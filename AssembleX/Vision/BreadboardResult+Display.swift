import Foundation
import simd

extension BreadboardResult {
    /// 整塊板子轉 180°：位置不變，只換標號（A↔J、1↔N）。
    func flipped() -> BreadboardResult {
        let n = cols
        var newHoles: [BreadboardHole] = []
        newHoles.reserveCapacity(holes.count)
        for r in 0..<10 {
            for c in 0..<n {
                let src = holes[(9 - r) * n + (n - 1 - c)]
                newHoles.append(BreadboardHole(row: r, col: c, point: src.point, detected: src.detected))
            }
        }
        return BreadboardResult(
            imageWidth: imageWidth, imageHeight: imageHeight, cols: n, holes: newHoles, pitch: pitch,
            detectedRatio: detectedRatio, meanResidual: meanResidual,
            outline: Array(outline[2...] + outline[..<2]),
            rowAxis: flippedAxis(rowAxis, across: holes.first?.point, holes.last?.point),
            colAxis: flippedAxis(colAxis, across: holes.first?.point, holes.last?.point),
            rails: flippedRails())
    }

    /// 轉 180°：A 側 ↔ J 側，沿軌方向反過來（內／外排不變）。
    private func flippedRails() -> [RailHole] {
        var count: [Int: Int] = [:]
        for h in rails { count[h.side * 2 + h.line, default: 0] += 1 }
        return rails.map {
            RailHole(side: 1 - $0.side, line: $0.line, index: count[$0.side * 2 + $0.line]! - 1 - $0.index,
                     point: $0.point, detected: $0.detected)
        }
    }

    /// 標字位置在板子外側；翻轉後要移到另一側（對板子中心做點對稱）。
    private func flippedAxis(_ axis: [SIMD2<Double>], across a: SIMD2<Double>?, _ b: SIMD2<Double>?) -> [SIMD2<Double>] {
        guard let a, let b else { return axis }
        let center = (a + b) / 2
        // 舊第 r 列標字在左側；點對稱後落在右側、且剛好在新第 r 列（＝舊第 9-r 列）旁
        return axis.map { center * 2 - $0 }
    }

    /// 和上一幀做指數平滑，減少孔位抖動；板型不同或移動太大時直接用新結果。
    func smoothed(from previous: BreadboardResult?, alpha: Double = 0.45) -> BreadboardResult {
        guard let prev = previous, prev.cols == cols, prev.holes.count == holes.count,
              prev.imageWidth == imageWidth else { return self }
        var move = 0.0
        for (h, p) in zip(holes, prev.holes) { move += simd_distance(h.point, p.point) }
        move /= Double(holes.count)
        guard move < pitch * 0.8 else { return self }
        func mix(_ new: SIMD2<Double>, _ old: SIMD2<Double>) -> SIMD2<Double> { old + (new - old) * alpha }
        return BreadboardResult(
            imageWidth: imageWidth, imageHeight: imageHeight, cols: cols,
            holes: zip(holes, prev.holes).map {
                BreadboardHole(row: $0.row, col: $0.col, point: mix($0.point, $1.point), detected: $0.detected)
            },
            pitch: pitch, detectedRatio: detectedRatio, meanResidual: meanResidual,
            outline: zip(outline, prev.outline).map { mix($0, $1) },
            rowAxis: zip(rowAxis, prev.rowAxis).map { mix($0, $1) },
            colAxis: zip(colAxis, prev.colAxis).map { mix($0, $1) },
            rails: prev.rails.map(\.name) == rails.map(\.name)
                ? zip(rails, prev.rails).map {
                    RailHole(side: $0.side, line: $0.line, index: $0.index, point: mix($0.point, $1.point), detected: $0.detected)
                }
                : rails)
    }
}
