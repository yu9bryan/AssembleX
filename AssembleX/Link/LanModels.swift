import Foundation

// 內網分享協定 v1 的資料模型（docs/LAN_PROTOCOL.md）。
// 非必要欄位一律可缺，桌面端加欄位或少欄位都不會讓手機端解不開。

struct LanInfo: Codable, Sendable, Equatable {
    var v: Int
    var app: String?
    var title: String?
    var projectId: String?
    var revision: Int
    /// 電腦名稱（較新的桌面版才有；沒有就用 Bonjour 名稱）
    var host: String?
    /// v1.1：組裝進度（手機與桌面共用）
    var progress: LanProgress?

    /// 電腦開著的專案 id（沒開專案時桌面可能送 null 或空字串，都當成沒有）
    var openProjectId: String? { projectId.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } }
    /// 專案名稱（空的叫「未命名專案」）
    var projectTitle: String { title.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? "未命名專案" }
}

/// v1.1 組裝進度。`step`／`done` 是 `Step.index`。
struct LanProgress: Codable, Sendable, Equatable {
    var projectId: String?
    /// 桌面還沒進入組裝步驟時是 null（只同步已完成的步驟）
    var step: Int?
    var done: [Int]
    var from: String?
    var seq: Int?
}

struct LanProgressReply: Codable, Sendable {
    var ok: Bool?
    var seq: Int?
}

struct LanProject: Codable, Sendable, Equatable {
    var v: Int
    var title: String
    var projectId: String?
    var revision: Int
    var board: Board?
    var breadboard: Breadboard?
    var parts: [Part]
    var wires: [Wire]
    var steps: [Step]
    /// 孔位 → 麵包板座標 [x, z]（mm）
    var holes: [String: [Double]]?
    /// 孔位 → 給人看的名稱（桌面產生，例如 "BOT+24": "靠 A 排的＋軌（第 30 欄旁）"）。卡片與疊圖都用這一份
    var holeLabels: [String: String]?

    /// 孔位名稱：桌面給的優先，沒有就用同格式自己算。
    /// 主區孔寫成「麵包板 D 排 8 欄」，不會和開發板腳位「D8」搞混。
    func label(_ hole: String) -> String {
        Self.normalizeSide(desktopLabel(hole) ?? HoleID.displayName(hole, columns: columns))
    }

    /// 舊版桌面寫「靠 A 排的＋軌」：統一成現在桌面的「A 側＋軌」（三端同一種說法）
    static func normalizeSide(_ s: String) -> String {
        let t = s.replacingOccurrences(of: "靠 A 排的", with: "A 側").replacingOccurrences(of: "靠 J 排的", with: "J 側")
        return railWording(t)
    }

    /// 「A 側−軌（第 43 欄旁）」→「藍色 − 電源軌（A 那一側，第 43 欄旁）」：初學者看得懂是哪一條
    static func railWording(_ s: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"([AJ])\s*側\s*([＋−+\-])\s*軌\s*（第\s*(\d+)\s*欄旁）"#) else { return s }
        let ns = s as NSString
        var out = "", last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let side = ns.substring(with: m.range(at: 1)), sign = ns.substring(with: m.range(at: 2)), col = ns.substring(with: m.range(at: 3))
            let plus = sign == "＋" || sign == "+"
            out += (plus ? "紅色 ＋ 電源軌" : "藍色 − 電源軌") + "（\(side) 那一側，第 \(col) 欄旁）"
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// 這一步的孔哪些是通的（給步驟卡一行說明）：「E 排 40 欄：和 40 欄的 A–E 是通的」
    func connectivityHints(_ step: Step) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for h in step.holes {
            switch HoleID(h) {
            case let .main(row, col)?:
                let half = row < 5 ? "A–E" : "F–J"
                guard seen.insert("\(col)\(half)").inserted else { continue }
                out.append("\(BreadboardResult.rowLetters[row]) 排 \(col + 1) 欄：和 \(col + 1) 欄的 \(half) 是通的")
            case .rail?:
                guard seen.insert("rail").inserted else { continue }
                out.append("電源軌：同一條（紅＋或藍−）整排是通的")
            case nil: break
            }
        }
        return out
    }

    /// 桌面給的名稱；舊版桌面主區孔只回原樣（"D10" → "D10"），那不算名稱
    private func desktopLabel(_ hole: String) -> String? {
        guard let d = holeLabels?[hole] ?? holeLabels?[hole.uppercased()],
              d.caseInsensitiveCompare(hole) != .orderedSame else { return nil }
        return d
    }

