import Foundation
import Observation

/// 一次連線：先抓 /info＋/project，之後每 2 秒輪詢 /info：
/// - revision 變了 → 重抓專案
/// - progress.seq 變了且不是手機自己送的 → 套用桌面的進度（v1.1）
/// - projectId 變了 → 不自動換，等使用者選「切換／留在目前專案」
/// 組裝進度（目前第幾步、哪些做完）也放在這裡，手機每次改變就 POST /progress。
@MainActor
@Observable
final class LinkSession {
    enum Phase: Equatable {
        case idle
        case connecting(String)
        case connected
        case failed(String)
    }

    enum SyncState: Equatable {
        case synced(Date)
        case failed
    }

    private(set) var phase: Phase = .idle
    private(set) var project: LanProject?
    private(set) var endpoint: LanEndpoint?
    private(set) var isDemo = false
    /// 從手機存檔打開（沒有連電腦）：進度只存在手機
    private(set) var isOffline = false
    /// 已連線後輪詢失敗（電腦睡著、Wi-Fi 斷）：保留舊專案，只顯示提示
    private(set) var pollWarning: String?
    /// 專案剛被桌面更新（給畫面閃一下提示）
    private(set) var updatedAt: Date?

    // MARK: 進度
    /// 目前在 `project.steps` 的第幾個（陣列位置）
    private(set) var stepPosition = 0
    /// 做完的 `Step.index`
    private(set) var done: Set<Int> = []
    private(set) var syncState: SyncState?
    /// 手機上改過的專案名稱（最近的專案裡的 customTitle）
    private(set) var customTitle: String?
    var displayTitle: String? { customTitle ?? project?.title }

    /// 連線時手機和電腦各有一份不同的進度：等使用者選要用哪一份（nil＝沒有衝突）
    struct ProgressConflict: Equatable {
        var phoneDone: [Int]
        var phoneStep: Int
        var desktopDone: [Int]
        var desktopStep: Int
        /// 手機這份最後改的時間、是不是剛「重新開始」
        var phoneUpdatedAt: Date?
        var phoneReset = false
        /// 電腦那份最後是誰送的（"phone"＝之前由手機同步過去）
        var desktopFrom: String?
    }
    private(set) var progressConflict: ProgressConflict?
    /// 連線時自動對齊進度（用電腦的／推手機的）的提示
    private(set) var autoSyncNotice: String?
    private(set) var autoSyncAt: Date?
    /// 電腦送來的進度剛套用（給畫面提示「電腦把進度移到第 N 步」）
    private(set) var progressAppliedAt: Date?
    /// 剛套用的進度是誰送的（電腦／另一台手機）
    private(set) var progressAppliedFrom: String?

    /// 這台手機的代號（第一次用時產生、存起來）：送進度時 from＝"phone:<代號>"，
    /// 輪詢時只略過自己送的，另一台手機的進度照樣套用
    static let deviceId: String = {
        let key = "device.id"
        if let v = UserDefaults.standard.string(forKey: key) { return v }
        let v = String(UUID().uuidString.prefix(8)).lowercased()
        UserDefaults.standard.set(v, forKey: key)
        return v
    }()
    static var myFrom: String { "phone:" + deviceId }
    /// from 是不是某台手機（自己或別台）
    static func isPhone(_ from: String?) -> Bool { from?.hasPrefix("phone") ?? false }

    /// 首頁連線失敗的提示：關掉
    func clearFailure() { if case .failed = phase { phase = .idle } }
    /// 有進度還沒送到電腦（送失敗）：下次輪詢成功時自動重送
    private(set) var pendingProgress = false
    /// 電腦重開過（token 換了）：要重新連線
    private(set) var needsReconnect = false
    /// 在指引畫面內連上電腦的時間（給畫面提示）
    private(set) var reconnectedAt: Date?
    /// 正在重新連線（指引畫面內，不離開）
    private(set) var reconnecting = false
    /// 連線碼（token）換了、自動找不到：要掃 QR 或手動輸入（畫面把這兩個當主要按鈕）
    private(set) var needsNewToken = false
    /// 重新連線失敗的原因（給指引畫面顯示）
    private(set) var reconnectError: String?
    /// 離線打開的存檔記得的電腦（可「連線同步」）
    private(set) var savedEndpoint: LanEndpoint?
    var canReconnect: Bool { (endpoint ?? savedEndpoint) != nil }
    // MARK: 麵包板大小（真板子比專案小時把走線搬上去）

