import type { CircuitIR, WireEndpoint, WireSegment } from "./circuit-ir.js";
import { parsePinRef } from "./circuit-ir.js";
import type { ComponentProfile } from "./component-profile.js";
import { findPin } from "./component-profile.js";
import type { BreadboardHole } from "./breadboard.js";
import { BREADBOARD_830 } from "./breadboard.js";

/**
 * 杜邦線自動佈線。
 *
 * 照真實麵包板的接線習慣，而不是兩點之間拉一條曲線：
 *  1. 板內跳線（兩端都是孔）走直角 L 形、貼著板面平躺 —— 像預剪的硬跳線。
 *     兩種 L 方向挑「需要抬得最低」的那個。
 *  2. 分層避讓：短線先排、放最低層；每條線往上找第一個和已排好的線段
 *     保持「線徑＋間隙」以上距離的高度。經過元件上方時自動抬到元件頂以上。
 *  3. 從開發板拉出來的線：垂直拉起 → 在板子後緣匯成一束平行排線 →
 *     降到板面 → 走到目標孔。排線依目的欄位排序，減少交叉。
 *
 * 純函式、無 three.js 相依：桌面端拿去做管狀幾何，手機 AR 端可以拿同一份路徑疊圖。
 * 單位 mm，座標系和 CircuitIR 的實體層相同。
 */

export type Vec3 = [number, number, number];

export interface RouteOptions {
  wireRadius: number;     // 線的半徑
  gap: number;            // 線與線之間額外留的空隙
  baseLift: number;       // 板內跳線離板面的高度
  laneStep: number;       // 每一層的高度差
  harnessLift: number;    // 排線在開發板排針上方的高度
  harnessZ: number;       // 排線沿 X 走的那條線（板子後緣外側）
  maxLayers: number;
}

/** 杜邦公頭外殼高度（排針頂端往上算）。排線一律在它上方才轉彎。 */
export const HOUSING_H_MM = 8;

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
  // laneStep 必須 ≥ 線徑×2＋間隙（= 2.2），否則相鄰兩層會擦在一起
  wireRadius: 0.8, gap: 0.6, baseLift: 2.2, laneStep: 2.4,
  harnessLift: HOUSING_H_MM + 1, harnessZ: -5, maxLayers: 16,
};

/** 導線端點的世界座標。插在麵包板上的腳位以孔位為準。 */
/**
 * 板外元件（排線接頭、不插麵包板）：導線從它排線末端的杜邦頭接出。
 * 杜邦頭從插座拉出、間距 2.54mm（原本 1.5mm 的腳距兩條線會黏在一起）。
 */
