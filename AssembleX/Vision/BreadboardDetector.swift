import Foundation
import simd

// 麵包板孔位偵測（純 Swift，無 OpenCV）。
//
// 流程（參考 Fontaine-bleau/Breadboard-Vision 的「找孔 → 擬合規則格點」思路，改寫成可在 iPhone 即時跑的版本）：
//   1. 局部自適應門檻：比周圍暗一定比例的像素 → 暗點遮罩
//   2. 連通元件 → 依大小、長寬比、填滿率留下「像孔」的小方塊
//   3. 最近鄰位移 → 估計孔距 pitch 與兩個格點方向（容許透視）
//   4. 從鄰居一路 BFS 給每個孔整數格點座標 (a, b)
//   5. 以最大連通塊擬合單應矩陣 H（格點 → 影像），再把其他孔（跨過中央溝槽）併入、反覆重擬合
//   6. 找「5 列 + 溝槽 + 5 列」的列樣式 → A–J；欄數 → 1…N（830 孔板 63 欄、400 孔板 30 欄）
//   7. 用 H 推算所有孔位置（被元件擋住的孔也補上），回傳信心度
//
// 已知限制：電源軌常和主格點錯開半格，目前只標主區 A–J；
//          麵包板 180° 對稱，A/J 與 1/N 方向無法只靠孔判斷（預設 A 在上、1 在左，可由使用者翻轉）。

struct GrayImage {
    let width: Int
    let height: Int
    var pixels: [UInt8]
}

struct BreadboardHole {
    let row: Int          // 0…9 → A…J
    let col: Int          // 0…cols-1 → 1…cols
    let point: SIMD2<Double>
    let detected: Bool    // true＝影像中真的看到孔；false＝由格點推算（可能被元件擋住）

    var name: String { BreadboardResult.rowLetters[row] + String(col + 1) }
}

struct BreadboardResult {
    static let rowLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]

    let imageWidth: Int
    let imageHeight: Int
    let cols: Int
    let holes: [BreadboardHole]           // row-major：holes[row * cols + col]
    let pitch: Double                     // 影像中平均孔距（px）
    let detectedRatio: Double             // 主區孔被實際看到的比例
    let meanResidual: Double              // 孔位擬合殘差（格點單位，越小越準）
    let outline: [SIMD2<Double>]          // 主區四角（A1 外角起順時針）
    let rowAxis: [SIMD2<Double>]          // 每列左側標字位置
    let colAxis: [SIMD2<Double>]          // 每欄上方標字位置
    var rails: [RailHole] = []            // 電源軌孔（A 側、J 側各最多兩排；見 BreadboardRails.swift）

    var boardKind: String {
        switch cols {
        case 63: return "830 孔"
        case 30: return "400 孔"
        case 17: return "170 孔"
        default: return "\(cols) 欄"
        }
    }

    /// 足以給出明確孔位的門檻；不夠時 UI 要顯示「請重新對準」而不是硬標孔。
    var isReliable: Bool { detectedRatio >= 0.25 && meanResidual < 0.12 && cols >= 10 }

    func hole(row: Int, col: Int) -> BreadboardHole? {
        guard row >= 0, row < 10, col >= 0, col < cols else { return nil }
        return holes[row * cols + col]
    }

    /// 解析 "A5"、"j10" 這類孔名。
    func hole(named raw: String) -> BreadboardHole? {
        let s = raw.trimmingCharacters(in: .whitespaces).uppercased()
        guard let first = s.first, let r = BreadboardResult.rowLetters.firstIndex(of: String(first)),
              let c = Int(s.dropFirst()) else { return nil }
        return hole(row: r, col: c - 1)
    }

    func nearestHole(to p: SIMD2<Double>, maxDistance: Double) -> BreadboardHole? {
        var best: BreadboardHole?
        var bestD = maxDistance
        for h in holes {
            let d = simd_distance(h.point, p)
            if d < bestD { bestD = d; best = h }
        }
        return best
    }
}

enum BreadboardDetection {
    case found(BreadboardResult, candidates: [SIMD2<Double>])
    case notFound(reason: String, candidates: [SIMD2<Double>])
}

final class BreadboardDetector {
    struct Params {
        var darkPercent = 14          // 比局部平均暗多少 % 算暗點
        var minLocalMean = 70         // 局部平均太暗（背景、陰影）就不找孔
        var minArea = 3
        var maxCandidates = 6000
        var debug = false
        /// 尺度參考邊長（px）：nil＝用影像短邊。裁切後的小圖要沿用原圖短邊，孔的大小判斷才一致。
        var scaleReference: Int?
    }

