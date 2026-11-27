/**
 * 麵包板拓樸（架構文件 §7.4）。
 * 麵包板不能只做成一個 3D 模型 —— 每一個孔都要有座標和電氣導通群組，
 * 否則無法檢查「插錯一排是否造成斷路」「電源與 GND 是否意外連通」。
 *
 * 830 孔標準板：主區 63 欄 × 10 列（A–J，E/F 之間有中央溝）＝ 630 孔，
 * 加 4 條電源軌 × 50 孔 ＝ 200 孔，合計 830。
 * 電源軌中間是否斷開依型號而異，這裡用最常見的「分成兩段各 25 孔」。
 */

export const PITCH_MM = 2.54;

export interface BreadboardHole {
  /** 孔位名，例如 "E12"、"TOP+7"。 */
  id: string;
  /** 板面座標（mm，右手系 Y-up，原點＝板子左前角，y＝板面高度）。 */
  position_mm: [number, number, number];
  /** 電氣導通群組 id。同一群組的孔在板子內部就是短路的。 */
  tie_group: string;
  kind: "main" | "rail";
  row?: string;
  column?: number;
  rail?: RailName;
}

export type RailName = "TOP+" | "TOP-" | "BOT+" | "BOT-";

export interface BreadboardSpec {
  profile_id: string;
  columns: number;
  rows: string[];
  /** 電源軌切成幾段（1＝整條導通，2＝中間斷開）。 */
  rail_segments: number;
  /** 每條電源軌的孔數；0＝沒有電源軌（170 孔迷你板）。 */
  rail_holes?: number;
  size_mm: [number, number, number];
  surface_y_mm: number;
}

export const BREADBOARD_830: BreadboardSpec = {
  profile_id: "breadboard_830",
  columns: 63,
  rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  rail_segments: 2,
  rail_holes: 50,
  size_mm: [165.1, 8.5, 54.4],
  surface_y_mm: 8.5,
};

/** 400 孔半板：30 欄，電源軌 25 孔、整條導通。 */
export const BREADBOARD_400: BreadboardSpec = {
  profile_id: "breadboard_400",
  columns: 30,
  rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  rail_segments: 1,
  rail_holes: 25,
  size_mm: [82.5, 8.5, 54.4],
  surface_y_mm: 8.5,
};

/** 170 孔迷你板：17 欄，沒有電源軌。 */
export const BREADBOARD_170: BreadboardSpec = {
  profile_id: "breadboard_170",
  columns: 17,
  rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  rail_segments: 1,
  rail_holes: 0,
  size_mm: [46.5, 8.5, 34.5],
  surface_y_mm: 8.5,
};

export const BREADBOARDS: Record<string, BreadboardSpec> = {
  breadboard_830: BREADBOARD_830, breadboard_400: BREADBOARD_400, breadboard_170: BREADBOARD_170,
};

const CHANNEL_MM = 7.62;          // E 與 F 之間的中央溝（3 個 pitch）
const RAIL_HOLES_DEFAULT = 50;    // 每條電源軌的孔數（規格沒寫時）
const RAIL_GROUP = 5;             // 每 5 孔一組，組間多一個 pitch 的間隙

/** 產生整塊板的所有孔位。純函式，結果可快取。 */
export function buildBreadboard(spec: BreadboardSpec = BREADBOARD_830): BreadboardHole[] {
  const holes: BreadboardHole[] = [];
  const [W, , D] = spec.size_mm;
  const y = spec.surface_y_mm;

  // 主區 ------------------------------------------------------------------
  const mainSpan = (spec.columns - 1) * PITCH_MM;
  const x0 = (W - mainSpan) / 2;
  const half = spec.rows.length / 2;                       // A–E / F–J
  const mainDepth = (half - 1) * PITCH_MM * 2 + CHANNEL_MM;
  const z0 = (D - mainDepth) / 2;

  spec.rows.forEach((row, ri) => {
    // 前半段 A–E 連續排；後半段 F–J 要跨過中央溝
    const z = ri < half
      ? z0 + ri * PITCH_MM
      : z0 + (half - 1) * PITCH_MM + CHANNEL_MM + (ri - half) * PITCH_MM;

    for (let c = 1; c <= spec.columns; c++) {
      holes.push({
        id: `${row}${c}`,
        position_mm: [x0 + (c - 1) * PITCH_MM, y, z],
        // 同一欄的 A–E 互通、F–J 互通，上下半部彼此不通（中央溝的作用）
        tie_group: `${ri < half ? "L" : "U"}${c}`,
        kind: "main",
        row,
        column: c,
      });
    }
  });

  // 電源軌 ----------------------------------------------------------------
  const RAIL_HOLES = spec.rail_holes ?? RAIL_HOLES_DEFAULT;
  if (RAIL_HOLES <= 0) return holes;                       // 沒有電源軌的板子
  const groups = Math.ceil(RAIL_HOLES / RAIL_GROUP);
  const railSpan = ((groups - 1) * (RAIL_GROUP + 1) + RAIL_GROUP - 1) * PITCH_MM;
  const rx0 = (W - railSpan) / 2;
  const perSegment = RAIL_HOLES / spec.rail_segments;

  const rails: Array<{ name: RailName; z: number }> = [
    { name: "BOT-", z: z0 - 9.73 },
    { name: "BOT+", z: z0 - 7.19 },
    { name: "TOP+", z: z0 + mainDepth + 7.19 },
    { name: "TOP-", z: z0 + mainDepth + 9.73 },
  ];

  for (const rail of rails) {
    for (let i = 0; i < RAIL_HOLES; i++) {
      const g = Math.floor(i / RAIL_GROUP);
      const h = i % RAIL_GROUP;
      holes.push({
        id: `${rail.name}${i + 1}`,
        position_mm: [rx0 + (g * (RAIL_GROUP + 1) + h) * PITCH_MM, y, rail.z],
        // 軌道分段：第 1–25 孔一段、第 26–50 孔另一段，中間不導通
        tie_group: `${rail.name}:${Math.floor(i / perSegment) + 1}`,
        kind: "rail",
        rail: rail.name,
      });
    }
  }

  return holes;
}

/** 建索引，之後查孔位是 O(1)。 */
export function indexHoles(holes: BreadboardHole[]): Map<string, BreadboardHole> {
  return new Map(holes.map((h) => [h.id, h]));
}

/** 找離某個板面座標最近的孔（元件吸附用）。超過半個 pitch 就當作沒插到。 */
export function nearestHole(
  holes: BreadboardHole[], x: number, z: number, maxDist = PITCH_MM / 2,
): BreadboardHole | null {
  let best: BreadboardHole | null = null;
  let bestD = Infinity;
  for (const h of holes) {
    const dx = h.position_mm[0] - x, dz = h.position_mm[2] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best && Math.sqrt(bestD) <= maxDist ? best : null;
}
