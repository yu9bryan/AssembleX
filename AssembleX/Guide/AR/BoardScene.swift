import RealityKit
import SwiftUI
import UIKit
import simd

/// 麵包板 3D 場景：一個錨點（麵包板座標原點），底下 `mm` 節點縮放 0.001，所有內容都用桌面的 mm 座標。
/// - 元件、開發板：USDZ（已套 profile 的 model_transform，原點＝元件原點）→ translate(poseMm.position)·rotateY
/// - 導線：3D 弧形細管（協定顏色＋淡白外殼）；接開發板的端點接到排針位置
/// - 步驟：完成的實心、目前的半透明脈動、之後的隱藏（「全部接線」時淡淡顯示）
@MainActor
final class BoardScene {
    let anchor: AnchorEntity
    let mm = Entity()
    private(set) var project: LanProject
    private var parts: [String: Entity] = [:]       // part id → 模型
    private var wires: [String: Entity] = [:]       // wire id → 管子
    private var boardModel: Entity?
    /// 3D 示範（不是 AR）
    private var demo = false
    private var boardPins: [String: SIMD3<Float>] = [:]   // "mcu1.5V" → mm（板子座標）

    var surfaceY: Float { Float(project.breadboard?.sizeMm?[safe: 1] ?? 8.5) }

    init(project: LanProject, anchor: AnchorEntity, showBoardBody: Bool) {
        self.project = project
        self.anchor = anchor
        mm.scale = SIMD3(repeating: 0.001)
        anchor.addChild(mm)
        if showBoardBody { addBoardBody() }
        demo = showBoardBody
        computeBoardPins()
        computeExternalEnds()
        buildWires()
    }

    // MARK: 載入模型

    func loadModels() async {
        if let b = project.board, let model = b.model, let pose = b.poseMm, let e = await Self.load(model) {
            place(e, pose)
            mm.addChild(e)
            boardModel = e
        }
        for p in project.parts {
            guard let pose = p.poseMm else { continue }
            if let model = p.model, let e = await Self.load(model) {
                decorate(e, part: p, model: model)
                place(e, pose)
                e.isEnabled = false
                mm.addChild(e)
                parts[p.id] = e
            } else if p.offBoard == true || !(p.modelParts ?? []).isEmpty, let g = datasheetBody(p, pose) {
                // 規格書元件／板外元件：和桌面一樣用基本形狀畫（不是黑色方塊）
                g.isEnabled = false
                mm.addChild(g)
                parts[p.id] = g
            } else if let g = placeholder(p, pose) {
                g.isEnabled = false
                mm.addChild(g)
                parts[p.id] = g
            }
        }
    }

    // MARK: 模型細節（和桌面一致）

    private func decorate(_ e: Entity, part p: LanProject.Part, model: String) {
        if model == "dht22" { dhtDetails(e) }
        if model == "resistor_axial" { resistorBands(e, ohm: resistance(of: p)) }
    }

    /// DHT22：白殼（#d9d9d4，粗糙 0.6）＋正反面 5×4 方孔格柵（約 1.6 mm、間距 2.5 mm、看起來凹 0.8 mm）＋上方圓孔
    private func dhtDetails(_ e: Entity) {
        var shell = PhysicallyBasedMaterial()
        shell.baseColor = .init(tint: UIColor(hex: "#d9d9d4")); shell.roughness = 0.6
        func walk(_ n: Entity) {
            if n.name.contains("BODY_shell"), var mc = n.components[ModelComponent.self] {
                mc.materials = mc.materials.map { _ in shell }
                n.components.set(mc)
            }
            n.children.forEach(walk)
        }
        walk(e)
        // 本體範圍（模型座標）：x −3.74…11.36、y 3.4…28.4、z ±3.85
        let cx: Float = 3.81, z: Float = 3.85
        var pos: [SIMD3<Float>] = [], idx: [UInt32] = [], nor: [SIMD3<Float>] = []
        var deep: [SIMD3<Float>] = [], deepIdx: [UInt32] = [], deepNor: [SIMD3<Float>] = []
        func square(_ c: SIMD3<Float>, _ half: Float, _ n: Float, into p: inout [SIMD3<Float>], _ i: inout [UInt32], _ nn: inout [SIMD3<Float>]) {
            let b = UInt32(p.count)
            p += [c + SIMD3(-half, -half, 0), c + SIMD3(half, -half, 0), c + SIMD3(half, half, 0), c + SIMD3(-half, half, 0)]
            nn += Array(repeating: SIMD3(0, 0, n), count: 4)
            i += n > 0 ? [b, b + 1, b + 2, b, b + 2, b + 3] : [b, b + 2, b + 1, b, b + 3, b + 2]
        }
        for side: Float in [1, -1] {
            for r in 0..<5 { for c in 0..<4 {
                let center = SIMD3(cx + (Float(c) - 1.5) * 2.5, 9.5 + Float(r) * 2.5, side * (z + 0.04))
                square(center, 0.8, side, into: &pos, &idx, &nor)                       // 孔口（深灰）
                square(center + SIMD3(0.12, -0.12, side * 0.01), 0.55, side, into: &deep, &deepIdx, &deepNor)  // 井底（近黑，偏一點像有深度）
            } }
            // 上方圓孔
            let hc = SIMD3(cx, 25.6, side * (z + 0.05))
            let b = UInt32(deep.count)
            deep.append(hc); deepNor.append(SIMD3(0, 0, side))
            for k in 0...20 {
                let a = Float(k) / 20 * 2 * .pi
                deep.append(hc + SIMD3(cos(a) * 1.25, sin(a) * 1.25, 0)); deepNor.append(SIMD3(0, 0, side))
                if k > 0 { deepIdx += side > 0 ? [b, b + UInt32(k), b + UInt32(k + 1)] : [b, b + UInt32(k + 1), b + UInt32(k)] }
            }
        }
        for (p, i, n, color) in [(pos, idx, nor, "#3a3b3e"), (deep, deepIdx, deepNor, "#141416")] {
            var d = MeshDescriptor(name: "grille")
            d.positions = MeshBuffers.Positions(p); d.normals = MeshBuffers.Normals(n); d.primitives = .triangles(i)
            guard let mesh = try? MeshResource.generate(from: [d]) else { continue }
            var m = PhysicallyBasedMaterial(); m.baseColor = .init(tint: UIColor(hex: color)); m.roughness = 0.8
            e.addChild(ModelEntity(mesh: mesh, materials: [m]))
        }
    }

