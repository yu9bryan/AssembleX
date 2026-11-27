"""任意元件 CAD → App 用的 <id>.mesh.json ＋ <id>.profile.json（通用流程，新增元件就跑這支）。

幾何來源（擇一）：
  --stl  file.stl   STL 網格（最可靠；會用頂點聚類減面）
  --mesh file.json  tools/step_lite.py 已三角化的網格（App 座標以外的原始座標也可以）
顏色來源：
  --step file.stp   STEP 每個上色實體的包圍盒 → 三角形中心落在哪個盒子就用哪個顏色（最小的盒子優先）

自動決定座標（和 App 一致）：
  底板＝面積最大、且飽和的那個顏色（PCB），用 PCA 找底板平面；
  +Z＝零件面積較多的那一側；原點＝底板上表面中心；+Y＝最高零件（質心）所在的水平方向。
底板色相 → profile 的 baseHueMin/Max（±12°）。

python3 tools/cad_to_profile.py --id W5500 --name "W5500 乙太網路模組" --stl X.stl --step X.stp --out AssembleX/Resources
"""
import argparse
import json
import math
import re
import struct
from collections import defaultdict

import numpy as np


# ---------- STEP 顏色實體 ----------

def parse_step(path):
    text = open(path, encoding="latin-1").read()
    data = text[text.index("DATA;") + 5:]
    ents = {}
    for m in re.finditer(r"#(\d+)\s*=\s*(.*?);\s*(?=#\d+\s*=|ENDSEC)", data, re.S):
        body = m.group(2)
        tm = re.match(r"\s*([A-Z_0-9]+)\s*\((.*)\)\s*$", body, re.S)
        ents[int(m.group(1))] = (tm.group(1), tm.group(2)) if tm else ("COMPLEX", body)
    return ents


def refs(s):
    return [int(x) for x in re.findall(r"#(\d+)", s)]


def nums(s):
    return [float(x) for x in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", s)]


def colored_boxes(path):
    ents = parse_step(path)
    out = []
    for i, (t, a) in ents.items():
        if t != "STYLED_ITEM":
            continue
        r = refs(a)
        item = r[-1]
        stack, seen, rgb = [r[0]], set(), None
        while stack and rgb is None:
            j = stack.pop()
            if j in seen or j not in ents:
                continue
            seen.add(j)
            tj, aj = ents[j]
            if tj == "COLOUR_RGB":
                rgb = tuple(nums(aj.split(",", 1)[1])[:3])
            else:
                stack.extend(refs(aj))
        if rgb is None:
            continue
        pts, stack, seen = [], [item], set()
        while stack:
            j = stack.pop()
            if j in seen or j not in ents:
                continue
            seen.add(j)
            tj, aj = ents[j]
            if tj == "CARTESIAN_POINT":
                v = nums(aj.split(",", 1)[1])
                if len(v) >= 3:
                    pts.append(v[:3])
                continue
            stack.extend(refs(aj))
        if len(pts) >= 2:
            p = np.array(pts)
            out.append((rgb, p.min(0), p.max(0)))
    return out


# ---------- 幾何 ----------

def read_stl(path):
    raw = open(path, "rb").read()
    n = struct.unpack_from("<I", raw, 80)[0]
    if 84 + n * 50 == len(raw):
        arr = np.frombuffer(raw, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]),
                            count=n, offset=84)
        return arr["v"].astype(np.float64)
    tris, cur = [], []
    for line in raw.decode("latin-1").splitlines():
        line = line.strip()
        if line.startswith("vertex"):
            cur.append([float(x) for x in line.split()[1:4]])
            if len(cur) == 3:
                tris.append(cur); cur = []
    return np.array(tris, np.float64)


def cluster_decimate(tris, cell):
    v = tris.reshape(-1, 3)
    key = np.floor(v / cell).astype(np.int64)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    sums = np.zeros((len(uniq), 3)); np.add.at(sums, inv, v)
    cnt = np.bincount(inv, minlength=len(uniq))[:, None]
    verts = sums / cnt
    idx = inv.reshape(-1, 3)
    keep = (idx[:, 0] != idx[:, 1]) & (idx[:, 1] != idx[:, 2]) & (idx[:, 0] != idx[:, 2])
    idx = idx[keep]
    idx = np.unique(np.sort(idx, axis=1), axis=0, return_index=True)[1]
    return verts, keep, idx


