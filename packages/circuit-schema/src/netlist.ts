import type { CircuitIR } from "./circuit-ir.js";
import { parsePinRef, endpointKey } from "./circuit-ir.js";
import type { BreadboardHole } from "./breadboard.js";
import type { ComponentProfile } from "./component-profile.js";

/** Union-Find（Disjoint Set Union），管理所有插孔與導線的電氣連通性。 */
export class DisjointSet {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); }
  }
  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // 路徑壓縮
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const [x, y] = (this.rank.get(ra)! < this.rank.get(rb)!) ? [rb, ra] : [ra, rb];
    this.parent.set(y, x);
    if (this.rank.get(x) === this.rank.get(y)) this.rank.set(x, this.rank.get(x)! + 1);
  }
  connected(a: string, b: string): boolean { return this.find(a) === this.find(b); }
  /** 回傳所有等價類。 */
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      const bucket = out.get(r);
      if (bucket) bucket.push(k); else out.set(r, [k]);
    }
    return out;
  }
}

export interface PhysicalNet {
  /** 這一團裡面所有的腳位（PinRef）。 */
  pins: string[];
  /** 這一團佔到的孔位。 */
  holes: string[];
}

/**
 * 從實體佈局推出真正的電氣連通關係。
 * 三種導通來源：① 板子內部的 tie group ② 杜邦線 ③ 元件自己把兩個孔接起來（例如電阻跨兩欄）
 */
export function resolvePhysicalNets(
  ir: CircuitIR,
  holes: BreadboardHole[],
): PhysicalNet[] {
  const dsu = new DisjointSet();

  // ① 板子內部：同一 tie group 的孔互通
  for (const h of holes) dsu.union(`hole:${h.id}`, `tie:${h.tie_group}`);

  // ② 杜邦線：兩端互通（端點可能是孔，也可能直接是元件腳位）
  for (const w of ir.physical.wires) {
    dsu.union(endpointKey(w.from), endpointKey(w.to));
  }

  // ③ 元件腳位插進孔裡
  const pinHoles = new Map<string, string>();
  for (const p of ir.physical.placements) {
    for (const [pinId, holeId] of Object.entries(p.pin_to_hole)) {
      const ref = `${p.instance_id}.${pinId}`;
      pinHoles.set(ref, holeId);
      dsu.union(`pin:${ref}`, `hole:${holeId}`);
    }
  }

  const nets: PhysicalNet[] = [];
  for (const members of dsu.groups().values()) {
    const pins = members.filter((m) => m.startsWith("pin:")).map((m) => m.slice(4));
    const hs = members.filter((m) => m.startsWith("hole:")).map((m) => m.slice(5));
    if (pins.length > 0) nets.push({ pins: pins.sort(), holes: hs.sort() });
  }
  return nets;
}

export type IssueKind =
  | "missing_connection"    // 設計上該通，實體上沒通
  | "unintended_connection" // 實體上通了，設計上不該通
  | "power_ground_short"    // 電源直接接到地
  | "floating_pin"          // 設計有用到，但實體沒插
  | "pin_not_found"
  | "hole_conflict"
  | "isolated_part"         // 元件插上去了，但沒有任何腳接到網路
  | "part_overlap"          // 兩個有高度的元件本體在麵包板上重疊
  | "gpio_overcurrent";      // 腳位直驅的元件電流超過開發板建議值（提醒，不擋）         // 同一個孔塞了兩樣東西（兩條線、或線和元件腳）

export interface ElectricalIssue {
  kind: IssueKind;
  severity: "error" | "warning";
  message: string;
  pins?: string[];
  net_id?: string;
}

/**
 * 把實體連通性和 CircuitIR 的邏輯 Netlist 對照。
 * 這是「插錯一排」「意外短路」真正被抓出來的地方 —— 看到一條黃線不代表接對了。
 */