    var params = Params()

    // MARK: - 主流程

    func detect(_ img: GrayImage, flip: Bool = false) -> BreadboardDetection {
        let blobs = findBlobs(img)
        let pts = blobs.map { SIMD2<Double>($0.x, $0.y) }
        guard blobs.count >= 40 else {
            return .notFound(reason: "看不到足夠的孔（\(blobs.count)）", candidates: pts)
        }

        let minDim = Double(params.scaleReference ?? min(img.width, img.height))
        let hash = SpatialHash(points: pts, cell: max(16, minDim / 13))
        let knn = pts.indices.map { hash.neighbors(of: $0, k: 12) }

        // 孔距：最近鄰距離的中位數
        let nn1 = knn.compactMap { $0.first?.dist }
        guard nn1.count > 20 else { return .notFound(reason: "孔太少", candidates: pts) }
        let pitch = median(nn1)

        guard let (u0, v0) = estimateBasis(pts: pts, knn: knn, pitch: pitch) else {
            return .notFound(reason: "找不到格點方向", candidates: pts)
        }

        // 只保留和格點孔大小相近的候選（過濾印刷字、雜點）
        var latticeAreas: [Double] = []
        for i in knn.indices where !knn[i].isEmpty && knn[i][0].dist < pitch * 1.3 {
            latticeAreas.append(Double(blobs[i].area))
        }
        let areaMed = median(latticeAreas)
        let sizeOK = blobs.map { Double($0.area) >= areaMed * 0.3 && Double($0.area) <= areaMed * 3.0 }

        // BFS 標格點座標，取最大連通塊
        let comps = labelLattice(pts: pts, knn: knn, maxStep: max(simd_length(u0), simd_length(v0)) * 1.45,
                                 u0: u0, v0: v0, allowed: sizeOK)
        // 溝槽兩側、被元件切開的區塊各自連通；用整數平移把它們併成同一套座標
        let comp = mergeComponents(comps, pts: pts, pitch: pitch)
        if params.debug {
            let cs = comp.keys.map { latticeCoords($0) }
            print("  [dbg] comps=\(comps.prefix(6).map { $0.count })")
            print("  [dbg] pitch=\(pitch) u0=\(u0) v0=\(v0) comp=\(comp.count) a=\(cs.map{$0.0}.min() ?? 0)…\(cs.map{$0.0}.max() ?? 0) b=\(cs.map{$0.1}.min() ?? 0)…\(cs.map{$0.1}.max() ?? 0)")
        }
        guard comp.count >= 30 else {
            return .notFound(reason: "格點太小（\(comp.count)）", candidates: pts)
        }

        // 擬合 H，並把溝槽另一側等其他孔併入
        var assigned = comp
        var H = Homography.fit(assigned.map { (latticePoint($0.key), pts[$0.value]) })
        guard H != nil else { return .notFound(reason: "格點擬合失敗", candidates: pts) }
        var residual = 1.0
        for iter in 0..<5 {
            guard var h = H else { break }
            // 格點基底化簡：同一組孔可用 (u, v) 或 (u, v±u) 描述，後者讓每列錯一欄。
            // 取影像中最短的兩個方向（真正的行、列方向），把整數座標換過去。
            if iter == 2, let (reassigned, refit) = reduceBasis(assigned, H: h, pts: pts) {
                assigned = reassigned; h = refit
            }
            let inv = h.inverse
            var best: [Int64: (idx: Int, res: Double)] = [:]
            var resSum = 0.0
            for i in pts.indices where sizeOK[i] {
                let q = Homography.apply(inv, pts[i])
                let r = q.rounded(.toNearestOrAwayFromZero)
                let res = max(abs(q.x - r.x), abs(q.y - r.y))
                guard res < 0.24 else { continue }
                let key = latticeKey(Int(r.x), Int(r.y))
                if let old = best[key], old.res <= res { continue }
                best[key] = (i, res)
            }
            assigned = best.mapValues { $0.idx }
            resSum = best.values.reduce(0) { $0 + $1.res }
            residual = best.isEmpty ? 1 : resSum / Double(best.count)
            H = Homography.fit(assigned.map { (latticePoint($0.key), pts[$0.value]) })
        }
        guard let Hfinal = H, assigned.count >= 40 else {
            return .notFound(reason: "格點擬合失敗", candidates: pts)
        }

        // 長軸＝欄（1…N），短軸＝列（A…J）
        let keys = assigned.keys.map { latticeCoords($0) }
        let aSpan = (keys.map { $0.0 }.max()! - keys.map { $0.0 }.min()!)
        let bSpan = (keys.map { $0.1 }.max()! - keys.map { $0.1 }.min()!)
        let colIsA = aSpan >= bSpan
        func split(_ k: (Int, Int)) -> (col: Int, row: Int) { colIsA ? (k.0, k.1) : (k.1, k.0) }

        // 列樣式：5 列 + 溝槽（2 或 3 個空列）+ 5 列
        var rowCount: [Int: Int] = [:]
        for k in keys { rowCount[split(k).row, default: 0] += 1 }
        if params.debug {
            print("  [dbg] assigned=\(assigned.count) resid=\(residual) colIsA=\(colIsA) rows=" +
                  rowCount.keys.sorted().map { "\($0):\(rowCount[$0]!)" }.joined(separator: " "))
        }
        guard let rowLattice = findTerminalRows(rowCount) else {
            return .notFound(reason: "看不到完整 A–J 十列，請讓整塊板子入鏡", candidates: pts)
        }
        let rowSet = Set(rowLattice)

        // 欄範圍：主區十列中至少有 2 個孔的欄
        var colCount: [Int: Int] = [:]
        for k in keys {
            let s = split(k)
            if rowSet.contains(s.row) { colCount[s.col, default: 0] += 1 }
        }
        var colsLattice = colCount.filter { $0.value >= 2 }.keys.sorted()
        guard var cMin = colsLattice.first, var cMax = colsLattice.last else {
            return .notFound(reason: "找不到欄", candidates: pts)
        }
        // 貼齊常見板型（兩端多出來的通常是印刷字母）
        for target in [63, 30, 17] {
            let n = cMax - cMin + 1
            if n > target && n <= target + 4 {
                var lo = cMin, hi = cMax
                while hi - lo + 1 > target {
                    if colCount[lo, default: 0] <= colCount[hi, default: 0] { lo += 1 } else { hi -= 1 }
                }
                cMin = lo; cMax = hi
            }
        }
        colsLattice = Array(cMin...cMax)
        let nCols = colsLattice.count
        guard nCols >= 5 else { return .notFound(reason: "欄數太少", candidates: pts) }

        // 方向：欄往右（或往下）遞增，列往下（或往右）遞增；flip＝整塊轉 180°
        func lat(_ row: Int, _ col: Int) -> SIMD2<Double> {
            let r = rowLattice[row], c = colsLattice[col]
            return colIsA ? SIMD2(Double(c), Double(r)) : SIMD2(Double(r), Double(c))
        }
        func toImage(_ l: SIMD2<Double>) -> SIMD2<Double> { Homography.apply(Hfinal, l) }
        let colDir = toImage(lat(0, nCols - 1)) - toImage(lat(0, 0))
        let rowDir = toImage(lat(9, 0)) - toImage(lat(0, 0))
        var reverseCols: Bool
        var reverseRows: Bool
        if abs(colDir.x) >= abs(colDir.y) {
            reverseCols = colDir.x < 0
            reverseRows = rowDir.y < 0
        } else {
            reverseCols = colDir.y < 0
            reverseRows = rowDir.x > 0   // 直放時 A 在右側：等於橫放順時針轉 90°
        }
        if flip { reverseCols.toggle(); reverseRows.toggle() }

        func latFor(row: Int, col: Int) -> SIMD2<Double> {
            lat(reverseRows ? 9 - row : row, reverseCols ? nCols - 1 - col : col)
        }

        var holes: [BreadboardHole] = []
        holes.reserveCapacity(10 * nCols)
        var seen = 0
        for r in 0..<10 {
            for c in 0..<nCols {
                let l = latFor(row: r, col: c)
                let key = latticeKey(Int(l.x), Int(l.y))
                let detected = assigned[key] != nil
                if detected { seen += 1 }
                holes.append(BreadboardHole(row: r, col: c, point: toImage(l), detected: detected))
            }
        }

        // 外框與標字位置（格點座標外推半格／一格）
        func latOffset(row: Double, col: Double) -> SIMD2<Double> {
            // 任意 (row, col) 的格點座標；溝槽讓列不等距，所以先取最近的整數列再外推
            let base = latFor(row: 0, col: 0)
            let dc = latFor(row: 0, col: min(1, nCols - 1)) - base
            let dr = latFor(row: 1, col: 0) - base
            let r0 = Int(row.rounded(.down)).clamped(0, 9)
            let rowBase = latFor(row: r0, col: 0) + dr * (row - Double(r0))
            return toImage(rowBase + dc * col)
        }
        let outline = [
            latOffset(row: -0.5, col: -0.5), latOffset(row: -0.5, col: Double(nCols) - 0.5),
            latOffset(row: 9.5, col: Double(nCols) - 0.5), latOffset(row: 9.5, col: -0.5),
        ]
        let rowAxis = (0..<10).map { latOffset(row: Double($0), col: -1.2) }
        let colAxis = (0..<nCols).map { latOffset(row: -1.2, col: Double($0)) }

        // 電源軌：主區外側另找（錯開半格、5 孔一組，主區格點擬合時被當雜點丟掉）
        let rails = RailDetector.detect(pts: pts, allowed: sizeOK, H: Hfinal, colIsA: colIsA,
                                        rowLattice: rowLattice, colsLattice: colsLattice,
                                        reverseRows: reverseRows, reverseCols: reverseCols, debug: params.debug)

        let result = BreadboardResult(
            imageWidth: img.width, imageHeight: img.height, cols: nCols, holes: holes,
            pitch: pitch, detectedRatio: Double(seen) / Double(10 * nCols),
            meanResidual: residual, outline: outline, rowAxis: rowAxis, colAxis: colAxis, rails: rails)
        return .found(result, candidates: pts)
    }

