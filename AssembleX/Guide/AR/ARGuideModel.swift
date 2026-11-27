import ARKit
import Combine
import AVFoundation
import Observation
import RealityKit
import SwiftUI

/// AR 接線指引：ARKit 世界追蹤 + 偵測孔位求 3D 姿態 → 一個固定在世界的錨點。
///
/// - 未鎖定：每 ~0.25 秒拿一幀 capturedImage 跑偵測（AI 管線，經典備援），可靠就用 PnP 求板子姿態，
///   通過檢查（重投影誤差、距離、朝向、和偵測到的平面一致）就鎖定。
/// - 鎖定後：錨點不動（ARKit 追蹤相機）；每 ~1 秒再偵測一次，新姿態和錨點差 > 4 mm 或 > 2°
///   且連續 3 次一致才緩慢移過去。疊圖（孔圈、標籤）由錨點投影，不再逐幀跟偵測跳動。
/// - 3D 示範（simulated）：不開相機，用虛擬相機看同一個場景。
@MainActor
@Observable
final class ARGuideModel {
    enum Status: Equatable {
        case starting, searching(String), locked, limited, unsupported, failed(String)
    }

    private(set) var status: Status = .starting
    private(set) var isLocked = false
    var flip = false { didSet { if oldValue != flip { tap.setFlip(flip); relock() } } }
    var torch = false { didSet { setTorch(torch) } }

    let arView: ARView
    let simulated: Bool
    private(set) var scene: BoardScene?
    private let anchor = AnchorEntity(world: matrix_identity_float4x4)
    private let tap = FrameTap()
    private var pending: [simd_float4x4] = []
    @ObservationIgnored private var updateSub: (any Cancellable)?
    private var styleState = (step: 0, done: Set<Int>(), showAll: false)
    private var project: LanProject?

    init(simulated: Bool) {
        self.simulated = simulated
        if simulated {
            arView = ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
            arView.environment.background = .color(UIColor(white: 0.04, alpha: 1))
        } else {
            arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        }
        arView.renderOptions.insert(.disableMotionBlur)
        arView.scene.addAnchor(anchor)
        updateSub = arView.scene.subscribe(to: SceneEvents.Update.self) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        tap.onPose = { [weak self] pose, cam in
            Task { @MainActor in self?.handle(pose, camera: cam) }
        }
        tap.onTracking = { [weak self] limited in
            Task { @MainActor in self?.trackingChanged(limited: limited) }
        }
        tap.onSearching = { [weak self] msg in
            Task { @MainActor in if self?.isLocked == false { self?.status = .searching(msg) } }
        }
        tap.onCols = { [weak self] c in
            Task { @MainActor in self?.recordCols(c) }
        }
    }

    // MARK: 麵包板大小

    /// 偵測到的欄數（最近 5 次可靠偵測、只算 17／30／63 這三種整塊板，至少 3 次一樣才算數）
    private(set) var detectedCols: Int?
    @ObservationIgnored private var colsHistory: [Int] = []
    private func recordCols(_ c: Int) {
        guard [17, 30, 63].contains(c) else { return }
        colsHistory = Array((colsHistory + [c]).suffix(5))
        let counts = Dictionary(colsHistory.map { ($0, 1) }, uniquingKeysWith: +)
        if let best = counts.max(by: { $0.value < $1.value }), best.value >= 3, best.key != detectedCols {
            detectedCols = best.key
        }
    }

    /// 專案放不下這塊板：不畫 3D（不畫錯的疊圖）
    var hidden = false { didSet { if hidden != oldValue { tick() } } }

    // MARK: 生命週期

    func start(project: LanProject) async {
        setProject(project)
        if simulated {
            setupVirtualCamera()
            isLocked = true
            status = .locked
            return
        }
        guard ARWorldTrackingConfiguration.isSupported else { status = .unsupported; return }
        let cfg = ARWorldTrackingConfiguration()
        cfg.planeDetection = [.horizontal]
        cfg.isAutoFocusEnabled = true
        arView.session.delegate = tap
        arView.session.delegateQueue = tap.queue
        arView.session.run(cfg, options: [.resetTracking, .removeExistingAnchors])
        status = .searching("請對準麵包板")
    }

    func stop() {
        if !simulated { arView.session.pause() }
        setTorch(false)
    }

