import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { ComponentProfile } from "@assemblex/circuit-schema";

/** 規格書元件的外形種類。AI 讀規格書時給（存在 geometry.asset_id 的「__種類」字尾，因為 placeholder.shape 是固定列舉）；
 *  舊資料沒有就依名稱關鍵字判斷，再不行依類別 */
/** box＝不認得的元件：中性圓角方塊＋接腳（「外形示意」，不假裝成某塊電路板）；module＝使用者明確選「一般模組板」 */
export type ShapeHint = "model" | "pir_dome" | "ultrasonic_pair" | "display" | "module" | "box";
export const SHAPE_HINTS: ShapeHint[] = ["model", "pir_dome", "ultrasonic_pair", "display", "module", "box"];
/** 預覽裡的外形選單（model＝依規格書圖面生成的 3D 模型） */
export const SHAPE_LABEL: Record<ShapeHint, string> = { model: "依圖面生成", module: "一般模組板", pir_dome: "圓頂（PIR）", ultrasonic_pair: "雙探頭（超音波）", display: "螢幕", box: "方塊" };

/**
 * 依規格書圖面（機構圖、外觀照片）讀出的參數化 3D 模型：一組基本形狀。
 * 座標系：mm、y 朝上；原點＝元件底面的中心（x 沿寬、z 沿深），整體要在 bbox（寬 × 高 × 深）裡。
 * size：box／rounded_box＝[x, y, z]；cylinder／cone／dome＝[直徑, 高]；torus＝[外徑, 管徑]。
 * ComponentProfile 的 schema 會丟掉不認得的欄位，所以存在 localStorage（assemblex.customModels，以 component_id 為 key）。
 */
export type ModelShape = "box" | "rounded_box" | "cylinder" | "cone" | "dome" | "torus";
export type ModelMaterial = "plastic" | "metal" | "rubber" | "pcb" | "glass";
export interface ModelPart {
  shape: ModelShape; size: number[]; position: [number, number, number]; rotation_deg?: [number, number, number];
  color: string; material: ModelMaterial; label?: string;
}
const MODELS_KEY = "assemblex.customModels";
/** 每個元件存：parts＝模型；cable＝用排線接頭（3D 不架在排針上，接頭畫成插座） */
export interface StoredModel { parts: ModelPart[]; cable?: boolean }
let saved: Record<string, StoredModel> | null = null;
/** 預覽中（還沒加入）的模型：id → 模型，優先於已存的 */
const drafts = new Map<string, StoredModel>();
function store(): Record<string, StoredModel> {
  if (!saved) { try { saved = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "{}") as Record<string, StoredModel>; } catch { saved = {}; } }
  return saved!;
}
export function getStoredModel(id: string): StoredModel | undefined { return drafts.get(id) ?? store()[id]; }
export function getModel(id: string): ModelPart[] | undefined { return getStoredModel(id)?.parts; }
export function setDraftModel(id: string, m: StoredModel | null) { if (m) drafts.set(id, m); else drafts.delete(id); }
/** 存起來（加入元件庫時）；回傳是否存成功 */
export function saveModel(id: string, m: StoredModel | null): boolean {
  const all = { ...store() };
  if (m && (m.parts.length || m.cable)) all[id] = m; else delete all[id];
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(all)); saved = all; return true; } catch { return false; }
}
/** 一個形狀大約佔的半寬（x, y, z），不算旋轉 */
function halfExt(m: ModelPart): [number, number, number] {
  const [a = 1, b = 1, c = 1] = m.size;
  if (m.shape === "box" || m.shape === "rounded_box") return [a / 2, b / 2, c / 2];
  if (m.shape === "torus") return [a / 2, b / 2, a / 2];
  return [a / 2, b / 2, a / 2];   // cylinder／cone／dome：[直徑, 高]
}
/**
 * 驗證 AI 給的形狀：型別、數字、最多 20 個；超出 bbox 的縮小、拉回框內（容許 5%）。全部無效回 []。
 */
