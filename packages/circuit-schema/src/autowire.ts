import { moduleRect, isEdgeModule } from "./netlist.js";
import type { CircuitIR, WireEndpoint, WireSegment } from "./circuit-ir.js";
import type { ComponentProfile } from "./component-profile.js";
import type { BreadboardHole } from "./breadboard.js";
import { endpointPosition, routeWires, findWireCollisions, countPlanCrossings, type Vec3 } from "./routing.js";

/**
 * 自動接線：給定「用哪些元件、插在哪些孔、哪些腳要相連」（logical.nets + placements），
 * 依接線規範（docs/WIRING_RULES.md）產生全部杜邦線。AI 不再自己挑孔位。
 *
 * 只讀孔位資料（導通群組 tie_group、電源軌 rail、座標），不寫死任何麵包板尺寸：
 * 830／400／170 孔、軌道分段或整條、沒有軌道，都走同一套。
 *
 * 規範摘要（完整條文見 WIRING_RULES.md）：
 *  R1 已經在同一個導通群組的腳，不另外接線。
 *  R2 線只能插在「該網路自己的導通群組」裡沒被佔用、沒被元件本體蓋住的孔。
 *  R3 一孔一物：元件腳、線端互不重複。
 *  R4 電源／地網路走電源軌（＋／−），每個元件就近接到軌上；用到兩段軌時自動補橋接線。
 *     沒有電源軌的板子，電源／地照訊號網路處理。
 *  R5 訊號網路用最小生成樹串接；有開發板腳位時從開發板出發。
 *  R6 顏色固定：電源紅、地深灰、訊號依網路分配不重複的顏色。
 *  R7 產生後必須通過電氣檢查；多組候選（選軌、選孔策略）中挑實體碰撞 0、俯視交叉最少、總長最短的。
 */

export interface AutoWireResult {
  wires: WireSegment[];
  problems: string[];
  /** 候選評分：碰撞數、交叉數、總長（mm） */
  score: { collisions: number; crossings: number; length: number };
}

const POWER = "#d6484d", GROUND = "#1f2937";
const SIGNAL = ["#4ade80", "#2f6fd0", "#f5a524", "#a78bfa", "#f97316", "#14b8a6", "#ec4899", "#eab308", "#60a5fa", "#84cc16"];

type Terminal =
  | { kind: "pin"; ref: string; pos: Vec3 }
  | { kind: "strip"; group: string; pos: Vec3 };

interface Strategy { railPick: "nearMcu" | "nearParts"; holePick: "near" | "edge"; tree: "mst" | "star"; rand?: () => number; order?: number[] }

const STRATEGIES: Strategy[] = [
  { railPick: "nearMcu", holePick: "near", tree: "mst" },
  { railPick: "nearMcu", holePick: "edge", tree: "mst" },
  { railPick: "nearParts", holePick: "near", tree: "mst" },
  { railPick: "nearMcu", holePick: "near", tree: "star" },
  { railPick: "nearParts", holePick: "edge", tree: "star" },
];

const dist = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]);

/** 元件本體在麵包板平面上的外框（和 blockedHoleErrors 同一套：以腳位中心為中心，bbox 依旋轉換軸） */
function bodyBoxes(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holeIndex: Map<string, BreadboardHole>) {
  return ir.physical.placements.flatMap((pl) => {
    const hs = Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)).filter((h): h is BreadboardHole => !!h);
    const comp = ir.logical.components.find((c) => c.id === pl.instance_id);
    const prof = comp ? profiles.get(comp.profile_id) : profiles.get(ir.logical.board.profile_id);
    if (!hs.length || !prof) return [];
    const mod = moduleRect(pl, prof, holeIndex, 0.8);   // 規格書模組：本體從腳位排往一側延伸
    if (mod) return [mod];
    const cx = hs.reduce((s, h) => s + h.position_mm[0], 0) / hs.length;
    const cz = hs.reduce((s, h) => s + h.position_mm[2], 0) / hs.length;
    const [w, , d] = prof.geometry.bbox_mm;
    const swap = Math.round(pl.rotation_deg / 90) % 2 !== 0;
    const hw = (swap ? d : w) / 2 - 0.8, hd = (swap ? w : d) / 2 - 0.8;
    return [{ x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd }];
  });
}

