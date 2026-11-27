"""App 的 <id>.mesh.json（物件座標 Z 朝上、公尺）→ USDZ（Y 朝上、metersPerUnit=1、UsdPreviewSurface 顏色）。
給 `xcrun createml objecttracker -s X.usdz -o X.referenceobject` 訓練 Apple 物件追蹤用。

座標換算：物件 (x, y, z) → USD (x, z, −y)。App 端用 ARObjectAnchor 時要乘回來（見 AppleObjectTracking.swift）。
python3 tools/mesh_to_usdz.py AssembleX/Resources/L298N.mesh.json out/L298N.usdz L298N
"""
import json
import sys
import zipfile


def fmt(v):
    return f"{v:.6g}"


def main():
    src, dst, name = sys.argv[1], sys.argv[2], sys.argv[3]
    mesh = json.load(open(src))
    out = ['#usda 1.0', '(', f'    defaultPrim = "{name}"', '    metersPerUnit = 1', '    upAxis = "Y"', ')', '',
           f'def Xform "{name}" (', '    kind = "component"', ')', '{', '    def Scope "Materials"', '    {']
    for i, g in enumerate(mesh["groups"]):
        r, gg, b = g["color"]
        out += [f'        def Material "m{i}"', '        {',
                f'            token outputs:surface.connect = </{name}/Materials/m{i}/PBR.outputs:surface>',
                '            def Shader "PBR"', '            {',
                '                uniform token info:id = "UsdPreviewSurface"',
                f'                color3f inputs:diffuseColor = ({fmt(r)}, {fmt(gg)}, {fmt(b)})',
                '                float inputs:roughness = 0.6', '                float inputs:metallic = 0',
                '                token outputs:surface', '            }', '        }']
    out += ['    }']
    for i, g in enumerate(mesh["groups"]):
        P = g["positions"]; N = g.get("normals"); I = g["indices"]
        pts = ", ".join(f"({fmt(P[k])}, {fmt(P[k+2])}, {fmt(-P[k+1])})" for k in range(0, len(P), 3))
        out += [f'    def Mesh "g{i}" (', '        prepend apiSchemas = ["MaterialBindingAPI"]', '    )', '    {',
                f'        int[] faceVertexCounts = [{", ".join(["3"] * (len(I) // 3))}]',
                f'        int[] faceVertexIndices = [{", ".join(map(str, I))}]',
                f'        point3f[] points = [{pts}]']
        if N:
            nrm = ", ".join(f"({fmt(N[k])}, {fmt(N[k+2])}, {fmt(-N[k+1])})" for k in range(0, len(N), 3))
            out += [f'        normal3f[] normals = [{nrm}] (', '            interpolation = "vertex"', '        )']
        out += [f'        rel material:binding = </{name}/Materials/m{i}>',
                '        uniform token subdivisionScheme = "none"', '    }']
    out += ['}', '']
    usda = "\n".join(out).encode()

    # USDZ＝未壓縮 zip，每個檔案資料要 64-byte 對齊（用 extra 欄位補齊）
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:
        fname = f"{name}.usda"
        header_len = 30 + len(fname)
        pad = (64 - (header_len + 4) % 64) % 64
        zi = zipfile.ZipInfo(fname)
        zi.compress_type = zipfile.ZIP_STORED
        zi.extra = b"\x00\x00" + pad.to_bytes(2, "little") + b"\x00" * pad   # 自訂 extra id 0x0000
        z.writestr(zi, usda)
    print(f"{dst}: {len(usda)/1e6:.1f} MB usda, groups={len(mesh['groups'])}")


if __name__ == "__main__":
    main()
