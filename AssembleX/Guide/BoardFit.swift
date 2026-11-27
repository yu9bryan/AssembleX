import Foundation

/// 真的麵包板比專案用的小（例如專案排在 830 孔板，手上是 400 孔）時，把專案「搬」到真的板子上：
/// 真板子當成專案板子上的一個窗口（第 offset+1 … offset+realCols 欄），
/// 產生一份「真板子版」的專案：孔名改成真板子的欄號、座標平移，元件與開發板跟著平移。
/// 之後 AR 對位（用孔名配對）、3D、2D、疊圖、步驟文字都直接用這一份，不會畫到板子外面。
struct BoardFit: Equatable {
    enum State: Equatable {
        /// 一樣大（或真板子更大）：不用搬
        case same
        /// 搬好了：offset＝專案欄號 − 真板子欄號；first/last＝用到的範圍（真板子欄號）
        case fitted(offset: Int, first: Int, last: Int)
        /// 放不下：專案需要 need 欄（或需要電源軌但真板子沒有）
        case tooSmall(need: Int, needsRails: Bool)
    }

    let realCols: Int
    let projectCols: Int
    let state: State
    /// 電源軌孔在真板子上沒有剛好同一欄的（改用最近的軌孔）：真板子上的孔名
    var railSnapped: Set<String> = []

    static func kind(_ cols: Int) -> String {
        switch cols {
        case 63: return "830 孔"
        case 30: return "400 孔"
        case 17: return "170 孔"
        default: return "\(cols) 欄"
        }
    }

    /// 建議的板子：放得下 need 欄（要不要電源軌）的最小常見板
    static func suggested(need: Int, rails: Bool) -> Int {
        if need <= 17 && !rails { return 17 }
        if need <= 30 { return 30 }
        return 63
    }

    /// 給使用者看的狀態
    var summary: String {
        switch state {
        case .same:
            return "偵測到 \(Self.kind(realCols)) 麵包板 · 大小和專案一致"
        case let .fitted(_, first, last):
            return "\(Self.kind(realCols)) 麵包板 · 已把走線對到第 \(first)–\(last) 欄"
        case let .tooSmall(need, rails):
            let s = Self.suggested(need: need, rails: rails)
            if rails && HoleResolver.railModel(cols: realCols) == nil && need <= realCols {
                return "這個專案要用電源軌，\(Self.kind(realCols)) 麵包板沒有電源軌。請換 \(Self.kind(max(s, 30))) 以上的麵包板"
            }
            return "這個專案需要 \(need) 欄（約 \(Self.kind(s)) 麵包板），你的麵包板只有 \(realCols) 欄。請在電腦開新專案選「\(Self.kind(realCols))」或換大的麵包板"
        }
    }

    var isTooSmall: Bool { if case .tooSmall = state { return true } else { return false } }
}

extension LanProject {
    /// 專案用到的主區欄（1 起；電源軌算旁邊那一欄）、有沒有用到電源軌
    func usedColumns() -> (min: Int, max: Int, rails: Bool)? {
        var ids = Set<String>()
        for s in steps { ids.formUnion(s.holes) }
        for p in parts { for pin in p.pins { if let h = pin.hole { ids.insert(h) } } }
        for w in wires { for e in [w.from, w.to] { if let h = e.hole { ids.insert(h) } } }
        var cols: [Int] = [], rails = false
        for id in ids {
            switch HoleID(id) {
            case let .main(_, col)?: cols.append(col + 1)
            case let .rail(_, _, n)?:
                rails = true
                if let c = HoleID.railColumn(n: n, columns: columns) { cols.append(Int(c.rounded())) }
            case nil: break
            }
        }
        guard let lo = cols.min(), let hi = cols.max() else { return nil }
        return (lo, hi, rails)
    }

