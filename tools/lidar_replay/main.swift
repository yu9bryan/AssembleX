// 用手機存下來的 LiDAR 點雲（frame_*.points.bin，世界座標 Float32×3）重跑 LiDARFitter。
// 用法：tools/out/lidar_replay <points.bin…>
import Foundation
import simd

let ids = ["L298N", "W5500"]
var fitters: [String: LiDARFitter] = [:]
for id in ids {
    let p = ComponentProfile.load(url: URL(fileURLWithPath: "AssembleX/Resources/\(id).profile.json"))!
    fitters[id] = LiDARFitter(profile: p, meshURL: URL(fileURLWithPath: "AssembleX/Resources/\(id).mesh.json"))
    fitters[id]!.debug = ProcessInfo.processInfo.environment["BB_DEBUG"] != nil
}
for path in CommandLine.arguments.dropFirst() {
    let d = try! Data(contentsOf: URL(fileURLWithPath: path))
    var pts: [SIMD3<Float>] = []
    d.withUnsafeBytes { raw in
        let f = raw.bindMemory(to: Float32.self)
        for i in stride(from: 0, to: f.count - 2, by: 3) { pts.append(SIMD3(f[i], f[i + 1], f[i + 2])) }
    }
    let t0 = Date()
    let planes = DepthScene.supportPlanes(pts)
    let obs = DepthScene.objects(pts, planes: planes)
    print(String(format: "%@: %d pts, %d planes (y=%@), objects %@ (%.0f ms)", (path as NSString).lastPathComponent,
                 pts.count, planes.count, planes.map { String(format: "%.0fmm", -$0.d * 1000) }.joined(separator: ","),
                 obs.prefix(8).map { "\($0.points.count)" }.joined(separator: ","), Date().timeIntervalSince(t0) * 1000))
    for id in ids {
        let t1 = Date()
        let r = fitters[id]!.fit(objects: obs, prior: nil)
        let ms = Date().timeIntervalSince(t1) * 1000
        if let r {
            print(String(format: "  %@: %@ pts %d inlier %.2f cover %.2f rmse %.1fmm margin %.2f %@ (%.0f ms)", id,
                         fitters[id]!.rests[r.rest].name, r.points, r.inlier, r.coverage, r.rmse * 1000, r.margin,
                         r.isReliable ? "RELIABLE" : "unsure", ms))
        } else { print(String(format: "  %@: not found (%.0f ms)", id, ms)) }
    }
}
