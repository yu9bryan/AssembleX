import Foundation
import simd

// 電源軌偵測：主區 A–J 的格點（單應矩陣 H）定下來之後，在 A 列外側、J 列外側各找兩排電源軌孔。
//
// 電源軌和主區常錯開半格、和 A/J 的距離也不是整數格（830 板約 2.5、3.5 格），每 5 孔一組、組間空 1 孔，
// 所以主區格點擬合時會被當成雜點丟掉。這裡改在格點座標 (u＝欄方向, d＝往板外的距離) 裡：
//   1. 收集主區外 1.2–6.5 格內、大小像孔的暗點
//   2. 依 d 找出點最多的兩條「排」（同一排的 d 相同；允許 d 隨 u 線性變化以吸收外推誤差）
//   3. 每排估欄方向相位（frac(u) 的圓平均，錯開半格時約 0.5），把點對到整數位置 k
//   4. 找「5 孔一組、空 1」的週期；沒有空格週期就當連續
//   5. 由偵測到的範圍補齊整組，推算被擋住的孔

struct RailHole {
    let side: Int          // 0＝A 側、1＝J 側
    let line: Int          // 0＝內排（靠主區）、1＝外排
    let index: Int         // 沿電源軌第幾孔（0 起，從第 1 欄那端算）
    let point: SIMD2<Double>
    let detected: Bool

    var name: String { RailHole.name(side: side, line: line, index: index) }
    static func name(side: Int, line: Int, index: Int) -> String {
        (side == 0 ? "A" : "J") + "軌" + (line == 0 ? "內" : "外") + String(index + 1)
    }
}

/// 有名字的點（主區孔或電源軌孔），給目標孔／跳線用。
struct NamedPoint: Equatable {
    let name: String
    let point: SIMD2<Double>
}

extension BreadboardResult {
    /// 主區孔或電源軌孔（例如 "A5"、"A軌內3"）。
    func point(named raw: String) -> NamedPoint? {
        if let h = hole(named: raw) { return NamedPoint(name: h.name, point: h.point) }
        let s = raw.trimmingCharacters(in: .whitespaces).uppercased()
        return rails.first { $0.name == s }.map { NamedPoint(name: $0.name, point: $0.point) }
    }

    func nearestPoint(to p: SIMD2<Double>, maxDistance: Double) -> NamedPoint? {
        var best: NamedPoint?
        var bestD = maxDistance
        for h in holes {
            let d = simd_distance(h.point, p)
            if d < bestD { bestD = d; best = NamedPoint(name: h.name, point: h.point) }
        }
        for h in rails {
            let d = simd_distance(h.point, p)
            if d < bestD { bestD = d; best = NamedPoint(name: h.name, point: h.point) }
        }
        return best
    }

    /// 每條電源軌（side, line）的孔，依 index 排好。
    var railRows: [[RailHole]] {
        var rows: [[RailHole]] = []
        for side in 0...1 {
            for line in 0...1 {
                let r = rails.filter { $0.side == side && $0.line == line }.sorted { $0.index < $1.index }
                if !r.isEmpty { rows.append(r) }
            }
        }
        return rows
    }
}

