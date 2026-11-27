import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { bbSpecOf } from "../stores/projectStore";
import { routeWires, moduleRect, type CircuitIR, type ComponentProfile, type BreadboardHole } from "@assemblex/circuit-schema";
import { useProject } from "../stores/projectStore";
import { chromeFor } from "../spatial/layout";
const CAT_ZH: Record<string, string> = { sensor: "感測器", actuator: "致動器", led: "LED", input: "輸入", passive: "被動元件", display: "顯示器", microcontroller_board: "開發板", module: "模組" };
import { Thumb } from "../ui/Thumb";

/**
 * 3D 標註卡：一個圓點釘在元件上，引線拉到旁邊的卡片（CAD 縮圖＋規格）。
 * 規格全部從 profile 與 netlist 推出來，不寫死。預設標註開發板和第一個感測器。
 * 只在工作台畫面顯示。座標單位 mm（放在 Workspace 那個 group 裡）。
 */
type Side = "left" | "right";
// 各張卡的錨點螢幕 x 與卡片矩形（每一幀更新），用來決定左右與互相避讓
const ANCHORS = new Map<string, number>();
const RECTS = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
// 整個電路模型（麵包板上用到的範圍＋各元件高度＋開發板）在頁面上的外框，每一幀更新；卡片不能蓋到它
const MODEL = { box: null as null | { x0: number; x1: number; y0: number; y1: number }, pts: [] as [number, number][] };

function ModelBox({ points }: { points: [number, number, number][] }) {
  const g = useRef<THREE.Group>(null);
  const { camera, gl } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!g.current || !points.length) { MODEL.box = null; return; }
    const r = gl.domElement.getBoundingClientRect();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const out: [number, number][] = [];
    for (const p of points) {
      v.set(p[0], p[1], p[2]).applyMatrix4(g.current.matrixWorld).project(camera);
      const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
      out.push([x, y]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    MODEL.box = { x0, x1, y0, y1 }; MODEL.pts = out;
    if (import.meta.env.DEV) (window as unknown as { __model: typeof MODEL; __rects: typeof RECTS }).__model = MODEL, (window as unknown as { __rects: typeof RECTS }).__rects = RECTS;
  });
  return <group ref={g} />;
}

function anchorOf(id: string, ir: CircuitIR, prof: ComponentProfile,
                  holeIndex: Map<string, BreadboardHole>): [number, number, number] | null {
  const pl = ir.physical.placements.find((p) => p.instance_id === id);
  if (!pl) return null;
  const [w, h, d] = prof.geometry.bbox_mm;
  // 插在麵包板上的元件：錨點放在所有腳位的中心上方（開發板插麵包板時不會釘在最左端）
  const hs = Object.values(pl.pin_to_hole).map((x) => holeIndex.get(x)?.position_mm).filter((p): p is [number, number, number] => !!p);
  // 規格書模組：本體從腳位排往單側延伸（和驗證器、3D 外形同一個幾何），錨點放在本體中心
  const mod = hs.length ? moduleRect(pl, prof, holeIndex) : null;
  if (mod) return [(mod.x0 + mod.x1) / 2, hs[0][1] + h * 0.8, (mod.z0 + mod.z1) / 2];
  if (hs.length) {
    const cx = hs.reduce((a, p) => a + p[0], 0) / hs.length, cz = hs.reduce((a, p) => a + p[2], 0) / hs.length;
    return [cx, hs[0][1] + h * 0.8, cz];
  }
  const a = (pl.rotation_deg * Math.PI) / 180;
  const cx = w / 2, cz = d / 2;
  return [pl.position_mm[0] + cx * Math.cos(a) + cz * Math.sin(a), h,
          pl.position_mm[2] - cx * Math.sin(a) + cz * Math.cos(a)];
}