function wireOnce(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[], st: Strategy) {
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const groups = new Map<string, BreadboardHole[]>();
  for (const h of holes) groups.set(h.tie_group, [...(groups.get(h.tie_group) ?? []), h]);
  const boxes = bodyBoxes(ir, profiles, holeIndex);
  const covered = (h: BreadboardHole) => boxes.some((b) => h.position_mm[0] > b.x0 && h.position_mm[0] < b.x1 && h.position_mm[2] > b.z0 && h.position_mm[2] < b.z1);
  const used = new Set(ir.physical.placements.flatMap((p) => Object.values(p.pin_to_hole)));
  const problems: string[] = [];
  const wires: WireSegment[] = [];
  const board = ir.logical.board.instance_id;

  const freeIn = (group: string, toward: Vec3): BreadboardHole | null => {
    const cands = (groups.get(group) ?? []).filter((h) => !used.has(h.id) && !covered(h));
    if (!cands.length) return null;
    // near：最靠近目標的孔；edge：最外側的孔（離元件本體最遠，線比較不會從元件上方經過）
    const key = st.holePick === "near" ? (h: BreadboardHole) => dist(h.position_mm, toward)
      : (h: BreadboardHole) => -Math.abs(h.position_mm[2] - (groups.get(group)!.reduce((s, x) => s + x.position_mm[2], 0) / groups.get(group)!.length));
    const sorted = cands.sort((a, b) => key(a) - key(b) || dist(a.position_mm, toward) - dist(b.position_mm, toward));
    return st.rand ? sorted[Math.min(sorted.length - 1, Math.floor(st.rand() * Math.min(3, sorted.length)))] : sorted[0];
  };
  const take = (h: BreadboardHole) => { used.add(h.id); return { kind: "hole", hole: h.id } as WireEndpoint; };

  const terminalsOf = (pins: string[]): Terminal[] => {
    const out: Terminal[] = [];
    const seen = new Set<string>();
    for (const ref of pins) {
      const [inst, pin] = ref.split(".");
      const pl = ir.physical.placements.find((p) => p.instance_id === inst);
      const hole = pl?.pin_to_hole[pin];
      if (hole) {
        const h = holeIndex.get(hole);
        if (!h) { problems.push(`${ref} 插在不存在的孔 ${hole}`); continue; }
        if (seen.has(h.tie_group)) continue;   // R1：同一個導通群組已經相通
        seen.add(h.tie_group);
        const gh = groups.get(h.tie_group)!;
        out.push({ kind: "strip", group: h.tie_group, pos: [gh.reduce((s, x) => s + x.position_mm[0], 0) / gh.length, h.position_mm[1], gh.reduce((s, x) => s + x.position_mm[2], 0) / gh.length] });
      } else {
        const pos = endpointPosition({ kind: "pin", pin: ref }, ir, profiles, holeIndex);
        if (!pos) { problems.push(`找不到 ${ref} 的位置`); continue; }
        out.push({ kind: "pin", ref, pos });
      }
    }
    return out;
  };

  const add = (net: string, color: string, a: WireEndpoint, b: WireEndpoint) =>
    wires.push({ id: `w_${net}_${wires.filter((w) => w.net_id === net).length + 1}`, net_id: net, color, from: a, to: b });

  const endpointToward = (t: Terminal, toward: Vec3): WireEndpoint | null => {
    if (t.kind === "pin") return { kind: "pin", pin: t.ref };
    const h = freeIn(t.group, toward);
    if (!h) { problems.push(`導通群組 ${t.group} 沒有空孔可以接線`); return null; }
    return take(h);
  };

  // 電源軌：依極性分組（"+" / "-"），每條軌有自己的分段（tie_group）
  const rails = new Map<string, BreadboardHole[]>();
  for (const h of holes) if (h.kind === "rail" && h.rail) rails.set(h.rail, [...(rails.get(h.rail) ?? []), h]);
  const mcuPos = (() => {
    const pl = ir.physical.placements.find((p) => p.instance_id === board);
    return pl ? (pl.position_mm as Vec3) : null;
  })();

  let colorK = 0;
  // 先接電源／地（軌道上的孔比較搶手），再接訊號
  const nets = [...ir.logical.nets].sort((a, b) => (a.role === "signal" ? 1 : 0) - (b.role === "signal" ? 1 : 0)
    || (st.order ? st.order[ir.logical.nets.indexOf(a) % st.order.length] - st.order[ir.logical.nets.indexOf(b) % st.order.length] : 0));
  for (const net of nets) {
    const terms = terminalsOf(net.pins);
    if (terms.length < 2) continue;
    const isPower = net.role === "power" || net.role === "ground";
    const color = net.role === "power" ? POWER : net.role === "ground" ? GROUND : SIGNAL[colorK++ % SIGNAL.length];
    const polarity = net.role === "power" ? "+" : "-";
    const railNames = [...rails.keys()].filter((n) => n.endsWith(polarity));

    if (isPower && railNames.length) {
      // R4：選一條同極性的軌——靠近開發板（排線短）或靠近元件群（元件端短）
      const centroid: Vec3 = [terms.reduce((s, t) => s + t.pos[0], 0) / terms.length, 0, terms.reduce((s, t) => s + t.pos[2], 0) / terms.length];
      const ref = st.railPick === "nearMcu" && mcuPos ? mcuPos : centroid;
      const railName = railNames.sort((a, b) => Math.abs(rails.get(a)![0].position_mm[2] - ref[2]) - Math.abs(rails.get(b)![0].position_mm[2] - ref[2]))[0];
      const rail = rails.get(railName)!;
      const segUsed = new Set<string>();
      for (const t of terms) {
        const freeRail = rail.filter((h) => !used.has(h.id)).sort((a, b) => Math.abs(a.position_mm[0] - t.pos[0]) - Math.abs(b.position_mm[0] - t.pos[0]));
        if (!freeRail.length) { problems.push(`${railName} 軌沒有空孔`); continue; }
        // 開發板的電源／地腳：接到軌上的哪個位置會決定排線會不會和訊號線交叉。
        // 固定策略接最近的孔；搜尋時在整條軌上取樣（跨段會自動補橋接線）
        const rh = t.kind === "pin" && st.rand ? freeRail[Math.floor(st.rand() * freeRail.length)] : freeRail[0];
        const from = endpointToward(t, rh.position_mm);
        if (!from) continue;
        segUsed.add(rh.tie_group);
        add(net.id, color, from, take(rh));
      }
      // 分段的軌道：用到的段之間補橋接線（相鄰兩段的交界處）
      const segs = [...new Set(rail.map((h) => h.tie_group))];
      const usedIdx = segs.map((s, i) => (segUsed.has(s) ? i : -1)).filter((i) => i >= 0);
      if (usedIdx.length > 1) {
        for (let i = usedIdx[0]; i < usedIdx[usedIdx.length - 1]; i++) {
          const left = rail.filter((h) => h.tie_group === segs[i] && !used.has(h.id)).sort((a, b) => b.position_mm[0] - a.position_mm[0])[0];
          const right = rail.filter((h) => h.tie_group === segs[i + 1] && !used.has(h.id)).sort((a, b) => a.position_mm[0] - b.position_mm[0])[0];
          if (!left || !right) { problems.push(`${railName} 軌分段之間找不到空孔可以橋接`); continue; }
          add(net.id, color, take(left), take(right));
        }
      }
      continue;
    }

    // R5：訊號網路（或沒有軌道時的電源／地）——最小生成樹；有開發板腳位就從它出發
    const root = terms.findIndex((t) => t.kind === "pin");
    const inTree = new Set([root >= 0 ? root : 0]);
    while (inTree.size < terms.length) {
      let best: [number, number, number] | null = null;
      for (const i of inTree) for (let j = 0; j < terms.length; j++) {
        if (inTree.has(j)) continue;
        // star：一律從根連出去；mst：從樹上最近的點連出去
        if (st.tree === "star" && i !== (root >= 0 ? root : 0)) continue;
        const d = dist(terms[i].pos, terms[j].pos);
        if (!best || d < best[2]) best = [i, j, d];
      }
      if (!best) break;
      const [i, j] = best;
      const a = endpointToward(terms[i], terms[j].pos);
      const b = endpointToward(terms[j], terms[i].pos);
      if (a && b) add(net.id, color, a, b);
      inTree.add(j);
    }
  }
  return { wires, problems };
}

