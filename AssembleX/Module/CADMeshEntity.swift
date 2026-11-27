import Foundation
import RealityKit
import UIKit

/// 讀 `<元件>.mesh.json`（tools/step_lite.py／cad_to_profile.py 轉出，物件座標、公尺），組成 RealityKit 模型。
enum CADMeshEntity {
    private struct File: Decodable {
        struct Group: Decodable {
            let color: [Float]
            let positions: [Float]
            let normals: [Float]?
            let indices: [UInt32]
        }
        let groups: [Group]
    }

    static func make(resource: String, opacity: Float) -> Entity {
        let root = Entity()
        guard let url = Bundle.main.url(forResource: resource, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return root }
        for g in file.groups {
            var d = MeshDescriptor(name: "part")
            d.positions = MeshBuffer(stride(from: 0, to: g.positions.count, by: 3).map {
                SIMD3(g.positions[$0], g.positions[$0 + 1], g.positions[$0 + 2])
            })
            if let n = g.normals {
                d.normals = MeshBuffer(stride(from: 0, to: n.count, by: 3).map { SIMD3(n[$0], n[$0 + 1], n[$0 + 2]) })
            }
            d.primitives = .triangles(g.indices)
            guard let mesh = try? MeshResource.generate(from: [d]) else { continue }
            var m = PhysicallyBasedMaterial()
            m.baseColor = .init(tint: UIColor(red: CGFloat(g.color[0]), green: CGFloat(g.color[1]),
                                              blue: CGFloat(g.color[2]), alpha: 1))
            m.roughness = 0.6
            m.blending = .transparent(opacity: .init(floatLiteral: opacity))
            m.faceCulling = .none
            root.addChild(ModelEntity(mesh: mesh, materials: [m]))
        }
        return root
    }
}