    /// 阻值：payload parameters.resistance_ohm → 步驟標題裡的「10kΩ」→ 預設 1 kΩ（棕黑紅金）
    private func resistance(of p: LanProject.Part) -> Double {
        if let v = p.parameters?.resistance_ohm { return v }
        let texts = [p.name ?? ""] + project.steps.filter { $0.targetId == p.id }.map(\.title)
        for t in texts {
            if let r = t.range(of: #"(\d+(?:\.\d+)?)\s*([kKM]?)Ω"#, options: .regularExpression) {
                let s = String(t[r])
                let num = Double(s.filter { "0123456789.".contains($0) }) ?? 0
                let mult: Double = s.contains("M") ? 1e6 : (s.lowercased().contains("k") ? 1e3 : 1)
                if num > 0 { return num * mult }
            }
        }
        return 1000
    }

    /// 四環色碼（同桌面 colorBands／Bands：本體 x 1.93–8.23、半徑 1.25、中心高 1.25）
    private func resistorBands(_ e: Entity, ohm: Double) {
        let band = ["#1a1a1a", "#8b4513", "#d93025", "#e8710a", "#f4c20d", "#2e9e4f", "#2a63c9", "#8a4fbd", "#9aa0a6", "#f5f5f5"]
        let ex = max(0, Int(floor(log10(max(ohm, 1)))) - 1)
        let sig = Int((ohm / pow(10, Double(ex))).rounded())
        let colors = [band[(sig / 10) % 10], band[sig % 10], band[ex % 10], "#c9a227"]
        for (i, c) in colors.enumerated() {
            var m = PhysicallyBasedMaterial(); m.baseColor = .init(tint: UIColor(hex: c)); m.roughness = 0.42
            let ring = ModelEntity(mesh: .generateCylinder(height: 0.5, radius: 1.27), materials: [m])
            ring.position = SIMD3(5.08 + [-2.1, -1.25, -0.4, 1.9][i], 1.25, 0)
            ring.orientation = simd_quatf(angle: .pi / 2, axis: SIMD3(0, 0, 1))
            e.addChild(ring)
        }
    }

    /// 桌面 datasheetShape 的畫法：
    /// - 有 modelParts：一組基本形狀（原點＝本體底面中心）
    /// - 沒有：中性灰圓角方塊（bbox 大小，「外形示意」）
    /// 本體位置：板外（排線）元件在 (cx, 0, zMax + 2.5 + d/2)（接頭在腳位那一排、本體往 +z 延伸），
    /// 其他在 (cx, 5, z0 + d/2)；腳位座標手機沒有，用 cx＝0、zMax＝0（LD06 腳位在 x 0–4.5、z 0）。
    /// 整組再照 poseMm 繞 Y 轉、平移（和桌面同一個座標系，所以和孔位、導線對得上）。
    private func datasheetBody(_ p: LanProject.Part, _ pose: LanProject.PoseMm) -> Entity? {
        let b = p.bboxMm ?? [30, 20, 30]
        let w = Float(b[safe: 0] ?? 30), h = Float(b[safe: 1] ?? 20), d = Float(b[safe: 2] ?? 30)
        let cable = p.offBoard == true
        let root = Entity()
        place(root, pose)
        let body = Entity()
        body.position = cable ? SIMD3(0, 0, 2.5 + d / 2) : SIMD3(0, 5, d / 2)
        root.addChild(body)
        if let shapes = p.modelParts, !shapes.isEmpty {
            for m in shapes { if let e = Self.primitive(m) { body.addChild(e) } }
        } else {
            var mat = PhysicallyBasedMaterial()
            mat.baseColor = .init(tint: UIColor(hex: "#8e9197")); mat.roughness = 0.7
            let r = max(0.3, min(2, w * 0.08, h * 0.15, d * 0.08))
            let e = ModelEntity(mesh: .generateBox(width: w, height: max(1, h), depth: d, cornerRadius: r), materials: [mat])
            e.position = SIMD3(0, max(1, h) / 2, 0)
            body.addChild(e)
        }
        if cable {
            // 接頭：腳位那一排的小插座
            var dark = PhysicallyBasedMaterial()
            dark.baseColor = .init(tint: UIColor(hex: "#f2f2ee")); dark.roughness = 0.6
            let n = Float(max(1, p.pins.count))
            let sock = ModelEntity(mesh: .generateBox(width: n * 1.5 + 2, height: 3, depth: 4, cornerRadius: 0.3), materials: [dark])
            sock.position = SIMD3(0, 1.5, 0.5)
            root.addChild(sock)
        }
        return root
    }

