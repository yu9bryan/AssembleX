import SwiftUI
import simd

/// 疊圖位置的二次平滑（偵測之間逐顯示幀內插，避免抖動）。
final class PointSmoother {
    private var points: [String: CGPoint] = [:]
    private var thisFrame: [String: CGPoint] = [:]
    private var frame = -1.0

    /// 同一個顯示幀只內插一次（同一孔可能被圈、導線各取一次）
    func begin(frame t: Double) {
        if t != frame { frame = t; thisFrame.removeAll(keepingCapacity: true) }
    }

    func value(_ key: String, _ target: CGPoint, jump: CGFloat) -> CGPoint {
        if let p = thisFrame[key] { return p }
        let p = step(key, target, jump: jump)
        thisFrame[key] = p
        return p
    }

    private func step(_ key: String, _ target: CGPoint, jump: CGFloat) -> CGPoint {
        guard let old = points[key], hypot(target.x - old.x, target.y - old.y) < jump else {
            points[key] = target
            return target
        }
        let p = CGPoint(x: old.x + (target.x - old.x) * 0.35, y: old.y + (target.y - old.y) * 0.35)
        points[key] = p
        return p
    }
}

/// 逐步接線疊圖：目前這一步的孔加脈動圈與標籤、導線畫成彩色弧線、
/// 接開發板的端點畫成貼著板緣的半透明箭頭並標上腳位（例如「UNO 5V」）。
struct WiringOverlayView: View {
    let project: LanProject
    let stepIndex: Int
    let done: Set<Int>
    let showAll: Bool
    let resolver: HoleResolver
    let map: ImageToView
    let time: Double
    let smoother: PointSmoother
    /// 模擬板：欄號／列字母由疊圖畫在導線之上，避免被蓋住
    var axisLabels = false
    /// 模擬板目前看得到的範圍（上緣固定畫「A B C D E │ F G H I J」欄頭）；相機模式為 nil
    var visibleRect: CGRect?
    /// AR／3D：導線、完成的元件由 3D 場景畫；接開發板的端點標在排針的畫面位置
    var wires3D = false
    var pinPoints: [String: CGPoint] = [:]
    /// 標籤不可蓋到的範圍（AR：開發板在畫面上的外框）
    var avoidRects: [CGRect] = []
    /// 標籤要待在這個範圍內（標題列與步驟卡之間，左右留 16pt）；nil＝整個畫面
    var safeRect: CGRect?
    /// 已顯示導線在畫面上的折線（AR：3D 導線投影）；引線盡量不要穿過
    var wireScreenPaths: [[CGPoint]] = []
    /// AR／3D：標籤單行、最寬 55% 畫面、電源軌用短名稱
    private var compact: Bool { wires3D }

    var body: some View {
        Canvas { ctx, size in draw(&ctx, size) }
            .allowsHitTesting(false)
    }

    private enum Style { case current, done, all }

    private var pitch: CGFloat { CGFloat(resolver.result.pitch) * map.scale }

    private func view(_ id: String) -> CGPoint? {
        guard let p = resolver.point(id) else { return nil }
        return smoother.value(id.uppercased(), map.view(p), jump: pitch * 3)
    }

