import SwiftUI
import ARKit

/// 連線桌面專案：掃 QR code／Bonjour 清單／手動輸入；連上後進入接線指引。
struct ConnectView: View {
    @State private var session = LinkSession()
    @State private var browser = BonjourBrowser()
    @State private var showScanner = false
    @State private var address = ""
    @State private var token = ""
    @State private var guide: GuideLaunch?
    @State private var resolving: String?
    @State private var qrError: String?
    @State private var manualError: String?
    @State private var manualTried = false
    @State private var last = LanEndpoint.last
    @State private var recents: [RecentProject] = RecentProjects.load()
    @State private var renamingId: String?
    @State private var renameText = ""
    /// 等使用者確認的刪除／重新開始
    @State private var confirm: Confirm?
    /// 最近的專案：電腦在不在線（專案 id → 狀態）
    @State private var reach: [String: LanClient.Reach] = [:]
    @State private var probeRound = 0
    /// 正在打開（先看電腦在不在）的專案 id
    @State private var opening: String?
    /// Bonjour 找到的電腦：IP → 電腦名稱（QR／手動連線時用來顯示名稱）
    @State private var studioNames: [String: String] = [:]
    /// 找了 6 秒還沒找到 Studio：顯示說明（繼續找）
    @State private var searchSlow = false
    /// Bonjour 找到的 Studio：解析出的位址、開著哪個專案
    @State private var studioEndpoints: [String: LanEndpoint] = [:]
    @State private var studioProjects: [String: StudioProject] = [:]
    enum StudioProject: Equatable { case open(String, String?), none, unknown }
    /// 剛刪掉的專案（10 秒內可以「復原」）
    @State private var lastDeleted: RecentProject?
    @State private var deletedLast: LanEndpoint?
    /// 上一次嘗試連的位址（首頁錯誤列的「重試」）
    @State private var lastTried: LanEndpoint?
    @FocusState private var tokenFocused: Bool
    @FocusState private var addressFocused: Bool
    /// 從 Studio 清單連線：錯誤顯示在那一列下面
    @State private var studioTried: String?
    @State private var studioError: String?
    private var arSupported: Bool { ARWorldTrackingConfiguration.isSupported }

    enum Confirm: Identifiable {
        case delete(RecentProject), reset(RecentProject)
        var id: String {
            switch self {
            case let .delete(r): return "d" + r.id
            case let .reset(r): return "r" + r.id
            }
        }
        var project: RecentProject {
            switch self { case let .delete(r), let .reset(r): return r }
        }
    }
    /// 模擬器／沒有 AR 的裝置：打開專案時用 3D 示範
    private var defaultMode: GuideMode { ARWorldTrackingConfiguration.isSupported ? .ar : .sim3D }

    struct GuideLaunch: Identifiable {
        let mode: GuideMode
        var id: String { mode.rawValue }
    }

