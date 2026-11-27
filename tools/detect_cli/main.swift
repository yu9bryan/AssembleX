// macOS 測試工具：對照片跑 BreadboardDetector，輸出疊圖 PNG。
// 編譯：tools/test_detector.sh
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import simd

func loadGray(_ path: String, maxDim: Int) -> (GrayImage, CGImage)? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,       // 套用 EXIF 方向
        kCGImageSourceThumbnailMaxPixelSize: maxDim,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    let w = cg.width, h = cg.height
    var px = [UInt8](repeating: 0, count: w * h)
    let ok = px.withUnsafeMutableBytes { buf -> Bool in
        guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    return ok ? (GrayImage(width: w, height: h, pixels: px), cg) : nil
}

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: detect_cli <image> <out.png> [maxDim]"); exit(1) }
let maxDim = args.count > 3 ? Int(args[3])! : 1920
guard let (gray, cg) = loadGray(args[1], maxDim: maxDim) else { print("cannot load"); exit(1) }

let det = BreadboardDetector()
det.params.debug = ProcessInfo.processInfo.environment["BB_DEBUG"] != nil
let t0 = Date()
let outcome = det.detect(gray)
let ms = Date().timeIntervalSince(t0) * 1000

let w = gray.width, h = gray.height
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)   // 改成影像座標（左上原點）

func dot(_ p: SIMD2<Double>, _ r: Double, _ c: CGColor, fill: Bool) {
    let rect = CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)
    if fill { ctx.setFillColor(c); ctx.fillEllipse(in: rect) } else { ctx.setStrokeColor(c); ctx.setLineWidth(max(1, r / 3)); ctx.strokeEllipse(in: rect) }
}

switch outcome {
case let .notFound(reason, cands):
    for p in cands { dot(p, 2, CGColor(red: 1, green: 0, blue: 0, alpha: 1), fill: true) }
    print(String(format: "NOT FOUND (%.0f ms) %@  candidates=%d  size=%dx%d", ms, reason, cands.count, w, h))
case let .found(r, cands):
    for p in cands { dot(p, 1.5, CGColor(red: 1, green: 0, blue: 0, alpha: 0.8), fill: true) }
    ctx.setStrokeColor(CGColor(red: 0, green: 0.6, blue: 1, alpha: 1)); ctx.setLineWidth(2)
    ctx.addLines(between: r.outline.map { CGPoint(x: $0.x, y: $0.y) }); ctx.closePath(); ctx.strokePath()
    let rad = r.pitch * 0.32
    for hole in r.holes {
        dot(hole.point, rad, hole.detected ? CGColor(red: 0, green: 0.9, blue: 0.2, alpha: 1)
                                           : CGColor(red: 1, green: 0.6, blue: 0, alpha: 1), fill: false)
    }
    for name in ["A1", "J1", "A\(r.cols)", "J\(r.cols)"] {
        if let p = r.hole(named: name)?.point { dot(p, r.pitch * 0.55, CGColor(red: 1, green: 0, blue: 1, alpha: 1), fill: false) }
    }
    if let a = r.hole(named: "A1")?.point { dot(a, r.pitch * 0.2, CGColor(red: 1, green: 0, blue: 1, alpha: 1), fill: true) }
    print(String(format: "FOUND (%.0f ms) %@ cols=%d pitch=%.1f seen=%.0f%% resid=%.3f reliable=%@ candidates=%d size=%dx%d",
                 ms, r.boardKind, r.cols, r.pitch, r.detectedRatio * 100, r.meanResidual, r.isReliable ? "yes" : "no",
                 cands.count, w, h))
    // 有合成圖的真值 JSON 就算誤差（單位：孔距）
    let truthURL = URL(fileURLWithPath: args[1]).deletingPathExtension().appendingPathExtension("json")
    if let data = try? Data(contentsOf: truthURL),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let tcols = obj["cols"] as? Int, let tp = obj["points"] as? [String: [Double]] {
        // 真值以原圖像素表示；偵測在縮圖上跑，要換算
        let scale = Double(w) / Double(CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil)
            .flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }?[kCGImagePropertyPixelWidth] as? Int ?? w)
        var errs: [String] = []
        var worst = 0.0
        for (name, xy) in tp.sorted(by: { $0.key < $1.key }) {
            guard let hole = r.hole(named: name) else { errs.append("\(name)=missing"); worst = 99; continue }
            let e = simd_distance(hole.point, SIMD2(xy[0] * scale, xy[1] * scale)) / r.pitch
            worst = max(worst, e)
            errs.append(String(format: "%@=%.2f", name, e))
        }
        let pass = tcols == r.cols && worst < 0.5
        print("  truth cols=\(tcols)  err(pitch) " + errs.joined(separator: " ") + (pass ? "  PASS" : "  FAIL"))
    }
}

let out = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out, nil)
CGImageDestinationFinalize(dest)
