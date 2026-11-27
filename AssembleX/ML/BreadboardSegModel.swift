import Accelerate
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import simd

// YOLO11m-seg（使用者自己訓練的麵包板分割模型）→ Core ML。
//
// 模型輸出（Ultralytics 匯出、nms=False）：
//   det:    [1, 4 + nc + 32, N]   每個 anchor：cx, cy, w, h（輸入像素）、nc 個類別分數、32 個遮罩係數
//   protos: [1, 32, S/4, S/4]     遮罩原型；遮罩 = sigmoid(係數 · 原型)，再裁到框內
// 輸入是 S×S 的 letterbox 影像（等比縮放、上下或左右補灰邊），這裡自己做 letterbox，
// 所以能精確換回相機直式影像座標（1080×1920，和 BreadboardDetector 同一套座標）。

/// 一個分割結果（座標都是相機直式影像像素）。
struct SegInstance: Sendable {
    let classIndex: Int
    let className: String
    let score: Float
    let box: CGRect                     // 影像像素
    let hull: [SIMD2<Double>]           // 遮罩凸包（影像像素），畫外框用
    let quad: [SIMD2<Double>]           // 凸包簡化成四邊形（左上起順時針）；遮罩太小時為空
    let mask: SegMask                   // 遮罩點陣（只含影像範圍，不含 letterbox 灰邊）
    let areaFraction: Double            // 遮罩面積 / 影像面積
}

/// 遮罩點陣：width×height，覆蓋整張影像（每格對應 imageWidth/width 像素）。
struct SegMask: Sendable {
    let width: Int
    let height: Int
    let bits: [UInt8]                   // 0 或 1，row-major

    func contains(imageX x: Double, imageY y: Double, imageSize: CGSize) -> Bool {
        let u = Int(x / Double(imageSize.width) * Double(width))
        let v = Int(y / Double(imageSize.height) * Double(height))
        guard u >= 0, v >= 0, u < width, v < height else { return false }
        return bits[v * width + u] != 0
    }
}

struct SegFrame: Sendable {
    let instances: [SegInstance]
    let imageSize: CGSize
    let milliseconds: Double            // 前處理＋推論＋解碼
    let inferenceMilliseconds: Double   // 只有 model.prediction
    var preprocessMilliseconds = 0.0    // letterbox
    var decodeMilliseconds = 0.0        // 框＋NMS＋遮罩

    /// 主要的麵包板（分數最高的「整塊板子」類別；沒有就分數最高的）。
    var board: SegInstance? {
        instances.first { BreadboardSegModel.boardClassNames.contains($0.className.lowercased()) } ?? instances.first
    }
}

final class BreadboardSegModel: @unchecked Sendable {
    /// 類別名稱裡代表「整塊麵包板」的名字（依匯出時讀到的類別名稱調整）。
    static let boardClassNames: Set<String> = ["breadboard", "board", "bread_board", "bread-board"]

    var confidenceThreshold: Float = 0.25
    var iouThreshold: Float = 0.5
    var maxInstances = 4

    let inputSize: Int
    let classNames: [String]
    private let model: MLModel
    private let inputName: String
    private let detName: String
    private let protoName: String
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?

    enum LoadError: Error { case notFound, badSignature(String) }

    /// 從 App bundle 載入（Xcode 會把 .mlpackage 編成 .mlmodelc）。
    convenience init(computeUnits: MLComputeUnits = .all) throws {
        guard let url = Bundle.main.url(forResource: "BreadboardSeg", withExtension: "mlmodelc") else {
            throw LoadError.notFound
        }
        try self.init(compiledURL: url, computeUnits: computeUnits)
    }

    init(compiledURL url: URL, computeUnits: MLComputeUnits = .all) throws {
        let cfg = MLModelConfiguration()
        cfg.computeUnits = computeUnits
        model = try MLModel(contentsOf: url, configuration: cfg)
        let desc = model.modelDescription

        guard let (inName, inDesc) = desc.inputDescriptionsByName.first(where: { $0.value.type == .image }),
              let c = inDesc.imageConstraint else {
            throw LoadError.badSignature("找不到影像輸入")
        }
        inputName = inName
        inputSize = c.pixelsWide

        // 兩個輸出：4 維的是原型，3 維的是偵測
        var det: String?, proto: String?
        for (name, d) in desc.outputDescriptionsByName {
            let rank = d.multiArrayConstraint?.shape.count ?? 0
            if rank == 4 { proto = name } else if rank == 3 { det = name }
        }
        guard let det, let proto else { throw LoadError.badSignature("輸出不是 YOLO-seg 格式") }
        detName = det
        protoName = proto

        // Ultralytics 會把類別名稱寫進 metadata 的 names（Python dict 字串）
        let meta = desc.metadata[.creatorDefinedKey] as? [String: String] ?? [:]
        classNames = Self.parseNames(meta["names"] ?? "")
    }

