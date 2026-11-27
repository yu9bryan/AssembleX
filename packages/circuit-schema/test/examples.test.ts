import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CircuitIR } from "../src/circuit-ir.js";
import { buildBreadboard } from "../src/breadboard.js";
import { runElectricalChecks, footprintErrors, blockedHoleErrors, detectIsolatedParts, detectPartOverlaps } from "../src/netlist.js";
import { ComponentProfile } from "../src/component-profile.js";

/**
 * 所有內建範例電路都必須是**物理上成立**的：
 * 腳距對得上真實元件、沒有斷路、沒有意外短路、沒有未插的腳位。
 * 手寫 JSON 很容易寫出接不起來的電路，這個測試擋住它進到 demo 裡。
 */
const DIR = join(__dirname, "../../../apps/desktop/src/data/examples");
const holes = buildBreadboard();
const holeIndex = new Map(holes.map((h) => [h.id, h]));
const CDIR = join(__dirname, "../../../apps/desktop/src/data/components");
const profiles = new Map(readdirSync(CDIR).filter((f) => f.endsWith(".json"))
  .map((f) => ComponentProfile.parse(JSON.parse(readFileSync(join(CDIR, f), "utf8"))))
  .map((p) => [p.component_id, p] as const));

describe("腳距檢查", () => {
  it("電阻插到太短的間距要被抓出來", () => {
    const ir = CircuitIR.parse(JSON.parse(readFileSync(join(DIR, "blink.circuit.json"), "utf8")));
    ir.physical.placements.find((p) => p.instance_id === "r1")!.pin_to_hole = { "1": "E10", "2": "E12" };
    expect(footprintErrors(ir, profiles, holeIndex)).toHaveLength(1);
  });
});

describe("內建範例電路", () => {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".circuit.json"))) {
    it(`${f} 通過電氣檢查`, () => {
      const ir = CircuitIR.parse(JSON.parse(readFileSync(join(DIR, f), "utf8")));
      const issues = runElectricalChecks(ir, holes);
      expect(issues.map((i) => `${i.kind}: ${i.message}`)).toEqual([]);
    });
    it(`${f} 元件腳距和插孔一致`, () => {
      const ir = CircuitIR.parse(JSON.parse(readFileSync(join(DIR, f), "utf8")));
      expect(footprintErrors(ir, profiles, holeIndex)).toEqual([]);
    });
    it(`${f} 導線不插在元件本體底下`, () => {
      const ir = CircuitIR.parse(JSON.parse(readFileSync(join(DIR, f), "utf8")));
      expect(blockedHoleErrors(ir, profiles, holeIndex)).toEqual([]);
      expect(detectIsolatedParts(ir, profiles).map((i) => i.message)).toEqual([]);
      expect(detectPartOverlaps(ir, profiles, holeIndex).map((i) => i.message)).toEqual([]);
    });
  }
});

describe("元件本體重疊與孤立元件", () => {
  const blink = CircuitIR.parse(JSON.parse(readFileSync(join(DIR, "blink.circuit.json"), "utf8")));
  it("兩顆 DHT22 只隔兩欄 → 重疊；沒接線 → 孤立", () => {
    const ir = structuredClone(blink);
    for (const [id, c] of [["d1", 40], ["d2", 42]] as const) {
      ir.logical.components.push({ id, profile_id: "dht22", parameters: {} } as never);
      ir.physical.placements.push({ instance_id: id, position_mm: [0, 0, 0], rotation_deg: 0,
        pin_to_hole: { VCC: `E${c}`, DATA: `E${c + 1}`, NC: `E${c + 2}`, GND: `E${c + 3}` } } as never);
    }
    expect(detectPartOverlaps(ir, profiles, holeIndex).some((i) => i.pins?.includes("d1") && i.pins?.includes("d2"))).toBe(true);
    expect(detectIsolatedParts(ir, profiles).map((i) => i.pins?.[0].split(".")[0])).toEqual(["d1", "d2"]);
  });
});