    /// 一個基本形狀（同桌面 buildModel：position 的 y 是底面，畫的時候換成中心）
    private static func primitive(_ m: LanProject.ModelPart) -> ModelEntity? {
        guard let shape = m.shape, let size = m.size, let a0 = size.first else { return nil }
        let a = Float(a0), b = Float(size[safe: 1] ?? a0), c = Float(size[safe: 2] ?? a0)
        var mat = PhysicallyBasedMaterial()
        let color = UIColor(hex: m.color ?? "#8e9197")
        mat.baseColor = .init(tint: color)
        switch m.material {
        case "metal": mat.metallic = 0.6; mat.roughness = 0.35
        case "rubber": mat.roughness = 0.95
        case "glass": mat.roughness = 0.08; mat.blending = .transparent(opacity: 0.55)
        default: mat.roughness = 0.6
        }
        let mesh: MeshResource, cy: Float
        var scaleY: Float = 1
        switch shape {
        case "box": mesh = .generateBox(width: a, height: b, depth: c); cy = b / 2
        case "rounded_box": mesh = .generateBox(width: a, height: b, depth: c, cornerRadius: max(0.2, min(a, b, c) * 0.12)); cy = b / 2
        case "cylinder": mesh = .generateCylinder(height: b, radius: a / 2); cy = b / 2
        case "cone": mesh = .generateCone(height: b, radius: a / 2); cy = b / 2
        case "dome": mesh = .generateSphere(radius: a / 2); cy = 0; scaleY = max(0.1, b / (a / 2))   // 半球：下半埋在底下
        case "torus": mesh = .generateCylinder(height: b, radius: a / 2); cy = b / 2                    // 沒有內建環面：用扁圓柱代替
        default: mesh = .generateBox(width: a, height: b, depth: c); cy = b / 2
        }
        let e = ModelEntity(mesh: mesh, materials: [mat])
        let pos = m.position ?? [0, 0, 0]
        e.position = SIMD3(Float(pos[safe: 0] ?? 0), Float(pos[safe: 1] ?? 0) + cy, Float(pos[safe: 2] ?? 0))
        if scaleY != 1 { e.scale = SIMD3(1, scaleY, 1) }
        if let r = m.rotation_deg, r.count == 3 {
            // three.js 預設 XYZ 順序
            let rad = r.map { Float($0) * .pi / 180 }
            e.orientation = simd_quatf(angle: rad[0], axis: SIMD3(1, 0, 0)) * simd_quatf(angle: rad[1], axis: SIMD3(0, 1, 0))
                * simd_quatf(angle: rad[2], axis: SIMD3(0, 0, 1))
        }
        return e
    }

    /// 沒有模型的元件（v1.3）：bboxMm 方塊（底面在板面、角落在元件原點，同桌面 placeholder）＋每隻腳一根 2 mm 插針
    private func placeholder(_ p: LanProject.Part, _ pose: LanProject.PoseMm) -> Entity? {
        guard let b = p.bboxMm, b.count >= 3 else { return nil }
        let group = Entity()
        var m = PhysicallyBasedMaterial()
        m.baseColor = .init(tint: UIColor(hex: p.color ?? "#4b5563")); m.roughness = 0.55
        let w = Float(b[0]), h = Float(b[1]), d = Float(b[2])
        let body = ModelEntity(mesh: .generateBox(width: w, height: h, depth: d, cornerRadius: min(0.6, min(w, d) * 0.1)),
                               materials: [m])
        body.position = SIMD3(w / 2, h / 2, d / 2)
        let partRoot = Entity()
        place(partRoot, pose)
        partRoot.addChild(body)
        group.addChild(partRoot)
        var metal = PhysicallyBasedMaterial()
        metal.baseColor = .init(tint: UIColor(hex: "#c9ccd1")); metal.metallic = 0.9; metal.roughness = 0.3
        for pin in p.pins {
            guard let hp = pin.hole.flatMap(hole) else { continue }
            let e = ModelEntity(mesh: .generateCylinder(height: 3.5, radius: 0.32), materials: [metal])
            e.position = hp + SIMD3(0, 0.25, 0)
            group.addChild(e)
        }
        return group
    }

    private static var cache: [String: Entity] = [:]

    private static func load(_ model: String) async -> Entity? {
        if let c = cache[model] { return c.clone(recursive: true) }
        guard let url = Bundle.main.url(forResource: model, withExtension: "usdz"),
              let e = try? await Entity(contentsOf: url) else { return nil }
        cache[model] = e
        return e.clone(recursive: true)
    }

    private func place(_ e: Entity, _ pose: LanProject.PoseMm) {
        let p = pose.position
        e.position = SIMD3(Float(p[safe: 0] ?? 0), Float(p[safe: 1] ?? 0), Float(p[safe: 2] ?? 0))
        e.orientation = simd_quatf(angle: Float((pose.rotationDeg ?? 0) * .pi / 180), axis: SIMD3(0, 1, 0))
    }

    // MARK: 位置

    /// 孔口（mm，板子座標）
    func hole(_ id: String) -> SIMD3<Float>? {
        guard let xz = project.holes?[id] ?? project.holes?[id.uppercased()], xz.count >= 2 else { return nil }
        return SIMD3(Float(xz[0]), surfaceY, Float(xz[1]))
    }

    /// 開發板排針（mm，板子座標）："mcu1.5V"
    func pin(_ ref: String) -> SIMD3<Float>? { boardPins[ref] }