    // MARK: - 推論

    /// pixelBuffer：相機的直式影像（任何 Core Image 讀得懂的格式，例如 420f）。
    func predict(_ pixelBuffer: CVPixelBuffer) throws -> SegFrame {
        let t0 = CFAbsoluteTimeGetCurrent()
        let imgW = CVPixelBufferGetWidth(pixelBuffer), imgH = CVPixelBufferGetHeight(pixelBuffer)
        let lb = Letterbox(imageWidth: imgW, imageHeight: imgH, size: inputSize)
        let input = try makeInput(pixelBuffer, lb)

        let t1 = CFAbsoluteTimeGetCurrent()
        let out = try model.prediction(from: MLDictionaryFeatureProvider(
            dictionary: [inputName: MLFeatureValue(pixelBuffer: input)]))
        let t2 = CFAbsoluteTimeGetCurrent()

        guard let det = out.featureValue(for: detName)?.multiArrayValue,
              let protos = out.featureValue(for: protoName)?.multiArrayValue else {
            throw LoadError.badSignature("沒有輸出")
        }
        let instances = decode(det: det, protos: protos, lb: lb)
        let t3 = CFAbsoluteTimeGetCurrent()
        return SegFrame(instances: instances, imageSize: CGSize(width: imgW, height: imgH),
                        milliseconds: (t3 - t0) * 1000, inferenceMilliseconds: (t2 - t1) * 1000,
                        preprocessMilliseconds: (t1 - t0) * 1000, decodeMilliseconds: (t3 - t2) * 1000)
    }

    struct Letterbox {
        let scale: Double, padX: Double, padY: Double, size: Int
        let imageWidth: Int, imageHeight: Int
        init(imageWidth: Int, imageHeight: Int, size: Int) {
            self.imageWidth = imageWidth; self.imageHeight = imageHeight; self.size = size
            scale = Double(size) / Double(max(imageWidth, imageHeight))
            padX = (Double(size) - Double(imageWidth) * scale) / 2
            padY = (Double(size) - Double(imageHeight) * scale) / 2
        }
        func toImage(_ x: Double, _ y: Double) -> SIMD2<Double> { SIMD2((x - padX) / scale, (y - padY) / scale) }
    }

    private func makeInput(_ pb: CVPixelBuffer, _ lb: Letterbox) throws -> CVPixelBuffer {
        let s = inputSize
        if pool == nil {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: s, kCVPixelBufferHeightKey as String: s,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        }
        var out: CVPixelBuffer?
        guard let pool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let out else {
            throw LoadError.badSignature("無法建立輸入影像")
        }
        // Ultralytics 訓練時 letterbox 用灰色 114
        let gray = CIImage(color: CIColor(red: 114 / 255, green: 114 / 255, blue: 114 / 255))
            .cropped(to: CGRect(x: 0, y: 0, width: s, height: s))
        // 上下 padding 對稱，Core Image 的 y 軸翻轉不影響
        let img = CIImage(cvPixelBuffer: pb)
            .transformed(by: CGAffineTransform(scaleX: lb.scale, y: lb.scale)
                .concatenating(CGAffineTransform(translationX: lb.padX, y: lb.padY)))
        ciContext.render(img.composited(over: gray), to: out)
        return out
    }

    // MARK: - 解碼