export function sanitizeModel(raw: unknown, bbox: [number, number, number]): ModelPart[] {
  if (!Array.isArray(raw)) return [];
  const [W, H, D] = bbox;
  const SH: ModelShape[] = ["box", "rounded_box", "cylinder", "cone", "dome", "torus"];
  const MAT: ModelMaterial[] = ["plastic", "metal", "rubber", "pcb", "glass"];
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const out: ModelPart[] = [];
  for (const r of raw.slice(0, 24)) {
    const o = r as Record<string, unknown>;
    if (!SH.includes(o.shape as ModelShape) || !Array.isArray(o.size) || !o.size.length || !o.size.every((v) => num(v) && (v as number) > 0)) continue;
    const pos = Array.isArray(o.position) && o.position.length === 3 && o.position.every(num) ? o.position as [number, number, number] : [0, 0, 0] as [number, number, number];
    const rot = Array.isArray(o.rotation_deg) && o.rotation_deg.length === 3 && o.rotation_deg.every(num) ? o.rotation_deg as [number, number, number] : undefined;
    const m: ModelPart = { shape: o.shape as ModelShape, size: (o.size as number[]).slice(0, 3), position: [...pos] as [number, number, number], ...(rot ? { rotation_deg: rot } : {}),
      color: typeof o.color === "string" && /^#[0-9a-f]{3,8}$/i.test(o.color) ? o.color : "#8e9197",
      material: MAT.includes(o.material as ModelMaterial) ? o.material as ModelMaterial : "plastic",
      ...(typeof o.label === "string" ? { label: o.label.slice(0, 30) } : {}) };
    // 太大就等比例縮小到放得進 bbox，再把位置拉回框內
    const he = halfExt(m), lim = [W / 2, H / 2, D / 2];
    const k = Math.min(1, ...he.map((e, i) => (lim[i] * 1.05) / e));
    if (k < 0.33) continue;   // 大到離譜（超過外形 3 倍）：多半是 AI 弄錯單位，丟掉
    if (k < 1) m.size = m.size.map((v) => +(v * k).toFixed(2));
    const he2 = halfExt(m);
    m.position = [
      Math.max(-W / 2 + he2[0], Math.min(W / 2 - he2[0], m.position[0])),
      Math.max(0, Math.min(H - 2 * he2[1], m.position[1] - (m.shape === "dome" ? 0 : 0))),
      Math.max(-D / 2 + he2[2], Math.min(D / 2 - he2[2], m.position[2])),
    ].map((v) => +v.toFixed(2)) as [number, number, number];
    out.push(m);
    if (out.length >= 20) break;
  }
  return out;
}
/** position 的 y 是形狀的「底面」高度（AI 比較容易想）；畫的時候換成中心 */
function buildModel(parts: ModelPart[]): THREE.Group {
  const g = new THREE.Group();
  const mat = (m: ModelPart) => {
    const c = new THREE.Color(m.color);
    switch (m.material) {
      case "metal": return new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.6, roughness: 0.35 });
      case "rubber": return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.95 });
      case "pcb": return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 });
      case "glass": return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.08, transparent: true, opacity: 0.55, clearcoat: 1 });
      default: return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.6, clearcoat: 0.1 });
    }
  };
  for (const m of parts) {
    const [a, b = a, c = a] = m.size;
    let geo: THREE.BufferGeometry, cy: number;
    switch (m.shape) {
      case "box": geo = new THREE.BoxGeometry(a, b, c); cy = b / 2; break;
      case "rounded_box": geo = new RoundedBoxGeometry(a, b, c, 3, Math.max(0.2, Math.min(a, b, c) * 0.12)); cy = b / 2; break;
      case "cylinder": geo = new THREE.CylinderGeometry(a / 2, a / 2, b, 48); cy = b / 2; break;
      case "cone": geo = new THREE.CylinderGeometry(a * 0.15, a / 2, b, 48); cy = b / 2; break;
      case "dome": geo = new THREE.SphereGeometry(a / 2, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2); geo.scale(1, Math.max(0.1, b / (a / 2)), 1); cy = 0; break;
      case "torus": geo = new THREE.TorusGeometry((a - b) / 2, b / 2, 16, 48); geo.rotateX(Math.PI / 2); cy = b / 2; break;
    }
    const mesh = new THREE.Mesh(geo, mat(m));
    mesh.position.set(m.position[0], m.position[1] + cy, m.position[2]);
    if (m.rotation_deg) mesh.rotation.set(...m.rotation_deg.map((d) => THREE.MathUtils.degToRad(d)) as [number, number, number]);
    mesh.castShadow = true;
    g.add(mesh);
  }
  return g;
}
/** 依名稱關鍵字認得出的種類；認不出來回 null */
export function keywordShape(p: ComponentProfile): ShapeHint | null {
  const t = `${p.display_name} ${p.component_id}`;
  if (/pir|hc-?sr501|am312|人體紅外|熱釋電/i.test(t)) return "pir_dome";
  if (/ultrasonic|hc-?sr04|us-?100|超音波/i.test(t)) return "ultrasonic_pair";
  if (p.category === "display" || /oled|lcd|tft|display|顯示/i.test(t)) return "display";
  return null;
}
export function shapeHintOf(p: ComponentProfile): ShapeHint {
  const m = p.geometry.asset_id.match(/__(model|pir_dome|ultrasonic_pair|display|module|box)$/);
  // 選了「依圖面生成」但模型不見了（別台電腦、存不了）：退回關鍵字／方塊
  if (m && (m[1] !== "model" || getModel(p.component_id)?.length)) return m[1] as ShapeHint;
  const t = `${p.display_name} ${p.component_id}`;
  if (/pir|hc-?sr501|am312|人體紅外|熱釋電/i.test(t)) return "pir_dome";
  if (/ultrasonic|hc-?sr04|us-?100|超音波/i.test(t)) return "ultrasonic_pair";
  if (p.category === "display" || /oled|lcd|tft|display|顯示/i.test(t)) return "display";
  return "box";
}
/** 把外形種類寫進 asset_id（取代舊的字尾） */
export const withShapeHint = (assetId: string, hint: ShapeHint) => `${assetId.replace(/__[a-z_]+$/, "")}__${hint}`;

