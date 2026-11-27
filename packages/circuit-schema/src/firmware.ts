import type { CircuitIR } from "./circuit-ir.js";
import { parsePinRef } from "./circuit-ir.js";

/**
 * 從 CircuitIR 生成 Arduino 韌體。
 *
 * 關鍵設計：**腳位定義不讓 LLM 自己寫**，由 CircuitIR 直接產生 pins.generated.h。
 * 程式和接線圖共用同一份腳位資料，就不可能出現「程式寫 D9、實際接 D10」這種錯。
 * 改了接線 → header 重生 → 編譯結果跟著變，對不上會在編譯期就爆出來。
 */

/** "mcu1.D9" → "9"；"mcu1.A0" → "A0"。Arduino 的類比腳在 C 裡是 A0 這個巨集。 */
function pinLiteral(ref: string): string {
  const { pinId } = parsePinRef(ref);
  const m = /^D(\d+)$/.exec(pinId);
  if (m) return m[1];
  if (/^A\d+$/.test(pinId)) return pinId;
  return pinId;
}

export function generatePinHeader(ir: CircuitIR): string {
  const binds = Object.entries(ir.logical.firmware_bindings)
    .sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(0, ...binds.map(([k]) => k.length));

  const lines = [
    "// pins.generated.h — 自動生成，請勿手動修改",
    `// 來源：${ir.project_id} 電路版本 ${ir.revision}`,
    "#pragma once",
    "",
    ...binds.map(([name, ref]) =>
      `#define ${name.padEnd(width)}  ${pinLiteral(ref).padStart(2)}   // ${ref}`),
    "",
  ];
  return lines.join("\n");
}

/** 綁定名稱決定腳位方向：輸出（LED、蜂鳴器、繼電器、馬達），其餘一律當輸入，按鈕用內部上拉。 */
const OUTPUT_RE = /LED|BUZZER|RELAY|MOTOR|SERVO/i;
const BUTTON_RE = /BUTTON|BTN|SWITCH/i;

/**
 * 依 CircuitIR 的 behavior 產生真的能跑的程式，而不是一律閃燈：
 *  - threshold_alarm：讀 DHT22，超過門檻蜂鳴器響、LED 亮；按鈕切換靜音（邊緣偵測＋去彈跳）
 *  - toggle：按一下按鈕切換 LED
 *  - 其他（含 blink）：LED 依 interval 閃爍
 * 只有輸出類綁定設 OUTPUT；資料線（DHT）交給函式庫、不能設成 OUTPUT 去搶線。
 */