    /// 疊圖用的短名稱，和桌面 3D 標籤同一種：主區「D 排 8 欄」、電源軌「A 側−軌·43 欄」
    func shortLabel(_ hole: String) -> String {
        switch HoleID(hole) {
        case let .main(row, col)?:
            if let d = desktopLabel(hole), d.hasPrefix("麵包板 ") { return String(d.dropFirst(4)) }
            return "\(BreadboardResult.rowLetters[row]) 排 \(col + 1) 欄"
        case let .rail(side, line, n)?:
            // 欄號取桌面名稱裡的「第 N 欄」（和卡片同一個數字），沒有才自己算
            let full = label(hole)
            let col: String
            if let m = full.range(of: #"第\s*(\d+)\s*欄"#, options: .regularExpression) { col = full[m].filter(\.isNumber) }
            else if let c = HoleID.railColumn(n: n, columns: columns) { col = "\(Int(c.rounded()))" }
            else { return full }
            return (side == 0 ? "A" : "J") + " 側" + (line == 0 ? "＋" : "−") + "軌·\(col) 欄"
        case nil:
            return label(hole)
        }
    }

    /// 導線端點：孔用 label(_:)，開發板腳位用 label
    func text(_ e: End) -> String { e.hole.map(label) ?? e.label ?? e.pin ?? "?" }

    struct Board: Codable, Sendable, Equatable {
        var profileId: String?
        var name: String?
        var onBreadboard: Bool?
        /// v1.2：模型檔名（不含副檔名）與在麵包板座標的位置
        var model: String?
        var poseMm: PoseMm?
    }

    /// v1.2：元件原點在麵包板座標（mm；x 沿欄、y 向上、z 沿列 A→J）的位置與繞 Y 軸角度
    struct PoseMm: Codable, Sendable, Equatable {
        var position: [Double]
        var rotationDeg: Double?
    }

    struct Breadboard: Codable, Sendable, Equatable {
        var profileId: String?
        var columns: Int?
        var rows: [String]?
        var pitchMm: Double?
        /// v1.2：[W, H, D] mm（H＝板厚，孔口在 y = H）
        var sizeMm: [Double]?
    }

    struct Part: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var tag: String?
        var name: String?
        var pins: [Pin]
        /// v1.2
        var profileId: String?
        var model: String?
        var poseMm: PoseMm?
        /// v1.3：沒有 3D 模型（從規格書新增）時畫方塊用
        var bboxMm: [Double]?
        var color: String?
        /// 元件參數（有給才用，例如電阻色環）
        var parameters: Parameters?
        /// 板外元件（不插麵包板，例如 LD06 用排線）：poseMm 是它在麵包板旁的位置
        var offBoard: Bool?
        /// 從規格書圖面生成的 3D（基本形狀；原點＝元件底面中心、mm）
        var modelParts: [ModelPart]?
    }

    /// 桌面 datasheetShape 的一個基本形狀。size：box／rounded_box＝[x, y, z]；cylinder／cone／dome＝[直徑, 高]；torus＝[外徑, 管徑]。
    /// position 的 y 是形狀的底面。欄位都可缺（桌面多帶少帶都不會讓整份專案解不開）
    struct ModelPart: Codable, Sendable, Equatable {
        var shape: String?
        var size: [Double]?
        var position: [Double]?
        var rotation_deg: [Double]?
        var color: String?
        var material: String?
    }

    struct Parameters: Codable, Sendable, Equatable {
        var resistance_ohm: Double?
    }

    struct Pin: Codable, Sendable, Equatable {
        var pin: String
        var label: String?
        var hole: String?
    }