    func setProject(_ p: LanProject) {
        guard p != project else { return }
        // 孔位換了（搬到真板子上）：舊的對位不算數，重新對位
        let holesChanged = project != nil && project?.holes != p.holes
        project = p
        if holesChanged, !simulated { relock() }
        tap.setProject(p)
        scene?.mm.removeFromParent()
        let s = BoardScene(project: p, anchor: anchor, showBoardBody: simulated)
        scene = s
        Task {
            await s.loadModels(); tick()
            // 模型載入後焦點範圍可能變了：剛打開時直接定到最終位置，不播「慢慢轉正」的動畫
            if simulated { frameStep(animated: false) }
        }
    }

    func setStyle(step: Int, done: Set<Int>, showAll: Bool) {
        let changed = step != styleState.step
        styleState = (step, done, showAll)
        tick()
        // 第一次（剛打開／剛跳出提示框）直接定位，之後換步驟才用動畫
        if simulated, changed || !hasFramedStep { frameStep(animated: hasFramedStep && camEntity != nil) }
        if camEntity != nil { hasFramedStep = true }
    }

    /// 可用的畫面範圍（標題列與步驟卡之間，畫面座標）
    func setViewport(region r: CGRect, size: CGSize, safeTop: CGFloat = 0) {
        // 取景上緣：安全區＋標題膠囊（約 72pt）＋12pt，3D 內容不跑到狀態列底下
        let top = max(r.minY, safeTop + 72 + 12)
        let region = CGRect(x: r.minX, y: top, width: r.width, height: max(80, r.maxY - top))
        guard region != viewport.region || size != viewport.size else { return }
        viewport = (region, size)
        if simulated { frameStep(animated: false) }
    }
    @ObservationIgnored private var viewport = (region: CGRect.zero, size: CGSize.zero)
    @ObservationIgnored private var camEntity: PerspectiveCamera?
    @ObservationIgnored private var hasFramedStep = false

    /// 重新對位：放掉錨點，從頭偵測
    func relock() {
        guard !simulated else { return }
        isLocked = false
        pending = []
        tap.setLocked(false)
        status = .searching("重新對位中…")
    }

    private func tick() {
        let t = Date().timeIntervalSinceReferenceDate
        scene?.update(stepPosition: styleState.step, done: styleState.done, showAll: styleState.showAll, time: t)
        anchor.isEnabled = isLocked && !hidden
    }

    // MARK: 姿態

    private func handle(_ pose: simd_float4x4, camera: simd_float4x4) {
        guard !simulated else { return }
        // 和偵測到的水平面一致性檢查：從相機往板子中心打一條射線
        if let s = scene {
            let size = project?.breadboard?.sizeMm ?? [165.1, 8.5, 54.4]
            let centerLocal = SIMD4<Float>(Float(size[0]) / 2000, Float(size[safe: 1] ?? 8.5) / 1000, Float(size[safe: 2] ?? 54.4) / 2000, 1)
            let center = pose * centerLocal
            let camPos = SIMD3(camera.columns.3.x, camera.columns.3.y, camera.columns.3.z)
            let c3 = SIMD3(center.x, center.y, center.z)
            let q = ARRaycastQuery(origin: camPos, direction: simd_normalize(c3 - camPos),
                                   allowing: .existingPlaneGeometry, alignment: .horizontal)
            if let hit = arView.session.raycast(q).first {
                let hp = SIMD3(hit.worldTransform.columns.3.x, hit.worldTransform.columns.3.y, hit.worldTransform.columns.3.z)
                // 平面通常是桌面（板底）；孔口比桌面高約板厚
                if simd_distance(hp, c3) > 0.06 {
                    if !isLocked { status = .searching("對位和桌面不一致，請拿穩再試") }
                    return
                }
            }
            _ = s
        }
        if !isLocked {
            anchor.transform = Transform(matrix: pose)
            isLocked = true
            pending = []
            tap.setLocked(true)
            status = .locked
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            return
        }
        let cur = anchor.transformMatrix(relativeTo: nil)
        let d = poseDifference(cur, pose)
        if d.mm <= 4 && d.deg <= 2 { pending = []; return }
        if let last = pending.last {
            let e = poseDifference(last, pose)
            pending = (e.mm <= 4 && e.deg <= 2) ? pending + [pose] : [pose]
        } else {
            pending = [pose]
        }
        if pending.count >= 3 {
            anchor.move(to: Transform(matrix: pose), relativeTo: nil, duration: 0.6, timingFunction: .easeInOut)
            pending = []
        }
    }