    /// 使用者選的麵包板大小（欄數：63／30／17）；nil＝自動（AR 用偵測結果，其他用專案的大小）
    var boardOverride: Int?
    /// AR 偵測到的欄數（最近幾次的眾數）
    private(set) var detectedCols: Int?
    func setDetectedCols(_ c: Int?) { if detectedCols != c { detectedCols = c } }
    /// 目前用來比對的真板子欄數
    var realBoardCols: Int? { boardOverride ?? detectedCols }

    @ObservationIgnored private var fitCache: (key: String, value: (project: LanProject, fit: BoardFit))?
    private func fitted() -> (project: LanProject, fit: BoardFit)? {
        guard let p = project, let real = realBoardCols else { return nil }
        let key = "\(p.projectId ?? p.title)|\(p.revision)|\(p.steps.count)|\(p.holes?.count ?? 0)|\(p.title)|\(real)"
        if let c = fitCache, c.key == key { return c.value }
        let v = p.fitted(toRealCols: real)
        fitCache = (key, v)
        return v
    }
    /// 真板子和專案的對應（nil＝不知道真板子大小，照專案畫）
    var boardFit: BoardFit? { fitted()?.fit }
    /// 畫面上用的專案：真板子比較小而且放得下時是「搬過去」的那一份（孔名、座標都是真板子的）
    var viewProject: LanProject? { fitted()?.project ?? project }

    /// 連著的電腦名稱（/info.host；舊版桌面沒有就用 Bonjour 名稱或 IP）
    private(set) var hostName: String?

    /// 電腦開著「別的」專案：不換掉手機上這份，讓使用者選「切換到電腦的專案／留在這份」
    struct OtherProject: Equatable {
        var title: String
        var endpoint: LanEndpoint
        var message: String
    }
    private(set) var otherProject: OtherProject?
    /// 離線打開的原因（電腦沒開專案、連不上…）：給指引畫面一行說明
    private(set) var offlineNotice: String?

    func dismissOtherProject() { otherProject = nil }
    func dismissOfflineNotice() { offlineNotice = nil }

    /// 使用者選「切換到電腦的專案」
    func switchToComputerProject() async {
        guard let o = otherProject else { return }
        otherProject = nil
        reconnecting = true
        defer { reconnecting = false }
        await connect(o.endpoint, inPlace: true, allowOtherProject: true)
    }

    /// 開著的專案和電腦上的不同時的說明
    static func otherProjectMessage(_ title: String) -> String {
        "電腦開著〈\(title)〉。請在電腦打開這個專案，或切換到電腦的專案。"
    }

    // MARK: 換專案保護
    /// 電腦換了專案、等使用者決定（nil＝沒有）
    private(set) var pendingSwitch: LanInfo?
    /// 使用者選「留在目前專案」：不再送進度，也不再為同一個新專案跳提示
    private(set) var detached = false
    private var dismissedProjectId: String?

    private var pollTask: Task<Void, Never>?
    private var offlineWatch: Task<Void, Never>?
    private var tokenWatch: Task<Void, Never>?
    private var lastConnectError: LinkError?
    private var client: LanClient?
    /// 上次看到的 /info revision。桌面的 /info revision 是伺服器計數器，和 /project 內的 revision（IR 版本）
    /// 不一定相同，所以只拿 /info 和 /info 比。
    private var infoRevision: Int?
    private var progressSeq: Int?

    /// 連線。inPlace＝在指引畫面裡（離線存檔／token 換了）直接接上：失敗時保留目前畫面，只記下原因。
    @discardableResult
    func connect(_ ep: LanEndpoint, inPlace: Bool = false, allowOtherProject: Bool = false) async -> Bool {
        if inPlace {
            reconnectError = nil
            otherProject = nil
        } else {
            disconnect()
            phase = .connecting(ep.display)
        }
        let client = LanClient(endpoint: ep)
        do {
            let info = try await client.info()
            guard info.v == 1 else { throw LinkError.badData("協定版本 v\(info.v)") }
            let p = try await client.project()
            // 指引畫面內連線：電腦開著別的專案就不換掉手機上這份，先問
            if inPlace, !allowOtherProject, let mine = project, (mine.projectId ?? mine.title) != (p.projectId ?? p.title) {
                let title = info.title.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? p.title
                otherProject = OtherProject(title: title, endpoint: ep, message: Self.otherProjectMessage(title))
                return false
            }
            if inPlace {
                offlineNotice = nil
                needsNewToken = false
                pollTask?.cancel(); pollTask = nil
                pendingSwitch = nil; detached = false; dismissedProjectId = nil
                syncState = nil; progressConflict = nil; deferredConflict = nil; pendingProgress = false
                needsReconnect = false; pollWarning = nil
                isOffline = false; isDemo = false; savedEndpoint = nil
            }
            infoRevision = info.revision
            var last = ep
            last.title = info.host ?? ep.title   // 「上次連線」顯示電腦名稱（不是專案名，刪掉專案後不會冒出來）
            LanEndpoint.last = last
            endpoint = ep                 // title＝電腦名稱（Bonjour）或 nil（QR／手動）
            self.client = client
            isDemo = false
            progressSeq = info.progress?.seq
            hostName = info.host ?? ep.title
            reconcile(p, desktop: info.progress, source: info.host ?? ep.title)
            phase = .connected
            Self.everConnected = true
            startPolling(client)
            if inPlace { reconnectedAt = Date() }
            return true
        } catch let e as LinkError {
            lastConnectError = e
            if inPlace { reconnectError = e == .badToken ? "電腦重開過，舊的連線碼失效了" : e.message }
            else { phase = .failed(e.message) }
        } catch is CancellationError {
            if !inPlace { phase = .idle }
        } catch {
            if inPlace { reconnectError = error.localizedDescription } else { phase = .failed(error.localizedDescription) }
        }
        return false
    }