def rgb_to_ycc(rgb):
    r, g, b = [c * 255 for c in rgb]
    return (0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
            128 + 0.5 * r - 0.418688 * g - 0.081312 * b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--stl")
    ap.add_argument("--step")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cell", type=float, default=0.35, help="減面聚類格大小（mm）")
    ap.add_argument("--hue-pad", type=float, default=12)
    a = ap.parse_args()

    tris = read_stl(a.stl)
    print(f"STL triangles: {len(tris)}  bbox {tris.reshape(-1,3).min(0).round(2)} .. {tris.reshape(-1,3).max(0).round(2)}")
    boxes = colored_boxes(a.step) if a.step else []
    print(f"STEP colored bodies: {len(boxes)}")

    # 每個三角形的顏色：中心落在哪個（最小的）包圍盒
    cen = tris.mean(1)
    color = np.tile(np.array([0.6, 0.6, 0.6]), (len(tris), 1))
    best_vol = np.full(len(tris), np.inf)
    for rgb, lo, hi in boxes:
        pad = 0.05
        inside = np.all((cen >= lo - pad) & (cen <= hi + pad), axis=1)
        vol = np.prod(np.maximum(hi - lo, 0.05))
        upd = inside & (vol < best_vol)
        color[upd] = rgb; best_vol[upd] = vol

    # 面積、法向
    fnrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    area = 0.5 * np.linalg.norm(fnrm, axis=1)
    fnrm /= np.linalg.norm(fnrm, axis=1, keepdims=True) + 1e-12
    def saturated(c):
        y, cb, cr = rgb_to_ycc(c)
        return math.hypot(cb - 128, cr - 128) > 25
    # 底板＝「薄板狀」的飽和色實體：兩邊大、厚度 < 15%，取面積最大者
    plates = []
    for rgb, lo, hi in boxes:
        d = np.sort(hi - lo)
        if saturated(rgb) and d[0] < 0.15 * d[1]:
            plates.append((d[1] * d[2], rgb, lo, hi))
    _, base, plo, phi = max(plates, key=lambda x: x[0])
    base = tuple(round(c, 3) for c in base)
    pn = np.zeros(3); pn[int(np.argmin(phi - plo))] = 1     # 板的法向（包圍盒最薄的軸）
    on_plate = np.all((cen >= plo - 0.05) & (cen <= phi + 0.05), axis=1) & (np.abs(fnrm @ pn) > 0.9)
    color[on_plate] = base
    is_base = on_plate
    print("base color:", base, "plate", plo.round(2), phi.round(2), "plate tris", int(on_plate.sum()))

    # 底板平面：用板子包圍盒的軸（最薄軸＝法向，另兩軸＝板面方向）
    k = int(np.argmin(phi - plo))
    others = [i for i in range(3) if i != k]
    eye = np.eye(3)
    nrm, ax_u, ax_v = eye[k].copy(), eye[others[0]].copy(), eye[others[1]].copy()
    c0 = (plo + phi) / 2
    h_all = (cen - c0) @ nrm
    up_area = area[(h_all > 1.0) & ~is_base].sum(); dn_area = area[(h_all < -1.0) & ~is_base].sum()
    if dn_area > up_area:
        nrm = -nrm
    top = abs((phi - plo)[k]) / 2
    center = c0 + nrm * top
    W, D = (phi - plo)[others[0]], (phi - plo)[others[1]]
    allv = tris.reshape(-1, 3)
    # +Y＝最高零件方向
    h = (cen - center) @ nrm
    tall = cen[h > 0.5 * h.max()]
    dirv = tall.mean(0) - center
    du, dv = dirv @ ax_u, dirv @ ax_v
    if abs(du) > abs(dv):     # 讓 +Y 對準最高零件：交換 u、v
        ax_u, ax_v, W, D, du, dv = ax_v, ax_u, D, W, dv, du
    yaxis = ax_v if dv > 0 else -ax_v
    xaxis = np.cross(yaxis, nrm)
    R = np.stack([xaxis, yaxis, nrm])      # 列：App 的 X、Y、Z

    verts, keep, uniq_idx = cluster_decimate(tris, a.cell)
    tri_idx_all = np.floor(tris.reshape(-1, 3) / a.cell).astype(np.int64)  # 只為了對應顏色
    # 重建：減面後保留的三角形（keep 後再去重）
    v = tris.reshape(-1, 3)
    key = np.floor(v / a.cell).astype(np.int64)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1, 3)
    kept = np.nonzero(keep)[0][uniq_idx]
    vpos = verts
    app = (vpos - center) @ R.T / 1000.0      # mm → m

    groups = defaultdict(list)
    for t in kept:
        groups[tuple(color[t].round(3))].append(inv[t])
    out = {"groups": []}
    for col, idxs in groups.items():
        idxs = np.array(idxs)
        used = np.unique(idxs)
        remap = {u: k for k, u in enumerate(used)}
        P = app[used]
        tri = np.vectorize(remap.get)(idxs)
        # 每頂點法向（面法向平均）
        N = np.zeros_like(P)
        fn = np.cross(P[tri[:, 1]] - P[tri[:, 0]], P[tri[:, 2]] - P[tri[:, 0]])
        for k in range(3):
            np.add.at(N, tri[:, k], fn)
        N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
        out["groups"].append({"color": list(col), "positions": [round(float(x), 6) for x in P.ravel()],
                              "normals": [round(float(x), 4) for x in N.ravel()],
                              "indices": [int(x) for x in tri.ravel()]})
    ntri = sum(len(g["indices"]) // 3 for g in out["groups"])
    json.dump(out, open(f"{a.out}/{a.id}.mesh.json", "w"), separators=(",", ":"))

    y, cb, cr = rgb_to_ycc(base)
    hue = math.degrees(math.atan2(cr - 128, cb - 128))
    profile = {"id": a.id, "displayName": a.name, "mesh": f"{a.id}.mesh",
               "boardWidthMM": round(float(W), 2), "boardDepthMM": round(float(D), 2),
               "baseHueMin": round(hue - a.hue_pad, 1), "baseHueMax": round(hue + a.hue_pad, 1),
               "baseRGB": [round(c, 3) for c in base]}
    # 注意：實物顏色常和 CAD 不同（W5500 實物 −100°、CAD −135°）。拍一張實物後量色相，手動改 baseHueMin/Max。
    json.dump(profile, open(f"{a.out}/{a.id}.profile.json", "w"), ensure_ascii=False, indent=1)
    allapp = (allv - center) @ R.T
    print(f"mesh triangles {ntri} (from {len(tris)}), board {W:.1f} x {D:.1f} mm, height "
          f"{allapp[:,2].min():.1f}..{allapp[:,2].max():.1f} mm, base hue {hue:.0f}°")
    print(json.dumps(profile, ensure_ascii=False))


if __name__ == "__main__":
    main()
