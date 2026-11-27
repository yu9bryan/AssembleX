import SwiftUI

/// AI 管線疊圖：分割遮罩（粉紅）、RGB 增強遮罩（青）、直線四邊形（黃）、AI 孔位（青點）。
struct SegOverlayView: View {
    let seg: SegFrame
    let map: ImageToView
    var pipeline: BoardPipelineFrame?
    /// 對照模式：遮罩只畫外框，避免蓋住經典孔位
    var compare = false
    /// 畫 AI 管線找到的孔（對照模式下經典結果是主畫面時）
    var showPipelineHoles = false

    var body: some View {
        Canvas { ctx, _ in
            let imgRect = CGRect(origin: map.view(SIMD2(0, 0)),
                                 size: CGSize(width: seg.imageSize.width * map.scale,
                                              height: seg.imageSize.height * map.scale))
            let board = pipeline?.seg ?? seg.board

            // 1. 分割
            if let inst = board {
                if !compare, let img = Self.maskImage(inst.mask, rgb: (255, 64, 160), alpha: 60) {
                    ctx.draw(Image(decorative: img, scale: 1).interpolation(.medium), in: imgRect)
                }
                if inst.hull.count >= 3 {
                    var p = Path()
                    p.addLines(inst.hull.map(map.view))
                    p.closeSubpath()
                    ctx.stroke(p, with: .color(.pink.opacity(0.9)),
                               style: StrokeStyle(lineWidth: 2, lineJoin: .round, dash: compare ? [6, 4] : []))
                }
                let tl = map.view(SIMD2(inst.box.minX, inst.box.minY))
                ctx.draw(Text("分割 \(Int(inst.score * 100))%")
                            .font(.system(size: 12, weight: .bold, design: .rounded)).foregroundStyle(.pink),
                         at: CGPoint(x: tl.x + 4, y: tl.y - 10), anchor: .leading)
            }

            // 2. RGB 增強
            if let m = pipeline?.refined, let img = Self.maskImage(m, rgb: (40, 200, 255), alpha: compare ? 45 : 70) {
                ctx.draw(Image(decorative: img, scale: 1).interpolation(.medium), in: imgRect)
            }

            // 3. 直線四邊形
            if let q = pipeline?.quad {
                var p = Path()
                p.addLines(q.map(map.view))
                p.closeSubpath()
                ctx.stroke(p, with: .color(.yellow), style: StrokeStyle(lineWidth: 2.5, lineJoin: .round))
                for c in q {
                    let v = map.view(c)
                    ctx.fill(Path(ellipseIn: CGRect(x: v.x - 4, y: v.y - 4, width: 8, height: 8)), with: .color(.yellow))
                }
            }

            // 4. AI 孔位（對照用；主畫面孔位由 HoleOverlayView 畫）
            if showPipelineHoles, case let .found(r, _)? = pipeline?.detection, r.isReliable {
                let rad = max(1.5, CGFloat(r.pitch) * map.scale * 0.12)
                for h in r.holes {
                    let v = map.view(h.point)
                    ctx.stroke(Path(ellipseIn: CGRect(x: v.x - rad, y: v.y - rad, width: 2 * rad, height: 2 * rad)),
                               with: .color(.cyan), lineWidth: 1.2)
                }
            }
        }
        .allowsHitTesting(false)
    }

    static func maskImage(_ m: SegMask, rgb: (UInt8, UInt8, UInt8), alpha: UInt8 = 90) -> CGImage? {
        var px = [UInt8](repeating: 0, count: m.width * m.height * 4)
        // premultiplied alpha
        let a = Double(alpha) / 255
        let r = UInt8(Double(rgb.0) * a), g = UInt8(Double(rgb.1) * a), b = UInt8(Double(rgb.2) * a)
        for i in 0..<(m.width * m.height) where m.bits[i] != 0 {
            px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = alpha
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData) else { return nil }
        return CGImage(width: m.width, height: m.height, bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: m.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
