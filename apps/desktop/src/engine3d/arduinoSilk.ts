import * as THREE from "three";
import type { ComponentProfile } from "@assemblex/circuit-schema";

/**
 * Arduino UNO 的絲印貼圖。
 *
 * UNO 的視覺識別九成來自青色板上的白絲印：ARDUINO 字樣、DIGITAL / ANALOG IN / POWER
 * 三段分區、0–13 腳位編號、板框白線。沒有這些它就只是一塊青色壓克力。
 *
 * 腳位編號**直接讀 profile 的座標**畫，和排針模型同一份資料，不會各說各話。
 */
export interface SilkOptions { model?: string; maxPinX?: number; analogX?: number; digitalX?: number; logoX?: number }
export function arduinoSilkTexture(profile: ComponentProfile,
                                   W = 68.58, D = 53.34, opt: SilkOptions = {}): THREE.CanvasTexture {
  const PPM = 16;
  const cv = document.createElement("canvas");
  cv.width = Math.round(W * PPM);
  cv.height = Math.round(D * PPM);
  const g = cv.getContext("2d")!;
  const mm = (v: number) => v * PPM;
  const SILK = "#dfe8ec";

  // 板材底色：實物比較偏青綠，不是亮藍
  g.fillStyle = "#0f7276";
  g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 26000; i++) {           // 阻焊層的細微不均勻
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 2, 2);
  }

  // 板框白線
  g.strokeStyle = SILK; g.lineWidth = mm(0.35); g.globalAlpha = 0.75;
  g.strokeRect(mm(1.2), mm(1.2), cv.width - mm(2.4), cv.height - mm(2.4));
  g.globalAlpha = 1;

  g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = SILK;

  // 腳位編號：z 相同的分成一組，照 profile 的 x 畫
  const byZ = new Map<number, { id: string; x: number }[]>();
  for (const p of profile.pins) {
    const z = Math.round(p.position_mm[2] * 10) / 10;
    byZ.set(z, [...(byZ.get(z) ?? []), { id: p.id, x: p.position_mm[0] }]);
  }
  g.font = `600 ${mm(1.5)}px -apple-system, Helvetica, sans-serif`;
  for (const [z, pins] of byZ) {
    const top = z > D / 2;                     // 數位側在上緣
    for (const { id, x } of pins) {
      if (opt.maxPinX != null && x > opt.maxPinX) continue;
      const label = /^D(\d+)$/.exec(id)?.[1] ?? id.replace(/^GND\d$/, "GND");
      if (label.length > 5) continue;
      g.fillText(label, mm(x), mm(top ? z - 3.1 : z + 3.1));
    }
  }

  // 分區標題
  g.font = `700 ${mm(1.9)}px -apple-system, Helvetica, sans-serif`;
  g.textAlign = "left";
  g.fillText("DIGITAL (PWM~)", mm(opt.digitalX ?? 34), mm(D - 2.9));
  g.fillText("POWER", mm(18), mm(2.9));
  g.fillText("ANALOG IN", mm(opt.analogX ?? 43), mm(2.9));

  // wordmark
  g.font = `700 ${mm(3.4)}px -apple-system, Helvetica, sans-serif`;
  g.globalAlpha = 0.92;
  g.fillText("ARDUINO", mm(opt.logoX ?? 8.5), mm(D / 2 + 6));
  g.font = `500 ${mm(1.7)}px -apple-system, Helvetica, sans-serif`;
  g.globalAlpha = 0.7;
  g.fillText(opt.model ?? "UNO  R3", mm(opt.logoX ?? 8.5), mm(D / 2 + 10.4));
  g.globalAlpha = 1;

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