/**
 * 依規範產生全部導線。會試幾組策略，挑：沒有問題 → 實體碰撞 0 → 俯視交叉最少 → 總長最短。
 * 回傳的 wires 直接放進 ir.physical.wires。
 */
export function autoWire(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[],
                         opts: { budgetMs?: number; seed?: number } = {}): AutoWireResult {
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const base: CircuitIR = { ...ir, physical: { ...ir.physical, wires: [] } };
  let best: AutoWireResult | null = null;
  // 先試固定策略；還有交叉就在時間預算內做隨機搜尋（固定種子，結果可重現）
  let seed = opts.seed ?? 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const t0 = Date.now(), budget = opts.budgetMs ?? 1500;
  const variants = function* (): Generator<Strategy> {
    yield* STRATEGIES;
    for (let k = 0; k < 400; k++) {
      const b = STRATEGIES[k % STRATEGIES.length];
      yield { ...b, rand: rnd, order: ir.logical.nets.map(() => rnd()) };
    }
  };
  for (const st of variants()) {
    if (best && !best.problems.length && !best.score.collisions && !best.score.crossings) break;
    if (st.rand && Date.now() - t0 > budget) break;
    const { wires, problems } = wireOnce(base, profiles, holes, st);
    const trial: CircuitIR = { ...base, physical: { ...base.physical, wires } };
    const routes = routeWires(trial, profiles, holes);
    const score = {
      collisions: findWireCollisions(routes).length,
      crossings: countPlanCrossings(routes),
      length: wires.reduce((s, w) => {
        const a = endpointPosition(w.from, trial, profiles, holeIndex), b = endpointPosition(w.to, trial, profiles, holeIndex);
        return s + (a && b ? dist(a, b) : 0);
      }, 0),
    };
    const r = { wires, problems, score };
    const better = !best
      || (problems.length < best.problems.length)
      || (problems.length === best.problems.length && (score.collisions < best.score.collisions
        || (score.collisions === best.score.collisions && (score.crossings < best.score.crossings
          || (score.crossings === best.score.crossings && score.length < best.score.length)))));
    if (better) best = r;
  }
  return best!;
}

