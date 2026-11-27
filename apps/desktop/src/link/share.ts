/**
 * 內網分享給手機 AR 端（協定：docs/LAN_PROTOCOL.md）。
 * 專案一變就把整份「手機看得懂」的資料推給 Tauri 端的 HTTP 伺服器；手機輪詢 /info 的 revision 決定要不要重抓。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { assemblySteps, holeLabel, holeShort, routeWires, endpointPosition, type CircuitIR, type ComponentProfile, type BreadboardHole } from "@assemblex/circuit-schema";
import { boardOf } from "../data/boards";
import { bbSpecOf } from "../stores/projectStore";
import { getModel } from "../engine3d/datasheetShape";

export interface LanAddress { url: string; ip: string; port: number; token: string; ok: boolean }

/** 給人看的腳位名稱（和組裝步驟同一套）：anode → 正極、2 → 腳2、GND2 → GND */
function pinName(pin: string): string {
  if (pin === "+" || pin === "anode") return "正極";
  if (pin === "-" || pin === "cathode") return "負極";
  if (/^\d+$/.test(pin)) return `腳${pin}`;
  return pin.replace(/^GND\d+$/, "GND");
}

function pinText(ref: string, ir: CircuitIR, profiles: Map<string, ComponentProfile>): string {
  const [inst, pin] = ref.split(".");
  if (inst === ir.logical.board.instance_id) return `${boardOf(ir.logical.board.profile_id).short} ${pin.replace(/^GND\d+$/, "GND")}`;
  const c = ir.logical.components.find((x) => x.id === inst);
  return `${(c ? profiles.get(c.profile_id)?.display_name : null) ?? inst.toUpperCase()} ${pin}`;
}

