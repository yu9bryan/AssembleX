import Foundation
import simd

/// CAD 擬合（render-and-compare）：把 CAD 網格依候選姿態畫成小張「顏色類別圖」，
/// 和相機影像的顏色類別比加權 IoU，用 Nelder–Mead 在 6DoF 上找最吻合的姿態。
/// 高的零件擋住板邊時，模型本身就會預測被擋住的區域，所以不會像只看外框那樣被拉歪。
///
/// 通用：顏色類別由 ColorClassifier（依元件 profile）決定，各類別權重依 CAD 中的面積比例自動設定。
final class CADFitter {
    struct Tri { let a: SIMD3<Float>, b: SIMD3<Float>, c: SIMD3<Float>, n: SIMD3<Float>, cls: UInt8 }
    let tris: [Tri]
    let colors: ColorClassifier
    /// 每個類別的計分權重：底板 1；CAD 裡面積 ≥ 4% 的其他顏色 0.5（淺色 0.3，桌面常是淺色）
    let weights: [Double]

    init(tris: [Tri], colors: ColorClassifier) {
        self.tris = tris
        self.colors = colors
        var area = [Double](repeating: 0, count: ColorClassifier.classCount)
        // 上下兩面都算：元件常被翻過來放（例：W5500 晶片面朝上），只算朝上的面會讓翻面時看得到的顏色權重變 0
        for t in tris where abs(t.n.z) > 0.3 {
            area[Int(t.cls)] += Double(simd_length(simd_cross(t.b - t.a, t.c - t.a))) / 2
        }
        let total = max(area.reduce(0, +), 1e-12)
        weights = (0..<ColorClassifier.classCount).map { c in
            if c == Int(ColorClassifier.base) { return 1 }
            if c == Int(ColorClassifier.none) { return 0 }
            guard area[c] / total >= 0.04 else { return 0 }
            return c == Int(ColorClassifier.light) ? 0.3 : 0.5
        }
    }

    /// 讀 mesh JSON（step_lite.py／cad_to_profile.py 輸出），依顏色分類。
    static func load(url: URL, colors: ColorClassifier) -> CADFitter? {
        struct File: Decodable {
            struct G: Decodable { let color: [Float]; let positions: [Float]; let normals: [Float]?; let indices: [UInt32] }
            let groups: [G]
        }
        guard let d = try? Data(contentsOf: url), let f = try? JSONDecoder().decode(File.self, from: d) else { return nil }
        var tris: [Tri] = []
        for g in f.groups {
            let cls = colors.classify(rgb: Double(g.color[0]), Double(g.color[1]), Double(g.color[2]))
            func v(_ i: UInt32) -> SIMD3<Float> {
                let k = Int(i) * 3
                return SIMD3(g.positions[k], g.positions[k + 1], g.positions[k + 2])
            }
            func nv(_ i: UInt32) -> SIMD3<Float> {
                guard let n = g.normals else { return .zero }
                let k = Int(i) * 3
                return SIMD3(n[k], n[k + 1], n[k + 2])
            }
            for t in stride(from: 0, to: g.indices.count, by: 3) {
                let i0 = g.indices[t], i1 = g.indices[t + 1], i2 = g.indices[t + 2]
                let a = v(i0), b = v(i1), c = v(i2)
                var n = nv(i0) + nv(i1) + nv(i2)
                if simd_length(n) < 1e-6 { n = simd_cross(b - a, c - a) }
                guard simd_length(n) > 1e-12 else { continue }
                tris.append(Tri(a: a, b: b, c: c, n: simd_normalize(n), cls: cls))
            }
        }
        return CADFitter(tris: tris, colors: colors)
    }

    // MARK: - 觀測

    struct Observation {
        let w: Int, h: Int
        let x0: Double, y0: Double, scale: Double     // 裁切區：原圖座標 = x0 + u / scale
        let cls: [UInt8]
    }

