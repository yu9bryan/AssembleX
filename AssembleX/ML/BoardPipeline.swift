import CoreGraphics
import Foundation
import simd

// AI 麵包板管線：YOLO-seg 粗遮罩 → RGB 顏色增強 → 直線擬合四邊形 → 板內孔位辨識。
//
//   1. 分割：BreadboardSegModel 給整塊板的粗遮罩（160 格原型，約 1/12 解析度，邊緣會糊）。
//   2. RGB 增強：在外擴的框內，用「縮小遮罩內＝板子」「放大遮罩外＝背景」各建一個 YCbCr 高斯色彩模型，
//      逐像素（1/4 解析度）重新分類，取和板子相連的最大塊並補洞（孔、元件）→ 邊緣貼緊真正的板子。
//   3. 直線增強：麵包板一定是長方體，影像中是四邊形。凸包簡化成四角，再對每邊的邊緣點做
//      去離群的整體最小平方直線擬合，相鄰兩線交點＝角點。
//   4. 孔位：四邊形 → 單應矩陣，把板子拉正成正面的長方形影像（去透視），在上面跑經典 BreadboardDetector，
//      結果再用單應矩陣映回原圖；拉正後格點應和長方形軸平行，偏太多就判為不可靠。

/// 1/4 解析度 YCbCr（相機給的 420f：Y 全解析度、CbCr 半解析度）。
struct QuarterYCbCr: Sendable {
    static let scale = 4
    let width: Int
    let height: Int
    var y: [UInt8]
    var cb: [UInt8]
    var cr: [UInt8]
}

struct BoardPipelineFrame: Sendable {
    var seg: SegInstance?
    /// RGB 增強後的遮罩（1/4 解析度、整張影像）；顏色模型不可信時為 nil，後面改用分割遮罩
    var refined: SegMask?
    var refinedIoU = 0.0                // 增強遮罩 vs 分割遮罩
    var quad: [SIMD2<Double>]?          // 直線擬合的四角（影像像素，左上起順時針）
    var lineRMS = 0.0                   // 邊緣點到擬合直線的均方根距離（px）
    var detection: BreadboardDetection?
    var latticeAngle = 0.0              // 格點和四邊形邊的夾角（度）
    var rectified = false               // 孔位是在拉正影像上找的（透視明顯時）
    var segMs = 0.0, rgbMs = 0.0, lineMs = 0.0, holeMs = 0.0
    var failure: String?

    var totalMs: Double { segMs + rgbMs + lineMs + holeMs }
    var found: Bool { detection?.isReliable ?? false }
}

final class BoardPipeline {
    let detector = BreadboardDetector()
    var maxLatticeAngle = 8.0           // 度
    /// 除錯：拿到拉正後的影像（Mac 測試工具用）
    var onRectified: ((GrayImage) -> Void)?

    /// seg 為已跑好的分割結果；gray 為 Y 平面；color 為 1/4 YCbCr。
    func run(seg: SegFrame, gray: GrayImage, color: QuarterYCbCr) -> BoardPipelineFrame {
        var out = BoardPipelineFrame()
        out.segMs = seg.milliseconds
        guard let board = seg.board else { out.failure = "AI 沒找到麵包板"; return out }
        out.seg = board
        let imageSize = CGSize(width: gray.width, height: gray.height)

        // 2. RGB 增強
        var t = CFAbsoluteTimeGetCurrent()
        let refined = refineByColor(board, color: color, imageSize: imageSize)
        out.refined = refined.mask
        out.refinedIoU = refined.iou
        out.rgbMs = (CFAbsoluteTimeGetCurrent() - t) * 1000

        // 3. 直線增強：邊緣點 → 四邊形
        t = CFAbsoluteTimeGetCurrent()
        let mask = refined.mask ?? Self.resample(board.mask, to: color.width, color.height)
        let edge = Self.edgePoints(mask)
        guard let fit = Self.fitQuad(edge) else {
            out.lineMs = (CFAbsoluteTimeGetCurrent() - t) * 1000
            out.failure = "板子邊緣擬合不出四邊形"
            return out
        }
        out.quad = fit.quad
        out.lineRMS = fit.rms
        out.lineMs = (CFAbsoluteTimeGetCurrent() - t) * 1000

        // 4. 拉正 → 經典孔位 → 映回
        t = CFAbsoluteTimeGetCurrent()
        // 透視明顯（角不是直角、對邊不等長）才拉正；正對時直接在原圖裁切，避免重取樣把暗淡的孔糊掉。
        // 先用的方法失敗就換另一種。
        let tilted = Self.perspectiveStrength(fit.quad) > 0.1
        var (det, angle) = tilted ? detectRectified(gray, quad: fit.quad) : detectCropped(gray, quad: fit.quad)
        out.rectified = tilted
        if !det.isReliable {
            let other = tilted ? detectCropped(gray, quad: fit.quad) : detectRectified(gray, quad: fit.quad)
            if other.0.isReliable { (det, angle) = other; out.rectified = !tilted }
        }
        out.detection = det
        out.latticeAngle = angle
        out.holeMs = (CFAbsoluteTimeGetCurrent() - t) * 1000
        return out
    }

