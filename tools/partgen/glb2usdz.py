"""桌面 GLB → iOS USDZ：套用 profile 的 model_transform（scale→rotate→translate），單位 mm，原點＝元件原點。
用法：python glb2usdz.py <desktop_dir> <out_dir> <work_dir>
"""
import json, glob, os, re, sys, subprocess, math
import numpy as np, trimesh

desk, out_dir, work = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True); os.makedirs(work, exist_ok=True)

def srgb_to_lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def hex_rgb(h):
    h = h.lstrip('#'); return np.array([int(h[i:i+2], 16) / 255 for i in (0, 2, 4)])

def euler_xyz(deg):
    x, y, z = [math.radians(d) for d in deg]
    Rx = np.array([[1,0,0],[0,math.cos(x),-math.sin(x)],[0,math.sin(x),math.cos(x)]])
    Ry = np.array([[math.cos(y),0,math.sin(y)],[0,1,0],[-math.sin(y),0,math.cos(y)]])
    Rz = np.array([[math.cos(z),-math.sin(z),0],[math.sin(z),math.cos(z),0],[0,0,1]])
    return Rx @ Ry @ Rz          # three.js Euler 'XYZ'

def fmt(v): return '%.5g' % v

def crease_normals(v, f, angle_deg=30):
    """每個三角形角各自一個法線：只平均和這個面夾角 < angle 的相鄰面（硬邊保留、曲面平滑）。
    回傳 (points, faces, normals, corner_index)：頂點按「面角」展開。"""
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    area = np.linalg.norm(fn, axis=1, keepdims=True)
    unit = fn / np.maximum(area, 1e-12)
    cos_t = math.cos(math.radians(angle_deg))
    faces_of = [[] for _ in range(len(v))]
    for fi, tri in enumerate(f):
        for vi in tri: faces_of[vi].append(fi)
    normals = np.zeros((len(f) * 3, 3))
    for fi, tri in enumerate(f):
        for k, vi in enumerate(tri):
            nb = faces_of[vi]
            ok = [g for g in nb if np.dot(unit[g], unit[fi]) >= cos_t]
            n = fn[ok].sum(0)
            l = np.linalg.norm(n)
            normals[fi * 3 + k] = n / l if l > 1e-12 else unit[fi]
    pts = v[f.reshape(-1)]
    faces = np.arange(len(f) * 3).reshape(-1, 3)
    return pts, faces, normals, f.reshape(-1)

profiles = {}
for f in sorted(glob.glob(os.path.join(desk, 'src/data/components/*.json'))):
    d = json.load(open(f))
    g = d.get('geometry', {})
    m = g.get('desktop_model')
    if not m: continue
    profiles[d['component_id']] = d

by_model = {}
for pid, d in profiles.items():
    model = os.path.splitext(os.path.basename(d['geometry']['desktop_model']))[0]
    by_model.setdefault(model, []).append(pid)