export function validateAgainstLogical(
  ir: CircuitIR,
  holes: BreadboardHole[],
): ElectricalIssue[] {
  const issues: ElectricalIssue[] = [];
  const physical = resolvePhysicalNets(ir, holes);

  // 每個腳位屬於哪一團實體 net
  const netOfPin = new Map<string, number>();
  physical.forEach((n, i) => n.pins.forEach((p) => netOfPin.set(p, i)));

  // 設計上有接、但實體沒插的腳位
  for (const net of ir.logical.nets) {
    for (const ref of net.pins) {
      if (!netOfPin.has(ref)) {
        issues.push({
          kind: "floating_pin", severity: "error", net_id: net.id, pins: [ref],
          message: `${ref} 在設計的 ${net.id} 裡，但實體上沒有插進任何孔位。`,
        });
      }
    }
  }

  // 設計上同一 net 的腳位，實體上必須落在同一團
  for (const net of ir.logical.nets) {
    const present = net.pins.filter((p) => netOfPin.has(p));
    if (present.length < 2) continue;
    const first = netOfPin.get(present[0])!;
    const stray = present.filter((p) => netOfPin.get(p) !== first);
    if (stray.length > 0) {
      issues.push({
        kind: "missing_connection", severity: "error", net_id: net.id,
        pins: [present[0], ...stray],
        message: `${net.id} 應該連通，但 ${stray.join("、")} 和 ${present[0]} 實體上沒接在一起。`,
      });
    }
  }

  // 實體上連在一起、設計上卻分屬不同 net ＝ 意外短路
  const logicalNetOfPin = new Map<string, string>();
  for (const net of ir.logical.nets) for (const p of net.pins) logicalNetOfPin.set(p, net.id);
  const roleOf = new Map(ir.logical.nets.map((n) => [n.id, n.role]));

  for (const pn of physical) {
    const ids = [...new Set(pn.pins.map((p) => logicalNetOfPin.get(p)).filter(Boolean))] as string[];
    if (ids.length > 1) {
      const roles = new Set(ids.map((id) => roleOf.get(id)));
      const isPowerShort = roles.has("power") && roles.has("ground");
      issues.push({
        kind: isPowerShort ? "power_ground_short" : "unintended_connection",
        severity: "error",
        pins: pn.pins,
        message: isPowerShort
          ? `電源與 GND 被短路：${ids.join("、")} 透過 ${pn.holes.slice(0, 4).join("、")} 連在一起。`
          : `${ids.join("、")} 不該相連，但實體上透過同一組孔位連通了。`,
      });
    }
  }

  return issues;
}

/** 同一顆 IC 的兩個腳位被插進同一組孔 → 短接。 */
export function detectSelfShorts(ir: CircuitIR): ElectricalIssue[] {
  const out: ElectricalIssue[] = [];
  for (const p of ir.physical.placements) {
    const byHole = new Map<string, string[]>();
    for (const [pinId, holeId] of Object.entries(p.pin_to_hole)) {
      byHole.set(holeId, [...(byHole.get(holeId) ?? []), pinId]);
    }
    for (const [holeId, pins] of byHole) {
      if (pins.length > 1) {
        out.push({
          kind: "unintended_connection", severity: "error",
          pins: pins.map((x) => `${p.instance_id}.${x}`),
          message: `${p.instance_id} 的 ${pins.join("、")} 被插進同一個孔 ${holeId}，等於短接。`,
        });
      }
    }
  }
  return out;
}

/** 便利函式：一次跑完所有電氣檢查。 */
/**
 * 一個麵包板孔只插得進一隻腳或一條線的公頭。
 * 電氣上兩樣東西塞同一孔是「通的」，Union-Find 抓不到，但實際上插不進去。
 */
export function detectHoleConflicts(ir: CircuitIR): ElectricalIssue[] {
  const users = new Map<string, string[]>();
  const use = (hole: string, who: string) => users.set(hole, [...(users.get(hole) ?? []), who]);
  for (const p of ir.physical.placements)
    for (const [pin, hole] of Object.entries(p.pin_to_hole)) use(hole, `${p.instance_id}.${pin}`);
  for (const w of ir.physical.wires)
    for (const e of [w.from, w.to]) if (e.kind === "hole") use(e.hole, w.id);
  const issues: ElectricalIssue[] = [];
  for (const [hole, who] of users) {
    if (who.length > 1) issues.push({
      kind: "hole_conflict", severity: "error", pins: who,
      message: `孔 ${hole} 同時插了 ${who.join("、")}，一個孔只能插一樣東西`,
    });
  }
  return issues;
}

export function runElectricalChecks(ir: CircuitIR, holes: BreadboardHole[]): ElectricalIssue[] {
  return [...validateAgainstLogical(ir, holes), ...detectSelfShorts(ir), ...detectHoleConflicts(ir)];
}

export { parsePinRef };

