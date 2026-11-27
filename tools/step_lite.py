"""不靠 OpenCascade 的簡易 STEP（AP214）三角化：只處理這個 L298N 檔用到的幾何。

  平面（PLANE）＋ 直線／圓弧邊 → 外框多邊形 ear-clipping（內孔 FACE_BOUND 忽略，安裝孔會被填平）
  圓柱面（CYLINDRICAL_SURFACE）→ 依邊界取角度範圍 × 高度範圍，產生條帶
  圓錐／圓環面（共 6 個）略過
顏色取自 STYLED_ITEM（面或實體）。輸出物件座標（公尺）：
  STEP 是 SolidWorks Y 朝上、單位 mm；PCB 底面在 y=0。轉成 App 座標：原點＝PCB 上表面中心，
  +X 右、+Y 往散熱片、+Z 朝上。散熱片方向由「黑色零件的質心」自動判斷。

python3 tools/step_lite.py <file.STEP> <out.mesh.json> <out.labels.json>
"""
import json
import math
import re
import sys
from collections import defaultdict

import numpy as np

ENT = re.compile(r"^#(\d+)\s*=\s*(.*?);\s*$", re.S)


def parse(path):
    text = open(path, encoding="latin-1").read()
    data = text[text.index("DATA;") + 5:text.index("ENDSEC;", text.index("DATA;"))]
    ents = {}
    for stmt in data.split(";\n"):
        stmt = stmt.strip()
        if not stmt.startswith("#"):
            continue
        m = re.match(r"#(\d+)\s*=\s*(.*)", stmt, re.S)
        if not m:
            continue
        body = m.group(2).strip().rstrip(";")
        tm = re.match(r"([A-Z_0-9]+)\s*\((.*)\)\s*$", body, re.S)
        if tm:
            ents[int(m.group(1))] = (tm.group(1), tm.group(2))
        else:
            ents[int(m.group(1))] = ("COMPLEX", body)
    return ents


def refs(s):
    return [int(x) for x in re.findall(r"#(\d+)", s)]


def nums(s):
    return [float(x) for x in re.findall(r"[-+]?\d*\.\d+(?:[eE][-+]?\d+)?|[-+]?\d+(?:[eE][-+]?\d+)?", s)]


class Step:
    def __init__(self, ents):
        self.e = ents

    def point(self, i):
        t, a = self.e[i]
        assert t == "CARTESIAN_POINT", t
        return np.array(nums(a.split(",", 1)[1])[:3])

    def direction(self, i):
        t, a = self.e[i]
        v = np.array(nums(a.split(",", 1)[1])[:3])
        return v / np.linalg.norm(v)

    def axis2(self, i):
        t, a = self.e[i]
        r = refs(a)
        loc = self.point(r[0])
        z = self.direction(r[1]) if len(r) > 1 else np.array([0, 0, 1.0])
        x = self.direction(r[2]) if len(r) > 2 else np.array([1.0, 0, 0])
        x = x - z * (x @ z); x /= np.linalg.norm(x)
        y = np.cross(z, x)
        return loc, x, y, z

    def vertex(self, i):
        t, a = self.e[i]
        return self.point(refs(a)[0])

    def edge_points(self, oriented_id, seg_deg=12):
        """ORIENTED_EDGE → 依方向排好的取樣點（不含終點）。"""
        t, a = self.e[oriented_id]
        r = refs(a)
        edge_id = r[-1]
        forward = a.strip().endswith(".T.")
        t2, a2 = self.e[edge_id]
        er = refs(a2)
        v0, v1, curve = self.vertex(er[0]), self.vertex(er[1]), er[2]
        same = a2.strip().endswith(".T.")
        ct, ca = self.e[curve]
        if ct == "CIRCLE":
            cr = refs(ca)
            loc, x, y, z = self.axis2(cr[0])
            radius = nums(ca.split(",")[-1])[0]
            def ang(p):
                d = p - loc
                return math.atan2(d @ y, d @ x)
            a0, a1 = ang(v0), ang(v1)
            if same:
                if a1 <= a0 + 1e-9: a1 += 2 * math.pi
            else:
                if a1 >= a0 - 1e-9: a1 -= 2 * math.pi
            n = max(2, int(abs(a1 - a0) / math.radians(seg_deg)) + 1)
            pts = [loc + radius * (math.cos(t_) * x + math.sin(t_) * y) for t_ in np.linspace(a0, a1, n + 1)]
        else:
            pts = [v0, v1]
        if not forward:
            pts = pts[::-1]
        return pts[:-1]

    def loop_points(self, bound_id):
        t, a = self.e[bound_id]
        loop = refs(a)[0]
        lt, la = self.e[loop]
        pts = []
        for oe in refs(la):
            pts.extend(self.edge_points(oe))
        return pts