    /// 外接元件（不插麵包板，例如 LD06 用 ZH1.5 排線）：排線另一頭的杜邦頭沿「面向麵包板的那一邊」每 2.54 mm 一個，
    /// 導線從這些點出發（和桌面 routing.ts 的 cableEnd 同一個想法；位置是近似）
    private func computeExternalEnds() {
        // 桌面有給腳位端點座標（posMm）就直接用（排線末端的杜邦頭）
        for w in project.wires {
            for e in [w.from, w.to] {
                guard let ref = e.pin, let v = e.posMm, v.count >= 3 else { continue }
                boardPins[ref] = SIMD3(Float(v[0]), Float(v[1]), Float(v[2]))
            }
        }
        let size = project.breadboard?.sizeMm ?? [165.1, 8.5, 54.4]
        let boardMid = SIMD2(Float(size[safe: 0] ?? 165.1) / 2, Float(size[safe: 2] ?? 54.4) / 2)
        for p in project.parts where !p.pins.isEmpty && p.pins.allSatisfy({ $0.hole == nil }) {
            guard let pose = p.poseMm else { continue }
            let b = p.bboxMm ?? [30, 20, 30]
            let hw = Float(b[safe: 0] ?? 30) / 2, hd = Float(b[safe: 2] ?? 30) / 2
            // 元件原點在包圍盒的角（和方塊替身同一個約定）：中心＝原點＋半個尺寸
            let c = SIMD3(Float(pose.position[safe: 0] ?? 0) + hw, Float(pose.position[safe: 1] ?? 0), Float(pose.position[safe: 2] ?? 0) + hd)
            // 面向麵包板：x 方向離板子比較遠就用 x 邊，否則用 z 邊
            let dx = boardMid.x - c.x, dz = boardMid.y - c.z
            let n = Float(p.pins.count), y = surfaceY + 2
            for (k, pin) in p.pins.enumerated() {
                let off = (Float(k) - (n - 1) / 2) * 2.54
                let pt: SIMD3<Float> = abs(dx) >= abs(dz)
                    ? SIMD3(c.x + (dx > 0 ? hw + 6 : -hw - 6), y, c.z + off)
                    : SIMD3(c.x + off, y, c.z + (dz > 0 ? hd + 6 : -hd - 6))
                if boardPins["\(p.id).\(pin.pin)"] == nil { boardPins["\(p.id).\(pin.pin)"] = pt }
            }
        }
    }

    private func computeBoardPins() {
        guard let b = project.board, let pid = b.profileId, let pose = b.poseMm,
              let pins = ModelCatalog.shared.pins[pid] else { return }
        let rot = simd_quatf(angle: Float((pose.rotationDeg ?? 0) * .pi / 180), axis: SIMD3(0, 1, 0))
        let origin = SIMD3(Float(pose.position[safe: 0] ?? 0), Float(pose.position[safe: 1] ?? 0), Float(pose.position[safe: 2] ?? 0))
        // 接線端點用的是 "<instance>.<pin>"；instance 從導線資料找（不是元件的那個就是開發板）
        let partIds = Set(project.parts.map(\.id))
        for w in project.wires {
            for e in [w.from, w.to] {
                guard let ref = e.pin, let dot = ref.firstIndex(of: ".") else { continue }
                let inst = String(ref[..<dot]), name = String(ref[ref.index(after: dot)...])
                guard !partIds.contains(inst), let local = pins[name], local.count >= 3 else { continue }
                boardPins[ref] = origin + rot.act(SIMD3(Float(local[0]), Float(local[1]), Float(local[2])))
            }
        }
    }

    /// 板子座標（mm）→ 世界（m）
    func world(_ p: SIMD3<Float>) -> SIMD3<Float> { mm.convert(position: p, to: nil) }

    // MARK: 麵包板本體（模擬／3D 示範才畫；AR 時是真的板子）

