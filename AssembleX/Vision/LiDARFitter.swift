import Foundation
import simd

// LiDAR 路線：只用形狀、不看顏色。
//
//   1. 深度圖（ARKit sceneDepth 256×192）→ 世界座標點雲（ARKit 世界：+Y 朝上）
//   2. RANSAC 找桌面（法向接近 +Y 的最大平面）
//   3. 桌面上 3–60 mm 的點 → 在桌面座標上做格點連通 → 物件點群
//   4. 六種靜置姿態（正放、倒放、四種側／立放）依尺寸與高度挑候選 → CAD 表面取樣點做 point-to-plane ICP：
//      4 自由度（繞桌面法向的轉角＋位移；元件放在桌上不會傾斜，放開 6 自由度反而會因只看得到上表面而歪掉）；
//      多個起始轉角取最好（近正方形板每 45° 一個）
//   5. 分數＝貼合率（場景點離 CAD 表面 < 4 mm 的比例）×0.5＋覆蓋率（CAD 朝上的點附近有場景點的比例）×0.5
//
// 物件座標和 mesh 一致（原點＝底板上表面中心，+Z 朝上）。

struct DepthPlane {
    let n: SIMD3<Float>      // 單位法向（朝上）
    let d: Float             // n·p + d = 0
    func height(_ p: SIMD3<Float>) -> Float { simd_dot(n, p) + d }
}

enum DepthScene {
    /// 深度圖（Float32 公尺）＋信心圖 → 世界座標點。K 是「深度圖解析度」的內參；cam 是 ARKit 相機姿態。
    static func points(depth: UnsafePointer<Float32>, width: Int, height: Int, rowStride: Int,
                       confidence: UnsafePointer<UInt8>?, confStride: Int, minConfidence: UInt8 = 1,
                       K: CameraIntrinsics, cam: simd_float4x4, maxRange: Float = 1.0) -> [SIMD3<Float>] {
        var out: [SIMD3<Float>] = []
        out.reserveCapacity(width * height / 2)
        for v in 0..<height {
            let row = depth + v * rowStride
            for u in 0..<width {
                if let c = confidence, c[v * confStride + u] < minConfidence { continue }
                let z = row[u]
                guard z > 0.08, z < maxRange else { continue }
                // ARKit 相機座標：x 右、y 上、看向 −z
                let x = Float((Double(u) + 0.5 - K.cx) / K.fx) * z
                let y = -Float((Double(v) + 0.5 - K.cy) / K.fy) * z
                let w = cam * SIMD4(x, y, -z, 1)
                out.append(SIMD3(w.x, w.y, w.z))
            }
        }
        return out
    }

    /// RANSAC 找桌面：法向和 +Y 夾角 < 18°、內點最多的平面，最後用內點最小平方重擬合。
    static func tablePlane(_ pts: [SIMD3<Float>], iterations: Int = 160, tol: Float = 0.004) -> DepthPlane? {
        guard pts.count > 100 else { return nil }
        var rng = SystemRandomNumberGenerator()
        let sample = pts.count > 3000 ? (0..<3000).map { _ in pts[Int.random(in: 0..<pts.count, using: &rng)] } : pts
        var best: (DepthPlane, Int)?
        for _ in 0..<iterations {
            let a = sample.randomElement(using: &rng)!, b = sample.randomElement(using: &rng)!, c = sample.randomElement(using: &rng)!
            var n = simd_cross(b - a, c - a)
            let len = simd_length(n)
            guard len > 1e-6 else { continue }
            n /= len
            if n.y < 0 { n = -n }
            guard n.y > 0.95 else { continue }
            let pl = DepthPlane(n: n, d: -simd_dot(n, a))
            var cnt = 0
            for p in sample where abs(pl.height(p)) < tol { cnt += 1 }
            if best == nil || cnt > best!.1 { best = (pl, cnt) }
        }
        guard let (pl, _) = best else { return nil }
        // 重擬合（內點的 PCA 最小變異方向）
        let inl = pts.filter { abs(pl.height($0)) < tol }
        guard inl.count > 50 else { return pl }
        let c = inl.reduce(SIMD3<Float>(repeating: 0), +) / Float(inl.count)
        var cov = simd_float3x3(0)
        for p in inl { let q = p - c; cov += simd_float3x3(columns: (q * q.x, q * q.y, q * q.z)) }
        var n = smallestEigenvector(cov)
        if n.y < 0 { n = -n }
        return DepthPlane(n: n, d: -simd_dot(n, c))
    }

