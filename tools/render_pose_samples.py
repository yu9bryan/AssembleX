"""用 CAD 網格渲染已知姿態的合成照片，測 ModulePoseDetector 的 6DoF 誤差。

python tools/render_pose_samples.py AssembleX/Resources/L298N.mesh.json tools/samples/pose
每張輸出 <name>.jpg ＋ <name>.json（K、R、t；R/t 為物件→OpenCV 相機）。
純 numpy z-buffer 光柵化（雙面、Lambert＋環境光），背景是桌面雜訊＋光線漸層。
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

W, H = 1920, 1440                     # 和 ARKit capturedImage 同尺寸
K = np.array([[1450.0, 0, W / 2], [0, 1450.0, H / 2], [0, 0, 1]])


def rot(axis, deg):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    x, y, z = axis
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def look_pose(dist, tilt, yaw, roll=0.0, offset=(0.0, 0.0)):
    """相機在板子上方 dist 公尺、往下看；tilt＝偏離正上方的角度。回傳物件→相機 R, t。"""
    # 物件 Z 朝上；相機 z 朝前。正上方俯視時：物件 +Z → 相機 −z，物件 +X → 相機 +x，物件 +Y → 相機 −y
    R0 = np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]], float)
    R = rot((0, 0, 1), roll) @ rot((1, 0, 0), -tilt) @ R0 @ rot((0, 0, 1), yaw)
    t = np.array([offset[0], offset[1], dist])
    return R, t


def background(rng):
    bg = np.empty((H, W, 3), np.float32)
    base = rng.choice([[150, 160, 170], [90, 110, 140], [200, 200, 195], [60, 70, 80]])
    bg[:] = base
    bg += cv2.GaussianBlur(rng.normal(0, 18, (H, W, 1)).astype(np.float32), (0, 0), 5)[..., None]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    bg *= (0.8 + 0.3 * xx / W)[..., None]
    return bg


def render(mesh, R, t, rng, light_dir):
    img = background(rng)
    zbuf = np.full((H, W), np.inf, np.float32)
    for g in mesh["groups"]:
        color = np.array(g["color"][::-1], np.float32) * 255     # BGR
        P = np.array(g["positions"], np.float64).reshape(-1, 3)
        N = np.array(g["normals"], np.float64).reshape(-1, 3)
        I = np.array(g["indices"], np.int64).reshape(-1, 3)
        Pc = P @ R.T + t
        Nc = N @ R.T
        uv = (Pc @ K.T)[:, :2] / Pc[:, 2:3]
        for tri in I:
            a, b, c = uv[tri]
            z = Pc[tri, 2]
            x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0])))), int(min(W - 1, np.ceil(max(a[0], b[0], c[0]))))
            y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1])))), int(min(H - 1, np.ceil(max(a[1], b[1], c[1]))))
            if x1 < x0 or y1 < y0:
                continue
            den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(den) < 1e-9:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
            w1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
            w2 = 1 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue
            depth = w0 * z[0] + w1 * z[1] + w2 * z[2]
            sub = zbuf[y0:y1 + 1, x0:x1 + 1]
            m = inside & (depth < sub)
            if not m.any():
                continue
            n = Nc[tri].mean(0)
            n /= np.linalg.norm(n) + 1e-12
            shade = 0.45 + 0.6 * abs(float(n @ light_dir))
            sub[m] = depth[m]
            img[y0:y1 + 1, x0:x1 + 1][m] = color * shade
    return img


def main():
    mesh = json.load(open(sys.argv[1]))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(3)
    cases = [
        ("p01_top", 0.22, 0, 0),
        ("p02_tilt25", 0.25, 25, 30),
        ("p03_tilt40_yaw120", 0.28, 40, 120),
        ("p04_yaw200_far", 0.40, 15, 200),
        ("p05_tilt35_yaw290", 0.24, 35, 290),
        ("p06_close_offset", 0.17, 20, 75, 8, (0.02, -0.015)),
    ]
    for case in cases:
        name, dist, tilt, yaw = case[:4]
        roll = case[4] if len(case) > 4 else rng.uniform(-10, 10)
        offset = case[5] if len(case) > 5 else (0.0, 0.0)
        R, t = look_pose(dist, tilt, yaw, roll, offset)
        light = np.array([0.3, -0.5, -0.8]); light /= np.linalg.norm(light)
        img = render(mesh, R, t, rng, light)
        img = cv2.GaussianBlur(img, (0, 0), 1.0) + rng.normal(0, 3, img.shape)
        cv2.imwrite(str(out / f"{name}.jpg"), np.clip(img, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
        json.dump({"K": [K[0, 0], K[1, 1], K[0, 2], K[1, 2]], "R": R.tolist(), "t": t.tolist()},
                  open(out / f"{name}.json", "w"))
        print("rendered", name)


if __name__ == "__main__":
    main()
