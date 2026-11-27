"""STEP → App 用的網格（AssembleX/Resources/L298N.mesh.json）＋ 尺寸摘要。

用 OpenCascade（cadquery-ocp）三角化，依 STEP 面顏色分組。
座標系轉成 App 的物件座標（公尺）：
  原點＝PCB 上表面中心；+X 右、+Y 往散熱片那一側（後）、+Z 朝上（離開板面）。
用法：python tools/step_to_mesh.py <file.STEP> <out.json>
"""
import json
import sys
from collections import defaultdict

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool


def load(path):
    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    assert reader.ReadFile(path) == IFSelect_RetDone, "cannot read STEP"
    reader.Transfer(doc)
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    labels = TDF_LabelSequence()
    shape_tool.GetFreeShapes(labels)
    shapes = [shape_tool.GetShape_s(labels.Value(i + 1)) for i in range(labels.Length())]
    return shapes, color_tool


def face_color(color_tool, face, fallback):
    c = Quantity_Color()
    for t in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        if color_tool.GetColor(face, t, c):
            return (round(c.Red(), 3), round(c.Green(), 3), round(c.Blue(), 3))
    return fallback


def main():
    src, out = sys.argv[1], sys.argv[2]
    shapes, color_tool = load(src)
    groups = defaultdict(lambda: {"v": [], "i": []})
    for shape in shapes:
        BRepMesh_IncrementalMesh(shape, 0.08, False, 0.35, True)
        solid_color = (0.6, 0.6, 0.6)
        c = Quantity_Color()
        if color_tool.GetColor(shape, XCAFDoc_ColorType.XCAFDoc_ColorGen, c):
            solid_color = (c.Red(), c.Green(), c.Blue())
        exp = TopExp_Explorer(shape, TopAbs_FACE)
        while exp.More():
            face = TopoDS.Face_s(exp.Current())
            col = face_color(color_tool, face, solid_color)
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is not None:
                trsf = loc.Transformation()
                g = groups[col]
                base = len(g["v"])
                for k in range(1, tri.NbNodes() + 1):
                    p = tri.Node(k).Transformed(trsf)
                    g["v"].append((p.X(), p.Y(), p.Z()))
                rev = face.Orientation() == TopAbs_REVERSED
                for k in range(1, tri.NbTriangles() + 1):
                    a, b, cc = tri.Triangle(k).Get()
                    if rev:
                        b, cc = cc, b
                    g["i"].append((base + a - 1, base + b - 1, base + cc - 1))
            exp.Next()

    allv = np.concatenate([np.array(g["v"]) for g in groups.values()])
    print("raw bbox (STEP units):", allv.min(0).round(2), allv.max(0).round(2))
    print("groups:")
    for col, g in sorted(groups.items(), key=lambda kv: -len(kv[1]["i"])):
        v = np.array(g["v"])
        print(f"  color={col} tris={len(g['i'])} bbox={v.min(0).round(2)}..{v.max(0).round(2)}")
    json.dump({k: {"v": g["v"], "i": g["i"]} for k, g in
               ((",".join(map(str, c)), g) for c, g in groups.items())}, open(out + ".raw.json", "w"))


if __name__ == "__main__":
    main()