    /// 以底板色區域外擴當裁切，縮到最長邊 side 像素。
    func observe(_ img: YCbCrImage, around box: (minX: Int, minY: Int, maxX: Int, maxY: Int), side: Int) -> Observation {
        let bw = box.maxX - box.minX, bh = box.maxY - box.minY
        let pad = Double(max(bw, bh)) * 0.45
        let x0 = max(0, Double(box.minX) - pad), y0 = max(0, Double(box.minY) - pad)
        let x1 = min(Double(img.width - 1), Double(box.maxX) + pad), y1 = min(Double(img.height - 1), Double(box.maxY) + pad)
        let scale = Double(side) / max(x1 - x0, y1 - y0)
        let w = max(8, Int((x1 - x0) * scale)), h = max(8, Int((y1 - y0) * scale))
        var cls = [UInt8](repeating: 0, count: w * h)
        for v in 0..<h {
            let y = min(img.height - 1, Int(y0 + (Double(v) + 0.5) / scale))
            for u in 0..<w {
                let x = min(img.width - 1, Int(x0 + (Double(u) + 0.5) / scale))
                let i = y * img.width + x
                cls[v * w + u] = colors.classify(y: img.y[i], cb: img.cb[i], cr: img.cr[i])
            }
        }
        return Observation(w: w, h: h, x0: x0, y0: y0, scale: scale, cls: cls)
    }

    // MARK: - 渲染＋評分

    private var zbuf: [Float] = []
    private var cbuf: [UInt8] = []

    func render(R: simd_double3x3, t: SIMD3<Double>, K: CameraIntrinsics, obs: Observation) -> [UInt8] {
        let w = obs.w, h = obs.h
        if zbuf.count != w * h { zbuf = [Float](repeating: 0, count: w * h); cbuf = [UInt8](repeating: 0, count: w * h) }
        for i in 0..<(w * h) { zbuf[i] = .infinity; cbuf[i] = 0 }
        let Rf = simd_float3x3(columns: (SIMD3<Float>(R.columns.0), SIMD3<Float>(R.columns.1), SIMD3<Float>(R.columns.2)))
        let tf = SIMD3<Float>(t)
        let fx = Float(K.fx * obs.scale), fy = Float(K.fy * obs.scale)
        let cx = Float((K.cx - obs.x0) * obs.scale), cy = Float((K.cy - obs.y0) * obs.scale)
        zbuf.withUnsafeMutableBufferPointer { zb in
            cbuf.withUnsafeMutableBufferPointer { cb in
                for tri in tris {
                    let qa = Rf * tri.a + tf
                    // 背面剔除：法向背對相機就跳過（約省一半三角形）
                    if simd_dot(Rf * tri.n, qa) > 0 { continue }
                    let qb = Rf * tri.b + tf, qc = Rf * tri.c + tf
                    guard qa.z > 0.01, qb.z > 0.01, qc.z > 0.01 else { continue }
                    let a = SIMD3(fx * qa.x / qa.z + cx, fy * qa.y / qa.z + cy, qa.z)
                    let b = SIMD3(fx * qb.x / qb.z + cx, fy * qb.y / qb.z + cy, qb.z)
                    let c = SIMD3(fx * qc.x / qc.z + cx, fy * qc.y / qc.z + cy, qc.z)
                    let minX = max(0, Int(min(a.x, b.x, c.x))), maxX = min(w - 1, Int(max(a.x, b.x, c.x)) + 1)
                    let minY = max(0, Int(min(a.y, b.y, c.y))), maxY = min(h - 1, Int(max(a.y, b.y, c.y)) + 1)
                    guard minX <= maxX, minY <= maxY else { continue }
                    let den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
                    guard abs(den) > 1e-6 else { continue }
                    let inv = 1 / den
                    for py in minY...maxY {
                        let fy0 = Float(py) + 0.5
                        for px in minX...maxX {
                            let fx0 = Float(px) + 0.5
                            let w0 = ((b.y - c.y) * (fx0 - c.x) + (c.x - b.x) * (fy0 - c.y)) * inv
                            let w1 = ((c.y - a.y) * (fx0 - c.x) + (a.x - c.x) * (fy0 - c.y)) * inv
                            let w2 = 1 - w0 - w1
                            guard w0 >= 0, w1 >= 0, w2 >= 0 else { continue }
                            let z = w0 * a.z + w1 * b.z + w2 * c.z
                            let i = py * w + px
                            if z < zb[i] { zb[i] = z; cb[i] = tri.cls }
                        }
                    }
                }
            }
        }
        return cbuf
    }