    private func addBoardBody() {
        let size = project.breadboard?.sizeMm ?? [165.1, 8.5, 54.4]
        let W = Float(size[safe: 0] ?? 165.1), H = Float(size[safe: 1] ?? 8.5), D = Float(size[safe: 2] ?? 54.4)
        var plastic = PhysicallyBasedMaterial()
        plastic.baseColor = .init(tint: UIColor(hex: "#26272a"))
        plastic.roughness = 0.55
        plastic.metallic = .init(floatLiteral: 0)
        let body = ModelEntity(mesh: .generateBox(width: W, height: H, depth: D, cornerRadius: 1.2), materials: [plastic])
        body.position = SIMD3(W / 2, H / 2, D / 2)
        mm.addChild(body)

        // ＋／−軌色帶（0.35，抬高 0.05 mm 避免 z-fighting）
        for (prefix, color) in [("BOT+", "#d0342c"), ("BOT-", "#2563a8"), ("TOP+", "#d0342c"), ("TOP-", "#2563a8")] {
            let pts = (project.holes ?? [:]).filter { $0.key.hasPrefix(prefix) }.map { $0.value }
            guard let x0 = pts.map({ $0[0] }).min(), let x1 = pts.map({ $0[0] }).max(), let z = pts.first?[1] else { continue }
            var m = UnlitMaterial(color: UIColor(hex: color))
            m.blending = .transparent(opacity: 0.35)
            let band = ModelEntity(mesh: .generatePlane(width: Float(x1 - x0 + 2.54), depth: 2.4), materials: [m])
            band.position = SIMD3(Float(x0 + x1) / 2, H + 0.05, Float(z))
            mm.addChild(band)
        }

        // 絲印（列標 A–J 兩端、每 5 欄欄號、軌道 ＋／− 與色線），和桌面 breadboardSilk 同樣位置
        if let tex = silkTexture(W: W, D: D) {
            var m = UnlitMaterial()
            m.color = .init(tint: .white, texture: .init(tex))
            m.blending = .transparent(opacity: .init(floatLiteral: 1))
            let silk = ModelEntity(mesh: .generatePlane(width: W, depth: D), materials: [m])
            silk.position = SIMD3(W / 2, H + 0.07, D / 2)
            mm.addChild(silk)
        }

        // 孔：外圈斜面（較亮）＋內井（近黑），看起來是凹下去的方孔
        var pos: [SIMD3<Float>] = [], col: [SIMD3<Float>] = [], idx: [UInt32] = []
        func quad(_ c: SIMD3<Float>, _ s: Float, _ y: Float) {
            let base = UInt32(pos.count)
            pos += [SIMD3(c.x - s, y, c.z - s), SIMD3(c.x + s, y, c.z - s), SIMD3(c.x + s, y, c.z + s), SIMD3(c.x - s, y, c.z + s)]
            idx += [base, base + 2, base + 1, base, base + 3, base + 2]
        }
        var bevel: [SIMD3<Float>] = [], bevelIdx: [UInt32] = []
        for (_, xz) in project.holes ?? [:] where xz.count >= 2 {
            let c = SIMD3(Float(xz[0]), 0, Float(xz[1]))
            let b0 = UInt32(bevel.count), s: Float = 0.95
            bevel += [SIMD3(c.x - s, H + 0.09, c.z - s), SIMD3(c.x + s, H + 0.09, c.z - s),
                      SIMD3(c.x + s, H + 0.09, c.z + s), SIMD3(c.x - s, H + 0.09, c.z + s)]
            bevelIdx += [b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2]
            quad(c, 0.6, H + 0.1)
        }
        _ = col
        for (points, indices, color) in [(bevel, bevelIdx, "#121315"), (pos, idx, "#030304")] where !points.isEmpty {
            var d = MeshDescriptor(name: "holes")
            d.positions = MeshBuffers.Positions(points)
            d.normals = MeshBuffers.Normals(Array(repeating: SIMD3(0, 1, 0), count: points.count))
            d.primitives = .triangles(indices)
            if let mesh = try? MeshResource.generate(from: [d]) {
                mm.addChild(ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: UIColor(hex: color))]))
            }
        }
    }

    /// 絲印貼圖（每 mm 12 px，x→寬、z→高）
    private func silkTexture(W: Float, D: Float) -> TextureResource? {
        let ppm: CGFloat = 12
        let size = CGSize(width: CGFloat(W) * ppm, height: CGFloat(D) * ppm)
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = false
        let holes = project.holes ?? [:]
        let cols = project.columns
        func xz(_ id: String) -> CGPoint? { holes[id].map { CGPoint(x: $0[0] * ppm, y: $0[1] * ppm) } }
        let img = UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in
            let g = ctx.cgContext
            let silk = UIColor(hex: "#d8d6d0")
            func text(_ s: String, _ p: CGPoint, _ fontMM: CGFloat, _ weight: UIFont.Weight, _ color: UIColor, rotate: CGFloat = 0) {
                let a: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: fontMM * ppm, weight: weight), .foregroundColor: color]
                let str = NSAttributedString(string: s, attributes: a)
                let b = str.size()
                if rotate == 0 { str.draw(at: CGPoint(x: p.x - b.width / 2, y: p.y - b.height / 2)); return }
                g.saveGState()
                g.translateBy(x: p.x, y: p.y)
                g.rotate(by: rotate)
                str.draw(at: CGPoint(x: -b.width / 2, y: -b.height / 2))
                g.restoreGState()
            }
            // 3D 示範的預設視角是「第 1 欄在上」：字母、欄號轉 90°，從畫面上看是正的
            let upright: CGFloat = -.pi / 2
            // 列標 A–J（兩端）
            for r in BreadboardResult.rowLetters {
                guard let a = xz("\(r)1"), let b = xz("\(r)\(cols)") else { continue }
                text(r, CGPoint(x: a.x - 3.4 * ppm, y: a.y), 1.9, .semibold, silk, rotate: upright)
                text(r, CGPoint(x: b.x + 3.4 * ppm, y: b.y), 1.9, .semibold, silk, rotate: upright)
            }
            // 欄號（1 與每 5 欄），A 列外與 J 列外
            for c in 1...max(1, cols) where c == 1 || c % 5 == 0 {
                guard let a = xz("A\(c)"), let j = xz("J\(c)") else { continue }
                text("\(c)", CGPoint(x: a.x, y: a.y - 2.6 * ppm), 1.75, .medium, silk, rotate: upright)
                text("\(c)", CGPoint(x: j.x, y: j.y + 2.6 * ppm), 1.75, .medium, silk, rotate: upright)
            }
            // 電源軌：色線＋符號（色線在每條軌離另一條軌較遠的那側）
            for (prefix, color, sign, off) in [("BOT-", "#2563a8", "−", -2.1), ("BOT+", "#d0342c", "+", 2.1),
                                               ("TOP+", "#d0342c", "+", -2.1), ("TOP-", "#2563a8", "−", 2.1)] {
                let pts = holes.filter { $0.key.hasPrefix(prefix) }.map { CGPoint(x: $0.value[0] * ppm, y: $0.value[1] * ppm) }
                guard let x0 = pts.map(\.x).min(), let x1 = pts.map(\.x).max(), let z = pts.first?.y else { continue }
                let c = UIColor(hex: color)
                g.setStrokeColor(c.withAlphaComponent(0.85).cgColor)
                g.setLineWidth(0.45 * ppm)
                g.move(to: CGPoint(x: x0 - 4 * ppm, y: z + CGFloat(off) * ppm))
                g.addLine(to: CGPoint(x: x1 + 4 * ppm, y: z + CGFloat(off) * ppm))
                g.strokePath()
                text(sign, CGPoint(x: x0 - 7 * ppm, y: z), 2.8, .bold, c)
                text(sign, CGPoint(x: x1 + 7 * ppm, y: z), 2.8, .bold, c)
            }
        }
        guard let cg = img.cgImage else { return nil }
        return try? TextureResource(image: cg, options: .init(semantic: .color))
    }

    // MARK: 導線

    /// 導線：照桌面的走法（垂直拉起 → 水平 → 垂直落下，轉角倒圓），兩端各一根 2 mm 金屬針插進孔／排針
    private func buildWires() {
        let holes = (project.holes ?? [:]).values
        let boardZ0 = Float(holes.map { $0[1] }.min() ?? 0) - 3      // 板子後緣（A 側外）
        let s = surfaceY
        var metal = PhysicallyBasedMaterial()
        metal.baseColor = .init(tint: UIColor(hex: "#c9ccd1")); metal.metallic = 0.9; metal.roughness = 0.3
        for (k, w) in project.wires.enumerated() {
            // 桌面佈線好的折線：照著畫（板外元件、開發板的線都接得到）
            if let pm = w.pathMm {
                let pts = pm.compactMap { $0.count >= 3 ? SIMD3(Float($0[0]), Float($0[1]), Float($0[2])) : nil }
                if pts.count >= 2 {
                    addWire(w, path: Self.rounded(Self.dedupe(pts)), ends: [pts[0], pts[pts.count - 1]], pinLen: 2, metal: metal)
                    continue
                }
            }
            let fromHole = w.from.hole.flatMap(hole), toHole = w.to.hole.flatMap(hole)
            let fromPin = w.from.pin.flatMap(pin), toPin = w.to.pin.flatMap(pin)
            guard let a0 = fromHole ?? fromPin, let b0 = toHole ?? toPin else { continue }
            let pinLen: Float = 2
            let a = a0 + SIMD3(0, pinLen, 0), b = b0 + SIMD3(0, pinLen, 0)
            var pts: [SIMD3<Float>]
            if fromHole != nil, toHole != nil {
                // 板內跳線：L 形平躺，層高依順序錯開
                let h = s + 1.2 + 2.4 * Float(k % 3) + pinLen
                pts = [a, SIMD3(a.x, h, a.z), SIMD3(b.x, h, a.z), SIMD3(b.x, h, b.z), b]
            } else {
                // 開發板：垂直拉起到杜邦頭上方 → 沿板子後緣外 → 降到板面 → 走到孔
                let (hdr, hole) = fromPin != nil ? (a, b) : (b, a)
                // 離開開發板 PCB 之前都要高於排針頂＋2 mm（也高於板上元件）
                let pcbTop = boardModelCorners.map(\.y).max() ?? hdr.y
                let hH = max(max(hdr.y, pcbTop) + 2, s + 9) + 4 + 1.2 * Float(k % 4)
                let z = boardZ0 - 2 - 1.6 * Float(k % 4)
                let low = s + 1.2 + pinLen + 1.2 * Float(k % 4)
                pts = [hdr, SIMD3(hdr.x, hH, hdr.z), SIMD3(hdr.x, hH, z), SIMD3(hole.x, hH, z), SIMD3(hole.x, low, z),
                       SIMD3(hole.x, low, hole.z), hole]
                if fromPin == nil { pts.reverse() }
            }
            addWire(w, path: Self.rounded(Self.dedupe(pts)), ends: [a0, b0], pinLen: pinLen, metal: metal)
        }
    }

    private func addWire(_ w: LanProject.Wire, path: [SIMD3<Float>], ends: [SIMD3<Float>], pinLen: Float, metal: PhysicallyBasedMaterial) {
        do {
            wirePaths[w.id] = path
            let e = Entity()
            if let core = Self.tube(path, radius: 0.8), let shell = Self.tube(path, radius: 1.1) {
                let color = UIColor(hex: w.color ?? "#e0e0e0")
                var m = PhysicallyBasedMaterial()
                m.baseColor = .init(tint: color); m.roughness = 0.45; m.metallic = .init(floatLiteral: 0)
                e.addChild(ModelEntity(mesh: core, materials: [m]))
                var outline = UnlitMaterial(color: .white)
                outline.blending = .transparent(opacity: 0.22)
                e.addChild(ModelEntity(mesh: shell, materials: [outline]))
            }
            for p in ends {
                let pinE = ModelEntity(mesh: .generateCylinder(height: pinLen + 1.5, radius: 0.32), materials: [metal])
                pinE.position = p + SIMD3(0, (pinLen - 1.5) / 2, 0)
                e.addChild(pinE)
            }
            e.isEnabled = false
            mm.addChild(e)
            wires[w.id] = e
        }
    }

    private static func dedupe(_ p: [SIMD3<Float>]) -> [SIMD3<Float>] {
        var out: [SIMD3<Float>] = []
        for q in p where out.last.map({ simd_distance($0, q) > 1e-3 }) ?? true { out.append(q) }
        // 去掉共線中間點
        var i = 1
        while i < out.count - 1 {
            let u = simd_normalize(out[i] - out[i - 1]), v = simd_normalize(out[i + 1] - out[i])
            if simd_dot(u, v) > 0.9999 { out.remove(at: i) } else { i += 1 }
        }
        return out
    }

    /// 轉角倒圓（同桌面 routedWireGeometry：二次貝茲，半徑依兩側線段長度縮放）
    private static func rounded(_ P: [SIMD3<Float>], bend: Float = 4.5) -> [SIMD3<Float>] {
        guard P.count > 2 else { return P }
        let span = hypot(P[0].x - P[P.count - 1].x, P[0].z - P[P.count - 1].z)
        let capR: Float = span < 14 ? max(0.9, span * 0.22) : .infinity
        var out = [P[0]]
        for i in 1..<(P.count - 1) {
            let prev = P[i - 1], cur = P[i], next = P[i + 1]
            let inLen = simd_distance(cur, prev), outLen = simd_distance(cur, next)
            let r = min(max(bend, min(inLen, outLen) * 0.22), inLen * 0.45, outLen * 0.45, capR)
            let a = cur + simd_normalize(prev - cur) * r, b = cur + simd_normalize(next - cur) * r
            out.append(a)
            for k in 1...8 {
                let t = Float(k) / 8, u = 1 - t
                out.append(u * u * a + 2 * u * t * cur + t * t * b)
            }
        }
        out.append(P[P.count - 1])
        // 直線段補點，管子才不會扭
        var dense: [SIMD3<Float>] = [out[0]]
        for i in 1..<out.count {
            let d = simd_distance(out[i - 1], out[i])
            let n = max(1, Int(d / 3))
            for k in 1...n { dense.append(out[i - 1] + (out[i] - out[i - 1]) * Float(k) / Float(n)) }
        }
        return dense
    }

    /// 某條線的 3D 路徑（mm），給 2D 疊圖判斷引線會不會穿過導線
    func wirePath(_ id: String) -> [SIMD3<Float>] { wirePaths[id] ?? [] }
    private var wirePaths: [String: [SIMD3<Float>]] = [:]

    private static func tube(_ pts: [SIMD3<Float>], radius r: Float, sides: Int = 10) -> MeshResource? {
        guard pts.count >= 2 else { return nil }
        var pos: [SIMD3<Float>] = [], nor: [SIMD3<Float>] = [], idx: [UInt32] = []
        var prevN = SIMD3<Float>(1, 0, 0)
        for (i, p) in pts.enumerated() {
            let tng = simd_normalize(pts[min(i + 1, pts.count - 1)] - pts[max(i - 1, 0)])
            var n = prevN - simd_dot(prevN, tng) * tng
            if simd_length(n) < 1e-3 { n = simd_cross(tng, SIMD3(0, 0, 1)) }
            if simd_length(n) < 1e-3 { n = simd_cross(tng, SIMD3(1, 0, 0)) }
            n = simd_normalize(n); prevN = n
            let bnm = simd_cross(tng, n)
            for k in 0..<sides {
                let a = Float(k) / Float(sides) * 2 * .pi
                let dir = cos(a) * n + sin(a) * bnm
                pos.append(p + dir * r); nor.append(dir)
            }
        }
        for i in 0..<(pts.count - 1) {
            for k in 0..<sides {
                let a = UInt32(i * sides + k), b = UInt32(i * sides + (k + 1) % sides)
                let c = a + UInt32(sides), d = b + UInt32(sides)
                idx += [a, c, b, b, c, d]
            }
        }
        var desc = MeshDescriptor(name: "wire")
        desc.positions = MeshBuffers.Positions(pos)
        desc.normals = MeshBuffers.Normals(nor)
        desc.primitives = .triangles(idx)
        return try? MeshResource.generate(from: [desc])
    }

    // MARK: 步驟樣式

    func update(stepPosition: Int, done: Set<Int>, showAll: Bool, time: Double) {
        let pulse = Float(0.5 + 0.5 * sin(time * 2 * .pi / 1.4))
        for (i, s) in project.steps.enumerated() {
            // 只看「現在在第幾步」：之前的實心、目前的標示、之後的隱藏（打勾過的後面步驟也不顯示，和桌面一致）
            let isDone = i < stepPosition
            let isCurrent = i == stepPosition
            guard let e = s.isWire ? wires[s.targetId] : parts[s.targetId] else { continue }
            e.isEnabled = isDone || isCurrent || showAll
            // 目前的元件半透明脈動；目前的導線保持不透明（半透明的線壓在 PCB 上看起來像穿過板子）
            let opacity: Float = isCurrent ? (s.isWire ? 1 : 0.45 + 0.3 * pulse) : (isDone ? 1 : 0.35)
            e.components.set(OpacityComponent(opacity: opacity))
        }
        // 3D 示範：開發板只在有線接到它（目前、做完或「全部接線」）時才出現；
        // 前面插元件的步驟不會在畫面邊緣露出一角
        if demo, let b = boardModel {
            b.isEnabled = showAll || project.steps.enumerated().contains { i, s in
                guard s.isWire, i <= stepPosition, let w = project.wire(s.targetId) else { return false }
                return [w.from.pin, w.to.pin].contains { $0.map { externalPart(of: $0) == nil } ?? false }
            }
        }
    }

    // MARK: 投影成 2D 疊圖用的孔位（畫面座標）

    /// 用目前錨點的 3D 姿態把所有孔投影到畫面，組成和偵測器同格式的結果（給 2D 標籤、圈圈用）
    func projected(viewSize: CGSize, project toScreen: (SIMD3<Float>) -> CGPoint?) -> BreadboardResult? {
        let cols = project.columns
        var holes: [BreadboardHole] = []
        holes.reserveCapacity(10 * cols)
        func P(_ x: Double, _ z: Double) -> SIMD2<Double>? {
            guard let q = toScreen(world(SIMD3(Float(x), surfaceY, Float(z)))) else { return nil }
            return SIMD2(Double(q.x), Double(q.y))
        }
        var xs = [Double](repeating: 0, count: cols), zs = [Double](repeating: 0, count: 10)
        for r in 0..<10 {
            for c in 0..<cols {
                let id = BreadboardResult.rowLetters[r] + String(c + 1)
                guard let xz = project.holes?[id], xz.count >= 2, let p = P(xz[0], xz[1]) else { return nil }
                xs[c] = xz[0]; zs[r] = xz[1]
                holes.append(BreadboardHole(row: r, col: c, point: p, detected: true))
            }
        }
        var rails: [RailHole] = []
        for (id, xz) in project.holes ?? [:] where xz.count >= 2 {
            guard case let .rail(side, line, n)? = HoleID(id), let p = P(xz[0], xz[1]) else { continue }
            rails.append(RailHole(side: side, line: line, index: n - 1, point: p, detected: true))
        }
        rails.sort { ($0.side, $0.line, $0.index) < ($1.side, $1.line, $1.index) }
        let pitchMM = project.breadboard?.pitchMm ?? 2.54
        let h = pitchMM / 2
        let outline = [P(xs[0] - h, zs[0] - h), P(xs[cols - 1] + h, zs[0] - h), P(xs[cols - 1] + h, zs[9] + h), P(xs[0] - h, zs[9] + h)]
        let rowAxis = (0..<10).map { P(xs[0] - 1.3 * pitchMM, zs[$0]) }
        let colAxis = (0..<cols).map { P(xs[$0], zs[0] - 1.4 * pitchMM) }
        guard outline.allSatisfy({ $0 != nil }), rowAxis.allSatisfy({ $0 != nil }), colAxis.allSatisfy({ $0 != nil }) else { return nil }
        let pitch = simd_distance(holes[0].point, holes[cols - 1].point) / Double(cols - 1)
        return BreadboardResult(imageWidth: Int(viewSize.width), imageHeight: Int(viewSize.height), cols: cols, holes: holes,
                                pitch: pitch, detectedRatio: 1, meanResidual: 0,
                                outline: outline.compactMap { $0 }, rowAxis: rowAxis.compactMap { $0 },
                                colAxis: colAxis.compactMap { $0 }, rails: rails)
    }
}