/**
 * 腳位重新分配（接線規範 §3 S3）：訊號網路接到開發板的哪一隻腳，只要功能相同（類比 ADC／PWM／一般 GPIO）
 * 就可以互換。把「開發板腳位的左右順序」對齊「元件的左右順序」，排線就不會交叉。
 * 只在同一功能類別內互換（集合不變），韌體的腳位對照一起更新。試順向、反向，和原本的分配比，取交叉最少的。
 */
export function optimizePinAssignment(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[],
                                      opts: { budgetMs?: number } = {}): { ir: CircuitIR; remap: Record<string, string>; result: AutoWireResult } {
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const board = ir.logical.board.instance_id;
  const bprof = profiles.get(ir.logical.board.profile_id);
  const classOf = (ref: string) => {
    const f = bprof?.pins.find((p) => p.id === ref.split(".")[1])?.functions ?? [];
    return f.includes("ADC") ? "adc" : f.includes("PWM") ? "pwm" : f.some((x) => /I2C|SDA|SCL|MOSI|MISO|SCK|TX|RX/.test(x)) ? `fixed:${ref}` : "gpio";
  };
  const items = ir.logical.nets.flatMap((n) => {
    if (n.role !== "signal") return [];
    const mine = n.pins.filter((p) => p.startsWith(`${board}.`));
    const others = n.pins.filter((p) => !p.startsWith(`${board}.`));
    if (mine.length !== 1 || !others.length) return [];
    const xs = others.map((p) => endpointPosition({ kind: "pin", pin: p }, ir, profiles, holeIndex)?.[0]).filter((x): x is number => x != null);
    const px = endpointPosition({ kind: "pin", pin: mine[0] }, ir, profiles, holeIndex)?.[0];
    if (!xs.length || px == null) return [];
    return [{ net: n.id, pin: mine[0], tx: xs.reduce((a, b) => a + b, 0) / xs.length, px, cls: classOf(mine[0]) }];
  });
  const apply = (remap: Record<string, string>): CircuitIR => ({
    ...ir,
    logical: {
      ...ir.logical,
      nets: ir.logical.nets.map((n) => ({ ...n, pins: n.pins.map((p) => remap[p] ?? p) })),
      firmware_bindings: Object.fromEntries(Object.entries(ir.logical.firmware_bindings).map(([k, v]) => [k, remap[v] ?? v])),
    },
  });
  // 可用的腳：開發板上所有一般 GPIO（不含序列埠、I2C、SPI 這類有特殊用途的腳），沒被別的網路佔用、或本來就是這些網路在用的
  const usedElsewhere = new Set(ir.logical.nets.flatMap((n) => n.pins).filter((p) => p.startsWith(`${board}.`) && !items.some((i) => i.pin === p)));
  const pool = (bprof?.pins ?? []).filter((p) => {
    const f = p.functions ?? [];
    return f.includes("GPIO") && !f.some((x) => /^(TX|RX|I2C|SDA|SCL|MOSI|MISO|SCK|SS)$/.test(x)) && !usedElsewhere.has(`${board}.${p.id}`);
  }).map((p) => ({ ref: `${board}.${p.id}`, f: p.functions ?? [],
    px: endpointPosition({ kind: "pin", pin: `${board}.${p.id}` }, ir, profiles, holeIndex)?.[0] ?? 0 }));
  const need = (cls: string) => (f: string[]) => cls === "adc" ? f.includes("ADC") : cls === "pwm" ? f.includes("PWM") : true;
  // 單調配對（動態規劃）：元件依 x 排序、腳依 x 排序，找一組遞增的對應，每個網路拿到符合功能需求的腳 → 排線不交叉
  const plan = (dir: 1 | -1) => {
    const remap: Record<string, string> = {};
    const fixed = items.filter((i) => i.cls.startsWith("fixed"));
    const nets = items.filter((i) => !i.cls.startsWith("fixed")).sort((a, b) => a.tx - b.tx);
    const pins = pool.filter((p) => !fixed.some((f) => f.pin === p.ref)).sort((a, b) => dir * (a.px - b.px));
    const n = nets.length, m = pins.length;
    // ok[i][j]：第 i 個之後的網路能不能用第 j 根之後的腳排完
    const ok: boolean[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(false));
    for (let j = 0; j <= m; j++) ok[n][j] = true;
    for (let i2 = n - 1; i2 >= 0; i2--) for (let j = m - 1; j >= 0; j--)
      ok[i2][j] = ok[i2][j + 1] || (need(nets[i2].cls)(pins[j].f) && ok[i2 + 1][j + 1]);
    if (!ok[0][0]) return null;
    // 重建：讓腳盡量平均分布（在可行範圍內，挑和元件 x 排名最接近的腳）
    let j = 0;
    for (let i2 = 0; i2 < n; i2++) {
      const ideal = Math.round((i2 + 0.5) * m / n - 0.5);
      let pick = -1;
      for (let k = j; k < m; k++) {
        if (!need(nets[i2].cls)(pins[k].f) || !ok[i2 + 1][k + 1]) continue;
        if (pick < 0 || Math.abs(k - ideal) < Math.abs(pick - ideal)) pick = k;
        if (k > ideal) break;
      }
      if (pick < 0) return null;
      if (nets[i2].pin !== pins[pick].ref) remap[nets[i2].pin] = pins[pick].ref;
      j = pick + 1;
    }
    // 換掉的腳如果是別的網路原本的腳，互換關係已經在 remap 裡；確認不會兩個網路搶同一隻腳
    const targets = Object.values(remap).concat(nets.filter((x) => !remap[x.pin]).map((x) => x.pin));
    return new Set(targets).size === targets.length ? remap : null;
  };
  const budget = opts.budgetMs ?? 1500;
  let best = { ir, remap: {} as Record<string, string>, result: autoWire(ir, profiles, holes, { budgetMs: budget / 3 }) };
  for (const dir of [1, -1] as const) {
    const remap = plan(dir);
    if (!remap || !Object.keys(remap).length) continue;
    const cand = apply(remap);
    const result = autoWire(cand, profiles, holes, { budgetMs: budget / 3 });
    const a = result.score, b = best.result.score;
    if (result.problems.length <= best.result.problems.length && (a.collisions < b.collisions || (a.collisions === b.collisions && a.crossings < b.crossings)))
      best = { ir: cand, remap, result };
  }
  return best;
}