    // MARK: - 1–2. 暗點與連通元件

    struct Blob { var x: Double; var y: Double; var area: Int }

    func findBlobs(_ img: GrayImage) -> [Blob] {
        let w = img.width, h = img.height
        let minDim = params.scaleReference ?? min(w, h)
        let r = max(4, minDim / 90)                // 視窗半徑
        let maxSide = max(6, minDim / 28)
        let maxArea = maxSide * maxSide
        let stride1 = w + 1
        var integral = [UInt32](repeating: 0, count: (w + 1) * (h + 1))
        var mask = [UInt8](repeating: 0, count: w * h)
        let darkK = 100 - params.darkPercent
        let minMean = params.minLocalMean

        img.pixels.withUnsafeBufferPointer { px in
            integral.withUnsafeMutableBufferPointer { ii in
                for y in 0..<h {
                    var rowSum: UInt32 = 0
                    let base = y * w, ib = (y + 1) * stride1, ip = y * stride1
                    for x in 0..<w {
                        rowSum &+= UInt32(px[base + x])
                        ii[ib + x + 1] = ii[ip + x + 1] &+ rowSum
                    }
                }
                mask.withUnsafeMutableBufferPointer { m in
                    for y in 0..<h {
                        let y0 = max(0, y - r), y1 = min(h - 1, y + r)
                        let top = y0 * stride1, bot = (y1 + 1) * stride1
                        let rows = y1 - y0 + 1
                        for x in 0..<w {
                            let x0 = max(0, x - r), x1 = min(w - 1, x + r)
                            let sum = Int(ii[bot + x1 + 1]) - Int(ii[top + x1 + 1]) - Int(ii[bot + x0]) + Int(ii[top + x0])
                            let cnt = rows * (x1 - x0 + 1)
                            let v = Int(px[y * w + x])
                            if sum >= minMean * cnt && v * cnt * 100 < sum * darkK { m[y * w + x] = 1 }
                        }
                    }
                }
            }
        }

        var blobs: [Blob] = []
        var stack: [Int] = []
        stack.reserveCapacity(4096)
        mask.withUnsafeMutableBufferPointer { m in
            for start in 0..<(w * h) where m[start] == 1 {
                m[start] = 2
                stack.append(start)
                var area = 0, sx = 0, sy = 0
                var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0
                while let p = stack.popLast() {
                    let x = p % w, y = p / w
                    area += 1; sx += x; sy += y
                    if x < minX { minX = x }; if x > maxX { maxX = x }
                    if y < minY { minY = y }; if y > maxY { maxY = y }
                    if x > 0, m[p - 1] == 1 { m[p - 1] = 2; stack.append(p - 1) }
                    if x < w - 1, m[p + 1] == 1 { m[p + 1] = 2; stack.append(p + 1) }
                    if y > 0, m[p - w] == 1 { m[p - w] = 2; stack.append(p - w) }
                    if y < h - 1, m[p + w] == 1 { m[p + w] = 2; stack.append(p + w) }
                }
                let bw = maxX - minX + 1, bh = maxY - minY + 1
                guard area >= params.minArea, area <= maxArea, bw <= maxSide, bh <= maxSide else { continue }
                guard max(bw, bh) <= 2 * min(bw, bh) + 1 else { continue }
                guard Double(area) >= 0.35 * Double(bw * bh) else { continue }
                blobs.append(Blob(x: Double(sx) / Double(area) + 0.5, y: Double(sy) / Double(area) + 0.5, area: area))
                if blobs.count >= params.maxCandidates { return }
            }
        }
        return blobs
    }