    /// 在指引畫面裡重新連線：先試原本的位址；不行（電腦重開換了 token、IP 變了）
    /// 就用 Bonjour 找同一個 Wi-Fi 上開著「這個專案」的 Studio。進度由 reconcile 合併（不同時會問）。
    func reconnect() async {
        guard !reconnecting, let old = endpoint ?? savedEndpoint else { return }
        reconnecting = true
        offlineNotice = nil     // 開始重新連線：舊的說明不再適用，讓連線結果（錯誤）顯示出來
        defer { reconnecting = false }
        lastConnectError = nil
        needsNewToken = false
        if await connect(old, inPlace: true) { return }
        let firstLinkError = lastConnectError
        if otherProject != nil { return }
        // 原本那台電腦有回應（只是沒開專案、資料不對…）：直接說原因，不用再找別台
        if let e = lastConnectError, e == .noProject {
            reconnectError = "電腦的 Studio 還沒打開這個專案：請在電腦打開它，再按「重新連線」"
            return
        }   // 原本那台電腦開著別的專案：已經在問使用者了
        let firstError = reconnectError
        let mine = project?.projectId
        let browser = BonjourBrowser()
        browser.start()
        defer { browser.stop() }
        for _ in 0..<10 where browser.studios.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
        try? await Task.sleep(for: .milliseconds(300))
        var other: OtherProject?
        for s in browser.studios {
            guard let ep = try? await BonjourBrowser.resolve(s),
                  let info = try? await LanClient(endpoint: ep).info() else { continue }
            if mine == nil || info.projectId == mine {
                if await connect(ep, inPlace: true) { return }
            } else if info.openProjectId != nil, other == nil {   // 沒開專案的電腦不算「開著別的專案」
                let title = info.projectTitle
                other = OtherProject(title: title, endpoint: ep, message: Self.otherProjectMessage(title))
            }
        }
        if let other { otherProject = other; reconnectError = nil; return }
        // 原本那台電腦回「token 錯誤」、又找不到：真正原因是電腦重開換了連線碼
        if firstLinkError == .badToken {
            needsNewToken = true
            reconnectError = "電腦重開過，連線碼換了：請掃描電腦上的 QR code，或按「手動輸入」填新的 token"
            return
        }
        reconnectError = browser.studios.isEmpty ? "同一個 Wi-Fi 上找不到 Studio：確認電腦開著 Studio，或掃描 QR code"
            : (firstError ?? "連不上電腦，請掃描 QR code")
    }