    private func trackingChanged(limited: Bool) {
        guard !simulated else { return }
        if limited { status = .limited }
        else if status == .limited { status = isLocked ? .locked : .searching("請對準麵包板") }
    }

    // MARK: 3D 示範的虛擬相機

    private func setupVirtualCamera() {
        let cam = PerspectiveCamera()
        cam.camera.fieldOfViewInDegrees = 50
        let camAnchor = AnchorEntity(world: .zero)
        camAnchor.addChild(cam)
        let key = DirectionalLight()
        key.light.intensity = 2300
        key.look(at: .zero, from: SIMD3(0.12, 0.4, 0.2), relativeTo: nil)
        camAnchor.addChild(key)
        let fill = DirectionalLight()
        fill.light.intensity = 900
        fill.look(at: .zero, from: SIMD3(-0.2, 0.3, -0.15), relativeTo: nil)
        camAnchor.addChild(fill)
        arView.scene.addAnchor(camAnchor)
        anchor.transform = Transform(matrix: matrix_identity_float4x4)
        camEntity = cam
        frameStep(animated: false)
    }

    /// 3D 示範：把目前這一步（孔＋元件，接到開發板時含整塊開發板）框在標題列與步驟卡之間，外擴 1.6 倍
    private func frameStep(animated: Bool) {
        guard let cam = camEntity, let scene else { return }
        var pts = scene.focusPoints(stepPosition: styleState.step).map(scene.world)
        if pts.isEmpty { pts = [scene.world(.zero)] }
        let c = pts.reduce(SIMD3<Float>.zero, +) / Float(pts.count)
        pts = pts.map { c + ($0 - c) * 1.6 }
        // 最小取景：約 28 欄 × 整個板寬，單一短跳線才看得出在板子哪裡
        let half = SIMD3<Float>(0.036, 0, 0.030)
        pts += [c + half, c - half, c + SIMD3(half.x, 0, -half.z), c + SIMD3(-half.x, 0, half.z)]
        let size = viewport.size.width > 0 ? viewport.size : CGSize(width: 402, height: 874)
        let region = viewport.region.width > 0 ? viewport.region : CGRect(x: 0, y: 130, width: size.width, height: 520)
        let vfov = Float(cam.camera.fieldOfViewInDegrees) * .pi / 180
        let tv = tan(vfov / 2), th = tv * Float(size.width / size.height)
        // 可用範圍（NDC）
        let ndcTop = Float(1 - 2 * region.minY / size.height), ndcBottom = Float(1 - 2 * region.maxY / size.height)
        let ndcL = Float(-1 + 2 * (region.minX + 16) / size.width), ndcR = Float(-1 + 2 * (region.maxX - 16) / size.width)
        // 相機：從上方稍微往 +x 傾斜看下去；畫面上方＝板子 −x（第 1 欄在上）
        let tilt = simd_normalize(SIMD3<Float>(0.28, 1, 0))
        let upHint = SIMD3<Float>(-1, 0, 0)
        func ndc(_ p: SIMD3<Float>, eye: SIMD3<Float>, f: SIMD3<Float>, r: SIMD3<Float>, u: SIMD3<Float>) -> SIMD2<Float> {
            let v = p - eye
            let z = max(1e-4, simd_dot(v, f))
            return SIMD2(simd_dot(v, r) / (z * th), simd_dot(v, u) / (z * tv))
        }
        var target = c
        var best = (eye: c + tilt * 0.3, target: c)
        for _ in 0..<3 {
            // 二分搜尋距離：所有點都落在可用範圍內的最近距離
            var lo: Float = 0.03, hi: Float = 2.0
            let f = -tilt, r = simd_normalize(simd_cross(f, upHint)), u = simd_cross(r, f)
            for _ in 0..<30 {
                let d = (lo + hi) / 2
                let eye = target + tilt * d
                let ok = pts.allSatisfy {
                    let q = ndc($0, eye: eye, f: f, r: r, u: u)
                    return q.x >= ndcL && q.x <= ndcR && q.y <= ndcTop && q.y >= ndcBottom
                }
                if ok { hi = d } else { lo = d }
            }
            let eye = target + tilt * hi
            best = (eye, target)
            // 把框住的東西移到可用範圍正中間
            let qs = pts.map { ndc($0, eye: eye, f: f, r: r, u: u) }
            let midX = (qs.map(\.x).min()! + qs.map(\.x).max()!) / 2, midY = (qs.map(\.y).min()! + qs.map(\.y).max()!) / 2
            let wantX = (ndcL + ndcR) / 2, wantY = (ndcTop + ndcBottom) / 2
            let z = simd_dot(c - eye, f)
            target += r * (midX - wantX) * z * th + u * (midY - wantY) * z * tv
        }
        let probe = Entity()
        probe.look(at: best.target, from: best.eye, upVector: upHint, relativeTo: nil)
        let t = probe.transform
        if animated { cam.move(to: t, relativeTo: nil, duration: 0.5, timingFunction: .easeInOut) }
        else { cam.transform = t }
    }