    // MARK: - 3. 格點方向

    private func estimateBasis(pts: [SIMD2<Double>], knn: [[SpatialHash.Neighbor]], pitch: Double)
        -> (SIMD2<Double>, SIMD2<Double>)? {
        // 每個孔取：最近鄰（第一軸）＋方向差 ≥ 30° 的最近鄰（第二軸）。
        // 對任何（含透視壓扁的）格點，這兩個都是軸向鄰居，不會取到對角線。
        var hist = [Double](repeating: 0, count: 180)
        var vecs: [SIMD2<Double>] = []
        func add(_ raw: SIMD2<Double>) {
            var d = raw
            if d.y < 0 || (d.y == 0 && d.x < 0) { d = -d }      // 角度收到 [0, π)
            vecs.append(d)
            let deg = Int((atan2(d.y, d.x) * 180 / .pi).rounded()) % 180
            hist[(deg + 180) % 180] += 1
        }
        for i in pts.indices {
            guard let n1 = knn[i].first, n1.dist < pitch * 1.5 else { continue }
            let d1 = pts[n1.index] - pts[i]
            add(d1)
            for n in knn[i].dropFirst() where n.dist < n1.dist * 2.2 {
                let d = pts[n.index] - pts[i]
                let c = abs(simd_dot(d, d1)) / (simd_length(d) * simd_length(d1))
                if c < cos(30 * .pi / 180) { add(d); break }
            }
        }
        guard vecs.count > 40 else { return nil }
        var smooth = hist
        for i in 0..<180 {
            var s = 0.0
            for k in -3...3 { s += hist[(i + k + 180) % 180] }
            smooth[i] = s
        }
        let p1 = smooth.indices.max { smooth[$0] < smooth[$1] }!
        func angDist(_ a: Int, _ b: Int) -> Int { let d = abs(a - b) % 180; return min(d, 180 - d) }
        // 第二軸在強透視下角度會散開，用較寬的窗找峰值
        var wide = hist
        for i in 0..<180 {
            var s = 0.0
            for k in -10...10 { s += hist[(i + k + 180) % 180] }
            wide[i] = s
        }
        guard let p2 = wide.indices.filter({ angDist($0, p1) >= 30 }).max(by: { wide[$0] < wide[$1] }),
              wide[p2] > wide[p1] * 0.08 else { return nil }

        func meanVec(_ peak: Int) -> SIMD2<Double>? {
            let ref = SIMD2(cos(Double(peak) * .pi / 180), sin(Double(peak) * .pi / 180))
            var sum = SIMD2<Double>(0, 0), n = 0.0
            for v in vecs {
                let len = simd_length(v)
                let c = simd_dot(v / len, ref)
                if abs(c) > cos(12 * .pi / 180) { sum += c > 0 ? v : -v; n += 1 }
            }
            return n > 5 ? sum / n : nil
        }
        guard let u = meanVec(p1), let v = meanVec(p2) else { return nil }
        return (u, v)
    }

