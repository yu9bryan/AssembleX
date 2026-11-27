# -*- coding: utf-8 -*-
"""
依 datasheet 尺寸程序生成沒有授權 CAD 的元件模型，輸出 GLB（mm、Y 朝上、腳位原點在第 1 腳）。
DHT22 / AM2302：Aosong 規格書 15.1 × 25.0 × 7.7mm、4 腳 2.54mm。
SSD1306 0.96" I2C 模組：玻璃 26.70 × 19.26 × 1.45（UG-2864HSWEG01），PCB 27.3 × 27.8（常見規格），4 腳排針。
格柵與固定孔是真的挖空（框條＋凹底），不是貼片。
用法：python3 make_parts.py <輸出資料夾>
"""
import math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "wrl2gltf"))
from wrl2glb import build_glb, normals_for  # noqa: E402

class Mesh:
    def __init__(self): self.groups = {}
    def _g(self, mat):
        return self.groups.setdefault(mat["name"], (mat, [], []))
    def quad(self, mat, a, b, c, d):
        _, P, T = self._g(mat); n = len(P); P += [a, b, c, d]; T += [[n, n + 1, n + 2], [n, n + 2, n + 3]]
    def box(self, mat, x0, x1, y0, y1, z0, z1):
        q = self.quad
        q(mat, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])  # +z
        q(mat, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0])  # -z
        q(mat, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1])  # +x
        q(mat, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])  # -x
        q(mat, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0])  # +y
        q(mat, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])  # -y
    def cyl(self, mat, cx, cy, z0, z1, r, n=24, axis="z"):
        # 軸向 z（或 y）的圓柱，側面每段獨立頂點 → 法線平順但端面平
        def pt(a, z):
            u, v = cx + r * math.cos(a), cy + r * math.sin(a)
            return [u, v, z] if axis == "z" else [u, z, v]
        for i in range(n):
            a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
            self.quad(mat, pt(a0, z0), pt(a1, z0), pt(a1, z1), pt(a0, z1))
        for z in (z0, z1):
            _, P, T = self._g(mat); c = len(P)
            P.append([cx, cy, z] if axis == "z" else [cx, z, cy])
            for i in range(n):
                P.append(pt(2 * math.pi * i / n, z))
            for i in range(n):
                T.append([c, c + 1 + i, c + 1 + (i + 1) % n])
    def write(self, path):
        groups = []
        for mat, P, T in self.groups.values():
            # 每個三角形用獨立頂點 → 平面法線，盒子稜角清楚
            P2, T2 = [], []
            for t in T:
                k = len(P2); P2 += [P[i] for i in t]; T2.append([k, k + 1, k + 2])
            groups.append((mat, P2, T2, normals_for(P2, T2)))
        size = build_glb(groups, path)
        print(f"{Path(path).name}: {size/1024:.0f} KB")

def M(name, rgb, shin=0.4, spec=0.1):
    return {"name": name, "diffuse": rgb, "specular": [spec] * 3, "transparency": 0.0, "shininess": shin}

def dht22(out):
    m = Mesh()
    shell = M("BODY_shell", [0.91, 0.90, 0.87], 0.35)
    inner = M("BODY_inner", [0.20, 0.20, 0.21], 0.1)
    pin = M("PIN_lead", [0.75, 0.76, 0.78], 0.7, 0.9)
    cx, W, H, D, y0 = 3.81, 15.1, 25.0, 7.7, 3.4      # 外殼底在板面上 3.4mm（腳的肩部露出來）
    x0, x1, z0, z1 = cx - W / 2, cx + W / 2, -D / 2, D / 2
    face = 1.0                                         # 正面格柵框的厚度（凹進去的深度）
    # 主體（扣掉正面那 1mm）
    m.box(shell, x0, x1, y0, y0 + H, z0, z1 - face)
    # 格柵：4 欄 × 6 列方孔，四周與孔間用框條組成
    cols, rows, gw, gh, gx, gy = 4, 6, 2.3, 1.9, 3.05, 2.55
    gTop = y0 + H - 6.2
    xs = [cx + (c - (cols - 1) / 2) * gx for c in range(cols)]
    ys = [gTop - r * gy for r in range(rows)]
    gx0, gx1 = xs[0] - gw / 2, xs[-1] + gw / 2
    gy0, gy1 = ys[-1] - gh / 2, ys[0] + gh / 2
    zf0, zf1 = z1 - face, z1
    m.box(shell, x0, gx0, y0, y0 + H, zf0, zf1)                 # 左框
    m.box(shell, gx1, x1, y0, y0 + H, zf0, zf1)                 # 右框
    m.box(shell, gx0, gx1, y0, gy0, zf0, zf1)                   # 下方光滑區
    # 上方：固定孔所在的一段，孔用方框圍出圓孔的近似（四周框＋凹底圓柱）
    hy, hr = y0 + H - 2.5, 1.5
    m.box(shell, gx0, gx1, gy1, hy - hr, zf0, zf1)
    m.box(shell, gx0, gx1, hy + hr, y0 + H, zf0, zf1)
    m.box(shell, gx0, cx - hr, hy - hr, hy + hr, zf0, zf1)
    m.box(shell, cx + hr, gx1, hy - hr, hy + hr, zf0, zf1)
    m.cyl(inner, cx, hy, z0 - 0.02, z1 - face + 0.02, hr - 0.02)   # 穿孔：深色孔壁貫穿外殼
    m.cyl(inner, cx, hy, z0 - 0.03, z0 - 0.01, hr - 0.02)
    # 方孔之間的框條
    for c in range(cols - 1):
        m.box(shell, xs[c] + gw / 2, xs[c + 1] - gw / 2, gy0, gy1, zf0, zf1)
    for r in range(rows - 1):
        m.box(shell, gx0, gx1, ys[r + 1] + gh / 2, ys[r] - gh / 2, zf0, zf1)
    # 凹底：孔裡看到的深色感測片
    m.box(inner, gx0, gx1, gy0, gy1, zf0 - 0.05, zf0 + 0.01)
    # 下方分模刻線
    m.box(inner, x0 + 1.5, x1 - 1.5, y0 + 4.1, y0 + 4.35, z1 - 0.15, z1 + 0.01)
    # 4 根腳：0.6mm 方截面，從板面下 6mm 到外殼底
    for i in range(4):
        x = i * 2.54
        m.box(pin, x - 0.3, x + 0.3, -6.0, y0 + 0.5, -0.3, 0.3)
    m.write(out / "dht22.glb")