    var body: some View {
        NavigationStack {
            List {
                statusSection
                // 剛刪掉的專案：放在列表最上面（不浮在底部蓋住按鈕）
                if let d = lastDeleted {
                    Section { undoBar(d) }
                }

                if recents.isEmpty && last == nil { firstLaunchSection }

                recentSection
                connectSections
            }
            .navigationTitle("專案")

        }
        .tint(.white)
        .alert("重新命名", isPresented: Binding(get: { renamingId != nil }, set: { if !$0 { renamingId = nil } })) {
            TextField("專案名稱（最多 60 字）", text: $renameText)
                .onChange(of: renameText) { _, v in if v.count > 60 { renameText = String(v.prefix(60)) } }
            Button("取消", role: .cancel) { renamingId = nil }
            Button("儲存") {
                if let id = renamingId {
                    RecentProjects.rename(id: id, to: renameText.trimmingCharacters(in: .whitespaces)); recents = RecentProjects.load()
                }
                renamingId = nil
            }
        } message: {
            Text(renameOriginal.map { "只改手機上的名稱。留空＝用電腦上的名稱〈\($0)〉。" } ?? "")
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                            titleVisibility: .visible, presenting: confirm) { c in
            switch c {
            case let .delete(r):
                Button("刪除", role: .destructive) { delete(r) }
            case let .reset(r):
                Button("重新開始", role: .destructive) { reset(r) }
            }
        } message: { c in
            switch c {
            case .delete: Text("手機上存的專案和進度會一起刪掉；電腦上的專案不受影響。")
            case .reset: Text("清掉手機上的進度、回到第 1 步。電腦在線時也會清掉電腦上的進度；不在線的話，下次連線時會問你要用哪一份。")
            }
        }
        .onAppear { handleAppear() }
        // 用系統相機掃電腦上的 QR code（assemblex://ip:port/?t=token）打開 App：直接連線
        .onOpenURL { url in handleOpenURL(url) }
        .onDisappear { browser.stop() }
        // 每次回到列表都看一下各專案的電腦在不在
        // 電腦的狀態會變（開了 Studio、換了專案）：列表顯示期間每 5 秒重查一次
        .task(id: probeKey) {
            while !Task.isCancelled {
                await probeRecents()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        // Bonjour 找到的電腦解析出 IP，用來把「127.0.0.1:47820」顯示成電腦名稱
        .task(id: browser.studios) { await resolveStudioNames() }
        // 每 5 秒再看一次各台電腦開著什麼（電腦上開了專案，畫面會自己更新）
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await resolveStudioNames()
            }
        }
        .sheet(isPresented: $showScanner) { scannerSheet }
        .fullScreenCover(item: $guide, onDismiss: { session.disconnect(); last = LanEndpoint.last; recents = RecentProjects.load(); probeRound += 1 }) { g in
            GuideView(session: session, mode: g.mode)
        }
    }

    private func handleOpenURL(_ url: URL) {
        guard let ep = LanEndpoint(qr: url.absoluteString) else { qrError = "這不是 AssembleX 的連線網址"; return }
        manualTried = false
        if guide != nil {
            // 指引畫面開著：就地連上（電腦開著別的專案時會問）
            Task { await session.connect(withName(ep), inPlace: true) }
        } else {
            connect(ep)
        }
    }

    private func handleAppear() {
        browser.start()
        // 測試用：GUIDE_RESET=1 清掉手機上的專案與上次連線（模擬第一次打開）
        if ProcessInfo.processInfo.environment["GUIDE_RESET"] != nil {
            LanEndpoint.last = nil
            for r in RecentProjects.load() { RecentProjects.remove(id: r.id) }
            LinkSession.everConnected = false
        }
        last = LanEndpoint.last
        recents = RecentProjects.load()
        // 測試用：GUIDE_SEED_RECENT=1 把內建範例存成一筆「最近的專案」（含進度）
        if ProcessInfo.processInfo.environment["GUIDE_SEED_RECENT"] != nil,
           let url = Bundle.main.url(forResource: "sample_project", withExtension: "json"),
           let d = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(LanProject.self, from: d) {
            RecentProjects.save(p, source: "MacBook 上的 Studio", done: Array(p.steps.prefix(7).map(\.index)), stepPosition: 7)
            // 測試用：GUIDE_SEED_TITLE=名稱 順便把它改名（驗證重新連線後名稱保留）
            if let t = ProcessInfo.processInfo.environment["GUIDE_SEED_TITLE"] { RecentProjects.rename(id: p.projectId ?? p.title, to: t) }
            recents = RecentProjects.load()
        }
        // 測試用：GUIDE_DELETE_RECENT=1 刪掉第一筆最近的專案（看「復原」）
        if ProcessInfo.processInfo.environment["GUIDE_DELETE_RECENT"] != nil, let r = recents.first { delete(r) }
        // 測試用：GUIDE_RESET_RECENT=1 對第一筆最近的專案按「重新開始」
        if ProcessInfo.processInfo.environment["GUIDE_RESET_RECENT"] != nil, let r = recents.first { reset(r) }
        // 測試用：GUIDE_OPEN_RECENT=sim3d|sim 直接打開第一筆最近的專案
        if let m = ProcessInfo.processInfo.environment["GUIDE_OPEN_RECENT"], guide == nil, let r = recents.first {
            open(r, mode: m == "sim" ? .sim2D : .sim3D)
        }
        // 量測／截圖用：啟動參數環境變數 GUIDE_DEMO=sim 直接開模擬麵包板
        let env = ProcessInfo.processInfo.environment
        if let d = env["GUIDE_DEMO"], d == "sim" || d == "sim3d" || d == "ar", guide == nil {
            session.loadDemo(); guide = GuideLaunch(mode: d == "sim" ? .sim2D : (d == "sim3d" ? .sim3D : .ar))
        }
        // 測試用：GUIDE_OPEN_URL=assemblex://… 走和系統相機打開 App 一樣的處理
        if let u = env["GUIDE_OPEN_URL"].flatMap(URL.init(string:)), guide == nil { handleOpenURL(u) }
        // GUIDE_CONNECT=ip:port/token 直接連線（測試用）
        if let c = env["GUIDE_CONNECT"], guide == nil, session.phase == .idle {
            let parts = c.split(separator: "/", maxSplits: 1).map(String.init)
            if parts.count == 2, let ep = LanEndpoint(address: parts[0], token: parts[1]) { connect(ep) }
        }
    
    }