    /// 桌面上方 [minH, maxH] 的點，在桌面座標上以 cell 格子做 8 連通分群。
    static func clusters(_ pts: [SIMD3<Float>], plane: DepthPlane, minH: Float = 0.003, maxH: Float = 0.06,
                         cell: Float = 0.004, minPoints: Int = 25) -> [[SIMD3<Float>]] {
        let (e1, e2) = planeBasis(plane.n)
        var cells: [SIMD2<Int32>: [Int]] = [:]
        let above = pts.filter { let h = plane.height($0); return h > minH && h < maxH }
        for (i, p) in above.enumerated() {
            let k = SIMD2(Int32(floor(simd_dot(p, e1) / cell)), Int32(floor(simd_dot(p, e2) / cell)))
            cells[k, default: []].append(i)
        }
        var seen = Set<SIMD2<Int32>>()
        var out: [[SIMD3<Float>]] = []
        for start in cells.keys where !seen.contains(start) {
            var stack = [start]; seen.insert(start)
            var members: [SIMD3<Float>] = []
            while let k = stack.popLast() {
                for i in cells[k]! { members.append(above[i]) }
                for dx in -1...1 { for dy in -1...1 where dx != 0 || dy != 0 {
                    let nk = k &+ SIMD2(Int32(dx), Int32(dy))
                    if cells[nk] != nil && !seen.contains(nk) { seen.insert(nk); stack.append(nk) }
                } }
            }
            if members.count >= minPoints { out.append(members) }
        }
        return out.sorted { $0.count > $1.count }
    }

    /// 場景常有好幾個水平面（桌面、筆電掌托、鍵盤）。逐一 RANSAC 找出、移除內點，最多 maxPlanes 個。
    static func supportPlanes(_ pts: [SIMD3<Float>], maxPlanes: Int = 4, minInliers: Int = 1200,
                              tol: Float = 0.003) -> [DepthPlane] {
        var rest = pts
        var planes: [DepthPlane] = []
        for _ in 0..<maxPlanes {
            guard rest.count > minInliers, let pl = tablePlane(rest, tol: tol) else { break }
            let inl = rest.filter { abs(pl.height($0)) < tol }
            guard inl.count >= minInliers else { break }
            planes.append(pl)
            rest = rest.filter { abs(pl.height($0)) >= tol }
        }
        return planes
    }

    /// 物件點群：去掉所有支撐面上的點，剩下的點用 3D 體素 26 連通分群；每群配上「正下方最近的支撐面」。
    static func objects(_ pts: [SIMD3<Float>], planes: [DepthPlane], minH: Float = 0.003, maxH: Float = 0.06,
                        cell: Float = 0.004, minPoints: Int = 25) -> [(points: [SIMD3<Float>], plane: DepthPlane)] {
        guard !planes.isEmpty else { return [] }
        // 每點：最近的「在它下方」的平面高度；在任何平面上（< 3 mm）就丟掉
        var kept: [SIMD3<Float>] = []
        for p in pts {
            var bestH = Float.infinity
            var onPlane = false
            for pl in planes {
                let h = pl.height(p)
                if abs(h) < minH { onPlane = true; break }
                if h > 0 && h < bestH { bestH = h }
            }
            if !onPlane && bestH < maxH { kept.append(p) }
        }
        var cells: [SIMD3<Int32>: [Int]] = [:]
        for (i, p) in kept.enumerated() {
            cells[SIMD3(Int32(floor(p.x / cell)), Int32(floor(p.y / cell)), Int32(floor(p.z / cell))), default: []].append(i)
        }
        var seen = Set<SIMD3<Int32>>()
        var out: [(points: [SIMD3<Float>], plane: DepthPlane)] = []
        for start in cells.keys where !seen.contains(start) {
            var stack = [start]; seen.insert(start)
            var members: [SIMD3<Float>] = []
            while let k = stack.popLast() {
                for i in cells[k]! { members.append(kept[i]) }
                for dx in -1...1 { for dy in -1...1 { for dz in -1...1 where dx != 0 || dy != 0 || dz != 0 {
                    let nk = k &+ SIMD3(Int32(dx), Int32(dy), Int32(dz))
                    if cells[nk] != nil && !seen.contains(nk) { seen.insert(nk); stack.append(nk) }
                } } }
            }
            guard members.count >= minPoints else { continue }
            // 支撐面：群的最低點正下方、距離最近的平面
            let support = planes.min { a, b in
                let ha = members.map { a.height($0) }.min() ?? 0, hb = members.map { b.height($0) }.min() ?? 0
                func cost(_ h: Float) -> Float { h >= -0.004 ? h : 1 + abs(h) }
                return cost(ha) < cost(hb)
            }!
            out.append((members, support))
        }
        return out.sorted { $0.points.count > $1.points.count }
    }

