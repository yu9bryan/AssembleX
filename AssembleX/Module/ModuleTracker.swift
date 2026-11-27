import ARKit
import Foundation
import ImageIO
import simd
import UniformTypeIdentifiers

/// 每個啟用的元件各跑一個偵測器（同時辨識多個元件）→ 世界座標姿態。兩種模式：
///   .rgb   ：相機影像＋CAD 顏色擬合（ModulePoseDetector／CADFitter）
///   .lidar ：LiDAR 深度點雲＋CAD 形狀 ICP，不看顏色（LiDARFitter）
/// ARKit 只負責相機追蹤（手機自己怎麼動）；元件位置由上面兩種方法之一算出。
final class ModuleTracker: NSObject, ARSessionDelegate, @unchecked Sendable {
    enum Mode: String, CaseIterable, Sendable { case rgb = "RGB", lidar = "LiDAR" }

    struct Item: Sendable {
        let id: String
        let name: String
        let world: simd_float4x4?           // 物件 → 世界（RealityKit 用）
        let reliable: Bool
        /// 位置可信、但方向不確定（元件近對稱，例：W5500 從晶片面看四個方向很像）
        var located: Bool = false
        let fitScore: Double?               // RGB：CAD 吻合；LiDAR：貼合＋覆蓋分數
        let cameraT: SIMD3<Double>?         // 物件在相機座標（OpenCV：x 右 y 下 z 前，公尺）
        let euler: SIMD3<Double>?           // 物件相對相機的 roll/pitch/yaw（度）
        let reason: String?
        let debug: String
    }
    struct Output: Sendable {
        let items: [Item]
        let milliseconds: Double
        let mode: Mode
    }

    let profiles: [ComponentProfile]
    private let queue = DispatchQueue(label: "assemblex.module", qos: .userInitiated)
    private let detectors: [String: ModulePoseDetector]
    private let lidarFitters: [String: LiDARFitter]
    private let lock = NSLock()
    private var busy = false
    private var enabled: Set<String>
    private var mode: Mode = .rgb
    /// 每個元件上一個可靠姿態（世界座標）；只在 queue 上讀寫
    private var lastWorld: [String: (m: simd_float4x4, t: Double)] = [:]
    private var lastImage: YCbCrImage?
    private var lastK: CameraIntrinsics?
    private var lastPoints: [SIMD3<Float>] = []
    private var lastDebug = ""
    var onOutput: (@Sendable (Output) -> Void)?

    override init() {
        profiles = ComponentProfile.bundled()
        var d: [String: ModulePoseDetector] = [:], l: [String: LiDARFitter] = [:]
        for p in profiles {
            let det = ModulePoseDetector(profile: p)
            if let url = Bundle.main.url(forResource: p.mesh, withExtension: "json") {
                det.fitter = CADFitter.load(url: url, colors: det.colors)
                l[p.id] = LiDARFitter(profile: p, meshURL: url)
            }
            d[p.id] = det
        }
        detectors = d
        lidarFitters = l
        enabled = Set(profiles.map(\.id))
        super.init()
    }

