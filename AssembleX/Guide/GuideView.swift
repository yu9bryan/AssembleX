import SwiftUI
import ARKit
import AVFoundation

/// 和桌面 Studio 同一套視覺：近黑中性底、白色主按鈕、灰階層次，不用系統藍。
enum GuideStyle {
    static let panel = Color(hex: "#171718")   // 完全不透明，板上絲印不會透出
    static let hairline = Color.white.opacity(0.07)
    static let primaryBG = Color(hex: "#f0f0f1")
    static let primaryText = Color(hex: "#0b0b0c")
    static let secondaryBG = Color(hex: "#1f1f21")
    static let secondaryText = Color(hex: "#c2c2c6")
    static let muted = Color(white: 0.62)
    static let board = Color(hex: "#2a2c31")
    static let hole = Color(hex: "#0d0d0f")
}

private extension View {
    /// 實心深色面板＋細邊
    func guidePanel(_ radius: CGFloat) -> some View {
        background(GuideStyle.panel, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(GuideStyle.hairline, lineWidth: 1))
    }
}

/// 指引模式：AR（相機＋世界錨點＋3D 模型）、2D 模擬板、3D 示範（虛擬相機看同一個 3D 場景）
enum GuideMode: String, Identifiable {
    case ar, sim2D, sim3D
    var id: String { rawValue }
}

/// 接線指引：相機畫面上疊出目前這一步要插的孔與導線。
struct GuideView: View {
    let session: LinkSession
    /// 目前的顯示方式（沒有 AR 的裝置可以在畫面上改成 3D／2D）
    @State private var mode: GuideMode
    /// 2D 模擬板（不開相機）
    private var simulated: Bool { mode == .sim2D }
    /// 選了 AR，但這台裝置不能用（模擬器、舊 iPhone）
    private var arUnsupported: Bool { mode == .ar && !ARWorldTrackingConfiguration.isSupported }
    /// 選了 AR，但相機權限被關掉
    private var arCameraDenied: Bool {
        guard mode == .ar, ARWorldTrackingConfiguration.isSupported else { return false }
        let st = AVCaptureDevice.authorizationStatus(for: .video)
        return st == .denied || st == .restricted
    }
    /// 目前這一步用到的主區列（0＝A）
    private var currentRows: Set<Int> {
        guard let p = session.viewProject, p.steps.indices.contains(session.stepPosition) else { return [] }
        return Set(p.steps[session.stepPosition].holes.compactMap { if case let .main(r, _)? = HoleID($0) { return r } else { return nil } })
    }

    /// 畫面上的麵包板欄數（搬到真板子上時是真板子的）
    private var boardCols: Int {
        // 放不下：畫真的板子大小（不畫走線），一眼看出差多少
        if fitTooSmall, let real = session.realBoardCols { return real }
        return session.viewProject?.columns ?? 63
    }
    /// 專案放不下這塊麵包板
    private var fitTooSmall: Bool { session.boardFit?.isTooSmall ?? false }

    /// AR 用不了（不支援或沒權限）：顯示說明面板、步驟卡先不能按
    private var arBlocked: Bool { arUnsupported || arCameraDenied }

    init(session: LinkSession, mode: GuideMode) {
        self.session = session
        _mode = State(initialValue: mode)
    }

    @Environment(\.dismiss) private var dismiss
    /// AR／3D 示範的場景與追蹤（2D 模擬時為 nil）
    @State private var ar: ARGuideModel?
    @State private var showAll = false
    @State private var smoother = PointSmoother()
    @State private var notice: String?
    @State private var syncHint: String?
    @State private var syncHintOK = true
    /// 模擬板的擺放範圍：標題列下緣、步驟卡上緣（guideRoot 座標）
    @State private var headerBottom: CGFloat = 120
    @State private var cardTop: CGFloat = 620
    @State private var cardMeasured = false
    /// 模擬板目前捲到的欄（往目標欄平滑移動）
    @State private var focus = FocusEaser()
    /// 步驟清單（點「第 n / N 步」打開）
    @State private var showSteps = false
    /// 按了「全部完成」：顯示完成卡，使用者自己關
    @State private var showCompletion = false
    @State private var didStart = false
    @State private var noticeTask: Task<Void, Never>?
    /// 指引畫面內掃 QR（電腦重開、換了 token）
    @State private var showScanner = false
    /// 步驟卡上方的提示條（約 4 秒）
    @State private var toast: String?
    @State private var toastQueue: [String] = []
    /// 從「設定」回來時重試 AR
    @State private var arRetry = 0
    @State private var confirmMarkAll = false
    /// 指引畫面內手動輸入 IP
    @State private var showManual = false
    @State private var manualAddress = ""
    @State private var manualToken = ""

