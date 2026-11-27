import SwiftUI
import simd

/// 在相機畫面上標出 A–J × 1…N 每個孔；目標孔加圈、兩個目標時畫跳線。
struct HoleOverlayView: View {
    let result: BreadboardResult
    let map: ImageToView
    let targets: [NamedPoint]
    let showAllLabels: Bool

    var body: some View {
        Canvas { ctx, _ in
            let s = map.scale
            let pitch = CGFloat(result.pitch) * s

            // 主區外框
            var outline = Path()
            outline.addLines(result.outline.map(map.view))
            outline.closeSubpath()
            ctx.stroke(outline, with: .color(.cyan.opacity(0.9)), lineWidth: 2)

            // 孔：綠點＝看得到的孔；橘圈＝推算出的孔（可能被元件擋住）
            let r = max(2, pitch * 0.22)
            for h in result.holes {
                let p = map.view(h.point)
                let rect = CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)
                if h.detected {
                    ctx.fill(Path(ellipseIn: rect), with: .color(.green.opacity(0.85)))
                } else {
                    ctx.stroke(Path(ellipseIn: rect), with: .color(.orange), lineWidth: max(1, r * 0.45))
                }
            }

            // 電源軌：方形孔＋沿軌色帶，和主區的圓點分開（內排青、外排洋紅；空心＝推算）
            drawRails(ctx, pitch: pitch)

            // 列字母、欄號（每 5 欄；showAllLabels 時全部）
            let font = Font.system(size: max(9, min(16, pitch * 0.62)), weight: .heavy, design: .rounded)
            for (i, p) in result.rowAxis.enumerated() {
                ctx.draw(label(BreadboardResult.rowLetters[i], font), at: map.view(p))
            }
            for (i, p) in result.colAxis.enumerated() where showAllLabels || i == 0 || (i + 1) % 5 == 0 {
                ctx.draw(label("\(i + 1)", font), at: map.view(p))
            }

            // 目標：兩孔之間畫跳線
            if targets.count == 2 {
                var wire = Path()
                wire.move(to: map.view(targets[0].point))
                wire.addLine(to: map.view(targets[1].point))
                ctx.stroke(wire, with: .color(.pink), style: StrokeStyle(lineWidth: max(3, pitch * 0.3), lineCap: .round))
            }
            for (i, t) in targets.enumerated() {
                let p = map.view(t.point)
                let rr = max(8, pitch * 0.7)
                ctx.stroke(Path(ellipseIn: CGRect(x: p.x - rr, y: p.y - rr, width: 2 * rr, height: 2 * rr)),
                           with: .color(i == 0 ? .pink : .purple), lineWidth: 3)
                ctx.draw(Text(t.name).font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(.white),
                         at: CGPoint(x: p.x, y: p.y - rr - 12))
            }
        }
        .allowsHitTesting(false)
    }

    private func drawRails(_ ctx: GraphicsContext, pitch: CGFloat) {
        let half = max(2, pitch * 0.2)
        for row in result.railRows {
            guard let first = row.first, let last = row.last else { continue }
            let color: Color = first.line == 0 ? .cyan : Color(red: 1, green: 0.3, blue: 0.85)
            // 色帶
            var band = Path()
            band.move(to: map.view(first.point))
            band.addLine(to: map.view(last.point))
            ctx.stroke(band, with: .color(color.opacity(0.25)),
                       style: StrokeStyle(lineWidth: max(4, pitch * 0.75), lineCap: .round))
            // 方形孔
            for h in row {
                let p = map.view(h.point)
                let rect = CGRect(x: p.x - half, y: p.y - half, width: 2 * half, height: 2 * half)
                if h.detected {
                    ctx.fill(Path(rect), with: .color(color.opacity(0.95)))
                } else {
                    ctx.stroke(Path(rect), with: .color(color), lineWidth: max(1, half * 0.5))
                }
            }
            // 軌名標在第 1 孔外側
            if row.count >= 2 {
                let dir = first.point - row[1].point
                let len = max(1e-6, simd_length(dir))
                let at = first.point + dir / len * Double(pitch / map.scale) * 1.6
                let name = (first.side == 0 ? "A 側" : "J 側") + (first.line == 0 ? "內軌" : "外軌")
                ctx.draw(Text(name).font(.system(size: max(9, min(13, pitch * 0.5)), weight: .bold, design: .rounded))
                            .foregroundStyle(color),
                         at: map.view(at))
            }
        }
    }

    private func label(_ s: String, _ font: Font) -> Text {
        Text(s).font(font).foregroundStyle(.yellow)
    }
}