def ear_clip(poly2):
    n = len(poly2)
    if n < 3:
        return []
    idx = list(range(n))
    area = sum(poly2[i][0] * poly2[(i + 1) % n][1] - poly2[(i + 1) % n][0] * poly2[i][1] for i in range(n))
    if area < 0:
        idx.reverse()
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        found = False
        m = len(idx)
        for k in range(m):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % m]
            a, b, c = poly2[i0], poly2[i1], poly2[i2]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross <= 1e-12:
                continue
            ok = True
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                p = poly2[j]
                d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
                d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0])
                d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0])
                if d1 > 0 and d2 > 0 and d3 > 0:
                    ok = False
                    break
            if ok:
                tris.append((i0, i1, i2))
                idx.pop(k)
                found = True
                break
        if not found:
            break
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def face_colors(st):
    """STYLED_ITEM → {item_id: rgb}"""
    colors = {}
    for i, (t, a) in st.e.items():
        if t != "STYLED_ITEM":
            continue
        r = refs(a)
        item = r[-1]
        # 追 style 鏈到 COLOUR_RGB
        stack, seen, rgb = [r[0]], set(), None
        while stack and rgb is None:
            j = stack.pop()
            if j in seen or j not in st.e:
                continue
            seen.add(j)
            tj, aj = st.e[j]
            if tj == "COLOUR_RGB":
                rgb = tuple(round(v, 3) for v in nums(aj.split(",", 1)[1])[:3])
            else:
                stack.extend(refs(aj))
        if rgb:
            colors[item] = rgb
    return colors


