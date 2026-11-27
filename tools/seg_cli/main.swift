// macOS 測試工具：同一張圖跑 AI 分割（Core ML）、經典孔位偵測、AI 裁切＋經典，輸出耗時與疊圖。
// 用法：tools/test_seg.sh <圖片…>
import CoreGraphics
import CoreML
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import simd

func load(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                 kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: 1920]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
}

func pixelBuffer(_ cg: CGImage) -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
    CVPixelBufferCreate(nil, cg.width, cg.height, kCVPixelFormatType_32BGRA, attrs, &pb)
    let b = pb!
    CVPixelBufferLockBaseAddress(b, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(b), width: cg.width, height: cg.height, bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(b), space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    CVPixelBufferUnlockBaseAddress(b, [])
    return b
}

func gray(_ cg: CGImage) -> GrayImage {
    let w = cg.width, h = cg.height
    var px = [UInt8](repeating: 0, count: w * h)
    px.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return GrayImage(width: w, height: h, pixels: px)
}

func describe(_ d: BreadboardDetection) -> String {
    switch d {
    case let .found(r, _): return r.isReliable ? "OK \(r.cols)欄 看到\(Int(r.detectedRatio * 100))%" : "不可靠(\(Int(r.detectedRatio * 100))%, res \(String(format: "%.2f", r.meanResidual)))"
    case let .notFound(reason, _): return "沒找到：\(reason)"
    }
}

/// 合成圖真值（A1/J1/AN/JN 四角）誤差，單位孔距；回傳 (PASS?, 說明)
func truthCheck(_ path: String, _ d: BreadboardDetection, scale: Double) -> (Bool, String)? {
    let url = URL(fileURLWithPath: path).deletingPathExtension().appendingPathExtension("json")
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let tcols = obj["cols"] as? Int, let tp = obj["points"] as? [String: [Double]] else { return nil }
    guard case let .found(r, _) = d, r.isReliable else { return (false, "沒找到") }
    var worst = 0.0
    for (name, xy) in tp {
        guard let h = r.hole(named: name) else { return (false, "缺 \(name)") }
        worst = max(worst, simd_distance(h.point, SIMD2(xy[0] * scale, xy[1] * scale)) / r.pitch)
    }
    let ok = tcols == r.cols && worst < 0.5
    return (ok, String(format: "%@ 最差 %.2f 孔距%@", ok ? "PASS" : "FAIL", worst, tcols == r.cols ? "" : " 欄數錯"))
}

/// 電源軌真值：每排頭尾孔的誤差（孔距）；回傳 (通過?, 說明)
func railCheck(_ path: String, _ d: BreadboardDetection?, scale: Double) -> (Bool, String)? {
    let url = URL(fileURLWithPath: path).deletingPathExtension().appendingPathExtension("json")
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let tr = obj["rails"] as? [String: [Double]] else { return nil }
    guard case let .found(r, _)? = d, r.isReliable else { return (false, "沒找到主區") }
    var worst = 0.0, missing: [String] = []
    for (name, xy) in tr {
        guard let p = r.rails.first(where: { $0.name == name }) else { missing.append(name); continue }
        worst = max(worst, simd_distance(p.point, SIMD2(xy[0] * scale, xy[1] * scale)) / r.pitch)
    }
    let rows = r.railRows.map { "\($0[0].side == 0 ? "A" : "J")\($0[0].line == 0 ? "內" : "外")\($0.count)" }.joined(separator: " ")
    let ok = missing.isEmpty && worst < 0.5
    return (ok, String(format: "%@ [%@] 最差 %.2f 孔距%@", ok ? "PASS" : "FAIL", rows as NSString, worst,
                       missing.isEmpty ? "" : " 缺 " + missing.sorted().joined(separator: ",")))
}