function cableEnd(pl: CircuitIR["physical"]["placements"][number], prof: ComponentProfile, pinId: string): Vec3 | null {
  const i = prof.pins.findIndex((q) => q.id === pinId);
  if (i < 0) return null;
  // 和桌面模型一致：插座在腳位那一排（元件座標 z 最小處），本體往 +z 延伸。
  // 杜邦頭從插座往 -z 拉出 6mm，沿 x 以 2.54mm 排開、以腳位中心對齊
  const xs = prof.pins.map((q) => q.position_mm[0]), zs = prof.pins.map((q) => q.position_mm[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const lx = cx + (i - (prof.pins.length - 1) / 2) * 2.54, lz = Math.min(...zs) - 6;
  const r = (pl.rotation_deg * Math.PI) / 180;
  return [
    pl.position_mm[0] + lx * Math.cos(r) + lz * Math.sin(r),
    pl.position_mm[1] + 2,
    pl.position_mm[2] - lx * Math.sin(r) + lz * Math.cos(r),
  ];
}

export function endpointPosition(
  e: WireEndpoint, ir: CircuitIR,
  profiles: Map<string, ComponentProfile>, holeIndex: Map<string, BreadboardHole>,
): Vec3 | null {
  if (e.kind === "hole") {
    const h = holeIndex.get(e.hole);
    return h ? [...h.position_mm] as Vec3 : null;
  }
  const { instanceId, pinId } = parsePinRef(e.pin);
  const pl = ir.physical.placements.find((p) => p.instance_id === instanceId);
  if (!pl) return null;
  const hole = pl.pin_to_hole[pinId];
  if (hole) {
    const h = holeIndex.get(hole);
    return h ? [...h.position_mm] as Vec3 : null;
  }
  const profId = instanceId === ir.logical.board.instance_id
    ? ir.logical.board.profile_id
    : ir.logical.components.find((c) => c.id === instanceId)?.profile_id;
  const prof = profId ? profiles.get(profId) : undefined;
  const pin = prof && findPin(prof, pinId);
  if (!pin) return null;
  if (instanceId !== ir.logical.board.instance_id && prof) return cableEnd(pl, prof, pinId);
  const a = (pl.rotation_deg * Math.PI) / 180;
  const [x, y, z] = pin.position_mm;
  return [
    pl.position_mm[0] + x * Math.cos(a) + z * Math.sin(a),
    pl.position_mm[1] + y,
    pl.position_mm[2] - x * Math.sin(a) + z * Math.cos(a),
  ];
}

interface Obstacle { x0: number; x1: number; z0: number; z1: number; top: number; }

/** 插在麵包板上的元件，在板面上佔的範圍與高度。 */
function obstaclesOf(ir: CircuitIR, profiles: Map<string, ComponentProfile>,
                     holeIndex: Map<string, BreadboardHole>): Obstacle[] {
  const out: Obstacle[] = [];
  for (const pl of ir.physical.placements) {
    const holes = Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)).filter(Boolean) as BreadboardHole[];
    if (holes.length === 0) continue;
    const profId = ir.logical.components.find((c) => c.id === pl.instance_id)?.profile_id;
    const prof = profId ? profiles.get(profId) : undefined;
    const [bw, bh, bd] = prof?.geometry.bbox_mm ?? [3, 3, 3];
    const xs = holes.map((h) => h.position_mm[0]), zs = holes.map((h) => h.position_mm[2]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const swap = Math.round(pl.rotation_deg / 90) % 2 !== 0;
    const hw = Math.max((swap ? bd : bw) / 2, (Math.max(...xs) - Math.min(...xs)) / 2 + 0.8) + 0.6;
    const hd = Math.max((swap ? bw : bd) / 2, (Math.max(...zs) - Math.min(...zs)) / 2 + 0.8) + 0.6;
    out.push({ x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd, top: holes[0].position_mm[1] + bh });
  }
  return out;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 兩條 3D 線段的最短距離。 */
export function segmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) return Math.sqrt(dot(r, r));
  if (a <= 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const c1 = lerp3(p1, q1, s), c2 = lerp3(p2, q2, t);
  const d = sub(c1, c2);
  return Math.sqrt(dot(d, d));
}

/** 只有「架空」的段落參與避讓；從孔垂直插下去的短腳不算（同一欄的孔本來就很近）。 */
/**
 * 一條路徑的所有線段，**包含插進孔的那段垂直線**。
 * 以前把插孔段排除在碰撞檢查外，結果別條線可以從插頭正上方壓過去（兩條線在孔上交叉）。
 */
function aerialSegments(path: Vec3[], _surfaceY: number): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i < path.length - 1; i++) out.push([path[i], path[i + 1]]);
  return out;
}

/** 路徑中在水平面上有長度的段落（俯視圖看得到的部分） */
function horizontalRuns(path: Vec3[]): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    if (Math.hypot(b[0] - a[0], b[2] - a[2]) > 0.3) out.push([a, b]);
  }
  return out;
}

/** 俯視圖（x-z 平面）上兩條線段是否真的相交（端點相碰不算） */
function cross2d(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  const o = (p: Vec3, q: Vec3, r: Vec3) => (q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) &&
         ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
}

/** 俯視圖交叉的線對（除錯、自動接線用來找是哪幾條線打結） */
export function planCrossingPairs(routes: Map<string, Vec3[]>): [string, string][] {
  const ids = [...routes.keys()], runs = [...routes.values()].map(horizontalRuns);
  const out: [string, string][] = [];
  for (let i = 0; i < runs.length; i++) for (let k = i + 1; k < runs.length; k++)
    if (runs[i].some(([a, b]) => runs[k].some(([c, d]) => cross2d(a, b, c, d)))) out.push([ids[i], ids[k]]);
  return out;
}

