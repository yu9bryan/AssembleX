import Foundation
import simd

// 通用元件 6DoF 定位（只用 RGB＋CAD；元件設定見 ComponentProfile）。
//
//   1. 底板顏色（色相角查表）→ 閉運算 → 由最大塊往外的鄰近聚類（零件會把底板色切成好幾塊）
//   2. 每列左右端點 → 凸包 → 內接最大四邊形 → 每邊最小平方重擬合
//   3. 四角 ↔ CAD 底板角（實際尺寸）＋相機內參 → 單應分解＋Gauss–Newton，四種擺法各一個初始姿態
//   4. CAD render-and-compare：粗略比對排序擺法 → Nelder–Mead 6DoF 精修（CADFitter）
//   5. 追蹤：上一幀姿態精修後分數夠就直接用，不再試其他擺法
//
// 物件座標（和 CAD 網格一致，公尺）：原點＝底板上表面中心，+Z 朝上，+Y 朝最高零件。

struct YCbCrImage {
    let width: Int
    let height: Int
    var y: [UInt8]
    var cb: [UInt8]
    var cr: [UInt8]
}

extension YCbCrImage {
    /// 2×2 平均縮半（只抽一點會疊頻，讓四邊形和 CAD 擬合變差：合成圖 960 px 時轉角誤差從 2° 變 67°）
    func halved() -> YCbCrImage {
        let w2 = width / 2, h2 = height / 2
        var y2 = [UInt8](repeating: 0, count: w2 * h2), cb2 = y2, cr2 = y2
        y.withUnsafeBufferPointer { Y in cb.withUnsafeBufferPointer { B in cr.withUnsafeBufferPointer { R in
            for r in 0..<h2 {
                let a = (r * 2) * width, b = a + width
                for c in 0..<w2 {
                    let i = a + c * 2, j = b + c * 2, o = r * w2 + c
                    let ys: Int = Int(Y[i]) + Int(Y[i + 1]) + Int(Y[j]) + Int(Y[j + 1])
                    let bs: Int = Int(B[i]) + Int(B[i + 1]) + Int(B[j]) + Int(B[j + 1])
                    let rs: Int = Int(R[i]) + Int(R[i + 1]) + Int(R[j]) + Int(R[j + 1])
                    y2[o] = UInt8((ys + 2) / 4); cb2[o] = UInt8((bs + 2) / 4); cr2[o] = UInt8((rs + 2) / 4)
                }
            }
        } } }
        return YCbCrImage(width: w2, height: h2, y: y2, cb: cb2, cr: cr2)
    }
}

struct CameraIntrinsics {
    var fx: Double, fy: Double, cx: Double, cy: Double
    func project(_ p: SIMD3<Double>) -> SIMD2<Double> { SIMD2(fx * p.x / p.z + cx, fy * p.y / p.z + cy) }
    func normalized(_ u: SIMD2<Double>) -> SIMD2<Double> { SIMD2((u.x - cx) / fx, (u.y - cy) / fy) }
}

struct ModulePose {
    let rotation: simd_double3x3       // 物件 → 相機（OpenCV 座標）
    let translation: SIMD3<Double>      // 公尺
    let corners: [SIMD2<Double>]        // 影像中四角，順序：前左、前右、後右、後左
    let reprojectionError: Double       // 像素（RMS）
    let orientationMargin: Double       // 最佳擺法比第二名高多少
    let redPixels: Int                  // 底板色像素數
    var fitScore: Double? = nil         // CAD 擬合分數（底板 IoU＋其他顏色加權 IoU，約 0…2）

    var distance: Double { simd_length(translation) }

    /// 足以顯示明確安裝位置的門檻；不夠時 UI 要提示重新對準。
    var isReliable: Bool {
        if let f = fitScore { return f > 0.6 && orientationMargin >= 0.27 * f }   // 實拍 L298N 正確：fit 0.64–0.92、相對差距 ≥0.28；W5500 合成錯誤解相對差距 0.20–0.24
        return reprojectionError < 4.0 && orientationMargin > 0.08
    }

    func project(_ p: SIMD3<Double>, _ K: CameraIntrinsics) -> SIMD2<Double> {
        K.project(rotation * p + translation)
    }