/** 元件腳位插的孔，相對位置要和 profile 的腳位座標一致，否則 3D 會畫出腳插錯孔的元件。 */
export function footprintErrors(ir: CircuitIR, profiles: Map<string, ComponentProfile>,
                         holeIndex: Map<string, BreadboardHole>): string[] {
  const errs: string[] = [];
  for (const pl of ir.physical.placements) {
    const entries = Object.entries(pl.pin_to_hole);
    if (entries.length < 2) continue;
    const comp = ir.logical.components.find((c) => c.id === pl.instance_id);
    const prof = comp && profiles.get(comp.profile_id);
    if (!prof) continue;
    const a = (pl.rotation_deg * Math.PI) / 180;
    const [p0, h0] = entries[0];
    const pin0 = prof.pins.find((p) => p.id === p0);
    const hole0 = holeIndex.get(h0);
    if (!pin0 || !hole0) continue;
    for (const [pid, hid] of entries.slice(1)) {
      const pin = prof.pins.find((p) => p.id === pid);
      const hole = holeIndex.get(hid);
      if (!pin || !hole) { errs.push(`${pl.instance_id}: 腳位 ${pid} 或孔 ${hid} 不存在`); continue; }
      const dx = pin.position_mm[0] - pin0.position_mm[0], dz = pin.position_mm[2] - pin0.position_mm[2];
      const ex = dx * Math.cos(a) + dz * Math.sin(a), ez = -dx * Math.sin(a) + dz * Math.cos(a);
      const hx = hole.position_mm[0] - hole0.position_mm[0], hz = hole.position_mm[2] - hole0.position_mm[2];
      if (Math.hypot(hx - ex, hz - ez) > 1.2) {
        errs.push(`${pl.instance_id}: ${p0}→${h0} 時 ${pid} 應該離它 (${ex.toFixed(2)}, ${ez.toFixed(2)}) mm，但 ${hid} 在 (${hx.toFixed(2)}, ${hz.toFixed(2)}) mm`);
      }
    }
  }
  return errs;
}


/**
 * 被元件本體蓋住的孔，杜邦線插不進去（之前的範例就有線插在按鈕正下方的 B8）。
 * 用 profile 的 bbox 投影到板面判斷，內縮 0.8mm 容忍模型和 bbox 的小誤差；元件自己的腳不算。
 */

/**
 * 從規格書新增的模組（user_*、沒有 CAD 模型）：本體是架在排針上的 PCB，從腳位那一排往元件的 +z 延伸 d（3D 外形 datasheetShape 同一個幾何）。
 * 旋轉 180° 時往 −z 延伸，可以把腳插在 A 排、讓本體伸出板外，和實際把模組插在板邊的用法一樣。
 * 其他元件維持「以腳位中心為中心」。
 */
/**
 * 「排針在板邊、板子往一側伸出去」的模組：規格書匯入的模組，以及內建的單排排針模組（OLED 這類，
 * 一排腳、板子很深）。這種元件的本體不是以腳為中心，而是從腳那一排往元件 +z 延伸。
 */
export function isEdgeModule(prof: ComponentProfile): boolean {
  if (prof.component_id.startsWith("user_") && !prof.geometry.desktop_model) return true;
  const zs = prof.pins.map((q) => q.position_mm[2]);
  const oneRow = prof.pins.length >= 3 && zs.every((z) => Math.abs(z - zs[0]) < 0.3);
  return oneRow && prof.geometry.bbox_mm[2] >= 12;
}

/**
 * 腳距不是 2.54mm 的倍數（例如 LD06 的 ZH1.5 排線接頭）：插不進麵包板，要放在板外、用排線轉杜邦線接過來。
 */
export function offGridPins(prof: ComponentProfile): boolean {
  if (prof.pins.length < 2) return false;
  const p0 = prof.pins[0].position_mm;
  return prof.pins.some((q) => [0, 2].some((k) => {
    const d = Math.abs(q.position_mm[k] - p0[k]) / 2.54;
    return Math.abs(d - Math.round(d)) * 2.54 > 0.3;
  }));
}