    func setEnabled(_ ids: Set<String>) { lock.lock(); enabled = ids; lock.unlock() }
    func setMode(_ m: Mode) {
        lock.lock(); mode = m; lock.unlock()
        queue.async { self.lastWorld.removeAll() }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        lock.lock()
        if busy { lock.unlock(); return }
        busy = true
        let ids = profiles.map(\.id).filter { enabled.contains($0) }
        let mode = self.mode
        lock.unlock()

        let cam = frame.camera.transform
        let k = frame.camera.intrinsics
        let imgW = Double(CVPixelBufferGetWidth(frame.capturedImage))

        if mode == .lidar {
            guard let depth = frame.smoothedSceneDepth ?? frame.sceneDepth else {
                onOutput?(Output(items: ids.map { id in
                    Item(id: id, name: profiles.first { $0.id == id }?.displayName ?? id, world: nil, reliable: false,
                         fitScore: nil, cameraT: nil, euler: nil, reason: "沒有 LiDAR 深度（此裝置不支援或尚未就緒）", debug: "")
                }, milliseconds: 0, mode: mode))
                setIdle(); return
            }
            // 立刻把深度轉成點雲（不要留住 ARFrame）
            let dm = depth.depthMap
            CVPixelBufferLockBaseAddress(dm, .readOnly)
            let dw = CVPixelBufferGetWidth(dm), dh = CVPixelBufferGetHeight(dm)
            let s = Double(dw) / imgW
            let Kd = CameraIntrinsics(fx: Double(k[0][0]) * s, fy: Double(k[1][1]) * s, cx: Double(k[2][0]) * s, cy: Double(k[2][1]) * s)
            var pts: [SIMD3<Float>] = []
            if let base = CVPixelBufferGetBaseAddress(dm)?.assumingMemoryBound(to: Float32.self) {
                let stride = CVPixelBufferGetBytesPerRow(dm) / MemoryLayout<Float32>.size
                if let cm = depth.confidenceMap {
                    CVPixelBufferLockBaseAddress(cm, .readOnly)
                    let cbase = CVPixelBufferGetBaseAddress(cm)?.assumingMemoryBound(to: UInt8.self)
                    pts = DepthScene.points(depth: base, width: dw, height: dh, rowStride: stride, confidence: cbase,
                                            confStride: CVPixelBufferGetBytesPerRow(cm), K: Kd, cam: cam)
                    CVPixelBufferUnlockBaseAddress(cm, .readOnly)
                } else {
                    pts = DepthScene.points(depth: base, width: dw, height: dh, rowStride: stride, confidence: nil,
                                            confStride: 0, K: Kd, cam: cam)
                }
            }
            CVPixelBufferUnlockBaseAddress(dm, .readOnly)
            let cloud = pts
            queue.async { [self] in
                let t0 = CFAbsoluteTimeGetCurrent()
                var items: [Item] = []
                let planes = DepthScene.supportPlanes(cloud)
                let objects = DepthScene.objects(cloud, planes: planes)
                for id in ids {
                    let name = profiles.first { $0.id == id }?.displayName ?? id
                    guard let fitter = lidarFitters[id], !planes.isEmpty else {
                        items.append(Item(id: id, name: name, world: nil, reliable: false, fitScore: nil, cameraT: nil, euler: nil,
                                          reason: "找不到桌面（深度點 \(cloud.count)）", debug: "點 \(cloud.count)")); continue
                    }
                    let prior = lastWorld[id].flatMap { t0 - $0.t < 1.0 ? $0.m : nil }
                    guard let r = fitter.fit(objects: objects, prior: prior) else {
                        items.append(Item(id: id, name: name, world: nil, reliable: false, fitScore: nil, cameraT: nil, euler: nil,
                                          reason: "桌面上找不到大小相符的物件", debug: "平面 \(planes.count) · 物件群 \(objects.count)")); continue
                    }
                    if r.isReliable { lastWorld[id] = (r.world, t0) }
                    let (ct, eu) = Self.cameraRelative(r.world, camera: cam)
                    let dbg = String(format: "點 %d · 貼合 %.2f · 覆蓋 %.2f · 差距 %.2f · %@", r.points, r.inlier, r.coverage,
                                     r.margin, r.isReliable ? "可靠" : "不可靠")
                    var item = Item(id: id, name: name, world: r.world, reliable: r.isReliable, fitScore: Double(r.score),
                                    cameraT: ct, euler: eu, reason: r.margin <= 0.05 ? "形狀接近對稱，方向不確定" : nil, debug: dbg)
                    item.located = !r.isReliable && r.inlier > 0.6 && r.coverage > 0.5
                    items.append(item)
                }
                let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
                lastPoints = cloud
                lastDebug = items.map { "\($0.id): \($0.debug)" }.joined(separator: " | ")
                onOutput?(Output(items: items, milliseconds: ms, mode: mode))
                setIdle()
            }
            return
        }

        // RGB：立刻複製影像（不要留住 ARFrame）
        guard let img = Self.halfResYCbCr(frame.capturedImage) else { setIdle(); return }
        let K = CameraIntrinsics(fx: Double(k[0][0]) / 2, fy: Double(k[1][1]) / 2,
                                 cx: Double(k[2][0]) / 2, cy: Double(k[2][1]) / 2)

        queue.async { [self] in
            let t0 = CFAbsoluteTimeGetCurrent()
            var items: [Item] = []
            for id in ids {
                guard let det = detectors[id] else { continue }
                // 追蹤：把上一個世界姿態換到這一幀的相機座標，當擬合起點
                var prior: (simd_double3x3, SIMD3<Double>)?
                if let w = lastWorld[id], t0 - w.t < 1.0 {
                    let cvToAR = simd_float4x4(diagonal: SIMD4(1, -1, -1, 1))
                    let m = cvToAR.inverse * cam.inverse * w.m
                    prior = (simd_double3x3(columns: (SIMD3<Double>(Double(m.columns.0.x), Double(m.columns.0.y), Double(m.columns.0.z)),
                                                      SIMD3<Double>(Double(m.columns.1.x), Double(m.columns.1.y), Double(m.columns.1.z)),
                                                      SIMD3<Double>(Double(m.columns.2.x), Double(m.columns.2.y), Double(m.columns.2.z)))),
                             SIMD3<Double>(Double(m.columns.3.x), Double(m.columns.3.y), Double(m.columns.3.z)))
                }
                switch det.detect(img, intrinsics: K, prior: prior) {
                case let .found(pose):
                    let world = Self.worldTransform(pose, camera: cam)
                    if pose.isReliable { lastWorld[id] = (world, t0) }
                    let dbg = String(format: "底板色 %d · CAD 吻合 %.2f · %@", pose.redPixels, pose.fitScore ?? -1,
                                     pose.isReliable ? "可靠" : "不可靠")
                    let reason = (pose.fitScore ?? 0) < 0.6 ? "和 CAD 對不起來，請靠近、讓整個元件入鏡" : "方向不確定，請換個角度"
                    var item = Item(id: id, name: det.profile.displayName, world: world, reliable: pose.isReliable,
                                    fitScore: pose.fitScore, cameraT: pose.translation, euler: pose.eulerDegrees,
                                    reason: pose.isReliable ? nil : reason, debug: dbg)
                    item.located = !pose.isReliable && (pose.fitScore ?? 0) >= 0.55
                    items.append(item)
                case let .notFound(reason):
                    items.append(Item(id: id, name: det.profile.displayName, world: nil, reliable: false, fitScore: nil,
                                      cameraT: nil, euler: nil, reason: reason, debug: reason))
                }
            }
            let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            lastImage = img; lastK = K
            lastDebug = items.map { "\($0.id): \($0.debug)" }.joined(separator: " | ")
            onOutput?(Output(items: items, milliseconds: ms, mode: mode))
            setIdle()
        }
    }