    // MARK: - 4. BFS 標格點

    private func labelLattice(pts: [SIMD2<Double>], knn: [[SpatialHash.Neighbor]], maxStep: Double,
                              u0: SIMD2<Double>, v0: SIMD2<Double>, allowed: [Bool]) -> [[Int64: Int]] {
        var visited = [Bool](repeating: false, count: pts.count)
        var comps: [[Int64: Int]] = []
        for seed in pts.indices where !visited[seed] && allowed[seed] {
            var comp: [Int64: Int] = [:]
            var coord: [Int: (Int, Int)] = [seed: (0, 0)]
            guard let local = localBasis(seed, pts: pts, knn: knn, u0: u0, v0: v0, maxStep: maxStep) else { continue }
            var basis: [Int: (SIMD2<Double>, SIMD2<Double>)] = [seed: local]
            var queue = [seed]
            visited[seed] = true
            comp[latticeKey(0, 0)] = seed
            var qi = 0
            while qi < queue.count {
                let a = queue[qi]; qi += 1
                let (ca, cb) = coord[a]!
                let (ua, va) = basis[a]!
                let det = ua.x * va.y - ua.y * va.x
                guard abs(det) > 1e-6 else { continue }
                for n in knn[a] where n.dist < maxStep && allowed[n.index] && !visited[n.index] {
                    let d = pts[n.index] - pts[a]
                    let x = (d.x * va.y - d.y * va.x) / det
                    let y = (ua.x * d.y - ua.y * d.x) / det
                    let rx = x.rounded(), ry = y.rounded()
                    guard abs(rx) + abs(ry) == 1, abs(x - rx) < 0.3, abs(y - ry) < 0.3 else { continue }
                    let nc = (ca + Int(rx), cb + Int(ry))
                    let key = latticeKey(nc.0, nc.1)
                    guard comp[key] == nil else { continue }
                    visited[n.index] = true
                    comp[key] = n.index
                    coord[n.index] = nc
                    if rx != 0 {
                        let nu: SIMD2<Double> = (ua + d * rx) * 0.5
                        basis[n.index] = reduced(nu, va)
                    } else {
                        let nv: SIMD2<Double> = (va + d * ry) * 0.5
                        basis[n.index] = reduced(ua, nv)
                    }
                    queue.append(n.index)
                }
            }
            // 只接受兩個方向都有展開的塊（單一列無法擬合 H）
            let cs = comp.keys.map { latticeCoords($0) }
            let spanA = (cs.map { $0.0 }.max() ?? 0) - (cs.map { $0.0 }.min() ?? 0)
            let spanB = (cs.map { $0.1 }.max() ?? 0) - (cs.map { $0.1 }.min() ?? 0)
            if spanA >= 2, spanB >= 2, comp.count >= 12 { comps.append(comp) }
        }
        return comps.sorted { $0.count > $1.count }
    }