    /// 物件在相機座標的 roll／pitch／yaw（度，ZYX）
    var eulerDegrees: SIMD3<Double> {
        let R = rotation
        let pitch = asin(-max(-1, min(1, R[0][2])))
        let roll = atan2(R[1][2], R[2][2])
        let yaw = atan2(R[0][1], R[0][0])
        return SIMD3(roll, pitch, yaw) * 180 / .pi
    }
}

enum ModuleDetection {
    case found(ModulePose)
    case notFound(String)
}

final class ModulePoseDetector {
    struct Params {
        var satMin = 22
        var minBoardFraction = 0.0006     // 紅色面積至少佔畫面比例（約 50 cm 外的板子）
        var debug = false
        var debugDumpPath: String? = nil     // 測試用：把「觀測類別｜CAD 預測類別」寫成 PPM
    }

    var params = Params()
    let profile: ComponentProfile
    let colors: ColorClassifier
    /// 有 CAD 網格時，用 render-and-compare 精修（處理零件擋住板邊）
    var fitter: CADFitter?
    private var lastFitScore = 0.0

    init(profile: ComponentProfile, fitter: CADFitter? = nil) {
        self.profile = profile
        self.colors = ColorClassifier(profile: profile)
        self.fitter = fitter
    }

    /// 從 profile＋mesh 檔建立（App 用 bundle，Mac 測試用路徑）
    convenience init?(profileURL: URL, meshURL: URL) {
        guard let p = ComponentProfile.load(url: profileURL) else { return nil }
        self.init(profile: p)
        fitter = CADFitter.load(url: meshURL, colors: colors)
    }

    /// 先在一半解析度找（快、雜訊少：貼紙等小紅點會被打散）；板子太小（太遠）才用原解析度。
    func detect(_ img: YCbCrImage, intrinsics K: CameraIntrinsics,
                prior: (simd_double3x3, SIMD3<Double>)? = nil) -> ModuleDetection {
        if img.width >= 800 {
            let small = img.halved()
            let Ks = CameraIntrinsics(fx: K.fx / 2, fy: K.fy / 2, cx: K.cx / 2, cy: K.cy / 2)
            let r = detectAt(small, intrinsics: Ks, prior: prior)
            if case let .found(p) = r {
                // 板子在半解析度下太小（遠）→ 原解析度再算一次，取吻合較高者（40 cm 時轉角誤差 8° → 1°）
                let xs: [Double] = p.corners.map(\.x), ys: [Double] = p.corners.map(\.y)
                let spanX: Double = (xs.max() ?? 0) - (xs.min() ?? 0)
                let spanY: Double = (ys.max() ?? 0) - (ys.min() ?? 0)
                let size: Double = max(spanX, spanY)
                if size < 90, case let .found(q) = detectAt(img, intrinsics: K, prior: prior),
                   (q.fitScore ?? 0) >= (p.fitScore ?? 0) - 0.05 {
                    return .found(q)
                }
                return r
            }
            if case let .notFound(reason) = r, !reason.contains("太遠"), !reason.contains("底板顏色") { return r }
        }
        return detectAt(img, intrinsics: K, prior: prior)
    }