    private func draw(_ ctx: inout GraphicsContext, _ size: CGSize) {
        smoother.begin(frame: time)
        let steps = project.steps
        guard steps.indices.contains(stepIndex) else { return }
        let current = steps[stepIndex]
        let tags = TagBoard()
        tags.bands += avoidRects
        tags.wirePolys = wireScreenPaths
        // 目標孔所在的整排（含那排的欄號）都不放標籤
        for id in current.holes {
            guard let p = view(id) else { continue }
            tags.bands.append(rowBand(through: p))
        }

        // 已完成的元件（淡色實線＋灰點），已完成（或「全部接線」）的導線
        for (i, s) in steps.enumerated() where i != stepIndex {
            // 之前的步驟才畫；之後的步驟就算打過勾也不畫（「全部接線」才全部顯示）
            let isDone = i < stepIndex
            if s.isWire {
                guard isDone || showAll, let w = project.wire(s.targetId) else { continue }
                drawWire(&ctx, w, size: size, style: showAll ? .all : .done, tags: tags)
            } else if isDone, !wires3D, let part = project.part(s.targetId) {
                drawDonePart(&ctx, part)
            }
        }

        // 目前這一步
        let pulse = 0.5 + 0.5 * sin(time * 2 * .pi / 1.2)
        if current.isWire, let w = project.wire(current.targetId) {
            drawWire(&ctx, w, size: size, style: .current, tags: tags)
        } else if !wires3D, let part = project.part(current.targetId) {
            drawPart(&ctx, part)
        }
        // 欄號畫在導線之上（壓到導線的加深色底），再蓋固定欄頭
        // 目前這一步的列、欄：欄頭字母與欄號標成白底，好找
        let hiRows = Set(current.holes.compactMap { if case let .main(r, _)? = HoleID($0) { return r } else { return nil } })
        let hiCols = Set(current.holes.compactMap { if case let .main(_, c)? = HoleID($0) { return c } else { return nil } })
        if axisLabels { drawAxis(&ctx, wirePts: tags.wirePts, tags: tags, highlight: hiCols) }
        if let v = visibleRect { drawStickyHeader(&ctx, v, highlight: hiRows) }
        let ringColor: Color = current.isWire ? (project.wire(current.targetId).map { Color(hex: $0.color) } ?? .white) : .white
        let ringPts = current.holes.compactMap { id in view(id).map { (id, $0) } }
        for (id, p) in ringPts.sorted(by: { $0.1.y < $1.1.y }) {
            // 直徑＝min(0.8 × 當地孔距, 40pt)；相鄰兩孔都要標時改成實心點＋細圈，避免圈圈疊成「8」
            let local = localPitch(id, at: p)
            let r = min(0.4 * local, 20)
            let crowded = ringPts.contains { $0.0 != id && hypot($0.1.x - p.x, $0.1.y - p.y) < local * 1.5 }
            let dotColor = pinColor(id, step: current)
            let rect = CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)
            if crowded {
                ctx.stroke(Path(ellipseIn: rect), with: .color(ringColor.opacity(0.55 + 0.45 * pulse)), lineWidth: 1)
                let d = r * 0.62
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)), with: .color(dotColor))
                ctx.stroke(Path(ellipseIn: CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)),
                           with: .color(.black.opacity(0.5)), lineWidth: 0.8)
            } else {
                // 外側柔光脈動（不放大圈本身）
                let g = r + 3 + 3 * pulse
                ctx.stroke(Path(ellipseIn: CGRect(x: p.x - g, y: p.y - g, width: 2 * g, height: 2 * g)),
                           with: .color(ringColor.opacity(0.25 * pulse)), lineWidth: 3)
                ctx.stroke(Path(ellipseIn: rect), with: .color(.white.opacity(0.9)), lineWidth: 3)
                ctx.stroke(Path(ellipseIn: rect), with: .color(ringColor), lineWidth: 1.6)
                let d = max(2.5, r * 0.38)
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)), with: .color(dotColor))
            }
            drawHoleTag(&ctx, id: id, at: p, ringRadius: r, step: current, size: size, tags: tags)
        }
    }

    /// 目前步驟的孔標籤：一律放在旁邊的標籤欄（或中央溝），用 1px 引線連到孔；不蓋目標排的孔與欄號。
    /// - 元件腳、電源軌端：靠近的那一側（電源軌在哪側就放哪側）
    /// - 導線的主區端：中央溝放得下就放中央溝，否則放另一側
    private func drawHoleTag(_ ctx: inout GraphicsContext, id: String, at p: CGPoint, ringRadius r: CGFloat,
                             step: LanProject.Step, size: CGSize, tags: TagBoard) {
        let text = holeLabel(id, step: step)
        var left = p.x <= mainRect.midX
        var placement: TagPlacement?
        var pairNear = false
        if step.isWire, case let .main(row, col)? = HoleID(id) {
            if let ch = channel(col: col) {
                placement = .channel(center: CGPoint(x: ch.midX, y: p.y), maxWidth: ch.width)
            }
            _ = row
            // 一律先放靠近的那一側（引線短）。
            // 兩端在同一側、高度差不多（短的橫線，例如主區 → 旁邊的電源軌）：各自貼在自己那一端的上方／下方，
            // 標籤不會跑到另一端旁邊。
            if let w = project.wire(step.targetId),
               let oh = [w.from, w.to].first(where: { $0.hole != nil && $0.hole?.uppercased() != id.uppercased() })?.hole,
               let op = view(oh), abs(op.y - p.y) < 30 {
                let away = CGPoint(x: 0, y: p.x < op.x ? -1 : 1)
                placement = .near(anchor: p, away: away, gap: r + 6)
                pairNear = true
            }
        }
        // 引線（孔 → 標籤欄）會穿過已畫的導線：換另一側試試
        if !step.isWire, tags.crossesWire(p, CGPoint(x: sideColumnX(left: left, size: size), y: p.y)),
           !tags.crossesWire(p, CGPoint(x: sideColumnX(left: !left, size: size), y: p.y)) {
            left.toggle()
        }
        let column: TagPlacement = .column(edgeX: sideColumnX(left: left, size: size), rightAligned: left, y: p.y)
        var side = column
        if compact {
            // AR：標籤貼近孔，往「離同一步其他孔」的方向放
            let others = step.holes.filter { $0.uppercased() != id.uppercased() }.compactMap(view)
            var away = CGPoint(x: 0, y: -1)
            if !others.isEmpty {
                let c = CGPoint(x: others.map(\.x).reduce(0, +) / CGFloat(others.count),
                                y: others.map(\.y).reduce(0, +) / CGFloat(others.count))
                let l = hypot(p.x - c.x, p.y - c.y)
                if l > 1 { away = CGPoint(x: (p.x - c.x) / l, y: (p.y - c.y) / l) }
            }
            side = .near(anchor: p, away: away, gap: r + 6)
            placement = nil
        }
        if pairNear, !compact {
            // 另一端也在旁邊：這一端的標籤一定貼在自己上方／下方
            side = placement ?? side
        }
        let tagRect = drawTag(&ctx, text, size: size, fill: GuideStyle.panel, text: .white, stroke: true,
                              placement: placement ?? side, fallback: side, tags: tags)
        guard !tagRect.contains(p) else { return }
        // 引線：從標籤靠孔那一邊的中點到圈外
        let from = CGPoint(x: min(max(p.x, tagRect.minX), tagRect.maxX), y: min(max(p.y, tagRect.minY), tagRect.maxY))
        let dx = p.x - from.x, dy = p.y - from.y, l = max(1, hypot(dx, dy))
        guard l > r + 2 else { return }
        var lead = Path()
        lead.move(to: from)
        lead.addLine(to: CGPoint(x: p.x - dx / l * (r + 1), y: p.y - dy / l * (r + 1)))
        ctx.stroke(lead, with: .color(.white.opacity(0.6)), lineWidth: 1)
    }

    /// 某欄 E 與 F 之間的中央溝（扣掉孔的範圍）
    private func channel(col: Int) -> CGRect? {
        let r = resolver.result
        guard let e = r.hole(row: 4, col: col), let f = r.hole(row: 5, col: col) else { return nil }
        let a = map.view(e.point), b = map.view(f.point)
        let gap = hypot(b.x - a.x, b.y - a.y) - pitch * 0.5 - 2
        return CGRect(x: (a.x + b.x) / 2 - gap / 2, y: (a.y + b.y) / 2 - pitch / 2, width: max(0, gap), height: pitch)
    }

    /// 穿過某點、沿列方向橫跨整塊板子的一排（外擴半個孔距）
    private func rowBand(through p: CGPoint) -> CGRect {
        let dir = axes().row
        let box = boardRect
        let pts = [box.origin, CGPoint(x: box.maxX, y: box.minY), CGPoint(x: box.minX, y: box.maxY), CGPoint(x: box.maxX, y: box.maxY)]
        let ts = pts.map { ($0.x - p.x) * dir.x + ($0.y - p.y) * dir.y }
        let a = CGPoint(x: p.x + dir.x * ts.min()!, y: p.y + dir.y * ts.min()!)
        let b = CGPoint(x: p.x + dir.x * ts.max()!, y: p.y + dir.y * ts.max()!)
        let h = max(6, pitch * 0.55)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y)).insetBy(dx: -h, dy: -h)
    }

    /// 每個孔標籤往哪邊放：孔分成左右兩欄（沿列方向有落差）→ 左欄往左、右欄往右；
    /// 同一欄（例如 LED 上下兩腳）→ 沿欄方向往外。都相同時往板子外側。
    private func tagDirections(_ pts: [(String, CGPoint)]) -> [CGPoint] {
        guard !pts.isEmpty else { return [] }
        let (rowDir, colDir) = axes()
        let c = CGPoint(x: pts.map(\.1.x).reduce(0, +) / CGFloat(pts.count),
                        y: pts.map(\.1.y).reduce(0, +) / CGFloat(pts.count))
        func dot(_ p: CGPoint, _ d: CGPoint) -> CGFloat { (p.x - c.x) * d.x + (p.y - c.y) * d.y }
        func neg(_ d: CGPoint) -> CGPoint { CGPoint(x: -d.x, y: -d.y) }
        let rowProj = pts.map { dot($0.1, rowDir) }
        let colProj = pts.map { dot($0.1, colDir) }
        let center = boardCenter
        let outward = (c.x - center.x) * rowDir.x + (c.y - center.y) * rowDir.y >= 0 ? rowDir : neg(rowDir)
        if (rowProj.max()! - rowProj.min()!) > pitch * 0.5 {
            return rowProj.map { $0 >= 0 ? rowDir : neg(rowDir) }
        }
        if (colProj.max()! - colProj.min()!) > pitch * 0.5 {
            return colProj.map { $0 >= 0 ? colDir : neg(colDir) }
        }
        return pts.map { _ in outward }
    }

    /// 畫面上的列方向（A→J）、欄方向（1→N）單位向量
    private func axes() -> (row: CGPoint, col: CGPoint) {
        let r = resolver.result
        guard let a1 = r.hole(row: 0, col: 0), let aN = r.hole(row: 0, col: r.cols - 1),
              let j1 = r.hole(row: 9, col: 0) else { return (CGPoint(x: 1, y: 0), CGPoint(x: 0, y: 1)) }
        func unit(_ from: SIMD2<Double>, _ to: SIMD2<Double>) -> CGPoint {
            let q0 = map.view(from), q1 = map.view(to)
            let d = CGPoint(x: q1.x - q0.x, y: q1.y - q0.y), l = max(1e-6, hypot(d.x, d.y))
            return CGPoint(x: d.x / l, y: d.y / l)
        }
        return (unit(a1.point, j1.point), unit(a1.point, aN.point))
    }

    /// 主區（A–J）在畫面上的外接框
    private var mainRect: CGRect {
        let pts = resolver.result.outline.map(map.view)
        guard let x0 = pts.map(\.x).min(), let x1 = pts.map(\.x).max(),
              let y0 = pts.map(\.y).min(), let y1 = pts.map(\.y).max() else { return .zero }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// 板外標籤欄的 x：優先放在整塊板子（含電源軌）外 8pt；畫面放不下（板子幾乎滿版）就退到主區外 6pt
    private func sideColumnX(left: Bool, size: CGSize, need: CGFloat = 76) -> CGFloat {
        let box = boardRect
        if left { return box.minX - 8 >= need + 4 ? box.minX - 8 : mainRect.minX - 6 }
        return size.width - (box.maxX + 8) >= need + 4 ? box.maxX + 8 : mainRect.maxX + 6
    }

    /// 板子（主區＋電源軌）在畫面上的外接框
    private var boardRect: CGRect {
        let r = resolver.result
        let pts = r.outline.map(map.view) + r.rails.map { map.view($0.point) }
        guard let x0 = pts.map(\.x).min(), let x1 = pts.map(\.x).max(),
              let y0 = pts.map(\.y).min(), let y1 = pts.map(\.y).max() else { return .zero }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0).insetBy(dx: -pitch * 0.6, dy: -pitch * 0.6)
    }

    /// 這個孔附近的孔距（畫面點）：主區用左右相鄰孔量，電源軌用整體平均
    private func localPitch(_ id: String, at p: CGPoint) -> CGFloat {
        if case let .main(row, col)? = HoleID(id) {
            let r = resolver.result
            let n = [r.hole(row: row, col: col - 1), r.hole(row: row, col: col + 1)].compactMap { $0 }
            if let q = n.first {
                let v = map.view(q.point), o = map.view(r.hole(row: row, col: col)!.point)
                return max(4, hypot(v.x - o.x, v.y - o.y))
            }
        }
        return max(4, pitch)
    }

    /// 極性：正極紅、負極中性灰，其他腳白色
    private func pinColor(_ id: String, step: LanProject.Step) -> Color {
        guard !step.isWire, let pin = project.part(step.targetId)?.pins.first(where: { $0.hole?.uppercased() == id.uppercased() })
        else { return .white }
        let key = (pin.label ?? "") + " " + pin.pin.lowercased()
        if key.contains("正極") || key.contains("anode") || pin.pin == "+" { return Color(hex: "#d6484d") }
        if key.contains("負極") || key.contains("cathode") || pin.pin == "-" { return Color(hex: "#8a8f98") }
        return .white
    }

    /// 孔的標籤：和步驟卡同一份名稱（project.label，原樣使用）
    private func holeLabel(_ id: String, step: LanProject.Step) -> String {
        // 和桌面 3D 同一種短名：主區「D 排 8 欄」、電源軌「A 側−軌·43 欄」（2D／3D／AR 都一樣）
        let name = project.shortLabel(id)
        if !step.isWire, let pin = project.part(step.targetId)?.pins.first(where: { $0.hole?.uppercased() == id.uppercased() }) {
            return "\(pin.label ?? pin.pin) \(name)"
        }
        return name
    }

    /// 欄號（每 5 欄）：白 0.68；靠近導線（±1 孔距）的加不透明底色。第一個看得到的欄號加「欄」。
    private func drawAxis(_ ctx: inout GraphicsContext, wirePts: [CGPoint], tags: TagBoard? = nil, highlight: Set<Int> = []) {
        let r = resolver.result
        let size = max(11, min(13, pitch * 0.7))
        let font = Font.system(size: size, weight: .medium).monospacedDigit()
        let color = Color(white: 0.68)
        let topLimit = (visibleRect?.minY ?? -.infinity) + 28 + size / 2
        let bottomLimit = visibleRect?.maxY ?? .infinity
        var first = true
        for (i, p) in r.colAxis.enumerated() where i == 0 || (i + 1) % 5 == 0 || highlight.contains(i) {
            let v = map.view(p)
            guard v.y >= topLimit, v.y <= bottomLimit else { continue }
            let hi = highlight.contains(i)
            // 目前這一欄：孔的標籤已經寫了「N 欄」，軸上只標粗體數字當記號（不重複寫兩次「N 欄」）
            let s = hi ? "\(i + 1)" : first ? "\(i + 1) 欄" : "\(i + 1)"
            let t = ctx.resolve(Text(s).font(hi ? font.weight(.bold) : font).foregroundStyle(hi ? Color.black : color))
            let m = t.measure(in: CGSize(width: 80, height: 30))
            let c = v
            var box = CGRect(x: c.x - m.width / 2 - 3, y: c.y - m.height / 2 - 1, width: m.width + 6, height: m.height + 2)
            // 被標籤（開發板腳位、孔名）蓋住的欄號不畫，避免疊字
            if !hi, let tags, tags.placed.contains(where: { $0.intersects(box) }) { continue }
            var at = c
            if hi {
                // 目前這一欄的白底欄號：壓到導線就沿著欄號那一條往上／下挪開，畫一小段線指回原位
                func hitsWire(_ b: CGRect) -> Bool { wirePts.contains { b.insetBy(dx: -3, dy: -3).contains($0) } }
                if hitsWire(box) {
                    let home = c
                    for k in [1.0, -1.0, 1.8, -1.8, 2.6, -2.6] {
                        let nb = box.offsetBy(dx: 0, dy: pitch * k)
                        if !hitsWire(nb) {
                            box = nb; at = CGPoint(x: home.x, y: home.y + pitch * k)
                            var tick = Path()
                            tick.move(to: CGPoint(x: home.x, y: k > 0 ? box.minY : box.maxY))
                            tick.addLine(to: CGPoint(x: home.x, y: home.y + (k > 0 ? 4 : -4)))
                            ctx.stroke(tick, with: .color(.white.opacity(0.7)), lineWidth: 1)
                            break
                        }
                    }
                }
                ctx.fill(Path(roundedRect: box, cornerRadius: 4), with: .color(.white))
            } else if wirePts.contains(where: { hypot($0.x - c.x, $0.y - c.y) < pitch * 1.0 + m.width / 2 }) {
                ctx.fill(Path(roundedRect: box, cornerRadius: 3), with: .color(GuideStyle.panel))
            }
            ctx.draw(t, at: at)
            first = false
        }
        if visibleRect == nil {
            for (i, p) in r.rowAxis.enumerated() {
                ctx.draw(Text(BreadboardResult.rowLetters[i]).font(font).foregroundStyle(color), at: map.view(p))
            }
        }
    }

    /// 固定在可見範圍頂端的欄頭「A B C D E │ F G H I J」
    private func drawStickyHeader(_ ctx: inout GraphicsContext, _ v: CGRect, highlight: Set<Int> = []) {
        let r = resolver.result
        guard r.rowAxis.count == 10 else { return }
        let band = CGRect(x: v.minX, y: v.minY, width: v.width, height: 28)
        ctx.fill(Path(band), with: .color(GuideStyle.panel.opacity(0.9)))
        let y = v.minY + 14
        let font = Font.system(size: 12, weight: .semibold)
        for (i, p) in r.rowAxis.enumerated() {
            let at = CGPoint(x: map.view(p).x, y: y)
            if highlight.contains(i) {
                ctx.fill(Path(roundedRect: CGRect(x: at.x - 9, y: at.y - 9, width: 18, height: 18), cornerRadius: 5), with: .color(.white))
                ctx.draw(Text(BreadboardResult.rowLetters[i]).font(font.weight(.bold)).foregroundStyle(Color.black), at: at)
            } else {
                ctx.draw(Text(BreadboardResult.rowLetters[i]).font(font).foregroundStyle(Color(white: 0.78)), at: at)
            }
        }
        let mid = (map.view(r.rowAxis[4]).x + map.view(r.rowAxis[5]).x) / 2
        ctx.draw(Text("│").font(font).foregroundStyle(Color(white: 0.45)), at: CGPoint(x: mid, y: y))
    }

    // MARK: 元件

    private func drawPart(_ ctx: inout GraphicsContext, _ part: LanProject.Part) {
        let pts = part.pins.compactMap { $0.hole }.compactMap(view)
        guard pts.count >= 2 else { return }
        let dash = StrokeStyle(lineWidth: max(1.5, pitch * 0.14), lineCap: .round, lineJoin: .round, dash: [6, 5])
        if pts.count >= 3 {
            // 三腳以上（按鈕、感測器）：畫元件本體的外框，不畫依腳序連起來的折線（看起來像導線）
            ctx.stroke(bodyRect(pts), with: .color(.white.opacity(0.85)), style: dash)
        } else {
            var path = Path()
            path.addLines(pts)
            ctx.stroke(path, with: .color(.white.opacity(0.85)), style: dash)
        }
    }

    /// 元件本體：腳位外接框外擴約半個孔距
    private func bodyRect(_ pts: [CGPoint]) -> Path {
        let x0 = pts.map(\.x).min()!, x1 = pts.map(\.x).max()!, y0 = pts.map(\.y).min()!, y1 = pts.map(\.y).max()!
        let m = pitch * 0.5
        return Path(roundedRect: CGRect(x: x0 - m, y: y0 - m, width: x1 - x0 + 2 * m, height: y1 - y0 + 2 * m),
                    cornerRadius: pitch * 0.25)
    }

    /// 已插好的元件：淡色本體（兩腳畫線、三腳以上畫外框）＋每腳灰點
    private func drawDonePart(_ ctx: inout GraphicsContext, _ part: LanProject.Part) {
        let pts = part.pins.compactMap { $0.hole }.compactMap(view)
        guard !pts.isEmpty else { return }
        let style = StrokeStyle(lineWidth: max(1, pitch * 0.22), lineCap: .round, lineJoin: .round)
        if pts.count >= 3 {
            ctx.stroke(bodyRect(pts), with: .color(.white.opacity(0.35)), style: StrokeStyle(lineWidth: max(1, pitch * 0.12)))
        } else if pts.count == 2 {
            var path = Path()
            path.addLines(pts)
            ctx.stroke(path, with: .color(.white.opacity(0.35)), style: style)
        }
        let d = max(1.5, pitch * 0.25)
        for p in pts {
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)),
                     with: .color(Color(white: 0.6)))
        }
    }

    // MARK: 導線

    private func drawWire(_ ctx: inout GraphicsContext, _ w: LanProject.Wire, size: CGSize, style: Style, tags: TagBoard) {
        let color = Color(hex: w.color)
        let a = w.from.hole.flatMap(view), b = w.to.hole.flatMap(view)
        if wires3D {
            // 線是 3D 的；只在開發板排針旁標腳位（推不出排針位置時才畫往外的箭頭）
            // 只有目前這一步標腳位；之前的線維持淡色、不標字
            guard style == .current else { return }
            for (end, other) in [(w.from, b), (w.to, a)] {
                guard let ref = end.pin else { continue }
                if let q = pinPoints[ref] {
                    // 往離開麵包板的方向放（不蓋到板子上印的欄號）
                    let bc = boardCenter, dv = CGPoint(x: q.x - bc.x, y: q.y - bc.y), dl = max(1, hypot(dv.x, dv.y))
                    let dir = boardRect.contains(q) ? CGPoint(x: 0, y: -1) : CGPoint(x: dv.x / dl, y: dv.y / dl)
                    drawTag(&ctx, project.text(end), size: size, fill: Color(hex: w.color).opacity(style == .current ? 0.92 : 0.6),
                            text: .white, stroke: true, placement: .along(anchor: q, dir: dir, gap: 12),
                            small: style != .current, ignoreBands: true, tags: tags)
                } else if let o = other {
                    drawPinArrow(&ctx, from: o, label: project.text(end), color: color, size: size, style: style, tags: tags)
                }
            }
            return
        }
        switch (a, b) {
        case let (a?, b?):
            let path = curve(a, b)
            stroke(&ctx, path, color: color, style: style)
            for k in 0...10 { if let q = path.trimmedPath(from: 0, to: CGFloat(k) / 10).currentPoint { tags.wirePts.append(q) } }
        case let (a?, nil):
            drawPinArrow(&ctx, from: a, label: project.text(w.to), color: color, size: size, style: style, tags: tags)
        case let (nil, b?):
            drawPinArrow(&ctx, from: b, label: project.text(w.from), color: color, size: size, style: style, tags: tags)
        default:
            break   // 兩端都不在麵包板上（或孔位看不到）：只在步驟卡顯示
        }
    }

    private func wireWidth(_ style: Style) -> CGFloat {
        style == .current ? max(3, pitch * 0.3) : max(2, pitch * 0.22)
    }

    /// 目前這條：淺色外框＋本色（深色地線 #1f2937 才看得到）。
    /// 完成的：陰影＋半透明本色＋細高光，像一條立體但退到背景的線。
    private func stroke(_ ctx: inout GraphicsContext, _ path: Path, color: Color, style: Style) {
        let w = wireWidth(style)
        let round = StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round)
        switch style {
        case .current:
            ctx.stroke(path, with: .color(.white.opacity(0.85)),
                       style: StrokeStyle(lineWidth: w + 4, lineCap: .round, lineJoin: .round))
            ctx.stroke(path, with: .color(color), style: round)
        case .done, .all:
            let k = style == .all ? 1.6 : 1.0
            ctx.stroke(path.offsetBy(dx: 1.2, dy: 2), with: .color(.black.opacity(0.35 * k)), style: round)
            ctx.stroke(path, with: .color(.white.opacity(0.14 * k)),
                       style: StrokeStyle(lineWidth: w + 1.5, lineCap: .round, lineJoin: .round))
            ctx.stroke(path, with: .color(color.opacity(0.42 * k)), style: round)
            ctx.stroke(path.offsetBy(dx: -w * 0.18, dy: -w * 0.22), with: .color(.white.opacity(0.18 * k)),
                       style: StrokeStyle(lineWidth: max(0.8, w * 0.25), lineCap: .round, lineJoin: .round))
        }
    }

    /// 兩孔之間的弧線，往板子外側拱
    private func curve(_ a: CGPoint, _ b: CGPoint) -> Path {
        let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        let dx = b.x - a.x, dy = b.y - a.y
        let len = max(1, hypot(dx, dy))
        var n = CGPoint(x: -dy / len, y: dx / len)
        let c = boardCenter
        if (mid.x - c.x) * n.x + (mid.y - c.y) * n.y < 0 { n = CGPoint(x: -n.x, y: -n.y) }
        let bow = min(len * 0.25, max(pitch * 1.2, len * 0.12))
        var p = Path()
        p.move(to: a)
        p.addQuadCurve(to: b, control: CGPoint(x: mid.x + n.x * bow, y: mid.y + n.y * bow))
        return p
    }

    private var boardCenter: CGPoint {
        let o = resolver.result.outline.map(map.view)
        guard !o.isEmpty else { return .zero }
        return CGPoint(x: o.map(\.x).reduce(0, +) / CGFloat(o.count), y: o.map(\.y).reduce(0, +) / CGFloat(o.count))
    }

    /// 接開發板的端點：從孔沿板子軸向往最近的板緣，畫成半透明膠囊箭頭，終點不超過板緣外 8pt，並標上腳位。
    private func drawPinArrow(_ ctx: inout GraphicsContext, from p: CGPoint, label: String, color: Color,
                              size: CGSize, style: Style, tags: TagBoard) {
        let r = resolver.result
        guard let a1 = r.hole(row: 0, col: 0), let aN = r.hole(row: 0, col: r.cols - 1),
              let j1 = r.hole(row: 9, col: 0) else { return }
        func unit(_ from: SIMD2<Double>, _ to: SIMD2<Double>) -> CGPoint {
            let q0 = map.view(from), q1 = map.view(to)
            let d = CGPoint(x: q1.x - q0.x, y: q1.y - q0.y), l = max(1e-6, hypot(d.x, d.y))
            return CGPoint(x: d.x / l, y: d.y / l)
        }
        let colDir = unit(a1.point, aN.point), rowDir = unit(a1.point, j1.point)
        // 板子（主區外框＋電源軌）的點
        var boardPts = r.outline.map(map.view)
        boardPts += r.rails.map { map.view($0.point) }
        func exit(_ d: CGPoint) -> CGFloat { boardPts.map { ($0.x - p.x) * d.x + ($0.y - p.y) * d.y }.max() ?? 0 }
        // 四個軸向裡離板緣最近的；從短邊（沿欄方向）出去稍微不偏好
        let dirs = [CGPoint(x: -rowDir.x, y: -rowDir.y), rowDir, CGPoint(x: -colDir.x, y: -colDir.y), colDir]
        let dir = dirs.enumerated().min { exit($0.element) * ($0.offset >= 2 ? 1.6 : 1) < exit($1.element) * ($1.offset >= 2 ? 1.6 : 1) }!.element
        let len = max(exit(dir) + pitch * 0.6 + 4, pitch * 1.5)    // 電源軌外緣再出去幾 pt（標籤欄在 8pt 外）
        let end = CGPoint(x: p.x + dir.x * len, y: p.y + dir.y * len)
        for k in 0...6 {
            tags.wirePts.append(CGPoint(x: p.x + (end.x - p.x) * CGFloat(k) / 6, y: p.y + (end.y - p.y) * CGFloat(k) / 6))
        }

        let cur = style == .current
        let alpha = cur ? 1.0 : (style == .all ? 0.75 : 0.5)
        let w = cur ? max(7, pitch * 0.62) : max(5, pitch * 0.45)
        // 膠囊身
        var body = Path()
        body.move(to: p)
        body.addLine(to: CGPoint(x: end.x - dir.x * w * 0.6, y: end.y - dir.y * w * 0.6))
        ctx.stroke(body, with: .color(.white.opacity(0.35 * alpha)),
                   style: StrokeStyle(lineWidth: w + 2, lineCap: .round))
        ctx.stroke(body, with: .color(color.opacity(0.55 * alpha)), style: StrokeStyle(lineWidth: w, lineCap: .round))
        // 箭頭
        let L = w * 1.5
        let back = CGPoint(x: end.x - dir.x * L, y: end.y - dir.y * L)
        let side = CGPoint(x: -dir.y * w * 1.05, y: dir.x * w * 1.05)
        var head = Path()
        head.move(to: end)
        head.addLine(to: CGPoint(x: back.x + side.x, y: back.y + side.y))
        head.addLine(to: CGPoint(x: back.x - side.x, y: back.y - side.y))
        head.closeSubpath()
        ctx.fill(head, with: .color(color.opacity(0.8 * alpha)))
        ctx.stroke(head, with: .color(.white.opacity(0.7 * alpha)), lineWidth: 1.2)

        // 腳位標籤：往左右出去的對齊在板子外的固定欄（左側靠右對齊、右側靠左對齊）
        let placement: TagPlacement = abs(dir.x) >= abs(dir.y)
            ? .column(edgeX: sideColumnX(left: dir.x < 0, size: size), rightAligned: dir.x < 0, y: end.y)
            : .along(anchor: end, dir: dir, gap: 4)
        drawTag(&ctx, label, size: size, fill: color.opacity(0.88 * alpha), text: .white.opacity(cur ? 1 : 0.85),
                stroke: true, placement: placement, small: !cur, tags: tags)
    }

    /// 圓角標籤：放在指定位置外側，和已畫的標籤／目標孔重疊就沿方向再推（最多 4 次）
    @discardableResult
    private func drawTag(_ ctx: inout GraphicsContext, _ s: String, size: CGSize, fill: Color, text: Color,
                         stroke: Bool = false, placement: TagPlacement, fallback: TagPlacement? = nil,
                         small: Bool = false, ignoreBands: Bool = false, tags: TagBoard) -> CGRect {
        let font = Font.system(size: small ? 11 : 13, weight: .semibold)
        let padX: CGFloat = small ? 5 : 7, padY: CGFloat = small ? 2 : 3
        // 標籤欄寬：欄的 x 到畫面邊；太窄就換行
        var maxText: CGFloat = 220
        switch placement {
        case let .column(edgeX, rightAligned, _):
            maxText = max(104, (rightAligned ? edgeX - 4 : size.width - edgeX - 4) - 2 * padX)   // 太窄時允許伸進主區（不在目標排）
        case .channel:
            maxText = 1000
        case .along, .near: break
        }
        var t = ctx.resolve(Text(s).font(font).foregroundStyle(text))
        var m = t.measure(in: CGSize(width: maxText, height: 200))
        if compact {
            // 單行、最寬 55% 畫面；太長先縮字（≥ 85%），再截成「…」
            let maxW = size.width * 0.55 - 2 * padX
            let base: CGFloat = small ? 11 : 13
            var str = s
            var fs = base
            func res() -> GraphicsContext.ResolvedText {
                ctx.resolve(Text(str).font(.system(size: fs, weight: .semibold)).foregroundStyle(text))
            }
            t = res(); m = t.measure(in: CGSize(width: 2000, height: 100))
            if m.width > maxW { fs = base * 0.85; t = res(); m = t.measure(in: CGSize(width: 2000, height: 100)) }
            while m.width > maxW, str.count > 2 {
                str = String(str.dropLast(2)) + "…"
                t = res(); m = t.measure(in: CGSize(width: 2000, height: 100))
            }
        }
        let w = m.width + 2 * padX, h = m.height + 2 * padY
        func rect(_ c: CGPoint) -> CGRect { CGRect(x: c.x - w / 2, y: c.y - h / 2, width: w, height: h) }
        func free(_ c: CGPoint, bands: Bool = true) -> Bool {
            let r = rect(c).insetBy(dx: -1, dy: -1)
            return !tags.placed.contains { $0.intersects(r) } && !(bands && !ignoreBands && tags.bands.contains { $0.intersects(r) })
        }
        var c: CGPoint
        switch placement {
        case let .channel(center, maxWidth):
            // 中央溝沒有孔，不受「目標排」限制；一行放不下（不換行）或撞到其他標籤就改用 fallback
            let oneLine = t.measure(in: CGSize(width: 1000, height: 200)).width + 2 * padX
            if oneLine <= maxWidth + 0.5, abs(w - oneLine) < 0.5, free(center, bands: false) {
                return finish(&ctx, t, rect(center), pad: CGSize(width: padX, height: padY), fill: fill, stroke: stroke, tags: tags)
            }
            if let fallback {
                return drawTag(&ctx, s, size: size, fill: fill, text: text, stroke: stroke, placement: fallback,
                               small: small, tags: tags)
            }
            c = center
        case let .along(anchor, dir0, gap):
            // 這個方向放不進畫面（孔太靠邊）就改試反方向、上下兩側
            let screen = CGRect(origin: .zero, size: size).insetBy(dx: 4, dy: 4)
            let tries = [dir0, CGPoint(x: -dir0.y, y: dir0.x), CGPoint(x: dir0.y, y: -dir0.x), CGPoint(x: -dir0.x, y: -dir0.y)]
            func center(_ d: CGPoint) -> CGPoint {
                let half = abs(d.x) * w / 2 + abs(d.y) * h / 2
                return CGPoint(x: anchor.x + d.x * (gap + half), y: anchor.y + d.y * (gap + half))
            }
            let dir = tries.first { screen.contains(rect(center($0))) } ?? dir0
            c = center(dir)
            for _ in 0..<4 where !free(c) { c.x += dir.x * (h + 4); c.y += dir.y * (h + 4) }
        case let .near(anchor, away, gap):
            let bounds = (safeRect ?? CGRect(origin: .zero, size: size)).insetBy(dx: safeRect == nil ? 4 : 16, dy: 4)
            let base = atan2(away.y, away.x)
            func leaderOK(_ q: CGPoint) -> Bool {
                let r = rect(q)
                let from = CGPoint(x: min(max(anchor.x, r.minX), r.maxX), y: min(max(anchor.y, r.minY), r.maxY))
                return !tags.crossesWire(from, anchor)
            }
            var found: CGPoint?
            pass: for strict in [true, false] {
                for extra in [CGFloat(0), 22, 48, 80, 120] {
                    for k in [0, 1, -1, 2, -2, 3, -3, 4] {
                        let ang = base + CGFloat(k) * .pi / 4
                        let d = CGPoint(x: cos(ang), y: sin(ang))
                        let half = abs(d.x) * w / 2 + abs(d.y) * h / 2
                        let q = CGPoint(x: anchor.x + d.x * (gap + extra + half), y: anchor.y + d.y * (gap + extra + half))
                        guard bounds.contains(rect(q)), free(q) else { continue }
                        if !strict || leaderOK(q) { found = q; break pass }
                    }
                }
            }
            c = found ?? CGPoint(x: anchor.x, y: anchor.y - gap - h / 2)
        case let .column(edgeX, rightAligned, y):
            c = CGPoint(x: rightAligned ? edgeX - w / 2 : edgeX + w / 2, y: y)
            c.x = min(max(c.x, w / 2 + 4), size.width - w / 2 - 4)
            // 撞到目標排或其他標籤：上下交替找最近的空位（間距至少 4pt）
            if !free(c) {
                let y0 = c.y
                for k in 1...12 {
                    let dy = CGFloat((k + 1) / 2) * 6 * (k % 2 == 1 ? 1 : -1)
                    let cand = CGPoint(x: c.x, y: y0 + dy)
                    if free(cand) { c = cand; break }
                    if k == 12 { c.y = y0 + 6 * 6 }
                }
                if !free(c) {
                    for k in 1...10 where !free(c) { c.y = y0 + CGFloat(k) * (h + 4) }
                }
            }
        }
        let bounds = (safeRect ?? CGRect(origin: .zero, size: size)).insetBy(dx: safeRect == nil ? 4 : 16, dy: 4)
        c.x = min(max(c.x, bounds.minX + w / 2), bounds.maxX - w / 2)
        c.y = min(max(c.y, bounds.minY + h / 2), bounds.maxY - h / 2)
        return finish(&ctx, t, rect(c), pad: CGSize(width: padX, height: padY), fill: fill, stroke: stroke, tags: tags)
    }

    private func finish(_ ctx: inout GraphicsContext, _ t: GraphicsContext.ResolvedText, _ r: CGRect, pad: CGSize,
                        fill: Color, stroke: Bool, tags: TagBoard) -> CGRect {
        tags.placed.append(r)
        let shape = Path(roundedRect: r, cornerRadius: min(r.height / 2, 10))
        ctx.fill(shape, with: .color(fill))
        if stroke { ctx.stroke(shape, with: .color(.white.opacity(0.25)), lineWidth: 1) }
        // 多留 1pt 給排版誤差，避免換行後被截成「…」
        ctx.draw(t, in: r.insetBy(dx: pad.width - 1, dy: pad.height - 1))
        return r
    }
}