    /// 依大小把其他連通塊併進主塊：試各種整數平移，取「合起來仍符合同一個單應矩陣」殘差最小者。
    private func mergeComponents(_ comps: [[Int64: Int]], pts: [SIMD2<Double>], pitch: Double) -> [Int64: Int] {
        guard var main = comps.first else { return [:] }
        func residual(_ set: [Int64: Int]) -> Double? {
            let pairs = set.map { (latticePoint($0.key), pts[$0.value]) }
            guard let H = Homography.fit(pairs) else { return nil }
            var e = [Double]()
            e.reserveCapacity(pairs.count)
            for (l, p) in pairs { e.append(simd_distance(Homography.apply(H, l), p)) }
            return median(e) / pitch
        }
        for other in comps.dropFirst().prefix(8) {
            guard let Hm = Homography.fit(main.map { (latticePoint($0.key), pts[$0.value]) }) else { break }
            // 用主塊外推估計平移的起點
            let inv = Hm.inverse
            var dx = [Double](), dy = [Double]()
            for (k, idx) in other {
                let q = Homography.apply(inv, pts[idx])
                let c = latticePoint(k)
                dx.append(q.x - c.x); dy.append(q.y - c.y)
            }
            let ex = Int(median(dx).rounded()), ey = Int(median(dy).rounded())
            var best: (res: Double, merged: [Int64: Int])?
            for oy in (ey - 2)...(ey + 2) {
                for ox in (ex - 2)...(ex + 2) {
                    var merged = main
                    var clash = 0
                    for (k, idx) in other {
                        let (a, b) = latticeCoords(k)
                        let nk = latticeKey(a + ox, b + oy)
                        if merged[nk] != nil { clash += 1 } else { merged[nk] = idx }
                    }
                    guard clash <= other.count / 10, let r = residual(merged) else { continue }
                    if best == nil || r < best!.res { best = (r, merged) }
                }
            }
            if let b = best, b.res < 0.12 { main = b.merged }
        }
        return main
    }

    private func reduceBasis(_ assigned: [Int64: Int], H: simd_double3x3, pts: [SIMD2<Double>])
        -> ([Int64: Int], simd_double3x3)? {
        let cs = assigned.keys.map { latticeCoords($0) }
        let c = SIMD2(Double(cs.map { $0.0 }.reduce(0, +)) / Double(cs.count),
                      Double(cs.map { $0.1 }.reduce(0, +)) / Double(cs.count))
        let p0 = Homography.apply(H, c)
        func step(_ m: (Int, Int)) -> SIMD2<Double> { Homography.apply(H, c + SIMD2(Double(m.0), Double(m.1))) - p0 }
        // Gauss 化簡，追蹤整數基底（以舊座標表示）
        var bu = (1, 0), bv = (0, 1)
        for _ in 0..<10 {
            if simd_length(step(bu)) > simd_length(step(bv)) { swap(&bu, &bv) }
            let su = step(bu), sv = step(bv)
            let m = Int((simd_dot(su, sv) / simd_dot(su, su)).rounded())
            if m == 0 { break }
            bv = (bv.0 - m * bu.0, bv.1 - m * bu.1)
        }
        // 新座標 (a', b')：舊 = a'·bu + b'·bv，解 2×2 整數反矩陣
        let det = bu.0 * bv.1 - bv.0 * bu.1
        guard abs(det) == 1 else { return nil }
        if bu == (1, 0) && bv == (0, 1) { return nil }
        var out: [Int64: Int] = [:]
        for (k, idx) in assigned {
            let (a, b) = latticeCoords(k)
            let na = (a * bv.1 - b * bv.0) * det
            let nb = (b * bu.0 - a * bu.1) * det
            out[latticeKey(na, nb)] = idx
        }
        guard let refit = Homography.fit(out.map { (latticePoint($0.key), pts[$0.value]) }) else { return nil }
        return (out, refit)
    }