function Card({ id, side, muted = false }: { id: string; side: Side; muted?: boolean }) {
  const { ir, profiles, holeIndex } = useProject();
  const profId = id === ir.logical.board.instance_id
    ? ir.logical.board.profile_id
    : ir.logical.components.find((c) => c.id === id)?.profile_id;
  const prof = profId ? profiles.get(profId) : undefined;
  const pos = useMemo(() => (prof ? anchorOf(id, ir, prof, holeIndex) : null), [id, ir, prof, holeIndex]);
  // 總覽預設展開（截圖、展示時沒有人會去滑）；滑鼠移過可以收合
  const panelOpen = useProject((s) => s.openCard !== null);
  const [hover, setHover] = useState<boolean | null>(null);
  // 每一幀依螢幕位置決定卡片放哪：兩側都試，選完全落在可視區內的一側；
  // 兩張卡時，螢幕上偏右的元件卡放右邊、偏左的放左邊（引線不交叉）；都放不下就夾在可視區內
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGPolylineElement>(null);
  const screenName = useProject((s) => s.screen);
  useEffect(() => () => { ANCHORS.delete(id); RECTS.delete(id); }, [id]);
  useFrame(() => {
    const root = rootRef.current, card = cardRef.current, line = lineRef.current;
    if (!root || !card || !line) return;
    const a = root.getBoundingClientRect();
    const ax = a.left, ay = a.top;
    ANCHORS.set(id, ax);
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const L = 112, Rr = window.innerWidth - chromeFor(screenName, panelOpen).right - 8;
    const others = [...ANCHORS.entries()].filter(([k]) => k !== id).map(([, x]) => x);
    const pref: Side = others.length ? (ax >= Math.max(...others) ? "right" : "left") : side;
    const mb = MODEL.box;
    const T = 156, B = window.innerHeight - 290;   // 頂部暗幕 150px 以下才放卡
    const yBase = Math.min(Math.max(ay + (open ? -190 : -60), T), B - ch);
    const other: Side = pref === "right" ? "left" : "right";
    const clear = (x: number, y: number) => {
      if (x < L || x + cw > Rr || y < T || y + ch > B) return false;
      for (const [px, py] of MODEL.pts) if (px > x - 14 && px < x + cw + 14 && py > y - 14 && py < y + ch + 14) return false;
      for (const [k, r] of RECTS) if (k !== id && x < r.x1 + 12 && x + cw > r.x0 - 12 && y < r.y1 + 12 && y + ch > r.y0 - 12) return false;
      return true;
    };
    const near = (sd: Side) => sd === "right" ? ax + 120 : ax - 120 - cw;
    const far = (sd: Side) => sd === "right" ? (mb?.x1 ?? ax) + 32 : (mb?.x0 ?? ax) - 32 - cw;
    const cands: [number, number, Side][] = [];
    for (const sd2 of [pref, other]) for (const xx of [near(sd2), far(sd2)])
      for (const yy of [yBase, ay - ch - 40, ay - ch / 2, T]) cands.push([xx, Math.min(Math.max(yy, T), B - ch), sd2]);
    if (mb) cands.push([Math.min(Math.max(ax - cw / 2, L), Rr - cw), mb.y0 - ch - 24, ax > (L + Rr) / 2 ? "right" : "left"]);
    const keep = last.current && last.current[3] === cw && Math.abs(last.current[4] - ax) < 2 && Math.abs(last.current[5] - ay) < 2
      && clear(last.current[0], last.current[1]) ? last.current : null;
    const hit = keep ? [keep[0], keep[1], keep[2]] as [number, number, Side] : cands.find(([x, y]) => clear(x, y));
    let sd: Side = pref, x0: number, y0: number;
    if (hit) [x0, y0, sd] = hit;
    else {
      // 找不到乾淨的位置：這一幀不顯示；展開卡就收成膠囊再找，膠囊也放不下就放到模型上方（引線長一點也不蓋元件）
      x0 = Math.min(Math.max(near(pref), L), Rr - cw); y0 = mb ? Math.max(T, mb.y0 - ch - 24) : yBase;
      if (open) { if (!noRoom) setNoRoom(true); root.style.visibility = "hidden"; return; }
    }
    last.current = [x0, y0, sd, cw, ax, ay];
    // 和其他卡的避讓已經在 clear() 裡做（排除自己）；這裡不能再拿 RECTS 比，裡面有自己上一幀的位置，會來回跳
    RECTS.set(id, { x0, x1: x0 + cw, y0, y1: y0 + ch });
    card.style.left = `${x0 - ax}px`; card.style.top = `${y0 - ay}px`;
    root.style.visibility = "visible";   // 位置算好才顯示，不會先在預設位置閃一下
    // 引線接到卡片標題那一行的中線（展開卡：縮圖中心；收合膠囊：垂直中心）；卡片在上方時接底邊中點
    const above = mb != null && y0 + ch <= mb.y0;
    const ex = above ? x0 - ax + cw / 2 : sd === "right" ? x0 - ax : x0 - ax + cw;
    const nm = card.querySelector(".cc-name") as HTMLElement | null;
    const nr = nm?.getBoundingClientRect(), cr = card.getBoundingClientRect();
    const titleMid = nr && open ? nr.top - cr.top + nr.height / 2 : ch / 2;   // 量實際的標題位置，不寫死
    const ey = above ? y0 - ay + ch : y0 - ay + titleMid;
    // 直角引線（和腳位標籤同一套語彙）：卡片在上方時 錨點 → 垂直 → 水平 → 垂直接底邊；在兩側時 錨點 → 垂直到標題列 → 水平接進卡片
    // 最多兩段：錨點正上方就是卡片 → 一條垂直線；否則垂直到標題列高度，再水平接進卡片較近的那一側
    const cx0 = x0 - ax, cx1 = x0 - ax + cw, my = y0 - ay + titleMid;
    const pts = above && cx0 + 12 <= 0 && 0 <= cx1 - 12 ? `0,0 0,${y0 - ay + ch}`
      : `0,0 0,${my} ${cx1 < 0 ? cx1 : cx0 > 0 ? cx0 : ex},${my}`;
    line.setAttribute("points", pts);
  });
  // 預設：沒開面板時展開；開了面板空間不夠就收成一行。滑鼠移過可以手動切換
  // 版面放不下展開卡時自動收成膠囊（換專案、換面板狀態才重新嘗試展開）
  const [noRoom, setNoRoom] = useState(false);
  useEffect(() => { setNoRoom(false); }, [ir, panelOpen]);
  const open = noRoom ? false : (hover ?? !panelOpen);   // 滑過不能推翻「沒位置」的判斷
  const last = useRef<[number, number, Side, number, number, number] | null>(null);
  if (!prof || !pos) return null;

  const usedPins = new Set(ir.logical.nets.flatMap((n) => n.pins).filter((p) => p.startsWith(id + ".")));
  const e = prof.electrical;
  const rows: [string, string][] = [
    ["腳位", `${usedPins.size} / ${prof.pins.length} 使用中`],
    ...(e.logic_voltage_v ? [["邏輯電壓", `${e.logic_voltage_v} V`] as [string, string]] : []),
    ...(e.supply_voltage_min_v ? [["供電", (e.supply_voltage_min_v === e.supply_voltage_max_v ? `${e.supply_voltage_min_v} V` : `${e.supply_voltage_min_v}–${e.supply_voltage_max_v} V`)] as [string, string]] : []),
    ...(e.recommended_gpio_current_ma ? [["GPIO 電流", `${e.recommended_gpio_current_ma} mA`] as [string, string]] : []),
  ];
  // 左側卡片往下放，避開左上角的專案標題；右側卡片往上
  // 展開的卡片往外上方拉開，放在元件旁邊的空處，不蓋住元件本體
  const W = open ? 268 : 168;
  const dx = side === "right" ? 150 : -150 - W, dy = open ? -190 : -60;   // 初始位置；實際位置每一幀在 useFrame 裡算

  return (
    <Html position={pos} zIndexRange={[9, 1]} style={{ pointerEvents: "none" }}>
      <div ref={rootRef} className={`callout ${muted ? "is-muted" : ""}`} style={{ visibility: "hidden" }}>
        <svg width="1" height="1">
          <polyline ref={lineRef} fill="none" points={`0,0 ${side === "right" ? dx : dx + W},${dy + 30}`}
                    stroke="rgba(255,255,255,.7)" strokeWidth={1} />
        </svg>
        <span className="callout-dot" />
        <div ref={cardRef} className={`callout-card card ${open ? "" : "is-compact"}`} style={{ left: dx, top: dy, width: open ? W : undefined }}
             onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(null)}>
          {!open && <span className="cc-name">{prof.display_name}</span>}
          {open && <><div className="cc-row">
            <Thumb profile={prof} size={72} />
            <div className="stack" style={{ minWidth: 0 }}>
              <span className="cc-name">{prof.display_name}</span>
              <span className="cc-sub" style={{ margin: 0 }}>{prof.manufacturer ?? CAT_ZH[prof.category] ?? prof.category} · 位號 {id.toUpperCase()}</span>
            </div>
          </div>
          <div className="kv-list">
            {rows.map(([k, v]) => <div key={k} className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>)}
          </div></>}
        </div>
      </div>
    </Html>
  );
}