    /// 電腦重開（token 換了）之後：每 6 秒在 Wi-Fi 上找開著同一個專案的 Studio，找到就用新的連線碼自動接上
    private func startTokenWatch() {
        guard tokenWatch == nil else { return }
        tokenWatch = Task { [weak self] in
            defer { Task { @MainActor [weak self] in self?.tokenWatch = nil } }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                guard !Task.isCancelled, let self, self.needsReconnect, !self.reconnecting,
                      let mine = self.project?.projectId else { return }
                if let ep = await Self.findStudio(projectId: mine) {
                    self.reconnecting = true
                    let ok = await self.connect(ep, inPlace: true)
                    self.reconnecting = false
                    if ok { return }
                }
            }
        }
    }

    /// 同一個 Wi-Fi 上開著這個專案的 Studio（用它現在的連線碼）
    static func findStudio(projectId: String) async -> LanEndpoint? {
        let browser = BonjourBrowser()
        browser.start()
        defer { browser.stop() }
        for _ in 0..<10 where browser.studios.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
        for s in browser.studios {
            guard let ep = try? await BonjourBrowser.resolve(s),
                  let info = try? await LanClient(endpoint: ep).info(), info.projectId == projectId else { continue }
            return ep
        }
        return nil
    }

    /// 內建範例專案（不需要桌面）
    func loadDemo() {
        disconnect()
        guard let url = Bundle.main.url(forResource: "sample_project", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              var p = try? JSONDecoder().decode(LanProject.self, from: data) else {
            phase = .failed("找不到範例專案")
            return
        }
        // 測試用：GUIDE_DEMO_EXTERNAL=1 加一個外接元件（LD06，ZH1.5 排線，不插麵包板）＋一條接它的線
        // 和桌面 share.ts 同格式：offBoard、modelParts、腳位端點 posMm（cableEnd 算法）、導線 pathMm（佈線折線）
        if ProcessInfo.processInfo.environment["GUIDE_DEMO_EXTERNAL"] != nil, let a1 = p.holes?["A1"], let j5 = p.holes?["J5"],
           let jz = p.holes?["J1"]?[safe: 1] {
            let pinIds = ["TX", "PWM", "GND", "P5V"]
            let pins = pinIds.map { LanProject.Pin(pin: $0, label: nil, hole: nil) }
            // 麵包板左邊（−x），本體往 −x 延伸（rotationDeg −90：元件 +z → 世界 −x）、接頭朝向麵包板
            let px = a1[0] - 14, pz = (a1[1] + jz) / 2, rot = -90.0
            let shapes: [LanProject.ModelPart] = [
                .init(shape: "rounded_box", size: [38, 12, 38], position: [0, 0, 0], rotation_deg: nil, color: "#2b2d31", material: "plastic"),
                .init(shape: "cylinder", size: [30, 14], position: [0, 12, 0], rotation_deg: nil, color: "#1f2937", material: "plastic"),
                .init(shape: "dome", size: [22, 6], position: [0, 26, 0], rotation_deg: nil, color: "#0b0f19", material: "glass"),
            ]
            p.parts.append(LanProject.Part(id: "ld1", tag: "LD1", name: "LD06 光達", pins: pins, profileId: "user_ld06", model: nil,
                                           poseMm: .init(position: [px, 0, pz], rotationDeg: rot),
                                           bboxMm: [38, 34, 38], color: "#2b2d31", parameters: nil, offBoard: true, modelParts: shapes))
            // cableEnd：腳位 x 0、1.5、3、4.5（中心 2.25），杜邦頭沿 x 每 2.54 mm、從插座往 −z 拉出 6 mm
            let r = rot * .pi / 180, i = 0.0
            let lx = 2.25 + (i - 1.5) * 2.54, lz = -6.0
            let ex = px + lx * cos(r) + lz * sin(r), ez = pz - lx * sin(r) + lz * cos(r), ey = 2.0
            let s = p.breadboard?.sizeMm?[safe: 1] ?? 8.5
            let path: [[Double]] = [[j5[0], s, j5[1]], [j5[0], s + 6, j5[1]], [j5[0], s + 6, ez], [ex + 4, s + 6, ez], [ex + 4, ey + 3, ez], [ex, ey, ez]]
            p.wires.append(LanProject.Wire(id: "w_ld_tx", color: "#eab308", role: "signal", net: nil, from: .init(hole: "J5", pin: nil, label: nil),
                                           to: .init(hole: nil, pin: "ld1.TX", label: "LD1 Tx", posMm: [ex, ey, ez]), pathMm: path))
            let place = LanProject.Step(index: 900, kind: "place", targetId: "ld1", tag: "LD1", title: "擺好 LD06（外接）",
                                        detail: "放在麵包板左邊，用 ZH1.5 排線接出杜邦頭", holes: [])
            let wire = LanProject.Step(index: 901, kind: "wire", targetId: "w_ld_tx", tag: "線 LD", title: "接 LD06 的 Tx",
                                       detail: nil, holes: ["J5"])
            p.steps.insert(contentsOf: [place, wire], at: 1)
        }
        // 測試用：GUIDE_DEMO_TRIM=30 只留下落在 30 欄範圍內的步驟（試「搬到 400 孔板」）
        if let t = ProcessInfo.processInfo.environment["GUIDE_DEMO_TRIM"].flatMap(Int.init), let lo = p.usedColumns()?.min {
            func inside(_ id: String) -> Bool {
                switch HoleID(id) {
                case let .main(_, c)?: return c + 1 >= lo && c + 1 < lo + t
                case let .rail(_, _, n)?: return HoleID.railColumn(n: n, columns: p.columns).map { $0 >= Double(lo) && $0 < Double(lo + t) } ?? false
                case nil: return true
                }
            }
            p.parts = p.parts.filter { $0.pins.allSatisfy { $0.hole.map(inside) ?? true } }
            p.wires = p.wires.filter { [$0.from, $0.to].allSatisfy { $0.hole.map(inside) ?? true } }
            let keep = Set(p.parts.map(\.id) + p.wires.map(\.id))
            p.steps = p.steps.filter { keep.contains($0.targetId) && $0.holes.allSatisfy(inside) }
        }
        // 測試用：GUIDE_NOMODEL=<元件 id> 把該元件當成「從規格書新增、沒有模型」（v1.3）
        if let id = ProcessInfo.processInfo.environment["GUIDE_NOMODEL"], let i = p.parts.firstIndex(where: { $0.id == id }) {
            p.parts[i].model = nil
            if p.parts[i].bboxMm == nil { p.parts[i].bboxMm = [8, 6, 5] }
            if p.parts[i].color == nil { p.parts[i].color = "#7c3aed" }
        }
        project = p
        isDemo = true
        phase = .connected
    }

    /// 接上電腦時合併兩邊的進度：
    /// - 電腦沒有進度 → 用手機存的，並推給電腦
    /// - 手機沒有進度 → 用電腦的
    /// - 兩邊都有且不同 → 先顯示電腦的，等使用者選（progressConflict）
    private func reconcile(_ p: LanProject, desktop: LanProgress?, source: String?) {
        project = p
        stepPosition = 0
        done = []
        let id = p.projectId ?? p.title
        let phone = RecentProjects.find(id: id)
        customTitle = phone?.customTitle
        let desk = desktop.flatMap { $0.projectId == nil || $0.projectId == p.projectId ? $0 : nil }
        // 電腦的進度：step 為 nil（電腦重開、還沒進組裝步驟）時只比較「做完哪些步」
        let deskDone = Set(desk?.done ?? [])
        let deskStep: Int? = desk?.step.flatMap { s in p.steps.firstIndex { $0.index == s } }
        let deskHas = !deskDone.isEmpty || (deskStep ?? 0) > 0
        func deskSame(done d: Set<Int>, step st: Int) -> Bool { deskDone == d && (deskStep == nil || deskStep == st) }
        // 手機上按過「重新開始」還沒同步：手機這份（第 1 步、0 步完成）也算一份進度
        let phoneHas = (phone?.hasProgress ?? false) || (phone?.resetPending ?? false)
        let phoneDone = Set(phone?.done ?? [])
        let phoneStep = min(max(phone?.stepPosition ?? 0, 0), max(p.steps.count - 1, 0))

        // 和上次對齊時比，哪一邊真的改過（只看內容；電腦重開後 seq 會從頭算，不拿 seq 判斷）
        let synced = phone?.lastSynced
        let phoneChanged = phoneHas && (synced.map { !$0.same(done: phoneDone, step: phoneStep) } ?? true)
        let deskChanged = deskHas && (synced.map { !deskSame(done: Set($0.done), step: $0.step) } ?? true)
        let differs = phone != nil && !deskSame(done: phoneDone, step: phoneStep)

        func usePhone(notice: Bool) {
            done = phoneDone
            stepPosition = phoneStep
            RecentProjects.save(p, source: source, endpoint: endpoint, done: done.sorted(), stepPosition: stepPosition)
            sendProgress()          // 送成功時會記下 lastSynced
            RecentProjects.clearResetPending(id: id)
            if notice { autoSync("已把手機的進度同步到電腦") }
        }

        // 電腦沒有這個專案的進度（剛重開、從沒做過）：保留手機的並推過去
        if phoneHas, !deskHas { usePhone(notice: true); return }
        // 只有手機改過：手機這份推給電腦
        if phoneHas, phoneChanged, !deskChanged, differs { usePhone(notice: true); return }
        // 兩邊都改過而且不同：問使用者
        if let phone, phoneChanged, deskChanged, differs {
            if let desk { apply(desk, persist: false) }
            progressConflict = ProgressConflict(phoneDone: phone.done.sorted(), phoneStep: phoneStep,
                                                desktopDone: done.sorted(), desktopStep: stepPosition,
                                                phoneUpdatedAt: phone.progressAt, phoneReset: phone.resetPending ?? false,
                                                desktopFrom: desk?.from)
            RecentProjects.save(p, source: source, endpoint: endpoint)   // 先不動手機存檔，等使用者選
            // 選之前畫面維持手機這一份（不先套用電腦的）
            done = phoneDone
            stepPosition = phoneStep
            return
        }
        if phone != nil, !differs {
            // 兩邊一樣（電腦沒給 step 時只比 done）：照手機的位置，不跳步
            done = phoneDone
            stepPosition = phoneStep
        } else if let desk {
            // 只有電腦改過：直接用電腦的
            apply(desk, persist: false)
            if phone != nil { autoSync("已接上電腦的進度：第 \(stepPosition + 1) 步") }
        }
        RecentProjects.save(p, source: source, endpoint: endpoint, done: done.sorted(), stepPosition: stepPosition)
        RecentProjects.clearResetPending(id: id)
        RecentProjects.setSynced(id: id, SyncPoint(done: done.sorted(), step: stepPosition, seq: desk?.seq))
    }

    /// 自動對齊進度時給畫面的短提示
    private func autoSync(_ text: String) {
        autoSyncNotice = text
        autoSyncAt = Date()
    }

    /// 使用者選了要用哪一份進度
    enum ConflictChoice { case phone, desktop, merge }

    func resolveConflict(usePhone: Bool) { resolveConflict(usePhone ? .phone : .desktop) }

    func resolveConflict(_ choice: ConflictChoice) {
        guard let c = progressConflict else { return }
        progressConflict = nil
        deferredConflict = nil
        if let p = project { RecentProjects.clearResetPending(id: p.projectId ?? p.title) }
        if choice == .merge {
            // 合併：兩邊勾過的都算完成，停在第一個還沒完成的步驟
            done = Set(c.phoneDone).union(c.desktopDone)
            let steps = project?.steps ?? []
            stepPosition = steps.firstIndex { !done.contains($0.index) } ?? max(c.phoneStep, c.desktopStep)
            sendProgress()
        } else if choice == .phone {
            done = Set(c.phoneDone); stepPosition = c.phoneStep
            sendProgress()   // 推給電腦＋存手機（成功時記 lastSynced）
        } else {
            done = Set(c.desktopDone); stepPosition = c.desktopStep
            persistProgress()
            markSynced(seq: progressSeq)
        }
    }

    /// 衝突「稍後再決定」：先照手機的做、不和電腦同步，之後可以從提示框再叫出來
    private(set) var deferredConflict: ProgressConflict?
    var syncDeferred: Bool { deferredConflict != nil }

    func deferConflict() {
        guard let c = progressConflict else { return }
        deferredConflict = c
        progressConflict = nil
    }

    func reopenConflict() {
        guard var c = deferredConflict else { return }
        c.phoneDone = done.sorted(); c.phoneStep = stepPosition   // 手機這段時間做的也算進去
        deferredConflict = nil
        progressConflict = c
    }

    /// 這台手機有沒有連上過電腦（首頁標題「第一次使用」／「連線電腦」）
    static var everConnected: Bool {
        get { UserDefaults.standard.bool(forKey: "link.everConnected") }
        set { UserDefaults.standard.set(newValue, forKey: "link.everConnected") }
    }

    /// 從手機存檔打開（離線）
    /// notice：為什麼用手機上存的（給指引畫面顯示）；other：電腦開著別的專案
    /// tokenGone：電腦重開換了連線碼、Wi-Fi 上也找不到 → 直接顯示「掃描 QR／手動輸入」
    func openSaved(_ r: RecentProject, notice: String? = nil, other: OtherProject? = nil, tokenGone: Bool = false) {
        disconnect()
        offlineNotice = notice
        otherProject = other
        if tokenGone {
            needsNewToken = true
            needsReconnect = true
            reconnectError = "電腦重開過，連線碼換了：請掃描電腦上的 QR code，或按「手動輸入」填新的 token"
            startTokenWatch()   // Studio 重開後在 Wi-Fi 上出現就自動接上
        }
        project = r.project
        customTitle = r.customTitle
        savedEndpoint = r.endpoint
        done = Set(r.done)
        stepPosition = min(max(r.stepPosition, 0), max(r.project.steps.count - 1, 0))
        isOffline = true
        phase = .connected
        RecentProjects.updateProgress(id: r.id, done: r.done, stepPosition: stepPosition)
        if r.endpoint != nil { startOfflineWatch() }
    }

    /// 離線打開時每 5 秒看一下電腦：電腦打開了這個專案就自動連上（進度不同時照常會問）
    private func startOfflineWatch() {
        offlineWatch?.cancel()
        offlineWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self, self.isOffline, !self.reconnecting,
                      let ep = self.savedEndpoint, let mine = self.project?.projectId else { return }
                if case let .online(info) = await LanClient.probe(ep), info.projectId == mine {
                    self.reconnecting = true
                    let ok = await self.connect(ep, inPlace: true)
                    self.reconnecting = false
                    if ok { return }
                }
            }
        }
    }

    func disconnect() {
        offlineWatch?.cancel()
        offlineWatch = nil
        tokenWatch?.cancel()
        tokenWatch = nil
        boardOverride = nil
        detectedCols = nil
        pollTask?.cancel()
        pollTask = nil
        client = nil
        project = nil
        pollWarning = nil
        infoRevision = nil
        progressSeq = nil
        pendingSwitch = nil
        detached = false
        dismissedProjectId = nil
        syncState = nil
        progressConflict = nil
        deferredConflict = nil
        progressAppliedAt = nil
        customTitle = nil
        pendingProgress = false
        needsReconnect = false
        reconnectError = nil
        savedEndpoint = nil
        otherProject = nil
        offlineNotice = nil
        hostName = nil
        needsNewToken = false
        stepPosition = 0
        done = []
        isDemo = false
        isOffline = false
        phase = .idle
    }

    // MARK: - 步驟操作（每次都送 /progress）

    /// 移到某一步。只有 markDone 會改「做完」的清單；往回走不會把步驟改回未完成。
    func goTo(position: Int, markDone: Bool = false) {
        guard let steps = project?.steps, !steps.isEmpty else { return }
        let old = stepPosition
        let target = min(max(position, 0), steps.count - 1)
        if markDone, steps.indices.contains(old) { done.insert(steps[old].index) }
        stepPosition = target
        sendProgress()
    }

    /// 步驟清單裡勾／取消「做完」
    func toggleDone(stepIndex: Int) {
        if done.contains(stepIndex) { done.remove(stepIndex) } else { done.insert(stepIndex) }
        sendProgress()
    }

    /// 重新開始：清掉進度、回到第 1 步
    func resetProgress() {
        done = []
        stepPosition = 0
        sendProgress()
    }

    /// 測試用：全部標成做完、停在最後一步
    func markAllDone() {
        guard let steps = project?.steps, !steps.isEmpty else { return }
        done = Set(steps.map(\.index))
        stepPosition = steps.count - 1
        sendProgress()
    }

    func completeCurrent() { goTo(position: stepPosition + 1, markDone: true) }
    func completeLast() {
        guard let steps = project?.steps, steps.indices.contains(stepPosition) else { return }
        done.insert(steps[stepPosition].index)
        sendProgress()
    }

    /// 現在的進度就是和電腦對齊的那份
    private func markSynced(seq: Int?) {
        guard !isDemo, let p = project else { return }
        RecentProjects.setSynced(id: p.projectId ?? p.title, SyncPoint(done: done.sorted(), step: stepPosition, seq: seq))
    }

    /// 進度存到手機（最近的專案）
    private func persistProgress() {
        guard !isDemo, progressConflict == nil, let p = project else { return }
        RecentProjects.updateProgress(id: p.projectId ?? p.title, done: done.sorted(), stepPosition: stepPosition)
    }

    func clearReconnectError() { reconnectError = nil }

    /// 「未同步 · 重試」
    func retrySync() { sendProgress() }

    private func sendProgress() {
        persistProgress()
        guard !isDemo, !isOffline, !detached, progressConflict == nil, !syncDeferred, let client, let p = project, p.steps.indices.contains(stepPosition) else { return }
        let body = LanProgress(projectId: p.projectId, step: p.steps[stepPosition].index,
                               done: done.sorted(), from: Self.myFrom, seq: nil)
        Task {
            do {
                let reply = try await client.post(progress: body)
                if let s = reply.seq { progressSeq = s }
                pendingProgress = false
                if let id = p.projectId ?? Optional(p.title) {
                    RecentProjects.setSynced(id: id, SyncPoint(done: body.done, step: p.steps.firstIndex { $0.index == body.step } ?? 0, seq: reply.seq))
                }
                syncState = .synced(Date())
            } catch LinkError.projectChanged {
                // 電腦換了專案：不算「未同步」，改問要不要切換
                pendingProgress = false
                syncState = nil
                if let info = try? await client.info(), let id = info.projectId, id != project?.projectId,
                   id != dismissedProjectId { pendingSwitch = info }
            } catch LinkError.badToken {
                pendingProgress = true
                needsReconnect = true
                syncState = .failed
            } catch {
                pendingProgress = true
                syncState = .failed
            }
        }
    }

    /// 套用桌面（或上次）的進度
    private func apply(_ pr: LanProgress, persist: Bool = true) {
        guard let steps = project?.steps, !steps.isEmpty else { return }
        if let s = pr.step {
            stepPosition = steps.firstIndex { $0.index == s } ?? min(max(s, 0), steps.count - 1)
        } else if let next = steps.firstIndex(where: { !pr.done.contains($0.index) }) {
            stepPosition = next   // 沒有指定步驟：跳到第一個還沒完成的
        }
        done = Set(pr.done)
        if persist { persistProgress() }
    }

    // MARK: - 換專案

    /// 使用者選「切換」：抓新專案，進度從桌面的 progress 接續
    func acceptSwitch() async {
        guard let client else { return }
        pendingSwitch = nil
        do {
            let info = try await client.info()
            let p = try await client.project()
            infoRevision = info.revision
            detached = false
            dismissedProjectId = nil
            progressConflict = nil
            progressSeq = info.progress?.seq
            reconcile(p, desktop: info.progress?.projectId == p.projectId ? info.progress : nil,
                      source: endpoint?.title)
            updatedAt = Date()
        } catch let e as LinkError {
            pollWarning = e.message
        } catch {
            pollWarning = "切換失敗，請再試一次"
        }
    }

    /// 使用者選「留在目前專案」：停止送進度
    func stayOnCurrent() {
        dismissedProjectId = pendingSwitch?.projectId
        pendingSwitch = nil
        detached = true
    }

    // MARK: - 輪詢

    private func startPolling(_ client: LanClient) {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                await self.poll(client)
            }
        }
    }

    private func poll(_ client: LanClient) async {
        do {
            let info = try await client.info()
            // 這一輪是舊連線（就地重新連線後已換成新的 token／位址）：結果不算
            guard !Task.isCancelled, client.endpoint == self.client?.endpoint else { return }
            pollWarning = nil
            needsReconnect = false
            if let h = info.host { hostName = h }
            let mine = project?.projectId
            if let id = info.projectId, let mine, id != mine {
                // 電腦換了專案：不動目前疊圖，等使用者決定
                if id != dismissedProjectId { pendingSwitch = info }
                return
            }
            // 回到原來的專案：恢復同步
            pendingSwitch = nil
            if detached { detached = false; dismissedProjectId = nil }

            if info.revision != infoRevision {
                let p = try await client.project()
                guard !Task.isCancelled else { return }
                infoRevision = info.revision
                if p != project {
                    project = p
                    stepPosition = min(stepPosition, max(0, p.steps.count - 1))
                    updatedAt = Date()
                    // 新版專案也存到手機（保留手機上的進度與名稱）
                    RecentProjects.save(p, source: endpoint?.title, endpoint: endpoint,
                                        done: progressConflict == nil ? done.sorted() : nil,
                                        stepPosition: progressConflict == nil ? stepPosition : nil)
                }
            }
            // 之前送失敗的進度：連線恢復了就重送（手機這份比較新，這一輪不套用電腦的）
            if pendingProgress, !detached, progressConflict == nil {
                progressSeq = info.progress?.seq
                sendProgress()
                return
            }
            if let pr = info.progress, let seq = pr.seq, seq != progressSeq {
                progressSeq = seq
                if pr.from != Self.myFrom, !syncDeferred, pr.projectId == nil || pr.projectId == project?.projectId {
                    if var c = progressConflict, let steps = project?.steps {
                        // 還在等使用者選：只更新「電腦的進度」那一份
                        c.desktopDone = pr.done.sorted()
                        if let s = pr.step { c.desktopStep = steps.firstIndex { $0.index == s } ?? c.desktopStep }
                        progressConflict = c
                    } else if pr.step == nil, Set(pr.done) == done {
                        markSynced(seq: seq)   // 電腦重開後送來同樣的進度（沒有 step）：不動目前位置
                    } else {
                        let before = (stepPosition, done)
                        apply(pr)
                        markSynced(seq: seq)
                        if before != (stepPosition, done) { progressAppliedFrom = pr.from; progressAppliedAt = Date() }
                    }
                }
            }
        } catch is CancellationError {
            return
        } catch let e as LinkError {
            // 舊連線的請求晚回來（已經用新的 token 連上了）：不要誤報「token 錯誤」
            guard !Task.isCancelled, client.endpoint == self.client?.endpoint else { return }
            if e == .badToken {
                needsReconnect = true
                pollWarning = "電腦重開過，需要重新連線"
                startTokenWatch()
            } else {
                pollWarning = "和桌面的連線中斷，重試中…"
            }
        } catch {
            pollWarning = "和桌面的連線中斷，重試中…"
        }
    }
}