/** 俯視圖交叉總數（測試與 App 用來衡量「看起來亂不亂」） */
export function countPlanCrossings(routes: Map<string, Vec3[]>): number {
  const runs = [...routes.values()].map(horizontalRuns);
  let n = 0;
  for (let i = 0; i < runs.length; i++) for (let k = i + 1; k < runs.length; k++)
    for (const [a, b] of runs[i]) for (const [c, d] of runs[k]) if (cross2d(a, b, c, d)) n++;
  return n;
}

function clean(path: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 0.05) continue;
    out.push(p);
  }
  // 去掉共線的中間點
  for (let i = out.length - 2; i > 0; i--) {
    const u = sub(out[i], out[i - 1]), v = sub(out[i + 1], out[i]);
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    if (lu > 0 && lv > 0 && dot(u, v) / (lu * lv) > 0.9999) out.splice(i, 1);
  }
  return out;
}

/** 線段在板面投影上經過的元件，最高到哪。 */
function clearanceOver(path: Vec3[], obstacles: Obstacle[], r: number): number {
  let top = -Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    for (let k = 1; k < 16; k++) {
      const p = lerp3(path[i], path[i + 1], k / 16);
      for (const o of obstacles) {
        if (p[0] > o.x0 - r && p[0] < o.x1 + r && p[2] > o.z0 - r && p[2] < o.z1 + r) top = Math.max(top, o.top);
      }
    }
  }
  return top;
}

/**
 * 主函式：每條線回傳一條折線（含兩端點）。
 * 桌面端再把轉角倒圓角做成管狀幾何。
 */