/** 模型外框取樣點：每個元件的腳位孔（含元件高度）＋放在旁邊的開發板外框角點。單位 mm。 */
function modelPoints(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holeIndex: Map<string, BreadboardHole>) {
  const out: [number, number, number][] = [];
  const all = [{ id: ir.logical.board.instance_id, profile_id: ir.logical.board.profile_id }, ...ir.logical.components];
  for (const c of all) {
    const prof = profiles.get(c.profile_id), pl = ir.physical.placements.find((p) => p.instance_id === c.id);
    if (!prof || !pl) continue;
    const [w, h, d] = prof.geometry.bbox_mm;
    const hs = Object.values(pl.pin_to_hole).map((x) => holeIndex.get(x)?.position_mm).filter((p): p is [number, number, number] => !!p);
    if (hs.length) { for (const p of hs) { out.push([p[0], p[1], p[2]]); out.push([p[0], p[1] + h, p[2]]); } continue; }
    const a = (pl.rotation_deg * Math.PI) / 180, [px, py, pz] = pl.position_mm;
    for (const [x, z] of [[0, 0], [w, 0], [0, d], [w, d]]) for (const y of [0, h])
      out.push([px + x * Math.cos(a) + z * Math.sin(a), py + y, pz - x * Math.sin(a) + z * Math.cos(a)]);
  }
  return out;
}