    // MARK: - 2. RGB 顏色增強

    private struct Gauss {
        var mean = SIMD3<Double>(0, 0, 0)
        var inv = simd_double3x3(1)
        var logDet = 0.0
        init?(_ s: [SIMD3<Double>]) {
            guard s.count >= 30 else { return nil }
            mean = s.reduce(SIMD3<Double>(0, 0, 0), +) / Double(s.count)
            var c = simd_double3x3(0)
            for v in s { let d = v - mean; c += simd_double3x3(columns: (d * d.x, d * d.y, d * d.z)) }
            c = c * (1 / Double(s.count))
            c += simd_double3x3(diagonal: SIMD3(16, 9, 9))       // 正則化：避免單色區域變奇異
            inv = c.inverse
            logDet = log(max(1e-9, c.determinant))
        }
        @inline(__always) func cost(_ v: SIMD3<Double>) -> Double {
            let d = v - mean
            return simd_dot(d, inv * d) + logDet
        }
    }

    private func refineByColor(_ board: SegInstance, color: QuarterYCbCr, imageSize: CGSize) -> (mask: SegMask?, iou: Double) {
        let W = color.width, H = color.height, sc = Double(QuarterYCbCr.scale)
        let seg = Self.resample(board.mask, to: W, H)
        // 工作範圍：框外擴 12%
        let bx = board.box.insetBy(dx: -board.box.width * 0.12, dy: -board.box.height * 0.12)
        let x0 = max(0, Int(bx.minX / sc)), y0 = max(0, Int(bx.minY / sc))
        let x1 = min(W, Int(bx.maxX / sc) + 1), y1 = min(H, Int(bx.maxY / sc) + 1)
        guard x1 - x0 > 8, y1 - y0 > 8 else { return (nil, 0) }
        // 腐蝕／膨脹半徑：板子短邊的 6%
        let r = max(2, Int(min(board.box.width, board.box.height) / sc * 0.06))
        @inline(__always) func segAt(_ x: Int, _ y: Int) -> Bool {
            x >= 0 && y >= 0 && x < W && y < H && seg.bits[y * W + x] != 0
        }
        @inline(__always) func px(_ i: Int) -> SIMD3<Double> {
            SIMD3(Double(color.y[i]), Double(color.cb[i]), Double(color.cr[i]))
        }
        var fgS: [SIMD3<Double>] = [], bgS: [SIMD3<Double>] = []
        let step = max(1, Int(sqrt(Double((x1 - x0) * (y1 - y0)) / 4000)))    // 取樣約 4000 點
        for y in stride(from: y0, to: y1, by: step) {
            for x in stride(from: x0, to: x1, by: step) {
                let c = segAt(x, y), n = [segAt(x - r, y), segAt(x + r, y), segAt(x, y - r), segAt(x, y + r)]
                if c && !n.contains(false) { fgS.append(px(y * W + x)) }
                else if !c && !n.contains(true) { bgS.append(px(y * W + x)) }
            }
        }
        guard let fg = Gauss(fgS), let bg = Gauss(bgS) else { return (nil, 0) }

        // 分類（只在工作範圍內）
        var cls = [UInt8](repeating: 0, count: W * H)
        for y in y0..<y1 {
            for x in x0..<x1 {
                let i = y * W + x
                let v = px(i)
                if fg.cost(v) < bg.cost(v) { cls[i] = 1 }
            }
        }
        // 和板子相連的最大塊：從縮小遮罩內的像素開始長
        var seen = [UInt8](repeating: 0, count: W * H)
        var bestComp: [Int] = [], stack: [Int] = []
        for y in y0..<y1 {
            for x in x0..<x1 {
                let s = y * W + x
                guard cls[s] == 1, seen[s] == 0, segAt(x, y) else { continue }
                var comp: [Int] = []
                seen[s] = 1; stack.append(s)
                while let p = stack.popLast() {
                    comp.append(p)
                    let px0 = p % W, py0 = p / W
                    for (nx, ny) in [(px0 - 1, py0), (px0 + 1, py0), (px0, py0 - 1), (px0, py0 + 1)]
                    where nx >= x0 && nx < x1 && ny >= y0 && ny < y1 {
                        let q = ny * W + nx
                        if cls[q] == 1 && seen[q] == 0 { seen[q] = 1; stack.append(q) }
                    }
                }
                if comp.count > bestComp.count { bestComp = comp }
            }
        }
        guard !bestComp.isEmpty else { return (nil, 0) }
        var bits = [UInt8](repeating: 0, count: W * H)
        for p in bestComp { bits[p] = 1 }
        // 補洞：從工作範圍邊界淹水，淹不到的非板子像素（孔、元件、線）都算板子
        var outside = [UInt8](repeating: 0, count: W * H)
        for y in y0..<y1 {
            for x in x0..<x1 where (x == x0 || x == x1 - 1 || y == y0 || y == y1 - 1) {
                let s = y * W + x
                if bits[s] == 0 && outside[s] == 0 { outside[s] = 1; stack.append(s) }
            }
        }
        while let p = stack.popLast() {
            let px0 = p % W, py0 = p / W
            for (nx, ny) in [(px0 - 1, py0), (px0 + 1, py0), (px0, py0 - 1), (px0, py0 + 1)]
            where nx >= x0 && nx < x1 && ny >= y0 && ny < y1 {
                let q = ny * W + nx
                if bits[q] == 0 && outside[q] == 0 { outside[q] = 1; stack.append(q) }
            }
        }
        var inter = 0, uni = 0
        for y in y0..<y1 {
            for x in x0..<x1 {
                let i = y * W + x
                if outside[i] == 0 { bits[i] = 1 }
                let a = bits[i] != 0, b = seg.bits[i] != 0
                if a && b { inter += 1 }
                if a || b { uni += 1 }
            }
        }
        // 也算工作範圍外的分割遮罩（理論上沒有）
        let iou = Double(inter) / Double(max(1, uni))
        // 顏色模型失敗（例如白桌面＋白板子）時，增強結果和分割差很多 → 不採用
        guard iou > 0.7 else { return (nil, iou) }
        return (SegMask(width: W, height: H, bits: bits), iou)
    }

