import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { ComponentProfile } from "../src/component-profile.js";
import { assemblySteps } from "../src/assembly.js";

const APP = join(__dirname, "../../../apps/desktop/src/data");
const profiles = new Map(readdirSync(join(APP, "components")).filter((f) => f.endsWith(".json"))
  .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(APP, "components", f), "utf8"))))
  .map((p) => [p.component_id, p] as const));

describe("組裝步驟", () => {
  const ir = CircuitIR.parse(JSON.parse(readFileSync(join(APP, "examples", "dht22_alarm.circuit.json"), "utf8")));
  const steps = assemblySteps(ir, profiles);

  it("每個插在板上的元件、每條線都剛好出現一次", () => {
    const onBoard = ir.physical.placements.filter((p) => Object.keys(p.pin_to_hole).length).length;
    expect(steps.filter((s) => s.kind === "place")).toHaveLength(onBoard);
    expect(steps.filter((s) => s.kind === "wire")).toHaveLength(ir.physical.wires.length);
  });

  it("先插元件、後接線", () => {
    const firstWire = steps.findIndex((s) => s.kind === "wire");
    expect(steps.slice(firstWire).every((s) => s.kind === "wire")).toBe(true);
  });

  it("接線順序：地線 → 電源 → 訊號", () => {
    const role = new Map(ir.logical.nets.map((n) => [n.id, n.role]));
    const order = steps.filter((s) => s.kind === "wire")
      .map((s) => role.get(ir.physical.wires.find((w) => w.id === s.targetId)!.net_id ?? "") ?? "signal");
    const rank = { ground: 0, power: 1, signal: 2 } as Record<string, number>;
    for (let i = 1; i < order.length; i++) expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]]);
  });
});