    static func planeBasis(_ n: SIMD3<Float>) -> (SIMD3<Float>, SIMD3<Float>) {
        let ref: SIMD3<Float> = abs(n.x) < 0.9 ? SIMD3(1, 0, 0) : SIMD3(0, 0, 1)
        let e1 = simd_normalize(simd_cross(ref, n))
        return (e1, simd_cross(n, e1))
    }

    /// 對稱 3×3 最小特徵值的特徵向量（逆冪法）
    static func smallestEigenvector(_ m: simd_float3x3) -> SIMD3<Float> {
        let shifted = m + simd_float3x3(diagonal: SIMD3(repeating: 1e-9))
        let inv = shifted.inverse
        var v = simd_normalize(SIMD3<Float>(0.1, 1, 0.2))
        for _ in 0..<30 { v = simd_normalize(inv * v) }
        return v
    }
}

final class LiDARFitter {
    struct Result {
        let world: simd_float4x4     // 物件 → 世界
        let inlier: Float            // 場景點貼合率
        let coverage: Float          // CAD 朝上表面被覆蓋率
        let rmse: Float              // 公尺
        let margin: Float            // 和「不同姿態／轉角」次佳解的分數差
        let points: Int
        var rest: Int = 0            // 靜置姿態（哪一面朝上）
        var score: Float { 0.4 * inlier + 0.4 * coverage + 0.2 * max(0, 1 - rmse / 0.004) }
        var isReliable: Bool { inlier > 0.6 && coverage > 0.5 && margin > 0.05 && points >= 40 }
    }

    /// 一種靜置姿態：物件的某一軸朝上放在桌上。Q＝物件座標 → 靜置座標（靜置座標 +Z 朝上）。
    struct Rest {
        let name: String
        let Q: simd_float3x3
        let pts: [SIMD3<Float>]          // 靜置座標中、從上方看得到的取樣點
        let nrm: [SIMD3<Float>]
        let topIdx: [Int]
        let grid: [SIMD3<Int32>: [Int]]
        let minZ: Float, maxZ: Float
        let extents: [Float]             // 俯視外框（排序後）
        var height: Float { maxZ - minZ }
    }

    let profile: ComponentProfile
    let rests: [Rest]
    private let gridCell: Float = 0.006
    var debug = false
    /// 只用正放（+Z 朝上）；多姿態太慢時可關
    var uprightOnly = false

