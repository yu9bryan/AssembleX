import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { ComponentProfile } from "../src/component-profile.js";
import { buildBreadboard } from "../src/breadboard.js";
import { autoWire } from "../src/autowire.js";
import { runElectricalChecks, detectHoleConflicts, blockedHoleErrors } from "../src/netlist.js";

const APP = join(__dirname, "../../../apps/desktop/src/data");
const profiles = new Map(readdirSync(join(APP, "components")).filter((f) => f.endsWith(".json"))
  .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(APP, "components", f), "utf8"))))
  .map((p) => [p.component_id, p] as const));
const holes = buildBreadboard();
const holeIndex = new Map(holes.map((h) => [h.id, h]));

describe("自動接線：拿掉範例的導線，依規範重新產生", () => {
  for (const f of readdirSync(join(APP, "examples")).filter((x) => x.endsWith(".json"))) {
    it(f, () => {
      const ir = CircuitIR.parse(JSON.parse(readFileSync(join(APP, "examples", f), "utf8")));
      const r = autoWire(ir, profiles, holes);
      const out = { ...ir, physical: { ...ir.physical, wires: r.wires } };
      console.log(f, r.wires.length, "wires", r.score, r.problems);
      expect(r.problems).toEqual([]);
      expect(runElectricalChecks(out, holes).filter((i) => i.severity === "error").map((i) => i.message)).toEqual([]);
      expect(detectHoleConflicts(out)).toEqual([]);
      expect(blockedHoleErrors(out, profiles, holeIndex)).toEqual([]);
      expect(r.score.collisions).toBe(0);
    });
  }
});