/**
 * 元件位置最佳化（接線規範 §6；模擬退火）。
 * 不改電路，只在麵包板上把元件左右平移幾欄、或兩個元件互換位置，
 * 讓自動接線的成本 J = 規則問題·10⁶ + 碰撞·10⁵ + 俯視交叉·10³ + 總線長 最小。
 * 硬限制：一孔一物、元件本體不重疊、腳不插在別的元件底下（不合法的擺法直接不考慮）。
 * 最後再做一次腳位重新分配。固定種子、時間預算內完成，結果可重現。
 */
export function optimizeLayout(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[],
                               opts: { budgetMs?: number; seed?: number } = {}): { ir: CircuitIR; remap: Record<string, string>; result: AutoWireResult; moved: number } {
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const byRowCol = new Map(holes.filter((h) => h.kind === "main").map((h) => [`${h.row}:${h.column}`, h.id]));
  const board = ir.logical.board.instance_id;
  const movable = ir.physical.placements.filter((p) => p.instance_id !== board && Object.keys(p.pin_to_hole).length > 0
    && Object.values(p.pin_to_hole).every((h) => holeIndex.get(h)?.kind === "main"));
  let seed = opts.seed ?? 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

  const shifted = (pl: CircuitIR["physical"]["placements"][number], dc: number) => {
    const out: Record<string, string> = {};
    for (const [pin, h] of Object.entries(pl.pin_to_hole)) {
      const hole = holeIndex.get(h)!;
      const id = byRowCol.get(`${hole.row}:${(hole.column ?? 0) + dc}`);
      if (!id) return null;
      out[pin] = id;
    }
    return out;
  };
  const minCol = (pl: CircuitIR["physical"]["placements"][number]) => Math.min(...Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)?.column ?? 0));
  const netOf = new Map(ir.logical.nets.flatMap((n) => n.pins.map((p) => [p, n.id] as const)));
  const valid = (cand: CircuitIR) => {
    const pins = cand.physical.placements.flatMap((p) => Object.values(p.pin_to_hole));
    if (new Set(pins).size !== pins.length) return false;
    // 同一個導通群組裡的腳必須屬於同一個網路（或沒接網路），否則板子內部就短路了
    const groupNet = new Map<string, string>();
    for (const pl of cand.physical.placements) for (const [pin, h] of Object.entries(pl.pin_to_hole)) {
      const g = holeIndex.get(h)!.tie_group, n = netOf.get(`${pl.instance_id}.${pin}`) ?? `nc:${pl.instance_id}.${pin}`;
      const prev = groupNet.get(g);
      if (prev && prev !== n) return false;
      groupNet.set(g, n);
    }
    const boxes = bodyBoxes(cand, profiles, holeIndex);
    for (const pl of cand.physical.placements) {
      const own = bodyBoxes({ ...cand, physical: { ...cand.physical, placements: [pl] } }, profiles, holeIndex)[0];
      for (const h of Object.values(pl.pin_to_hole)) {
        const p = holeIndex.get(h)!.position_mm;
        if (boxes.some((b) => b !== undefined && !(own && b.x0 === own.x0 && b.z0 === own.z0) && p[0] > b.x0 && p[0] < b.x1 && p[2] > b.z0 && p[2] < b.z1)) return false;
      }
    }
    // 本體互不重疊（留 0.5mm）
    for (let i = 0; i < boxes.length; i++) for (let k = i + 1; k < boxes.length; k++) {
      const a = boxes[i], b = boxes[k];
      if (a.x0 + 0.5 < b.x1 && b.x0 + 0.5 < a.x1 && a.z0 + 0.5 < b.z1 && b.z0 + 0.5 < a.z1) return false;
    }
    return true;
  };
  const J = (r: AutoWireResult) => r.problems.length * 1e6 + r.score.collisions * 1e5 + r.score.crossings * 1e3 + r.score.length;
  const evalIr = (cand: CircuitIR) => autoWire(cand, profiles, holes, { budgetMs: 0 });

  let cur = ir, curR = evalIr(ir), curJ = J(curR);
  let best = cur, bestJ = curJ;
  const t0 = Date.now(), budget = opts.budgetMs ?? 2500;
  let T = 2000;
  while (movable.length && Date.now() - t0 < budget && bestJ >= 1) {
    const pls = cur.physical.placements;
    const ids = pls.filter((p) => movable.some((m) => m.instance_id === p.instance_id));
    const next = pls.map((p) => ({ ...p, pin_to_hole: { ...p.pin_to_hole } }));
    if (rnd() < 0.7 || ids.length < 2) {
      // 平移一個元件 ±1–3 欄
      const pl = ids[Math.floor(rnd() * ids.length)];
      const dc = (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 3));
      const m = shifted(pl, dc);
      if (!m) continue;
      next.find((p) => p.instance_id === pl.instance_id)!.pin_to_hole = m;
    } else {
      // 兩個元件互換欄位（各自平移到對方的起始欄）
      const a = ids[Math.floor(rnd() * ids.length)], b = ids[Math.floor(rnd() * ids.length)];
      if (a === b) continue;
      const ma = shifted(a, minCol(b) - minCol(a)), mb = shifted(b, minCol(a) - minCol(b));
      if (!ma || !mb) continue;
      next.find((p) => p.instance_id === a.instance_id)!.pin_to_hole = ma;
      next.find((p) => p.instance_id === b.instance_id)!.pin_to_hole = mb;
    }
    const cand: CircuitIR = { ...cur, physical: { ...cur.physical, placements: next } };
    if (!valid(cand)) continue;
    const r = evalIr(cand), j = J(r);
    if (j < curJ || rnd() < Math.exp((curJ - j) / T)) { cur = cand; curR = r; curJ = j; }
    if (j < bestJ) { best = cand; bestJ = j; }
    T *= 0.93;
  }
  const moved = best.physical.placements.filter((p) => JSON.stringify(p.pin_to_hole) !== JSON.stringify(ir.physical.placements.find((q) => q.instance_id === p.instance_id)?.pin_to_hole)).length;
  const opt = optimizePinAssignment(best, profiles, holes, { budgetMs: 900 });
  return { ...opt, moved };
}

