import ARKit
import RealityKit
import SwiftUI

/// 元件定位畫面：同時辨識多個元件（L298N、W5500…），各自疊上 CAD 模型、顯示 6DoF。
/// 新增元件只要在 Resources 放 `<id>.profile.json`＋`<id>.mesh.json`（tools/cad_to_profile.py 產生）。
struct ModuleTrackerView: View {
    @State private var model = ModuleTrackerModel()

    var body: some View {
        ARContainer(model: model)
            .ignoresSafeArea()
            .overlay(alignment: .top) { statusPanel.padding(.horizontal, 16).padding(.top, 8) }
            .overlay(alignment: .bottom) { controls.padding(.horizontal, 16).padding(.bottom, 12) }
            .onAppear { model.run() }
            .onDisappear { model.pause() }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.mode == .rgb ? "元件定位（RGB＋CAD 顏色）" : "元件定位（LiDAR＋CAD 形狀）").font(.subheadline.weight(.semibold))
                Spacer()
                if ARWorldTrackingConfiguration.isSupported {
                    Text("\(Int(model.milliseconds)) ms").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Text("實驗功能：用相機找出元件的位置和角度。接線指引在「專案」分頁。")
                .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !ARWorldTrackingConfiguration.isSupported {
                Label("這台裝置沒有可用的 AR 相機（例如模擬器）。可以到「專案」頁用 3D 示範看接線。", systemImage: "camera.metering.unknown")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            } else if model.rows.isEmpty {
                Text("請在下方選擇要辨識的元件").font(.caption).foregroundStyle(.secondary)
            }
            // 沒有 AR 相機：不顯示「尋找中…」
            ForEach(ARWorldTrackingConfiguration.isSupported ? model.rows : []) { row in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Circle().fill(row.tracking ? (row.locatedOnly ? Color.yellow : Color.green) : Color.orange)
                            .frame(width: 9, height: 9)
                        Text(row.name).font(.caption.weight(.semibold))
                        Text(row.message).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if let t = row.cameraT, let e = row.euler {
                        Text(row.locatedOnly
                             ? String(format: "X %+.1f  Y %+.1f  Z %.1f cm · 方向未定", t.x * 100, t.y * 100, t.z * 100)
                             : String(format: "X %+.1f  Y %+.1f  Z %.1f cm · R %+.0f° P %+.0f° Y %+.0f°",
                                      t.x * 100, t.y * 100, t.z * 100, e.x, e.y, e.z))
                            .font(.caption2.monospacedDigit())
                    }
                    Text(row.debug).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var controls: some View {
        VStack(spacing: 8) {
            Picker("模式", selection: $model.mode) {
                Text("RGB（顏色）").tag(ModuleTracker.Mode.rgb)
                Text("LiDAR（形狀）").tag(ModuleTracker.Mode.lidar)
            }
            .pickerStyle(.segmented)
            .disabled(!model.lidarSupported && model.mode == .rgb)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.profiles) { p in
                        let on = model.enabled.contains(p.id)
                        Button {
                            if on { model.enabled.remove(p.id) } else { model.enabled.insert(p.id) }
                        } label: {
                            Label(p.displayName, systemImage: on ? "checkmark.circle.fill" : "circle")
                                .font(.subheadline.weight(.medium))
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .foregroundStyle(on ? Color.black : Color.white)
                                .background(on ? AnyShapeStyle(Color.white) : AnyShapeStyle(.ultraThinMaterial),
                                            in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            HStack(spacing: 8) {
                Toggle(isOn: $model.showModel) { Label("CAD 模型", systemImage: "cube.transparent") }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Button { model.saveDiagnostic() } label: {
                    Label(model.saveMessage ?? "存診斷畫面", systemImage: "camera.metering.matrix")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12).padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            Text(model.mode == .rgb ? "距離 15–30 cm、拿穩；整個元件要入鏡 · 位置為相機座標"
                                    : "元件平放在桌上、距離 20–40 cm；LiDAR 只看形狀，顏色不影響")
                .font(.caption2).foregroundStyle(.white.opacity(0.85)).shadow(radius: 2)
        }
    }
}

private struct ARContainer: UIViewRepresentable {
    let model: ModuleTrackerModel

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        view.renderOptions.insert(.disableMotionBlur)
        model.attach(view)
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {}
}
