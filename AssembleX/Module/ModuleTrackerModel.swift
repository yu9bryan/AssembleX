import ARKit
import Foundation
import Observation
import RealityKit
import simd
import UIKit

@MainActor
@Observable
final class ModuleTrackerModel {
    struct Row: Identifiable {
        let id: String
        let name: String
        var tracking = false
        var locatedOnly = false        // 位置找到、方向未定
        var message = "尋找中…"
        var cameraT: SIMD3<Double>?
        var euler: SIMD3<Double>?
        var debug = ""
    }

    private(set) var rows: [Row] = []
    private(set) var milliseconds = 0.0
    var saveMessage: String?
    var showModel = true { didSet { for id in entities.keys { updateVisibility(id) } } }
    /// 要辨識的元件（可多選，同時辨識）
    var enabled: Set<String> = [] { didSet { tracker.setEnabled(enabled); syncRows() } }
    /// RGB（顏色＋CAD）或 LiDAR（深度＋CAD 形狀，不看顏色）
    var mode: ModuleTracker.Mode = .rgb {
        didSet {
            guard oldValue != mode else { return }
            tracker.setMode(mode)
            for i in rows.indices { rows[i].tracking = false; rows[i].message = "尋找中…"; rows[i].cameraT = nil }
            visible.removeAll(); worldPose.removeAll()
            for id in entities.keys { updateVisibility(id) }
            run(reset: false)
        }
    }
    var lidarSupported: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) }

    let tracker = ModuleTracker()
    var profiles: [ComponentProfile] { tracker.profiles }
    private weak var arView: ARView?
    private var entities: [String: Entity] = [:]
    private var worldPose: [String: simd_float4x4] = [:]
    private var visible: Set<String> = []
    private var lastGood: [String: Date] = [:]

    init() {
        enabled = Set(tracker.profiles.map(\.id))
        syncRows()
    }

    func attach(_ view: ARView) {
        arView = view
        tracker.onOutput = { [weak self] out in
            Task { @MainActor in self?.handle(out) }
        }
        view.session.delegate = tracker
        let anchor = AnchorEntity(world: .zero)
        for p in profiles {
            let e = CADMeshEntity.make(resource: p.mesh, opacity: 0.55)
            e.isEnabled = false
            anchor.addChild(e)
            entities[p.id] = e
        }
        view.scene.addAnchor(anchor)
    }

    func run(reset: Bool = true) {
        guard let view = arView else { return }
        let config = ARWorldTrackingConfiguration()
        if mode == .lidar {
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
                config.frameSemantics.insert(.smoothedSceneDepth)
            } else if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
                config.frameSemantics.insert(.sceneDepth)
            }
        }
        if let best = ARWorldTrackingConfiguration.supportedVideoFormats.first(where: {
            $0.imageResolution == CGSize(width: 1920, height: 1440)
        }) { config.videoFormat = best }
        config.isAutoFocusEnabled = true
        view.session.run(config, options: reset ? [.resetTracking, .removeExistingAnchors] : [])
    }

    func pause() { arView?.session.pause() }

    func saveDiagnostic() {
        tracker.saveDiagnostic { msg in
            Task { @MainActor [weak self] in self?.saveMessage = msg }
        }
    }

    private func syncRows() {
        rows = profiles.filter { enabled.contains($0.id) }.map { p in
            rows.first { $0.id == p.id } ?? Row(id: p.id, name: p.displayName)
        }
        for id in entities.keys where !enabled.contains(id) { visible.remove(id); updateVisibility(id) }
    }

    private func updateVisibility(_ id: String) { entities[id]?.isEnabled = showModel && visible.contains(id) }

    private func handle(_ out: ModuleTracker.Output) {
        milliseconds = milliseconds * 0.8 + out.milliseconds * 0.2
        let now = Date()
        for item in out.items {
            guard let idx = rows.firstIndex(where: { $0.id == item.id }) else { continue }
            rows[idx].debug = item.debug
            if let w = item.world, item.reliable || item.located {
                let s = smooth(from: worldPose[item.id], to: w)
                worldPose[item.id] = s
                entities[item.id]?.setTransformMatrix(s, relativeTo: nil)
                visible.insert(item.id); updateVisibility(item.id)
                rows[idx].tracking = true
                rows[idx].locatedOnly = !item.reliable
                rows[idx].cameraT = item.cameraT
                rows[idx].euler = item.euler
                rows[idx].message = item.reliable ? "已擬合" : "位置已找到，方向未定（轉一下元件或換角度）"
                lastGood[item.id] = now
                continue
            }
            // 短暫失去先保留；超過 0.6 秒就停止顯示（企劃書的安全 UX：不確定時不給明確位置）
            guard now.timeIntervalSince(lastGood[item.id] ?? .distantPast) > 0.6 else { continue }
            visible.remove(item.id); updateVisibility(item.id)
            worldPose[item.id] = nil
            rows[idx].tracking = false
            rows[idx].locatedOnly = false
            rows[idx].cameraT = nil
            rows[idx].euler = nil
            rows[idx].message = item.reason ?? "尋找中…"
        }
    }

    private func smooth(from old: simd_float4x4?, to new: simd_float4x4, alpha: Float = 0.45) -> simd_float4x4 {
        guard let old else { return new }
        let po = SIMD3(old.columns.3.x, old.columns.3.y, old.columns.3.z)
        let pn = SIMD3(new.columns.3.x, new.columns.3.y, new.columns.3.z)
        guard simd_distance(po, pn) < 0.03 else { return new }       // 跳太遠（換位置）就直接用新的
        let q = simd_slerp(simd_quatf(old), simd_quatf(new), alpha)
        var m = simd_float4x4(q)
        m.columns.3 = SIMD4(po + (pn - po) * alpha, 1)
        return m
    }
}