/**
 * 板邊模組（OLED 這類：一排排針、板子往一側伸出去）放錯排時，本體會蓋住那幾欄所有的孔，線沒地方插。
 * 接線前先自動把它移到板邊：腳插 J 排（本體往板外，rotation 0）或 A 排（rotation 180），欄位就近找不衝突的。
 * 回傳調整後的電路與被移動的元件。
 */
export function fixEdgeModules(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[]): { ir: CircuitIR; moved: string[] } {
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const byRowCol = new Map(holes.filter((h) => h.kind === "main").map((h) => [`${h.row}:${h.column}`, h.id]));
  const groups = new Map<string, BreadboardHole[]>();
  for (const h of holes) { const g = groups.get(h.tie_group) ?? []; g.push(h); groups.set(h.tie_group, g); }
  const maxCol = Math.max(0, ...holes.filter((h) => h.kind === "main").map((h) => h.column ?? 0));
  const profOf = (cand: CircuitIR, id: string) => {
    const c = cand.logical.components.find((x) => x.id === id);
    return c ? profiles.get(c.profile_id) : undefined;
  };
  // 每隻腳所在的導通群組都還有「沒被腳佔、沒被本體蓋住」的孔
  const allGroupsFree = (cand: CircuitIR) => {
    const used = new Set(cand.physical.placements.flatMap((p) => Object.values(p.pin_to_hole)));
    const boxes = bodyBoxes(cand, profiles, holeIndex);
    const covered = (h: BreadboardHole) => boxes.some((b) => h.position_mm[0] > b.x0 && h.position_mm[0] < b.x1 && h.position_mm[2] > b.z0 && h.position_mm[2] < b.z1);
    for (const pl of cand.physical.placements) for (const hid of Object.values(pl.pin_to_hole)) {
      const h = holeIndex.get(hid); if (!h) return false;
      if (!(groups.get(h.tie_group) ?? []).some((x) => !used.has(x.id) && !covered(x))) return false;
    }
    // 本體不互相重疊
    for (let i = 0; i < boxes.length; i++) for (let k = i + 1; k < boxes.length; k++) {
      const a = boxes[i], b = boxes[k];
      if (a.x0 + 0.5 < b.x1 && b.x0 + 0.5 < a.x1 && a.z0 + 0.5 < b.z1 && b.z0 + 0.5 < a.z1) return false;
    }
    return true;
  };
  let cur = ir; const moved: string[] = [];
  if (allGroupsFree(cur)) return { ir, moved };
  for (const pl of ir.physical.placements) {
    if (pl.instance_id === ir.logical.board.instance_id) continue;
    const prof = profOf(cur, pl.instance_id);
    if (!prof || !isEdgeModule(prof)) continue;
    if (!Object.keys(pl.pin_to_hole).length) continue;   // 板外元件（排線接頭）不在板上，不用挪
    if (!Object.values(pl.pin_to_hole).every((h) => holeIndex.get(h)?.kind === "main")) continue;
    const pins = [...prof.pins].sort((a, b) => a.position_mm[0] - b.position_mm[0]).map((q) => q.id).filter((id) => id in pl.pin_to_hole);
    const step = (a: string, b: string) => Math.round((prof.pins.find((q) => q.id === b)!.position_mm[0] - prof.pins.find((q) => q.id === a)!.position_mm[0]) / 2.54);
    const offs = pins.map((id) => step(pins[0], id));
    const span = Math.max(...offs);
    const c0 = Math.min(...Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)?.column ?? 1));
    const tries: number[] = [0]; for (let k = 1; k <= maxCol; k++) tries.push(k, -k);
    let done = false;
    for (const [row, rot] of [["J", 0], ["A", 180]] as const) {
      for (const dc of tries) {
        const start = c0 + dc;
        if (start < 1 || start + span > maxCol) continue;
        const map: Record<string, string> = {};
        let ok = true;
        pins.forEach((id, i) => {
          const col = rot === 0 ? start + offs[i] : start + span - offs[i];
          const hid = byRowCol.get(`${row}:${col}`);
          if (!hid) ok = false; else map[id] = hid;
        });
        if (!ok) continue;
        const cand: CircuitIR = { ...cur, physical: { ...cur.physical, placements: cur.physical.placements.map((p) => p.instance_id === pl.instance_id ? { ...p, pin_to_hole: map, rotation_deg: rot } : p) } };
        const others = new Set(cand.physical.placements.filter((p) => p.instance_id !== pl.instance_id).flatMap((p) => Object.values(p.pin_to_hole)));
        if (Object.values(map).some((h) => others.has(h))) continue;
        if (allGroupsFree(cand)) { cur = cand; moved.push(pl.instance_id); done = true; break; }
      }
      if (done) break;
    }
  }
  return { ir: cur, moved };
}

