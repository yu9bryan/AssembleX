import AVFoundation
import SwiftUI
import UIKit

/// 相機預覽（aspectFill、直式），和偵測用的影像同一個裁切，疊圖座標才對得上。
struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewUIView {
        let v = PreviewUIView()
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {}

    final class PreviewUIView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        override func layoutSubviews() {
            super.layoutSubviews()
            if let c = previewLayer.connection, c.isVideoRotationAngleSupported(90), c.videoRotationAngle != 90 {
                c.videoRotationAngle = 90
            }
        }
    }
}

/// 影像座標（直式像素）↔ 畫面座標，aspectFill。
struct ImageToView {
    let imageSize: CGSize
    let viewSize: CGSize

    var scale: CGFloat { max(viewSize.width / imageSize.width, viewSize.height / imageSize.height) }
    var offset: CGPoint {
        CGPoint(x: (viewSize.width - imageSize.width * scale) / 2, y: (viewSize.height - imageSize.height * scale) / 2)
    }

    func view(_ p: SIMD2<Double>) -> CGPoint {
        CGPoint(x: CGFloat(p.x) * scale + offset.x, y: CGFloat(p.y) * scale + offset.y)
    }

    func image(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - offset.x) / scale, y: (p.y - offset.y) / scale)
    }
}