export function routeWires(
  ir: CircuitIR,
  profiles: Map<string, ComponentProfile>,
  holes: BreadboardHole[],
  opts: Partial<RouteOptions> = {},
): Map<string, Vec3[]> {
  const o = { ...DEFAULT_ROUTE_OPTIONS, ...opts };
  const surfaceY = BREADBOARD_830.surface_y_mm;
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const obstacles = obstaclesOf(ir, profiles, holeIndex);
  const minSep = o.wireRadius * 2 + o.gap;
  if (o.laneStep < minSep) o.laneStep = minSep + 0.2;   // 防呆：層距不可能小於兩條線的直徑和
  /**
   * 已佔用的線段。owner = 哪條線；reserve = 還沒排的線預留的插孔柱（硬限制：插頭位置不能改，別人只能讓）。
   */
  type Seg = { id: string; s: [Vec3, Vec3]; reserve: boolean; lo: Vec3; hi: Vec3 };
  const seg = (id: string, s: [Vec3, Vec3], reserve: boolean): Seg => ({
    id, s, reserve,
    lo: [Math.min(s[0][0], s[1][0]), Math.min(s[0][1], s[1][1]), Math.min(s[0][2], s[1][2])],
    hi: [Math.max(s[0][0], s[1][0]), Math.max(s[0][1], s[1][1]), Math.max(s[0][2], s[1][2])],
  });

  type Job = { w: WireSegment; a: Vec3; b: Vec3; onBoard: boolean };
  const jobs: Job[] = [];
  for (const w of ir.physical.wires) {
    const a = endpointPosition(w.from, ir, profiles, holeIndex);
    const b = endpointPosition(w.to, ir, profiles, holeIndex);
    if (!a || !b) continue;
    const onBoard = w.from.kind === "hole" && w.to.kind === "hole";
    const j: Job = { w, a, b, onBoard };
    // 讓 b 永遠是板子上的那一端
    if (!onBoard && w.from.kind === "hole") [j.a, j.b] = [j.b, j.a];
    jobs.push(j);
  }

  // 預留插孔柱：每個端點正上方一小段。先排的線不能從別人還沒排的插頭上壓過去
  const reservationsOf = (j: Job): Seg[] => [
    seg(j.w.id, [j.a, [j.a[0], j.a[1] + (j.onBoard ? o.baseLift + o.laneStep : o.harnessLift), j.a[2]]], true),
    seg(j.w.id, [j.b, [j.b[0], j.b[1] + o.baseLift + o.laneStep, j.b[2]]], true),
  ];

  // ── 候選路徑 ──
  /** 每條候選路徑屬於哪一「族」（形狀＋繞行方向＋錯開量）；選路時每族只看最低的那條 */
  const famOf = new WeakMap<Vec3[], string>();
  const tag = (path: Vec3[], fam: string) => { famOf.set(path, fam); return path; };
  const headerTop = Math.max(surfaceY, ...jobs.filter((j) => !j.onBoard).map((j) => j.a[1]));
  const boardX0 = Math.min(...holes.map((h) => h.position_mm[0])) - 3;   // 板子左緣附近
  const boardZ0 = Math.min(...holes.map((h) => h.position_mm[2])) - 3;   // 板子後緣附近
  // 開發板在板子左邊 → 排線沿左緣（平行 Z）走；在後面 → 沿後緣（平行 X）走
  const side = (j: Job): "left" | "back" => (boardX0 - j.a[0]) > (boardZ0 - j.a[2]) ? "left" : "back";
  const edgeDist = (j: Job) => side(j) === "left" ? boardX0 - j.a[0] : boardZ0 - j.a[2];

  /** 開發板自己的 PCB 在桌面上佔的範圍（從 placement＋profile 包圍盒推出） */
  const footprintOf = (w: WireSegment) => {
    const e = w.from.kind === "pin" ? w.from : w.to.kind === "pin" ? w.to : null;
    if (!e || e.kind !== "pin") return null;
    const inst = e.pin.split(".")[0];
    const pl = ir.physical.placements.find((p) => p.instance_id === inst);
    const profId = inst === ir.logical.board.instance_id ? ir.logical.board.profile_id
      : ir.logical.components.find((c) => c.id === inst)?.profile_id;
    const prof = profId ? profiles.get(profId) : undefined;
    if (!pl || !prof || Object.keys(pl.pin_to_hole).length) return null;
    const [bw, , bd] = prof.geometry.bbox_mm;
    const r = (pl.rotation_deg * Math.PI) / 180;
    const pts = [[0, 0], [bw, 0], [0, bd], [bw, bd]].map(([x, z]) => [
      pl.position_mm[0] + x * Math.cos(r) + z * Math.sin(r),
      pl.position_mm[2] - x * Math.sin(r) + z * Math.cos(r)]);
    return { x0: Math.min(...pts.map((q) => q[0])), x1: Math.max(...pts.map((q) => q[0])),
             z0: Math.min(...pts.map((q) => q[1])), z1: Math.max(...pts.map((q) => q[1])) };
  };

  /** 板內跳線：直角 L 形（兩種轉向）＋小幅錯開的 Z 形，由低到高 */
  const onBoardCandidates = (j: Job): Vec3[][] => {
    const { a, b } = j;
    const shapes: ((h: number) => Vec3[])[] = [
      (h) => [a, [a[0], h, a[2]], [b[0], h, a[2]], [b[0], h, b[2]], b],
      (h) => [a, [a[0], h, a[2]], [a[0], h, b[2]], [b[0], h, b[2]], b],
    ];
    for (const d of [2.54, -2.54, 5.08, -5.08]) {
      // 先沿 z 錯開一點再走 x，或先沿 x 錯開一點再走 z：繞過別人的插頭
      shapes.push((h) => [a, [a[0], h, a[2]], [a[0], h, a[2] + d], [b[0], h, a[2] + d], [b[0], h, b[2]], b]);
      shapes.push((h) => [a, [a[0], h, a[2]], [a[0] + d, h, a[2]], [a[0] + d, h, b[2]], [b[0], h, b[2]], b]);
    }
    const out: Vec3[][] = [];
    for (let layer = 0; layer < o.maxLayers; layer++) {
      shapes.forEach((shape, si) => {
        const probe = shape(surfaceY + o.baseLift);
        const need = Math.max(surfaceY + o.baseLift, clearanceOver(probe, obstacles, o.wireRadius) + o.wireRadius + 0.8);
        out.push(tag(shape(need + layer * o.laneStep), `s${si}`));
      });
    }
    return out;
  };

  const offOrder = jobs.filter((j) => !j.onBoard).sort((p, q) => (edgeDist(p) - edgeDist(q)) ||
    (side(p) === "left" ? p.b[2] - q.b[2] : p.b[0] - q.b[0]));

  /**
   * 排線分道（巢狀）：一條線的水平走段如果經過別條線的排針，它就必須走比較靠板子的內道，
   * 否則別人從排針升上來的那段會切過它。往左走的線：排針越靠右越內；往右走的：排針越靠左越內。
   * 這樣從上往下看，排線區不會交叉。
   */
  const laneOf = new Map<string, number>();
  const axis = (j: Job) => (side(j) === "left" ? 2 : 0);
  const leftGoing = offOrder.filter((j) => j.b[axis(j)] < j.a[axis(j)]).sort((p, q) => q.a[axis(q)] - p.a[axis(p)]);
  const rightGoing = offOrder.filter((j) => j.b[axis(j)] >= j.a[axis(j)]).sort((p, q) => p.a[axis(p)] - q.a[axis(q)]);
  leftGoing.forEach((j, i) => laneOf.set(j.w.id, i));
  rightGoing.forEach((j, i) => laneOf.set(j.w.id, i));

  // 排線平行段的間距放大到 1.5 倍：俯視時看得出是兩條線，不會黏成一條帶
  const laneSep = minSep * 1.5;
  /** 從開發板拉出來的線：沿板子最靠近開發板的那條邊匯成排線；遠側排針先繞出 PCB 外緣 */
  const offBoardCandidates = (j: Job): Vec3[][] => {
    const { w, a, b } = j;
    const lane = laneOf.get(w.id) ?? offOrder.indexOf(j);
    const out: Vec3[][] = [];
    const fp = footprintOf(w);
    const pcbTop = Math.min(a[1], ...jobs.filter((x) => !x.onBoard).map((x) => x.a[1])) - 2;   // 排針頂端往下約 2mm 是 PCB 上方元件的基準
    if (fp && side(j) === "back" && a[2] < fp.z1 - 8) {
      // 維持在排線高度繞過 PCB 外緣（不掉到桌面、不跨過自己的 PCB）
      // 兩側都試（近的那側先），由俯視交叉數決定：繞右邊有時能完全不跨過其他排線
      const near = Math.abs(a[0] - fp.x0) < Math.abs(a[0] - fp.x1) ? -1 : 1;
      for (const sgn of [near, -near]) {
        // 板緣外留 10mm：UNO 的 DC 座、USB 座凸出 PCB 外緣，轉角圓弧又會往內切，留 4mm 會穿過 DC 座
        const xe = sgn < 0 ? fp.x0 - 10 - lane * laneSep : fp.x1 + 10 + lane * laneSep;
        const zBehind = boardZ0 - 1 - lane * laneSep;
        for (let ll = 0; ll < 4; ll++) {
          const lift = Math.max(a[1] + o.harnessLift, pcbTop + 6) + ll * o.laneStep;   // 只要高過開發板上的元件就好，不必撐成衣架
          for (let bl = 0; bl < o.maxLayers; bl++) {
            const hb = surfaceY + o.baseLift + bl * o.laneStep;
            // 目標孔就在板緣附近（電源軌）：直接在高處走到孔正上方再垂直落下，
            // 不要先降到板後緣再往前一小段——那會折成 V 形小鉤
            if (Math.abs(b[2] - zBehind) < 20) {   // 電源軌整條都在板緣 20mm 內
              out.push(tag([a, [a[0], lift, a[2]], [xe, lift, a[2]], [xe, lift, b[2]], [b[0], lift, b[2]], b], `d${sgn}direct`));
            }
            for (const jog of [0, 2.54, -2.54]) {
              const xj = b[0] + jog;
              out.push(tag([a, [a[0], lift, a[2]], [xe, lift, a[2]], [xe, lift, zBehind],
                [xj, lift, zBehind], [xj, hb, zBehind], [xj, hb, b[2]], [b[0], hb, b[2]], b], `d${sgn}${jog}`));
            }
          }
        }
      }
    }
    const left = side(j) === "left";
    // jog：最後進孔前沿排線方向錯開一點，繞過「剛好在同一條進場線上」別人的插頭
    const make = (H: number, hb: number, off: number, jog = 0): Vec3[] => {
      const lineOff = -5 - off;
      if (left) {
        const xl = boardX0 + lineOff + 3, xe = Math.min(b[0], boardX0 + 5.5), zj = b[2] + jog;
        return [a, [a[0], H, a[2]], [xl, H, a[2]], [xl, H, zj], [xe, H, zj],
                [xe, hb, zj], [b[0], hb, zj], [b[0], hb, b[2]], b];
      }
      const zl = boardZ0 + lineOff + 3, ze = Math.min(b[2], boardZ0 + 5.5), xj = b[0] + jog;
      // 目標離板緣很近：在排線高度直接走到孔正上方再垂直落下。
      // 先降到板面、往前一小段、再插下去，從側面看是 N 形小鉤（findHooks 抓的就是這個）
      if (Math.abs(b[2] - ze) < 15 && jog === 0) {
        return [a, [a[0], H, a[2]], [a[0], H, zl], [b[0], H, zl], [b[0], H, b[2]], b];
      }
      return [a, [a[0], H, a[2]], [a[0], H, zl], [xj, H, zl], [xj, H, ze],
              [xj, hb, ze], [xj, hb, b[2]], [b[0], hb, b[2]], b];
    };
    const base = headerTop + o.harnessLift;
    const over = clearanceOver(make(base, surfaceY + o.baseLift, 0).slice(4), obstacles, o.wireRadius);
    const hb0 = Math.max(surfaceY + o.baseLift, over + o.wireRadius + 0.8);
    // 先低後高：排線高度與上板高度兩個維度，依總層數排序
    const grid: [number, number][] = [];
    for (let hl = 0; hl < o.maxLayers; hl++) for (let bl = 0; bl < o.maxLayers; bl++) grid.push([hl, bl]);
    grid.sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]) || p[0] - q[0]);
    for (const [hl, bl] of grid) out.push(tag(make(base + hl * o.laneStep, hb0 + bl * o.laneStep, lane * laneSep * 0.6), "m0"));
    // 錯開進場的變體用完整線距分道（一般排線用 0.6 倍線距貼緊、靠高度分層）：
    // 兩種間距混用，擁擠時才有足夠多不同的走法可選（2000 個隨機電路壓力測試的結果）
    for (const jog of [2.54, -2.54, 5.08, -5.08]) {
      for (const [hl, bl] of grid) {
        if (hl >= 8 || bl >= 8) continue;
        out.push(tag(make(base + hl * o.laneStep, hb0 + bl * o.laneStep, lane * laneSep, jog), `m${jog}`));
      }
    }
    return out;
  };

  const candidates = new Map<string, Vec3[][]>();
  for (const j of jobs) candidates.set(j.w.id, j.onBoard ? onBoardCandidates(j) : offBoardCandidates(j));

  // ── 協商式佈線（rip-up and reroute）──
  // 板內短線先、再排從開發板拉出的線；排不開時選「擋到最少線」的路徑，把擋路的拔起來重排。
  // 被拔過越多次的線，下次越不容易被拔（歷史成本），避免兩條線互相搶位置無限循環。
  const onOrder = jobs.filter((j) => j.onBoard).sort((p, q) =>
    (Math.abs(p.a[0] - p.b[0]) + Math.abs(p.a[2] - p.b[2])) -
    (Math.abs(q.a[0] - q.b[0]) + Math.abs(q.a[2] - q.b[2])));
  const byId = new Map(jobs.map((j) => [j.w.id, j]));

  /** 一輪協商：依給定順序排，排不開就拔掉擋路的線重排（有次數上限） */
  // 時間預算：App 在載入專案時同步算佈線，不能讓極端電路把畫面卡住好幾秒
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  const attempt = (order: Job[]) => {
    let placed: Seg[] = jobs.flatMap(reservationsOf);
    const routes = new Map<string, Vec3[]>();

    /** 這條候選路徑會撞到哪些線；撞到預留柱回傳 null（不可行） */
    /** stopAt：撞到這麼多條就不用再算了（已經不可能比目前最佳更好） */
    const hits = (id: string, path: Vec3[], stopAt: number): Set<string> | null => {
      const out = new Set<string>();
      for (const [a, b] of aerialSegments(path, surfaceY)) {
        const lo0 = Math.min(a[0], b[0]) - minSep, hi0 = Math.max(a[0], b[0]) + minSep;
        const lo1 = Math.min(a[1], b[1]) - minSep, hi1 = Math.max(a[1], b[1]) + minSep;
        const lo2 = Math.min(a[2], b[2]) - minSep, hi2 = Math.max(a[2], b[2]) + minSep;
        for (const g of placed) {
          if (g.id === id || out.has(g.id)) continue;
          // 包圍盒先篩：絕大多數線段對在這裡就排除，不必算精確距離
          if (g.hi[0] < lo0 || g.lo[0] > hi0 || g.hi[1] < lo1 || g.lo[1] > hi1 || g.hi[2] < lo2 || g.lo[2] > hi2) continue;
          if (segmentDistance(a, b, g.s[0], g.s[1]) < minSep) {
            if (g.reserve) return null;
            out.add(g.id);
            if (out.size >= stopAt) return out;
          }
        }
      }
      return out;
    };
    /** 這條路徑的水平段，和已排好的線的水平段在俯視圖上交叉幾次（插孔、升降的垂直段不算） */
    const planCrossings = (path: Vec3[], id: string): number => {
      let n = 0;
      const mine = horizontalRuns(path);
      for (const [wid, r] of routes) {
        if (wid === id) continue;
        for (const [a, b] of mine) for (const [c, d] of horizontalRuns(r)) if (cross2d(a, b, c, d)) n++;
      }
      return n;
    };
    const commit = (j: Job, path: Vec3[]) => {
      const p = clean(path);
      routes.set(j.w.id, p);
      placed = placed.filter((g) => g.id !== j.w.id);
      placed.push(...aerialSegments(p, surfaceY).map((s) => seg(j.w.id, s, false)));
    };
    const ripUp = (j: Job) => {
      routes.delete(j.w.id);
      placed = placed.filter((g) => g.id !== j.w.id);
      placed.push(...reservationsOf(j));
    };

    const queue = [...order];
    const ripped = new Map<string, number>();
    let budget = Math.max(40, jobs.length * 12);
    let oscillating = false;
    while (queue.length && budget-- > 0 && !oscillating && elapsed() < 900) {
      const j = queue.shift()!;
      const cands = candidates.get(j.w.id)!;
      // 在前幾條「完全不碰撞」的候選裡，選從上往下看交叉最少的：
      // 不同高度交錯在 3D 裡沒碰到，但從鏡頭看還是兩條線疊在一起，不好看也難照著接
      let free: Vec3[] | null = null, freeX = Infinity;
      const seen = new Set<string>();
      for (const c of cands) {
        const fam = famOf.get(c) ?? "";
        if (seen.has(fam)) continue;          // 這一族已經有更低的可行路徑
        const h = hits(j.w.id, c, 1);
        if (!h || h.size) continue;
        seen.add(fam);
        const x = planCrossings(c, j.w.id);
        if (x < freeX) { free = c; freeX = x; }
        if (freeX === 0) break;
      }
      if (free) { commit(j, free); continue; }

      // 沒有完全空的路：找代價最小的（擋到的線數 × 它們被拔過的次數），把那些線拔掉重排
      let best: { c: Vec3[]; ids: Set<string>; cost: number } | null = null;
      for (let i = 0; i < cands.length; i++) {
        const h = hits(j.w.id, cands[i], best ? Math.floor(best.cost) + 1 : Infinity);
        if (!h) continue;
        let cost = i * 0.001;
        for (const id of h) cost += 1 + 2 * (ripped.get(id) ?? 0);
        if (!best || cost < best.cost) best = { c: cands[i], ids: h, cost };
      }
      if (!best) { commit(j, cands[cands.length - 1]); continue; }
      for (const id of best.ids) {
        const other = byId.get(id)!;
        ripUp(other);
        ripped.set(id, (ripped.get(id) ?? 0) + 1);
        // 同一條線被拔超過 6 次：這個順序在兩三條線之間來回搶位置，換順序比繼續耗下去有效
        if (ripped.get(id)! > 6) oscillating = true;
        queue.push(other);
      }
      commit(j, best.c);
    }
    // 預算用完還沒排的線：給它衝突最少的路徑；碰撞交給 findWireCollisions 判斷這一輪好不好
    for (const j of queue) {
      if (routes.has(j.w.id)) continue;
      const cands = candidates.get(j.w.id)!;
      let pick = cands[0], bestN = Infinity;
      for (const c of cands) {
        const h = hits(j.w.id, c, bestN);
        const n = h ? h.size : 1e6;
        if (n < bestN) { bestN = n; pick = c; }
        if (bestN === 0) break;
      }
      commit(j, pick);
    }
    return routes;
  };

  // 預設順序先試；有碰撞就換順序重試幾輪（固定種子，結果可重現），留碰撞最少的那一輪
  let order = [...onOrder, ...offOrder];
  let bestRoutes = attempt(order);
  let bestHits = findWireCollisions(bestRoutes, o).length;
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let k = 0; k < 12 && bestHits > 0 && elapsed() < 700; k++) {
    order = [...order].sort(() => rand() - 0.5);
    const r = attempt(order);
    const n = findWireCollisions(r, o).length;
    if (n < bestHits) { bestRoutes = r; bestHits = n; }
  }
  const routes = bestRoutes;

  return routes;
}

