import SwiftUI

/// 麵包板孔位辨識畫面：相機是主畫面，上方狀態、下方操作。
struct ScannerView: View {
    @State private var model = ScannerModel()
    @State private var targetText = ""
    @FocusState private var editing: Bool

    var body: some View {
        GeometryReader { geo in
            let map = ImageToView(imageSize: model.imageSize, viewSize: geo.size)
            ZStack {
                Color.black
                if let frozen = model.frozenImage {
                    Image(decorative: frozen, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                } else {
                    CameraPreviewView(session: model.camera.session)
                }
                if let seg = model.seg, model.mode.runsSeg {
                    // 各階段：分割（粉紅）、RGB 增強（青）、直線四邊形（黃）；對照時另畫 AI 管線的孔（青點）
                    SegOverlayView(seg: seg, map: map, pipeline: model.pipeline, compare: model.mode == .compare,
                                   showPipelineHoles: model.mode == .compare && !model.usingAI)
                }
                if let result = model.result {
                    HoleOverlayView(result: result, map: map, targets: model.targetHoles,
                                    showAllLabels: model.showAllLabels)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { location in
                if editing { editing = false; return }
                let p = map.image(location)
                model.tap(imagePoint: p)
                targetText = model.targets.joined(separator: "-")
            }
        }
        .ignoresSafeArea()
        .overlay(alignment: .top) { statusBar.padding(.horizontal, 16).padding(.top, 8) }
        .overlay(alignment: .bottom) { controls.padding(.horizontal, 16).padding(.bottom, 12) }
        // 截圖／示範模式（GUIDE_DEMO）不開相機，也就不會跳出相機權限對話框
        .task { if ProcessInfo.processInfo.environment["GUIDE_DEMO"] == nil { await model.start() } }
        .onDisappear { model.stop() }
        .statusBarHidden(false)
    }

    // MARK: - 上方狀態

    private var statusBar: some View {
        HStack(spacing: 10) {
            Circle().fill(statusColor).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusTitle).font(.subheadline.weight(.semibold))
                Text("實驗功能：用相機找出麵包板和孔位。接線指引在「專案」分頁。")
                    .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if case .error = model.status {
                    // 沒有相機：不顯示搜尋中的數字
                } else if model.mode == .compare {
                    compareStats
                } else if model.mode == .ai {
                    aiStats
                } else if let r = model.result {
                    Text("\(r.boardKind) · 看到 \(Int(r.detectedRatio * 100))% 孔 · \(Int(model.milliseconds)) ms")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("候選暗點 \(model.candidateCount) · \(Int(model.milliseconds)) ms")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// AI 管線：各階段耗時＋品質
    private var aiStats: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let b = model.seg?.board {
                Text("分割 \(Int(b.score * 100))% · 佔畫面 \(Int(b.areaFraction * 100))%" + pipelineQuality)
            } else {
                Text("AI 沒找到麵包板")
            }
            Text(stageLine).monospacedDigit()
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    private var pipelineQuality: String {
        guard let p = model.pipeline else { return "" }
        var s = p.refined != nil ? String(format: " · 顏色貼合 %.0f%%", p.refinedIoU * 100) : " · 顏色未採用"
        if p.quad != nil { s += String(format: " · 邊 %.1f px", p.lineRMS) }
        if p.detection != nil { s += p.rectified ? " · 拉正" : " · 裁切" }
        return s
    }

    private var stageLine: String {
        let st = model.stageMilliseconds
        let total = model.segMilliseconds + st.rgb + st.line + st.hole
        return String(format: "分割 %.0f＋RGB %.0f＋直線 %.0f＋孔位 %.0f＝%.0f ms",
                      model.segMilliseconds, st.rgb, st.line, st.hole, total)
    }

    /// 對照：每種方法一行「有沒有找到、耗時、累計命中率」
    private var compareStats: some View {
        let st = model.stats
        let ai = model.stageMilliseconds
        func pct(_ n: Int) -> String { st.frames == 0 ? "–" : "\(n * 100 / st.frames)%" }
        return Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 1) {
            GridRow {
                Text("經典孔位"); found(model.classicalFound)
                Text("\(Int(model.milliseconds)) ms").monospacedDigit(); Text("命中 \(pct(st.classical))")
            }
            GridRow {
                Text("AI 分割"); found(model.seg?.board != nil)
                Text("\(Int(model.segMilliseconds)) ms").monospacedDigit(); Text("命中 \(pct(st.seg))")
            }
            GridRow {
                Text("AI 管線孔位"); found(model.aiFound)
                Text("\(Int(model.segMilliseconds + ai.rgb + ai.line + ai.hole)) ms").monospacedDigit()
                Text("命中 \(pct(st.ai))")
            }
            Text(stageLine).monospacedDigit().gridCellColumns(4)
            if model.usingAI {
                Text("經典找不到，孔位改用 AI 管線的結果").foregroundStyle(.orange).gridCellColumns(4)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .onTapGesture { model.resetStats() }
    }

    private func found(_ ok: Bool) -> some View {
        Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle")
            .foregroundStyle(ok ? .green : .red)
    }

    private var statusTitle: String {
        switch model.status {
        case .starting: return "啟動相機…"
        case let .searching(s): return s
        case .locked:
            if model.frozen { return "已凍結畫面" }
            return model.mode == .ai ? "AI 管線已鎖定麵包板" : "已鎖定麵包板"
        case let .unreliable(s): return "暫停指引：\(s)"
        case .cameraDenied: return "沒有相機權限，請到「設定」開啟"
        case let .error(s): return s
        }
    }

    private var statusColor: Color {
        switch model.status {
        case .locked: return .green
        case .unreliable: return .orange
        case .cameraDenied, .error: return .red
        default: return .yellow
        }
    }

    // MARK: - 下方操作

    private var controls: some View {
        VStack(spacing: 10) {
            Picker("模式", selection: $model.mode) {
                ForEach(ScanMode.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(4)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            if let r = model.result, !model.targets.isEmpty {
                let missing = model.targets.filter { r.point(named: $0) == nil }
                if !missing.isEmpty {
                    Text("這塊板子沒有 \(missing.joined(separator: "、"))（A–J，1–\(r.cols)）")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Group {
            HStack(spacing: 8) {
                Image(systemName: "scope").foregroundStyle(.secondary)
                TextField("輸入孔位，例如 A5 或 A5-J10", text: $targetText)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($editing)
                    .submitLabel(.done)
                    .onSubmit { model.setTargets(from: targetText) }
                    .onChange(of: targetText) { _, v in model.setTargets(from: v) }
                if !targetText.isEmpty {
                    Button { targetText = ""; model.targets = [] } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            HStack(spacing: 10) {
                toggleButton(model.frozen ? "繼續" : "凍結", model.frozen ? "play.fill" : "pause.fill", model.frozen) {
                    model.frozen.toggle()
                }
                toggleButton("翻轉 180°", "arrow.triangle.2.circlepath", model.flip) { model.flip.toggle() }
                toggleButton("全部欄號", "number", model.showAllLabels) { model.showAllLabels.toggle() }
                toggleButton("補光", model.torch ? "flashlight.on.fill" : "flashlight.off.fill", model.torch) {
                    model.torch.toggle()
                }
            }
            Text(model.mode == .compare ? "粉紅＝分割、青＝顏色增強、黃＝直線四邊形、青點＝AI 孔位 · 點統計歸零"
                 : "點畫面上的孔可設起點／終點 · A1 不在你預期的角落就按「翻轉」")
                .font(.caption2).foregroundStyle(.white.opacity(0.8))
                .shadow(radius: 2)
        }
    }

    private func toggleButton(_ title: String, _ icon: String, _ on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                Text(title).font(.caption2.weight(.medium))
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(on ? Color.black : Color.white)
            .background(on ? AnyShapeStyle(Color.white) : AnyShapeStyle(.ultraThinMaterial),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    ScannerView()
}