    private func decode(det: MLMultiArray, protos: MLMultiArray, lb: Letterbox) -> [SegInstance] {
        let detT = Tensor(det)            // [1, C, N]
        let C = detT.shape[1], N = detT.shape[2]
        let D = detT.data
        @inline(__always) func d(_ ch: Int, _ i: Int) -> Float { D[ch * N + i] }
        let nm = protos.shape[1].intValue // 32
        let nc = C - 4 - nm
        guard nc >= 1 else { return [] }

        // 1. 分數門檻
        struct Cand { var i: Int; var cls: Int; var score: Float; var box: SIMD4<Float> }   // x1 y1 x2 y2（輸入像素）
        var cands: [Cand] = []
        for i in 0..<N {
            var best: Float = 0, bc = 0
            for c in 0..<nc {
                let v = d(4 + c, i)
                if v > best { best = v; bc = c }
            }
            guard best >= confidenceThreshold else { continue }
            let cx = d(0, i), cy = d(1, i), w = d(2, i), h = d(3, i)
            cands.append(Cand(i: i, cls: bc, score: best, box: SIMD4(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)))
        }
        cands.sort { $0.score > $1.score }

        // 2. NMS（同類別）
        var kept: [Cand] = []
        for c in cands {
            if kept.count >= maxInstances { break }
            if kept.contains(where: { $0.cls == c.cls && iou($0.box, c.box) > iouThreshold }) { continue }
            kept.append(c)
        }

        // 3. 遮罩
        let P = Tensor(protos)            // [1, nm, mh, mw]
        let mh = P.shape[2], mw = P.shape[3], plane = mh * mw
        let PD = P.data
        let protoScale = Double(mw) / Double(lb.size)       // 輸入像素 → 原型格
        // 影像在原型格中的範圍（去掉 letterbox 灰邊）
        let u0 = Int((lb.padX * protoScale).rounded()), v0 = Int((lb.padY * protoScale).rounded())
        let u1 = mw - u0, v1 = mh - v0
        let outW = u1 - u0, outH = v1 - v0
        let pixelSize = Double(lb.imageWidth) / Double(outW)   // 一格 = 多少影像像素

        return kept.map { c in
            var coef = [Float](repeating: 0, count: nm)
            for k in 0..<nm { coef[k] = d(4 + nc + k, c.i) }
            // 框（原型格）
            let bx0 = max(u0, Int(Double(c.box.x) * protoScale)), by0 = max(v0, Int(Double(c.box.y) * protoScale))
            let bx1 = min(u1, Int((Double(c.box.z) * protoScale).rounded(.up)))
            let by1 = min(v1, Int((Double(c.box.w) * protoScale).rounded(.up)))
            var bits = [UInt8](repeating: 0, count: outW * outH)
            var on = 0
            if bx1 > bx0, by1 > by0 {
                for v in by0..<by1 {
                    for u in bx0..<bx1 {
                        var s: Float = 0
                        let o = v * mw + u
                        for k in 0..<nm { s += coef[k] * PD[k * plane + o] }
                        if s > 0 {          // sigmoid(s) > 0.5
                            bits[(v - v0) * outW + (u - u0)] = 1
                            on += 1
                        }
                    }
                }
            }
            let mask = SegMask(width: outW, height: outH, bits: bits)
            let hull = Self.convexHull(of: mask).map { $0 * pixelSize }
            let p0 = lb.toImage(Double(c.box.x), Double(c.box.y)), p1 = lb.toImage(Double(c.box.z), Double(c.box.w))
            let name = c.cls < classNames.count ? classNames[c.cls] : "class\(c.cls)"
            return SegInstance(
                classIndex: c.cls, className: name, score: c.score,
                box: CGRect(x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y),
                hull: hull, quad: Self.quad(from: hull),
                mask: mask, areaFraction: Double(on) / Double(max(1, outW * outH)))
        }
    }

    private func iou(_ a: SIMD4<Float>, _ b: SIMD4<Float>) -> Float {
        let iw = max(0, min(a.z, b.z) - max(a.x, b.x)), ih = max(0, min(a.w, b.w) - max(a.y, b.y))
        let inter = iw * ih
        let ua = (a.z - a.x) * (a.w - a.y) + (b.z - b.x) * (b.w - b.y) - inter
        return ua > 0 ? inter / ua : 0
    }

    // MARK: - 幾何

    /// 遮罩的凸包（格座標，取每格四角）。Andrew monotone chain。
    static func convexHull(of m: SegMask) -> [SIMD2<Double>] {
        var pts: [SIMD2<Double>] = []
        for v in 0..<m.height {
            var first = -1, last = -1
            for u in 0..<m.width where m.bits[v * m.width + u] != 0 {
                if first < 0 { first = u }
                last = u
            }
            guard first >= 0 else { continue }
            pts.append(SIMD2(Double(first), Double(v))); pts.append(SIMD2(Double(first), Double(v + 1)))
            pts.append(SIMD2(Double(last + 1), Double(v))); pts.append(SIMD2(Double(last + 1), Double(v + 1)))
        }
        return convexHull(pts)
    }

