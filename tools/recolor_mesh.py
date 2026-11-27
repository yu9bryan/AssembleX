"""依實物顏色改 CAD 網格的顏色（CAD 常和手上的板子不同，例：W5500 Lite 排針座是黃色、CAD 是黑色）。

規則：原顏色＋高度範圍（物件座標 z，mm）→ 新顏色。
python3 tools/recolor_mesh.py AssembleX/Resources/W5500.mesh.json \
    "0.098,0.098,0.098 z<-1.8 -> 0.95,0.82,0.08" "0.98,0.627,0 z<-1.8 -> 0.8,0.8,0.8"
"""
import json
import re
import sys
from collections import defaultdict


def parse(rule):
    m = re.match(r"\s*([\d.,]+)\s+z([<>])(-?[\d.]+)\s*->\s*([\d.,]+)\s*$", rule)
    src = tuple(round(float(x), 3) for x in m.group(1).split(","))
    return src, m.group(2), float(m.group(3)) / 1000, [float(x) for x in m.group(4).split(",")]


def main():
    path = sys.argv[1]
    rules = [parse(r) for r in sys.argv[2:]]
    mesh = json.load(open(path))
    out = defaultdict(lambda: {"v": [], "n": [], "i": []})
    for g in mesh["groups"]:
        col = tuple(round(c, 3) for c in g["color"])
        P, N, I = g["positions"], g.get("normals"), g["indices"]
        for t in range(0, len(I), 3):
            idx = I[t:t + 3]
            z = sum(P[k * 3 + 2] for k in idx) / 3
            new = col
            for src, op, thr, dst in rules:
                if src == col and ((op == "<" and z < thr) or (op == ">" and z > thr)):
                    new = tuple(dst)
            o = out[new]
            base = len(o["v"]) // 3
            for k in idx:
                o["v"] += P[k * 3:k * 3 + 3]
                o["n"] += N[k * 3:k * 3 + 3] if N else [0, 0, 1]
            o["i"] += [base, base + 1, base + 2]
    mesh["groups"] = [{"color": list(c), "positions": g["v"], "normals": g["n"], "indices": g["i"]} for c, g in out.items()]
    json.dump(mesh, open(path, "w"), separators=(",", ":"))
    for c, g in out.items():
        print(c, len(g["i"]) // 3)


if __name__ == "__main__":
    main()