    struct Wire: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var color: String?
        var role: String?
        var net: String?
        var from: End
        var to: End
        /// 桌面佈線好的折線（mm，麵包板座標，y 朝上）：有就照這條畫，板外的線才會真的接到外接元件與開發板
        var pathMm: [[Double]]?
    }

    /// 插麵包板：{ hole }；接開發板排針：{ pin, label }
    struct End: Codable, Sendable, Equatable {
        var hole: String?
        var pin: String?
        var label: String?
        /// 腳位端點的座標（mm，麵包板座標）：板外元件的線頭在排線末端的杜邦頭
        var posMm: [Double]?

        var text: String { hole.map { HoleID.displayName($0) } ?? label ?? pin ?? "?" }
    }

    struct Step: Codable, Sendable, Equatable {
        var index: Int
        var kind: String          // "place" | "wire"
        var targetId: String
        var tag: String?
        var title: String
        var detail: String?
        var holes: [String]

        var isWire: Bool { kind == "wire" }
    }

    /// 步驟說明：導線由端點重組（「A30 → 靠 A 排的＋軌（第 30 欄旁）」），其他用桌面的 detail（舊版「下方 ＋ 軌 14」改成「靠 A 排的＋軌 14」）
    func detail(of step: Step) -> String {
        if step.isWire, let w = wire(step.targetId) { return "\(text(w.from)) → \(text(w.to))" }
        var d = step.detail ?? ""
        d = d.replacingOccurrences(of: "\u{2009}→\u{2009}", with: " → ")
        // 舊版桌面送「上方／下方」：換成和板子方向無關的「靠 A 排的／靠 J 排的」
        d = d.replacingOccurrences(of: #"(上方|下方)\s*([＋−+\-])\s*軌"#, with: "$1$2軌", options: .regularExpression)
        d = d.replacingOccurrences(of: "下方", with: "A 側").replacingOccurrences(of: "上方", with: "J 側")
        d = Self.normalizeSide(d)
        d = d.replacingOccurrences(of: "側+", with: "側＋")
        // 桌面舊版 detail 寫「腳1 → E8」：箭頭後面的主區孔改成「麵包板 E 排 8 欄」（箭頭前是腳位名稱，不動）
        let re = try? NSRegularExpression(pattern: #"(→\s*)([A-Ja-j])(\d{1,2})(?![\d+\-A-Za-z])"#)
        if let re {
            let ns = d as NSString
            var out = "", last = 0
            for m in re.matches(in: d, range: NSRange(location: 0, length: ns.length)) {
                out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
                let hole = ns.substring(with: m.range(at: 2)).uppercased() + ns.substring(with: m.range(at: 3))
                out += ns.substring(with: m.range(at: 1)) + label(hole)
                last = m.range.location + m.range.length
            }
            d = out + ns.substring(from: last)
        }
        return d
    }

    func wire(_ id: String) -> Wire? { wires.first { $0.id == id } }
    func part(_ id: String) -> Part? { parts.first { $0.id == id } }

    /// 這塊專案用的麵包板欄數（830 孔＝63）
    var columns: Int { breadboard?.columns ?? 63 }
}

/// 桌面端孔位名稱：主區 "C12"；電源軌 "BOT+38"、"TOP-3"。
enum HoleID: Equatable, Sendable {
    case main(row: Int, col: Int)                   // 0 起
    /// side：0＝BOT（A 側）、1＝TOP（J 側）；line：0＝＋（內排）、1＝−（外排）；n：1 起
    case rail(side: Int, line: Int, n: Int)

    init?(_ raw: String) {
        let s = raw.trimmingCharacters(in: .whitespaces).uppercased()
        for (prefix, side) in [("BOT", 0), ("TOP", 1)] where s.hasPrefix(prefix) {
            let rest = s.dropFirst(prefix.count)
            guard let sign = rest.first, sign == "+" || sign == "-", let n = Int(rest.dropFirst()), n >= 1 else { return nil }
            self = .rail(side: side, line: sign == "+" ? 0 : 1, n: n)
            return
        }
        guard let first = s.first, let r = BreadboardResult.rowLetters.firstIndex(of: String(first)),
              let c = Int(s.dropFirst()), c >= 1 else { return nil }
        self = .main(row: r, col: c - 1)
    }

    static func railName(side: Int, line: Int, n: Int) -> String {
        (side == 0 ? "BOT" : "TOP") + (line == 0 ? "+" : "-") + String(n)
    }

    /// 給人看（桌面沒給 holeLabels 時的備援，用語和桌面相同）：D8 →「麵包板 D 排 8 欄」；BOT+24 → 「靠 A 排的＋軌（第 30 欄旁）」；
    /// 板型不認得時退回「靠 A 排的＋軌 24」
    static func displayName(_ raw: String, columns: Int = 63) -> String {
        if case let .main(row, col)? = HoleID(raw) { return "麵包板 \(BreadboardResult.rowLetters[row]) 排 \(col + 1) 欄" }
        guard case let .rail(side, line, n)? = HoleID(raw) else { return raw.uppercased() }
        let head = (side == 0 ? "A 側" : "J 側") + (line == 0 ? "＋" : "−") + "軌"
        guard let col = railColumn(n: n, columns: columns) else { return head + " \(n)" }
        return head + "（第 \(Int(col.rounded())) 欄旁）"
    }

    /// 電源軌第 n 孔（1 起）旁邊的主區欄號（桌面模型：830 板第 1 孔在第 3 欄、5 孔一組、組間空 1 格）
    static func railColumn(n: Int, columns: Int) -> Double? {
        guard let m = HoleResolver.railModel(cols: columns), (1...m.holes).contains(n) else { return nil }
        let i = n - 1
        return m.firstCol + Double((i / 5) * 6 + i % 5)
    }

    /// 這個孔在主區的欄號（電源軌用旁邊的欄），給模擬板捲動用
    func column(columns: Int = 63) -> Double? {
        switch self {
        case let .main(_, col): return Double(col + 1)
        case let .rail(_, _, n): return HoleID.railColumn(n: n, columns: columns)
        }
    }
}
