// macOS 測試工具：對照片跑 ModulePoseDetector（L298N），輸出疊圖 PNG。
// tools/test_pose.sh <圖片…>；若同名 .json 有真值（合成圖），印出旋轉／位移誤差。
import CoreGraphics
import Foundation
import ImageIO
import simd
import UniformTypeIdentifiers

func loadRGB(_ path: String, maxDim: Int) -> (YCbCrImage, CGImage, Double)? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let ow = props[kCGImagePropertyPixelWidth] as? Int else { return nil }
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                 kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: maxDim]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    let w = cg.width, h = cg.height
    var rgba = [UInt8](repeating: 0, count: w * h * 4)
    rgba.withUnsafeMutableBytes { b in
        let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var y = [UInt8](repeating: 0, count: w * h), cb = y, cr = y
    for i in 0..<(w * h) {
        let r = Double(rgba[i * 4]), g = Double(rgba[i * 4 + 1]), b = Double(rgba[i * 4 + 2])
        y[i] = UInt8(max(0, min(255, 0.299 * r + 0.587 * g + 0.114 * b)))
        cb[i] = UInt8(max(0, min(255, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b)))
        cr[i] = UInt8(max(0, min(255, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b)))
    }
    return (YCbCrImage(width: w, height: h, y: y, cb: cb, cr: cr), cg, Double(w) / Double(ow))
}

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: pose_cli <image> <out.png>"); exit(1) }
let maxDim = Int(ProcessInfo.processInfo.environment["MAXDIM"] ?? "480")!   // 手機用 480×360
guard let (img, cg, scale) = loadRGB(args[1], maxDim: maxDim) else { print("cannot load"); exit(1) }

// 內參：合成圖讀真值；其他照片假設 iPhone 主鏡頭（水平視角約 69°）
let truthURL = URL(fileURLWithPath: args[1]).deletingPathExtension().appendingPathExtension("json")
let truth = (try? Data(contentsOf: truthURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
let fGuess = 0.68 * Double(max(img.width, img.height))   // iPhone 主鏡頭 24mm 等效：長邊視角約 74°
var K = CameraIntrinsics(fx: fGuess, fy: fGuess,
                         cx: Double(img.width) / 2, cy: Double(img.height) / 2)
if let k = truth?["K"] as? [Double] {
    K = CameraIntrinsics(fx: k[0] * scale, fy: k[1] * scale, cx: k[2] * scale, cy: k[3] * scale)
}

let profileID = ProcessInfo.processInfo.environment["PROFILE"] ?? "L298N"
guard let det = ModulePoseDetector(profileURL: URL(fileURLWithPath: "AssembleX/Resources/\(profileID).profile.json"),
                                   meshURL: URL(fileURLWithPath: "AssembleX/Resources/\(profileID).mesh.json")) else {
    print("cannot load profile \(profileID)"); exit(1)
}
det.params.debug = ProcessInfo.processInfo.environment["BB_DEBUG"] != nil
det.params.debugDumpPath = ProcessInfo.processInfo.environment["DUMP"]
let t0 = Date()
var outcome = det.detect(img, intrinsics: K)
var ms = Date().timeIntervalSince(t0) * 1000
// 模擬追蹤：拿第一次結果當上一幀姿態再跑一次，量追蹤時的速度
if case let .found(p0) = outcome, ProcessInfo.processInfo.environment["NO_FIT"] == nil {
    let t1 = Date()
    let o2 = det.detect(img, intrinsics: K, prior: (p0.rotation, p0.translation))
    print(String(format: "  first frame %.0f ms (fit %.2f rel-margin %.2f), tracking frame %.0f ms", ms,
                 p0.fitScore ?? -1, p0.orientationMargin / max(p0.fitScore ?? 1, 1e-6), Date().timeIntervalSince(t1) * 1000))
    outcome = o2; ms = Date().timeIntervalSince(t1) * 1000
}

let w = img.width, h = img.height
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)

func line(_ a: SIMD2<Double>, _ b: SIMD2<Double>, _ c: CGColor, _ lw: CGFloat = 2) {
    ctx.setStrokeColor(c); ctx.setLineWidth(lw)
    ctx.move(to: CGPoint(x: a.x, y: a.y)); ctx.addLine(to: CGPoint(x: b.x, y: b.y)); ctx.strokePath()
}

switch outcome {
case let .notFound(reason):
    print(String(format: "NOT FOUND (%.0f ms) %@", ms, reason))
case let .found(p):
    let hw = det.profile.boardWidth / 2, hd = det.profile.boardDepth / 2, th = -0.0016
    let top = [SIMD3(-hw, -hd, 0.0), SIMD3(hw, -hd, 0), SIMD3(hw, hd, 0), SIMD3(-hw, hd, 0)]
    let bottom = top.map { $0 + SIMD3(0, 0, th) }
    let cyan = CGColor(red: 0, green: 0.9, blue: 1, alpha: 1)
    for i in 0..<4 {
        line(p.project(top[i], K), p.project(top[(i + 1) % 4], K), cyan)
        line(p.project(bottom[i], K), p.project(bottom[(i + 1) % 4], K), cyan, 1)
        line(p.project(top[i], K), p.project(bottom[i], K), cyan, 1)
    }
    let o = p.project(.zero, K)
    line(o, p.project(SIMD3(0.02, 0, 0), K), CGColor(red: 1, green: 0, blue: 0, alpha: 1), 3)
    line(o, p.project(SIMD3(0, 0.02, 0), K), CGColor(red: 0, green: 1, blue: 0, alpha: 1), 3)
    line(o, p.project(SIMD3(0, 0, 0.02), K), CGColor(red: 0, green: 0.3, blue: 1, alpha: 1), 3)
    let e = p.eulerDegrees
    print(String(format: "FOUND (%.0f ms) dist=%.1fcm t=(%.1f, %.1f, %.1f)cm rpy=(%.0f, %.0f, %.0f) err=%.2fpx margin=%.2f fit=%.2f reliable=%@",
                 ms, p.distance * 100, p.translation.x * 100, p.translation.y * 100, p.translation.z * 100,
                 e.x, e.y, e.z, p.reprojectionError, p.orientationMargin, p.fitScore ?? -1, p.isReliable ? "yes" : "no"))
    if let R = truth?["R"] as? [[Double]], let t = truth?["t"] as? [Double] {
        let Rt = simd_double3x3(rows: R.map { SIMD3($0[0], $0[1], $0[2]) })
        let dR = p.rotation * Rt.transpose
        let ang = acos(max(-1, min(1, (dR[0][0] + dR[1][1] + dR[2][2] - 1) / 2))) * 180 / .pi
        let dt = simd_distance(p.translation, SIMD3(t[0], t[1], t[2])) * 1000
        let pass = ang < 5 && dt < 0.03 * simd_length(SIMD3(t[0], t[1], t[2])) * 1000
        print(String(format: "  truth: rot err=%.2f°  pos err=%.1fmm (dist %.0fmm)  %@", ang, dt,
                     simd_length(SIMD3(t[0], t[1], t[2])) * 1000, pass ? "PASS" : "FAIL"))
    }
}

let out = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out, nil)
CGImageDestinationFinalize(dest)