    /// 模擬板放在標題列與步驟卡之間。origin：全畫面 GeometryReader 在 guideRoot 座標的 y（約為 −安全區頂端）
    private func simRegion(width: CGFloat, origin: CGFloat) -> CGRect {
        let top = headerBottom - origin, bottom = cardTop - origin
        return CGRect(x: 0, y: top + 10, width: width, height: max(100, bottom - top - 20))
    }

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            // 步驟卡只拿 result 做警告（缺孔、板型），和擺放位置無關
            let result = simulated
                ? SimulatedBoard.result(time: t, region: CGRect(x: 0, y: 0, width: 400, height: 600), viewSize: CGSize(width: 400, height: 600), cols: boardCols)
                : ar?.projectedResult(viewSize: ar?.arView.bounds.size ?? .zero)
            GeometryReader { geo in
                let region = simRegion(width: geo.size.width, origin: geo.frame(in: .named("guideRoot")).minY)
                // 上緣 28pt 留給固定的「A B C D E │ F G H I J」欄頭
                let boardRegion = CGRect(x: region.minX, y: region.minY + 28, width: region.width, height: region.height - 28)
                let focusCol = focus.step(toward: focusTarget, time: t)
                // AR／3D：孔位由世界錨點投影（畫面座標），不跟逐幀偵測跳動
                let result = simulated ? SimulatedBoard.result(time: t, region: boardRegion, viewSize: geo.size, focusCol: focusCol, cols: boardCols)
                    : ar?.projectedResult(viewSize: geo.size)
                let map = ImageToView(imageSize: geo.size, viewSize: geo.size)
                ZStack {
                    Color.black
                    if simulated {
                        SimulatedBoardView(time: t, region: boardRegion, focusCol: focusCol, result: result, map: map, cols: boardCols)
                            .mask(Rectangle().frame(width: region.width, height: region.height)
                                .position(x: region.midX, y: region.midY))
                    } else if let ar {
                        ARViewContainer(arView: ar.arView)
                            .id(ObjectIdentifier(ar))
                            .onChange(of: region, initial: true) { _, r in
                                ar.setViewport(region: r, size: geo.size, safeTop: max(0, -geo.frame(in: .named("guideRoot")).minY))
                            }
                    }
                    if !simulated {
                        // 狀態列底下壓暗（黑→透明），3D 場景不和時間、電量搶
                        let safeTop = max(0, -geo.frame(in: .named("guideRoot")).minY)
                        VStack(spacing: 0) {
                            // 狀態列範圍全黑，再往下 24pt 漸淡
                            LinearGradient(stops: [.init(color: .black, location: 0),
                                                   .init(color: .black, location: safeTop / (safeTop + 24)),
                                                   .init(color: .black.opacity(0), location: 1)],
                                           startPoint: .top, endPoint: .bottom)
                                .frame(height: safeTop + 24)
                            Spacer(minLength: 0)
                        }
                        .allowsHitTesting(false)
                    }
                    if let project = session.viewProject, let result, !fitTooSmall {
                        WiringOverlayView(project: project, stepIndex: session.stepPosition, done: session.done,
                                          showAll: showAll, resolver: HoleResolver(result: result), map: map, time: t,
                                          smoother: smoother, axisLabels: simulated,
                                          visibleRect: simulated ? region : nil,
                                          wires3D: !simulated, pinPoints: ar?.pinPoints() ?? [:],
                                          avoidRects: ar?.avoidRects() ?? [],
                                          safeRect: simulated ? nil : region,
                                          wireScreenPaths: ar?.wireScreenPaths(excluding: currentWireId) ?? [])
                            .mask {
                                if simulated {
                                    Rectangle().frame(width: region.width, height: region.height)
                                        .position(x: region.midX, y: region.midY)
                                } else { Rectangle() }
                            }
                    }
                    // 3D 示範：在畫面上第一個看得到的欄上方標 A–J（板子絲印的列標只在兩端，放大時看不到）
                    if mode == .sim3D, let result {
                        RowLetters3D(result: result, map: map, region: region, highlight: currentRows).allowsHitTesting(false)
                    }
                }
            }
            .ignoresSafeArea()
            .overlay {
                if arBlocked { arUnsupportedPanel } else if result == nil { aimHint }
            }
            .overlay(alignment: .bottom) {
                if let project = session.viewProject {
                    VStack(spacing: 8) {
                        // 自動同步、電腦移動進度等提示：步驟卡上方的提示條，約 4 秒
                        if let toast { toastView(toast) }
                        Group {
                            if showCompletion { completionCard(project) }
                            else {
                                // 沒有 AR：先在面板選 3D／2D，步驟卡暫時不能按
                                stepCard(project, resolver: result.map(HoleResolver.init))
                                    .disabled(arBlocked)
                                    .opacity(arBlocked ? 0.35 : 1)
                            }
                        }
                        .padding(.horizontal, 16)
                        // 只往上收（卡片最高時的位置），換步驟時板子不會忽大忽小
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("guideRoot")).minY } action: { y in
                            if y < cardTop - 0.5 || !cardMeasured { cardTop = y; cardMeasured = true }
                        }
                    }
                    .padding(.bottom, 4)
                }
            }
        }
        .overlay(alignment: .top) {
            VStack(spacing: 8) {
                topBar
                // 連線錯誤比「為什麼離線」的說明重要：重新連線失敗時一定看得到
                // 連不上（電腦重開）最優先：連上了才談切換專案
                if session.needsReconnect || session.reconnectError != nil { reconnectBanner }
                else if let s = session.pendingSwitch { switchBanner(s) }
                else if let o = session.otherProject { otherProjectBanner(o) }
                else if session.syncDeferred { deferredBanner }
                else if let n = session.offlineNotice { offlineNoticeBanner(n) }
                // 麵包板大小：放不下（大提示）／已搬過去（一行說明）
                if let f = session.boardFit, f.state != .same { fitBanner(f) }
            }
            // 板子（2D 的 A–J 欄頭）放在標題列＋提示框的下面，提示框不會蓋住欄頭
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("guideRoot")).maxY } action: { headerBottom = $0 }
            .padding(.horizontal, 16).padding(.top, 4)
        }
        .coordinateSpace(.named("guideRoot"))
        .environment(\.colorScheme, .dark)
        .tint(.white)
        .task(id: "\(mode.rawValue)-\(arRetry)") { await startMode() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            if mode == .ar, ar == nil, !arBlocked { arRetry += 1 }   // 剛在設定打開相機
        }
        .onDisappear { ar?.stop() }
        .modifier(GuideDialogs(view: self))
    }


    /// 提示框、確認、輸入（拆出來，body 才不會太長編不過）
    fileprivate func dialogs<V: View>(_ content: V) -> some View {
        content
        .sheet(isPresented: $showSteps) { StepListSheet(session: session) }
        .sheet(isPresented: $showScanner) { scannerSheet }
        .confirmationDialog("把剩下的步驟都標成完成？", isPresented: $confirmMarkAll, titleVisibility: .visible) {
            Button("全部標為完成") { session.markAllDone() }
        } message: {
            Text("之後可以在步驟清單裡個別取消。")
        }
        .alert("手動輸入電腦位址", isPresented: $showManual) {
            TextField("IP:埠，例如 192.168.1.23:47820", text: $manualAddress)
                .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("token", text: $manualToken)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("取消", role: .cancel) {}
            Button("連線") {
                if let ep = LanEndpoint(address: manualAddress, token: manualToken) {
                    Task { await session.connect(ep, inPlace: true) }
                } else { flash(LinkError.badAddress.message) }
            }
        } message: {
            Text("在電腦 Studio 的「手機 AR」視窗可以看到 IP 和 token。")
        }
        .alert("手機和電腦的進度不一樣", isPresented: Binding(get: { session.progressConflict != nil }, set: { _ in }),
               presenting: session.progressConflict) { c in
            // 完成步數多的那邊放前面、標「建議」
            let phoneFirst = c.phoneDone.count >= c.desktopDone.count
            let phoneTitle = "用手機的進度（第 \(c.phoneStep + 1) 步）" + (phoneFirst && c.phoneDone.count != c.desktopDone.count ? "（建議）" : "")
            let deskTitle = "用電腦的進度（第 \(c.desktopStep + 1) 步）" + (!phoneFirst ? "（建議）" : "")
            if phoneFirst {
                Button(phoneTitle) { session.resolveConflict(.phone) }
                Button(deskTitle) { session.resolveConflict(.desktop) }
            } else {
                Button(deskTitle) { session.resolveConflict(.desktop) }
                Button(phoneTitle) { session.resolveConflict(.phone) }
            }
            Button("合併：兩邊勾過的都算完成") { session.resolveConflict(.merge) }
            Button("稍後再決定", role: .cancel) { session.deferConflict() }
        } message: { c in
            Text(conflictMessage(c))
        }
            .modifier(GuideChanges(view: self))
    }

    fileprivate func changes<V: View>(_ content: V) -> some View {
        content
        .onChange(of: session.stepPosition) { _, _ in syncStyle() }
        .onChange(of: session.done) { _, _ in syncStyle() }
        .onChange(of: showAll) { _, _ in syncStyle() }
        .onChange(of: session.viewProject) { _, p in if let p { ar?.setProject(p); syncStyle() } }
        .onChange(of: ar?.detectedCols) { _, c in session.setDetectedCols(mode == .ar ? c : nil) }
        .onChange(of: fitTooSmall) { _, v in ar?.hidden = v }
        .onChange(of: session.boardFit) { old, f in
            // 偵測到板子大小（第一次）：大小一樣時提示一下；搬過去／放不下由提示框說明
            if let f, old == nil, case .same = f.state, mode == .ar { flash(f.summary) }
        }
        .onChange(of: session.updatedAt) { _, _ in
            guard session.project != nil else { return }
            flash("桌面已更新專案")
        }
        .onChange(of: session.reconnectedAt) { _, t in
            if t != nil { flash("已連上電腦，進度會同步") }
        }
        .onChange(of: session.autoSyncAt) { _, t in
            if t != nil, let n = session.autoSyncNotice { flash(n) }
        }
        .onChange(of: session.progressAppliedAt) { _, t in
            guard t != nil, session.project != nil else { return }
            let who = LinkSession.isPhone(session.progressAppliedFrom) ? "另一台手機" : "電腦"
            flash("\(who)把進度移到第 \(session.stepPosition + 1) 步")
        }
        .onChange(of: session.syncState) { _, s in
            switch s {
            case .synced?:
                syncHint = "已同步到電腦"; syncHintOK = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    if syncHintOK { withAnimation(.easeOut(duration: 0.4)) { syncHint = nil } }
                }
            case .failed?:
                syncHint = "未同步"; syncHintOK = false
            case nil:
                syncHint = nil
            }
        }
        .onChange(of: session.project == nil) { _, gone in if gone { dismiss() } }
    }

    /// 換顯示方式（也是第一次出現）：第一次先跑測試鉤子，再建立 3D／AR 場景
    private func startMode() async {
        if !didStart {
            didStart = true
            // 連線時（指引畫面還沒出現前）自動對齊了進度：打開時補顯示提示
            if let t = session.autoSyncAt, Date().timeIntervalSince(t) < 6, let n = session.autoSyncNotice { flash(n) }
            let env = ProcessInfo.processInfo.environment
            // 測試用：GUIDE_REAL_COLS=30 假裝手上是 400 孔板（17＝170 孔）
            if let c = env["GUIDE_REAL_COLS"].flatMap(Int.init) { session.boardOverride = c }
            if let s = env["GUIDE_STEP"], let n = Int(s) { session.goTo(position: n) }
            // 測試用：GUIDE_STEPLIST=1 打開步驟清單；GUIDE_COMPLETE=1 全部做完並顯示完成卡
            if env["GUIDE_STEPLIST"] != nil { showSteps = true }
            // GUIDE_COMPLETE=partial：只顯示完成卡（還有步驟沒做完）
            if let c = env["GUIDE_COMPLETE"] {
                if c != "partial" { session.markAllDone() }
                showCompletion = true
            }
            // 測試用：GUIDE_CONFIRM_MARKALL=1 打開「全部標為完成」的確認
            if env["GUIDE_CONFIRM_MARKALL"] != nil {
                Task { try? await Task.sleep(for: .seconds(1)); confirmMarkAll = true }
            }
            // 測試用：GUIDE_WALK=1 每 1.5 秒「完成這步」走 4 步，再回到第 1 步（看之後的步驟有沒有藏起來）
            if env["GUIDE_WALK"] != nil {
                Task {
                    for _ in 0..<4 { try? await Task.sleep(for: .seconds(1.5)); session.completeCurrent() }
                    try? await Task.sleep(for: .seconds(3))
                    session.goTo(position: 0)
                }
            }
            // 測試用：GUIDE_SWITCH_COMPUTER=秒數 之後按「切換到電腦的專案」
            if let t = env["GUIDE_SWITCH_COMPUTER"].flatMap(Double.init) {
                Task { try? await Task.sleep(for: .seconds(t)); await session.switchToComputerProject() }
            }
            // 測試用：GUIDE_RESOLVE=phone|desktop 2 秒後替使用者選進度（同衝突提示的按鈕）
            if let r = env["GUIDE_RESOLVE"] {
                Task { try? await Task.sleep(for: .seconds(2)); if r == "defer" { session.deferConflict() } else { session.resolveConflict(r == "phone" ? .phone : r == "merge" ? .merge : .desktop) } }
            }
            // 測試用：GUIDE_RECONNECT_AFTER=秒數 之後按「重新連線／連線同步」
            if let t = env["GUIDE_RECONNECT_AFTER"].flatMap(Double.init) {
                Task { try? await Task.sleep(for: .seconds(t)); await session.reconnect() }
            }
            // 測試用：GUIDE_SWITCH=sim3d|sim 1.5 秒後換顯示方式（同「不能用 AR」面板的按鈕）
            if let m = env["GUIDE_SWITCH"] {
                Task { try? await Task.sleep(for: .seconds(1.5)); mode = m == "sim" ? .sim2D : .sim3D }
            }
        }
        // 換顯示方式：先停掉舊的場景
        ar?.stop()
        ar = nil
        if mode != .ar { session.setDetectedCols(nil) }
        guard !simulated, !arBlocked, let project = session.viewProject else { return }
        let m = ARGuideModel(simulated: mode == .sim3D)
        ar = m
        m.hidden = fitTooSmall
        await m.start(project: project)
        m.setStyle(step: session.stepPosition, done: session.done, showAll: showAll)
    
    }

    /// 標題列下方閃一下的提示（約 2.5 秒）
    /// 提示排隊依序顯示（每則約 2.5 秒，最後一則 4 秒），不會互相蓋掉
    private func flash(_ text: String) {
        if toast == text || toastQueue.contains(text) { return }
        if toast == nil { showToast(text) } else { toastQueue.append(text) }
    }

    private func showToast(_ text: String) {
        noticeTask?.cancel()
        withAnimation(.easeOut(duration: 0.2)) { toast = text }
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(toastQueue.isEmpty ? 4 : 2.5))
            // 顯示期間又排進新的：至少再看 2.5 秒就換下一則
            guard !Task.isCancelled else { return }
            if !toastQueue.isEmpty {
                showToast(toastQueue.removeFirst())
            } else {
                withAnimation(.easeIn(duration: 0.3)) { toast = nil }
            }
        }
    }

    private func toastView(_ text: String) -> some View {
        Label(text, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.medium)).foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(GuideStyle.panel, in: Capsule())
            .overlay(Capsule().stroke(GuideStyle.hairline, lineWidth: 1))
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onTapGesture {
                noticeTask?.cancel()
                if !toastQueue.isEmpty { showToast(toastQueue.removeFirst()) } else { withAnimation { toast = nil } }
            }
    }

    /// 衝突說明：兩份各是什麼、哪份比較可能是新的
    private func conflictMessage(_ c: LinkSession.ProgressConflict) -> String {
        let when = c.phoneUpdatedAt.map { $0.formatted(.relative(presentation: .named).locale(Locale(identifier: "zh-Hant"))) }
        _ = when
        let phone = "手機：完成 \(c.phoneDone.count) 步、停在第 \(c.phoneStep + 1) 步（"
            + (c.phoneReset ? "在手機上重新開始過" : c.phoneUpdatedAt.map { Self.phoneWhen($0) } ?? "手機上存的") + "）"
        let desk = "電腦：完成 \(c.desktopDone.count) 步、停在第 \(c.desktopStep + 1) 步（"
            + (c.desktopFrom == LinkSession.myFrom || c.desktopFrom == "phone" ? "上次由這台手機同步過去"
               : LinkSession.isPhone(c.desktopFrom) ? "另一台手機做的" : "在電腦上做的") + "）"
        let hint: String
        if c.phoneReset { hint = "你在手機上重新開始了，要清掉電腦上的進度請選手機。" }
        else if c.phoneDone.count != c.desktopDone.count {
            hint = (c.phoneDone.count > c.desktopDone.count ? "手機" : "電腦") + "完成的步驟比較多（\(max(c.phoneDone.count, c.desktopDone.count)) vs \(min(c.phoneDone.count, c.desktopDone.count))）。選一份，另一邊會跟著改。"
        } else { hint = "兩邊完成的步數一樣、停的位置不同。選一份，另一邊會跟著改。" }
        return phone + "\n" + desk + "\n" + hint
    }

    /// 「剛剛在手機上做的」／「12 分鐘前在手機上做的」／「3 小時前…」／「2 天前…」
    static func phoneWhen(_ d: Date) -> String {
        let sec = max(0, Date().timeIntervalSince(d))
        let ago: String
        switch sec {
        case ..<60: ago = "剛剛"
        case ..<3600: ago = "\(Int(sec / 60)) 分鐘前"
        case ..<86400: ago = "\(Int(sec / 3600)) 小時前"
        default: ago = "\(Int(sec / 86400)) 天前"
        }
        return ago + "在手機上做的"
    }

    private var currentWireId: String? {
        guard let p = session.viewProject, p.steps.indices.contains(session.stepPosition) else { return nil }
        let st = p.steps[session.stepPosition]
        return st.isWire ? st.targetId : nil
    }

    private func syncStyle() {
        ar?.setStyle(step: session.stepPosition, done: session.done, showAll: showAll)
    }

    // MARK: - 標題列

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(GuideStyle.secondaryText)
                    .frame(width: 34, height: 34)
                    .background(GuideStyle.secondaryBG, in: Circle())
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 1) {
                Text(session.displayTitle ?? "專案").font(.subheadline.weight(.medium))
                    .foregroundStyle(.white).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(subtitleColor).lineLimit(2)
            }
            Spacer(minLength: 0)
            // 下方已經有「重新連線／切換」提示框時不重複顯示
            if session.isOffline, session.canReconnect, session.otherProject == nil,
               !session.needsReconnect, session.reconnectError == nil {
                // 離線打開的存檔：直接在這裡接上電腦（進度不同時會問要用哪一份）
                Button { Task { await session.reconnect() } } label: {
                    HStack(spacing: 5) {
                        if session.reconnecting { ProgressView().controlSize(.mini) }
                        else { Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11, weight: .semibold)) }
                        Text("連線同步").font(.caption.weight(.medium))
                    }
                    .padding(.horizontal, 10).frame(height: 34)
                    .foregroundStyle(GuideStyle.primaryText)
                    .background(GuideStyle.primaryBG, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(session.reconnecting)
            }
            // 顯示方式：AR 相機／3D 示範／2D 麵包板（任何模式都能換）
            Menu {
                Picker("顯示方式", selection: $mode) {
                    if ARWorldTrackingConfiguration.isSupported {
                        Label("AR 相機", systemImage: "camera.viewfinder").tag(GuideMode.ar)
                    }
                    Label("3D 示範", systemImage: "cube").tag(GuideMode.sim3D)
                    Label("2D 麵包板", systemImage: "square.grid.3x3").tag(GuideMode.sim2D)
                }
                // 麵包板大小：手上的板子比專案小時，走線會搬到真的板子上
                Picker("麵包板大小", selection: Binding(get: { session.boardOverride ?? 0 },
                                                   set: { session.boardOverride = $0 == 0 ? nil : $0 })) {
                    Text(mode == .ar ? "麵包板大小：自動偵測" : "麵包板大小：和專案一樣").tag(0)
                    Text("830 孔（63 欄）").tag(63)
                    Text("400 孔（30 欄）").tag(30)
                    Text("170 孔（17 欄）").tag(17)
                }
            } label: {
                Text(mode == .ar ? "AR" : mode == .sim3D ? "3D" : "2D").font(.caption.weight(.semibold))
                    .frame(width: 34, height: 34)
                    .foregroundStyle(GuideStyle.secondaryText)
                    .background(GuideStyle.secondaryBG, in: Circle())
            }
            .accessibilityLabel("顯示方式")
            if mode == .ar, let ar {
                Button { ar.relock() } label: {
                    Text("重新對位").font(.caption.weight(.medium))
                        .padding(.horizontal, 10).frame(height: 34)
                        .foregroundStyle(GuideStyle.secondaryText)
                        .background(GuideStyle.secondaryBG, in: Capsule())
                }
                .buttonStyle(.plain)
                iconButton("arrow.triangle.2.circlepath", on: ar.flip) { ar.flip.toggle() }
                iconButton(ar.torch ? "flashlight.on.fill" : "flashlight.off.fill", on: ar.torch) { ar.torch.toggle() }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .guidePanel(16)
    }

    private var subtitle: String {
        if let notice { return notice }
        if let w = session.pollWarning { return w }
        if arUnsupported { return "這台裝置不能用 AR" }
        if arCameraDenied { return "相機權限被關閉" }
        if mode == .ar, let ar, ar.status != .locked { return ar.statusText }
        if session.isDemo {
            switch mode {
            case .sim2D: return "範例專案 · 2D 麵包板 · 範例進度不會保存"
            case .sim3D: return "範例專案 · 3D 示範 · 範例進度不會保存"
            case .ar: return "範例專案 · " + (ar?.statusText ?? "") + " · 範例進度不會保存"
            }
        }
        if session.isOffline { return "存在手機的專案 · 進度只記在手機" }
        if session.detached { return "留在目前專案 · 不同步進度" }
        return session.endpoint.map { "已連線〈\(session.hostName ?? $0.display)〉" } ?? ""
    }

    private var subtitleColor: Color {
        if session.pollWarning != nil { return .orange }
        return GuideStyle.muted
    }

    private func iconButton(_ icon: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 14, weight: .semibold))
                .frame(width: 34, height: 34)
                .foregroundStyle(on ? GuideStyle.primaryText : GuideStyle.secondaryText)
                .background(on ? GuideStyle.primaryBG : GuideStyle.secondaryBG, in: Circle())
        }
        .buttonStyle(.plain)
    }

    /// 電腦換了專案：不自動換，讓使用者選
    private func switchBanner(_ info: LanInfo) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            let other = info.title ?? info.projectId ?? "其他專案"
            Text("電腦已切換到〈\(other)〉")
                .font(.subheadline.weight(.medium)).foregroundStyle(.white)
            // 兩個選項的後果說清楚
            VStack(alignment: .leading, spacing: 2) {
                Text("切換：改看電腦上的〈\(other)〉，這份的進度留在手機")
                Text("留下：繼續做這份，但不和電腦同步")
            }
            .font(.caption).foregroundStyle(GuideStyle.muted)
            HStack(spacing: 8) {
                pill("切換", primary: true) { Task { await session.acceptSwitch() } }
                pill("留在目前專案", primary: false) { session.stayOnCurrent() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .guidePanel(16)
    }

    /// 電腦開著別的專案：不換掉這份，讓使用者選
    private func otherProjectBanner(_ o: LinkSession.OtherProject) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(session.isOffline ? "電腦開著〈\(o.title)〉，這裡用手機上存的這份" : o.message)
                .font(.subheadline.weight(.medium)).foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            if session.isOffline {
                Text("要接著做這份：在電腦打開它，再按下面的「再試一次」。")
                    .font(.caption).foregroundStyle(GuideStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                pill(session.reconnecting ? "切換中…" : "切換到電腦的專案", primary: false) {
                    Task { await session.switchToComputerProject() }
                }
                .disabled(session.reconnecting)
                pill("留在這份", primary: true) { session.dismissOtherProject() }
            }
            .padding(.top, 4)
            if session.isOffline, session.canReconnect {
                // 在電腦打開這份之後，直接在這裡重試（標題列的「連線同步」在提示框出現時不顯示）
                Button { Task { await session.reconnect() } } label: {
                    HStack(spacing: 5) {
                        if session.reconnecting { ProgressView().controlSize(.mini) }
                        else { Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11, weight: .semibold)) }
                        Text("已在電腦打開這份？再試一次").font(.caption.weight(.medium))
                    }
                    .foregroundStyle(GuideStyle.secondaryText)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .disabled(session.reconnecting)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .guidePanel(16)
    }

    /// 衝突「稍後再決定」：提醒還沒同步，隨時可以決定
    private var deferredBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "pause.circle").foregroundStyle(.orange)
            Text("進度先記在手機、還沒和電腦對齊").font(.caption).foregroundStyle(GuideStyle.secondaryText)
            Spacer(minLength: 0)
            Button { session.reopenConflict() } label: {
                Text("現在決定").font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).frame(height: 28)
                    .foregroundStyle(GuideStyle.primaryText)
                    .background(GuideStyle.primaryBG, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .guidePanel(14)
    }

    /// 麵包板大小和專案不同
    @ViewBuilder
    private func fitBanner(_ f: BoardFit) -> some View {
        if f.isTooSmall {
            VStack(alignment: .leading, spacing: 6) {
                Label("麵包板太小", systemImage: "rectangle.compress.vertical").font(.subheadline.weight(.medium)).foregroundStyle(.white)
                Text(f.summary).font(.caption).foregroundStyle(GuideStyle.muted).fixedSize(horizontal: false, vertical: true)
                Text(mode == .ar ? "AR 先不畫走線（會超出板子）。可以先用 3D 示範／2D 看完整接線。"
                     : mode == .sim3D ? "3D 先不顯示（板子放不下這個專案）。切到 2D 可看你這塊板子的實際大小。"
                     : "下面是你選的 \(BoardFit.kind(f.realCols)) 麵包板，走線放不下所以不畫。")
                    .font(.caption).foregroundStyle(GuideStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    if mode == .ar {
                        pill("3D 示範", primary: true) { mode = .sim3D }
                        pill("2D 麵包板", primary: false) { mode = .sim2D }
                    } else if mode == .sim3D {
                        pill("2D 麵包板", primary: true) { mode = .sim2D }
                    }
                    if session.boardOverride != nil {
                        pill("用專案的大小", primary: mode != .ar) { session.boardOverride = nil }
                    }
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .guidePanel(16)
        } else {
            HStack(spacing: 8) {
                Image(systemName: "arrow.left.and.right.square").foregroundStyle(GuideStyle.secondaryText)
                Text(f.summary + (session.boardOverride == nil ? "（偵測不對？右上選單可改板子大小）" : ""))
                    .font(.caption).foregroundStyle(GuideStyle.secondaryText).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .guidePanel(14)
        }
    }

    /// 為什麼用手機上存的（電腦沒開專案、連不上…）
    private func offlineNoticeBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle").foregroundStyle(GuideStyle.secondaryText)
            Text(text).font(.caption).foregroundStyle(GuideStyle.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { session.dismissOfflineNotice() } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(GuideStyle.secondaryText).frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("關閉")
        }
        .padding(12)
        .guidePanel(16)
    }

    /// 電腦重開（token 換了）／離線連線失敗：說明＋重新連線／掃描 QR
    private var reconnectBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(session.needsReconnect ? "電腦重開過，需要重新連線" : "沒有連上電腦")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.white)
                Spacer()
                if !session.needsReconnect {
                    Button { session.clearReconnectError() } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(GuideStyle.secondaryText).frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("關閉")
                }
            }
            Text(session.reconnectError ?? "進度先記在手機，連上後會和電腦對齊。")
                .font(.caption).foregroundStyle(GuideStyle.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                // 連線碼換了：掃 QR／手動輸入才是解法，放前面當主要按鈕
                let tokenGone = session.needsNewToken
                if !tokenGone {
                    pill(session.reconnecting ? "連線中…" : "重新連線", primary: true) { Task { await session.reconnect() } }
                        .disabled(session.reconnecting)
                }
                pill("掃描 QR", primary: tokenGone) { showScanner = true }
                pill("手動輸入", primary: tokenGone) {
                    if manualAddress.isEmpty, let ep = session.endpoint ?? session.savedEndpoint { manualAddress = ep.display }
                    showManual = true
                }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .guidePanel(16)
    }

    private var scannerSheet: some View {
        NavigationStack {
            Group {
                QRScanContent(fallbackHint: "按「手動輸入」填電腦上顯示的 IP 和 token") { code in
                    showScanner = false
                    if let ep = LanEndpoint(qr: code) { Task { await session.connect(ep, inPlace: true) } }
                    else { flash("這不是 AssembleX 的 QR code") }
                }
            }
            .navigationTitle("掃描電腦上的 QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { showScanner = false } } }
        }
    }

    private func pill(_ title: String, primary: Bool, height: CGFloat = 36, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: height)
                .foregroundStyle(primary ? GuideStyle.primaryText : GuideStyle.secondaryText)
                .background(primary ? GuideStyle.primaryBG : GuideStyle.secondaryBG, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    /// 選了 AR 但裝置不支援：說明並讓使用者改用 3D／2D
    private var arUnsupportedPanel: some View {
        VStack(spacing: 8) {
            Image(systemName: arCameraDenied ? "camera.badge.ellipsis" : "camera.metering.unknown").font(.system(size: 30, weight: .light))
            Text(arCameraDenied ? "相機權限被關閉" : "這台裝置不能用 AR").font(.headline)
            Text(arCameraDenied ? "AR 要用相機。到「設定 › AssembleX」打開相機，或先改用 3D 示範／2D 麵包板，接線步驟一樣。"
                 : "AR 需要支援世界追蹤的 iPhone。改用 3D 示範或 2D 麵包板，接線步驟一樣。")
                .font(.caption).foregroundStyle(GuideStyle.muted).multilineTextAlignment(.center)
            if arCameraDenied {
                pill("打開設定", primary: true) {
                    if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                }
                .padding(.top, 4)
            }
            HStack(spacing: 8) {
                pill("3D 示範", primary: !arCameraDenied) { mode = .sim3D }
                pill("2D 麵包板", primary: false) { mode = .sim2D }
            }
            .padding(.top, 4)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20).padding(.vertical, 16)
        .guidePanel(16)
        .padding(32)
    }

    /// 偵測不可靠：不畫猜測的位置
    private var aimHint: some View {
        VStack(spacing: 6) {
            Image(systemName: "viewfinder").font(.system(size: 34, weight: .light))
            Text("請對準麵包板").font(.headline)
            Group {
                if let ar, ar.statusText != "請對準麵包板" { Text(ar.statusText) }
            }
            .font(.caption).foregroundStyle(GuideStyle.muted).multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20).padding(.vertical, 14)
        .guidePanel(16)
        .padding(40)
    }

    // MARK: - 步驟卡

    private func stepCard(_ project: LanProject, resolver: HoleResolver?) -> some View {
        let steps = project.steps
        let i = min(session.stepPosition, max(0, steps.count - 1))
        let step = steps.indices.contains(i) ? steps[i] : nil
        return VStack(alignment: .leading, spacing: 10) {
            if let step {
                HStack(spacing: 8) {
                    // 點這裡打開全部步驟（可跳步、勾完成）
                    Button { showSteps = true } label: {
                        HStack(spacing: 3) {
                            if session.done.contains(step.index) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            }
                            Text("第 \(i + 1) / \(steps.count) 步").monospacedDigit()
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(GuideStyle.secondaryText)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("第 \(i + 1) 步，共 \(steps.count) 步，打開步驟清單")
                    // 元件步驟：位號（LED1）；導線步驟：色塊＋導線編號（W_5V），兩者同一種膠囊
                    HStack(spacing: 6) {
                        if step.isWire, let w = project.wire(step.targetId) {
                            Capsule().fill(Color(hex: w.color)).overlay(Capsule().stroke(.white.opacity(0.35), lineWidth: 1))
                                .frame(width: 16, height: 6)
                        }
                        Text(step.tag ?? step.targetId.uppercased()).font(.caption.weight(.semibold))
                            .foregroundStyle(GuideStyle.secondaryText)
                    }
                    .padding(.horizontal, 7).padding(.vertical, 1)
                    .background(GuideStyle.secondaryBG, in: Capsule())
                    if let syncHint {
                        if syncHintOK {
                            Text(syncHint).font(.caption2).foregroundStyle(GuideStyle.muted)
                                .transition(.opacity)
                        } else {
                            // 送失敗：點一下重送（輪詢恢復時也會自動重送）
                            Button { session.retrySync() } label: {
                                Text(session.needsReconnect ? "未同步" : "未同步 · 重試").font(.caption2.weight(.medium))
                                    .foregroundStyle(.orange)
                                    .padding(.horizontal, 7).padding(.vertical, 3)
                                    .background(Color.orange.opacity(0.15), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .disabled(session.needsReconnect)
                        }
                    }
                    Spacer()
                    allWiresToggle
                }
                Text(step.title).font(.title3.weight(.semibold)).foregroundStyle(.white)
                if fitTooSmall {
                    // 板子放不下：這一步的孔在手上的板子不存在，不列出來（避免照著打勾）
                    Label("這一步的孔位在你的板子上不存在", systemImage: "rectangle.compress.vertical")
                        .font(.subheadline).foregroundStyle(.orange)
                } else {
                    let detail = project.detail(of: step)
                    if !detail.isEmpty { Text(detail).font(.subheadline).foregroundStyle(GuideStyle.muted) }
                    // 外接元件（不插麵包板，例如 LD06 用排線）：說清楚放哪裡
                    if !step.isWire, step.holes.isEmpty {
                        Label("這個元件不插麵包板（外接），放在板子旁邊，用排線接出來", systemImage: "cable.connector")
                            .font(.caption).foregroundStyle(GuideStyle.secondaryText)
                    }
                    // 哪些孔是通的（和桌面同一個說法）
                    let hints = project.connectivityHints(step)
                    if !hints.isEmpty {
                        Text(hints.prefix(2).joined(separator: "\n")).font(.caption).foregroundStyle(GuideStyle.muted.opacity(0.85))
                    }
                }
                if let warn = warning(project, step, resolver) {
                    Label(warn, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
                }
                HStack(spacing: 10) {
                    pill("上一步", primary: false, height: 46) { session.goTo(position: i - 1) }
                        .frame(width: 104)
                        .opacity(i == 0 ? 0.4 : 1)
                        .disabled(i == 0)
                    let isLast = i == steps.count - 1
                    pill(isLast ? "全部完成" : (session.done.contains(step.index) ? "下一步" : "完成這步，下一步"),
                         primary: !fitTooSmall, height: 46) {
                        if isLast {
                            session.completeLast()
                            withAnimation(.easeOut(duration: 0.25)) { showCompletion = true }
                        } else { session.completeCurrent() }
                    }
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
                }
            } else {
                Text("這個專案沒有組裝步驟").font(.headline).foregroundStyle(.white)
            }
        }
        .padding(14)
        .guidePanel(20)
    }

    /// 按「全部完成」後的完成卡（不自動關，使用者自己選下一步）
    private func completionCard(_ project: LanProject) -> some View {
        let steps = project.steps
        let left = steps.enumerated().filter { !session.done.contains($0.element.index) }
        let allDone = left.isEmpty
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Image(systemName: allDone ? "checkmark.seal.fill" : "exclamationmark.circle.fill")
                    .font(.system(size: 28)).foregroundStyle(allDone ? .green : .orange)
                Spacer()
                Button { withAnimation { showCompletion = false } } label: {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(GuideStyle.secondaryText)
                        .frame(width: 28, height: 28)
                        .background(GuideStyle.secondaryBG, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("關閉")
            }
            Text(allDone ? "\(steps.count) 步都完成了" : "還有 \(left.count) 步沒勾完成")
                .font(.title3.weight(.semibold)).foregroundStyle(.white)
            Text(allDone ? "通電前，打開全部接線再對照一次。\n下一步：在電腦的「韌體」下載程式上傳到開發板。"
                 : "第 " + left.prefix(5).map { "\($0.offset + 1)" }.joined(separator: "、") + (left.count > 5 ? "… " : " ") + "步還沒完成。")
                .font(.subheadline).foregroundStyle(GuideStyle.muted)
            if let first = left.first {
                HStack(spacing: 10) {
                    pill("跳到第 \(first.offset + 1) 步", primary: false, height: 46) {
                        session.goTo(position: first.offset)
                        withAnimation { showCompletion = false }
                    }
                    pill("全部標為完成", primary: false, height: 46) { confirmMarkAll = true }
                }
            }
            HStack(spacing: 10) {
                if left.isEmpty {
                    pill("檢查全部接線", primary: false, height: 46) {
                        showAll = true
                        withAnimation { showCompletion = false }
                    }
                }
                pill("回到專案列表", primary: true, height: 46) { dismiss() }
            }
        }
        .padding(14)
        .guidePanel(20)
    }

    /// 模擬板要捲到的欄：目前步驟用到的孔的平均欄號
    private var focusTarget: Double? {
        guard let p = session.viewProject, p.steps.indices.contains(session.stepPosition) else { return nil }
        let step = p.steps[session.stepPosition]
        let cols = step.holes.compactMap { HoleID($0)?.column(columns: p.columns) }
        guard !cols.isEmpty else { return nil }
        return cols.reduce(0, +) / Double(cols.count)
    }

    private var allWiresToggle: some View {
        Button { showAll.toggle() } label: {
            Text("全部接線").font(.caption.weight(.medium))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .foregroundStyle(showAll ? Color.black : GuideStyle.secondaryText)
                .background(showAll ? GuideStyle.primaryBG : GuideStyle.secondaryBG, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func warning(_ project: LanProject, _ step: LanProject.Step, _ resolver: HoleResolver?) -> String? {
        if fitTooSmall { return nil }   // 板子放不下：上方提示框已說明
        if let snapped = session.boardFit?.railSnapped, let h = step.holes.first(where: snapped.contains) {
            return "這塊麵包板的電源軌孔位和專案不同：請插 \(project.label(h))（最接近的軌孔）"
        }
        guard let resolver else { return nil }
        if project.columns != resolver.result.cols, !fitTooSmall {   // 放不下時上方提示框已說明
            return "專案用 \(project.columns) 欄的麵包板，畫面上是 \(resolver.result.boardKind)"
        }
        let missing = step.holes.filter { resolver.point($0) == nil }
        if !missing.isEmpty {
            let rail = missing.contains { if case .rail? = HoleID($0) { return true } else { return false } }
            return "看不到 " + missing.map(project.label).joined(separator: "、")
                + (rail && mode == .ar ? "（電源軌要一起入鏡）" : "")
        }
        if step.isWire, let w = project.wire(step.targetId), w.from.hole == nil, w.to.hole == nil {
            return "這條線不經過麵包板：\(project.text(w.from)) → \(project.text(w.to))"
        }
        return nil
    }
}

/// 全部步驟：點一步跳過去，點左邊圓圈勾／取消完成
private struct StepListSheet: View {
    let session: LinkSession
    @Environment(\.dismiss) private var dismiss
    @State private var confirmReset = false

    var body: some View {
        let steps = session.viewProject?.steps ?? []
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    Section {
                        ForEach(Array(steps.enumerated()), id: \.offset) { pos, st in
                            row(pos, st)
                                .id(pos)
                                .listRowBackground(pos == session.stepPosition ? Color.white.opacity(0.08) : nil)
                        }
                    } footer: {
                        Text("點步驟跳過去；點左邊的圓圈可以勾或取消「完成」。")
                    }
                    Section {
                        Button("重新開始（清掉所有進度）", role: .destructive) { confirmReset = true }
                            .foregroundStyle(.red)
                            .disabled(session.done.isEmpty && session.stepPosition == 0)
                    }
                }
                // 等清單排好再捲：目前這步放在偏上的中間，上一步還看得到一部分
                .task {
                    try? await Task.sleep(for: .milliseconds(80))
                    proxy.scrollTo(session.stepPosition, anchor: UnitPoint(x: 0.5, y: 0.4))
                }
            }
            .navigationTitle("全部步驟（\(session.done.count)/\(steps.count) 完成）")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("關閉") { dismiss() } }
            }
            .confirmationDialog("清掉所有進度、回到第 1 步？", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("重新開始", role: .destructive) { session.resetProgress(); dismiss() }
            } message: {
                Text(session.isDemo ? "範例進度不會保存。"
                     : session.isOffline || session.detached || session.endpoint == nil ? "只清掉手機上的進度。"
                     : "已連線：電腦上的進度也會一起清掉。")
            }
        }
        .presentationDetents([.medium, .large])
        .environment(\.colorScheme, .dark)
        .tint(.white)
    }

    private func row(_ pos: Int, _ st: LanProject.Step) -> some View {
        let isDone = session.done.contains(st.index)
        return HStack(spacing: 12) {
            Button { session.toggleDone(stepIndex: st.index) } label: {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3).foregroundStyle(isDone ? Color.green : Color.secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isDone ? "取消完成" : "標成完成")
            Button { session.goTo(position: pos); dismiss() } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("第 \(pos + 1) 步 · \(st.tag ?? st.targetId.uppercased())")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(st.title).foregroundStyle(isDone ? .secondary : .primary)
                        // 同名步驟（「接地線」×6）靠這一行分辨：孔位／腳位
                        if let p = session.viewProject {
                            let d = p.detail(of: st)
                            if !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                    }
                    Spacer()
                    if pos == session.stepPosition {
                        Text("目前").font(.caption.weight(.semibold)).foregroundStyle(.black)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(Color.white, in: Capsule())
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// 3D 示範的列標：第一個完整看得到的欄往上一格，標 A–J（小字＋深色底）
private struct RowLetters3D: View {
    let result: BreadboardResult
    let map: ImageToView
    let region: CGRect
    /// 目前這一步用到的列：標成白底（容易找到是哪一排）
    var highlight: Set<Int> = []

    var body: some View {
        Canvas { ctx, _ in
            let rows = BreadboardResult.rowLetters.indices
            func pt(_ r: Int, _ c: Int) -> CGPoint? { result.hole(row: r, col: c).map { map.view($0.point) } }
            let inner = region.insetBy(dx: 8, dy: 0)
            // 第一個 10 列都在可用範圍內、而且上一格也在範圍內的欄
            var c0: Int?
            for c in 1..<max(1, result.cols - 1) {
                let ps = rows.compactMap { pt($0, c) }
                guard ps.count == rows.count, ps.allSatisfy({ inner.contains($0) }) else { continue }
                let ups = rows.compactMap { r -> CGPoint? in
                    guard let a = pt(r, c), let b = pt(r, c + 1) else { return nil }
                    return CGPoint(x: a.x + (a.x - b.x) * 1.1, y: a.y + (a.y - b.y) * 1.1)
                }
                guard ups.count == rows.count, ups.allSatisfy({ inner.contains($0) }) else { continue }
                c0 = c; break
            }
            guard let c0 else { return }
            // 第 1 欄看得到時，板子上印的列標就在那裡，不重複畫
            if rows.allSatisfy({ r in pt(r, 0).map { inner.contains($0) } ?? false }) { return }
            for r in rows {
                guard let a = pt(r, c0), let b = pt(r, c0 + 1) else { continue }
                let p = CGPoint(x: a.x + (a.x - b.x) * 1.1, y: a.y + (a.y - b.y) * 1.1)
                let hi = highlight.contains(r)
                let t = ctx.resolve(Text(BreadboardResult.rowLetters[r]).font(.system(size: hi ? 11 : 10, weight: hi ? .bold : .semibold))
                    .foregroundStyle(hi ? Color.black : Color(white: 0.85)))
                let m = t.measure(in: CGSize(width: 40, height: 20))
                let box = CGRect(x: p.x - m.width / 2 - 3, y: p.y - m.height / 2 - 1, width: m.width + 6, height: m.height + 2)
                ctx.fill(Path(roundedRect: box, cornerRadius: 4), with: .color(hi ? .white : .black.opacity(0.7)))
                ctx.draw(t, at: p)
            }
        }
    }
}

/// 模擬板捲動：每個顯示幀往目標欄靠近一點（約 0.3 秒到位）
final class FocusEaser {
    private var value: Double?
    private var last: Double?

    func step(toward target: Double?, time t: Double) -> Double? {
        guard let target else { return value }
        guard let v = value, let l = last else { value = target; last = t; return target }
        let dt = min(max(t - l, 0), 0.1)
        last = t
        let k = 1 - exp(-dt / 0.08)
        value = abs(target - v) < 0.01 ? target : v + (target - v) * k
        return value
    }
}

/// 模擬模式的底圖：和桌面 3D 麵包板同色（#2a2c31），孔 #0d0d0f；欄號由疊圖畫在導線之上
private struct SimulatedBoardView: View {
    let time: Double
    let region: CGRect
    let focusCol: Double?
    let result: BreadboardResult?
    let map: ImageToView
    var cols = 63

    var body: some View {
        Canvas { ctx, _ in
            var body = Path()
            body.addLines(SimulatedBoard.body(time: time, region: region, focusCol: focusCol, cols: cols).map(map.view))
            body.closeSubpath()
            ctx.fill(body, with: .color(GuideStyle.board))
            ctx.stroke(body, with: .color(.white.opacity(0.06)), lineWidth: 1)
            guard let result else { return }
            // 中央溝
            if let e1 = result.hole(row: 4, col: 0), let f1 = result.hole(row: 5, col: 0),
               let eN = result.hole(row: 4, col: result.cols - 1), let fN = result.hole(row: 5, col: result.cols - 1) {
                var ch = Path()
                ch.move(to: map.view((e1.point + f1.point) / 2))
                ch.addLine(to: map.view((eN.point + fN.point) / 2))
                ctx.stroke(ch, with: .color(.black.opacity(0.35)),
                           style: StrokeStyle(lineWidth: CGFloat(result.pitch) * map.scale * 1.2))
            }
            let r = CGFloat(result.pitch) * map.scale * 0.2
            for p in result.holes.map(\.point) + result.rails.map(\.point) {
                let v = map.view(p)
                ctx.fill(Path(roundedRect: CGRect(x: v.x - r, y: v.y - r, width: 2 * r, height: 2 * r), cornerRadius: r * 0.3),
                         with: .color(GuideStyle.hole))
            }
            // ＋軌整條淡紅、−軌整條淡藍，一眼看出哪條是＋
            for row in result.railRows {
                guard let a = row.first, let b = row.last, row.count > 1 else { continue }
                var band = Path()
                band.move(to: map.view(a.point))
                band.addLine(to: map.view(b.point))
                ctx.stroke(band, with: .color((a.line == 0 ? Color(hex: "#d0342c") : Color(hex: "#2563a8")).opacity(0.10)),
                           style: StrokeStyle(lineWidth: CGFloat(result.pitch) * map.scale * 1.05, lineCap: .square))
            }
            // 電源軌色線（同桌面：內排＋紅線在靠主區那側、外排−藍線在外側）
            for row in result.railRows {
                guard let a = row.first, let b = row.last, row.count > 1 else { continue }
                let toward = row[0].side == 0 ? -1.0 : 1.0
                let off = (result.hole(row: 9, col: 0)!.point - result.hole(row: 0, col: 0)!.point)
                let unit = off / max(1e-6, (off * off).sum().squareRoot()) * result.pitch * 0.55 * toward
                let shift = a.line == 0 ? -unit : unit
                var line = Path()
                line.move(to: map.view(a.point + shift))
                line.addLine(to: map.view(b.point + shift))
                ctx.stroke(line, with: .color((a.line == 0 ? Color(hex: "#d0342c") : Color(hex: "#2563a8")).opacity(0.7)),
                           lineWidth: 1)
            }
        }
    }
}

#Preview("模擬麵包板") {
    let s = LinkSession()
    s.loadDemo()
    return GuideView(session: s, mode: .sim2D)
}


private struct GuideDialogs: ViewModifier {
    let view: GuideView
    func body(content: Content) -> some View { view.dialogs(content) }
}

private struct GuideChanges: ViewModifier {
    let view: GuideView
    func body(content: Content) -> some View { view.changes(content) }
}
