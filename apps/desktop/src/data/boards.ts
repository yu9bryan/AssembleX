/**
 * 可選的開發板。每塊板子要知道：
 *  - 怎麼擺：beside＝放在麵包板旁邊用杜邦線接（UNO／Mega／Leonardo）；
 *           breadboard＝直接跨在麵包板上，腳就插在孔裡（Nano／ESP32）
 *  - 韌體要用的 FQBN（Arduino CLI／IDE 的板子代號）
 *  - 電源腳叫什麼（5V 板 vs 3.3V 板）
 * 腳位座標在各自的 component profile 裡。
 */
export interface BoardOption {
  id: string;            // component profile id
  short: string;         // 介面上的簡稱（標籤、步驟用）
  name: string;
  fqbn: string;
  mount: "beside" | "breadboard";
  power: string;         // 給電源軌的腳位
  ground: string;
  logic: string;         // 一句話特色
  spec: string;          // 電壓 · 數位 D／類比 A 腳數（固定一行，不折行）
  hasModel: boolean;
  pinNote?: string;      // 腳位資料的限制（例如推估值），選板卡片用黃字標出     // 有沒有自己的實體 3D 模型（Leonardo 沒有授權模型，借用外形相同的 UNO，介面要標出來）
}

export const BOARDS: BoardOption[] = [
  { id: "arduino_uno_r3", short: "UNO", name: "Arduino UNO R3", fqbn: "arduino:avr:uno",
    mount: "beside", power: "5V", ground: "GND2", logic: "最常用的入門板", spec: "5V · 14D / 6A", hasModel: true },
  { id: "arduino_nano", short: "Nano", name: "Arduino Nano", fqbn: "arduino:avr:nano",
    mount: "breadboard", power: "5V", ground: "GND2", logic: "小巧，可插麵包板", spec: "5V · 14D / 8A", hasModel: true },
  { id: "arduino_mega2560", short: "Mega", name: "Arduino Mega 2560", fqbn: "arduino:avr:mega",
    mount: "beside", power: "5V", ground: "GND2", logic: "腳位最多", spec: "5V · 54D / 16A", hasModel: true, pinNote: "D14+ 為推定" },
  { id: "arduino_leonardo", short: "Leonardo", name: "Arduino Leonardo", fqbn: "arduino:avr:leonardo",
    mount: "beside", power: "5V", ground: "GND2", logic: "可當 USB 鍵盤", spec: "5V · 20D / 12A", hasModel: false },
  { id: "esp32_devkit_v1", short: "ESP32", name: "ESP32 DevKit V1", fqbn: "esp32:esp32:esp32doit-devkit-v1",
    mount: "breadboard", power: "3V3", ground: "GND2", logic: "Wi-Fi／藍牙", spec: "3.3V · 25 GPIO", hasModel: true },
];

export const boardOf = (profileId: string) => BOARDS.find((b) => b.id === profileId) ?? BOARDS[0];

/**
 * 開發板在電路裡的擺放：放旁邊的板子固定在麵包板後方；
 * 插麵包板的板子依腳位座標換算成孔位（Nano：C／G 排，ESP32：B／J 排，從第 2 欄開始）。
 */
/** 麵包板寬度（mm）：板外的開發板對齊麵包板中央擺在後方。830 孔板寬 165.1 → x = 117，和原本一致 */
export function boardPlacement(board: BoardOption, pins: { id: string; position_mm: number[] }[], bbWidth = 165.1) {
  if (board.mount === "beside") {
    // 小板（400／170）時多退 6mm：斜視角下不會看起來壓在麵包板上
    return { instance_id: "mcu1", position_mm: [+(bbWidth / 2 + 34.45).toFixed(2), 0, bbWidth < 100 ? -20 : -14], rotation_deg: 180, pin_to_hole: {} as Record<string, string> };
  }
  const rows = board.id === "esp32_devkit_v1" ? ["B", "J"] : ["C", "G"];
  const zs = [...new Set(pins.map((p) => p.position_mm[2]))].sort((a, b) => a - b);
  const pin_to_hole: Record<string, string> = {};
  for (const p of pins) {
    const row = rows[zs.indexOf(p.position_mm[2])];
    // 板子外形比最外側腳位多出一截（USB 座、天線）：第一欄往右挪，整塊板子才會落在麵包板上
    const start = board.id === "esp32_devkit_v1" ? 6 : board.id === "arduino_nano" ? 5 : 2;
    const col = start + Math.round(p.position_mm[0] / 2.54);
    pin_to_hole[p.id] = `${row}${col}`;
  }
  return { instance_id: "mcu1", position_mm: [0, 0, 0], rotation_deg: 0, pin_to_hole };
}