/// 標籤位置：沿某方向放在錨點外側、對齊板外的一條直欄，或放在中央溝
enum TagPlacement {
    case along(anchor: CGPoint, dir: CGPoint, gap: CGFloat)
    case column(edgeX: CGFloat, rightAligned: Bool, y: CGFloat)
    case channel(center: CGPoint, maxWidth: CGFloat)
    /// AR：在孔附近找位置（優先「離同一步其他孔」的方向），不蓋孔／開發板／其他標籤，引線盡量不穿過導線
    case near(anchor: CGPoint, away: CGPoint, gap: CGFloat)
}

/// 同一幀已畫的標籤外框、不能放標籤的目標排、已畫導線的取樣點
final class TagBoard {
    var placed: [CGRect] = []
    var bands: [CGRect] = []
    var wirePts: [CGPoint] = []
    var wirePolys: [[CGPoint]] = []

    /// 線段 a–b 會不會穿過任何一條已畫的導線
    func crossesWire(_ a: CGPoint, _ b: CGPoint) -> Bool {
        func ccw(_ p: CGPoint, _ q: CGPoint, _ r: CGPoint) -> CGFloat { (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) }
        for poly in wirePolys where poly.count >= 2 {
            for i in 0..<(poly.count - 1) {
                let c = poly[i], d = poly[i + 1]
                if ccw(a, b, c) * ccw(a, b, d) < 0, ccw(c, d, a) * ccw(c, d, b) < 0 { return true }
            }
        }
        return false
    }
}

extension Color {
    /// "#d6484d"／"d6484d"／"#abc"；看不懂就用洋紅
    init(hex: String?) {
        var s = (hex ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else {
            let named: [String: Color] = ["red": .red, "black": .black, "blue": .blue, "green": .green,
                                          "yellow": .yellow, "orange": .orange, "white": .white, "purple": .purple]
            self = named[s] ?? .pink
            return
        }
        self = Color(red: Double(v >> 16 & 255) / 255, green: Double(v >> 8 & 255) / 255, blue: Double(v & 255) / 255)
    }
}
