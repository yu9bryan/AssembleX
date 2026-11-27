# -*- coding: utf-8 -*-
"""
修正 FreeCAD-library 轉出模型的顏色（幾何不動）：
- Mega 2560：原檔 PCB 是螢光綠，改成實物的 Arduino 藍綠。
- ESP32 DevKit V1：PCB 改成 DOIT 常見的黑色。
- Nano：原檔整塊只有一個灰色材質，依高度把三角形分成 腳（金屬）／排針塑膠座／PCB（Nano 藍）／上方零件（黑）。
用法：python3 fix_colors.py <models 資料夾>
"""
import json, struct, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "wrl2gltf"))
from wrl2glb import build_glb, normals_for  # noqa: E402

def read(path):
    b = Path(path).read_bytes()
    jl = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    bin_off = 20 + jl + 8
    return j, b, bin_off

def set_color(path, idx, rgb):
    j, b, bo = read(path)
    j["materials"][idx]["pbrMetallicRoughness"]["baseColorFactor"] = rgb + [1.0]
    js = json.dumps(j, separators=(",", ":")).encode(); js += b" " * ((-len(js)) % 4)
    binlen = struct.unpack("<I", b[bo - 8:bo - 4])[0]
    blob = b[bo:bo + binlen]
    out = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + blob
    Path(path).write_bytes(out)

def acc(j, b, bo, i):
    a = j["accessors"][i]; v = j["bufferViews"][a["bufferView"]]
    off = bo + v.get("byteOffset", 0) + a.get("byteOffset", 0)
    n = {"SCALAR": 1, "VEC3": 3}[a["type"]] * a["count"]
    fmt = {5126: "f", 5125: "I", 5123: "H"}[a["componentType"]]
    return struct.unpack_from(f"<{n}{fmt}", b, off)

def split_nano(path):
    j, b, bo = read(path)
    P, T = [], []
    for mesh in j["meshes"]:
        for prim in mesh["primitives"]:
            pos = acc(j, b, bo, prim["attributes"]["POSITION"]); base = len(P)
            P += [list(pos[i:i + 3]) for i in range(0, len(pos), 3)]
            # 節點可能有變換；FreeCAD 轉出的檔案節點是單位矩陣（已確認 bbox 與 mm 一致）
            idx = acc(j, b, bo, prim["indices"])
            T += [[base + idx[i], base + idx[i + 1], base + idx[i + 2]] for i in range(0, len(idx), 3)]
    mats = {
        "PIN_lead": {"diffuse": [0.78, 0.78, 0.80], "specular": [0.9] * 3, "transparency": 0.0, "shininess": 0.7},
        "BODY_header": {"diffuse": [0.04, 0.04, 0.045], "specular": [0.1] * 3, "transparency": 0.0, "shininess": 0.3},
        "BODY_pcb": {"diffuse": [0.02, 0.16, 0.42], "specular": [0.1] * 3, "transparency": 0.0, "shininess": 0.4},
        "BODY_ic": {"diffuse": [0.05, 0.05, 0.055], "specular": [0.1] * 3, "transparency": 0.0, "shininess": 0.35},
        "MET_usb": {"diffuse": [0.75, 0.76, 0.78], "specular": [0.9] * 3, "transparency": 0.0, "shininess": 0.7},
    }
    ys = sorted(p[1] for p in P)
    groups = {k: ([], []) for k in mats}
    for t in T:
        a, bb, c = (P[i] for i in t)
        cy = (a[1] + bb[1] + c[1]) / 3; cx = (a[0] + bb[0] + c[0]) / 3
        xr = max(a[0], bb[0], c[0]) - min(a[0], bb[0], c[0]); zr = max(a[2], bb[2], c[2]) - min(a[2], bb[2], c[2])
        thin = xr < 1.0 and zr < 1.0          # 細長的三角形 = 針腳
        if cy < -2.45 or (thin and cy > 1.7 and abs(cx) < 22 and False):
            k = "PIN_lead"
        elif cy < 0.0:
            k = "BODY_header"
        elif cy <= 1.65:
            k = "BODY_pcb"
        elif cx > 17.5:
            k = "MET_usb"
        else:
            k = "BODY_ic"
        G = groups[k]; n = len(G[0]); G[0].extend([a, bb, c]); G[1].append([n, n + 1, n + 2])
    out = []
    for k, (GP, GT) in groups.items():
        if GT: out.append(({**mats[k], "name": k}, GP, GT, normals_for(GP, GT)))
    build_glb(out, path)
    print("nano groups", {k: len(v[1]) for k, v in groups.items()}, "y range", ys[0], ys[-1])

if __name__ == "__main__":
    d = Path(sys.argv[1])
    set_color(d / "arduino_mega2560.glb", 0, [0.0, 0.2, 0.24])
    set_color(d / "esp32_devkit_v1.glb", 1, [0.012, 0.012, 0.014])
    # Nano 需先用 trimesh 把節點縮放烘進頂點（mm），再呼叫 split_nano
    split_nano(d / "arduino_nano.glb")
