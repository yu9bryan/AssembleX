import Foundation
import simd

/// 麵包板 3D 姿態（PnP）：偵測到的孔（影像 px）↔ 桌面給的孔位座標（mm），配上相機內參求出板子在相機座標的位置。
///
/// 座標約定
/// - 板子（桌面）：x 沿欄、y 向上、z 沿列 A→J，mm；孔口在 y = 板厚 H。
/// - 相機（vision）：x 右、y 下、z 往前（和影像像素同向）；ARKit 相機座標是 (x, −y, −z)。
/// 作法：平面單應（DLT）分解出初值，再用 Gauss-Newton 最小化重投影誤差（6 自由度）。
struct BoardPose: Equatable {
    var R: simd_double3x3          // 板子 → 相機（vision）
    var t: SIMD3<Double>           // m
    var rms: Double                // 重投影誤差（px）

    struct Camera {
        var fx, fy, cx, cy: Double
        func project(_ p: SIMD3<Double>) -> SIMD2<Double>? {
            guard p.z > 1e-4 else { return nil }
            return SIMD2(fx * p.x / p.z + cx, fy * p.y / p.z + cy)
        }
    }

    /// img：影像 px；board：板面 (x, z) mm；surfaceY：孔口高度 mm
    static func solve(img: [SIMD2<Double>], board: [SIMD2<Double>], camera K: Camera, surfaceY: Double) -> BoardPose? {
        guard img.count >= 8, img.count == board.count else { return nil }
        // 1. 正規化影像座標 ↔ 板面（m）的單應
        let norm = img.map { SIMD2(($0.x - K.cx) / K.fx, ($0.y - K.cy) / K.fy) }
        let plane = board.map { $0 / 1000 }
        guard let H = Homography.fit(Array(zip(plane, norm))) else { return nil }
        // H 的三欄 ∝ [r1, r3, H·r2 + t]（板面座標是 (x, z)）
        var h1 = SIMD3(H[0][0], H[0][1], H[0][2])
        var h2 = SIMD3(H[1][0], H[1][1], H[1][2])
        var h3 = SIMD3(H[2][0], H[2][1], H[2][2])
        let lam = 2 / (simd_length(h1) + simd_length(h2))
        h1 *= lam; h2 *= lam; h3 *= lam
        if h3.z < 0 { h1 = -h1; h2 = -h2; h3 = -h3 }       // 板子要在相機前方
        // 正交化：r1、r3 → r2 = r3 × r1（右手座標 x × y = z）
        let r1 = simd_normalize(h1)
        let r3 = simd_normalize(h2 - simd_dot(h2, r1) * r1)
        let r2 = simd_cross(r3, r1)
        var pose = BoardPose(R: simd_double3x3(columns: (r1, r2, r3)), t: h3 - (surfaceY / 1000) * r2, rms: .infinity)
        let pts3 = board.map { SIMD3($0.x / 1000, surfaceY / 1000, $0.y / 1000) }
        pose = refine(pose, pts3: pts3, img: img, camera: K)
        return pose
    }