    private func detectAt(_ img: YCbCrImage, intrinsics K: CameraIntrinsics,
                          prior: (simd_double3x3, SIMD3<Double>)?) -> ModuleDetection {
        let w = img.width, h = img.height

        // 1. 紅色遮罩
        var mask = [UInt8](repeating: 0, count: w * h)
        var redCount = 0
        for i in 0..<(w * h) where colors.isBase(y: img.y[i], cb: img.cb[i], cr: img.cr[i]) {
            mask[i] = 1; redCount += 1
        }
        // 閉運算：PCB 的紅色被白色絲印、銅線、零件切成很多碎塊，先連起來
        mask = Self.close(mask, w, h, radius: max(2, min(w, h) / 220))
        guard Double(redCount) >= params.minBoardFraction * Double(w * h) else {
            return .notFound("找不到\(profile.displayName)的底板顏色（請靠近到 15–30 cm）")
        }

        // 連通元件（標號），取主塊＋靠近主塊的碎塊
        let (labels, comps) = components(mask, w, h)
        guard let main = comps.max(by: { $0.area < $1.area }),
              Double(main.area) >= params.minBoardFraction * Double(w * h) else {
            return .notFound("板子太遠或太小，請靠近到 15–30 cm")
        }
        // 由最大塊往外聚類：藍色端子台會把 PCB 紅色切成好幾大塊、彼此隔開，
        // 只要和目前群集外框的距離小於群集尺寸的一半，就併進來，反覆到不再增加。
        var cbox = (minX: main.minX, minY: main.minY, maxX: main.maxX, maxY: main.maxY)
        var keepIDs: Set<Int32> = [main.id]
        let minPiece = max(30, main.area * 3 / 100)
        var changed = true
        while changed {
            changed = false
            let size = Double(max(cbox.maxX - cbox.minX, cbox.maxY - cbox.minY))
            let thr = 0.5 * size + 4
            for c in comps where !keepIDs.contains(c.id) && c.area >= minPiece {
                let gx = Double(max(0, max(c.minX - cbox.maxX, cbox.minX - c.maxX)))
                let gy = Double(max(0, max(c.minY - cbox.maxY, cbox.minY - c.maxY)))
                guard max(gx, gy) < thr else { continue }
                keepIDs.insert(c.id)
                cbox = (min(cbox.minX, c.minX), min(cbox.minY, c.minY), max(cbox.maxX, c.maxX), max(cbox.maxY, c.maxY))
                changed = true
            }
        }
        let keep = keepIDs

        // 2. 每列左右端點、每欄上下端點 → 邊界點
        var edge: [SIMD2<Double>] = []
        for yy in 0..<h {
            var lo = -1, hi = -1
            for xx in 0..<w where keep.contains(labels[yy * w + xx]) {
                if lo < 0 { lo = xx }; hi = xx
            }
            if lo >= 0 { edge.append(SIMD2(Double(lo), Double(yy))); edge.append(SIMD2(Double(hi) + 1, Double(yy))) }
        }
        for xx in 0..<w {
            var lo = -1, hi = -1
            for yy in 0..<h where keep.contains(labels[yy * w + xx]) {
                if lo < 0 { lo = yy }; hi = yy
            }
            if lo >= 0 { edge.append(SIMD2(Double(xx), Double(lo))); edge.append(SIMD2(Double(xx), Double(hi) + 1)) }
        }
        let hull = convexHull(edge)
        guard hull.count >= 4, var quad = fitQuad(hull) else { return .notFound("外框不是四邊形") }
        quad = refineQuad(quad, edge: edge)

        // 影像中順序要和物件「前左→前右→後右→後左」同手性（shoelace < 0）
        if signedArea(quad) > 0 { quad.reverse() }

        // 3–4. 四種擺法各解一次姿態，用暗／藍側帶打分
        let half = SIMD2(profile.boardWidth / 2, profile.boardDepth / 2)
        let obj: [SIMD3<Double>] = [
            SIMD3(-half.x, -half.y, 0), SIMD3(half.x, -half.y, 0),
            SIMD3(half.x, half.y, 0), SIMD3(-half.x, half.y, 0),
        ]
        var candidates: [(pose: (simd_double3x3, SIMD3<Double>), err: Double, score: Double, corners: [SIMD2<Double>])] = []
        for k in 0..<4 {
            let img4 = (0..<4).map { quad[($0 + k) % 4] }
            guard var pose = poseFromSquare(obj: obj, img: img4, K: K) else { continue }
            pose = refine(pose, obj: obj, img: img4, K: K)
            let err = rms(pose, obj: obj, img: img4, K: K)
            candidates.append((pose, err, 0, img4))
            // 翻面：元件常被倒過來放（例：W5500 晶片面朝上、RJ45 在下）。底板平面相同，只是物件繞自身 X 轉 180°
            let flip = simd_double3x3(diagonal: SIMD3(1, -1, -1))
            candidates.append(((pose.0 * flip, pose.1), err, 0, img4))
        }
        if let fitter {
            return fitCAD(fitter, img: img, K: K, candidates: candidates.map(\.pose), prior: prior,
                          comps: comps.filter { keep.contains($0.id) }, obj: obj, quad: quad, redCount: redCount)
        }
        guard let best = candidates.max(by: { $0.score < $1.score }) else { return .notFound("姿態解不出來") }
        let second = candidates.filter { $0.corners != best.corners }.map(\.score).max() ?? 0
        if params.debug {
            print("  [dbg] red=\(redCount) hull=\(hull.count) scores=" +
                  candidates.map { String(format: "%.2f/err%.1f", $0.score, $0.err) }.joined(separator: " "))
        }
        guard best.pose.1.z > 0 else { return .notFound("姿態在相機後方") }

        return .found(ModulePose(rotation: best.pose.0, translation: best.pose.1, corners: best.corners,
                                 reprojectionError: best.err, orientationMargin: best.score - second,
                                 redPixels: redCount))
    }

