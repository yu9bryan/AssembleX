#!/usr/bin/env python3
"""KiCad 的 VRML2 (.wrl) → glTF 2.0 (.glb)。零外部相依。

本機沒有 OpenCascade / trimesh / Blender，但 KiCad 的 .wrl 是純文字且結構單純：
檔案開頭是一串 `DEF <名稱> Material {...}` 的材質表，後面每個 Shape 用
`material USE <名稱>` 引用，幾何是 IndexedFaceSet（point + coordIndex）。
所以直接解析再寫出 glb 是最短路徑，也不用在專案裡多裝一堆東西。

單位：KiCad 的 .wrl 以 0.1 inch 為 1 單位（footprint 端再乘 2.54），所以輸出時 ×2.54 轉成 mm。

用法：python3 wrl2glb.py <in.wrl> <out.glb> [--scale 2.54] [--yup]
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

NUM = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def floats(s):
    return [float(x) for x in NUM.findall(s)]


def block(text, start):
    """從 text[start] 的 '{' 開始，回傳配對的 '}' 索引。"""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return len(text) - 1


def bracket(text, start):
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                return i
    return len(text) - 1


def parse_materials(text):
    mats = {}
    for m in re.finditer(r"DEF\s+([\w\-.]+)\s+Material\s*\{", text):
        end = block(text, text.index("{", m.end() - 1))
        body = text[m.end():end]
        def one(key, n=3, default=None):
            mm = re.search(key + r"\s+((?:[-+0-9.eE]+\s*){%d})" % n, body)
            return floats(mm.group(1)) if mm else default
        mats[m.group(1)] = {
            "diffuse": one("diffuseColor", 3, [0.6, 0.6, 0.6]),
            "specular": one("specularColor", 3, [0.1, 0.1, 0.1]),
            "transparency": (one("transparency", 1, [0.0]) or [0.0])[0],
            "shininess": (one("shininess", 1, [0.3]) or [0.3])[0],
        }
    return mats


def parse_shapes(text):
    """回傳 [(material_name, points[[x,y,z]...], tris[[a,b,c]...]), ...]"""
    out = []
    for m in re.finditer(r"\bShape\s*\{", text):
        end = block(text, text.index("{", m.end() - 1))
        body = text[m.end():end]
        if "IndexedFaceSet" not in body:
            continue                                   # 開頭那串只有材質定義的 Shape

        use = re.search(r"material\s+USE\s+([\w\-.]+)", body)
        name = use.group(1) if use else None

        pm = re.search(r"point\s*\[", body)
        cm = re.search(r"coordIndex\s*\[", body)
        if not pm or not cm:
            continue
        pts_raw = floats(body[pm.end() - 1: bracket(body, pm.end() - 1) + 1])
        idx_raw = [int(x) for x in re.findall(r"-?\d+", body[cm.end() - 1: bracket(body, cm.end() - 1) + 1])]

        points = [pts_raw[i:i + 3] for i in range(0, len(pts_raw) - 2, 3)]

        tris, face = [], []
        for v in idx_raw:
            if v == -1:
                for k in range(1, len(face) - 1):      # 扇形三角化（凸多邊形）
                    tris.append([face[0], face[k], face[k + 1]])
                face = []
            else:
                face.append(v)
        if face:
            for k in range(1, len(face) - 1):
                tris.append([face[0], face[k], face[k + 1]])

        if points and tris:
            out.append((name, points, tris))
    return out


def normals_for(points, tris):
    acc = [[0.0, 0.0, 0.0] for _ in points]
    for a, b, c in tris:
        pa, pb, pc = points[a], points[b], points[c]
        u = [pb[i] - pa[i] for i in range(3)]
        v = [pc[i] - pa[i] for i in range(3)]
        n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        for idx in (a, b, c):
            for i in range(3):
                acc[idx][i] += n[i]
    out = []
    for n in acc:
        L = math.sqrt(sum(x * x for x in n)) or 1.0
        out.append([n[0] / L, n[1] / L, n[2] / L])
    return out


def build_glb(groups, out_path):
    """groups: [(mat, points, tris, normals)]，座標已是最終單位。"""
    bin_parts, accessors, buffer_views, meshes, materials, nodes = [], [], [], [], [], []
    offset = 0

    def add_view(data, target):
        nonlocal offset
        pad = (-len(data)) % 4
        bin_parts.append(data + b"\x00" * pad)
        buffer_views.append({"buffer": 0, "byteOffset": offset,
                             "byteLength": len(data), "target": target})
        offset += len(data) + pad
        return len(buffer_views) - 1

    for gi, (mat, points, tris, norms) in enumerate(groups):
        flat_idx = [i for t in tris for i in t]
        use32 = len(points) > 65535
        idx_data = struct.pack(f"<{len(flat_idx)}{'I' if use32 else 'H'}", *flat_idx)
        iv = add_view(idx_data, 34963)
        accessors.append({"bufferView": iv, "componentType": 5125 if use32 else 5123,
                          "count": len(flat_idx), "type": "SCALAR"})
        i_acc = len(accessors) - 1

        pos_data = struct.pack(f"<{len(points) * 3}f", *[c for p in points for c in p])
        pv = add_view(pos_data, 34962)
        mins = [min(p[i] for p in points) for i in range(3)]
        maxs = [max(p[i] for p in points) for i in range(3)]
        accessors.append({"bufferView": pv, "componentType": 5126, "count": len(points),
                          "type": "VEC3", "min": mins, "max": maxs})
        p_acc = len(accessors) - 1

        nrm_data = struct.pack(f"<{len(norms) * 3}f", *[c for n in norms for c in n])
        nv = add_view(nrm_data, 34962)
        accessors.append({"bufferView": nv, "componentType": 5126, "count": len(norms),
                          "type": "VEC3"})
        n_acc = len(accessors) - 1

        d = mat["diffuse"]
        alpha = 1.0 - mat["transparency"]
        materials.append({
            "name": mat.get("name", f"mat{gi}"),
            "pbrMetallicRoughness": {
                "baseColorFactor": [d[0], d[1], d[2], alpha],
                "metallicFactor": 0.75 if sum(mat["specular"]) > 0.9 else 0.0,
                "roughnessFactor": max(0.08, 1.0 - mat["shininess"]),
            },
            "doubleSided": True,
            **({"alphaMode": "BLEND"} if alpha < 0.99 else {}),
        })
        meshes.append({"primitives": [{"attributes": {"POSITION": p_acc, "NORMAL": n_acc},
                                       "indices": i_acc, "material": len(materials) - 1}]})
        nodes.append({"mesh": len(meshes) - 1})

    gltf = {
        "asset": {"version": "2.0", "generator": "AssembleX wrl2glb"},
        "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "materials": materials,
        "accessors": accessors, "bufferViews": buffer_views,
        "buffers": [{"byteLength": offset}],
    }

    bin_blob = b"".join(bin_parts)
    json_blob = json.dumps(gltf, separators=(",", ":")).encode()
    json_blob += b" " * ((-len(json_blob)) % 4)

    glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(json_blob) + 8 + len(bin_blob))
    glb += struct.pack("<II", len(json_blob), 0x4E4F534A) + json_blob
    glb += struct.pack("<II", len(bin_blob), 0x004E4942) + bin_blob
    Path(out_path).write_bytes(glb)
    return len(glb)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    scale = 2.54
    if "--scale" in sys.argv:
        scale = float(sys.argv[sys.argv.index("--scale") + 1])
    yup = "--yup" in sys.argv          # KiCad 是 Z-up，glTF 慣例是 Y-up

    src, dst = args[0], args[1]
    text = Path(src).read_text(errors="ignore")
    mats = parse_materials(text)
    shapes = parse_shapes(text)

    merged = {}
    for name, pts, tris in shapes:
        key = name or "default"
        if key not in merged:
            merged[key] = ([], [])
        P, T = merged[key]
        base = len(P)
        for p in pts:
            x, y, z = p[0] * scale, p[1] * scale, p[2] * scale
            P.append([x, z, -y] if yup else [x, y, z])
        T.extend([[a + base, b + base, c + base] for a, b, c in tris])

    groups = []
    for key, (P, T) in merged.items():
        mat = dict(mats.get(key, {"diffuse": [.6, .6, .6], "specular": [.1, .1, .1],
                                  "transparency": 0.0, "shininess": 0.3}))
        mat["name"] = key
        groups.append((mat, P, T, normals_for(P, T)))

    size = build_glb(groups, dst)
    allp = [p for _, P, _, _ in groups for p in P]
    bb = [[min(p[i] for p in allp), max(p[i] for p in allp)] for i in range(3)]
    print(f"{Path(src).name} → {Path(dst).name}")
    print(f"  材質群組 {len(groups)}、頂點 {sum(len(P) for _,P,_,_ in groups)}、"
          f"三角形 {sum(len(T) for _,_,T,_ in groups)}、{size/1024:.0f} KB")
    print(f"  包圍盒 mm: X {bb[0][0]:.2f}..{bb[0][1]:.2f}  "
          f"Y {bb[1][0]:.2f}..{bb[1][1]:.2f}  Z {bb[2][0]:.2f}..{bb[2][1]:.2f}")


if __name__ == "__main__":
    main()