/**
 * 從規格書新增的元件沒有 CAD 模型：依類別生成「看得出是什麼」的參數化外形，而不是一個純色方塊。
 *  - 共同：模組 PCB（bbox 寬 × 深、厚 1.6mm）＋每隻腳一個黑色排針座與鍍金針
 *  - 外形種類（shapeHintOf）：PIR＝白色半球＋兩顆可變電阻；超音波＝藍板＋兩顆銀色探頭＋石英振盪器
 *  - 顯示器：深色螢幕面板
 *  - 一般模組板（使用者選的）：電路板＋一顆晶片＋幾顆被動元件
 *  - 認不出來（box）：中性灰圓角方塊＋接腳，介面標「外形示意」
 * 尺寸全部來自 profile（規格書讀出的 bbox 與腳位），不另外編造。
 * 原點與桌面其他元件相同：第一隻腳在 (0,0,0)，PCB 從原點往 +x、+z 延伸。
 */
export function datasheetShape(p: ComponentProfile): THREE.Group {
  const g = new THREE.Group();
  const [w, h, d] = p.geometry.bbox_mm;
  const pcbH = Math.min(1.6, h);
  const lift = 5;   // 排針座＋露出的針：看得出模組架在排針上
  // PCB 以腳位排為中心（實物的排針在板邊中央），不偏在原點那一角
  const xs = p.pins.map((q) => q.position_mm[0]), zs = p.pins.map((q) => q.position_mm[2]);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : w / 2;
  const z0 = zs.length ? Math.min(...zs) - 1.8 : 0;
  const hint = shapeHintOf(p);
  // 用排線接頭的元件（例如 LD06）：不架在排針上，本體放在接頭後面，接頭畫成一個小插座
  const cable = isCablePart(p);
  if (hint === "model") {
    const parts = getModel(p.component_id) ?? [];
    const body = buildModel(parts);
    const zMax = zs.length ? Math.max(...zs) : 0;
    body.position.set(cx, cable ? 0 : lift, cable ? zMax + 2.5 + d / 2 : z0 + d / 2);
    g.add(body);
    if (cable) addSocket(g, p); else addPins(g, p, lift);
    return g;
  }
  // PCB 顏色：超音波模組幾乎都是藍板；一般模組用規格書讀到的本體顏色（沒有就綠板）
  const pcbColor = hint === "ultrasonic_pair" ? "#1d4f9c" : hint === "module" && p.geometry.placeholder?.color && p.geometry.placeholder.color !== "#4b5563"
    ? p.geometry.placeholder.color : "#1f4f36";
  if (hint === "box") {
    // 認不出外形：中性灰的圓角方塊（尺寸照 bbox），只表示「佔多大」，不畫晶片、零件假裝成實物
    const r = Math.max(0.3, Math.min(2, w * 0.08, h * 0.15, d * 0.08));
    const body = new THREE.Mesh(new RoundedBoxGeometry(w, Math.max(1, h), d, 3, r),
      new THREE.MeshStandardMaterial({ color: "#8e9197", roughness: 0.7 }));
    const zMax = zs.length ? Math.max(...zs) : 0;
    body.position.set(cx, (cable ? 0 : lift) + Math.max(1, h) / 2, cable ? zMax + 2.5 + d / 2 : z0 + d / 2);
    body.castShadow = true;
    g.add(body);
    if (cable) addSocket(g, p); else addPins(g, p, lift);
    return g;
  }
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(w, pcbH, d),
    new THREE.MeshPhysicalMaterial({ color: pcbColor, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 }));
  pcb.position.set(cx, lift + pcbH / 2, z0 + d / 2);
  pcb.castShadow = true;
  g.add(pcb);

  const top = lift + pcbH, rest = Math.max(1, h - top);
  if (hint === "pir_dome") {
    const r = Math.min(w, d) * 0.36;
    const white = new THREE.MeshStandardMaterial({ color: "#e8e8e4", roughness: 0.8 });
    // 透鏡的方形白色底座（實物的菲涅耳透鏡卡在方框裡，不是直接黏在 PCB 上）
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2 * r + 2.4, 1.4, 2 * r + 2.4), white);
    frame.position.set(cx, top + 0.7, z0 + d / 2);
    frame.castShadow = true;
    g.add(frame);
    // 菲涅耳透鏡：霧面乳白半球，略扁
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshPhysicalMaterial({ color: "#ecebe6", roughness: 0.78, transmission: 0.05, thickness: 2, sheen: 0.25, sheenColor: new THREE.Color("#ffffff") }));
    dome.scale.y = Math.min(0.82, rest / r);
    dome.position.set(cx, top + 1.4, z0 + d / 2);
    dome.castShadow = true;
    g.add(dome);
    // 兩顆可變電阻（靈敏度／延時）：白色方座＋橘色旋鈕＋十字槽，放在板邊看得到的地方
    const orange = new THREE.MeshStandardMaterial({ color: "#c8742a", roughness: 0.6 });
    const slot = new THREE.MeshStandardMaterial({ color: "#7a3f12", roughness: 0.7 });
    for (const sx of [-1, 1]) {
      const px = cx + sx * Math.min(w / 2 - 3, r + 3.6), pz = z0 + d - 3.5;
      const base = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.2, 4.4), white);
      base.position.set(px, top + 0.6, pz);
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.4, 24), orange);
      knob.position.set(px, top + 1.9, pz);
      const s1 = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.3, 0.45), slot);
      s1.position.set(px, top + 2.62, pz);
      const s2 = s1.clone(); s2.rotation.y = Math.PI / 2;
      g.add(base, knob, s1, s2);
    }
    // PCB 四角鍍金固定孔，看得出是一塊電路板
    const ringMat = new THREE.MeshStandardMaterial({ color: "#d8c27a", metalness: 0.9, roughness: 0.35, side: THREE.DoubleSide });
    for (const [ex, ez] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.4, 20), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cx + ex * (w / 2 - 2), top + 0.02, z0 + d / 2 + ez * (d / 2 - 2));
      g.add(ring);
    }
  } else if (hint === "ultrasonic_pair") {
    // 兩顆銀色超音波探頭（發射／接收）：金屬圓筒＋深色防塵網面，中間一顆石英振盪器
    const r = Math.max(2, Math.min(d * 0.4, w * 0.2));
    const can = Math.max(4, Math.min(rest, 14));
    const silver = new THREE.MeshStandardMaterial({ color: "#d9dce0", metalness: 0.45, roughness: 0.38 });  // 金屬度太高在桌面燈光下會變深灰
    const mesh = new THREE.MeshStandardMaterial({ color: "#26282b", roughness: 0.9 });
    const lip = new THREE.MeshStandardMaterial({ color: "#c4c8cd", metalness: 0.5, roughness: 0.4 });
    const cz = z0 + d / 2;
    for (const sx of [-1, 1]) {
      const px = cx + sx * Math.min(w / 2 - r - 0.6, w * 0.27);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, can, 48), silver);
      body.position.set(px, top + can / 2, cz); body.castShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r - 0.35, 0.35, 10, 48), lip);
      ring.rotation.x = Math.PI / 2; ring.position.set(px, top + can, cz);
      const face = new THREE.Mesh(new THREE.CircleGeometry(r - 0.6, 48), mesh);
      face.rotation.x = -Math.PI / 2; face.position.set(px, top + can + 0.02, cz);
      g.add(body, ring, face);
    }
    const xtal = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 3.4, 6, 16), silver);
    xtal.rotation.z = Math.PI / 2; xtal.scale.z = 0.6;
    xtal.position.set(cx, top + 1, z0 + d - Math.min(3, d * 0.2));
    g.add(xtal);
    addIc(g, cx, top, z0 + Math.min(4, d * 0.3), Math.min(6, w * 0.15), Math.min(4, d * 0.2));
  } else if (hint === "display") {
    const scr = new THREE.Mesh(new THREE.BoxGeometry(w * 0.86, Math.min(1.2, rest), d * 0.62),
      new THREE.MeshPhysicalMaterial({ color: "#0d1013", roughness: 0.2, clearcoat: 0.8 }));
    scr.position.set(cx, top + Math.min(1.2, rest) / 2, z0 + d * 0.55);
    g.add(scr);
  } else {
    // 一般模組：電路板＋一顆主晶片＋幾顆被動元件（不假裝成某個特定外形）
    addIc(g, cx, top, z0 + d * 0.55, Math.min(8, w * 0.4), Math.min(6, d * 0.4));
    const smd = new THREE.MeshStandardMaterial({ color: "#3a2f26", roughness: 0.7 });
    const cap = new THREE.MeshStandardMaterial({ color: "#c9b48a", roughness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.8), i % 2 ? cap : smd);
      c.position.set(cx - w * 0.3 + i * 2.4, top + 0.3, z0 + d * 0.25);
      g.add(c);
    }
  }

  addPins(g, p, lift);
  return g;
}