enum RailDetector {
    /// pts／allowed：所有候選暗點與是否大小像孔；H：格點 → 影像；
    /// rowLattice：A…J 對應的格點列（遞增）；reverseRows／reverseCols：和主區標號一致的方向。
    static func detect(pts: [SIMD2<Double>], allowed: [Bool], H: simd_double3x3, colIsA: Bool,
                       rowLattice: [Int], colsLattice: [Int], reverseRows: Bool, reverseCols: Bool,
                       debug: Bool = false) -> [RailHole] {
        guard rowLattice.count == 10, let c0 = colsLattice.first, let c1 = colsLattice.last else { return [] }
        let inv = H.inverse
        // 格點座標
        var lat: [(u: Double, v: Double)] = []
        lat.reserveCapacity(pts.count)
        for p in pts {
            let q = Homography.apply(inv, p)
            lat.append(colIsA ? (q.x, q.y) : (q.y, q.x))
        }
        let uMin = Double(c0) - 1.5, uMax = Double(c1) + 1.5
        let minCount = max(8, colsLattice.count / 6)
        var out: [RailHole] = []

        for side in 0...1 {
            // 這一側的主區邊列（最終標號 A 或 J）在格點中的位置，和往板外的方向
            let finalRow = side == 0 ? 0 : 9
            let idx = reverseRows ? 9 - finalRow : finalRow
            let edge = Double(rowLattice[idx])
            let s: Double = idx == 0 ? -1 : 1
            var cand: [(u: Double, d: Double)] = []
            for (i, q) in lat.enumerated() where allowed[i] && q.u >= uMin && q.u <= uMax {
                let d = (q.v - edge) * s
                if d >= 1.2 && d <= 6.5 { cand.append((q.u, d)) }
            }

            // 找兩排：d 上點最密的中心，拿掉附近的點再找一次
            var rows: [(center: Double, pts: [(u: Double, d: Double)])] = []
            var rest = cand
            for _ in 0..<3 {
                var bestC = 0.0, bestN = 0
                var c = 1.25
                while c <= 6.5 {
                    let n = rest.reduce(0) { abs($1.d - c) < 0.25 ? $0 + 1 : $0 }
                    if n > bestN { bestN = n; bestC = c }
                    c += 0.05
                }
                guard bestN >= minCount else { break }
                let inRow = rest.filter { abs($0.d - bestC) < 0.35 }
                rest.removeAll { abs($0.d - bestC) < 0.35 }
                rows.append((bestC, inRow))
            }
            rows.sort { $0.center < $1.center }
            // 內排要靠近主區；外排和內排距離約 1 格
            guard let inner = rows.first, inner.center < 4.6 else { continue }
            var chosen = [inner]
            if let outer = rows.dropFirst().first(where: { (0.6...1.6).contains($0.center - inner.center) }) {
                chosen.append(outer)
            }
            if debug {
                print("  [rail] side=\(side) rows=" + rows.map { String(format: "%.2f:%d", $0.center, $0.pts.count) }.joined(separator: " "))
            }

            for (line, row) in chosen.enumerated() {
                guard let holes = fitRow(row.pts, minCount: minCount) else { continue }
                var list: [(k: Int, u: Double, d: Double, det: Bool)] = holes
                if reverseCols { list.reverse() }
                for (i, h) in list.enumerated() {
                    let v = edge + s * h.d
                    let l = colIsA ? SIMD2(h.u, v) : SIMD2(v, h.u)
                    out.append(RailHole(side: side, line: line, index: i, point: Homography.apply(H, l), detected: h.det))
                }
            }
        }
        return out
    }

    /// 一排的點 → 整數位置上的孔（含推算的），依 k 遞增。
    private static func fitRow(_ p: [(u: Double, d: Double)], minCount: Int)
        -> [(k: Int, u: Double, d: Double, det: Bool)]? {
        guard p.count >= minCount else { return nil }
        // d = a + b·u（最小平方）
        let n = Double(p.count)
        let su = p.reduce(0) { $0 + $1.u }, sd = p.reduce(0) { $0 + $1.d }
        let suu = p.reduce(0) { $0 + $1.u * $1.u }, sud = p.reduce(0) { $0 + $1.u * $1.d }
        let den = n * suu - su * su
        let b = abs(den) > 1e-9 ? (n * sud - su * sd) / den : 0
        let a = (sd - b * su) / n
        // 欄方向相位：frac(u) 的圓平均
        var cs = 0.0, sn = 0.0
        for q in p { cs += cos(2 * .pi * q.u); sn += sin(2 * .pi * q.u) }
        let phase = atan2(sn, cs) / (2 * .pi)
        var K = Set<Int>()
        for q in p {
            let k = (q.u - phase).rounded()
            guard abs(q.u - phase - k) < 0.25, abs(q.d - (a + b * q.u)) < 0.25 else { continue }
            K.insert(Int(k))
        }
        guard K.count >= minCount, let kMin = K.min(), let kMax = K.max() else { return nil }

        // 「5 孔一組、空 1」：找空格落點最少的相位 g
        func mod6(_ x: Int) -> Int { ((x % 6) + 6) % 6 }
        var bestG = 0, bestHits = Int.max
        for g in 0..<6 {
            let hits = K.reduce(0) { mod6($1 - g) == 5 ? $0 + 1 : $0 }
            if hits < bestHits { bestHits = hits; bestG = g }
        }
        let gapped = Double(bestHits) <= Double(K.count) * 0.08 && K.count >= 10
        var lo = kMin, hi = kMax
        if gapped {
            while mod6(lo - bestG) != 0 { lo -= 1 }      // 補到整組開頭
            while mod6(hi - bestG) != 4 { hi += 1 }      // 補到整組結尾
        }
        var holes: [(k: Int, u: Double, d: Double, det: Bool)] = []
        for k in lo...hi where !gapped || mod6(k - bestG) != 5 {
            let u = phase + Double(k)
            holes.append((k, u, a + b * u, K.contains(k)))
        }
        return holes
    }
}

extension BreadboardResult {
    /// 換掉電源軌（其他欄位不變）。
    func with(rails: [RailHole]) -> BreadboardResult {
        var r = self
        r.rails = rails
        return r
    }
}
