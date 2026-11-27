import { describe, it, expect } from "vitest";
import { CircuitIR } from "../src/circuit-ir.js";
import { generatePinHeader, generateSketch, validateBindings } from "../src/firmware.js";

const ir = CircuitIR.parse({
  schema_version: "1.0", project_id: "blink_demo", revision: 3,
  logical: {
    board: { instance_id: "mcu1", profile_id: "arduino_uno_r3" },
    components: [],
    nets: [
      { id: "n1", pins: ["mcu1.D9", "r1.1"], role: "signal" },
      { id: "n2", pins: ["mcu1.A0", "s1.out"], role: "signal" },
    ],
    firmware_bindings: { LED_PIN: "mcu1.D9", SENSOR_PIN: "mcu1.A0" },
  },
  behavior: { interval_ms: 500 },
});

describe("CircuitIR → 韌體", () => {
  it("數位腳轉成數字、類比腳保留 A 巨集", () => {
    const h = generatePinHeader(ir);
    expect(h).toContain("#define LED_PIN      9");
    expect(h).toContain("#define SENSOR_PIN  A0");
  });

  it("header 標出來源腳位，方便回溯", () => {
    expect(generatePinHeader(ir)).toContain("// mcu1.D9");
  });

  it("sketch 只 include header，不自己定義腳位", () => {
    const s = generateSketch(ir);
    expect(s).toContain('#include "pins.generated.h"');
    expect(s).not.toMatch(/#define\s+LED_PIN/);   // 不能有第二份定義
    expect(s).toContain("digitalWrite(LED_PIN, HIGH)");
    expect(s).toContain("delay(500)");
  });

  it("綁到沒接線的腳位會被抓出來", () => {
    const bad = CircuitIR.parse({
      ...JSON.parse(JSON.stringify(ir)),
      logical: { ...ir.logical, firmware_bindings: { LED_PIN: "mcu1.D13" } },
    });
    expect(validateBindings(bad)).toHaveLength(1);
    expect(validateBindings(ir)).toHaveLength(0);
  });

  it("溫度告警範例生成真的讀 DHT、超標響蜂鳴器、按鈕靜音（不是一律閃燈）", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dht = CircuitIR.parse(JSON.parse(readFileSync(join(__dirname, "../../../apps/desktop/src/data/examples/dht22_alarm.circuit.json"), "utf8")));
    const s = generateSketch(dht);
    expect(s).toContain("#include <DHT.h>");
    expect(s).toContain("dht.readTemperature()");
    expect(s).toContain("THRESHOLD_C = 30.0");
    expect(s).toContain("pinMode(BUTTON_PIN, INPUT);");   // R3 是外接上拉
    expect(s).not.toContain("pinMode(DHT_PIN, OUTPUT)");
    expect(s).not.toContain("pinMode(BUTTON_PIN, OUTPUT)");
    expect(s).toContain("digitalWrite(BUZZER_PIN, alarm && !muted ? HIGH : LOW)");
  });
});