    private var probeKey: String {
        "\(probeRound)|" + recents.map { $0.id + ($0.endpoint?.display ?? "") }.joined(separator: ",")
    }

    private func probeRecents() async {
        var r: [String: LanClient.Reach] = [:]
        let targets = recents.compactMap { p in p.endpoint.map { (p.id, $0) } }
        await withTaskGroup(of: (String, LanClient.Reach).self) { g in
            for (id, ep) in targets { g.addTask { (id, await LanClient.probe(ep)) } }
            for await (id, v) in g { r[id] = v }
        }
        reach = r
    }

    /// 每台 Studio：解析 IP（把 IP 顯示成電腦名稱）並看它開著哪個專案
    private func resolveStudioNames() async {
        for s in browser.studios {
            let name = s.title ?? s.name
            guard let ep = try? await BonjourBrowser.resolve(s) else { continue }
            studioNames[ep.host] = name
            studioEndpoints[s.name] = ep
            studioProjects[s.name] = (try? await LanClient(endpoint: ep).info()).map { $0.openProjectId == nil ? .none : .open($0.projectTitle, $0.openProjectId) } ?? .unknown
        }
    }

    /// 同一個 Wi-Fi 上開著這個專案的 Studio（用它現在的連線碼）
    private func studioWithProject(_ projectId: String?) async -> LanEndpoint? {
        guard let projectId else { return nil }
        for s in browser.studios {
            var resolved = studioEndpoints[s.name]
            if resolved == nil { resolved = try? await BonjourBrowser.resolve(s) }
            guard let ep = resolved, let info = try? await LanClient(endpoint: ep).info(), info.projectId == projectId else { continue }
            return withName(ep)
        }
        return nil
    }

    @ViewBuilder
    private var recentSection: some View {
        if !recents.isEmpty {
            Section {
                ForEach(recents) { r in
                    Button { open(r, mode: defaultMode) } label: { recentRow(r) }
                        .contextMenu { recentMenu(r) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { confirm = .delete(r) } label: { Label("刪除", systemImage: "trash") }
                        }
                }
            } header: {
                Text("最近的專案")
            } footer: {
                Text("點一下打開：找到開著這個專案的電腦就連線同步，找不到就用手機上存的（進度之後再對齊）。點右邊的 ⋯（或長按）可選打開方式、改名、重新開始或刪除。")
            }
        }

    }

