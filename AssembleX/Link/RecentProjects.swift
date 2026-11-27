import Foundation

/// 手機上存過的專案：連線成功時把整份專案（含孔位、步驟、模型清單）存下來，
/// 之後不用連電腦也能重新打開接線指引；進度也一起存。最多保留 12 筆，最新的在前。
struct RecentProject: Codable, Identifiable, Equatable {
    var project: LanProject
    var savedAt: Date
    var openedAt: Date
    /// 從哪台電腦來（顯示用）
    var source: String?
    var done: [Int]
    var stepPosition: Int
    /// 使用者在手機上改的名字（重新連線、桌面更新專案都不會蓋掉）
    var customTitle: String?
    /// 上次連到這個專案的電腦（可以直接重新連線）
    var endpoint: LanEndpoint?
    /// 手機上按了「重新開始」、還沒和電腦對齊（下次連線時，電腦有進度就會問要用哪一份）
    var resetPending: Bool?
    /// 進度真的改變的時間（只是打開不算）：進度衝突時用來說哪份較新
    var progressAt: Date?
    /// 上次和電腦對齊時的進度：連線時拿來判斷「只有一邊改過」（不用問）還是「兩邊都改過」（才問）
    var lastSynced: SyncPoint?
    var id: String { project.projectId ?? project.title }
    var displayTitle: String { customTitle ?? project.title }
    /// 手機上有沒有任何進度
    var hasProgress: Bool { !done.isEmpty || stepPosition > 0 }
}

/// 和電腦對齊時的進度（stepPosition 是 steps 陣列位置）
struct SyncPoint: Codable, Equatable {
    var done: [Int]
    var step: Int
    /// 對齊時電腦的 progress.seq
    var seq: Int?

    func same(done d: Set<Int>, step s: Int) -> Bool { Set(done) == d && step == s }
}

enum RecentProjects {
    private static var url: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("recent-projects.json")
    }

    static func load() -> [RecentProject] {
        guard let d = try? Data(contentsOf: url) else { return [] }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([RecentProject].self, from: d)) ?? []
    }

    static func find(id: String) -> RecentProject? { load().first { $0.id == id } }

    private static func write(_ list: [RecentProject]) {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        if let d = try? enc.encode(list) { try? d.write(to: url, options: .atomic) }
    }

    /// 存一份（同一個專案覆蓋舊的、移到最前面）。done 為 nil：沿用手機上原本的進度。
    static func save(_ p: LanProject, source: String?, endpoint: LanEndpoint? = nil, done: [Int]? = nil, stepPosition: Int? = nil) {
        var list = load()
        let id = p.projectId ?? p.title
        let old = list.first { $0.id == id }
        list.removeAll { $0.id == id }
        let now = Date()
        let newDone = done ?? old?.done ?? [], newStep = stepPosition ?? old?.stepPosition ?? 0
        // 進度沒變就保留原本的「進度改變時間」（只是重新連線不算改動）
        let changed = old.map { Set($0.done) != Set(newDone) || $0.stepPosition != newStep } ?? true
        list.insert(RecentProject(project: p, savedAt: now, openedAt: now, source: source ?? old?.source ?? endpoint.map { "電腦（\($0.host)）" },
                                  done: newDone, stepPosition: newStep,
                                  customTitle: old?.customTitle,
                                  endpoint: endpoint ?? old?.endpoint, resetPending: old?.resetPending,
                                  progressAt: changed && (old != nil || !newDone.isEmpty) ? now : old?.progressAt,
                                  lastSynced: old?.lastSynced), at: 0)
        write(Array(list.prefix(12)))
    }

    static func updateProgress(id: String, done: [Int], stepPosition: Int) {
        var list = load()
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        if list[i].done != done || list[i].stepPosition != stepPosition { list[i].progressAt = Date() }
        list[i].done = done; list[i].stepPosition = stepPosition; list[i].openedAt = Date()
        if !done.isEmpty || stepPosition > 0 { list[i].resetPending = nil }
        write(list)
    }

    /// 記下「和電腦對齊了」的那份進度
    static func setSynced(id: String, _ point: SyncPoint) {
        var list = load()
        guard let i = list.firstIndex(where: { $0.id == id }), list[i].lastSynced != point else { return }
        list[i].lastSynced = point
        write(list)
    }

    static func clearResetPending(id: String) {
        var list = load()
        guard let i = list.firstIndex(where: { $0.id == id }), list[i].resetPending != nil else { return }
        list[i].resetPending = nil
        write(list)
    }

    /// 重新開始：清掉手機上的進度
    static func resetProgress(id: String) {
        var list = load()
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        if list[i].hasProgress { list[i].progressAt = Date() }
        list[i].done = []; list[i].stepPosition = 0; list[i].resetPending = true
        write(list)
    }

    /// 復原剛刪掉的那一筆（放回最前面）
    static func restore(_ r: RecentProject) {
        var list = load().filter { $0.id != r.id }
        list.insert(r, at: 0)
        write(Array(list.prefix(12)))
    }

    static func remove(id: String) {
        write(load().filter { $0.id != id })
    }

    /// 改手機上顯示的名字（空字串＝恢復電腦上的名字）
    static func rename(id: String, to title: String) {
        var list = load()
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        list[i].customTitle = title.isEmpty || title == list[i].project.title ? nil : title
        write(list)
    }
}