    /// 世界姿態 → 相對相機（OpenCV 座標）的位置與 roll/pitch/yaw
    static func cameraRelative(_ world: simd_float4x4, camera: simd_float4x4) -> (SIMD3<Double>, SIMD3<Double>) {
        let cvToAR = simd_float4x4(diagonal: SIMD4(1, -1, -1, 1))
        let m = cvToAR.inverse * camera.inverse * world
        let R = simd_double3x3(columns: (SIMD3<Double>(Double(m.columns.0.x), Double(m.columns.0.y), Double(m.columns.0.z)),
                                         SIMD3<Double>(Double(m.columns.1.x), Double(m.columns.1.y), Double(m.columns.1.z)),
                                         SIMD3<Double>(Double(m.columns.2.x), Double(m.columns.2.y), Double(m.columns.2.z))))
        let t = SIMD3<Double>(Double(m.columns.3.x), Double(m.columns.3.y), Double(m.columns.3.z))
        let pose = ModulePose(rotation: R, translation: t, corners: [], reprojectionError: 0, orientationMargin: 0, redPixels: 0)
        return (t, pose.eulerDegrees)
    }

    private func setIdle() { lock.lock(); busy = false; lock.unlock() }

    /// 把最近一幀存成 PNG＋內參 JSON（App 的 Documents/diag/），給 Mac 上 tools/test_pose.sh 重跑。
    func saveDiagnostic(completion: @escaping @Sendable (String) -> Void) {
        queue.async { [self] in
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("diag")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let name = "frame_\(Int(Date().timeIntervalSince1970))"
            if !lastPoints.isEmpty {
                // LiDAR 點雲（世界座標，公尺）：每點 3 個 Float32，little-endian
                var data = Data(capacity: lastPoints.count * 12)
                for p in lastPoints { withUnsafeBytes(of: p.x) { data.append(contentsOf: $0) }
                    withUnsafeBytes(of: p.y) { data.append(contentsOf: $0) }; withUnsafeBytes(of: p.z) { data.append(contentsOf: $0) } }
                try? data.write(to: dir.appendingPathComponent(name + ".points.bin"))
            }
            guard let img = lastImage, let K = lastK else {
                completion(lastPoints.isEmpty ? "還沒有畫面" : "已存點雲 \(name)"); return
            }
            var rgba = [UInt8](repeating: 255, count: img.width * img.height * 4)
            for i in 0..<(img.width * img.height) {
                let Y = Double(img.y[i]), cb = Double(img.cb[i]) - 128, cr = Double(img.cr[i]) - 128
                rgba[i * 4] = UInt8(max(0, min(255, Y + 1.402 * cr)))
                rgba[i * 4 + 1] = UInt8(max(0, min(255, Y - 0.344136 * cb - 0.714136 * cr)))
                rgba[i * 4 + 2] = UInt8(max(0, min(255, Y + 1.772 * cb)))
            }
            let ok: Bool = rgba.withUnsafeMutableBytes { buf in
                guard let ctx = CGContext(data: buf.baseAddress, width: img.width, height: img.height, bitsPerComponent: 8,
                                          bytesPerRow: img.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
                      let cg = ctx.makeImage(),
                      let dest = CGImageDestinationCreateWithURL(dir.appendingPathComponent(name + ".png") as CFURL,
                                                                 UTType.png.identifier as CFString, 1, nil) else { return false }
                CGImageDestinationAddImage(dest, cg, nil)
                return CGImageDestinationFinalize(dest)
            }
            let meta: [String: Any] = ["K": [K.fx, K.fy, K.cx, K.cy], "debug": lastDebug]
            if let d = try? JSONSerialization.data(withJSONObject: meta) {
                try? d.write(to: dir.appendingPathComponent(name + ".json"))
            }
            completion(ok ? "已存 \(name)" : "存檔失敗")
        }
    }

    /// OpenCV 相機座標（x 右、y 下、z 前）→ ARKit 相機座標（x 右、y 上、z 後），再乘相機在世界的姿態。
    static func worldTransform(_ p: ModulePose, camera: simd_float4x4) -> simd_float4x4 {
        let R = p.rotation, t = p.translation
        let objToCV = simd_float4x4(columns: (
            SIMD4(Float(R[0][0]), Float(R[0][1]), Float(R[0][2]), 0),
            SIMD4(Float(R[1][0]), Float(R[1][1]), Float(R[1][2]), 0),
            SIMD4(Float(R[2][0]), Float(R[2][1]), Float(R[2][2]), 0),
            SIMD4(Float(t.x), Float(t.y), Float(t.z), 1)))
        let cvToAR = simd_float4x4(diagonal: SIMD4(1, -1, -1, 1))
        return camera * cvToAR * objToCV
    }

    /// capturedImage（1920×1440 420f）→ 960×720 的 Y／Cb／Cr（Y 每 2 點取 1，色度平面原本就是半解析度）。
    /// 曾改成 480×360 加速，但 40–50 cm 外的板子只剩 80 px、底板色太少；擬合成本和解析度無關，所以用半解析度。
    static func halfResYCbCr(_ pb: CVPixelBuffer) -> YCbCrImage? {
        guard CVPixelBufferGetPlaneCount(pb) == 2 else { return nil }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let cw = CVPixelBufferGetWidthOfPlane(pb, 1), ch = CVPixelBufferGetHeightOfPlane(pb, 1)
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let cStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(pb, 0)?.assumingMemoryBound(to: UInt8.self),
              let cBase = CVPixelBufferGetBaseAddressOfPlane(pb, 1)?.assumingMemoryBound(to: UInt8.self) else { return nil }
        var y = [UInt8](repeating: 0, count: cw * ch), cb = y, cr = y
        for r in 0..<ch {
            let yRow = yBase + (r * 2) * yStride, yRow2 = yRow + yStride, cRow = cBase + r * cStride
            for c in 0..<cw {
                let i = r * cw + c
                // Y 用 2×2 平均（直接抽點會疊頻）
                y[i] = UInt8((Int(yRow[c * 2]) + Int(yRow[c * 2 + 1]) + Int(yRow2[c * 2]) + Int(yRow2[c * 2 + 1]) + 2) / 4)
                cb[i] = cRow[c * 2]
                cr[i] = cRow[c * 2 + 1]
            }
        }
        return YCbCrImage(width: cw, height: ch, y: y, cb: cb, cr: cr)
    }
}