let args = CommandLine.arguments
guard args.count >= 4 else { print("usage: seg_cli <BreadboardSeg.mlmodelc> <outdir> <image…>"); exit(1) }
let units: MLComputeUnits = ProcessInfo.processInfo.environment["SEG_CPU"] != nil ? .cpuOnly : .all
let seg = try BreadboardSegModel(compiledURL: URL(fileURLWithPath: args[1]), computeUnits: units)
print("classes=\(seg.classNames) input=\(seg.inputSize)")
let det = BreadboardDetector()
let pipeline = BoardPipeline()
pipeline.detector.params.debug = ProcessInfo.processInfo.environment["BB_DEBUG"] != nil
var tally = (classical: 0, pipeline: 0, n: 0)
var found = (classical: 0, pipeline: 0, images: 0)
var railTally = (classical: 0, pipeline: 0, n: 0)
var dumpName = ""
if ProcessInfo.processInfo.environment["SEG_DUMP"] != nil {
    pipeline.onRectified = { g in
        let url = URL(fileURLWithPath: args[2]).appendingPathComponent("\(dumpName)_rect.png")
        guard let cg = g.makeGrayCGImage(),
              let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(d, cg, nil); CGImageDestinationFinalize(d)
    }
}
extension GrayImage {
    func makeGrayCGImage() -> CGImage? {
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                       space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
                       provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }
}
det.params.debug = ProcessInfo.processInfo.environment["BB_DEBUG"] != nil

