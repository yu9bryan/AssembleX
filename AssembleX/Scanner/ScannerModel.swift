import CoreGraphics
import Foundation
import Observation

@MainActor
@Observable
final class ScannerModel {
    enum Status: Equatable {
        case starting
        case searching(String)
        case locked
        case unreliable(String)
        case cameraDenied
        case error(String)
    }

    private(set) var status: Status = .starting
    /// 目前顯示的結果（已平滑、已套用翻轉）。不可靠時為 nil，畫面不顯示明確孔位。
    private(set) var result: BreadboardResult?
    private(set) var imageSize = CGSize(width: 1080, height: 1920)
    private(set) var candidateCount = 0
    private(set) var milliseconds = 0.0
    private(set) var frozenImage: CGImage?

    var frozen = false { didSet { frozenChanged() } }
    var flip = false { didSet { if oldValue != flip { result = result?.flipped() } } }
    var torch = false { didSet { camera.setTorch(torch) } }
    var showAllLabels = false

    // MARK: AI 管線／對照
    // 預設用 AI（分割模型）找麵包板；經典與對照留在切換器裡
    var mode: ScanMode = .ai {
        didSet {
            guard oldValue != mode else { return }
            camera.setMode(mode)
            seg = nil; segError = nil; pipeline = nil; aiFound = false
            result = nil
            stats.reset()
        }
    }
    private(set) var seg: SegFrame?
    private(set) var segError: String?
    /// AI 管線最新一幀（分割、RGB 增強遮罩、四邊形、板內孔位）
    private(set) var pipeline: BoardPipelineFrame?
    private(set) var classicalFound = false         // 經典偵測這一幀是否可靠地找到孔位
    private(set) var aiFound = false                // AI 管線這一幀是否可靠地找到孔位
    /// 平滑後的耗時（ms）
    private(set) var segMilliseconds = 0.0          // 分割：前處理＋推論＋解碼
    private(set) var segInferenceMilliseconds = 0.0 // 只有 Core ML 推論
    private(set) var stageMilliseconds = (rgb: 0.0, line: 0.0, hole: 0.0)
    /// 對照模式：經典找不到、AI 管線找到時，主畫面孔位改用 AI 管線的結果
    private(set) var usingAI = false
    /// 累計統計（對照模式）：幀數、各方法找到的幀數
    private(set) var stats = CompareStats()

    struct CompareStats {
        var frames = 0, classical = 0, seg = 0, ai = 0
        mutating func reset() { self = CompareStats() }
    }
    func resetStats() { stats.reset() }

    /// 目標孔，例如 ["A5", "J10"]；兩個時畫成一條跳線。
    var targets: [String] = []

    let camera = CameraController()
    private var lastGray: GrayImage?
    private var lastGood = Date.distantPast

    /// 量測用：啟動參數環境變數 SCAN_MODE=ai|compare 設定初始模式，SCAN_LOG=1 每 30 幀印一次耗時
    private let logTimings = ProcessInfo.processInfo.environment["SCAN_LOG"] != nil

    func start() async {
        switch ProcessInfo.processInfo.environment["SCAN_MODE"] {
        case "ai": mode = .ai
        case "compare": mode = .compare
        default: break
        }
        camera.onFrame = { [weak self] frame in
            Task { @MainActor in self?.handle(frame) }
        }
        do {
            try await camera.start()
            status = .searching("把麵包板放進畫面")
        } catch CameraController.StartError.denied {
            status = .cameraDenied
        } catch CameraController.StartError.noCamera {
            status = .error("這台裝置沒有可用的相機（例如模擬器）。可以到「專案」頁用 3D 示範看接線。")
        } catch {
            status = .error("相機暫時無法啟動，請關掉其他使用相機的 App 後再試一次。")
        }
    }

    func stop() { camera.stop() }