    /// 搬到 realCols 欄的真板子上。放得下才產生新專案；一樣大或放不下時回傳原專案（看 fit.state）。
    func fitted(toRealCols real: Int) -> (project: LanProject, fit: BoardFit) {
        let pc = columns
        let same = (self, BoardFit(realCols: real, projectCols: pc, state: .same))
        guard real < pc, let used = usedColumns() else { return same }
        let span = used.max - used.min + 1
        let realRails = HoleResolver.railModel(cols: real)
        if span > real || (used.rails && realRails == nil) {
            return (self, BoardFit(realCols: real, projectCols: pc, state: .tooSmall(need: span, needsRails: used.rails)))
        }
        guard let h = holes, let a1 = h["A1"], a1.count >= 2 else { return same }
        // 用到的範圍放在真板子中間
        let offset = Swift.min(Swift.max(used.min - 1 - (real - span) / 2, 0), pc - real)
        let pitch = breadboard?.pitchMm ?? 2.54
        let dx = Double(offset) * pitch
        let x0 = a1[0]

        // 真板子的孔位（座標系和原專案一樣，第 1 欄在原本第 1 欄的位置）
        var nh: [String: [Double]] = [:]
        for (r, L) in BreadboardResult.rowLetters.enumerated() {
            guard let z = h["\(L)1"]?[safe: 1] else { continue }
            _ = r
            for c in 1...real { nh["\(L)\(c)"] = [x0 + Double(c - 1) * pitch, z] }
        }
        if let model = realRails {
            for side in 0...1 {
                for line in 0...1 {
                    let prefix = HoleID.railName(side: side, line: line, n: 1).dropLast()
                    guard let z = h.first(where: { $0.key.hasPrefix(prefix) })?.value[safe: 1] else { continue }
                    for n in 1...model.holes {
                        guard let col = HoleID.railColumn(n: n, columns: real) else { continue }
                        nh[HoleID.railName(side: side, line: line, n: n)] = [x0 + (col - 1) * pitch, z]
                    }
                }
            }
        }

        var snapped = Set<String>()
        func map(_ id: String) -> String? {
            switch HoleID(id) {
            case let .main(row, col)?:
                let c = col + 1 - offset
                guard (1...real).contains(c) else { return nil }
                return "\(BreadboardResult.rowLetters[row])\(c)"
            case let .rail(side, line, n)?:
                guard let model = realRails, let vc = HoleID.railColumn(n: n, columns: pc) else { return nil }
                let rc = vc - Double(offset)
                var best = 1, bestD = Double.infinity
                for k in 1...model.holes {
                    guard let c = HoleID.railColumn(n: k, columns: real) else { continue }
                    if abs(c - rc) < bestD { bestD = abs(c - rc); best = k }
                }
                let out = HoleID.railName(side: side, line: line, n: best)
                // 400 孔板的軌孔本來就和主區錯開半格；落在組間空格（差 ≥ 0.6 欄）才算對不到
                if bestD >= 0.6 { snapped.insert(out) }
                return out
            case nil:
                return id
            }
        }

        var p = self
        p.holes = nh
        p.holeLabels = nil          // 名稱改用真板子的欄號自己算（「麵包板 D 排 N 欄」「A 側＋軌（第 N 欄旁）」）
        p.parts = parts.map { part in
            var q = part
            q.pins = part.pins.map { pin in var x = pin; x.hole = pin.hole.flatMap(map); return x }
            if var pose = q.poseMm, !pose.position.isEmpty { pose.position[0] -= dx; q.poseMm = pose }
            return q
        }
        if var b = p.board, var pose = b.poseMm, !pose.position.isEmpty {
            pose.position[0] -= dx; b.poseMm = pose; p.board = b
        }
        p.wires = wires.map { w in
            var q = w
            q.from.hole = w.from.hole.flatMap(map)
            q.to.hole = w.to.hole.flatMap(map)
            // 桌面的佈線折線、腳位座標也一起平移到真板子上
            func shift(_ v: [Double]) -> [Double] { v.isEmpty ? v : [v[0] - dx] + v.dropFirst() }
            q.pathMm = w.pathMm?.map(shift)
            q.from.posMm = w.from.posMm.map(shift)
            q.to.posMm = w.to.posMm.map(shift)
            return q
        }
        p.steps = steps.map { s in
            var q = s
            q.holes = s.holes.compactMap(map)
            return q
        }
        // 元件步驟的說明用新的孔名重組（「腳1 → 麵包板 E 排 8 欄 · …」），舊的欄號不會留在文字裡
        let mapped = p
        p.steps = p.steps.map { s in
            var q = s
            if !s.isWire, let part = mapped.part(s.targetId), part.pins.contains(where: { $0.hole != nil }) {
                q.detail = part.pins.compactMap { pin in pin.hole.map { "\(pin.label ?? pin.pin) → \($0)" } }.joined(separator: " · ")
            } else if let d = s.detail {
                q.detail = Self.shiftColumns(in: d, by: offset)
            }
            return q
        }
        var bb = breadboard ?? Breadboard()
        bb.columns = real
        bb.profileId = real == 30 ? "breadboard_400" : real == 17 ? "breadboard_170" : bb.profileId
        let size = bb.sizeMm ?? [165.1, 8.5, 54.4]
        bb.sizeMm = [2 * x0 + Double(real - 1) * pitch, size[safe: 1] ?? 8.5, size[safe: 2] ?? 54.4]
        p.breadboard = bb

        let first = used.min - offset, last = used.max - offset
        return (p, BoardFit(realCols: real, projectCols: pc, state: .fitted(offset: offset, first: first, last: last), railSnapped: snapped))
    }

    /// 文字裡的欄號（「D 排 40 欄」「第 45 欄旁」「→ E40」）減掉 offset
    static func shiftColumns(in text: String, by offset: Int) -> String {
        var s = text
        for pattern in [#"([A-J]\s*排\s*)(\d+)(\s*欄)"#, #"(第\s*)(\d+)(\s*欄)"#, #"(→\s*[A-Ja-j])(\d{1,2})()(?![\d+\-A-Za-z])"#] {
            guard let re = try? NSRegularExpression(pattern: pattern) else { continue }
            let ns = s as NSString
            var out = "", last = 0
            for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
                let n = Int(ns.substring(with: m.range(at: 2))) ?? 0
                out += ns.substring(with: m.range(at: 1)) + "\(n - offset)" + ns.substring(with: m.range(at: 3))
                last = m.range.location + m.range.length
            }
            s = out + ns.substring(from: last)
        }
        return s
    }
}