/** 用排線接頭：腳位的功能／名稱提到排線、ZH、JST（或 connector 型別不是排針） */
export function isCablePart(p: ComponentProfile): boolean {
  if (getStoredModel(p.component_id)?.cable) return true;
  return p.pins.some((q) => /排線|ZH\s?1\.5|JST|GH\s?1\.25|PH\s?2\.0|cable/i.test(q.functions.join(" ")));
}
/** 排線插座：白色小盒子蓋住所有腳位（腳位座標不變，接線照舊） */
function addSocket(g: THREE.Group, p: ComponentProfile) {
  const xs = p.pins.map((q) => q.position_mm[0]), zs = p.pins.map((q) => q.position_mm[2]);
  if (!xs.length) return;
  const w = Math.max(...xs) - Math.min(...xs) + 3, d = Math.max(...zs) - Math.min(...zs) + 4.5;
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, 4.5, d), new THREE.MeshStandardMaterial({ color: "#efeae0", roughness: 0.6 }));
  box.position.set((Math.min(...xs) + Math.max(...xs)) / 2, 2.25, (Math.min(...zs) + Math.max(...zs)) / 2);
  box.castShadow = true;
  g.add(box);
  addPins(g, p, 0.01);
}

/** 每隻腳一個黑色排針座＋鍍金針（下半段插進孔裡） */
function addPins(g: THREE.Group, p: ComponentProfile, lift: number) {
  const housing = new THREE.MeshStandardMaterial({ color: "#141416", roughness: 0.6 });
  const gold = new THREE.MeshStandardMaterial({ color: "#d8c27a", metalness: 0.9, roughness: 0.3 });
  for (const pin of p.pins) {
    const [x, , z] = pin.position_mm;
    const hs = new THREE.Mesh(new THREE.BoxGeometry(2.54, lift, 2.54), housing);
    hs.position.set(x, lift / 2, z);
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 6, 8), gold);
    needle.position.set(x, 0, z);
    g.add(hs, needle);
  }
}