    // MARK: 投影

    /// 用錨點投影出整塊板的孔位（畫面座標）；未鎖定時 nil
    func projectedResult(viewSize: CGSize) -> BreadboardResult? {
        guard isLocked, let scene else { return nil }
        let v = arView
        return scene.projected(viewSize: viewSize) { v.project($0) }
    }

    /// 開發板排針的畫面位置（"mcu1.5V" → 點）
    func pinPoints() -> [String: CGPoint] {
        guard isLocked, let scene, let p = project else { return [:] }
        var out: [String: CGPoint] = [:]
        for w in p.wires {
            for e in [w.from, w.to] {
                guard let ref = e.pin, let mmp = scene.pin(ref), let q = arView.project(scene.world(mmp)) else { continue }
                out[ref] = q
            }
        }
        return out
    }

    /// 開發板在畫面上的範圍（標籤不要蓋到）
    func avoidRects() -> [CGRect] {
        guard isLocked, let scene, let p = project else { return [] }
        func rect(_ corners: [SIMD3<Float>]) -> CGRect? {
            let qs = corners.compactMap { arView.project(scene.world($0)) }
            guard qs.count >= 4 else { return nil }
            let xs = qs.map(\.x), ys = qs.map(\.y)
            return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
        }
        var out = [rect(scene.boardModelCorners)].compactMap { $0 }
        // 畫面上看得到的元件（完成的、目前的、「全部接線」時全部）也不讓標籤蓋
        for (i, st) in p.steps.enumerated() where !st.isWire {
            let shown = i <= styleState.step || styleState.done.contains(st.index) || styleState.showAll
            guard shown, let part = p.part(st.targetId), let r = rect(scene.partCorners(part)) else { continue }
            out.append(r)
        }
        return out
    }

    /// 已顯示的導線（不含目前這條）在畫面上的折線，給引線避開
    func wireScreenPaths(excluding id: String?) -> [[CGPoint]] {
        guard isLocked, let scene, let p = project else { return [] }
        var out: [[CGPoint]] = []
        for (i, st) in p.steps.enumerated() where st.isWire && st.targetId != id {
            let shown = i < styleState.step || styleState.done.contains(st.index) || styleState.showAll
            guard shown else { continue }
            let path = scene.wirePath(st.targetId)
            let step = max(1, path.count / 24)
            out.append(stride(from: 0, to: path.count, by: step).compactMap { arView.project(scene.world(path[$0])) })
        }
        return out
    }

    var statusText: String {
        switch status {
        case .starting: return "啟動相機…"
        case let .searching(s): return s
        case .locked: return simulated ? "3D 示範" : "已鎖定麵包板"
        case .limited: return "請慢慢移動手機"
        case .unsupported: return "這台裝置不支援 AR 世界追蹤"
        case let .failed(s): return s
        }
    }

    private func setTorch(_ on: Bool) {
        guard !simulated, let d = AVCaptureDevice.default(for: .video), d.hasTorch,
              (try? d.lockForConfiguration()) != nil else { return }
        d.torchMode = on ? .on : .off
        d.unlockForConfiguration()
    }
}

