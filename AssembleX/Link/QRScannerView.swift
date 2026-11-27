import SwiftUI
import VisionKit
import AVFoundation

/// 用 VisionKit 掃 QR code；讀到 `assemblex://` 開頭的內容就回傳。
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    /// 掃到別的 QR code（不是 assemblex://）：讓畫面提示，掃描器不關
    var onOther: (() -> Void)? = nil

    static var isAvailable: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }
    /// 這台裝置有沒有能掃描的相機（沒權限也算有；模擬器沒有）
    static var deviceCanScan: Bool { DataScannerViewController.isSupported }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        context.coordinator.onOther = onOther
        if !vc.isScanning { try? vc.startScanning() }
    }

    static func dismantleUIViewController(_ vc: DataScannerViewController, coordinator: Coordinator) {
        vc.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        var onOther: (() -> Void)?
        private var sent = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            handle(addedItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            handle([item])
        }

        private func handle(_ items: [RecognizedItem]) {
            guard !sent else { return }
            for item in items {
                if case let .barcode(b) = item, let s = b.payloadStringValue {
                    if s.lowercased().hasPrefix("assemblex://") {
                        sent = true
                        onCode(s)
                        return
                    }
                    onOther?()
                }
            }
        }
    }
}

/// 掃描畫面的內容：可以掃就開相機；相機權限被關掉時說清楚並給「打開設定」；裝置不支援才說不能掃。
struct QRScanContent: View {
    let fallbackHint: String
    let onCode: (String) -> Void
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var otherCode = false
    @State private var otherTask: Task<Void, Never>?

    private func showOther() {
        withAnimation { otherCode = true }
        otherTask?.cancel()
        otherTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            withAnimation { otherCode = false }
        }
    }
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            if QRScannerView.isAvailable {
                QRScannerView(onCode: onCode, onOther: { showOther() }).ignoresSafeArea()
                    .overlay(alignment: .bottom) {
                        if otherCode {
                            Label("這不是 AssembleX 的 QR code。請掃電腦 Studio「手機 AR」視窗裡的那一個。", systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline).foregroundStyle(.white)
                                .padding(12).background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 14))
                                .padding(.horizontal, 16).padding(.bottom, 40)
                                .transition(.opacity)
                        }
                    }
            } else if DataScannerViewController.isSupported && (status == .denied || status == .restricted) {
                ContentUnavailableView {
                    Label("相機權限被關閉", systemImage: "camera.badge.ellipsis")
                } description: {
                    Text("到「設定 › AssembleX」打開相機，才能掃電腦上的 QR code。也可以\(fallbackHint)。")
                } actions: {
                    Button("打開設定") {
                        if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if DataScannerViewController.isSupported && status == .notDetermined {
                ProgressView("等待相機權限…")
                    .task {
                        _ = await AVCaptureDevice.requestAccess(for: .video)
                        status = AVCaptureDevice.authorizationStatus(for: .video)
                    }
            } else {
                ContentUnavailableView("這台裝置不能掃描", systemImage: "qrcode",
                                       description: Text("這台裝置沒有可用的相機（例如模擬器）。請\(fallbackHint)。"))
            }
        }
        // 從「設定」回來時重新檢查權限
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            status = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }
}
