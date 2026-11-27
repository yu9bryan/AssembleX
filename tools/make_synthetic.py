"""產生合成麵包板照片，給 BreadboardDetector 做回歸測試。

python tools/make_synthetic.py <輸出資料夾>
板型幾何（單位＝孔距 2.54 mm）：
  主區 A–E 在 y=0..4、F–J 在 y=7..11（中央溝槽 3 格）；欄 x=0..N-1
  電源軌每條 5 孔一組、組間空 1 孔，且和主區錯開半格（真實 830 板常見）
  列字母印在每列兩端、欄號每 5 欄印一次（故意放在格點附近，測試過濾）
另存 <name>.json：A1、J1、A{N}、J{N} 的真實影像座標，用來算誤差。
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

P = 22  # 繪製用孔距（px）


def draw_board(cols, rng, components=True):
    margin_x, top, bottom = 3.0, 5.0, 5.0
    W = int((cols - 1 + 2 * margin_x) * P)
    H = int((11 + top + bottom) * P)
    base = np.array([228, 232, 236], np.float32) + rng.normal(0, 4, 3)
    img = np.empty((H, W, 3), np.uint8)
    img[:] = np.clip(base, 0, 255).astype(np.uint8)
    ox, oy = margin_x * P, top * P

    def to_px(x, y):
        return ox + x * P, oy + y * P

    # 中央溝槽
    _, y5 = to_px(0, 5.5)
    cv2.rectangle(img, (int(ox - P), int(y5 - P * 0.35)), (int(ox + cols * P), int(y5 + P * 0.35)), (205, 208, 212), -1)
    # 電源軌紅藍線
    for y, color in [(-4.3, (40, 40, 200)), (-1.7, (200, 90, 40)), (12.7, (40, 40, 200)), (15.3, (200, 90, 40))]:
        _, yy = to_px(0, y)
        cv2.line(img, (int(ox), int(yy)), (int(ox + (cols - 1) * P), int(yy)), color, 2)

    hole = P * 0.42

    def draw_hole(x, y):
        cx, cy = to_px(x, y)
        cv2.rectangle(img, (int(cx - hole / 2), int(cy - hole / 2)), (int(cx + hole / 2), int(cy + hole / 2)),
                      (55, 55, 58), -1)

    for r in list(range(0, 5)) + list(range(7, 12)):
        for c in range(cols):
            draw_hole(c, r)
    # 電源軌（錯開半格、5 孔一組）
    for ry in (-3.5, -2.5, 13.5, 14.5):
        x = 1.5
        while x < cols - 2:
            for k in range(5):
                draw_hole(x + k, ry)
            x += 6
    font = cv2.FONT_HERSHEY_SIMPLEX
    for i, letter in enumerate("ABCDE"):
        for r, s in ((i, letter), (11 - i, "JIHGF"[i])):
            for x in (-1.6, cols + 0.6):
                cx, cy = to_px(x, r)
                cv2.putText(img, s, (int(cx - P * 0.25), int(cy + P * 0.25)), font, P / 40, (70, 70, 70), 1, cv2.LINE_AA)
    for c in range(0, cols, 5):
        for y in (-0.9, 12.3):
            cx, cy = to_px(c, y)
            cv2.putText(img, str(c + 1), (int(cx - P * 0.3), int(cy)), font, P / 45, (70, 70, 70), 1, cv2.LINE_AA)

    if components:
        for _ in range(rng.integers(4, 9)):           # 電阻、IC、LED、跳線
            kind = rng.integers(0, 4)
            c = int(rng.integers(2, cols - 8))
            r = int(rng.choice([0, 1, 2, 3, 7, 8, 9]))
            x0, y0 = to_px(c, r)
            if kind == 0:
                x1, y1 = to_px(c + 4, r)
                cv2.line(img, (int(x0), int(y0)), (int(x1), int(y1)), (160, 160, 160), 2)
                cv2.rectangle(img, (int(x0 + P), int(y0 - P * 0.4)), (int(x1 - P), int(y0 + P * 0.4)), (120, 170, 210), -1)
            elif kind == 1:
                x1, y1 = to_px(c + 4, 7)
                xa, ya = to_px(c, 4)
                cv2.rectangle(img, (int(xa - P * 0.3), int(ya - P * 0.2)), (int(x1 + P * 0.3), int(y1 + P * 0.2)), (30, 30, 30), -1)
            elif kind == 2:
                cv2.circle(img, (int(x0), int(y0)), int(P * 0.8), (40, 40, 220), -1)
            else:
                x1, y1 = to_px(c + int(rng.integers(3, 12)), int(rng.choice([2, 4, 7, 9])))
                color = tuple(int(v) for v in rng.choice([[40, 160, 40], [40, 200, 230], [200, 60, 40]]))
                cv2.line(img, (int(x0), int(y0)), (int(x1), int(y1)), color, int(P * 0.45))

    keys = {"A1": to_px(0, 0), "J1": to_px(0, 11), f"A{cols}": to_px(cols - 1, 0), f"J{cols}": to_px(cols - 1, 11)}
    # 電源軌真值：每排第一孔與最後一孔（名稱同 App：A軌內1、A軌外N…；A 側＝y<0）
    starts = []
    x = 1.5
    while x < cols - 2:
        starts.append(x)
        x += 6
    n = 5 * len(starts)
    last = starts[-1] + 4
    rails = {}
    for side, (yin, yout) in (("A", (-2.5, -3.5)), ("J", (13.5, 14.5))):
        for line, yy in (("內", yin), ("外", yout)):
            rails[f"{side}軌{line}1"] = to_px(1.5, yy)
            rails[f"{side}軌{line}{n}"] = to_px(last, yy)
    return img.astype(np.float32), (keys, rails)


def render(name, out, cols, canvas, quad, rng, light=1.0, blur=1.2, noise=4.0, components=True):
    board, (keys, rails) = draw_board(cols, rng, components)
    h, w = board.shape[:2]
    cw, ch = canvas
    bg = np.empty((ch, cw, 3), np.float32)
    bg[:] = (95, 110, 125)
    bg += rng.normal(0, 10, (ch, cw, 1)).astype(np.float32)
    bg = cv2.GaussianBlur(bg, (0, 0), 6)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32(quad)
    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(board, M, (cw, ch), flags=cv2.INTER_AREA)
    mask = cv2.warpPerspective(np.ones((h, w), np.float32), M, (cw, ch))
    img = bg * (1 - mask[..., None]) + warped * mask[..., None]
    # 不均勻光線
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    grad = 0.75 + 0.35 * (xx / cw) * (1 - 0.4 * yy / ch)
    img = img * grad[..., None] * light
    img = cv2.GaussianBlur(img, (0, 0), blur)
    img += rng.normal(0, noise, img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    cv2.imwrite(str(out / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    truth = {k: (cv2.perspectiveTransform(np.float32([[v]]), M)[0, 0]).tolist() for k, v in keys.items()}
    rail_truth = {k: (cv2.perspectiveTransform(np.float32([[v]]), M)[0, 0]).tolist() for k, v in rails.items()}
    (out / f"{name}.json").write_text(json.dumps({"cols": cols, "points": truth, "rails": rail_truth}, ensure_ascii=False))


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    L, Pt = (1920, 1080), (1080, 1920)
    # 板子長寬比：830 約 3.2:1、400 約 1.7:1；透視／旋轉都在這個基礎上做
    render("s01_830_flat", out, 63, L, [[110, 300], [1810, 290], [1815, 820], [105, 812]], rng)
    render("s02_830_persp", out, 63, L, [[300, 330], [1620, 340], [1860, 820], [60, 810]], rng)
    render("s03_830_rot", out, 63, L, [[150, 520], [1700, 120], [1830, 590], [280, 1000]], rng)
    render("s04_830_portrait", out, 63, Pt, [[800, 60], [810, 1860], [260, 1865], [250, 55]], rng)
    render("s05_830_dim", out, 63, L, [[110, 300], [1810, 290], [1815, 820], [105, 812]], rng, light=0.45, noise=7)
    render("s06_400_flat", out, 30, L, [[330, 150], [1620, 150], [1625, 930], [325, 925]], rng)
    render("s07_830_small", out, 63, L, [[560, 440], [1380, 435], [1382, 690], [557, 688]], rng)
    render("s08_830_portrait_hold", out, 63, Pt, [[40, 780], [1050, 770], [1052, 1090], [36, 1095]], rng)
    render("s09_830_clean", out, 63, L, [[110, 300], [1810, 290], [1815, 820], [105, 812]], rng, components=False)
    render("s10_830_steep", out, 63, L, [[420, 420], [1500, 420], [1900, 800], [20, 800]], rng)

if __name__ == "__main__":
    main()