    /// 起點附近的實際格點方向：各取與全域方向最接近（30° 內）的鄰居位移。
    private func localBasis(_ i: Int, pts: [SIMD2<Double>], knn: [[SpatialHash.Neighbor]],
                            u0: SIMD2<Double>, v0: SIMD2<Double>, maxStep: Double) -> (SIMD2<Double>, SIMD2<Double>)? {
        func pick(_ ref: SIMD2<Double>) -> SIMD2<Double>? {
            let r = simd_normalize(ref)
            var best: (SIMD2<Double>, Double)?
            for n in knn[i] where n.dist < maxStep {
                let d = pts[n.index] - pts[i]
                let c = simd_dot(d, r) / simd_length(d)
                guard abs(c) > cos(30 * .pi / 180) else { continue }
                let len = simd_length(d)
                let lenOK = len > simd_length(ref) * 0.6 && len < simd_length(ref) * 1.5
                guard lenOK else { continue }
                if best == nil || abs(c) > best!.1 { best = (c > 0 ? d : -d, abs(c)) }
            }
            return best?.0
        }
        guard let u = pick(u0), let v = pick(v0) else { return nil }
        return reduced(u, v)
    }

    /// 讓 (u, v) 保持「最短」基底（不讓 v 變成 v±u 的對角方向），但不交換、不改變方向意義。
    private func reduced(_ u: SIMD2<Double>, _ v: SIMD2<Double>) -> (SIMD2<Double>, SIMD2<Double>) {
        var u = u, v = v
        for _ in 0..<3 {
            let mv = (simd_dot(u, v) / simd_dot(u, u)).rounded()
            if mv != 0 { v -= mv * u }
            let mu = (simd_dot(u, v) / simd_dot(v, v)).rounded()
            if mu != 0 { u -= mu * v }
            if mv == 0 && mu == 0 { break }
        }
        return (u, v)
    }

    // MARK: - 6. 列樣式

    private func findTerminalRows(_ count: [Int: Int]) -> [Int]? {
        guard let lo = count.keys.min(), let hi = count.keys.max(), let maxC = count.values.max() else { return nil }
        let strong = max(2, maxC / 4)
        var best: (score: Double, rows: [Int])?
        for t in (lo - 12)...(hi) {
            for gap in [2, 3] {
                let top = Array(t..<(t + 5))
                let bottom = Array((t + 5 + gap)..<(t + 10 + gap))
                let gapRows = Array((t + 5)..<(t + 5 + gap))
                let topOK = top.filter { count[$0, default: 0] >= strong }.count
                let botOK = bottom.filter { count[$0, default: 0] >= strong }.count
                guard topOK >= 3, botOK >= 3 else { continue }
                let s = Double((top + bottom).reduce(0) { $0 + count[$1, default: 0] })
                    - 1.5 * Double(gapRows.reduce(0) { $0 + count[$1, default: 0] })
                if best == nil || s > best!.score { best = (s, top + bottom) }
            }
        }
        return best?.rows
    }

    // MARK: - 小工具

    private func latticeKey(_ a: Int, _ b: Int) -> Int64 { (Int64(a) << 32) | Int64(UInt32(bitPattern: Int32(b))) }
    private func latticeCoords(_ k: Int64) -> (Int, Int) { (Int(k >> 32), Int(Int32(truncatingIfNeeded: k))) }
    private func latticePoint(_ k: Int64) -> SIMD2<Double> { let c = latticeCoords(k); return SIMD2(Double(c.0), Double(c.1)) }
}

// MARK: - 空間雜湊 kNN