    // MARK: - 顏色

    /// 二值閉運算（先膨脹後侵蝕），方形核、可分離的滑動和。
    static func close(_ m: [UInt8], _ w: Int, _ h: Int, radius r: Int) -> [UInt8] {
        func boxCount(_ src: [UInt8]) -> [Int32] {
            var tmp = [Int32](repeating: 0, count: w * h), out = tmp
            for y in 0..<h {
                var s: Int32 = 0
                for x in 0..<min(w, r + 1) { s += Int32(src[y * w + x]) }
                for x in 0..<w {
                    tmp[y * w + x] = s
                    if x + r + 1 < w { s += Int32(src[y * w + x + r + 1]) }
                    if x - r >= 0 { s -= Int32(src[y * w + x - r]) }
                }
            }
            for x in 0..<w {
                var s: Int32 = 0
                for y in 0..<min(h, r + 1) { s += tmp[y * w + x] }
                for y in 0..<h {
                    out[y * w + x] = s
                    if y + r + 1 < h { s += tmp[(y + r + 1) * w + x] }
                    if y - r >= 0 { s -= tmp[(y - r) * w + x] }
                }
            }
            return out
        }
        let dil = boxCount(m).map { $0 > 0 ? UInt8(1) : 0 }
        let inv = dil.map { 1 - $0 }
        return boxCount(inv).map { $0 > 0 ? UInt8(0) : 1 }     // 侵蝕＝反相後膨脹再反相
    }

    // MARK: - CAD 擬合

