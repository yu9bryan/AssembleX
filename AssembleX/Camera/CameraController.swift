import AVFoundation
import CoreGraphics
import CoreImage

/// 掃描模式：經典孔位偵測／AI 分割／兩者對照。
enum ScanMode: Int, CaseIterable, Sendable {
    case classical, ai, compare
    var title: String {
        switch self {
        case .classical: return "經典"
        case .ai: return "AI 管線"
        case .compare: return "兩者對照"
        }
    }
    var runsClassical: Bool { self != .ai }
    var runsSeg: Bool { self != .classical }
}

/// 一幀的偵測結果（從相機佇列送到主執行緒）。
struct FrameResult: Sendable {
    let detection: BreadboardDetection?   // AI 分割模式下為 nil（不跑經典偵測）
    let gray: GrayImage           // 凍結畫面時用
    let milliseconds: Double      // 經典偵測耗時
    var seg: SegFrame?            // AI 分割結果（經典模式為 nil）
    var segError: String?
    /// AI 管線：分割 → RGB 增強 → 直線四邊形 → 板內孔位（座標已換回整張影像）
    var pipeline: BoardPipelineFrame?
}

/// 後鏡頭直式影像 → 灰階 Y 平面 → BreadboardDetector。
/// 處理在相機佇列上同步進行；忙碌時新幀會被 AVFoundation 丟掉（alwaysDiscardsLateVideoFrames）。
final class CameraController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "assemblex.camera", qos: .userInitiated)
    private let detector = BreadboardDetector()
    private var device: AVCaptureDevice?
    private var configured = false

    /// 在相機佇列上呼叫。
    var onFrame: (@Sendable (FrameResult) -> Void)?

    // 以下只在相機佇列上讀寫
    private var mode: ScanMode = .ai   // 和 ScannerModel 的預設一致
    private var segModel: BreadboardSegModel?
    private var segLoadError: String?
    private let pipeline = BoardPipeline()

    func setMode(_ m: ScanMode) { queue.async { self.mode = m } }

    enum StartError: Error { case denied, noCamera }

    func start() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { throw StartError.denied }
        default: throw StartError.denied
        }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    if !self.configured { try self.configure() }
                    if !self.session.isRunning { self.session.startRunning() }
                    cont.resume()
                } catch { cont.resume(throwing: error) }
            }
        }
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    func setTorch(_ on: Bool) {
        queue.async {
            guard let d = self.device, d.hasTorch, (try? d.lockForConfiguration()) != nil else { return }
            d.torchMode = on ? .on : .off
            d.unlockForConfiguration()
        }
    }

    private func configure() throws {
        // 三鏡頭／雙廣角的虛擬鏡頭會在太近時自動切到超廣角（微距），近拍麵包板比較清楚
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInTripleCamera, .builtInDualWideCamera, .builtInWideAngleCamera],
            mediaType: .video, position: .back)
        guard let device = discovery.devices.first else { throw StartError.noCamera }
        self.device = device

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .hd1920x1080
        let input = try AVCaptureDeviceInput(device: device)
        if session.canAddInput(input) { session.addInput(input) }

        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        if let c = output.connection(with: .video), c.isVideoRotationAngleSupported(90) {
            c.videoRotationAngle = 90     // 直式影像，座標和畫面一致
        }

        try device.lockForConfiguration()
        // 虛擬鏡頭預設是 0.5x 超廣角，拉回 1x 主鏡頭視角
        if let wideFactor = device.virtualDeviceSwitchOverVideoZoomFactors.first {
            device.videoZoomFactor = CGFloat(truncating: wideFactor)
        }
        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        device.unlockForConfiguration()
        configured = true
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        let w = CVPixelBufferGetWidthOfPlane(pb, 0)
        let h = CVPixelBufferGetHeightOfPlane(pb, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else {
            CVPixelBufferUnlockBaseAddress(pb, .readOnly); return
        }
        var px = [UInt8](repeating: 0, count: w * h)
        px.withUnsafeMutableBytes { dst in
            let src = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<h { memcpy(dst.baseAddress! + y * w, src + y * stride, w) }
        }
        let mode = self.mode
        // AI 管線的 RGB 增強要顏色：1/4 解析度 YCbCr
        var color: QuarterYCbCr?
        if mode.runsSeg, let cBase = CVPixelBufferGetBaseAddressOfPlane(pb, 1) {
            color = QuarterYCbCr(yBase: base.assumingMemoryBound(to: UInt8.self), yStride: stride,
                                 cBase: cBase.assumingMemoryBound(to: UInt8.self),
                                 cStride: CVPixelBufferGetBytesPerRowOfPlane(pb, 1), width: w, height: h)
        }
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)

        let gray = GrayImage(width: w, height: h, pixels: px)

        // AI 分割
        var seg: SegFrame?
        var segError: String?
        if mode.runsSeg {
            if segModel == nil && segLoadError == nil {
                do { segModel = try BreadboardSegModel() } catch { segLoadError = "AI 模型載入失敗：\(error)" }
            }
            if let segModel {
                do { seg = try segModel.predict(pb) } catch { segError = "AI 推論失敗：\(error)" }
            } else {
                segError = segLoadError
            }
        }

        var detection: BreadboardDetection?
        var ms = 0.0
        if mode.runsClassical {
            let t0 = CFAbsoluteTimeGetCurrent()
            detection = detector.detect(gray)
            ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        }

        var frame = FrameResult(detection: detection, gray: gray, milliseconds: ms, seg: seg, segError: segError)
        if let seg, let color {
            frame.pipeline = pipeline.run(seg: seg, gray: gray, color: color)
        }
        dumpIfNeeded(pb, hasBoard: seg?.board != nil)
        onFrame?(frame)
    }
}

// MARK: - 除錯：存實拍幀（啟動參數環境變數 SCAN_DUMP=1，最多 40 張、每 20 幀一張、只存 AI 有看到板子的）
// 取回：xcrun devicectl device copy from --device <id> --domain-type appDataContainer
//        --domain-identifier yu8bryan.AssembleX --source Documents/frames --destination <dir>
extension CameraController {
    private static let dumpEnabled = ProcessInfo.processInfo.environment["SCAN_DUMP"] != nil
    nonisolated(unsafe) private static var dumpCounter = 0
    nonisolated(unsafe) private static var dumpSaved = 0
    private static let dumpContext = CIContext()

    fileprivate func dumpIfNeeded(_ pb: CVPixelBuffer, hasBoard: Bool) {
        guard Self.dumpEnabled, hasBoard, Self.dumpSaved < 40 else { return }
        Self.dumpCounter += 1
        guard Self.dumpCounter % 20 == 0,
              let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let dir = docs.appendingPathComponent("frames")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(String(format: "frame_%03d.jpg", Self.dumpSaved))
        let img = CIImage(cvPixelBuffer: pb)
        if let data = Self.dumpContext.jpegRepresentation(of: img, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                          options: [:]) {
            try? data.write(to: url)
            Self.dumpSaved += 1
        }
    }
}

extension GrayImage {
    func makeCGImage() -> CGImage? {
        let data = Data(pixels) as CFData
        guard let provider = CGDataProvider(data: data) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                       space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