/** 黑色 SOIC 晶片＋兩排鍍錫腳 */
function addIc(g: THREE.Group, x: number, top: number, z: number, w: number, d: number) {
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, d), new THREE.MeshStandardMaterial({ color: "#141416", roughness: 0.45 }));
  body.position.set(x, top + 0.7, z); body.castShadow = true;
  g.add(body);
  const leg = new THREE.MeshStandardMaterial({ color: "#b8bcc2", metalness: 0.8, roughness: 0.35 });
  const n = Math.max(2, Math.floor(w / 1.27));
  for (let i = 0; i < n; i++) for (const sz of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.9), leg);
    l.position.set(x - w / 2 + 0.6 + i * ((w - 1.2) / Math.max(1, n - 1)), top + 0.15, z + sz * (d / 2 + 0.35));
    g.add(l);
  }
}

export const isDatasheetPart = (p: ComponentProfile) =>
  p.component_id.startsWith("user_") && !p.geometry.desktop_model;

/** 縮圖快取的 key 不含外形種類：換種類時在名稱後面加不可見字元，讓縮圖重拍（只給 <Thumb> 用，不存檔） */
export const thumbProfile = (p: ComponentProfile): ComponentProfile => {
  if (!p.component_id.startsWith("user_")) return p;
  const hint = shapeHintOf(p);
  // 依圖面生成的模型：形狀內容也要進 key（重新生成後縮圖要更新）
  let h = 0;
  if (hint === "model") for (const ch of JSON.stringify(getModel(p.component_id) ?? [])) h = (h * 31 + ch.charCodeAt(0)) % 97;
  return { ...p, display_name: p.display_name + "\u200b".repeat(SHAPE_HINTS.indexOf(hint) + 1) + (hint === "model" ? "\u200c" + "\u200d".repeat(h) : "") };
};