for path in args[3...] {
    guard let cg = load(path) else { print("cannot load \(path)"); continue }
    let pb = pixelBuffer(cg)
    _ = try seg.predict(pb)                       // 暖機
    var times: [Double] = [], infer: [Double] = []
    var frame: SegFrame!
    for _ in 0..<5 { frame = try seg.predict(pb); times.append(frame.milliseconds); infer.append(frame.inferenceMilliseconds) }
    let g = gray(cg)
    var t0 = Date()
    let full = det.detect(g)
    let fullMs = Date().timeIntervalSince(t0) * 1000
    var seeded: BreadboardDetection?
    var seedMs = 0.0
    if let b = frame.board {
        t0 = Date(); seeded = det.detect(g, croppedTo: b.box); seedMs = Date().timeIntervalSince(t0) * 1000
    }
    if ProcessInfo.processInfo.environment["SEG_PROFILE"] != nil {
        print(String(format: "  前處理 %.1f ms  推論 %.1f ms  解碼 %.1f ms", frame.preprocessMilliseconds,
                     frame.inferenceMilliseconds, frame.decodeMilliseconds))
    }
    // AI 管線
    dumpName = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let color = QuarterYCbCr(rgba: CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self),
                             bytesPerRow: CVPixelBufferGetBytesPerRow(pb), width: cg.width, height: cg.height, bgr: true)
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    var pf = pipeline.run(seg: frame, gray: g, color: color)
    for _ in 0..<3 {            // 取穩定的耗時
        let again = pipeline.run(seg: frame, gray: g, color: color)
        pf.rgbMs = min(pf.rgbMs, again.rgbMs); pf.lineMs = min(pf.lineMs, again.lineMs); pf.holeMs = min(pf.holeMs, again.holeMs)
    }
    let srcW = Double(CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)
        .flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }?[kCGImagePropertyPixelWidth] as? Int ?? cg.width)
    let sc = Double(cg.width) / srcW
    let tc = truthCheck(path, full, scale: sc), tp = pf.detection.flatMap { truthCheck(path, $0, scale: sc) }
    found.images += 1
    if full.isReliable { found.classical += 1 }
    if pf.found { found.pipeline += 1 }
    if tc != nil { tally.n += 1 }
    if tc?.0 == true { tally.classical += 1 }
    if tp?.0 == true { tally.pipeline += 1 }
    print(String(format: "   管線 seg %.1f + RGB %.1f + 直線 %.1f + 孔位 %.1f = %.1f ms | RGB IoU %.2f%@ | 直線 RMS %.1f px | 格點夾角 %.1f° %@ | %@",
                 pf.segMs, pf.rgbMs, pf.lineMs, pf.holeMs, pf.totalMs, pf.refinedIoU, pf.refined == nil ? "(未採用)" : "",
                 pf.lineRMS, pf.latticeAngle, (pf.rectified ? "拉正" : "裁切") as NSString, (pf.detection.map(describe) ?? (pf.failure ?? "-")) as NSString))
    if let tc { print("   真值：經典 \(tc.1) ｜ 管線 \(tp?.1 ?? "沒找到")") }
    if let rc = railCheck(path, full, scale: sc) {
        let rp = railCheck(path, pf.detection, scale: sc)
        railTally.n += 1
        if rc.0 { railTally.classical += 1 }
        if rp?.0 == true { railTally.pipeline += 1 }
        print("   電源軌：經典 \(rc.1) ｜ 管線 \(rp?.1 ?? "沒找到")")
    }
    let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    let b = frame.board
    print(String(format: "%-26@ AI %@ %5.1f ms(推論 %4.1f) | 經典 %5.1f ms %@ | 裁切 %5.1f ms %@", name as NSString,
                 (b.map { String(format: "conf %.2f 面積 %2.0f%% box %.0f,%.0f %.0fx%.0f", $0.score, $0.areaFraction * 100,
                                 $0.box.minX, $0.box.minY, $0.box.width, $0.box.height) } ?? "沒找到") as NSString,
                 times.sorted()[2], infer.sorted()[2], fullMs, describe(full) as NSString,
                 seedMs, (seeded.map(describe) ?? "-") as NSString))

    // 疊圖：遮罩凸包（粉紅）、框（青）、四邊形角點（黃）
    let w = cg.width, h = cg.height
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)
    for inst in frame.instances {
        // 遮罩
        let m = inst.mask, cw = Double(w) / Double(m.width), chh = Double(h) / Double(m.height)
        ctx.setFillColor(CGColor(red: 1, green: 0.2, blue: 0.6, alpha: 0.3))
        for v in 0..<m.height { for u in 0..<m.width where m.bits[v * m.width + u] != 0 {
            ctx.fill(CGRect(x: Double(u) * cw, y: Double(v) * chh, width: cw, height: chh))
        } }
        ctx.setStrokeColor(CGColor(red: 1, green: 0.2, blue: 0.6, alpha: 1)); ctx.setLineWidth(4)
        ctx.addLines(between: inst.hull.map { CGPoint(x: $0.x, y: $0.y) }); ctx.closePath(); ctx.strokePath()
        ctx.setStrokeColor(CGColor(red: 0, green: 0.9, blue: 1, alpha: 1)); ctx.setLineWidth(2); ctx.stroke(inst.box)
        ctx.setFillColor(CGColor(red: 1, green: 0.9, blue: 0, alpha: 1))
        for q in inst.quad { ctx.fillEllipse(in: CGRect(x: q.x - 8, y: q.y - 8, width: 16, height: 16)) }
    }
    if let m = pf.refined {
        let cw = Double(w) / Double(m.width), chh = Double(h) / Double(m.height)
        ctx.setFillColor(CGColor(red: 0, green: 0.8, blue: 1, alpha: 0.25))
        for v in 0..<m.height { for u in 0..<m.width where m.bits[v * m.width + u] != 0 {
            ctx.fill(CGRect(x: Double(u) * cw, y: Double(v) * chh, width: cw, height: chh))
        } }
    }
    if let q = pf.quad {
        ctx.setStrokeColor(CGColor(red: 1, green: 0.9, blue: 0, alpha: 1)); ctx.setLineWidth(3)
        ctx.addLines(between: q.map { CGPoint(x: $0.x, y: $0.y) }); ctx.closePath(); ctx.strokePath()
    }
    if case let .found(r, _)? = pf.detection {
        for hole in r.holes {
            ctx.setFillColor(hole.detected ? CGColor(red: 0, green: 0.9, blue: 0.2, alpha: 1) : CGColor(red: 1, green: 0.6, blue: 0, alpha: 1))
            ctx.fillEllipse(in: CGRect(x: hole.point.x - 3, y: hole.point.y - 3, width: 6, height: 6))
        }
        for rh in r.rails {
            ctx.setFillColor(rh.line == 0 ? CGColor(red: 0, green: 0.9, blue: 1, alpha: 1) : CGColor(red: 1, green: 0.3, blue: 0.85, alpha: 1))
            let rect = CGRect(x: rh.point.x - 4, y: rh.point.y - 4, width: 8, height: 8)
            if rh.detected { ctx.fill(rect) } else { ctx.setStrokeColor(CGColor(red: 1, green: 0.6, blue: 0, alpha: 1)); ctx.stroke(rect) }
        }
        if let a = r.hole(named: "A1")?.point {
            ctx.setFillColor(CGColor(red: 1, green: 0, blue: 1, alpha: 1)); ctx.fillEllipse(in: CGRect(x: a.x - 9, y: a.y - 9, width: 18, height: 18))
        }
    }
    let out = URL(fileURLWithPath: args[2]).appendingPathComponent("\(name)_seg.png")
    let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
}

print("找到孔位（可靠）：經典 \(found.classical)/\(found.images)、AI 管線 \(found.pipeline)/\(found.images)")
if railTally.n > 0 { print("電源軌通過：經典 \(railTally.classical)/\(railTally.n)、AI 管線 \(railTally.pipeline)/\(railTally.n)") }
if tally.n > 0 { print("真值通過：經典 \(tally.classical)/\(tally.n)、AI 管線 \(tally.pipeline)/\(tally.n)") }
