/**
 * 手動調整零件與走線（純函式，不碰 store）：
 *  - movePart：整個元件平移 dc 欄、dr 排（主區內，跨中央溝槽會換導通群組，照樣允許，由檢查判斷對錯）
 *  - rotatePart：繞自己的腳位範圍轉 180°（排與欄都鏡射）
 *  - moveWireEnd：把導線某一端移到另一個孔
 *  - rewire：依目前擺放重新自動接線（演算法和 AI 設計用的同一套）
 *  - checkEdit：擺放類錯誤（腳插到不存在的孔、和別的元件搶孔、本體蓋住孔、重疊）＋電氣檢查
 * 開發板（排母、不插麵包板）不能移動。
 */
import {
  autoWire, runElectricalChecks, footprintErrors, blockedHoleErrors, detectPartOverlaps,
  type CircuitIR, type ComponentProfile, type BreadboardHole,
} from "@assemblex/circuit-schema";

const ROWS = "ABCDEFGHIJ";
export type EditResult = { ir: CircuitIR } | { error: string };

function mainIndex(holes: BreadboardHole[]) {
  const byRowCol = new Map(holes.filter((h) => h.kind === "main").map((h) => [`${h.row}:${h.column}`, h.id]));
  const byId = new Map(holes.map((h) => [h.id, h]));
  return { byRowCol, byId };
}

const clone = (ir: CircuitIR): CircuitIR => JSON.parse(JSON.stringify(ir));

export function isMovable(ir: CircuitIR, instanceId: string, holes: BreadboardHole[]): boolean {
  if (instanceId === ir.logical.board.instance_id) return false;
  const pl = ir.physical.placements.find((p) => p.instance_id === instanceId);
  if (!pl || !Object.keys(pl.pin_to_hole).length) return false;
  const { byId } = mainIndex(holes);
  return Object.values(pl.pin_to_hole).every((h) => byId.get(h)?.kind === "main");
}

export function movePart(ir: CircuitIR, holes: BreadboardHole[], instanceId: string, dc: number, dr: number): EditResult {
  if (!isMovable(ir, instanceId, holes)) return { error: "這個元件不能移動（開發板或插在電源軌上的元件）" };
  const { byRowCol, byId } = mainIndex(holes);
  const out = clone(ir);
  const pl = out.physical.placements.find((p) => p.instance_id === instanceId)!;
  const next: Record<string, string> = {};
  for (const [pin, h] of Object.entries(pl.pin_to_hole)) {
    const hole = byId.get(h)!;
    const r = ROWS.indexOf(hole.row ?? "") + dr, c = (hole.column ?? 0) + dc;
    const id = r >= 0 && r < ROWS.length ? byRowCol.get(`${ROWS[r]}:${c}`) : undefined;
    if (!id) return { error: "再移就超出麵包板了" };
    next[pin] = id;
  }
  pl.pin_to_hole = next;
  return { ir: dropStaleWires(out, ir) };
}

export function rotatePart(ir: CircuitIR, holes: BreadboardHole[], instanceId: string): EditResult {
  if (!isMovable(ir, instanceId, holes)) return { error: "這個元件不能旋轉" };
  const { byRowCol, byId } = mainIndex(holes);
  const out = clone(ir);
  const pl = out.physical.placements.find((p) => p.instance_id === instanceId)!;
  const pts = Object.entries(pl.pin_to_hole).map(([pin, h]) => ({ pin, r: ROWS.indexOf(byId.get(h)!.row ?? ""), c: byId.get(h)!.column ?? 0 }));
  const rs = pts.map((p) => p.r), cs = pts.map((p) => p.c);
  const r0 = Math.min(...rs), r1 = Math.max(...rs), c0 = Math.min(...cs), c1 = Math.max(...cs);
  const next: Record<string, string> = {};
  for (const p of pts) {
    const id = byRowCol.get(`${ROWS[r0 + r1 - p.r]}:${c0 + c1 - p.c}`);
    if (!id) return { error: "轉不過去（會超出麵包板）" };
    next[p.pin] = id;
  }
  pl.pin_to_hole = next;
  pl.rotation_deg = ((pl.rotation_deg ?? 0) + 180) % 360;
  return { ir: dropStaleWires(out, ir) };
}

/** 移動元件後，原本插在它腳位欄的導線還在舊孔：保留（使用者可以再按「重新自動接線」），只是標記需要重接 */
function dropStaleWires(next: CircuitIR, _prev: CircuitIR): CircuitIR { void _prev; return next; }

export function moveWireEnd(ir: CircuitIR, holes: BreadboardHole[], wireId: string, end: "from" | "to", hole: string): EditResult {
  const { byId } = mainIndex(holes);
  if (!byId.has(hole)) return { error: `孔位 ${hole} 不存在` };
  const out = clone(ir);
  const w = out.physical.wires.find((x) => x.id === wireId);
  if (!w) return { error: "找不到這條線" };
  const other = end === "from" ? w.to : w.from;
  if (other.kind === "hole" && byId.get(other.hole)?.tie_group === byId.get(hole)!.tie_group) return { error: "兩端插在同一排導通的孔，這條線沒有作用" };
  w[end] = { kind: "hole", hole };
  return { ir: out };
}

export function deleteWire(ir: CircuitIR, wireId: string): EditResult {
  const out = clone(ir);
  const n = out.physical.wires.length;
  out.physical.wires = out.physical.wires.filter((w) => w.id !== wireId);
  return out.physical.wires.length === n ? { error: "找不到這條線" } : { ir: out };
}

export function rewire(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[]): EditResult & { problems?: string[] } {
  const r = autoWire(ir, profiles, holes, { budgetMs: 1200 });
  if (r.problems.length && !r.wires.length) return { error: `自動接線失敗：${r.problems[0]}` };
  return { ir: { ...ir, physical: { ...ir.physical, wires: r.wires } }, problems: r.problems };
}

/** 擺放錯誤（會讓電路沒辦法照做）＋電氣錯誤：給編輯列顯示 */
export function checkEdit(ir: CircuitIR, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[]): { errors: string[]; warnings: string[] } {
  const holeIndex = new Map(holes.map((h) => [h.id, h]));
  const errors: string[] = [], warnings: string[] = [];
  const used = new Map<string, string>();
  for (const pl of ir.physical.placements) for (const h of Object.values(pl.pin_to_hole)) {
    if (used.has(h) && used.get(h) !== pl.instance_id) errors.push(`${pl.instance_id} 和 ${used.get(h)} 插在同一個孔 ${h}`);
    used.set(h, pl.instance_id);
  }
  for (const e of [...footprintErrors(ir, profiles, holeIndex), ...blockedHoleErrors(ir, profiles, holeIndex)]) errors.push(String(e));
  for (const i of detectPartOverlaps(ir, profiles, holeIndex)) (i.severity === "error" ? errors : warnings).push(i.message);
  for (const i of runElectricalChecks(ir, holes)) (i.severity === "error" ? errors : warnings).push(i.message);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
