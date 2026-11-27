import { it, expect } from "vitest";
import { assemblySteps } from "../src/assembly.js";
import { offGridPins } from "../src/netlist.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { ComponentProfile } from "../src/component-profile.js";
import { buildBreadboard } from "../src/breadboard.js";
import { autoWire } from "../src/autowire.js";
import { routeWires, findWireCollisions } from "../src/routing.js";
import { runElectricalChecks, footprintErrors, blockedHoleErrors, detectIsolatedParts, detectPartOverlaps } from "../src/netlist.js";
const APP = join(__dirname, "../../../apps/desktop/src/data");
const profiles = new Map(readdirSync(join(APP, "components")).filter((f) => f.endsWith(".json"))
  .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(APP, "components", f), "utf8"))))
  .map((p) => [p.component_id, p] as const));
const base = profiles.get("buzzer_active")!;
const ld = ComponentProfile.parse({ ...base, component_id: "user_ld06", display_name: "LD06", category: "sensor",
  pins: ["TX","PWM","GND","P5V"].map((id, i) => ({ ...base.pins[0], id, functions: [id], position_mm: [i*1.5, 0, 0] })),
  geometry: { ...base.geometry, bbox_mm: [38.6, 34.8, 38.6] } });
profiles.set("user_ld06", ld);
const holes = buildBreadboard(); const hi = new Map(holes.map((h) => [h.id, h]));
it("板外元件（LD06 排線接頭）：不插麵包板也能自動接線、不碰撞、有擺放步驟", () => {
  const ir0 = JSON.parse(readFileSync(join(APP, "examples", "blink.circuit.json"), "utf8"));
  ir0.logical.components.push({ id: "ld1", profile_id: "user_ld06", parameters: {} });
  ir0.logical.nets.push({ id: "n_ld_tx", pins: ["ld1.TX", "mcu1.D2"], role: "signal" });
  const g = ir0.logical.nets.find((n: any) => n.role === "ground"); g.pins.push("ld1.GND");
  ir0.logical.nets.push({ id: "n_5v", pins: ["ld1.P5V", "mcu1.5V"], role: "power" });
  ir0.physical.placements.push({ instance_id: "ld1", position_mm: [-50, 0, 10], rotation_deg: 0, pin_to_hole: {} });
  ir0.physical.wires = [];
  const ir = CircuitIR.parse(ir0);
  const r = autoWire(ir, profiles, holes);
  const out = { ...ir, physical: { ...ir.physical, wires: r.wires } };
  console.log("problems", r.problems, r.wires.map((w) => JSON.stringify([w.from, w.to])).join("\n"));
  console.log("elec", runElectricalChecks(out, holes).filter((i) => i.severity === "error").map((i) => i.message));
  console.log("fp", footprintErrors(out, profiles, hi), blockedHoleErrors(out, profiles, hi), detectIsolatedParts(out, profiles), detectPartOverlaps(out, profiles, hi));
  const routes = routeWires(out, profiles, holes);
  expect(r.problems).toEqual([]);
  expect(runElectricalChecks(out, holes).filter((i) => i.severity === "error")).toEqual([]);
  expect(findWireCollisions(routes)).toEqual([]);
  const st = assemblySteps(out, profiles);
  expect(st.some((s) => s.kind === "place" && s.targetId === "ld1" && s.title.includes("外接") && s.holes.length === 0)).toBe(true);
  for (const w of r.wires) if (JSON.stringify(w).includes("ld1")) console.log(w.id, JSON.stringify(routes.get(w.id)?.map(p=>p.map(v=>+v.toFixed(1)))));
});
it("腳距 1.5mm 判定為板外元件，內建 DHT22 不是", () => { expect(offGridPins(profiles.get("user_ld06")!)).toBe(true); expect(offGridPins(profiles.get("dht22")!)).toBe(false); });
