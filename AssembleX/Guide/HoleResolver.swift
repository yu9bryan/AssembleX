import Foundation
import simd

/// 桌面孔位名稱（"C12"、"BOT+38"）→ 這一幀影像中的位置（px）。
///
/// 主區直接用 `BreadboardResult.hole(named:)`。
/// 電源軌不能直接用 `RailHole.index`：偵測器的 index 是「從這一排看得到的第一組」起算（只補齊到整組，
/// 不知道前面還有幾組沒拍到），內／外排也是依「找到的第一排」決定，只拍到外排時會被標成內排。
/// 所以這裡用幾何重新編號：
///   - 內／外：量每排到 A（或 J）列的垂直距離（以孔距為單位）。桌面模型內排 2.83 格、外排 3.83 格。
///   - 第幾孔：把每個軌孔投影到同側主區列上得到「欄座標 u」，對照桌面模型
///     （830 板第 1 孔在第 3 欄，每 5 孔一組、組間空 1 格）算出絕對編號 1…50。
struct HoleResolver {
    let result: BreadboardResult
    private(set) var rails: [String: SIMD2<Double>] = [:]

    init(result: BreadboardResult) {
        self.result = result
        rails = Self.mapRails(result)
    }

    func point(_ id: String) -> SIMD2<Double>? {
        switch HoleID(id) {
        case let .main(row, col)?: return result.hole(row: row, col: col)?.point
        case .rail?: return rails[id.uppercased()]
        case nil: return nil
        }
    }

    // MARK: - 電源軌重新編號

    /// 每條軌的孔數、第 1 孔所在的主區欄座標（1 起）
    static func railModel(cols: Int) -> (holes: Int, firstCol: Double)? {
        let holes: Int
        switch cols {
        case 63: holes = 50
        case 30: holes = 25
        default: return nil
        }
        let groups = (holes + 4) / 5
        let span = Double((groups - 1) * 6 + 4)         // 第 1 孔到最後一孔，幾個孔距
        return (holes, 1 + (Double(cols - 1) - span) / 2)
    }

    private static func mapRails(_ r: BreadboardResult) -> [String: SIMD2<Double>] {
        guard !r.rails.isEmpty, let model = railModel(cols: r.cols) else { return [:] }
        var out: [String: SIMD2<Double>] = [:]
        for side in 0...1 {
            let edgeRow = (0..<r.cols).compactMap { r.hole(row: side == 0 ? 0 : 9, col: $0)?.point }
            guard edgeRow.count >= 2 else { continue }
            let rows = r.railRows.filter { $0.first?.side == side }
            // 每排到主區邊列的距離（孔距）
            let dist = rows.map { row in median(row.map { perpendicular($0.point, edgeRow) }) }
            for (k, row) in rows.enumerated() {
                let line: Int
                if rows.count >= 2 {
                    line = dist[k] == dist.min() ? 0 : 1
                } else {
                    line = dist[k] < 3.3 ? 0 : 1
                }
                let us = row.map { columnCoordinate($0.point, edgeRow) }
                let offset = indexOffset(row: row, us: us, firstCol: model.firstCol, holes: model.holes)
                for h in row {
                    let n = h.index + offset + 1
                    guard (1...model.holes).contains(n) else { continue }
                    out[HoleID.railName(side: side, line: line, n: n)] = h.point
                }
            }
        }
        return out
    }

    /// 偵測器 index → 桌面編號（0 起）要加多少
    private static func indexOffset(row: [RailHole], us: [Double], firstCol: Double, holes: Int) -> Int {
        let groups = (holes + 4) / 5
        // 有沒有「組間空格」：相鄰孔距離有明顯大一截的
        let gaps = zip(row, row.dropFirst()).map { simd_distance($0.point, $1.point) }
        let m = median(gaps)
        let gapped = row.count >= 10 && gaps.contains { $0 > m * 1.5 }
        var votes: [Int: Int] = [:]
        if gapped {
            // 偵測器每排從整組開頭補起，index/5 就是組別；用組中心對照桌面組別
            var byGroup: [Int: [Double]] = [:]
            for (h, u) in zip(row, us) { byGroup[h.index / 5, default: []].append(u - firstCol) }
            for (j, ps) in byGroup {
                let center = ps.reduce(0, +) / Double(ps.count)       // 組中心＝組內第 3 孔
                let g = min(max(Int(((center - 2) / 6).rounded()), 0), groups - 1)
                votes[(g - j) * 5, default: 0] += 1
            }
        } else {
            for (h, u) in zip(row, us) {
                let p = u - firstCol
                let g = min(max(Int(((p - 2) / 6).rounded()), 0), groups - 1)
                let hh = min(max(Int((p - Double(g * 6)).rounded()), 0), 4)
                votes[g * 5 + hh - h.index, default: 0] += 1
            }
        }
        return votes.max { $0.value < $1.value }?.key ?? 0
    }

    /// 點到主區邊列（折線）的垂直距離，以當地孔距為單位
    private static func perpendicular(_ p: SIMD2<Double>, _ row: [SIMD2<Double>]) -> Double {
        let a = segmentStart(p, row)
        let d = row[a + 1] - row[a]
        let len = max(1e-6, simd_length(d))
        let v = p - row[a]
        return abs(d.x * v.y - d.y * v.x) / len / len
    }

    /// 點投影到主區邊列上的欄座標（1 起，可為小數）
    private static func columnCoordinate(_ p: SIMD2<Double>, _ row: [SIMD2<Double>]) -> Double {
        let a = segmentStart(p, row)
        let d = row[a + 1] - row[a]
        let t = simd_dot(p - row[a], d) / max(1e-9, simd_length_squared(d))
        return Double(a) + t + 1
    }

    private static func segmentStart(_ p: SIMD2<Double>, _ row: [SIMD2<Double>]) -> Int {
        var best = 0, bestD = Double.infinity
        for (i, q) in row.enumerated() {
            let d = simd_distance_squared(p, q)
            if d < bestD { bestD = d; best = i }
        }
        return min(best, row.count - 2)
    }

    private static func median(_ v: [Double]) -> Double {
        guard !v.isEmpty else { return 0 }
        let s = v.sorted()
        return s[s.count / 2]
    }
}