    /// 最近鄰重取樣遮罩（兩者都覆蓋整張影像）。
    static func resample(_ m: SegMask, to W: Int, _ H: Int) -> SegMask {
        var bits = [UInt8](repeating: 0, count: W * H)
        for y in 0..<H {
            let sy = min(m.height - 1, y * m.height / H)
            for x in 0..<W {
                bits[y * W + x] = m.bits[sy * m.width + min(m.width - 1, x * m.width / W)]
            }
        }
        return SegMask(width: W, height: H, bits: bits)
    }

    // MARK: - 3. 直線增強

    /// 遮罩邊界點（影像像素；格子中心）。
    static func edgePoints(_ m: SegMask) -> [SIMD2<Double>] {
        let W = m.width, H = m.height, sc = Double(QuarterYCbCr.scale)
        var pts: [SIMD2<Double>] = []
        for y in 0..<H {
            for x in 0..<W where m.bits[y * W + x] != 0 {
                let edge = x == 0 || y == 0 || x == W - 1 || y == H - 1 ||
                    m.bits[y * W + x - 1] == 0 || m.bits[y * W + x + 1] == 0 ||
                    m.bits[(y - 1) * W + x] == 0 || m.bits[(y + 1) * W + x] == 0
                if edge { pts.append(SIMD2((Double(x) + 0.5) * sc, (Double(y) + 0.5) * sc)) }
            }
        }
        return pts
    }