export function moduleRect(pl: { rotation_deg: number; pin_to_hole: Record<string, string> }, prof: ComponentProfile,
                    holeIndex: Map<string, BreadboardHole>, inset = 0): { x0: number; x1: number; z0: number; z1: number } | null {
  if (!isEdgeModule(prof)) return null;
  const pts = Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)?.position_mm).filter((p): p is [number, number, number] => !!p);
  if (!pts.length) return null;
  const [w, , d] = prof.geometry.bbox_mm;
  const r = ((Math.round(pl.rotation_deg / 90) % 4) + 4) % 4;   // 0:+z 1:+x 2:-z 3:-x（rotation_deg 逆時針）
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  let rect;
  if (r === 0) rect = { x0: cx - w / 2, x1: cx + w / 2, z0: Math.min(...zs) - 1.8, z1: Math.min(...zs) - 1.8 + d };
  else if (r === 2) rect = { x0: cx - w / 2, x1: cx + w / 2, z0: Math.max(...zs) + 1.8 - d, z1: Math.max(...zs) + 1.8 };
  else if (r === 1) rect = { x0: Math.min(...xs) - 1.8, x1: Math.min(...xs) - 1.8 + d, z0: cz - w / 2, z1: cz + w / 2 };
  else rect = { x0: Math.max(...xs) + 1.8 - d, x1: Math.max(...xs) + 1.8, z0: cz - w / 2, z1: cz + w / 2 };
  return { x0: rect.x0 + inset, x1: rect.x1 - inset, z0: rect.z0 + inset, z1: rect.z1 - inset };
}

export function blockedHoleErrors(ir: CircuitIR, profiles: Map<string, ComponentProfile>,
                                  holeIndex: Map<string, BreadboardHole>): string[] {
  const errs: string[] = [];
  // 本體以腳位中心為中心（元件模型都是這樣擺的），bbox 依旋轉角換軸
  const boxes = ir.physical.placements.flatMap((pl) => {
    const hs = Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)).filter((h): h is BreadboardHole => !!h);
    const comp = ir.logical.components.find((c) => c.id === pl.instance_id);
    const prof = comp && profiles.get(comp.profile_id);
    if (!hs.length || !prof) return [];
    const mod = moduleRect(pl, prof, holeIndex, 0.8);
    if (mod) return [{ id: pl.instance_id, ...mod }];
    const cx = hs.reduce((s, h) => s + h.position_mm[0], 0) / hs.length;
    const cz = hs.reduce((s, h) => s + h.position_mm[2], 0) / hs.length;
    const [w, , d] = prof.geometry.bbox_mm;
    const swap = Math.round(pl.rotation_deg / 90) % 2 !== 0;
    const hw = (swap ? d : w) / 2 - 0.8, hd = (swap ? w : d) / 2 - 0.8;
    return [{ id: pl.instance_id, x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd }];
  });
  for (const w of ir.physical.wires) {
    for (const e of [w.from, w.to]) {
      if (e.kind !== "hole") continue;
      const h = holeIndex.get(e.hole);
      if (!h) continue;
      const [x, , z] = h.position_mm;
      for (const b of boxes) {
        if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) {
          errs.push(`${w.id} 插在 ${e.hole}，但這個孔被 ${b.id} 的本體蓋住，插不進去`);
        }
      }
    }
  }
  // 元件的腳也不能插在別的元件底下（兩個元件疊在一起）
  for (const pl of ir.physical.placements) {
    for (const hole of Object.values(pl.pin_to_hole)) {
      const h = holeIndex.get(hole);
      if (!h) continue;
      const [x, , z] = h.position_mm;
      for (const b of boxes) {
        if (b.id !== pl.instance_id && x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) {
          errs.push(`${pl.instance_id} 的腳插在 ${hole}，但這個位置被 ${b.id} 的本體蓋住`);
        }
      }
    }
  }
  return errs;
}

/**
 * 開發板腳位直接驅動的元件，電流超過開發板的建議值就提醒（不是錯誤：還在絕對上限內也能動，
 * 但長時間會讓晶片發熱、影響壽命）。介面上同一頁寫「GPIO 建議 20 mA」，驗證卻全綠，就是在說謊。
 */
export function detectGpioOvercurrent(ir: CircuitIR, profiles: Map<string, ComponentProfile>): ElectricalIssue[] {
  const board = profiles.get(ir.logical.board.profile_id);
  const limit = board?.electrical.recommended_gpio_current_ma;
  if (!limit) return [];
  const out: ElectricalIssue[] = [];
  for (const n of ir.logical.nets) {
    if (n.role !== "signal") continue;
    const gpio = n.pins.find((p) => p.startsWith(`${ir.logical.board.instance_id}.`));
    if (!gpio) continue;
    for (const ref of n.pins) {
      const inst = ref.split(".")[0];
      const comp = ir.logical.components.find((c) => c.id === inst);
      const ma = comp && profiles.get(comp.profile_id)?.electrical.recommended_gpio_current_ma;
      if (ma && ma > limit) out.push({
        kind: "gpio_overcurrent", severity: "warning", net_id: n.id, pins: [gpio, ref],
        message: `${gpio.split(".")[1]} 直接驅動 ${inst.toUpperCase()}，約 ${ma} mA，超過開發板建議的 ${limit} mA（建議加電晶體驅動）`,
      });
    }
  }
  return out;
}