    private func fitCAD(_ fitter: CADFitter, img: YCbCrImage, K: CameraIntrinsics,
                        candidates: [(simd_double3x3, SIMD3<Double>)], prior: (simd_double3x3, SIMD3<Double>)?,
                        comps: [Comp], obj: [SIMD3<Double>], quad: [SIMD2<Double>], redCount: Int) -> ModuleDetection {
        let box = (minX: comps.map(\.minX).min()!, minY: comps.map(\.minY).min()!,
                   maxX: comps.map(\.maxX).max()!, maxY: comps.map(\.maxY).max()!)
        let coarse = fitter.observe(img, around: box, side: 72)
        var results: [(simd_double3x3, SIMD3<Double>, Double)] = []
        var tracked = false
        // 追蹤：上一幀姿態精修後，分數不比上一幀差太多就直接用（省掉試四種擺法，主要的加速）
        if let prior, prior.1.z > 0 {
            let r = fitter.refine(R: prior.0, t: prior.1, K: K, obs: coarse, iterations: 30, rotStep: 0.04, posStep: 0.0015)
            results.append(r)
            tracked = r.2 >= max(0.5, 0.85 * lastFitScore)
        }
        if !tracked {
            // 第一次偵測：四種擺法都精修（方向判斷要可靠，只花在第一幀）；之後靠追蹤
            let starts = candidates.filter { $0.1.z > 0 }
            for s in starts {
                results.append(fitter.refine(R: s.0, t: s.1, K: K, obs: coarse, iterations: 55))
            }
            if (results.map(\.2).max() ?? 0) < 0.8, let s = starts.first {
                for f in [0.8, 1.25] {
                    results.append(fitter.refine(R: s.0, t: s.1 * f, K: K, obs: coarse, iterations: 55))
                }
            }
            // 底板露出很少時（例：W5500 的 RJ45 蓋住大半），四邊形起點會一起歪、收斂到同一個解。
            // 再從目前最好的解繞板子法向轉 90°／180°／270° 各精修一次，確保真的比較過不同擺法。
            if let best = results.max(by: { $0.2 < $1.2 }) {
                for k in 1...3 {
                    let a = Double(k) * .pi / 2
                    let Rz = simd_double3x3(rows: [SIMD3(cos(a), -sin(a), 0), SIMD3(sin(a), cos(a), 0), SIMD3(0, 0, 1)])
                    results.append(fitter.refine(R: best.0 * Rz, t: best.1, K: K, obs: coarse, iterations: 55))
                }
            }
        }
        results.sort { $0.2 > $1.2 }
        guard let top = results.first else { return .notFound("姿態解不出來") }
        // 第二名要是「不同擺法」：和第一名旋轉差 > 45°
        func angle(_ a: simd_double3x3, _ b: simd_double3x3) -> Double {
            let d = a * b.transpose
            return acos(max(-1, min(1, (d[0][0] + d[1][1] + d[2][2] - 1) / 2)))
        }
        let second = tracked ? 0 : (results.dropFirst().first { angle($0.0, top.0) > .pi / 4 }?.2 ?? 0)
        let fine = fitter.observe(img, around: box, side: tracked ? 110 : 130)
        let final = fitter.refine(R: top.0, t: top.1, K: K, obs: fine, iterations: tracked ? 18 : 35,
                                  rotStep: 0.02, posStep: 0.001)
        let finalScore = max(final.2, 0)
        lastFitScore = finalScore
        if let path = params.debugDumpPath {
            let pred = fitter.render(R: final.0, t: final.1, K: K, obs: fine)
            let pal: [[UInt8]] = [[0, 0, 0], [0, 200, 0], [60, 60, 60], [230, 230, 230], [255, 0, 0], [255, 255, 0],
                                  [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255]]
            var out = Data("P6 \(fine.w * 2) \(fine.h) 255\n".utf8)
            for v in 0..<fine.h {
                for u in 0..<fine.w { out.append(contentsOf: pal[Int(fine.cls[v * fine.w + u])]) }
                for u in 0..<fine.w { out.append(contentsOf: pal[Int(pred[v * fine.w + u])]) }
            }
            try? out.write(to: URL(fileURLWithPath: path))
            print("  [dbg] weights " + fitter.weights.map { String(format: "%.1f", $0) }.joined(separator: " "))
        }
        let corners = obj.map { K.project(final.0 * $0 + final.1) }
        if params.debug {
            print("  [dbg] fit scores=" + results.map { String(format: "%.2f", $0.2) }.joined(separator: " ")
                  + String(format: " final=%.2f", finalScore))
        }
        guard final.1.z > 0 else { return .notFound("姿態在相機後方") }
        var pose = ModulePose(rotation: final.0, translation: final.1, corners: corners,
                              reprojectionError: zip(corners, quad).map { simd_distance($0, $1) }.max() ?? 0,
                              orientationMargin: top.2 - second, redPixels: redCount)
        pose.fitScore = finalScore
        return .found(pose)
    }

    // MARK: - 姿態

    private func poseFromSquare(obj: [SIMD3<Double>], img: [SIMD2<Double>], K: CameraIntrinsics)
        -> (simd_double3x3, SIMD3<Double>)? {
        let pairs = zip(obj, img).map { (SIMD2($0.0.x, $0.0.y), K.normalized($0.1)) }
        guard let H = Homography.fit(pairs) else { return nil }
        var h1 = SIMD3(H[0][0], H[0][1], H[0][2])   // 欄向量（simd 是 column-major）
        var h2 = SIMD3(H[1][0], H[1][1], H[1][2])
        var h3 = SIMD3(H[2][0], H[2][1], H[2][2])
        let lambda = 2 / (simd_length(h1) + simd_length(h2))
        h1 *= lambda; h2 *= lambda; h3 *= lambda
        if h3.z < 0 { h1 = -h1; h2 = -h2; h3 = -h3 }
        var R = simd_double3x3(columns: (h1, h2, simd_cross(h1, h2)))
        for _ in 0..<12 { R = (R + R.inverse.transpose) * 0.5 }   // 最近的旋轉矩陣（極分解）
        return (R, h3)
    }

