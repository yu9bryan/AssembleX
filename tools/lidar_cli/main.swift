// LiDAR 路線的 Mac 合成測試：CAD 放在桌面上（隨機轉角）→ 模擬 LiDAR 點雲（只取相機看得到的面、深度雜訊、
// 桌面點、干擾物）→ DepthScene＋LiDARFitter → 比對真值。
// 用法：tools/test_lidar.sh
import Foundation
import simd

struct MeshFile: Decodable {
    struct G: Decodable { let positions: [Float]; let indices: [UInt32] }
    let groups: [G]
}

func samplePoints(meshURL: URL, count: Int, seed: UInt64) -> [(SIMD3<Float>, SIMD3<Float>)] {
    let f = try! JSONDecoder().decode(MeshFile.self, from: Data(contentsOf: meshURL))
    var tris: [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>, Float)] = []
    for g in f.groups {
        func v(_ i: UInt32) -> SIMD3<Float> { let k = Int(i) * 3; return SIMD3(g.positions[k], g.positions[k + 1], g.positions[k + 2]) }
        for t in stride(from: 0, to: g.indices.count, by: 3) {
            let a = v(g.indices[t]), b = v(g.indices[t + 1]), c = v(g.indices[t + 2])
            let ar = simd_length(simd_cross(b - a, c - a)) / 2
            if ar > 1e-10 { tris.append((a, b, c, ar)) }
        }
    }
    var cdf: [Float] = []; var acc: Float = 0
    for t in tris { acc += t.3; cdf.append(acc) }
    var gen = SplitMix(seed: seed)
    var out: [(SIMD3<Float>, SIMD3<Float>)] = []
    for _ in 0..<count {
        let r = Float(gen.next01()) * acc
        var lo = 0, hi = cdf.count - 1
        while lo < hi { let mid = (lo + hi) / 2; if cdf[mid] < r { lo = mid + 1 } else { hi = mid } }
        let (a, b, c, _) = tris[lo]
        var u = Float(gen.next01()), w = Float(gen.next01())
        if u + w > 1 { u = 1 - u; w = 1 - w }
        out.append((a + (b - a) * u + (c - a) * w, simd_normalize(simd_cross(b - a, c - a))))
    }
    return out
}

func gauss(_ g: inout SplitMix) -> Float {
    let u1 = max(1e-12, g.next01()), u2 = g.next01()
    return Float(sqrt(-2 * log(u1)) * cos(2 * .pi * u2))
}