manifest = {'models': {}, 'profiles': {}, 'pins': {}}
for model, pids in sorted(by_model.items()):
    d = profiles[pids[0]]
    t = d['geometry'].get('model_transform') or {}
    for other in pids[1:]:
        if (profiles[other]['geometry'].get('model_transform') or {}) != t:
            print('WARN transform differs', model, pids)
    us = t.get('unit_scale', 1); sc = np.array(t.get('scale', [1, 1, 1]), float) * us
    R = euler_xyz(t.get('rotation_deg', [0, 0, 0])); off = np.array(t.get('offset_mm', [0, 0, 0]), float)
    M = np.eye(4); M[:3, :3] = R @ np.diag(sc); M[:3, 3] = off
    tint = (d['geometry'].get('placeholder') or {}).get('color')
    is_led = d.get('category') == 'led'
    rules = t.get('materials') or []

    scene = trimesh.load(os.path.join(desk, 'public/models', model + '.glb'), force='scene')
    mats, meshes, textures = [], [], []
    for node in scene.graph.nodes_geometry:
        T, gname = scene.graph[node]
        geo = scene.geometry[gname].copy()
        geo.apply_transform(M @ T)
        if np.linalg.det((M @ T)[:3, :3]) < 0: geo.invert()
        vis = geo.visual
        src = getattr(vis, 'material', None)
        mname = getattr(src, 'name', '') or ''
        names = f'{node} {gname} {mname}'
        base = np.array(getattr(src, 'baseColorFactor', None) if getattr(src, 'baseColorFactor', None) is not None else [154, 154, 154, 255], float) / 255
        color = base[:3]; opacity = float(base[3]); metal = 0.0; rough = 0.5; tex = None
        hit = next((r for r in rules if re.search(r['match'], names, re.I)), None)
        if t.get('keep_materials'):
            metal = float(getattr(src, 'metallicFactor', 0) or 0); rough = float(getattr(src, 'roughnessFactor', 0.5) or 0.5)
            img = getattr(src, 'baseColorTexture', None)
            if img is not None and getattr(vis, 'uv', None) is not None:
                tex = f'{model}_tex{len(textures)}.png'; img.save(os.path.join(work, tex)); textures.append(tex)
        elif hit:
            color = srgb_to_lin(hex_rgb(hit['color'])); metal = hit.get('metal', 0); rough = hit.get('rough', 0.5)
            opacity = 1 - 0.5 * hit.get('transmission', 0)
        else:
            up = mname.upper()
            r, g_, b = base[:3]; mx, mn = max(r, g_, b), min(r, g_, b); l = (mx + mn) / 2
            s = 0 if mx == mn else (mx - mn) / (1 - abs(2 * l - 1) + 1e-9)
            plastic = re.search(r'PLASTIC|BODY|EPOXY|RES-THT|LED|CAP|IC-|CASE', up) is not None
            is_metal = not plastic and (re.match(r'^(PIN|MET)', up) is not None or (s < 0.08 and l > 0.45 and not t.get('tint_body')))
            if is_metal:
                color = srgb_to_lin(hex_rgb('#b9bec6')); metal = 0.9; rough = 0.28
            elif is_led and tint:
                color = srgb_to_lin(hex_rgb(tint)); opacity = 0.8; rough = 0.15
            elif t.get('tint_body') and tint:
                color = srgb_to_lin(hex_rgb(tint)); rough = 0.6
            else:
                rough = min(0.75, float(getattr(src, 'roughnessFactor', 0.5) or 0.5))
            opacity = min(opacity, 1.0) if is_led else 1.0
        mats.append(dict(color=color, opacity=opacity, metal=metal, rough=rough, tex=tex, name=mname))
        uv = getattr(vis, 'uv', None) if tex else None
        meshes.append((geo, len(mats) - 1, uv))

    L = ['#usda 1.0', '(', '    defaultPrim = "Root"', '    upAxis = "Y"', '    metersPerUnit = 1', ')', '', 'def Xform "Root"', '{',
         '    def Scope "Materials"', '    {']
    for i, m in enumerate(mats):
        c = ', '.join(fmt(x) for x in m['color'])
        L += [f'        def Material "M{i}"', '        {',
              f'            token outputs:surface.connect = </Root/Materials/M{i}/S.outputs:surface>',
              f'            def Shader "S"', '            {', '                uniform token info:id = "UsdPreviewSurface"']
        if m['tex']:
            L += [f'                color3f inputs:diffuseColor.connect = </Root/Materials/M{i}/Tex.outputs:rgb>']
        else:
            L += [f'                color3f inputs:diffuseColor = ({c})']
        L += [f'                float inputs:metallic = {fmt(m["metal"])}', f'                float inputs:roughness = {fmt(m["rough"])}',
              f'                float inputs:opacity = {fmt(m["opacity"])}', '                token outputs:surface', '            }']
        if m['tex']:
            L += ['            def Shader "Reader"', '            {', '                uniform token info:id = "UsdPrimvarReader_float2"',
                  '                string inputs:varname = "st"', '                float2 outputs:result', '            }',
                  '            def Shader "Tex"', '            {', '                uniform token info:id = "UsdUVTexture"',
                  f'                asset inputs:file = @{m["tex"]}@',
                  f'                float2 inputs:st.connect = </Root/Materials/M{i}/Reader.outputs:result>',
                  '                float3 outputs:rgb', '            }']
        L += ['        }']
    L += ['    }']
    for i, (geo, mi, uv) in enumerate(meshes):
        v, f, n, corner = crease_normals(np.asarray(geo.vertices), np.asarray(geo.faces))
        safe = re.sub(r'[^A-Za-z0-9_]', '_', mats[mi]['name'] or 'mat')
        L += [f'    def Mesh "G{i}_{safe}" (', '        prepend apiSchemas = ["MaterialBindingAPI"]', '    )', '    {',
              '        uniform bool doubleSided = 1',
              '        int[] faceVertexCounts = [' + ', '.join(['3'] * len(f)) + ']',
              '        int[] faceVertexIndices = [' + ', '.join(str(x) for x in f.reshape(-1)) + ']',
              '        point3f[] points = [' + ', '.join(f'({fmt(a)}, {fmt(b)}, {fmt(c)})' for a, b, c in v) + ']',
              '        normal3f[] normals = [' + ', '.join(f'({fmt(a)}, {fmt(b)}, {fmt(c)})' for a, b, c in n) + '] (', '            interpolation = "vertex"', '        )']
        if uv is not None:
            # trimesh 讀 glTF 時已把 v 翻成 OpenGL 慣例（原點左下），USD 同慣例：不要再翻（之前多翻一次，UNO 絲印變鏡像）
            uvc = np.asarray(uv)[corner]
            L += ['        texCoord2f[] primvars:st = [' + ', '.join(f'({fmt(a)}, {fmt(b)})' for a, b in uvc) + '] (', '            interpolation = "vertex"', '        )']
        L += ['        uniform token subdivisionScheme = "none"', f'        rel material:binding = </Root/Materials/M{mi}>', '    }']
    L += ['}', '']
    usda = os.path.join(work, model + '.usda'); usdc = os.path.join(work, model + '.usdc')
    open(usda, 'w').write('\n'.join(L))
    subprocess.run(['usdcat', '-o', usdc, usda], check=True)
    outp = os.path.join(out_dir, model + '.usdz')
    if os.path.exists(outp): os.remove(outp)
    subprocess.run(['usdzip', outp, model + '.usdc'] + textures, check=True, cwd=work)
    size = os.path.getsize(outp)
    allv = np.concatenate([g.vertices for g, _, _ in meshes])
    manifest['models'][model] = {'bboxMin': allv.min(0).round(2).tolist(), 'bboxMax': allv.max(0).round(2).tolist(), 'bytes': size}
    for pid in pids:
        manifest['profiles'][pid] = model
    print(model, pids, len(meshes), 'meshes', size // 1024, 'KB', allv.min(0).round(1), allv.max(0).round(1))

# 開發板排針位置（part-local mm），給導線接到開發板用
for pid, d in profiles.items():
    if d.get('category') in ('mcu', 'board', 'microcontroller') or pid.startswith(('arduino', 'esp32')):
        pins = {p['id']: p['position_mm'] for p in d.get('pins', []) if p.get('position_mm')}
        for p in d.get('pins', []):
            for a in p.get('aliases', []) or []:
                if p.get('position_mm'): pins.setdefault(a, p['position_mm'])
        manifest['pins'][pid] = pins
json.dump(manifest, open(os.path.join(out_dir, 'models.json'), 'w'), ensure_ascii=False, indent=1)