    /// 邊緣點 → 四邊形（左上起順時針）＋直線擬合殘差。
    static func fitQuad(_ edge: [SIMD2<Double>]) -> (quad: [SIMD2<Double>], rms: Double)? {
        guard edge.count >= 40 else { return nil }
        var hull = BreadboardSegModel.convexHull(edge)
        guard hull.count >= 4 else { return nil }
        // 凸包簡化：反覆刪掉「刪了損失面積最小」的頂點，剩 4 個
        while hull.count > 4 {
            var best = 0, bestLoss = Double.infinity
            for i in hull.indices {
                let a = hull[(i + hull.count - 1) % hull.count], b = hull[i], c = hull[(i + 1) % hull.count]
                let loss = abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
                if loss < bestLoss { bestLoss = loss; best = i }
            }
            hull.remove(at: best)
        }
        var quad = orderQuad(hull)
        var rms = 0.0
        for pass in 0..<2 {
            let r = refineQuad(quad, edge: edge, band: pass == 0 ? 0.06 : 0.03)
            quad = r.quad; rms = r.rms
        }
        // 合理性：凸、每邊夠長
        guard isConvex(quad), (0..<4).allSatisfy({ simd_distance(quad[$0], quad[($0 + 1) % 4]) > 40 }) else { return nil }
        return (orderQuad(quad), rms)
    }

    /// 和 ModulePoseDetector.refineQuad 同概念（複製改寫）：每邊取中段邊緣點，去離群後整體最小平方擬合直線，鄰線求交。
    private static func refineQuad(_ q: [SIMD2<Double>], edge: [SIMD2<Double>], band: Double)
        -> (quad: [SIMD2<Double>], rms: Double) {
        var lines: [(p: SIMD2<Double>, d: SIMD2<Double>)] = []
        var sq = 0.0, n = 0
        for i in 0..<4 {
            let a = q[i], b = q[(i + 1) % 4]
            let len = simd_distance(a, b)
            let dir = (b - a) / len
            let nrm = SIMD2(-dir.y, dir.x)
            var sel: [SIMD2<Double>] = []
            for p in edge {
                let s = simd_dot(p - a, dir)
                guard s > len * 0.1, s < len * 0.9, abs(simd_dot(p - a, nrm)) < max(6, len * band) else { continue }
                sel.append(p)
            }
            guard sel.count >= 6 else { lines.append((a, dir)); continue }
            var line = tls(sel)
            // 去離群：距離 > 2.5×中位數的點拿掉再擬合一次
            let dists = sel.map { abs(simd_dot($0 - line.p, SIMD2(-line.d.y, line.d.x))) }
            let med = dists.sorted()[dists.count / 2]
            let inl = zip(sel, dists).filter { $0.1 <= max(1.5, med * 2.5) }.map(\.0)
            if inl.count >= 6 { line = tls(inl) }
            if simd_dot(line.d, dir) < 0 { line.d = -line.d }
            for p in inl { let e = simd_dot(p - line.p, SIMD2(-line.d.y, line.d.x)); sq += e * e; n += 1 }
            lines.append(line)
        }
        var out: [SIMD2<Double>] = []
        for i in 0..<4 {
            let l1 = lines[(i + 3) % 4], l2 = lines[i]
            let den = l1.d.x * l2.d.y - l1.d.y * l2.d.x
            guard abs(den) > 1e-6 else { out.append(q[i]); continue }
            let diff = l2.p - l1.p
            let s = (diff.x * l2.d.y - diff.y * l2.d.x) / den
            let p = l1.p + l1.d * s
            out.append(simd_distance(p, q[i]) < 0.25 * simd_distance(q[i], q[(i + 2) % 4]) ? p : q[i])
        }
        return (out, n > 0 ? sqrt(sq / Double(n)) : 0)
    }

    private static func tls(_ pts: [SIMD2<Double>]) -> (p: SIMD2<Double>, d: SIMD2<Double>) {
        let c = pts.reduce(SIMD2<Double>(0, 0), +) / Double(pts.count)
        var sxx = 0.0, sxy = 0.0, syy = 0.0
        for p in pts { let d = p - c; sxx += d.x * d.x; sxy += d.x * d.y; syy += d.y * d.y }
        let ang = 0.5 * atan2(2 * sxy, sxx - syy)
        return (c, SIMD2(cos(ang), sin(ang)))
    }

    /// 影像座標（y 往下）順時針，從 x+y 最小（左上）的角開始。
    static func orderQuad(_ q: [SIMD2<Double>]) -> [SIMD2<Double>] {
        let c = q.reduce(SIMD2<Double>(0, 0), +) / Double(q.count)
        var s = q.sorted { atan2($0.y - c.y, $0.x - c.x) < atan2($1.y - c.y, $1.x - c.x) }   // y 往下時＝順時針
        let start = s.indices.min { s[$0].x + s[$0].y < s[$1].x + s[$1].y }!
        s = Array(s[start...] + s[..<start])
        return s
    }

