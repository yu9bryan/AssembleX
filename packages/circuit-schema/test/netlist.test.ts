import { describe, it, expect } from "vitest";
import { buildBreadboard } from "../src/breadboard.js";
import { CircuitIR, type CircuitIR as IR } from "../src/circuit-ir.js";
import { resolvePhysicalNets, runElectricalChecks, DisjointSet } from "../src/netlist.js";

const holes = buildBreadboard();

/** D9 → 330Ω → LED → GND 的 blink 電路。wiring 可以故意接錯來測。 */
function blink(wiring: {
  r1a?: string; r1b?: string; ledA?: string; ledK?: string; gndWireTo?: string;
} = {}): IR {
  return CircuitIR.parse({
    schema_version: "1.0",
    project_id: "test_blink",
    revision: 1,
    logical: {
      board: { instance_id: "mcu1", profile_id: "arduino_uno_r3", fqbn: "arduino:avr:uno" },
      components: [
        { id: "led1", profile_id: "generic_led_red" },
        { id: "r1", profile_id: "resistor_axial", parameters: { resistance_ohm: 330 } },
      ],
      nets: [
        { id: "net_signal", pins: ["mcu1.D9", "r1.1"], role: "signal" },
        { id: "net_led", pins: ["r1.2", "led1.anode"], role: "signal" },
        { id: "net_ground", pins: ["led1.cathode", "mcu1.GND1"], role: "ground" },
      ],
      firmware_bindings: { LED_PIN: "mcu1.D9" },
    },
    physical: {
      placements: [
        { instance_id: "mcu1", position_mm: [0, 0, 0], pin_to_hole: { D9: "A10", GND1: "A20" } },
        { instance_id: "r1", position_mm: [0, 0, 0],
          pin_to_hole: { "1": wiring.r1a ?? "C10", "2": wiring.r1b ?? "C14" } },
        { instance_id: "led1", position_mm: [0, 0, 0],
          pin_to_hole: { anode: wiring.ledA ?? "D14", cathode: wiring.ledK ?? "D18" } },
      ],
      wires: [
        { id: "w1", from: { kind: "hole", hole: "E18" },
          to: { kind: "hole", hole: wiring.gndWireTo ?? "E20" },
          color: "#111827", net_id: "net_ground" },
      ],
    },
  });
}

describe("Union-Find", () => {
  it("傳遞性正確", () => {
    const d = new DisjointSet();
    d.union("a", "b"); d.union("b", "c");
    expect(d.connected("a", "c")).toBe(true);
    expect(d.connected("a", "z")).toBe(false);
  });
});

describe("實體連通性推導", () => {
  it("接對時三條 net 都成立，沒有任何錯誤", () => {
    const ir = blink();
    expect(runElectricalChecks(ir, holes)).toEqual([]);
  });

  it("D9 和 r1.1 透過同一欄的 tie group 連通（不需要額外導線）", () => {
    const nets = resolvePhysicalNets(blink(), holes);
    const n = nets.find(x => x.pins.includes("mcu1.D9"))!;
    expect(n.pins).toContain("r1.1");
  });

  it("電阻插到隔壁欄 → 抓出斷路", () => {
    const issues = runElectricalChecks(blink({ r1a: "C11" }), holes);
    expect(issues.some(i => i.kind === "missing_connection")).toBe(true);
  });

  it("插過中央溝（上半部）→ 抓出斷路", () => {
    // G14 和 D14 同一欄但分屬上下半部，中央溝隔開
    const issues = runElectricalChecks(blink({ ledA: "G14" }), holes);
    expect(issues.some(i => i.kind === "missing_connection")).toBe(true);
  });

  it("LED 兩腳插同一欄 → 抓出自我短路", () => {
    const issues = runElectricalChecks(blink({ ledK: "E14" }), holes);
    expect(issues.some(i => i.kind === "unintended_connection")).toBe(true);
  });

  it("GND 線誤插到訊號欄 → 抓出意外連通", () => {
    const issues = runElectricalChecks(blink({ gndWireTo: "E10" }), holes);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i =>
      i.kind === "unintended_connection" || i.kind === "missing_connection")).toBe(true);
  });

  it("元件沒插板子 → 抓出 floating pin", () => {
    const ir = blink();
    ir.physical.placements[1].pin_to_hole = {};
    expect(runElectricalChecks(ir, holes).some(i => i.kind === "floating_pin")).toBe(true);
  });
});

describe("電源短路", () => {
  it("5V 直接接到 GND → 標成 power_ground_short", () => {
    const ir = CircuitIR.parse({
      schema_version: "1.0", project_id: "t", revision: 1,
      logical: {
        board: { instance_id: "mcu1", profile_id: "arduino_uno_r3" },
        components: [],
        nets: [
          { id: "net_5v", pins: ["mcu1.5V"], role: "power", nominal_voltage_v: 5 },
          { id: "net_gnd", pins: ["mcu1.GND1"], role: "ground" },
        ],
        firmware_bindings: {},
      },
      physical: {
        placements: [{ instance_id: "mcu1", position_mm: [0, 0, 0],
          pin_to_hole: { "5V": "A30", GND1: "A40" } }],
        wires: [{ id: "bad", from: { kind: "hole", hole: "B30" },
                  to: { kind: "hole", hole: "B40" }, color: "#ef4444", net_id: null }],
      },
    });
    const issues = runElectricalChecks(ir, holes);
    expect(issues.some(i => i.kind === "power_ground_short")).toBe(true);
  });
});

describe("detectHoleConflicts", () => {
  it("一個孔被兩條線共用要報錯", async () => {
    const { detectHoleConflicts } = await import("../src/netlist");
    const ir = {
      physical: {
        placements: [],
        wires: [
          { id: "a", from: { kind: "hole", hole: "BOT-26" }, to: { kind: "hole", hole: "BOT-25" } },
          { id: "b", from: { kind: "hole", hole: "A33" }, to: { kind: "hole", hole: "BOT-26" } },
        ],
      },
    } as any;
    const issues = detectHoleConflicts(ir);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("hole_conflict");
    expect(issues[0].pins).toEqual(["a", "b"]);
  });
});