/// 模型與開發板排針表（Resources/models.json，由桌面 profile 產生）
struct ModelCatalog: Decodable {
    var models: [String: Model]
    var profiles: [String: String]
    var pins: [String: [String: [Double]]]

    struct Model: Decodable { var bboxMin: [Double]; var bboxMax: [Double] }

    static let shared: ModelCatalog = {
        guard let url = Bundle.main.url(forResource: "models", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let c = try? JSONDecoder().decode(ModelCatalog.self, from: data) else {
            return ModelCatalog(models: [:], profiles: [:], pins: [:])
        }
        return c
    }()
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

extension UIColor {
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasPrefix("#") { s.removeFirst() }
        let v = UInt32(s, radix: 16) ?? 0xcccccc
        self.init(red: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }
}

// MARK: - 取景與避讓用的幾何
extension BoardScene {
    /// 模型包圍盒八角（mm，板子座標）
    func modelCorners(model: String?, pose: LanProject.PoseMm?) -> [SIMD3<Float>] {
        guard let model, let pose, let m = ModelCatalog.shared.models[model], m.bboxMin.count == 3, m.bboxMax.count == 3 else { return [] }
        let rot = simd_quatf(angle: Float((pose.rotationDeg ?? 0) * .pi / 180), axis: SIMD3(0, 1, 0))
        let o = SIMD3(Float(pose.position[safe: 0] ?? 0), Float(pose.position[safe: 1] ?? 0), Float(pose.position[safe: 2] ?? 0))
        var out: [SIMD3<Float>] = []
        for x in [m.bboxMin[0], m.bboxMax[0]] { for y in [m.bboxMin[1], m.bboxMax[1]] { for z in [m.bboxMin[2], m.bboxMax[2]] {
            out.append(o + rot.act(SIMD3(Float(x), Float(y), Float(z))))
        } } }
        return out
    }

    /// 開發板（板外的 UNO 等）包圍盒
    /// "ld1.TX" 這類端點屬於哪個外接元件（不是開發板）
    func externalPart(of ref: String) -> LanProject.Part? {
        guard let dot = ref.firstIndex(of: ".") else { return nil }
        let inst = String(ref[..<dot])
        return project.parts.first { $0.id == inst }
    }

    var boardModelCorners: [SIMD3<Float>] { modelCorners(model: project.board?.model, pose: project.board?.poseMm) }

    /// 目前這一步要看的東西：孔、元件包圍盒、（接到開發板時）開發板整塊
    func focusPoints(stepPosition: Int) -> [SIMD3<Float>] {
        guard project.steps.indices.contains(stepPosition) else { return [] }
        let st = project.steps[stepPosition]
        var pts = st.holes.compactMap(hole)
        if st.isWire, let w = project.wire(st.targetId) {
            pts += wirePath(w.id)
            // 接開發板：框進整塊開發板；接外接元件（LD06 等）：框進那個元件
            for ref in [w.from.pin, w.to.pin].compactMap({ $0 }) {
                if let p = externalPart(of: ref) { pts += partCorners(p) } else { pts += boardModelCorners }
            }
        } else if let p = project.part(st.targetId) {
            pts += partCorners(p)
        }
        return pts
    }

    /// 元件包圍盒：有模型用模型的，沒有用 bboxMm
    func partCorners(_ p: LanProject.Part) -> [SIMD3<Float>] {
        let c = modelCorners(model: p.model, pose: p.poseMm)
        if !c.isEmpty { return c }
        guard let b = p.bboxMm, b.count >= 3, let pose = p.poseMm else { return [] }
        let rot = simd_quatf(angle: Float((pose.rotationDeg ?? 0) * .pi / 180), axis: SIMD3(0, 1, 0))
        let o = SIMD3(Float(pose.position[safe: 0] ?? 0), Float(pose.position[safe: 1] ?? 0), Float(pose.position[safe: 2] ?? 0))
        var out: [SIMD3<Float>] = []
        // 板外（排線）元件：本體在 (0, 0, 2.5 + d/2) 附近（同 datasheetBody）；其他：從原點往 +x、+z
        let xs: [Double] = p.offBoard == true ? [-b[0] / 2, b[0] / 2] : [0, b[0]]
        let zs: [Double] = p.offBoard == true ? [-1, 2.5 + b[2]] : [0, b[2]]
        for x in xs { for y in [0, b[1]] { for z in zs { out.append(o + rot.act(SIMD3(Float(x), Float(y), Float(z)))) } } }
        return out
    }
}