struct SpatialHash {
    struct Neighbor { let index: Int; let dist: Double }
    let points: [SIMD2<Double>]
    let cell: Double
    private var buckets: [Int64: [Int]] = [:]

    init(points: [SIMD2<Double>], cell: Double) {
        self.points = points
        self.cell = cell
        for (i, p) in points.enumerated() { buckets[key(p), default: []].append(i) }
    }

    private func key(_ p: SIMD2<Double>) -> Int64 { key(Int(floor(p.x / cell)), Int(floor(p.y / cell))) }
    private func key(_ cx: Int, _ cy: Int) -> Int64 { (Int64(cx) << 32) | Int64(UInt32(bitPattern: Int32(cy))) }

    func neighbors(of i: Int, k: Int) -> [Neighbor] {
        let p = points[i]
        let cx = Int(floor(p.x / cell)), cy = Int(floor(p.y / cell))
        var out: [Neighbor] = []
        for dy in -1...1 {
            for dx in -1...1 {
                guard let b = buckets[key(cx + dx, cy + dy)] else { continue }
                for j in b where j != i {
                    let d = simd_distance(points[j], p)
                    if d <= cell { out.append(Neighbor(index: j, dist: d)) }
                }
            }
        }
        out.sort { $0.dist < $1.dist }
        return Array(out.prefix(k))
    }
}

// MARK: - 單應矩陣

enum Homography {
    static func apply(_ H: simd_double3x3, _ p: SIMD2<Double>) -> SIMD2<Double> {
        let v = H * SIMD3(p.x, p.y, 1)
        return SIMD2(v.x / v.z, v.y / v.z)
    }

    /// DLT（h33 = 1）＋ Hartley 正規化；pairs = (來源, 目標)。
    static func fit(_ pairs: [(SIMD2<Double>, SIMD2<Double>)]) -> simd_double3x3? {
        guard pairs.count >= 4 else { return nil }
        let (ts, src) = normalize(pairs.map { $0.0 })
        let (td, dst) = normalize(pairs.map { $0.1 })
        var ata = [[Double]](repeating: [Double](repeating: 0, count: 8), count: 8)
        var atb = [Double](repeating: 0, count: 8)
        for (s, d) in zip(src, dst) {
            let rows: [([Double], Double)] = [
                ([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x], d.x),
                ([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y], d.y),
            ]
            for (a, b) in rows {
                for i in 0..<8 {
                    atb[i] += a[i] * b
                    for j in 0..<8 { ata[i][j] += a[i] * a[j] }
                }
            }
        }
        guard let h = solve(ata, atb) else { return nil }
        let Hn = simd_double3x3(rows: [SIMD3(h[0], h[1], h[2]), SIMD3(h[3], h[4], h[5]), SIMD3(h[6], h[7], 1)])
        return td.inverse * Hn * ts
    }

    private static func normalize(_ pts: [SIMD2<Double>]) -> (simd_double3x3, [SIMD2<Double>]) {
        let c = pts.reduce(SIMD2<Double>(0, 0), +) / Double(pts.count)
        let meanD = pts.reduce(0.0) { $0 + simd_distance($1, c) } / Double(pts.count)
        let s = meanD > 1e-9 ? sqrt(2) / meanD : 1
        let T = simd_double3x3(rows: [SIMD3(s, 0, -s * c.x), SIMD3(0, s, -s * c.y), SIMD3(0, 0, 1)])
        return (T, pts.map { ($0 - c) * s })
    }

    private static func solve(_ A: [[Double]], _ b: [Double]) -> [Double]? {
        let n = b.count
        var m = A, v = b
        for col in 0..<n {
            guard let piv = (col..<n).max(by: { abs(m[$0][col]) < abs(m[$1][col]) }), abs(m[piv][col]) > 1e-12 else { return nil }
            m.swapAt(col, piv); v.swapAt(col, piv)
            for r in (col + 1)..<n {
                let f = m[r][col] / m[col][col]
                if f == 0 { continue }
                for c in col..<n { m[r][c] -= f * m[col][c] }
                v[r] -= f * v[col]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in stride(from: n - 1, through: 0, by: -1) {
            var s = v[r]
            for c in (r + 1)..<n { s -= m[r][c] * x[c] }
            x[r] = s / m[r][r]
        }
        return x
    }
}

// MARK: - helpers

private func median(_ a: [Double]) -> Double {
    guard !a.isEmpty else { return 0 }
    let s = a.sorted()
    return s[s.count / 2]
}

private extension Int {
    func clamped(_ lo: Int, _ hi: Int) -> Int { Swift.min(Swift.max(self, lo), hi) }
}
