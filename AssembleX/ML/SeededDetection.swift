import CoreGraphics
import Foundation
import simd

// 用 AI 分割找到的板子框，限制經典孔位偵測只看那一塊：
// 背景（桌面紋路、文字、其他電子零件）的暗點不會進到格點擬合，像素也比較少。

extension BreadboardDetector {
    /// 只在 box（影像像素，會外擴 margin 比例）內偵測；結果座標換回整張影像。
    func detect(_ img: GrayImage, croppedTo box: CGRect, margin: Double = 0.08) -> BreadboardDetection {
        let mx = box.width * margin, my = box.height * margin
        let x0 = max(0, Int((box.minX - mx).rounded(.down)))
        let y0 = max(0, Int((box.minY - my).rounded(.down)))
        let x1 = min(img.width, Int((box.maxX + mx).rounded(.up)))
        let y1 = min(img.height, Int((box.maxY + my).rounded(.up)))
        let w = x1 - x0, h = y1 - y0
        guard w >= 64, h >= 64 else { return .notFound(reason: "AI 框太小", candidates: []) }

        var px = [UInt8](repeating: 0, count: w * h)
        img.pixels.withUnsafeBufferPointer { src in
            px.withUnsafeMutableBufferPointer { dst in
                for y in 0..<h {
                    let s = (y0 + y) * img.width + x0
                    for x in 0..<w { dst[y * w + x] = src[s + x] }
                }
            }
        }
        let crop = GrayImage(width: w, height: h, pixels: px)
        let off = SIMD2(Double(x0), Double(y0))
        // 孔的大小判斷沿用整張圖的尺度（否則小圖會把紋理當成孔）
        let saved = params.scaleReference
        params.scaleReference = min(img.width, img.height)
        defer { params.scaleReference = saved }
        switch detect(crop) {
        case let .found(r, c):
            return .found(r.translated(by: off, imageWidth: img.width, imageHeight: img.height), candidates: c.map { $0 + off })
        case let .notFound(reason, c):
            return .notFound(reason: reason, candidates: c.map { $0 + off })
        }
    }
}

extension BreadboardResult {
    func translated(by d: SIMD2<Double>, imageWidth w: Int, imageHeight h: Int) -> BreadboardResult {
        BreadboardResult(
            imageWidth: w, imageHeight: h, cols: cols,
            holes: holes.map { BreadboardHole(row: $0.row, col: $0.col, point: $0.point + d, detected: $0.detected) },
            pitch: pitch, detectedRatio: detectedRatio, meanResidual: meanResidual,
            outline: outline.map { $0 + d }, rowAxis: rowAxis.map { $0 + d }, colAxis: colAxis.map { $0 + d },
            rails: rails.map { RailHole(side: $0.side, line: $0.line, index: $0.index, point: $0.point + d, detected: $0.detected) })
    }
}

extension BreadboardDetection {
    /// 找到、且孔位可靠（和 ScannerModel 判斷「已鎖定」同一條件）
    var isReliable: Bool {
        if case let .found(r, _) = self { return r.isReliable }
        return false
    }
}