/// ARSession 代理（在背景佇列）：節流取幀 → 偵測 → PnP → 回主執行緒。
final class FrameTap: NSObject, ARSessionDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "assemblex.ar.delegate", qos: .userInitiated)
    private let work = DispatchQueue(label: "assemblex.ar.detect", qos: .userInitiated)
    private let detector = ARBoardDetector()
    private let lock = NSLock()
    private var busy = false
    private var lastSubmit = 0.0
    private var locked = false
    private var flip = false
    private var holes: [String: SIMD2<Double>] = [:]
    private var surfaceY = 8.5
    private var lastLimited: Bool?

    var onPose: (@Sendable (simd_float4x4, simd_float4x4) -> Void)?
    var onTracking: (@Sendable (Bool) -> Void)?
    var onSearching: (@Sendable (String) -> Void)?
    /// 每次可靠偵測的欄數（判斷真板子大小）
    var onCols: (@Sendable (Int) -> Void)?
    private var projectCols = 63

    func setLocked(_ v: Bool) { lock.lock(); locked = v; lastSubmit = 0; lock.unlock() }
    func setFlip(_ v: Bool) { lock.lock(); flip = v; lastSubmit = 0; lock.unlock() }
    func setProject(_ p: LanProject) {
        lock.lock()
        holes = (p.holes ?? [:]).compactMapValues { $0.count >= 2 ? SIMD2($0[0], $0[1]) : nil }
        projectCols = p.columns
        surfaceY = p.breadboard?.sizeMm?[safe: 1] ?? 8.5
        lock.unlock()
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let limited: Bool
        if case .normal = frame.camera.trackingState { limited = false } else { limited = true }
        if limited != lastLimited { lastLimited = limited; onTracking?(limited) }
        guard !limited else { return }

        lock.lock()
        let interval = locked ? 1.0 : 0.25
        let now = frame.timestamp
        guard !busy, now - lastSubmit >= interval else { lock.unlock(); return }
        busy = true; lastSubmit = now
        let flip = self.flip, holes = self.holes, surfaceY = self.surfaceY, projectCols = self.projectCols
        lock.unlock()

        let pb = PixelBox(frame.capturedImage)
        let K = frame.camera.intrinsics
        let C = frame.camera.transform
        work.async { [weak self] in
            guard let self else { return }
            defer { self.lock.lock(); self.busy = false; self.lock.unlock() }
            guard var r = self.detector.detect(pb.buffer) else { self.onSearching?("請對準麵包板"); return }
            if flip { r = r.flipped() }
            self.onCols?(r.cols)
            // 看到的欄比專案少（真板子比較小、還沒搬好，或只拍到一部分）：孔名對不上，不對位
            guard r.cols >= projectCols else {
                self.onSearching?(r.cols == 30 || r.cols == 17 ? "偵測到 \(BoardFit.kind(r.cols)) 麵包板，正在對齊走線…" : "請讓整塊麵包板入鏡")
                return
            }
            var img: [SIMD2<Double>] = [], board: [SIMD2<Double>] = []
            for h in r.holes where h.detected {
                guard let xz = holes[h.name] else { continue }
                img.append(h.point); board.append(xz)
            }
            let cam = BoardPose.Camera(fx: Double(K[0][0]), fy: Double(K[1][1]), cx: Double(K[2][0]), cy: Double(K[2][1]))
            guard let pose = BoardPose.solve(img: img, board: board, camera: cam, surfaceY: surfaceY) else {
                self.onSearching?("請對準麵包板"); return
            }
            // 檢查：重投影誤差、距離、板面朝向相機
            let dist = simd_length(pose.t)
            let up = pose.R.columns.1                       // 板子 +y（vision 座標）
            guard pose.rms < max(3, r.pitch * 0.3), dist > 0.06, dist < 1.6, simd_dot(up, pose.t) < 0 else {
                self.onSearching?("孔位對不齊，請從正上方對準"); return
            }
            self.onPose?(pose.world(cameraTransform: C), C)
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {}
}

/// CVPixelBuffer 跨佇列傳遞（唯讀）
struct PixelBox: @unchecked Sendable {
    let buffer: CVPixelBuffer
    init(_ b: CVPixelBuffer) { buffer = b }
}

/// SwiftUI 包 ARView
struct ARViewContainer: UIViewRepresentable {
    let arView: ARView
    func makeUIView(context: Context) -> ARView { arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}