    /// Gauss-Newton（數值微分）：參數＝旋轉小量 ω（左乘）＋位移
    private static func refine(_ p0: BoardPose, pts3: [SIMD3<Double>], img: [SIMD2<Double>], camera K: Camera) -> BoardPose {
        var R = p0.R, t = p0.t
        func residuals(_ R: simd_double3x3, _ t: SIMD3<Double>) -> [Double] {
            var r = [Double](); r.reserveCapacity(pts3.count * 2)
            for (P, q) in zip(pts3, img) {
                guard let u = K.project(R * P + t) else { r += [1e3, 1e3]; continue }
                r += [u.x - q.x, u.y - q.y]
            }
            return r
        }
        func apply(_ d: [Double], _ R: simd_double3x3, _ t: SIMD3<Double>) -> (simd_double3x3, SIMD3<Double>) {
            let w = SIMD3(d[0], d[1], d[2])
            let a = simd_length(w)
            let dR = a < 1e-12 ? matrix_identity_double3x3 : simd_double3x3(simd_quatd(angle: a, axis: w / a))
            return (dR * R, t + SIMD3(d[3], d[4], d[5]))
        }
        var res = residuals(R, t)
        var cost = res.reduce(0) { $0 + $1 * $1 }
        var mu = 1e-3
        for _ in 0..<15 {
            // Jacobian（2N × 6）
            let eps: [Double] = [1e-5, 1e-5, 1e-5, 1e-5, 1e-5, 1e-5]
            var J = [[Double]](repeating: [Double](repeating: 0, count: 6), count: res.count)
            for k in 0..<6 {
                var d = [Double](repeating: 0, count: 6); d[k] = eps[k]
                let (R2, t2) = apply(d, R, t)
                let r2 = residuals(R2, t2)
                for i in 0..<res.count { J[i][k] = (r2[i] - res[i]) / eps[k] }
            }
            var A = [[Double]](repeating: [Double](repeating: 0, count: 6), count: 6)
            var g = [Double](repeating: 0, count: 6)
            for i in 0..<res.count {
                for a in 0..<6 {
                    g[a] += J[i][a] * res[i]
                    for b in 0..<6 { A[a][b] += J[i][a] * J[i][b] }
                }
            }
            for a in 0..<6 { A[a][a] *= 1 + mu }
            guard let step = solveLinear(A, g.map { -$0 }) else { break }
            let (Rn, tn) = apply(step, R, t)
            let rn = residuals(Rn, tn)
            let cn = rn.reduce(0) { $0 + $1 * $1 }
            if cn < cost {
                R = Rn; t = tn; res = rn
                let done = cost - cn < 1e-6 * cost
                cost = cn; mu = max(1e-6, mu / 3)
                if done { break }
            } else {
                mu *= 10
                if mu > 1e4 { break }
            }
        }
        // 正交化（數值誤差）
        let q = simd_quatd(R)
        return BoardPose(R: simd_double3x3(simd_normalize(q)), t: t, rms: (cost / Double(max(1, pts3.count))).squareRoot())
    }

    private static func solveLinear(_ A0: [[Double]], _ b0: [Double]) -> [Double]? {
        var A = A0, b = b0
        let n = b.count
        for c in 0..<n {
            var p = c
            for r in c + 1..<n where abs(A[r][c]) > abs(A[p][c]) { p = r }
            guard abs(A[p][c]) > 1e-15 else { return nil }
            A.swapAt(c, p); b.swapAt(c, p)
            for r in c + 1..<n {
                let f = A[r][c] / A[c][c]
                for k in c..<n { A[r][k] -= f * A[c][k] }
                b[r] -= f * b[c]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in stride(from: n - 1, through: 0, by: -1) {
            var s = b[r]
            for k in r + 1..<n { s -= A[r][k] * x[k] }
            x[r] = s / A[r][r]
        }
        return x
    }

    /// vision 相機座標的板子姿態 → ARKit 世界（4×4，單位 m；板子座標軸不變）
    func world(cameraTransform C: simd_float4x4) -> simd_float4x4 {
        let F = simd_float4x4(diagonal: SIMD4(1, -1, -1, 1))          // vision → ARKit 相機
        let r = R.columns
        let M = simd_float4x4(columns: (
            SIMD4(Float(r.0.x), Float(r.0.y), Float(r.0.z), 0),
            SIMD4(Float(r.1.x), Float(r.1.y), Float(r.1.z), 0),
            SIMD4(Float(r.2.x), Float(r.2.y), Float(r.2.z), 0),
            SIMD4(Float(t.x), Float(t.y), Float(t.z), 1)))
        return C * F * M
    }
}

/// 兩個世界姿態的差距：位移（mm）與旋轉角（度）
func poseDifference(_ a: simd_float4x4, _ b: simd_float4x4) -> (mm: Double, deg: Double) {
    let d = simd_distance(SIMD3(a.columns.3.x, a.columns.3.y, a.columns.3.z), SIMD3(b.columns.3.x, b.columns.3.y, b.columns.3.z))
    let qa = simd_quatf(simd_float3x3(SIMD3(a.columns.0.x, a.columns.0.y, a.columns.0.z),
                                      SIMD3(a.columns.1.x, a.columns.1.y, a.columns.1.z),
                                      SIMD3(a.columns.2.x, a.columns.2.y, a.columns.2.z)))
    let qb = simd_quatf(simd_float3x3(SIMD3(b.columns.0.x, b.columns.0.y, b.columns.0.z),
                                      SIMD3(b.columns.1.x, b.columns.1.y, b.columns.1.z),
                                      SIMD3(b.columns.2.x, b.columns.2.y, b.columns.2.z)))
    let angle = 2 * acos(min(1, abs(simd_dot(qa.vector, qb.vector))))
    return (Double(d) * 1000, Double(angle) * 180 / .pi)
}