    static func convexHull(_ input: [SIMD2<Double>]) -> [SIMD2<Double>] {
        let p = input.sorted { $0.x != $1.x ? $0.x < $1.x : $0.y < $1.y }
        guard p.count >= 3 else { return p }
        func cross(_ o: SIMD2<Double>, _ a: SIMD2<Double>, _ b: SIMD2<Double>) -> Double {
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
        }
        var lower: [SIMD2<Double>] = [], upper: [SIMD2<Double>] = []
        for q in p {
            while lower.count >= 2, cross(lower[lower.count - 2], lower[lower.count - 1], q) <= 0 { lower.removeLast() }
            lower.append(q)
        }
        for q in p.reversed() {
            while upper.count >= 2, cross(upper[upper.count - 2], upper[upper.count - 1], q) <= 0 { upper.removeLast() }
            upper.append(q)
        }
        return Array(lower.dropLast() + upper.dropLast())
    }

    /// 凸包 → 四邊形：反覆刪掉「刪了面積增加最少」的頂點（把兩鄰邊延長相交）。
    static func quad(from hull: [SIMD2<Double>]) -> [SIMD2<Double>] {
        guard hull.count >= 4 else { return [] }
        // 簡化版：取凸包上離質心最遠、且彼此分散的四點（對長方形板子夠用）
        let c = hull.reduce(SIMD2<Double>(0, 0), +) / Double(hull.count)
        // 四個方向：(-1,-1) 左上、(1,-1) 右上、(1,1) 右下、(-1,1) 左下
        let dirs: [SIMD2<Double>] = [SIMD2(-1, -1), SIMD2(1, -1), SIMD2(1, 1), SIMD2(-1, 1)]
        return dirs.map { d in hull.max { simd_dot($0 - c, d) < simd_dot($1 - c, d) }! }
    }

    /// "{0: 'breadboard', 1: 'hole'}" → ["breadboard", "hole"]
    static func parseNames(_ s: String) -> [String] {
        var out: [Int: String] = [:]
        let pattern = #"(\d+)\s*:\s*['"]([^'"]*)['"]"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            guard let r1 = Range(m.range(at: 1), in: s), let r2 = Range(m.range(at: 2), in: s),
                  let k = Int(s[r1]) else { continue }
            out[k] = String(s[r2])
        }
        return (0..<(out.keys.max().map { $0 + 1 } ?? 0)).map { out[$0] ?? "class\($0)" }
    }
}

/// MLMultiArray → 連續 row-major Float（Float16 用 vImage 轉，比 MLShapedArray 快很多）。
private struct Tensor {
    let shape: [Int]
    let data: [Float]
    init(_ a: MLMultiArray) {
        let shape = a.shape.map(\.intValue)
        self.shape = shape
        let count = shape.reduce(1, *)
        // row-major 連續才走快路徑
        var expect = 1, contiguous = true
        for (dim, st) in zip(shape, a.strides.map(\.intValue)).reversed() {
            if dim > 1 && st != expect { contiguous = false }
            expect *= dim
        }
        var out = [Float](repeating: 0, count: count)
        if contiguous && a.dataType == .float16 {
            a.withUnsafeBytes { src in
                out.withUnsafeMutableBytes { dst in
                    var s = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: src.baseAddress!), height: 1,
                                          width: vImagePixelCount(count), rowBytes: count * 2)
                    var d = vImage_Buffer(data: dst.baseAddress!, height: 1, width: vImagePixelCount(count), rowBytes: count * 4)
                    vImageConvert_Planar16FtoPlanarF(&s, &d, 0)
                }
            }
            data = out
        } else if contiguous && a.dataType == .float32 {
            a.withUnsafeBytes { src in
                out.withUnsafeMutableBytes { dst in dst.copyMemory(from: UnsafeRawBufferPointer(rebasing: src[0..<(count * 4)])) }
            }
            data = out
        } else {
            data = MLShapedArray<Float>(converting: a).scalars
        }
    }
}