/**
 * 板外元件（排線接頭、腳距不是 2.54mm）：不管 AI 寫了什麼孔位，一律拔出麵包板、
 * 擺在麵包板左邊由前往後排開，導線從它排線末端的杜邦頭接過去。
 */
export function placeOffBoard(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[],
                              external: (p: ComponentProfile) => boolean): { ir: CircuitIR; placed: string[] } {
  const ids = ir.logical.components.filter((c) => { const p = profiles.get(c.profile_id); return p && external(p); });
  if (!ids.length) return { ir, placed: [] };
  const x0 = Math.min(...holes.map((h) => h.position_mm[0])) - 14;
  let z = Math.max(...holes.map((h) => h.position_mm[2])) + 4;   // 從板子前緣往後排
  const placed: string[] = [];
  const pls = ir.physical.placements.filter((p) => !ids.some((c) => c.id === p.instance_id));
  for (const c of ids) {
    const [w, , d] = profiles.get(c.profile_id)!.geometry.bbox_mm;
    z -= d;
    pls.push({ instance_id: c.id, position_mm: [+(x0 - w).toFixed(2), 0, +z.toFixed(2)], rotation_deg: 0, pin_to_hole: {} });
    z -= 6;
    placed.push(profiles.get(c.profile_id)!.display_name);
  }
  return { ir: { ...ir, physical: { ...ir.physical, placements: pls } }, placed };
}