/** 元件插了但完全沒接線（NC 腳不算）。電源／地腳都沒接時升級成錯誤：插上去也不會動。 */
export function detectIsolatedParts(ir: CircuitIR, profiles: Map<string, ComponentProfile>): ElectricalIssue[] {
  const out: ElectricalIssue[] = [];
  const wired = new Set(ir.logical.nets.flatMap((n) => n.pins));
  for (const c of ir.logical.components) {
    const prof = profiles.get(c.profile_id);
    if (!prof) continue;
    const pins = prof.pins.filter((p) => p.id !== "NC");
    if (!pins.length || pins.some((p) => wired.has(`${c.id}.${p.id}`))) continue;
    const powered = pins.some((p) => /^(VCC|VDD|GND|5V|3V3|\+|-)$/i.test(p.id));
    out.push({ kind: "isolated_part", severity: powered ? "error" : "warning", pins: pins.map((p) => `${c.id}.${p.id}`),
               message: `${c.id.toUpperCase()}（${prof.display_name}）插上去了，但沒有任何腳接線` });
  }
  return out;
}

/**
 * 本體重疊：高度 ≥ 5mm 的元件（感測器、蜂鳴器、模組、開發板）在麵包板平面上的外框兩兩相交。
 * 外框以腳位中心為中心、尺寸取 bbox 與腳距較大者（和佈線避障同一套），容差 0.5mm。
 */
export function detectPartOverlaps(ir: CircuitIR, profiles: Map<string, ComponentProfile>,
                                   holeIndex: Map<string, BreadboardHole>): ElectricalIssue[] {
  type Rect = { id: string; x0: number; x1: number; z0: number; z1: number };
  const rects: Rect[] = [];
  const all = [{ id: ir.logical.board.instance_id, profile_id: ir.logical.board.profile_id }, ...ir.logical.components];
  for (const c of all) {
    const prof = profiles.get(c.profile_id);
    const pl = ir.physical.placements.find((p) => p.instance_id === c.id);
    if (!prof || !pl) continue;
    const [bw, bh, bd] = prof.geometry.bbox_mm;
    if (bh < 5) continue;
    const swap = Math.round(pl.rotation_deg / 90) % 2 !== 0;
    const [w, d] = swap ? [bd, bw] : [bw, bd];
    const pts = Object.values(pl.pin_to_hole).map((h) => holeIndex.get(h)?.position_mm).filter((p): p is [number, number, number] => !!p);
    const mod = moduleRect(pl, prof, holeIndex);
    if (mod) { rects.push({ id: c.id, ...mod }); continue; }
    if (pts.length) {
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const hw = Math.max(w, Math.max(...xs) - Math.min(...xs)) / 2, hd = Math.max(d, Math.max(...zs) - Math.min(...zs)) / 2;
      rects.push({ id: c.id, x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd });
    } else if (pl.position_mm) {
      // 放在麵包板旁邊的開發板：原點在角落，依旋轉決定往哪邊長
      const [px, , pz] = pl.position_mm; const flip = Math.round(pl.rotation_deg / 180) % 2 !== 0;
      rects.push(flip ? { id: c.id, x0: px - w, x1: px, z0: pz - d, z1: pz } : { id: c.id, x0: px, x1: px + w, z0: pz, z1: pz + d });
    }
  }
  const out: ElectricalIssue[] = [];
  const tol = 0.5;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    if (a.x0 + tol < b.x1 && b.x0 + tol < a.x1 && a.z0 + tol < b.z1 && b.z0 + tol < a.z1) {
      out.push({ kind: "part_overlap", severity: "error", pins: [a.id, b.id],
                 message: `${a.id.toUpperCase()} 和 ${b.id.toUpperCase()} 的本體在麵包板上重疊，實際插不進去` });
    }
  }
  return out;
}
