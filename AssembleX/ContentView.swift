import SwiftUI

/// App 只有一個主流程：連線桌面專案（或打開手機上存的）→ 接線指引／AR。
/// 「找麵包板」「元件定位」兩個實驗分頁已拿掉（程式檔保留，未來需要可再接回）。
struct ContentView: View {
    var body: some View {
        ConnectView()
            .preferredColorScheme(.dark)
    }
}

#Preview {
    ContentView()
}