def ssd1306(out):
    m = Mesh()
    pcb = M("BODY_pcb", [0.06, 0.18, 0.45], 0.35)
    glass = M("BODY_glass", [0.03, 0.03, 0.035], 0.85)
    active = M("BODY_active", [0.06, 0.07, 0.09], 0.9)
    hdr = M("BODY_header", [0.05, 0.05, 0.05], 0.2)
    pin = M("PIN_lead", [0.80, 0.70, 0.40], 0.7, 0.9)
    flex = M("BODY_flex", [0.55, 0.35, 0.10], 0.5)
    cx = 3.81
    PW, PD, PT = 27.3, 27.8, 1.2
    yb = 2.5                                   # PCB 底面 = 排針塑膠座高度
    zp0 = -2.0                                 # 排針在 PCB 上緣往內 2mm
    px0, px1, pz0, pz1 = cx - PW / 2, cx + PW / 2, zp0, zp0 + PD
    # PCB（留 4 個 Ø2 安裝孔：用框條圍出方孔近似）
    hole = 1.0; hx = [px0 + 2.0, px1 - 2.0]; hz = [pz0 + 2.0, pz1 - 2.0]
    m.box(pcb, px0, px1, yb, yb + PT, pz0 + 3.2, pz1 - 3.2)
    for zz0, zz1, hzc in [(pz0, pz0 + 3.2, hz[0]), (pz1 - 3.2, pz1, hz[1])]:
        m.box(pcb, hx[0] + hole, hx[1] - hole, yb, yb + PT, zz0, zz1)
        m.box(pcb, px0, hx[0] - hole, yb, yb + PT, zz0, zz1)
        m.box(pcb, hx[1] + hole, px1, yb, yb + PT, zz0, zz1)
        for xc in hx:
            m.box(pcb, xc - hole, xc + hole, yb, yb + PT, zz0, hzc - hole)
            m.box(pcb, xc - hole, xc + hole, yb, yb + PT, hzc + hole, zz1)
    # 玻璃面板與顯示區
    GW, GD, GT = 26.70, 19.26, 1.45
    gz0 = pz0 + 4.6
    gt = yb + PT
    m.box(glass, cx - GW / 2, cx + GW / 2, gt, gt + GT, gz0, gz0 + GD)
    AW, AD = 21.744, 10.864
    az0 = gz0 + 2.1
    m.box(active, cx - AW / 2, cx + AW / 2, gt + GT, gt + GT + 0.01, az0, az0 + AD)
    # 排線（玻璃下緣折到 PCB 背面）
    m.box(flex, cx - 6, cx + 6, gt, gt + 0.15, gz0 + GD, gz0 + GD + 2.2)
    # 4 針排針：塑膠座在 PCB 下方，針穿過 PCB
    m.box(hdr, -1.27, 7.62 + 1.27, 0, yb, -1.27, 1.27)
    for i in range(4):
        x = i * 2.54
        m.box(pin, x - 0.32, x + 0.32, -6.0, yb + PT + 1.0, -0.32, 0.32)
    m.write(out / "ssd1306_096.glb")

if __name__ == "__main__":
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    dht22(out); ssd1306(out)