def main():
    st = Step(parse(sys.argv[1]))
    colors = face_colors(st)
    groups = defaultdict(lambda: {"v": [], "n": [], "i": []})
    solids = []
    for sid, (t, a) in st.e.items():
        if t != "MANIFOLD_SOLID_BREP":
            continue
        name = re.match(r"\s*'([^']*)'", a).group(1)
        shell = refs(a)[0]
        faces = refs(st.e[shell][1])
        solid_rgb = colors.get(sid, (0.6, 0.6, 0.6))
        spts = []
        for f in faces:
            ft, fa = st.e[f]
            fr = refs(fa)
            surf = fr[-1]
            same = fa.strip().endswith(".T.")
            rgb = colors.get(f, solid_rgb)
            g = groups[rgb]
            st_t, st_a = st.e[surf]
            outer = [b for b in fr[:-1] if st.e[b][0] == "FACE_OUTER_BOUND"] or fr[:1]
            try:
                pts = st.loop_points(outer[0])
            except Exception:
                continue
            if len(pts) < 3:
                continue
            spts.extend(pts)
            if st_t == "PLANE":
                loc, x, y, z = st.axis2(refs(st_a)[0])
                nrm = z if same else -z
                p2 = [((p - loc) @ x, (p - loc) @ y) for p in pts]
                tris = ear_clip(p2)
                base = len(g["v"])
                g["v"].extend(pts); g["n"].extend([nrm] * len(pts))
                for (i0, i1, i2) in tris:
                    # 依法向決定繞向
                    if np.cross(pts[i1] - pts[i0], pts[i2] - pts[i0]) @ nrm < 0:
                        i1, i2 = i2, i1
                    g["i"].append((base + i0, base + i1, base + i2))
            elif st_t == "CYLINDRICAL_SURFACE":
                cr = refs(st_a)
                loc, x, y, z = st.axis2(cr[0])
                radius = nums(st_a.split(",")[-1])[0]
                angs = np.array([math.atan2((p - loc) @ y, (p - loc) @ x) for p in pts])
                hs = np.array([(p - loc) @ z for p in pts])
                # 角度範圍：找最大的空隙當切口
                srt = np.sort(angs)
                gaps = np.diff(np.concatenate([srt, [srt[0] + 2 * math.pi]]))
                k = int(np.argmax(gaps))
                if gaps[k] < math.radians(20):
                    a0, a1 = -math.pi, math.pi
                else:
                    a0 = srt[(k + 1) % len(srt)]
                    a1 = srt[k] if k + 1 < len(srt) else srt[k]
                    if a1 <= a0:
                        a1 += 2 * math.pi
                h0, h1 = hs.min(), hs.max()
                n = max(2, int((a1 - a0) / math.radians(12)))
                base = len(g["v"])
                for j in range(n + 1):
                    ang = a0 + (a1 - a0) * j / n
                    d = math.cos(ang) * x + math.sin(ang) * y
                    nrm = d if same else -d
                    for h in (h0, h1):
                        g["v"].append(loc + radius * d + h * z); g["n"].append(nrm)
                for j in range(n):
                    p0, p1, p2, p3 = base + 2 * j, base + 2 * j + 1, base + 2 * j + 2, base + 2 * j + 3
                    g["i"].append((p0, p2, p1)); g["i"].append((p1, p2, p3))
        if spts:
            arr = np.array(spts)
            solids.append({"name": name, "rgb": solid_rgb, "min": arr.min(0), "max": arr.max(0)})

    # ---- 座標轉換：STEP (x, y上, z) mm → App (X右, Y後, Z上) m
    allv = np.concatenate([np.array(g["v"]) for g in groups.values() if g["v"]])
    pcb_top = 1.5
    cx = (allv[:, 0].min() + allv[:, 0].max()) / 2
    cz = (allv[:, 2].min() + allv[:, 2].max()) / 2
    # 散熱片＝最高、且沒有橫跨整塊板子的實體（STEP 的 y 是高度）
    span = allv[:, 0].max() - allv[:, 0].min()
    cand = [s for s in solids if (s["max"][0] - s["min"][0]) < 0.8 * span]
    sink = max(cand, key=lambda s: s["max"][1])
    print("heatsink solid:", sink["name"])
    hs = (sink["min"] + sink["max"]) / 2
    # 散熱片在 STEP 的哪個水平方向 → 那就是 App 的 +Y
    dx, dz = hs[0] - cx, hs[2] - cz
    if abs(dz) >= abs(dx):
        s = 1 if dz > 0 else -1
        def to_app(p):  # +Y_app = s·z_step；+Z_app = y_step；+X_app 依右手
            return np.array([-s * (p[..., 0] - cx), s * (p[..., 2] - cz), p[..., 1] - pcb_top]).T * 0.001 \
                if p.ndim > 1 else np.array([-s * (p[0] - cx), s * (p[2] - cz), p[1] - pcb_top]) * 0.001
        def nrm_app(n):
            return np.array([-s * n[..., 0], s * n[..., 2], n[..., 1]]).T if n.ndim > 1 else np.array([-s * n[0], s * n[2], n[1]])
    else:
        s = 1 if dx > 0 else -1
        def to_app(p):
            return np.array([s * (p[..., 2] - cz), s * (p[..., 0] - cx), p[..., 1] - pcb_top]).T * 0.001 \
                if p.ndim > 1 else np.array([s * (p[2] - cz), s * (p[0] - cx), p[1] - pcb_top]) * 0.001
        def nrm_app(n):
            return np.array([s * n[..., 2], s * n[..., 0], n[..., 1]]).T if n.ndim > 1 else np.array([s * n[2], s * n[0], n[1]])

    out = {"groups": []}
    tri_total = 0
    for rgb, g in groups.items():
        if not g["i"]:
            continue
        v = to_app(np.array(g["v"]))
        n = nrm_app(np.array(g["n"]))
        out["groups"].append({"color": list(rgb), "positions": [round(float(x), 6) for x in v.ravel()],
                              "normals": [round(float(x), 4) for x in n.ravel()],
                              "indices": [int(x) for x in np.array(g["i"]).ravel()]})
        tri_total += len(g["i"])
    json.dump(out, open(sys.argv[2], "w"), separators=(",", ":"))
    print(f"groups={len(out['groups'])} triangles={tri_total} -> {sys.argv[2]}")

    app_solids = []
    for s_ in solids:
        lo, hi = to_app(s_["min"]), to_app(s_["max"])
        mn, mx = np.minimum(lo, hi), np.maximum(lo, hi)
        app_solids.append({"name": s_["name"], "rgb": s_["rgb"], "min": (mn * 1000).round(2).tolist(),
                           "max": (mx * 1000).round(2).tolist()})
        print(f"  {s_['name']:<18} rgb={s_['rgb']}  X {mn[0]*1000:6.1f}..{mx[0]*1000:6.1f}  "
              f"Y {mn[1]*1000:6.1f}..{mx[1]*1000:6.1f}  Z {mn[2]*1000:6.1f}..{mx[2]*1000:6.1f} mm")
    json.dump(app_solids, open(sys.argv[3], "w"), indent=1)


if __name__ == "__main__":
    main()