    @ViewBuilder
    private var connectSections: some View {
        // 沒有相機的裝置（模擬器、部分 iPad）不放掃描按鈕，改用 Studio 清單或手動輸入
        if canScan {
            Section {
                Button { qrError = nil; showScanner = true } label: {
                    Label("掃描桌面上的 QR code", systemImage: "qrcode.viewfinder")
                }
                if let qrError { Text(qrError).font(.footnote).foregroundStyle(.orange) }
            } footer: {
                Text("在桌面 Studio 按「手機 AR」會顯示 QR code。手機和電腦要在同一個 Wi-Fi。")
            }
        } else if let qrError {
            Section { Text(qrError).font(.footnote).foregroundStyle(.orange) }
        }

        // 上次連線：已經在「最近的專案」裡（長按可重新連線）就不重複顯示
        if let last, !recents.contains(where: { $0.endpoint?.display == last.display }) {
            Section("上次連線") {
                Button { connect(last) } label: {
                    LabeledContent(last.title ?? "AssembleX Studio", value: last.display)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { LanEndpoint.last = nil; self.last = nil } label: { Label("刪除", systemImage: "trash") }
                }
            }
        }

        Section {
            if browser.studios.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    ProgressView()
                    Text(searchSlow ? "沒找到。請確認電腦已打開 AssembleX Studio、在同一個 Wi-Fi，或用上面的 QR／下面的手動輸入。"
                         : "尋找中…")
                        .font(searchSlow ? .footnote : .body)
                        .foregroundStyle(.secondary)
                }
                .task {
                    try? await Task.sleep(for: .seconds(6))
                    searchSlow = true
                }
            }
            ForEach(sortedStudios) { s in
                Button { connect(s) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.title ?? s.name)
                            // 開著哪個專案（不用連上就看得到，選對電腦）
                            switch studioProjects[s.name] {
                            case let .open(title, pid)?: Text(openTitle(title, pid)).font(.caption).foregroundStyle(.secondary)
                            case .none?: Text("還沒打開專案").font(.caption).foregroundStyle(.orange)
                            case .unknown?: Text("連線碼可能換了，點一下重新連線").font(.caption).foregroundStyle(.secondary)
                            case nil: Text(s.name).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if resolving == s.name || (studioTried == s.name && { if case .connecting = session.phase { return true }; return false }()) { ProgressView() }
                    }
                }
                // 這一台連不上：原因寫在這一列下面
                if studioTried == s.name, let msg = studioError ?? { if case let .failed(m) = session.phase { return m }; return nil }() {
                    Label(msg, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
                }
            }
        } header: {
            Text("同一個 Wi-Fi 上的 Studio")
        } footer: {
            if let p = browser.problem { Text(p) }
        }

        Section("手動輸入") {
            TextField("IP:埠，例如 192.168.1.23:47820", text: $address)
                .focused($addressFocused)
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("token", text: $token)
                .focused($tokenFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button {
                manualError = nil
                if let ep = LanEndpoint(address: address, token: token) { manualTried = true; connect(ep) }
                else { manualError = LinkError.badAddress.message }
            } label: {
                HStack(spacing: 8) {
                    if manualTried, case .connecting = session.phase { ProgressView() }
                    Text("連線")
                }
            }
            .disabled(address.isEmpty || token.isEmpty || { if case .connecting = session.phase { return true }; return false }())
            // 連線結果就顯示在按鈕下面（不在看不到的列表頂端）
            if let manualError {
                Text(manualError).font(.footnote).foregroundStyle(.orange)
            } else if manualTried, case let .failed(msg) = session.phase {
                Label(msg, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
            } else if manualTried, case let .connecting(t) = session.phase {
                Text("連線到 \(t)…").font(.footnote).foregroundStyle(.secondary)
            }
        }

        Section {
            Button("範例專案＋AR 相機") { session.loadDemo(); guide = GuideLaunch(mode: .ar) }
                .disabled(!arSupported)
            Button("範例專案＋3D 示範") { session.loadDemo(); guide = GuideLaunch(mode: .sim3D) }
            Button("範例專案＋模擬麵包板（2D）") { session.loadDemo(); guide = GuideLaunch(mode: .sim2D) }
        } header: {
            Text("示範")
        } footer: {
            Text(arSupported ? "不需要桌面，用內建的 DHT22 專案試接線指引。"
                 : "不需要桌面，用內建的 DHT22 專案試接線指引。這台裝置不支援 AR，請用 3D 示範或 2D 麵包板。")
        }
    }

    @ViewBuilder
    private var statusSection: some View {
        // 手動輸入的連線結果只顯示在「連線」按鈕下面，頂端不重複
        if manualTried || studioTried != nil { EmptyView() } else { phaseStatus }
    }

    @ViewBuilder
    private var phaseStatus: some View {
        switch session.phase {
        case let .connecting(s):
            Section { HStack(spacing: 8) { ProgressView(); Text("連線到 \(s)…") } }
        case let .failed(msg):
            Section {
                HStack(alignment: .top, spacing: 8) {
                    Label(msg, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Spacer(minLength: 0)
                    Button { session.clearFailure() } label: {
                        Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("關閉")
                }
                if msg == LinkError.badToken.message {
                    // token 錯了：重試也是同一個錯的 token，改給掃 QR／手動輸入
                    HStack(spacing: 20) {
                        if canScan { Button("掃描 QR") { qrError = nil; showScanner = true }.buttonStyle(.borderless) }
                        Button("手動輸入") {
                            if let ep = lastTried { address = ep.display }
                            token = ""
                            tokenFocused = true
                        }
                        .buttonStyle(.borderless)
                    }
                } else if let ep = lastTried, ep.host.hasPrefix("127.") || ep.host == "localhost" {
                    // 127.0.0.1 是手機自己：重試沒有用，改輸入電腦的 IP
                    HStack(spacing: 20) {
                        Button("手動輸入") { address = ""; addressFocused = true }.buttonStyle(.borderless)
                        if canScan { Button("掃描 QR") { qrError = nil; showScanner = true }.buttonStyle(.borderless) }
                    }
                } else if let ep = lastTried {
                    Button("重試") { connect(ep) }.buttonStyle(.borderless)
                }
            }
        default:
            EmptyView()
        }
    }

    private var scannerSheet: some View {
        NavigationStack {
            Group {
                QRScanContent(fallbackHint: "改用「同一個 Wi-Fi 上的 Studio」清單，或手動輸入 IP 與 token") { code in
                    showScanner = false
                    if let ep = LanEndpoint(qr: code) { manualTried = false; connect(ep) }
                    else { qrError = "這不是 AssembleX 的 QR code" }
                }
            }
            .navigationTitle("掃描 QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { showScanner = false } }
            }
        }
    }

    private var canScan: Bool { QRScannerView.deviceCanScan }

    /// Studio 清單：開著專案的排前面，沒開專案的排最後
    private var sortedStudios: [BonjourBrowser.Studio] {
        func rank(_ s: BonjourBrowser.Studio) -> Int {
            switch studioProjects[s.name] {
            case .open?: return 0
            case .none?: return 2
            default: return 1
            }
        }
        return browser.studios.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
    }

    private var renameOriginal: String? { recents.first { $0.id == renamingId }?.project.title }

    private var confirmTitle: String {
        switch confirm {
        case let .delete(r)?: return "刪除〈\(r.displayTitle)〉？"
        case let .reset(r)?: return "〈\(r.displayTitle)〉重新開始？"
        case nil: return ""
        }
    }

    /// 第一次打開（沒有任何專案）：告訴使用者先做什麼
    private var firstLaunchSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                // 連過電腦的人（例如刪掉了最後一個專案）不再當成第一次使用
                Text(LinkSession.everConnected ? "連線電腦" : "第一次使用").font(.headline)
                Label("在電腦打開 AssembleX Studio 和你的專案", systemImage: "1.circle")
                if let s = sortedStudios.first(where: { if case .open? = studioProjects[$0.name] { return true } else { return false } }) {
                    // 找到開著專案的電腦：不用掃 QR，點它就好
                    Label("點下方「同一個 Wi-Fi 上的 Studio」裡的〈\(s.title ?? s.name)〉連線", systemImage: "2.circle")
                        .foregroundStyle(.green)
                } else if let s = browser.studios.first, studioProjects[s.name] == StudioProject.none {
                    // 找到電腦，但它還沒開專案：先叫使用者在電腦上開專案（不標綠色）
                    Label("在〈\(s.title ?? s.name)〉上的 Studio 打開或新建一個專案，畫面會自動更新", systemImage: "2.circle")
                } else if let s = browser.studios.first {
                    Label("點下方「同一個 Wi-Fi 上的 Studio」裡的〈\(s.title ?? s.name)〉連線", systemImage: "2.circle")
                } else {
                    Label("按 Studio 上的「手機 AR」，畫面會出現 QR code" + (canScan ? "" : "和 IP、token"), systemImage: "2.circle")
                    Label(canScan ? "點下面的「掃描桌面上的 QR code」對準它" : "在下方手動輸入電腦上顯示的 IP 和 token", systemImage: "3.circle")
                }
                Text("手邊沒有電腦？先用內建的範例專案看看接線指引：")
                    .font(.footnote).foregroundStyle(.secondary).padding(.top, 2)
                Button {
                    session.loadDemo(); guide = GuideLaunch(mode: defaultMode)
                } label: {
                    Label("先試範例專案", systemImage: "play.fill").font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .foregroundStyle(.black)
                        .background(Color.white, in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .font(.subheadline)
            .padding(.vertical, 4)
        }
    }

    /// 最近的專案的選單（長按，或點那一列右邊的 ⋯）
    @ViewBuilder
    private func recentMenu(_ r: RecentProject) -> some View {
        Button { open(r, mode: .ar) } label: { Label("用 AR 相機打開", systemImage: "camera.viewfinder") }
            .disabled(!ARWorldTrackingConfiguration.isSupported)
        Button { open(r, mode: .sim3D) } label: { Label("用 3D 示範打開", systemImage: "cube") }
        Button { open(r, mode: .sim2D) } label: { Label("用 2D 麵包板打開", systemImage: "square.grid.3x3") }
        if r.endpoint != nil {
            // 和點一下一樣：先確認電腦開著這個專案、連線碼換了就從 Wi-Fi 上找新的
            Button { open(r, mode: defaultMode) } label: { Label("連線電腦並同步進度", systemImage: "desktopcomputer") }
        }
        Divider()
        Button { renameText = r.displayTitle; renamingId = r.id } label: { Label("重新命名", systemImage: "pencil") }
        Button { confirm = .reset(r) } label: { Label("重新開始", systemImage: "arrow.counterclockwise") }
            .disabled(!r.hasProgress)
        Button(role: .destructive) { confirm = .delete(r) } label: { Label("刪除", systemImage: "trash") }
    }

    private func recentRow(_ r: RecentProject) -> some View {
        let total = r.project.steps.count, n = r.done.count
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(r.displayTitle).foregroundStyle(.primary)
                Spacer(minLength: 4)
                if opening == r.id { ProgressView().controlSize(.small) }
                // 看得到的 ⋯：打開方式、改名、重新開始、刪除（不用知道要長按）
                Menu { recentMenu(r) } label: {
                    Image(systemName: "ellipsis.circle").font(.system(size: 20)).foregroundStyle(.secondary)
                        .frame(width: 36, height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("更多：打開方式、改名、刪除")
            }
            HStack(spacing: 6) {
                // 和進度條一致：先說完成幾步（進度條就是這個），再說停在哪
                Text(total == 0 ? "沒有步驟" : n >= total ? "已完成 \(total) 步"
                     : "完成 \(n) / \(total) 步" + (r.stepPosition > 0 && r.stepPosition != n ? " · 停在第 \(min(r.stepPosition + 1, total)) 步" : ""))
                Text("·")
                Text(Date().timeIntervalSince(r.openedAt) < 60 ? "剛剛開啟"
                     : r.openedAt.formatted(.relative(presentation: .named).locale(Locale(identifier: "zh-Hant"))) + "開啟")
                if let s = sourceName(r) { Text("·"); Text(s).lineLimit(1) }
            }
            .font(.caption).foregroundStyle(.secondary)
            if r.resetPending == true {
                Label("重新開始（尚未同步到電腦）", systemImage: "arrow.counterclockwise")
                    .font(.caption2).foregroundStyle(.orange)
            }
            if r.endpoint == nil {
                // 沒記住電腦：看 Wi-Fi 上有沒有開著這個專案的 Studio
                if let name = studioOpen(r.project.projectId) {
                    Label("〈\(name)〉開著這個專案 · 點開會連線同步", systemImage: "checkmark.circle.fill")
                        .font(.caption2).foregroundStyle(.green)
                } else {
                    Label("沒有記住電腦 · 用手機上存的", systemImage: "iphone")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            if r.endpoint != nil {
                let st = rowStatus(r)
                Label(st.text, systemImage: st.ok ? "checkmark.circle.fill" : "desktopcomputer")
                    .font(.caption2)
                    .foregroundStyle(st.ok ? Color.green : Color.secondary)
            }
            if total > 0 {
                ProgressView(value: Double(n), total: Double(total)).tint(n >= total ? .green : .white)
            }
        }
        .padding(.vertical, 2)
    }

    /// 最近的專案那一行的電腦狀態：只有電腦開著「同一個專案」才寫「會同步」
    private func rowStatus(_ r: RecentProject) -> (text: String, ok: Bool) {
        switch reach[r.id] {
        case nil: return ("檢查電腦…", false)
        case .offline?: return ("電腦離線 · 用手機上存的", false)
        case .badToken?:
            // 同一個 Wi-Fi 上已經找到開著這個專案的 Studio：點開就會用新的連線碼連上
            if studioProjects.values.contains(where: { if case let .open(_, pid) = $0 { return pid == r.project.projectId } else { return false } }) {
                return ("電腦重開過 · 已找到，點開會重新連線", true)
            }
            return ("電腦重開過 · 打開後掃描 QR 重新連線", false)
        case let .online(info)?:
            if info.openProjectId == nil { return ("電腦沒開專案 · 用手機上存的", false) }
            if info.projectId != r.project.projectId { return ("電腦開著〈\(info.projectTitle)〉· 打開會用手機上存的", false) }
            // 電腦上的進度和手機不同：先告訴使用者（打開時會自動對齊或問）
            if let pr = info.progress, pr.projectId == nil || pr.projectId == r.project.projectId {
                let pos = pr.step.flatMap { s in r.project.steps.firstIndex { $0.index == s } }
                if Set(pr.done) != Set(r.done) || (pos != nil && pos != r.stepPosition) {
                    let at = pos.map { "第 \($0 + 1) 步" } ?? "完成 \(pr.done.count) 步"
                    return ("電腦在線 · 會同步 · 電腦上在\(at)", true)
                }
            }
            return ("電腦在線 · 會同步", true)
        }
    }

    /// 來源電腦：電腦名稱優先（/info.host、Bonjour），沒有才顯示 IP
    private func sourceName(_ r: RecentProject) -> String? {
        if case let .online(info)? = reach[r.id], let h = info.host { return h }
        if let h = r.endpoint?.host, let n = studioNames[h] { return n }
        // 舊紀錄存的是「IP:埠」：改成「電腦（IP）」
        if let ep = r.endpoint, r.source == ep.display { return "電腦（\(ep.host)）" }
        return r.source
    }

    /// 打開最近的專案：電腦在線而且開著「同一個專案」→ 連線同步；
    /// 其他情況用手機上存的（離線），並在指引裡說明原因。
    private func open(_ r: RecentProject, mode: GuideMode) {
        guard opening == nil else { return }
        manualTried = false
        studioTried = nil
        guard let ep = r.endpoint else {
            // 沒記住電腦：Wi-Fi 上有開著這個專案的 Studio 就連它
            opening = r.id
            Task {
                defer { opening = nil }
                if let found = await studioWithProject(r.project.projectId), await session.connect(found) {
                    recents = RecentProjects.load()
                    guide = GuideLaunch(mode: mode)
                } else {
                    openOffline(r, mode: mode)
                }
            }
            return
        }
        opening = r.id
        Task {
            defer { opening = nil }
            let st = await LanClient.probe(ep)
            reach[r.id] = st
            switch st {
            case .offline:
                openOffline(r, mode: mode)   // 列表上已經寫「電腦離線」
            case .badToken:
                // 電腦重開換了連線碼：同一個 Wi-Fi 上找到開著這個專案的 Studio，就用新的連線碼直接連
                if let ep = await studioWithProject(r.project.projectId), await session.connect(ep) {
                    recents = RecentProjects.load()
                    guide = GuideLaunch(mode: mode)
                    return
                }
                openOffline(r, mode: mode, tokenGone: true)   // 指引裡直接顯示「掃描 QR／手動輸入」
            case let .online(info):
                if info.openProjectId == nil {
                    openOffline(r, mode: mode, notice: "電腦的 Studio 還沒打開專案，先用手機上存的這份。"); return
                }
                if info.projectId != r.project.projectId {
                    let title = info.projectTitle
                    openOffline(r, mode: mode, other: .init(title: title, endpoint: ep, message: LinkSession.otherProjectMessage(title)))
                    return
                }
                if await session.connect(withName(ep)) {
                    recents = RecentProjects.load()
                    guide = GuideLaunch(mode: mode)
                } else {
                    let why: String
                    if case let .failed(m) = session.phase { why = m } else { why = "連線失敗" }
                    openOffline(r, mode: mode, notice: "連不上電腦（\(why)），先用手機上存的這份。")
                }
            }
        }
    }

    private func openOffline(_ r: RecentProject, mode: GuideMode, notice: String? = nil, other: LinkSession.OtherProject? = nil, tokenGone: Bool = false) {
        session.openSaved(RecentProjects.find(id: r.id) ?? r, notice: notice, other: other, tokenGone: tokenGone)
        guide = GuideLaunch(mode: mode)
    }

    private func delete(_ r: RecentProject) {
        RecentProjects.remove(id: r.id)
        recents = RecentProjects.load()
        // 「上次連線」是同一台電腦：一起拿掉（不然刪掉的專案會換個樣子出現在「上次連線」），復原時放回來
        if let l = LanEndpoint.last, let ep = r.endpoint, l.display == ep.display {
            deletedLast = l
            LanEndpoint.last = nil
            last = nil
        } else { deletedLast = nil }
        withAnimation { lastDeleted = r }
        Task {
            try? await Task.sleep(for: .seconds(10))
            if lastDeleted?.id == r.id { withAnimation { lastDeleted = nil } }
        }
    }

    /// 「已刪除〈X〉· 復原」
    private func undoBar(_ r: RecentProject) -> some View {
        HStack(spacing: 12) {
            Text("已刪除〈\(r.displayTitle)〉").font(.subheadline).lineLimit(1)
            Spacer(minLength: 0)
            Button("復原") {
                RecentProjects.restore(r)
                recents = RecentProjects.load()
                if let l = deletedLast { LanEndpoint.last = l; last = l; deletedLast = nil }
                withAnimation { lastDeleted = nil }
            }
            .font(.subheadline.weight(.semibold)).buttonStyle(.borderless)
        }
        .transition(.opacity)
    }

    /// 重新開始：清手機；電腦在線而且開著同一個專案就一起清
    private func reset(_ r: RecentProject) {
        RecentProjects.resetProgress(id: r.id)
        recents = RecentProjects.load()
        guard let ep = r.endpoint, let first = r.project.steps.first else { return }
        Task {
            let client = LanClient(endpoint: ep)
            guard let info = try? await client.info(), info.projectId == r.project.projectId else { return }
            let body = LanProgress(projectId: r.project.projectId, step: first.index, done: [], from: LinkSession.myFrom, seq: nil)
            if (try? await client.post(progress: body)) != nil {
                RecentProjects.clearResetPending(id: r.id)
                recents = RecentProjects.load()
            }
        }
    }

    /// QR／手動連線沒有電腦名稱：用 Bonjour 找到的名稱補上
    private func withName(_ ep: LanEndpoint) -> LanEndpoint {
        var e = ep
        if e.title == nil { e.title = studioNames[ep.host] }
        return e
    }

    private func connect(_ ep: LanEndpoint, keepStudio: Bool = false) {
        if !keepStudio { studioTried = nil; studioError = nil }
        lastTried = ep
        Task {
            await session.connect(withName(ep))
            if session.phase == .connected {
                recents = RecentProjects.load()
                guide = GuideLaunch(mode: ProcessInfo.processInfo.environment["GUIDE_DEMO"] == "simconnect" ? .sim2D : defaultMode)
            }
        }
    }

    private func connect(_ s: BonjourBrowser.Studio) {
        manualTried = false
        studioTried = s.name
        studioError = nil
        resolving = s.name
        Task {
            defer { resolving = nil }
            do {
                let ep = try await BonjourBrowser.resolve(s)
                connect(ep, keepStudio: true)
            } catch let e as LinkError {
                studioError = e.message
            } catch {
                studioError = error.localizedDescription
            }
        }
    }

    /// Wi-Fi 上開著這個專案的 Studio 名稱
    private func studioOpen(_ pid: String?) -> String? {
        guard let pid else { return nil }
        return browser.studios.first { if case let .open(_, p)? = studioProjects[$0.name] { return p == pid } else { return false } }
            .map { $0.title ?? $0.name }
    }

    /// Studio 清單：開著的專案名稱；手機上改過名就兩個都寫
    private func openTitle(_ title: String, _ pid: String?) -> String {
        if let pid, let r = recents.first(where: { $0.project.projectId == pid }), let mine = r.customTitle, mine != title {
            return "開著〈\(title)〉（你手機上叫〈\(mine)〉）"
        }
        return "開著〈\(title)〉"
    }
}

#Preview {
    ConnectView()
}