    /// 分數＝Σ 權重 × 該類別 IoU（底板權重 1）。
    func score(R: simd_double3x3, t: SIMD3<Double>, K: CameraIntrinsics, obs: Observation) -> Double {
        let pred = render(R: R, t: t, K: K, obs: obs)
        var inter = [Int](repeating: 0, count: ColorClassifier.classCount)
        var uni = inter
        for i in 0..<pred.count {
            let p = Int(pred[i]), o = Int(obs.cls[i])
            if p == o { inter[p] += 1; uni[p] += 1 } else { uni[p] += 1; uni[o] += 1 }
        }
        var s = 0.0
        for c in 1..<ColorClassifier.classCount where weights[c] > 0 && uni[c] > 0 {
            s += weights[c] * Double(inter[c]) / Double(uni[c])
        }
        return s
    }

    // MARK: - Nelder–Mead（6 維：旋轉向量增量＋位移增量）

    func refine(R: simd_double3x3, t: SIMD3<Double>, K: CameraIntrinsics, obs: Observation,
                iterations: Int, rotStep: Double = 0.12, posStep: Double = 0.004) -> (simd_double3x3, SIMD3<Double>, Double) {
        let depthStep = max(posStep, t.z * 0.04)
        func pose(_ x: [Double]) -> (simd_double3x3, SIMD3<Double>) {
            (rodrigues(SIMD3(x[0], x[1], x[2])) * R, t + SIMD3(x[3], x[4], x[5]))
        }
        func f(_ x: [Double]) -> Double { let p = pose(x); return -score(R: p.0, t: p.1, K: K, obs: obs) }
        var simplex: [[Double]] = [[0, 0, 0, 0, 0, 0]]
        let steps = [rotStep, rotStep, rotStep, posStep, posStep, depthStep]
        for k in 0..<6 { var x = [Double](repeating: 0, count: 6); x[k] = steps[k]; simplex.append(x) }
        var vals = simplex.map(f)
        for _ in 0..<iterations {
            let order = vals.indices.sorted { vals[$0] < vals[$1] }
            simplex = order.map { simplex[$0] }; vals = order.map { vals[$0] }
            var centroid = [Double](repeating: 0, count: 6)
            for x in simplex.dropLast() { for k in 0..<6 { centroid[k] += x[k] / 6 } }
            func along(_ coef: Double) -> [Double] { (0..<6).map { centroid[$0] + coef * (simplex[6][$0] - centroid[$0]) } }
            let xr = along(-1), fr = f(xr)
            if fr < vals[0] {
                let xe = along(-2), fe = f(xe)
                if fe < fr { simplex[6] = xe; vals[6] = fe } else { simplex[6] = xr; vals[6] = fr }
            } else if fr < vals[5] {
                simplex[6] = xr; vals[6] = fr
            } else {
                let xc = along(fr < vals[6] ? -0.5 : 0.5), fc = f(xc)
                if fc < min(fr, vals[6]) { simplex[6] = xc; vals[6] = fc }
                else {
                    for i in 1...6 {
                        simplex[i] = (0..<6).map { simplex[0][$0] + 0.5 * (simplex[i][$0] - simplex[0][$0]) }
                        vals[i] = f(simplex[i])
                    }
                }
            }
        }
        let best = vals.indices.min { vals[$0] < vals[$1] }!
        let p = pose(simplex[best])
        return (p.0, p.1, -vals[best])
    }
}