export function Callouts() {
  const { ir, profiles, screen, view, activeStep, selectedNet, hoveredPart, holeIndex, holes } = useProject();
  // 模型外框：元件、開發板，加上每條導線的路徑點（拱起的跳線常常是最突出的東西）
  const pts = useMemo(() => {
    const out = modelPoints(ir, profiles, holeIndex);
    for (const p of routeWires(ir, profiles, holes).values()) for (const q of p) out.push([q[0], q[1], q[2]]);
    // 整塊麵包板（含沒用到的區域）每 12mm 取一點：卡片也不能蓋到板子
    const [BW, BH, BD] = bbSpecOf(ir.physical.breadboard?.profile_id).size_mm;
    for (let x = 0; x <= BW; x += 12) for (let z = 0; z <= BD; z += 12) out.push([x, BH, z]);
    return out;
  }, [ir, profiles, holeIndex, holes]);
  // 只在總覽標註：麵包板／Arduino 視角是用來看孔位與排針的，不該被卡片擋住
  // AR 步驟模式下也不標：指向的元件可能還沒「插上去」
  if (screen !== "project" || view !== "overview" || activeStep != null) return null;
  const muted = !!(selectedNet || hoveredPart);   // 不卸載：卸載再掛回來會跳位、閃爍
  const sensor = ir.logical.components.find((c) => {
    const cat = profiles.get(c.profile_id)?.category;
    return cat === "sensor" || cat === "actuator";
  });
  return (
    <>
      <ModelBox points={pts} />
      <Card id={ir.logical.board.instance_id} side="right" muted={muted} />
      {sensor && <Card id={sensor.id} side="left" muted={muted} />}
    </>
  );
}