export function generateSketch(ir: CircuitIR): string {
  const binds = Object.keys(ir.logical.firmware_bindings);
  const behavior = (ir.behavior ?? {}) as Record<string, unknown>;
  const type = String(behavior.type ?? "blink");
  const interval = Number(behavior.interval_ms ?? 1000);
  const find = (re: RegExp) => binds.find((b) => re.test(b));
  const led = find(/LED/i), buzzer = find(/BUZZER/i), button = find(BUTTON_RE), dht = find(/DHT/i);

  // 按鈕的網路上已經有電阻接到電源 → 外接上拉，用 INPUT；沒有才用晶片內建上拉
  const hasExternalPullup = (bind: string) => {
    const ref = ir.logical.firmware_bindings[bind];
    const net = ir.logical.nets.find((n) => n.pins.includes(ref));
    const powerPins = new Set(ir.logical.nets.filter((n) => n.role === "power").flatMap((n) => n.pins));
    return !!net?.pins.some((p) => {
      const inst = p.split(".")[0];
      const comp = ir.logical.components.find((c) => c.id === inst);
      if (!comp || !/resistor/i.test(comp.profile_id)) return false;
      return [...powerPins].some((q) => q.startsWith(`${inst}.`));
    });
  };
  const pinModes = binds.map((b) =>
    OUTPUT_RE.test(b) ? `  pinMode(${b}, OUTPUT);`
    : BUTTON_RE.test(b) ? (hasExternalPullup(b)
        ? `  pinMode(${b}, INPUT);          // 外接上拉電阻：平常 HIGH、按下＝LOW`
        : `  pinMode(${b}, INPUT_PULLUP);   // 內建上拉：按下＝LOW`)
    : /DHT/i.test(b) ? `  // ${b}：由 DHT 函式庫控制，不設 pinMode`
    : `  pinMode(${b}, INPUT);`);

  const head = [
    `// ${ir.project_id}.ino — 由 AssembleX 生成`,
    `// 電路版本 ${ir.revision}，腳位在 pins.generated.h`,
    '#include "pins.generated.h"',
  ];
  const buttonHelpers = button ? [
    "",
    "// 按鈕：去彈跳後的「剛按下」事件",
    "bool lastRaw = HIGH, stable = HIGH;",
    "unsigned long changedAt = 0;",
    "bool pressedNow() {",
    `  bool raw = digitalRead(${button});`,
    "  if (raw != lastRaw) { lastRaw = raw; changedAt = millis(); }",
    "  if (millis() - changedAt > 30 && raw != stable) { stable = raw; return stable == LOW; }",
    "  return false;",
    "}",
  ] : [];

  if (type === "threshold_alarm" && dht) {
    const th = Number(behavior.threshold_c ?? 30);
    return [
      ...head,
      "#include <DHT.h>   // 需安裝 DHT sensor library",
      "",
      `const float THRESHOLD_C = ${th.toFixed(1)};`,
      `DHT dht(${dht}, DHT22);`,
      "bool muted = false;",
      "bool alarm = false;",
      "unsigned long lastRead = 0;",
      ...buttonHelpers,
      "",
      "void setup() {",
      "  Serial.begin(9600);",
      ...pinModes,
      "  dht.begin();",
      "}",
      "",
      "void loop() {",
      `  if (millis() - lastRead >= ${Math.max(2000, interval)}) {   // DHT22 每次讀取至少間隔 2 秒`,
      "    lastRead = millis();",
      "    float t = dht.readTemperature();",
      "    if (!isnan(t)) {",
      "      alarm = t > THRESHOLD_C;",
      "      if (!alarm) muted = false;            // 溫度回落後解除靜音，下次超標會再響",
      '      Serial.print("溫度 "); Serial.print(t); Serial.println(" °C");',
      "    }",
      "  }",
      // 每一圈都檢查按鈕（去彈跳狀態才不會過期），只有在響的時候按才算靜音
      ...(button ? ["  bool pressed = pressedNow();", "  if (alarm && pressed) muted = true;"] : []),
      ...(buzzer ? [`  digitalWrite(${buzzer}, alarm && !muted ? HIGH : LOW);`] : []),
      ...(led ? [`  digitalWrite(${led}, alarm ? HIGH : LOW);   // 超標時亮燈（靜音也亮，提醒還沒解除）`] : []),
      "}",
      "",
    ].join("\n");
  }

  if (type === "toggle" && led && button) {
    return [
      ...head,
      "",
      "bool on = false;",
      ...buttonHelpers,
      "",
      "void setup() {",
      ...pinModes,
      "}",
      "",
      "void loop() {",
      "  if (pressedNow()) {",
      "    on = !on;",
      `    digitalWrite(${led}, on ? HIGH : LOW);`,
      "  }",
      "}",
      "",
    ].join("\n");
  }

  const loop = led
    ? [
        `  digitalWrite(${led}, HIGH);`,
        `  delay(${interval});`,
        `  digitalWrite(${led}, LOW);`,
        `  delay(${interval});`,
      ]
    : ["  // 行為尚未指定：只有腳位設定"];
  return [...head, "", "void setup() {", ...pinModes, "}", "", "void loop() {", ...loop, "}", ""].join("\n");
}

/** 這份韌體需要哪些 Arduino 函式庫（給介面顯示與下載說明用）。 */
export function sketchLibraries(ir: CircuitIR): string[] {
  const b = ((ir.behavior ?? {}) as Record<string, unknown>).type;
  return b === "threshold_alarm" && Object.keys(ir.logical.firmware_bindings).some((k) => /DHT/i.test(k))
    ? ["DHT sensor library（Adafruit）"] : [];
}

/** 檢查韌體綁定是否都指向電路裡真實存在、而且有接線的腳位。 */
export function validateBindings(ir: CircuitIR): string[] {
  const inNets = new Set(ir.logical.nets.flatMap((n) => n.pins));
  const out: string[] = [];
  for (const [name, ref] of Object.entries(ir.logical.firmware_bindings)) {
    if (!inNets.has(ref)) {
      out.push(`${name} 綁定到 ${ref}，但這個腳位沒有出現在任何 net 裡（程式會驅動一根沒接線的腳）。`);
    }
  }
  return out;
}
