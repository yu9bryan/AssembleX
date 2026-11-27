import Foundation
import simd

/// 示範／預覽用：合成一塊 830 孔麵包板的偵測結果（正投影、輕微晃動，用來測疊圖跟隨）。
/// 「影像」座標直接用畫面點（imageSize＝畫面大小），板子寬度填滿畫面（左右各留 16pt），放在 `region`（標題列與步驟卡之間）；
/// 63 欄放不下時只顯示目前步驟附近的一段。
/// 欄沿畫面縱向、A 列在右（和 3D 示範、桌面同方向）；電源軌照桌面模型（內排距 A 列 2.83 格、外排 3.83 格，第 1 孔在第 3 欄）。
enum SimulatedBoard {
    /// 板子外框（含電源軌）在板面座標（孔距單位）的範圍；欄數照專案（830＝63、400＝30、170＝17，170 沒有電源軌）
    private static let xRange = (-5.2, 16.2)
    private static func yRange(_ cols: Int) -> (Double, Double) { (-2.6, Double(cols) + 1.6) }

    /// 板子寬度＝畫面寬減左右各 16pt
    static func pitch(in region: CGRect) -> Double {
        Double(region.width - 32) / (xRange.1 - xRange.0)
    }

    /// 板面座標（孔距單位）→ 畫面點。x＝列方向（A→J），y＝欄方向（0 起）。
    /// 整塊放不下時，以 focusCol（欄號，1 起）為中心只顯示一段（約 ±14 欄），兩端不超出板子。
    static func projector(time t: Double, region: CGRect, focusCol: Double?, cols: Int = 63) -> (Double, Double) -> SIMD2<Double> {
        let yRange = yRange(cols)
        let pitch = pitch(in: region)
        let midX = (xRange.0 + xRange.1) / 2
        let half = Double(region.height) / 2 / pitch
        var midY = (yRange.0 + yRange.1) / 2
        if yRange.1 - yRange.0 > 2 * half, let f = focusCol {
            midY = min(max(f - 1, yRange.0 + half), yRange.1 - half)
        }
        let center = SIMD2(Double(region.midX), Double(region.midY))
        let shift = SIMD2(sin(t * 0.7) * 1.2, cos(t * 0.5) * 1.2)      // 輕微晃動（點）
        // 左右鏡像：A 列在右、J 列在左，和 3D 示範／桌面同一個方向（第 1 欄在上）
        return { x, y in center + SIMD2(midX - x, y - midY) * pitch + shift }
    }

    /// 板子外框四角，畫底圖用
    static func body(time t: Double, region: CGRect, focusCol: Double?, cols: Int = 63) -> [SIMD2<Double>] {
        let img = projector(time: t, region: region, focusCol: focusCol, cols: cols)
        let yRange = yRange(cols)
        return [img(xRange.0, yRange.0), img(xRange.1, yRange.0), img(xRange.1, yRange.1), img(xRange.0, yRange.1)]
    }

    static func result(time t: Double, region: CGRect, viewSize: CGSize, focusCol: Double? = nil, cols: Int = 63) -> BreadboardResult {
        let img = projector(time: t, region: region, focusCol: focusCol, cols: cols)
        let pitch = pitch(in: region)
        func rowX(_ r: Int) -> Double { r < 5 ? Double(r) : Double(r) + 2 }   // E/F 之間的溝 3 格

        var holes: [BreadboardHole] = []
        for r in 0..<10 {
            for col in 0..<cols {
                // 少數孔當作被元件擋住
                let hidden = (col * 7 + r * 3) % 11 == 0
                holes.append(BreadboardHole(row: r, col: col, point: img(rowX(r), Double(col)), detected: !hidden))
            }
        }
        var rails: [RailHole] = []
        if let model = HoleResolver.railModel(cols: cols) {
        for side in 0...1 {
            for line in 0...1 {
                let d = line == 0 ? 2.83 : 3.83
                let x = side == 0 ? -d : rowX(9) + d
                for i in 0..<model.holes {
                    let u = model.firstCol - 1 + Double((i / 5) * 6 + i % 5)
                    rails.append(RailHole(side: side, line: line, index: i, point: img(x, u), detected: true))
                }
            }
        }
        }
        let outline = [img(-0.5, -0.5), img(-0.5, Double(cols) - 0.5), img(rowX(9) + 0.5, Double(cols) - 0.5), img(rowX(9) + 0.5, -0.5)]
        return BreadboardResult(
            imageWidth: Int(viewSize.width), imageHeight: Int(viewSize.height), cols: cols,
            holes: holes, pitch: pitch, detectedRatio: 0.9, meanResidual: 0.03,
            outline: outline,
            rowAxis: (0..<10).map { img(rowX($0), -1.3) },
            colAxis: (0..<cols).map { img(-1.4, Double($0)) },
            rails: rails)
    }
}