export function buildSharePayload(ir: CircuitIR, profiles: Map<string, ComponentProfile>,
                                  holeIndex: Map<string, BreadboardHole>, title: string) {
  const steps = assemblySteps(ir, profiles);
  const used = new Set<string>();
  const board = ir.logical.board;
  const boardPl = ir.physical.placements.find((p) => p.instance_id === board.instance_id);
  // 和桌面 3D（Parts.tsx）同一套算法：插麵包板的元件，原點＝第一隻腳插的孔減去那隻腳在元件座標裡的位置（依旋轉轉過）
  const poseOf = (id: string) => {
    const pl = ir.physical.placements.find((x) => x.instance_id === id);
    if (!pl) return undefined;
    const prof = profiles.get(id === board.instance_id ? board.profile_id : ir.logical.components.find((c) => c.id === id)?.profile_id ?? "");
    const [firstPin, firstHole] = Object.entries(pl.pin_to_hole)[0] ?? [];
    const anchor = firstHole ? holeIndex.get(firstHole) : undefined;
    const fp = prof?.pins.find((q) => q.id === firstPin)?.position_mm ?? [0, 0, 0];
    const ry = (pl.rotation_deg * Math.PI) / 180;
    const pos = anchor
      ? [anchor.position_mm[0] - (fp[0] * Math.cos(ry) + fp[2] * Math.sin(ry)), anchor.position_mm[1] - fp[1],
         anchor.position_mm[2] - (-fp[0] * Math.sin(ry) + fp[2] * Math.cos(ry))]
      : pl.position_mm;
    return { position: pos.map((v) => +v.toFixed(3)), rotationDeg: pl.rotation_deg };
  };
  const modelOf = (pid?: string) => {
    const m = pid ? profiles.get(pid)?.geometry.desktop_model : undefined;
    return m ? m.replace(/^models\//, "").replace(/\.glb$/, "") : undefined;
  };
  const parts = ir.physical.placements.filter((p) => p.instance_id !== board.instance_id).map((p) => {
    const c = ir.logical.components.find((x) => x.id === p.instance_id);
    const prof = c ? profiles.get(c.profile_id) : undefined;
    const tag = steps.find((s) => s.targetId === p.instance_id)?.tag ?? p.instance_id.toUpperCase();
    return {
      id: p.instance_id, tag, name: prof?.display_name ?? p.instance_id,
      // 手機 AR 擺 3D 模型用：型號、模型檔、在麵包板座標（mm）裡的原點與繞 Y 軸角度
      profileId: c?.profile_id, model: modelOf(c?.profile_id), poseMm: poseOf(p.instance_id),
      bboxMm: prof?.geometry.bbox_mm, color: prof?.geometry.placeholder?.color,
      // 從規格書圖面生成的 3D（基本形狀；座標原點＝元件底面中心、mm）。iOS 端還沒有畫，先帶著
      modelParts: c?.profile_id.startsWith("user_") ? getModel(c.profile_id) : undefined,
      pins: Object.entries(p.pin_to_hole).map(([pin, hole]) => { used.add(hole); return { pin, label: pinName(pin), hole }; }),
      // 板外元件：不插麵包板，poseMm 是它在麵包板旁的位置（bbox 角落為原點，和桌面一致）
      offBoard: Object.keys(p.pin_to_hole).length === 0,
    };
  });
  const r3 = (v: number[]) => v.map((x) => +x.toFixed(2));
  // 腳位端點也帶上座標（mm，麵包板座標）：板外元件（LD06 這類排線接頭）的線頭在它排線末端的杜邦頭，手機不必自己猜
  const end = (e: CircuitIR["physical"]["wires"][number]["from"]) => {
    if (e.kind === "hole") { used.add(e.hole); return { hole: e.hole }; }
    const p = endpointPosition(e, ir, profiles, holeIndex);
    return { pin: e.pin, label: pinText(e.pin, ir, profiles), ...(p ? { posMm: r3(p) } : {}) };
  };
  // 和桌面 3D 同一套佈線結果：手機直接照這條折線畫，板外的線才會真的接到外接元件
  let routes = new Map<string, number[][]>();
  try { routes = routeWires(ir, profiles, [...holeIndex.values()]) as Map<string, number[][]>; } catch { /* 佈線失敗時手機用自己的畫法 */ }
  const wires = ir.physical.wires.map((w) => {
    const net = ir.logical.nets.find((n) => n.id === w.net_id);
    const path = routes.get(w.id);
    return { id: w.id, color: w.color, role: net?.role ?? "signal", net: w.net_id, from: end(w.from), to: end(w.to),
             ...(path ? { pathMm: path.map(r3) } : {}) };
  });
  steps.forEach((s) => s.holes.forEach((h) => used.add(h)));
  const holes: Record<string, [number, number]> = {};
  // 全部孔位都送：手機用已知孔距（mm）和偵測到的孔做 PnP，算出麵包板在空間中的姿態，3D 模型才擺得上去
  for (const [id, h] of holeIndex) holes[id] = [+h.position_mm[0].toFixed(2), +h.position_mm[2].toFixed(2)];
  const columns = Math.max(0, ...[...holeIndex.values()].filter((h) => h.kind !== "rail").map((h) => Number(/\d+$/.exec(h.id)?.[0] ?? 0)));
  // 每個用到的孔給人看的名稱（電源軌用「A 側＋軌（第 30 欄旁）」），手機卡片與疊圖直接用這個字串，三端說法一致
  const bbId = ir.physical.breadboard?.profile_id ?? "breadboard_830";
  const holeLabels: Record<string, string> = {};
  // 主區孔也給名稱（「麵包板 D 排 8 欄」），手機上不會和 Arduino 的 D8 腳搞混
  for (const h of used) holeLabels[h] = /^[A-J]\d+$/.test(h) ? `麵包板 ${holeShort(h, bbId)}` : holeLabel(h, bbId);
  return {
    v: 1, title, holeLabels, projectId: ir.project_id, revision: ir.revision,
    board: { profileId: board.profile_id, name: boardOf(board.profile_id).name, onBreadboard: !!boardPl && Object.keys(boardPl.pin_to_hole).length > 0,
             model: modelOf(board.profile_id), poseMm: poseOf(board.instance_id) },
    breadboard: { profileId: ir.physical.breadboard?.profile_id ?? "breadboard_830", columns,
                  sizeMm: bbSpecOf(ir.physical.breadboard?.profile_id).size_mm, rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"], pitchMm: 2.54 },
    parts, wires,
    // 接線步驟給人看的編號（線 1、線 2…），手機步驟卡用它，不顯示內部 id
    steps: steps.map((s) => ({ index: s.index, kind: s.kind, targetId: s.targetId,
                              tag: s.tag ?? (s.kind === "wire" ? `線 ${steps.filter((x) => x.kind === "wire" && x.index <= s.index).length}` : undefined),
                              title: s.title, detail: s.detail, holes: s.holes })),
    holes,
  };
}

export async function publishToLan(payload: ReturnType<typeof buildSharePayload>) {
  if (!isTauri()) return;
  await invoke("lan_publish", { project: JSON.stringify(payload), title: payload.title, projectId: payload.projectId }).catch(() => {});
}

export async function lanAddress(): Promise<LanAddress | null> {
  if (!isTauri()) return null;
  return invoke<LanAddress>("lan_address").catch(() => null);
}

/** 組裝進度（協定 v1.1）：手機與桌面共用一份，seq 變了且不是自己寫的才套用 */
export interface LanProgress { projectId: string; step: number | null; done: number[]; from: "phone" | "desktop"; seq: number }

export async function lanSetProgress(projectId: string, step: number | null, done: number[]) {
  if (!isTauri()) return 0;
  // step 為 null（桌面沒在組裝模式）就不送這個欄位，舊版手機也解析得了
  return invoke<number>("lan_set_progress", { progress: step == null ? { projectId, done } : { projectId, step, done } }).catch(() => 0);
}
export async function lanProgress(): Promise<LanProgress | null> {
  if (!isTauri()) return null;
  return invoke<LanProgress | null>("lan_progress").catch(() => null);
}
