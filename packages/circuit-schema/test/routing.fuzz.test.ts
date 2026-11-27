import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { ComponentProfile } from "../src/component-profile.js";
import { buildBreadboard } from "../src/breadboard.js";
import { routeWires, findWireCollisions, findHooks } from "../src/routing.js";
import { blockedHoleErrors, detectHoleConflicts } from "../src/netlist.js";

/**
 * 佈線演算法的壓力測試：隨機產生幾百個「合法」的麵包板電路
 * （元件不重疊、一孔一物、線不插在元件底下），每一個都必須排得開、零交叉。
 * 用固定種子，失敗時可以重現；之後改演算法時這組測試保證不會退步。
 */
const APP = join(__dirname, "../../../apps/desktop/src/data");
const profiles = new Map(
  readdirSync(join(APP, "components")).filter((f) => f.endsWith(".json"))
    .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(APP, "components", f), "utf8"))))
    .map((p) => [p.component_id, p] as const));
const holes = buildBreadboard();
const holeIndex = new Map(holes.map((h) => [h.id, h]));
const ROWS = "ABCDEFGHIJ";
const DIGITAL = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13"];

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function randomCircuit(seed: number, nParts: number, nWires: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const used = new Set<string>();
  const components: { id: string; profile_id: string; parameters: Record<string, number> }[] = [];
  const placements: { instance_id: string; position_mm: number[]; rotation_deg: number; pin_to_hole: Record<string, string> }[] = [
    { instance_id: "mcu1", position_mm: [117, 0, -14], rotation_deg: 180, pin_to_hole: {} },
  ];
  // 元件：電阻（跨 4 欄）或 LED（相鄰 2 欄），放在隨機的列與欄，欄之間留空
  let col = 3 + Math.floor(r() * 4);
  for (let i = 0; i < nParts && col < 58; i++) {
    const res = r() < 0.6;
    const row = pick([...ROWS]);
    const span = res ? 4 : 1;
    const pins: Record<string, string> = res ? { "1": `${row}${col}`, "2": `${row}${col + span}` }
                     : { anode: `${row}${col}`, cathode: `${row}${col + 1}` };
    const id = `${res ? "r" : "led"}${i + 1}`;
    components.push({ id, profile_id: res ? "resistor_axial" : "generic_led_red", parameters: res ? { resistance_ohm: 330 } : {} });
    placements.push({ instance_id: id, position_mm: [0, 0, 0], rotation_deg: 0, pin_to_hole: pins });
    Object.values(pins).forEach((h) => used.add(h));
    col += span + 3 + Math.floor(r() * 4);
  }
  // 導線：開發板腳位 → 孔、孔 → 電源軌、孔 → 孔
  const wires: unknown[] = [];
  const freeHole = (pool: string[]) => {
    for (let k = 0; k < 50; k++) { const h = pick(pool); if (!used.has(h)) { used.add(h); return h; } }
    return null;
  };
  const main = holes.filter((h) => h.kind === "main").map((h) => h.id);
  const rail = holes.filter((h) => h.kind === "rail").map((h) => h.id);
  const pins = [...DIGITAL, "5V", "GND2"].sort(() => r() - 0.5);
  for (let i = 0; i < nWires; i++) {
    const kind = r();
    let from: unknown, to: unknown;
    if (kind < 0.4 && pins.length) {
      const h = freeHole(main); if (!h) continue;
      from = { kind: "pin", pin: `mcu1.${pins.pop()}` }; to = { kind: "hole", hole: h };
    } else if (kind < 0.75) {
      const a = freeHole(main), b = freeHole(rail); if (!a || !b) continue;
      from = { kind: "hole", hole: a }; to = { kind: "hole", hole: b };
    } else {
      const a = freeHole(main), b = freeHole(main); if (!a || !b) continue;
      from = { kind: "hole", hole: a }; to = { kind: "hole", hole: b };
    }
    wires.push({ id: `w${i}`, from, to, color: "#f5a524", net_id: null });
  }
  return CircuitIR.parse({
    schema_version: "1.0", project_id: `fuzz_${seed}`, revision: 1, units: "mm",
    logical: { board: { instance_id: "mcu1", profile_id: "arduino_uno_r3", fqbn: "arduino:avr:uno" },
               components, nets: [], firmware_bindings: {} },
    physical: { breadboard: { instance_id: "bb1", profile_id: "breadboard_830", position_mm: [0, 0, 0] },
                placements, wires },
  });
}

describe("佈線壓力測試：隨機電路零交叉", () => {
  const cases: [number, number, number][] = [];
  for (let seed = 1; seed <= 300; seed++) cases.push([seed, 2 + (seed % 7), 4 + (seed % 15)]);

  it("300 個隨機電路全部排得開", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [seed, parts, nWires] of cases) {
      const ir = randomCircuit(seed, parts, nWires);
      // 只測「合法」的擺法：不合法的電路本來就該被電氣檢查擋下，不是佈線的責任
      if (detectHoleConflicts(ir).length || blockedHoleErrors(ir, profiles, holeIndex).length) continue;
      checked++;
      const routes = routeWires(ir, profiles, holes);
      const hit = findWireCollisions(routes);
      const hooks = findHooks(routes);
      if (hooks.length) failures.push(`seed ${seed}：${hooks.join("、")} 有 N 形小鉤`);
      if (hit.length) failures.push(`seed ${seed}（${ir.physical.wires.length} 條線）：${hit.slice(0, 3).map((h) => `${h.a}×${h.b} ${h.distance.toFixed(2)}mm`).join("、")}`);
    }
    expect(checked).toBeGreaterThan(200);
    expect(failures).toEqual([]);
  });
});