    private func refine(_ start: (simd_double3x3, SIMD3<Double>), obj: [SIMD3<Double>], img: [SIMD2<Double>],
                        K: CameraIntrinsics) -> (simd_double3x3, SIMD3<Double>) {
        var R = start.0, t = start.1
        func residuals(_ R: simd_double3x3, _ t: SIMD3<Double>) -> [Double] {
            var r: [Double] = []
            for (p, u) in zip(obj, img) {
                let q = R * p + t
                guard q.z > 1e-6 else { return [Double](repeating: 1e3, count: 8) }
                let pr = K.project(q)
                r.append(pr.x - u.x); r.append(pr.y - u.y)
            }
            return r
        }
        for _ in 0..<8 {
            let r0 = residuals(R, t)
            var J = [[Double]](repeating: [Double](repeating: 0, count: 6), count: r0.count)
            let eps = 1e-6
            for k in 0..<6 {
                var dR = R, dt = t
                if k < 3 {
                    var w = SIMD3<Double>(0, 0, 0); w[k] = eps
                    dR = rodrigues(w) * R
                } else { dt[k - 3] += eps }
                let r1 = residuals(dR, dt)
                for i in r0.indices { J[i][k] = (r1[i] - r0[i]) / eps }
            }
            var A = [[Double]](repeating: [Double](repeating: 0, count: 6), count: 6)
            var g = [Double](repeating: 0, count: 6)
            for i in r0.indices {
                for a in 0..<6 {
                    g[a] -= J[i][a] * r0[i]
                    for b in 0..<6 { A[a][b] += J[i][a] * J[i][b] }
                }
            }
            for a in 0..<6 { A[a][a] *= 1.001; A[a][a] += 1e-9 }
            guard let d = solveLinear(A, g) else { break }
            R = rodrigues(SIMD3(d[0], d[1], d[2])) * R
            t += SIMD3(d[3], d[4], d[5])
            if d.map(abs).max()! < 1e-9 { break }
        }
        return (R, t)
    }

    private func rms(_ pose: (simd_double3x3, SIMD3<Double>), obj: [SIMD3<Double>], img: [SIMD2<Double>], K: CameraIntrinsics) -> Double {
        var s = 0.0
        for (p, u) in zip(obj, img) { s += simd_length_squared(K.project(pose.0 * p + pose.1) - u) }
        return sqrt(s / Double(obj.count))
    }

    // MARK: - 幾何小工具

    struct Comp { let id: Int32; var area = 0; var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0 }

