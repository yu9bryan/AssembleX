import CoreVideo
import Foundation

/// 在 ARFrame.capturedImage（橫式、420f）上找麵包板孔位：先跑 AI 管線（分割→四邊形→孔位），不可靠再用經典偵測。
/// 只在偵測佇列上使用。
final class ARBoardDetector: @unchecked Sendable {
    private let detector = BreadboardDetector()
    private let pipeline = BoardPipeline()
    private var segModel: BreadboardSegModel?
    private var segFailed = false

    func detect(_ pb: CVPixelBuffer) -> BreadboardResult? {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0), let cBase = CVPixelBufferGetBaseAddressOfPlane(pb, 1) else {
            CVPixelBufferUnlockBaseAddress(pb, .readOnly); return nil
        }
        var px = [UInt8](repeating: 0, count: w * h)
        px.withUnsafeMutableBytes { dst in
            let src = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<h { memcpy(dst.baseAddress! + y * w, src + y * stride, w) }
        }
        let color = QuarterYCbCr(yBase: base.assumingMemoryBound(to: UInt8.self), yStride: stride,
                                 cBase: cBase.assumingMemoryBound(to: UInt8.self),
                                 cStride: CVPixelBufferGetBytesPerRowOfPlane(pb, 1), width: w, height: h)
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        let gray = GrayImage(width: w, height: h, pixels: px)

        // AI 管線（預設）
        if segModel == nil, !segFailed {
            do { segModel = try BreadboardSegModel() } catch { segFailed = true }
        }
        if let segModel, let seg = try? segModel.predict(pb) {
            let frame = pipeline.run(seg: seg, gray: gray, color: color)
            if case let .found(r, _)? = frame.detection, r.isReliable { return r }
        }
        // 經典偵測備援
        if case let .found(r, _) = detector.detect(gray), r.isReliable { return r }
        return nil
    }
}