    private static func isConvex(_ q: [SIMD2<Double>]) -> Bool {
        var sign = 0.0
        for i in 0..<4 {
            let a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]
            let z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if z == 0 { return false }
            if sign == 0 { sign = z } else if (z > 0) != (sign > 0) { return false }
        }
        return true
    }

    // MARK: - 4. 板內辨識孔位

    /// 透視程度：max(角偏離直角 / 90°, 1 − 對邊長度比)。正對約 0。
    static func perspectiveStrength(_ q: [SIMD2<Double>]) -> Double {
        var worst = 0.0
        for i in 0..<4 {
            let a = q[(i + 3) % 4] - q[i], b = q[(i + 1) % 4] - q[i]
            let ang = acos(max(-1, min(1, simd_dot(a, b) / (simd_length(a) * simd_length(b)))))
            worst = max(worst, abs(ang - .pi / 2) / (.pi / 2))
        }
        for i in 0..<2 {
            let l1 = simd_distance(q[i], q[i + 1]), l2 = simd_distance(q[(i + 2) % 4], q[(i + 3) % 4])
            worst = max(worst, 1 - min(l1, l2) / max(l1, l2))
        }
        return worst
    }

    /// 原圖裁到四邊形外接框（外擴 3%），格點方向要和四邊形的邊一致。
    private func detectCropped(_ img: GrayImage, quad q: [SIMD2<Double>]) -> (BreadboardDetection, Double) {
        let xs = q.map(\.x), ys = q.map(\.y)
        let box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
        let d = detector.detect(img, croppedTo: box, margin: 0.03)
        guard case let .found(r, c) = d else { return (d, 0) }
        let a1 = r.hole(row: 0, col: 0)!.point, aN = r.hole(row: 0, col: r.cols - 1)!.point
        // 和最平行的那條邊比
        let dir = simd_normalize(aN - a1)
        var best = 90.0
        for i in 0..<4 {
            let e = simd_normalize(q[(i + 1) % 4] - q[i])
            best = min(best, acos(min(1, abs(simd_dot(dir, e)))) * 180 / .pi)
        }
        guard best > maxLatticeAngle else { return (d, best) }
        let bad = BreadboardResult(imageWidth: r.imageWidth, imageHeight: r.imageHeight, cols: r.cols, holes: r.holes,
                                   pitch: r.pitch, detectedRatio: r.detectedRatio, meanResidual: max(r.meanResidual, 0.5),
                                   outline: r.outline, rowAxis: r.rowAxis, colAxis: r.colAxis, rails: r.rails)
        return (.found(bad, candidates: c), best)
    }

    private func detectRectified(_ img: GrayImage, quad q: [SIMD2<Double>]) -> (BreadboardDetection, Double) {
        // 拉正尺寸：取對邊較長者，保留解析度；長邊上限 1920
        var rw = max(simd_distance(q[0], q[1]), simd_distance(q[3], q[2]))
        var rh = max(simd_distance(q[0], q[3]), simd_distance(q[1], q[2]))
        let cap = 1920 / max(rw, rh)
        if cap < 1 { rw *= cap; rh *= cap }
        let margin = 0.03                                    // 四邊外擴 3%，避免邊上的孔被切掉
        let mx = rw * margin, my = rh * margin
        let W = Int(rw + 2 * mx), H = Int(rh + 2 * my)
        guard W >= 64, H >= 32,
              let Hr = Homography.fit([(SIMD2(mx, my), q[0]), (SIMD2(mx + rw, my), q[1]),
                                       (SIMD2(mx + rw, my + rh), q[2]), (SIMD2(mx, my + rh), q[3])]) else {
            return (.notFound(reason: "四邊形無法拉正", candidates: []), 0)
        }
        let rect = Self.warp(img, H: Hr, width: W, height: H)
        onRectified?(rect)

        let saved = detector.params.scaleReference
        detector.params.scaleReference = min(img.width, img.height)
        defer { detector.params.scaleReference = saved }
        switch detector.detect(rect) {
        case let .notFound(reason, c):
            return (.notFound(reason: "板內：\(reason)", candidates: c.map { Homography.apply(Hr, $0) }), 0)
        case let .found(r, c):
            // 拉正後格點應和長方形軸平行
            let a1 = r.hole(row: 0, col: 0)!.point, aN = r.hole(row: 0, col: r.cols - 1)!.point
            let d = aN - a1
            var ang = abs(atan2(d.y, d.x)) * 180 / .pi
            ang = min(ang, abs(180 - ang), abs(90 - ang))
            let mapped = Self.mapBack(r, H: Hr, imageWidth: img.width, imageHeight: img.height,
                                      plausible: ang <= maxLatticeAngle)
            return (.found(mapped, candidates: c.map { Homography.apply(Hr, $0) }), ang)
        }
    }

    /// 雙線性取樣：目標 (x, y) → 原圖 H·(x, y)。
    static func warp(_ img: GrayImage, H: simd_double3x3, width W: Int, height Hh: Int) -> GrayImage {
        var px = [UInt8](repeating: 0, count: W * Hh)
        let iw = img.width, ih = img.height
        // 板外（超出原圖）填板子平均亮度：避免被當成暗點
        var fill = 0, cnt = 0
        img.pixels.withUnsafeBufferPointer { src in
            for y in stride(from: 0, to: Hh, by: 8) {
                for x in stride(from: 0, to: W, by: 8) {
                    let p = Homography.apply(H, SIMD2(Double(x), Double(y)))
                    let xi = Int(p.x), yi = Int(p.y)
                    if xi >= 0, yi >= 0, xi < iw, yi < ih { fill += Int(src[yi * iw + xi]); cnt += 1 }
                }
            }
            let fv = UInt8(cnt > 0 ? fill / cnt : 128)
            px.withUnsafeMutableBufferPointer { dst in
                for y in 0..<Hh {
                    // 一列的齊次座標線性變化，逐點只做一次除法
                    var v = H * SIMD3(0, Double(y), 1)
                    let dv = SIMD3(H[0][0], H[0][1], H[0][2])
                    for x in 0..<W {
                        let sx = v.x / v.z, sy = v.y / v.z
                        v += dv
                        let x0 = Int(sx.rounded(.down)), y0 = Int(sy.rounded(.down))
                        guard x0 >= 0, y0 >= 0, x0 + 1 < iw, y0 + 1 < ih else { dst[y * W + x] = fv; continue }
                        let fx = sx - Double(x0), fy = sy - Double(y0)
                        let i = y0 * iw + x0
                        let a = Double(src[i]), b = Double(src[i + 1]), c = Double(src[i + iw]), d = Double(src[i + iw + 1])
                        let top = a + (b - a) * fx, bot = c + (d - c) * fx
                        dst[y * W + x] = UInt8(top + (bot - top) * fy)
                    }
                }
            }
        }
        return GrayImage(width: W, height: Hh, pixels: px)
    }

    /// 拉正座標的結果 → 原圖座標；方向（A 在上、1 在左）依原圖重新判斷，標字位置用鄰孔外推。
    static func mapBack(_ r: BreadboardResult, H: simd_double3x3, imageWidth: Int, imageHeight: Int,
                        plausible: Bool) -> BreadboardResult {
        let n = r.cols
        func P(_ row: Int, _ col: Int) -> SIMD2<Double> { Homography.apply(H, r.holes[row * n + col].point) }
        // 和 BreadboardDetector 相同的方向規則，在原圖上判斷
        let colDir = P(0, n - 1) - P(0, 0), rowDir = P(9, 0) - P(0, 0)
        var revC: Bool, revR: Bool
        if abs(colDir.x) >= abs(colDir.y) { revC = colDir.x < 0; revR = rowDir.y < 0 }
        else { revC = colDir.y < 0; revR = rowDir.x > 0 }
        func src(_ row: Int, _ col: Int) -> BreadboardHole {
            r.holes[(revR ? 9 - row : row) * n + (revC ? n - 1 - col : col)]
        }
        var holes: [BreadboardHole] = []
        holes.reserveCapacity(10 * n)
        for row in 0..<10 {
            for col in 0..<n {
                let h = src(row, col)
                holes.append(BreadboardHole(row: row, col: col, point: Homography.apply(H, h.point), detected: h.detected))
            }
        }
        func Q(_ row: Int, _ col: Int) -> SIMD2<Double> { holes[row * n + col].point }
        // 電源軌：A／J 側跟著列方向換、沿軌順序跟著欄方向換
        var railCount: [Int: Int] = [:]
        for h in r.rails { railCount[h.side * 2 + h.line, default: 0] += 1 }
        let mappedRails = r.rails.map { h in
            RailHole(side: revR ? 1 - h.side : h.side, line: h.line,
                     index: revC ? railCount[h.side * 2 + h.line]! - 1 - h.index : h.index,
                     point: Homography.apply(H, h.point), detected: h.detected)
        }
        let c1 = min(1, n - 1)
        let outline = [
            Q(0, 0) + (Q(0, 0) - Q(0, c1)) * 0.5 + (Q(0, 0) - Q(1, 0)) * 0.5,
            Q(0, n - 1) + (Q(0, n - 1) - Q(0, n - 1 - c1)) * 0.5 + (Q(0, n - 1) - Q(1, n - 1)) * 0.5,
            Q(9, n - 1) + (Q(9, n - 1) - Q(9, n - 1 - c1)) * 0.5 + (Q(9, n - 1) - Q(8, n - 1)) * 0.5,
            Q(9, 0) + (Q(9, 0) - Q(9, c1)) * 0.5 + (Q(9, 0) - Q(8, 0)) * 0.5,
        ]
        let rowAxis = (0..<10).map { Q($0, 0) + (Q($0, 0) - Q($0, c1)) * 1.2 }
        let colAxis = (0..<n).map { c in Q(0, c) + (Q(0, c) - Q(1, c)) * 1.2 }
        var pitchSum = 0.0
        for row in [0, 9] { pitchSum += simd_distance(Q(row, 0), Q(row, n - 1)) / Double(max(1, n - 1)) }
        return BreadboardResult(
            imageWidth: imageWidth, imageHeight: imageHeight, cols: n, holes: holes, pitch: pitchSum / 2,
            detectedRatio: r.detectedRatio,
            // 格點和長方形不平行＝拉正錯了：殘差設大，讓 isReliable 為 false
            meanResidual: plausible ? r.meanResidual : max(r.meanResidual, 0.5),
            outline: outline, rowAxis: rowAxis, colAxis: colAxis, rails: mappedRails)
    }
}