    init?(profile: ComponentProfile, meshURL: URL, samples: Int = 4000) {
        struct File: Decodable {
            struct G: Decodable { let positions: [Float]; let indices: [UInt32] }
            let groups: [G]
        }
        guard let d = try? Data(contentsOf: meshURL), let f = try? JSONDecoder().decode(File.self, from: d) else { return nil }
        var tris: [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>, Float)] = []
        for g in f.groups {
            func v(_ i: UInt32) -> SIMD3<Float> { let k = Int(i) * 3; return SIMD3(g.positions[k], g.positions[k + 1], g.positions[k + 2]) }
            for t in stride(from: 0, to: g.indices.count, by: 3) {
                let a = v(g.indices[t]), b = v(g.indices[t + 1]), c = v(g.indices[t + 2])
                let area = simd_length(simd_cross(b - a, c - a)) / 2
                if area > 1e-10 { tris.append((a, b, c, area)) }
            }
        }
        guard !tris.isEmpty else { return nil }
        // 面積加權取樣全部表面（固定亂數種子，結果可重現）
        var cdf: [Float] = []; var acc: Float = 0
        for t in tris { acc += t.3; cdf.append(acc) }
        var gen = SplitMix(seed: 42)
        var P: [SIMD3<Float>] = [], N: [SIMD3<Float>] = []
        for _ in 0..<samples {
            let r = Float(gen.next01()) * acc
            var lo = 0, hi = cdf.count - 1
            while lo < hi { let mid = (lo + hi) / 2; if cdf[mid] < r { lo = mid + 1 } else { hi = mid } }
            let (a, b, c, _) = tris[lo]
            var u = Float(gen.next01()), w = Float(gen.next01())
            if u + w > 1 { u = 1 - u; w = 1 - w }
            P.append(a + (b - a) * u + (c - a) * w); N.append(simd_normalize(simd_cross(b - a, c - a)))
        }
        // 六種靜置：±X、±Y、±Z 朝上
        let ups: [(String, SIMD3<Float>, SIMD3<Float>)] = [
            ("正放", SIMD3(0, 0, 1), SIMD3(1, 0, 0)), ("倒放", SIMD3(0, 0, -1), SIMD3(1, 0, 0)),
            ("側放 +X", SIMD3(1, 0, 0), SIMD3(0, 1, 0)), ("側放 −X", SIMD3(-1, 0, 0), SIMD3(0, 1, 0)),
            ("立放 +Y", SIMD3(0, 1, 0), SIMD3(0, 0, 1)), ("立放 −Y", SIMD3(0, -1, 0), SIMD3(0, 0, 1)),
        ]
        var rs: [Rest] = []
        for (name, up, rx) in ups {
            let ry = simd_cross(up, rx)
            let Q = simd_float3x3(rows: [rx, ry, up])           // 物件 → 靜置
            var pts: [SIMD3<Float>] = [], nrm: [SIMD3<Float>] = []
            var zmin: Float = .infinity, zmax: Float = -.infinity
            for (p, n) in zip(P, N) {
                let pr = Q * p
                zmin = min(zmin, pr.z); zmax = max(zmax, pr.z)
                var nr = Q * n
                if nr.z < -0.3 { continue }                    // 從上方看不到
                if abs(nr.z) < 0.3 { nr = simd_normalize(SIMD3(nr.x, nr.y, 0)) }
                pts.append(pr); nrm.append(nr)
            }
            let above = pts.filter { $0.z > zmin + 0.003 }
            let xs = above.map(\.x), ys = above.map(\.y)
            let ex: Float = (xs.max() ?? 0) - (xs.min() ?? 0), ey: Float = (ys.max() ?? 0) - (ys.min() ?? 0)
            var grid: [SIMD3<Int32>: [Int]] = [:]
            for (i, p) in pts.enumerated() {
                grid[SIMD3(Int32(floor(p.x / 0.006)), Int32(floor(p.y / 0.006)), Int32(floor(p.z / 0.006))), default: []].append(i)
            }
            rs.append(Rest(name: name, Q: Q, pts: pts, nrm: nrm, topIdx: nrm.indices.filter { nrm[$0].z > 0.6 },
                           grid: grid, minZ: zmin, maxZ: zmax, extents: [ex, ey].sorted()))
        }
        rests = rs
        self.profile = profile
    }

    // 相容：舊程式用到的正放資訊
    var minZ: Float { rests[0].minZ }
    var maxZ: Float { rests[0].maxZ }
    var modelPts: [SIMD3<Float>] { rests[0].pts }

    // MARK: - 對外

    /// 從所有點群裡找這個元件（六種靜置姿態都試）。prior＝上一幀的世界姿態（追蹤用）。
    func fit(clusters: [[SIMD3<Float>]], plane: DepthPlane, prior: simd_float4x4?) -> Result? {
        fit(objects: clusters.map { ($0, plane) }, prior: prior)
    }

    /// 每個物件點群帶自己的支撐面（桌面、筆電掌托…）。
    func fit(objects: [(points: [SIMD3<Float>], plane: DepthPlane)], prior: simd_float4x4?) -> Result? {
        // 追蹤：從上一幀姿態推回是哪種靜置，附近直接 ICP
        if let prior {
            let c = SIMD3(prior.columns.3.x, prior.columns.3.y, prior.columns.3.z)
            if let ob = objects.min(by: { simd_distance(centroid($0.points), c) < simd_distance(centroid($1.points), c) }),
               simd_distance(centroid(ob.points), c) < 0.03 {
                let cl = ob.points, plane = ob.plane
                let Rp = rot(prior)
                let ri = rests.indices.max { simd_dot(Rp * rests[$0].Q.transpose * SIMD3(0, 0, 1), plane.n)
                                           < simd_dot(Rp * rests[$1].Q.transpose * SIMD3(0, 0, 1), plane.n) }!
                let startRest = prior * mat4(rests[ri].Q.transpose)
                var r = icp(cl, rest: ri, start: startRest, iters: 8)
                if r.score > 0.6 {
                    r = Result(world: r.world, inlier: r.inlier, coverage: r.coverage, rmse: r.rmse, margin: 1,
                               points: r.points, rest: ri)
                    return r
                }
            }
        }
        let candRests = uprightOnly ? [0] : Array(rests.indices)
        // 每個點群：找和它尺寸／高度相符的靜置姿態
        var jobs: [([SIMD3<Float>], DepthPlane, Int, Float)] = []    // (點群, 支撐面, 靜置, 尺寸誤差)
        for (cl, plane) in objects.prefix(10) {
            let ext = footprint(cl, plane: plane).extents.sorted()
            let h = cl.map { plane.height($0) }.max() ?? 0
            for ri in candRests {
                let r = rests[ri]
                let err = abs(ext[0] - r.extents[0]) / r.extents[0] + abs(ext[1] - r.extents[1]) / r.extents[1]
                guard err < 1.3, abs(h - r.height) < 0.35 * r.height + 0.004 else { continue }
                jobs.append((cl, plane, ri, err))
            }
        }
        if debug {
            for (cl, plane) in objects.prefix(6) {
                let f = footprint(cl, plane: plane)
                print(String(format: "    cluster n=%d ext %.1f x %.1f mm h %.1f mm", cl.count, f.extents.min()! * 1000,
                             f.extents.max()! * 1000, (cl.map { plane.height($0) }.max() ?? 0) * 1000))
            }
            print("    jobs: " + jobs.map { "\(rests[$0.2].name)(\(String(format: "%.2f", $0.3)))" }.joined(separator: " "))
        }
        // 粗：每個 (點群, 靜置) 從數個轉角起點各做幾步 ICP
        var coarse: [(cl: [SIMD3<Float>], plane: DepthPlane, r: Result)] = []
        for (cl, plane, ri, _) in jobs.sorted(by: { $0.3 < $1.3 }).prefix(12) {
            let fp = footprint(cl, plane: plane)
            let ex = rests[ri].extents
            let n = ex[1] / max(ex[0], 1e-6) < 1.25 ? 8 : 4
            for k in 0..<n {
                let start = pose(on: plane, center: fp.center, yaw: fp.angle + Float(k) * 2 * .pi / Float(n), rest: ri)
                coarse.append((cl, plane, icp(cl, rest: ri, start: start, iters: 6)))
            }
        }
        coarse.sort { $0.r.score > $1.r.score }
        // 細：前三名精修＋yaw 精修
        var fine: [Result] = []
        var picked: [simd_float4x4] = []
        for c in coarse {
            if picked.contains(where: { rotAngle(rot($0), rot(c.r.world)) < .pi / 8 && simd_distance(pos($0), pos(c.r.world)) < 0.01 }) { continue }
            picked.append(c.r.world)
            let ri = c.r.rest
            var top = icp(c.cl, rest: ri, start: c.r.world * mat4(rests[ri].Q.transpose), iters: 10)
            for dDeg in stride(from: -12, through: 12, by: 3) where dDeg != 0 {
                let a = Float(dDeg) * .pi / 180
                let Rz = simd_float4x4(simd_quatf(angle: a, axis: SIMD3(0, 0, 1)))
                let r = icp(c.cl, rest: ri, start: top.world * mat4(rests[ri].Q.transpose) * Rz, iters: 3)
                if r.score > top.score { top = r }
            }
            fine.append(top)
            if fine.count >= 3 { break }
        }
        guard let best = fine.max(by: { $0.score < $1.score }) else { return nil }
        // 次佳：姿態（整體旋轉）差 > 45° 的最好結果（粗＋細都算）
        let others = (fine + coarse.map(\.r)).filter {
            rotAngle(rot($0.world), rot(best.world)) > .pi / 4 && simd_distance(pos($0.world), pos(best.world)) < 0.02
        }
        let second = others.map(\.score).max() ?? 0
        return Result(world: best.world, inlier: best.inlier, coverage: best.coverage, rmse: best.rmse,
                      margin: best.score - second, points: best.points, rest: best.rest)
    }

    // MARK: - 姿態工具

    private func rot(_ m: simd_float4x4) -> simd_float3x3 {
        simd_float3x3(SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z), SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                      SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
    }
    private func pos(_ m: simd_float4x4) -> SIMD3<Float> { SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z) }
    private func mat4(_ r: simd_float3x3) -> simd_float4x4 {
        simd_float4x4(columns: (SIMD4(r.columns.0, 0), SIMD4(r.columns.1, 0), SIMD4(r.columns.2, 0), SIMD4(0, 0, 0, 1)))
    }
    private func rotAngle(_ a: simd_float3x3, _ b: simd_float3x3) -> Float {
        let d = a * b.transpose
        return acos(max(-1, min(1, (d[0][0] + d[1][1] + d[2][2] - 1) / 2)))
    }

    /// 靜置座標放在桌上：+Z＝桌面法向，+X 在桌面內轉 yaw；高度讓最低點貼桌面。回傳「靜置 → 世界」。
    private func pose(on plane: DepthPlane, center: SIMD3<Float>, yaw: Float, rest ri: Int) -> simd_float4x4 {
        let (e1, e2) = DepthScene.planeBasis(plane.n)
        let ex = e1 * cos(yaw) + e2 * sin(yaw)
        let ez = plane.n
        let ey = simd_cross(ez, ex)
        let onPlane = center - plane.n * plane.height(center)
        let t = onPlane + plane.n * (-rests[ri].minZ)
        return simd_float4x4(columns: (SIMD4(ex, 0), SIMD4(ey, 0), SIMD4(ez, 0), SIMD4(t, 1)))
    }

    /// 4 自由度 ICP（繞桌面法向轉＋位移），在靜置座標中做。start＝靜置 → 世界；回傳的 world 是物件 → 世界。
    private func icp(_ sceneAll: [SIMD3<Float>], rest ri: Int, start: simd_float4x4, iters: Int) -> Result {
        let rest = rests[ri]
        let step = max(1, sceneAll.count / 500)
        let scene = stride(from: 0, to: sceneAll.count, by: step).map { sceneAll[$0] }
        var R = rot(start)
        var t = pos(start)
        for it in 0..<iters {
            var A = [[Double]](repeating: [Double](repeating: 0, count: 4), count: 4)
            var b = [Double](repeating: 0, count: 4)
            var used = 0
            let maxD: Float = it < 3 ? 0.012 : 0.006
            for q in scene {
                let p = R.transpose * (q - t)
                guard let (m, n) = nearest(p, rest: rest, maxDist: maxD) else { continue }
                let r = simd_dot(p - m, n)
                let jz = simd_cross(m, n).z                    // 只轉 z（桌面法向）
                let row: [Double] = [Double(jz), Double(n.x), Double(n.y), Double(n.z)]
                let w = 1 / (1 + Double(abs(r)) / 0.003)
                for i in 0..<4 { b[i] += w * row[i] * Double(r); for j in 0..<4 { A[i][j] += w * row[i] * row[j] } }
                used += 1
            }
            guard used >= 15 else { break }
            for i in 0..<4 { A[i][i] += 1e-6 }
            guard let x = solveLinear(A, b) else { break }
            let a = Float(x[0]), tau = SIMD3(Float(x[1]), Float(x[2]), Float(x[3]))
            let dR = simd_float3x3(simd_quatf(angle: a, axis: SIMD3(0, 0, 1)))
            t = t + R * tau
            R = R * dR
            if simd_length(tau) < 1e-5 && abs(a) < 1e-4 { break }
        }
        // 分數：貼合（殘差 < 2 mm）、覆蓋（朝上的點 3 mm 內有場景點）、RMSE
        var inl = 0, se: Float = 0, cnt = 0
        var sceneGrid = Set<SIMD3<Int32>>()
        let sc: Float = 0.002
        for q in sceneAll {
            let p = R.transpose * (q - t)
            sceneGrid.insert(SIMD3(Int32(floor(p.x / sc)), Int32(floor(p.y / sc)), Int32(floor(p.z / sc))))
            if let (m, n) = nearest(p, rest: rest, maxDist: 0.006) {
                let r = simd_dot(p - m, n)
                if abs(r) < 0.002 && simd_distance(p, m) < 0.004 { inl += 1 }
                se += min(r * r, 0.006 * 0.006); cnt += 1
            } else { se += 0.006 * 0.006; cnt += 1 }
        }
        var covered = 0
        for i in rest.topIdx {
            let p = rest.pts[i]
            let k = SIMD3(Int32(floor(p.x / sc)), Int32(floor(p.y / sc)), Int32(floor(p.z / sc)))
            var hit = false
            for dx in -1...1 { for dy in -1...1 { for dz in -1...1 where !hit {
                if sceneGrid.contains(k &+ SIMD3(Int32(dx), Int32(dy), Int32(dz))) { hit = true }
            } } }
            if hit { covered += 1 }
        }
        let restToWorld = simd_float4x4(columns: (SIMD4(R.columns.0, 0), SIMD4(R.columns.1, 0), SIMD4(R.columns.2, 0), SIMD4(t, 1)))
        return Result(world: restToWorld * mat4(rest.Q), inlier: sceneAll.isEmpty ? 0 : Float(inl) / Float(sceneAll.count),
                      coverage: rest.topIdx.isEmpty ? 0 : Float(covered) / Float(rest.topIdx.count),
                      rmse: cnt > 0 ? sqrt(se / Float(cnt)) : 1, margin: 0, points: sceneAll.count, rest: ri)
    }

    private func nearest(_ p: SIMD3<Float>, rest: Rest, maxDist: Float) -> (SIMD3<Float>, SIMD3<Float>)? {
        let k = SIMD3(Int32(floor(p.x / gridCell)), Int32(floor(p.y / gridCell)), Int32(floor(p.z / gridCell)))
        let reach: Int32 = maxDist > gridCell ? 2 : 1
        var best: Int = -1; var bd = maxDist * maxDist
        for dx in -reach...reach { for dy in -reach...reach { for dz in -reach...reach {
            guard let list = rest.grid[k &+ SIMD3(dx, dy, dz)] else { continue }
            for i in list { let d = simd_distance_squared(rest.pts[i], p); if d < bd { bd = d; best = i } }
        } } }
        return best >= 0 ? (rest.pts[best], rest.nrm[best]) : nil
    }

    private func centroid(_ c: [SIMD3<Float>]) -> SIMD3<Float> { c.reduce(SIMD3<Float>(repeating: 0), +) / Float(max(c.count, 1)) }

    /// 點群在桌面上的中心、主軸角度、兩軸長度（PCA）
    func footprint(_ cl: [SIMD3<Float>], plane: DepthPlane) -> (center: SIMD3<Float>, angle: Float, extents: [Float]) {
        let (e1, e2) = DepthScene.planeBasis(plane.n)
        let uv = cl.map { SIMD2(simd_dot($0, e1), simd_dot($0, e2)) }
        let m = uv.reduce(SIMD2<Float>(repeating: 0), +) / Float(uv.count)
        var sxx: Float = 0, sxy: Float = 0, syy: Float = 0
        for p in uv { let d = p - m; sxx += d.x * d.x; sxy += d.x * d.y; syy += d.y * d.y }
        let ang = 0.5 * atan2(2 * sxy, sxx - syy)
        let a1 = SIMD2(cos(ang), sin(ang)), a2 = SIMD2(-sin(ang), cos(ang))
        let p1 = uv.map { simd_dot($0 - m, a1) }, p2 = uv.map { simd_dot($0 - m, a2) }
        let lo1: Float = p1.min()!, hi1: Float = p1.max()!, lo2: Float = p2.min()!, hi2: Float = p2.max()!
        let off1: SIMD2<Float> = a1 * ((hi1 + lo1) / 2)
        let off2: SIMD2<Float> = a2 * ((hi2 + lo2) / 2)
        let c2: SIMD2<Float> = m + off1 + off2
        let inPlane: SIMD3<Float> = e1 * c2.x + e2 * c2.y
        let center: SIMD3<Float> = inPlane + plane.n * (-plane.d)
        return (center, ang, [hi1 - lo1, hi2 - lo2])
    }
}

/// 可重現的亂數
struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func next01() -> Double { Double(next() >> 11) / Double(1 << 53) }
}
