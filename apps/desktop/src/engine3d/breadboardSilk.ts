import * as THREE from "three";
/** 板面塑膠色：象牙白，不要灰褐（看起來像髒掉）。板體與絲印用同一個色，才不會分層。 */
export const BOARD_SILK = "#26272a";
export const BOARD_BODY = "#222326";

import { BREADBOARD_830, buildBreadboard, type BreadboardSpec } from "@assemblex/circuit-schema";

/**
 * 麵包板的絲印貼圖（列標 A–J、欄號、電源軌 +/− 與紅藍線、每 5 欄的刻度）。
 * 用 canvas 當場畫，不需要任何外部圖檔。
 * 少了絲印的麵包板一眼就是假的 —— 真板子上這些字是最醒目的特徵之一。
 */
export function breadboardSilkTexture(spec: BreadboardSpec = BREADBOARD_830): THREE.CanvasTexture {
  const [W, , D] = spec.size_mm;
  const PPM = 12;                                  // 每 mm 幾個像素
  const cv = document.createElement("canvas");
  cv.width = Math.round(W * PPM);
  cv.height = Math.round(D * PPM);
  const g = cv.getContext("2d")!;
  const mm = (v: number) => v * PPM;

  // 底色：微黃的象牙白，不是純白
  g.fillStyle = BOARD_SILK;
  g.fillRect(0, 0, cv.width, cv.height);

  // 很淡的塑膠紋理
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.02})`;
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 1.2, 1.2);
  }

  const half = spec.rows.length / 2;
  const mainSpan = (spec.columns - 1) * 2.54;
  const x0 = (W - mainSpan) / 2;
  const mainDepth = (half - 1) * 2.54 * 2 + 7.62;
  const z0 = (D - mainDepth) / 2;
  const rowZ = (ri: number) => ri < half
    ? z0 + ri * 2.54
    : z0 + (half - 1) * 2.54 + 7.62 + (ri - half) * 2.54;

  g.textAlign = "center";
  g.textBaseline = "middle";

  // 中央溝現在是真幾何（板體切兩塊），不要在貼圖上再畫一次，否則寬度對不上會露出灰邊

  // 列標 A–J（左右兩側各一組）
  g.fillStyle = "#d8d6d0";
  g.font = `600 ${mm(1.9)}px -apple-system, Helvetica, sans-serif`;
  spec.rows.forEach((row, ri) => {
    const z = rowZ(ri);
    // 小板（170 孔）左右留邊不到 3.4mm：字母往孔那邊靠，不要被板緣切掉
    const m = Math.min(3.4, x0 * 0.55);
    g.fillText(row, mm(x0 - m), mm(z));
    g.fillText(row, mm(x0 + mainSpan + m), mm(z));
  });

  // 欄號：每 5 欄一個，標在主區上下緣
  g.font = `500 ${mm(1.75)}px -apple-system, Helvetica, sans-serif`;
  for (let c = 1; c <= spec.columns; c++) {
    if (c !== 1 && c % 5 !== 0) continue;
    const x = x0 + (c - 1) * 2.54;
    g.fillStyle = "#d8d6d0";
    g.fillText(String(c), mm(x), mm(z0 - 2.6));
    g.fillText(String(c), mm(x), mm(z0 + mainDepth + 2.6));
  }

  // 電源軌：紅藍線 ＋ ＋/− 符號
  // 顏色必須和電氣資料一致（breadboard.ts：BOT- 在最外側、BOT+ 靠主區；TOP+ 靠主區、TOP- 在最外側）。
  // 紅＝＋（VCC）、藍＝−（GND）；色線畫在每條軌「離另一條軌較遠」的那一側
  const rails: Array<{ z: number; color: string; sign: string; lineZ: number }> = [
    { z: z0 - 9.73, color: "#2563a8", sign: "−", lineZ: z0 - 9.73 - 2.1 },              // BOT-
    { z: z0 - 7.19, color: "#d0342c", sign: "+", lineZ: z0 - 7.19 + 2.1 },              // BOT+
    { z: z0 + mainDepth + 7.19, color: "#d0342c", sign: "+", lineZ: z0 + mainDepth + 7.19 - 2.1 },   // TOP+
    { z: z0 + mainDepth + 9.73, color: "#2563a8", sign: "−", lineZ: z0 + mainDepth + 9.73 + 2.1 },   // TOP-
  ];
  const railHoles = buildBreadboard(spec).filter((h) => h.kind === "rail").map((h) => h.position_mm[0]);
  const railX0 = railHoles.length ? Math.min(...railHoles) : 0, railSpan = railHoles.length ? Math.max(...railHoles) - railX0 : 0;
  for (const r of railHoles.length ? rails : []) {
    const lineZ = r.lineZ;
    g.strokeStyle = r.color;
    g.lineWidth = mm(0.45);
    g.globalAlpha = 0.85;
    g.beginPath();
    g.moveTo(mm(railX0 - 4), mm(lineZ));
    g.lineTo(mm(railX0 + railSpan + 4), mm(lineZ));
    g.stroke();
    g.globalAlpha = 1;

    g.fillStyle = r.color;
    g.font = `700 ${mm(2.8)}px -apple-system, Helvetica, sans-serif`;
    g.fillText(r.sign, mm(railX0 - 7), mm(r.z));
    g.fillText(r.sign, mm(railX0 + railSpan + 7), mm(r.z));
  }

  // 孔口：外圈一圈斜面（上、左面背光較暗，下、右面受光較亮），中央的黑井由 Breadboard 的
  // 實例方塊畫（它還要負責 hover／步驟上色）。之前挖透明洞，底下看到的是板條頂面，孔變成「┌」形殘影。
  for (const h of buildBreadboard(spec)) {
    const x = mm(h.position_mm[0]), z = mm(h.position_mm[2]);
    const o = mm(0.95), i = mm(0.6);
    g.fillStyle = "rgba(0,0,0,0.30)";
    g.fillRect(x - o, z - o, o * 2, o * 2);
    g.fillStyle = "rgba(255,255,255,0.10)";
    g.beginPath();
    g.moveTo(x + o, z - o); g.lineTo(x + o, z + o); g.lineTo(x - o, z + o);
    g.lineTo(x - i, z + i); g.lineTo(x + i, z + i); g.lineTo(x + i, z - i);
    g.closePath(); g.fill();
  }

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