    private func components(_ mask: [UInt8], _ w: Int, _ h: Int) -> ([Int32], [Comp]) {
        var labels = [Int32](repeating: -1, count: w * h)
        var comps: [Comp] = []
        var stack: [Int] = []
        for s in 0..<(w * h) where mask[s] == 1 && labels[s] < 0 {
            let id = Int32(comps.count)
            var c = Comp(id: id)
            labels[s] = id; stack.append(s)
            while let p = stack.popLast() {
                let x = p % w, y = p / w
                c.area += 1
                c.minX = min(c.minX, x); c.maxX = max(c.maxX, x); c.minY = min(c.minY, y); c.maxY = max(c.maxY, y)
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let nx = x + dx, ny = y + dy
                    guard nx >= 0, ny >= 0, nx < w, ny < h else { continue }
                    let q = ny * w + nx
                    if mask[q] == 1 && labels[q] < 0 { labels[q] = id; stack.append(q) }
                }
            }
            comps.append(c)
        }
        return (labels, comps)
    }

    private func convexHull(_ pts: [SIMD2<Double>]) -> [SIMD2<Double>] {
        let p = pts.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        guard p.count > 2 else { return p }
        func cross(_ o: SIMD2<Double>, _ a: SIMD2<Double>, _ b: SIMD2<Double>) -> Double {
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
        }
        var lower: [SIMD2<Double>] = [], upper: [SIMD2<Double>] = []
        for q in p {
            while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], q) <= 0 { lower.removeLast() }
            lower.append(q)
        }
        for q in p.reversed() {
            while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], q) <= 0 { upper.removeLast() }
            upper.append(q)
        }
        return Array(lower.dropLast() + upper.dropLast())
    }

    /// 凸包內接最大面積四邊形（凸包點數少，先抽稀再窮舉）。
    private func fitQuad(_ hull: [SIMD2<Double>]) -> [SIMD2<Double>]? {
        var h = hull
        if h.count > 48 {
            let step = Double(h.count) / 48
            h = (0..<48).map { hull[Int(Double($0) * step)] }
        }
        let n = h.count
        guard n >= 4 else { return nil }
        func area(_ a: Int, _ b: Int, _ c: Int, _ d: Int) -> Double { abs(signedArea([h[a], h[b], h[c], h[d]])) }
        var best = (0.0, [0, 1, 2, 3])
        for a in 0..<n {
            for b in (a + 1)..<n {
                for c in (b + 1)..<n {
                    for d in (c + 1)..<n {
                        let s = area(a, b, c, d)
                        if s > best.0 { best = (s, [a, b, c, d]) }
                    }
                }
            }
        }
        // 再把每個角在原凸包上局部微調
        var corners = best.1.map { h[$0] }
        for _ in 0..<2 {
            for i in 0..<4 {
                var bestP = corners[i], bestA = abs(signedArea(corners))
                for q in hull {
                    var c = corners; c[i] = q
                    let s = abs(signedArea(c))
                    if s > bestA { bestA = s; bestP = q }
                }
                corners[i] = bestP
            }
        }
        return corners
    }

    /// 每邊用中間 70% 的邊界點擬合直線，相鄰邊交點為新角點（角被元件削掉時更準）。
    private func refineQuad(_ q: [SIMD2<Double>], edge: [SIMD2<Double>]) -> [SIMD2<Double>] {
        var lines: [(p: SIMD2<Double>, d: SIMD2<Double>)] = []
        for i in 0..<4 {
            let a = q[i], b = q[(i + 1) % 4]
            let len = simd_distance(a, b)
            let dir = (b - a) / len
            let nrm = SIMD2(-dir.y, dir.x)
            var sel: [SIMD2<Double>] = []
            for p in edge {
                let s = simd_dot(p - a, dir)
                guard s > len * 0.15, s < len * 0.85, abs(simd_dot(p - a, nrm)) < max(3, len * 0.03) else { continue }
                sel.append(p)
            }
            guard sel.count >= 6 else { lines.append((a, dir)); continue }
            let c = sel.reduce(SIMD2<Double>(0, 0), +) / Double(sel.count)
            var sxx = 0.0, sxy = 0.0, syy = 0.0
            for p in sel { let d = p - c; sxx += d.x * d.x; sxy += d.x * d.y; syy += d.y * d.y }
            let ang = 0.5 * atan2(2 * sxy, sxx - syy)
            var d = SIMD2(cos(ang), sin(ang))
            if simd_dot(d, dir) < 0 { d = -d }
            lines.append((c, d))
        }
        var out: [SIMD2<Double>] = []
        for i in 0..<4 {
            let l1 = lines[(i + 3) % 4], l2 = lines[i]
            let den = l1.d.x * l2.d.y - l1.d.y * l2.d.x
            guard abs(den) > 1e-6 else { out.append(q[i]); continue }
            let diff = l2.p - l1.p
            let s = (diff.x * l2.d.y - diff.y * l2.d.x) / den
            let p = l1.p + l1.d * s
            out.append(simd_distance(p, q[i]) < 0.25 * simd_distance(q[i], q[(i + 2) % 4]) ? p : q[i])
        }
        return out
    }
}

func signedArea(_ p: [SIMD2<Double>]) -> Double {
    var s = 0.0
    for i in p.indices { let a = p[i], b = p[(i + 1) % p.count]; s += a.x * b.y - b.x * a.y }
    return s / 2
}

func rodrigues(_ w: SIMD3<Double>) -> simd_double3x3 {
    let th = simd_length(w)
    guard th > 1e-12 else { return matrix_identity_double3x3 }
    let k = w / th
    let Kx = simd_double3x3(rows: [SIMD3(0, -k.z, k.y), SIMD3(k.z, 0, -k.x), SIMD3(-k.y, k.x, 0)])
    return matrix_identity_double3x3 + sin(th) * Kx + (1 - cos(th)) * (Kx * Kx)
}

func solveLinear(_ A: [[Double]], _ b: [Double]) -> [Double]? {
    let n = b.count
    var m = A, v = b
    for col in 0..<n {
        guard let piv = (col..<n).max(by: { abs(m[$0][col]) < abs(m[$1][col]) }), abs(m[piv][col]) > 1e-15 else { return nil }
        m.swapAt(col, piv); v.swapAt(col, piv)
        for r in (col + 1)..<n {
            let f = m[r][col] / m[col][col]
            for c in col..<n { m[r][c] -= f * m[col][c] }
            v[r] -= f * v[col]
        }
    }
    var x = [Double](repeating: 0, count: n)
    for r in stride(from: n - 1, through: 0, by: -1) {
        var s = v[r]
        for c in (r + 1)..<n { s -= m[r][c] * x[c] }
        x[r] = s / m[r][r]
    }
    return x
}
