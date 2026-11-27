import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { ComponentProfile } from "../src/component-profile.js";
import { buildBreadboard, BREADBOARDS, type BreadboardSpec } from "../src/breadboard.js";
import { optimizePinAssignment, optimizeLayout } from "../src/autowire.js";
import { runElectricalChecks, detectHoleConflicts, blockedHoleErrors, detectPartOverlaps } from "../src/netlist.js";

/**
 * 自動接線的壓力測試：不同尺寸的麵包板上隨機擺元件、隨機配網路（電源／地／訊號），
 * 每一個都要「電氣檢查全對、一孔一物、線不插在元件底下、實體零碰撞」。俯視交叉另外統計。
 * 固定種子，失敗可重現。
 */
const APP = join(__dirname, "../../../apps/desktop/src/data");
const profiles = new Map(readdirSync(join(APP, "components")).filter((f) => f.endsWith(".json"))
  .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(APP, "components", f), "utf8"))))
  .map((p) => [p.component_id, p] as const));
const DIGITAL = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "A0", "A1", "A2", "A3"];

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

export function randomCircuit(spec: BreadboardSpec, seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const comps: { id: string; profile_id: string; parameters: Record<string, number> }[] = [];
  const placements: { instance_id: string; position_mm: number[]; rotation_deg: number; pin_to_hole: Record<string, string> }[] = [
    { instance_id: "mcu1", position_mm: [117, 0, -14], rotation_deg: 180, pin_to_hole: {} },
  ];
  const nets = new Map<string, { role: "power" | "ground" | "signal"; pins: string[] }>([
    ["net_5v", { role: "power", pins: ["mcu1.5V"] }], ["net_gnd", { role: "ground", pins: ["mcu1.GND2"] }],
  ]);
  const gpio = [...DIGITAL].sort(() => r() - 0.5);
  const signal = (ref: string) => { const g = gpio.pop(); if (!g) return; nets.set(`net_${g}`, { role: "signal", pins: [`mcu1.${g}`, ref] }); };
  let col = 2 + Math.floor(r() * 3);
  let k = 0;
  while (col < spec.columns - 6 && k < 8) {
    const kind = pick(["res", "led", "btn", "dht"] as const);
    const top = r() < 0.5;   // 上半區 A–E 或下半區 F–J
    const id = `${kind}${++k}`;
    if (kind === "res") {
      const row = pick(top ? ["A", "B", "C"] : ["H", "I", "J"]);
      comps.push({ id, profile_id: "resistor_axial", parameters: { resistance_ohm: 330 } });
      placements.push({ instance_id: id, position_mm: [0, 0, 0], rotation_deg: 0, pin_to_hole: { "1": `${row}${col}`, "2": `${row}${col + 4}` } });
      signal(`${id}.1`); nets.get(r() < 0.5 ? "net_gnd" : "net_5v")!.pins.push(`${id}.2`);
      col += 4 + 3 + Math.floor(r() * 3);
    } else if (kind === "led") {
      const row = pick(top ? ["B", "C", "D"] : ["G", "H", "I"]);
      comps.push({ id, profile_id: "generic_led_red", parameters: {} });
      placements.push({ instance_id: id, position_mm: [0, 0, 0], rotation_deg: 0, pin_to_hole: { anode: `${row}${col}`, cathode: `${row}${col + 1}` } });
      signal(`${id}.anode`); nets.get("net_gnd")!.pins.push(`${id}.cathode`);
      col += 1 + 3 + Math.floor(r() * 3);
    } else if (kind === "btn") {
      comps.push({ id, profile_id: "pushbutton_6mm", parameters: {} });
      placements.push({ instance_id: id, position_mm: [0, 0, 0], rotation_deg: 0, pin_to_hole: { "1": `E${col}`, "2": `F${col}`, "3": `E${col + 2}`, "4": `F${col + 2}` } });
      signal(`${id}.1`); nets.get("net_gnd")!.pins.push(`${id}.3`);
      col += 2 + 4 + Math.floor(r() * 3);
    } else {
      const row = top ? "E" : "J";
      comps.push({ id, profile_id: "dht22", parameters: {} });
      placements.push({ instance_id: id, position_mm: [0, 0, 0], rotation_deg: 0,
        pin_to_hole: { VCC: `${row}${col + 2}`, DATA: `${row}${col + 3}`, NC: `${row}${col + 4}`, GND: `${row}${col + 5}` } });
      nets.get("net_5v")!.pins.push(`${id}.VCC`); signal(`${id}.DATA`); nets.get("net_gnd")!.pins.push(`${id}.GND`);
      col += 8 + 3 + Math.floor(r() * 3);
    }
  }
  return CircuitIR.parse({
    schema_version: "1.0", project_id: `fuzz_${seed}`, revision: 1,
    logical: {
      board: { instance_id: "mcu1", profile_id: "arduino_uno_r3", fqbn: "arduino:avr:uno" },
      components: comps,
      nets: [...nets].filter(([, n]) => n.pins.length > 1).map(([id, n]) => ({ id, role: n.role, pins: n.pins })),
      firmware_bindings: {},
    },
    physical: { breadboard: { instance_id: "bb1", profile_id: spec.profile_id }, placements, wires: [] },
  });
}

for (const [name, spec] of Object.entries(BREADBOARDS)) {
  describe(`自動接線壓力測試：${name}`, () => {
    const holes = buildBreadboard(spec);
    const holeIndex = new Map(holes.map((h) => [h.id, h]));
    const N = name === "breadboard_830" ? 60 : 40;
    it(`${N} 個隨機電路全部有效、零碰撞`, () => {
      const bad: string[] = [];
      let crossings = 0, skipped = 0;
      for (let seed = 1; seed <= N; seed++) {
        const ir = randomCircuit(spec, seed * 7919);
        if (detectPartOverlaps(ir, profiles, holeIndex).length || blockedHoleErrors(ir, profiles, holeIndex).length) { skipped++; continue; }
        const o = process.env.LAYOUT ? optimizeLayout(ir, profiles, holes, { budgetMs: 1500 }) : optimizePinAssignment(ir, profiles, holes, { budgetMs: 450 });
        const r = o.result;
        const out = { ...o.ir, physical: { ...o.ir.physical, wires: r.wires } };
        const errs = [
          ...r.problems,
          ...runElectricalChecks(out, holes).filter((i) => i.severity === "error").map((i) => i.message),
          ...detectHoleConflicts(out).map((i) => i.message),
          ...blockedHoleErrors(out, profiles, holeIndex),
          ...(r.score.collisions ? [`${r.score.collisions} 處實體碰撞`] : []),
        ];
        if (errs.length) bad.push(`seed ${seed}: ${errs.slice(0, 3).join("；")}`);
        crossings += r.score.crossings ? 1 : 0;
      }
      console.log(`${name}: ${N - skipped} 個電路，${bad.length} 個失敗，${crossings} 個仍有俯視交叉（跳過 ${skipped} 個本身擺放無效）`);
      expect(bad).toEqual([]);
    }, 120_000);
  });
}