/**
 * 找出佈好的線之間的碰撞（任兩條線任一段距離 < 線徑＋間隙，含插孔垂直段）。
 * 測試和 App 都用這個：佈線演算法真的排不開時要被看見，不能默默畫出交叉的線。
 */
export function findWireCollisions(
  routes: Map<string, Vec3[]>, opts: Partial<RouteOptions> = {},
): { a: string; b: string; distance: number }[] {
  const o = { ...DEFAULT_ROUTE_OPTIONS, ...opts };
  const minSep = o.wireRadius * 2 + o.gap - 1e-6;
  const segs = [...routes.entries()].map(([id, p]) => ({ id, s: aerialSegments(p, 0) }));
  const out: { a: string; b: string; distance: number }[] = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    let best = Infinity;
    for (const [a, b] of segs[i].s) for (const [c, d] of segs[j].s) best = Math.min(best, segmentDistance(a, b, c, d));
    if (best < minSep) out.push({ a: segs[i].id, b: segs[j].id, distance: best });
  }
  return out;
}

/**
 * 找出「鉤子」：線往下降、走一小段（< 15mm）水平、又再往下降。
 * 從側面看是 N 形或 V 形小折，是佈線最醜的瑕疵；碰撞檢查抓不到它，所以另外量。
 */
export function findHooks(routes: Map<string, Vec3[]>): string[] {
  const out: string[] = [];
  for (const [id, p] of routes) {
    for (let i = 0; i + 3 < p.length; i++) {
      const [a, b, c, d] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      const down1 = a[1] - b[1] > 0.8 && Math.hypot(b[0] - a[0], b[2] - a[2]) < 0.3;
      const flat = Math.abs(c[1] - b[1]) < 0.3 && Math.hypot(c[0] - b[0], c[2] - b[2]) < 15 && Math.hypot(c[0] - b[0], c[2] - b[2]) > 0.3;
      const down2 = c[1] - d[1] > 0.8 && Math.hypot(d[0] - c[0], d[2] - c[2]) < 0.3;
      if (down1 && flat && down2) { out.push(id); break; }
    }
  }
  return out;
}