let ids = CommandLine.arguments.count > 1 ? Array(CommandLine.arguments.dropFirst()) : ["L298N", "W5500"]
var passAll = 0, total = 0
for id in ids {
    let profile = ComponentProfile.load(url: URL(fileURLWithPath: "AssembleX/Resources/\(id).profile.json"))!
    let meshURL = URL(fileURLWithPath: "AssembleX/Resources/\(id).mesh.json")
    let t0 = Date()
    guard let fitter = LiDARFitter(profile: profile, meshURL: meshURL) else { print("cannot load \(id)"); continue }
    fitter.debug = ProcessInfo.processInfo.environment["BB_DEBUG"] != nil
    print(String(format: "%@: model samples %d, z %.1f..%.1f mm (load %.0f ms)", id, fitter.modelPts.count,
                 fitter.minZ * 1000, fitter.maxZ * 1000, Date().timeIntervalSince(t0) * 1000))
    var gen = SplitMix(seed: 7)
    let dense = samplePoints(meshURL: meshURL, count: 40000, seed: 99)
    for (k, yawDeg) in [17.0, 73.0, 128.0, 205.0, 290.0, 341.0].enumerated() {
        let dist = Float([0.22, 0.28, 0.35][k % 3])
        let yaw = Float(yawDeg) * .pi / 180
        // 真值：桌面 y=0，物件 +Z＝世界 +Y
        let ex = SIMD3<Float>(cos(yaw), 0, -sin(yaw)), ez = SIMD3<Float>(0, 1, 0), ey = simd_cross(ez, ex)
        let center = SIMD3<Float>(0.02 * Float(k % 2), 0, -0.01)
        // REST=i：真值用第 i 種靜置（0 正放、1 倒放、2/3 側放、4/5 立放）
        let restIdx = Int(ProcessInfo.processInfo.environment["REST"] ?? "0")!
        let rest = fitter.rests[restIdx]
        let tTrue = center + ez * (-rest.minZ)
        let Rt = simd_float3x3(ex, ey, ez) * rest.Q
        let cam = SIMD3<Float>(0.05, dist, 0.12)                     // 相機在斜上方
        let pitch = 2 * tan(Float(35) * .pi / 180) * dist / 256      // 每像素間距
        var scene: [SIMD3<Float>] = []
        // 物件：看得到的面，依像素密度取樣
        let objArea = rest.extents[0] * rest.extents[1] * 2.2
        let want = Int(objArea / (pitch * pitch))
        var kept = 0
        for (p, n) in dense {
            let w = Rt * p + tTrue, nw = Rt * n
            guard simd_dot(nw, cam - w) > 0 else { continue }
            if Float(gen.next01()) > Float(want) / Float(dense.count) * 2 { continue }
            let ray = simd_normalize(w - cam)
            scene.append(w + ray * gauss(&gen) * 0.0015); kept += 1
        }
        // 桌面
        var x: Float = -0.12
        while x < 0.12 { var z: Float = -0.12; while z < 0.12 {
            scene.append(SIMD3(x, gauss(&gen) * 0.0012, z)); z += pitch }; x += pitch }
        // 干擾物：30×20×12 mm 的盒子
        for _ in 0..<300 {
            scene.append(SIMD3(0.08 + Float(gen.next01()) * 0.03, Float(gen.next01()) * 0.012, 0.06 + Float(gen.next01()) * 0.02))
        }
        let t1 = Date()
        let planes = DepthScene.supportPlanes(scene)
        let cl = DepthScene.objects(scene, planes: planes)
        let r = fitter.fit(objects: cl, prior: nil)
        let ms = Date().timeIntervalSince(t1) * 1000
        total += 1
        guard let r else { print(String(format: "  yaw %3.0f° dist %.0fcm: NOT FOUND (%d clusters) %.0f ms", yawDeg, dist * 100, cl.count, ms)); continue }
        let Rf = simd_float3x3(SIMD3(r.world.columns.0.x, r.world.columns.0.y, r.world.columns.0.z),
                               SIMD3(r.world.columns.1.x, r.world.columns.1.y, r.world.columns.1.z),
                               SIMD3(r.world.columns.2.x, r.world.columns.2.y, r.world.columns.2.z))
        let dRm = Rf * Rt.transpose
        let ang = acos(max(-1, min(1, (dRm[0][0] + dRm[1][1] + dRm[2][2] - 1) / 2))) * 180 / .pi
        let pe = simd_distance(SIMD3(r.world.columns.3.x, r.world.columns.3.y, r.world.columns.3.z), tTrue) * 1000
        let pass = ang < 5 && pe < 4
        if pass && r.isReliable { passAll += 1 }
        // 追蹤幀
        let t2 = Date()
        let r2 = fitter.fit(objects: cl, prior: r.world)
        let ms2 = Date().timeIntervalSince(t2) * 1000
        print(String(format: "  yaw %3.0f° dist %.0fcm pts %d: rot %.1f° pos %.1fmm inlier %.2f cover %.2f margin %.2f %@ %@ | %.0f ms, track %.0f ms (%@)",
                     yawDeg, dist * 100, r.points, ang, pe, r.inlier, r.coverage, r.margin,
                     r.isReliable ? "reliable" : "unsure", pass ? "PASS" : "FAIL", ms, ms2, r2 == nil ? "lost" : "ok"))
    }
}
print("passed+reliable \(passAll)/\(total)")