    private func handle(_ frame: FrameResult) {
        guard !frozen else { return }
        imageSize = CGSize(width: frame.gray.width, height: frame.gray.height)
        lastGray = frame.gray
        let now = Date()

        handleSeg(frame)
        defer { logFrame(frame) }
        if mode.runsClassical { milliseconds = milliseconds * 0.8 + frame.milliseconds * 0.2 }
        classicalFound = frame.detection?.isReliable ?? false
        aiFound = frame.pipeline?.found ?? false
        usingAI = false
        if mode == .compare {
            stats.frames += 1
            if classicalFound { stats.classical += 1 }
            if frame.seg?.board != nil { stats.seg += 1 }
            if aiFound { stats.ai += 1 }
        }

        // 主畫面用哪一個結果
        var primary: BreadboardDetection?
        switch mode {
        case .classical: primary = frame.detection
        case .ai: primary = frame.pipeline?.detection
        case .compare:
            primary = frame.detection
            if !classicalFound, aiFound { primary = frame.pipeline?.detection; usingAI = true }
        }
        guard let detection = primary else {
            // AI 模式但這幀沒有孔位結果（沒找到板子、四邊形擬合失敗）
            guard now.timeIntervalSince(lastGood) > 0.5 else { return }
            result = nil
            if let e = frame.segError { status = .error(e) }
            else { status = .searching(frame.pipeline?.failure ?? "把麵包板放進畫面") }
            return
        }

        switch detection {
        case let .found(raw, candidates):
            candidateCount = candidates.count
            if raw.isReliable {
                let oriented = flip ? raw.flipped() : raw
                result = oriented.smoothed(from: result)
                status = .locked
                lastGood = now
                return
            }
            fallthrough
        default:
            if case let .notFound(_, candidates) = detection { candidateCount = candidates.count }
            // 短暫失去（手晃、遮擋）先保留上一個結果，避免閃爍；超過 0.5 秒就停止指引
            guard now.timeIntervalSince(lastGood) > 0.5 else { return }
            result = nil
            status = reasonStatus(detection)
        }
    }

    private var logCount = 0

    private func logFrame(_ frame: FrameResult) {
        guard logTimings else { return }
        logCount += 1
        guard logCount % 30 == 0 else { return }
        let s = frame.seg, p = frame.pipeline
        print(String(format: "[scan] mode=%@ classical=%.1fms found=%d | seg=%.1f(infer %.1f) board=%@ rgb=%.1f line=%.1f hole=%.1f %@ iou=%.2f rms=%.1f ang=%.1f found=%d | stats C%d S%d AI%d of %d",
                     mode.title, frame.milliseconds, classicalFound ? 1 : 0,
                     s?.milliseconds ?? 0, s?.inferenceMilliseconds ?? 0,
                     s?.board.map { String(format: "%.2f/%.0f%%", $0.score, $0.areaFraction * 100) } ?? "none",
                     p?.rgbMs ?? 0, p?.lineMs ?? 0, p?.holeMs ?? 0, (p?.rectified ?? false) ? "rect" : "crop",
                     p?.refinedIoU ?? 0, p?.lineRMS ?? 0, p?.latticeAngle ?? 0, aiFound ? 1 : 0,
                     stats.classical, stats.seg, stats.ai, stats.frames))
    }

    private func handleSeg(_ frame: FrameResult) {
        guard mode.runsSeg else { return }
        segError = frame.segError
        pipeline = frame.pipeline
        guard let s = frame.seg else { seg = nil; return }
        seg = s
        if let p = frame.pipeline {
            func mix(_ old: Double, _ new: Double) -> Double { old == 0 ? new : old * 0.8 + new * 0.2 }
            stageMilliseconds = (mix(stageMilliseconds.rgb, p.rgbMs), mix(stageMilliseconds.line, p.lineMs),
                                 mix(stageMilliseconds.hole, p.holeMs))
        }
        segMilliseconds = segMilliseconds == 0 ? s.milliseconds : segMilliseconds * 0.8 + s.milliseconds * 0.2
        segInferenceMilliseconds = segInferenceMilliseconds == 0
            ? s.inferenceMilliseconds : segInferenceMilliseconds * 0.8 + s.inferenceMilliseconds * 0.2
    }

    private func reasonStatus(_ d: BreadboardDetection) -> Status {
        switch d {
        case let .found(r, _):
            return .unreliable(r.detectedRatio < 0.25
                               ? "孔被擋住太多或角度太斜，請從正上方對準"
                               : "孔位對不齊，請拿穩、從正上方對準")
        case let .notFound(reason, candidates):
            return candidates.count < 40 ? .searching("把麵包板放進畫面（光線要夠）") : .searching(reason)
        }
    }

    private func frozenChanged() {
        if frozen {
            frozenImage = lastGray?.makeCGImage()
        } else {
            frozenImage = nil
        }
    }

    // MARK: - 目標孔

    var targetHoles: [NamedPoint] { targets.compactMap { result?.point(named: $0) } }

    func setTargets(from text: String) {
        let parts = text.uppercased()
            .split(whereSeparator: { "-→>, ，".contains($0) })
            .map(String.init)
        targets = Array(parts.prefix(2))
    }

    /// 點畫面：第一下設起點、第二下設終點、第三下重來。
    func tap(imagePoint p: CGPoint) {
        guard let r = result, let h = r.nearestPoint(to: SIMD2(p.x, p.y), maxDistance: r.pitch * 0.8) else { return }
        if targets.count >= 2 { targets = [] }
        if !targets.contains(h.name) { targets.append(h.name) }
    }
}