extension QuarterYCbCr {
    /// 相機 420f（Y 全解析度＋CbCr 交錯半解析度）→ 1/4 解析度。
    init(yBase: UnsafePointer<UInt8>, yStride: Int, cBase: UnsafePointer<UInt8>, cStride: Int, width: Int, height: Int) {
        let W = width / Self.scale, H = height / Self.scale
        var y = [UInt8](repeating: 0, count: W * H), cb = y, cr = y
        for j in 0..<H {
            let yr0 = yBase + (j * 4 + 1) * yStride, yr1 = yr0 + yStride
            let cr0 = cBase + (j * 2) * cStride
            for i in 0..<W {
                let x = i * 4 + 1
                y[j * W + i] = UInt8((Int(yr0[x]) + Int(yr0[x + 1]) + Int(yr1[x]) + Int(yr1[x + 1])) / 4)
                cb[j * W + i] = cr0[i * 4]
                cr[j * W + i] = cr0[i * 4 + 1]
            }
        }
        self.init(width: W, height: H, y: y, cb: cb, cr: cr)
    }

    /// RGBA／BGRA 8-bit（Mac 測試用）→ 1/4 解析度 YCbCr（BT.601 full range）。
    init(rgba: UnsafePointer<UInt8>, bytesPerRow: Int, width: Int, height: Int, bgr: Bool) {
        let W = width / Self.scale, H = height / Self.scale
        var y = [UInt8](repeating: 0, count: W * H), cb = y, cr = y
        for j in 0..<H {
            for i in 0..<W {
                var r = 0.0, g = 0.0, b = 0.0
                for dy in 1...2 {
                    for dx in 1...2 {
                        let p = rgba + (j * 4 + dy) * bytesPerRow + (i * 4 + dx) * 4
                        r += Double(p[bgr ? 2 : 0]); g += Double(p[1]); b += Double(p[bgr ? 0 : 2])
                    }
                }
                r /= 4; g /= 4; b /= 4
                y[j * W + i] = UInt8(max(0, min(255, 0.299 * r + 0.587 * g + 0.114 * b)))
                cb[j * W + i] = UInt8(max(0, min(255, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b)))
                cr[j * W + i] = UInt8(max(0, min(255, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b)))
            }
        }
        self.init(width: W, height: H, y: y, cb: cb, cr: cr)
    }
}
