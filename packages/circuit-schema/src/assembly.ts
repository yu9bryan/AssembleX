import type { CircuitIR } from "./circuit-ir.js";
import type { ComponentProfile } from "./component-profile.js";
import { buildBreadboard, BREADBOARDS, BREADBOARD_830 } from "./breadboard.js";

/**
 * 組裝步驟：由 CircuitIR 直接推導，桌面端顯示、手機 AR 端逐步疊圖，用的是同一份資料。
 *
 * 順序照實際動手的習慣：
 *  1. 先把元件插上麵包板（依最左邊那根腳的欄位，由左到右，手不會擋到已經插好的東西）
 *  2. 再接線：地線 → 電源 → 訊號。先接地是電子實驗的基本安全習慣。
 * 每一步都帶有要插的孔位／腳位，AR 端可以直接把目標標在畫面上。
 */
export interface AssemblyStep {
  index: number;
  kind: "place" | "wire";
  targetId: string;               // placement instance id 或 wire id
  title: string;
  detail: string;
  holes: string[];                // 這一步會用到的麵包板孔位
  tag?: string;                   // 元件位號（R2、DHT1），標題裡不重複
}

/** 電源軌孔 → 它旁邊主區的欄號（電源軌每 5 孔空一格，軌孔序號和欄號不同；人在板上找的是欄號） */
const railColCache = new Map<string, Map<string, number>>();
export function railColumns(profileId = "breadboard_830"): Map<string, number> {
  const hit = railColCache.get(profileId);
  if (hit) return hit;
  const holes = buildBreadboard(BREADBOARDS[profileId] ?? BREADBOARD_830);
  const main = holes.filter((h) => h.kind !== "rail" && /^A\d+$/.test(h.id));
  const m = new Map<string, number>();
  for (const h of holes.filter((x) => x.kind === "rail")) {
    let best = main[0], d = Infinity;
    for (const c of main) { const dd = Math.abs(c.position_mm[0] - h.position_mm[0]); if (dd < d) { d = dd; best = c; } }
    m.set(h.id, Number(best.id.slice(1)));
  }
  railColCache.set(profileId, m);
  return m;
}

/** 給人看的孔位名稱：BOT-1 →「A 側−軌（第 3 欄旁）」；主區孔位（E30）本來就看得懂。 */
export function holeLabel(hole: string, profileId = "breadboard_830"): string {
  const m = /^(TOP|BOT)([+-])(\d+)$/.exec(hole);
  if (!m) return hole;
  // 用「A 側／J 側」而不是上方／下方（從哪個角度看都不會講反），位置用旁邊主區的欄號（和手機疊圖同一套說法）
  const col = railColumns(profileId).get(hole);
  return `靠 ${m[1] === "TOP" ? "J" : "A"} 排的${m[2] === "+" ? "＋" : "−"}軌（第 ${col ?? m[3]} 欄旁）`;
}

/** 短名稱（3D 標記、手機疊圖用）：主區「D 排 8 欄」不會和 Arduino 的 D8 腳搞混；電源軌「A 側−軌·43 欄」 */
export function holeShort(hole: string, profileId = "breadboard_830"): string {
  const r = /^(TOP|BOT)([+-])(\d+)$/.exec(hole);
  if (r) return `${r[1] === "TOP" ? "J" : "A"} 側${r[2] === "+" ? "＋" : "−"}軌·${railColumns(profileId).get(hole) ?? r[3]} 欄`;
  const m = /^([A-J])(\d+)$/.exec(hole);
  return m ? `${m[1]} 排 ${m[2]} 欄` : hole;
}

/** 腳位名稱：+/- 換成全形符號，GND2 這類編號只是區分排針位置，人只需要知道是 GND。 */
function pinLabel(pin: string): string {
  // 和電氣面板、3D 標籤同一套名稱
  if (pin === "+" || pin === "anode") return "正極";
  if (pin === "-" || pin === "cathode") return "負極";
  if (/^\d+$/.test(pin)) return `腳${pin}`;
  return pin.replace(/^GND\d+$/, "GND");
}

const ARROW = "\u2009→\u2009";

const ROLE_ORDER: Record<string, number> = { ground: 0, power: 1, signal: 2 };

function colOf(hole: string): number {
  const m = /(\d+)$/.exec(hole);
  return m ? Number(m[1]) : 0;
}

export function assemblySteps(ir: CircuitIR, profiles: Map<string, ComponentProfile>): AssemblyStep[] {
  const steps: AssemblyStep[] = [];
  const bb = ir.physical.breadboard?.profile_id ?? "breadboard_830";
  /** 「插上 軸向電阻」重複兩次時分不出是哪一顆，所以帶上編號與阻值 */
  const nameOf = (id: string) => {
    const comp = ir.logical.components.find((c) => c.id === id);
    const pid = id === ir.logical.board.instance_id ? ir.logical.board.profile_id : comp?.profile_id;
    const base = (pid && profiles.get(pid)?.display_name) || id;
    const ohm = comp?.parameters?.resistance_ohm;
    const val = typeof ohm === "number" ? ` ${ohm >= 1000 ? `${ohm / 1000}kΩ` : `${ohm}Ω`}` : "";
    return `${base}${val}`;
  };

  const placed = ir.physical.placements
    .filter((p) => Object.keys(p.pin_to_hole).length > 0)
    .sort((a, b) => Math.min(...Object.values(a.pin_to_hole).map(colOf))
                  - Math.min(...Object.values(b.pin_to_hole).map(colOf)));
  for (const p of placed) {
    const pins = Object.entries(p.pin_to_hole);
    steps.push({
      index: steps.length, kind: "place", targetId: p.instance_id,
      // 中文動詞接中文名詞不加空格；名稱以英數字開頭（6mm、DHT22）才留一個空格
      title: `插上${/^[A-Za-z0-9]/.test(nameOf(p.instance_id)) ? " " : ""}${nameOf(p.instance_id)}`,
      tag: p.instance_id.toUpperCase(),
      detail: pins.map(([pin, hole]) => `${pinLabel(pin)}${ARROW}${holeLabel(hole, bb)}`).join(" · "),
      holes: pins.map(([, h]) => h),
    });
  }

  // 板外元件（排線接頭）：先擺在麵包板旁邊、接上排線轉杜邦線，後面的接線步驟再從杜邦頭接過去
  for (const p of ir.physical.placements) {
    if (p.instance_id === ir.logical.board.instance_id || Object.keys(p.pin_to_hole).length) continue;
    const comp = ir.logical.components.find((c) => c.id === p.instance_id);
    const prof = comp && profiles.get(comp.profile_id);
    if (!prof) continue;
    const used = new Set(ir.logical.nets.flatMap((n) => n.pins).filter((x) => x.startsWith(`${p.instance_id}.`)).map((x) => x.split(".")[1]));
    steps.push({
      index: steps.length, kind: "place", targetId: p.instance_id,
      title: `擺好${/^[A-Za-z0-9]/.test(nameOf(p.instance_id)) ? " " : ""}${nameOf(p.instance_id)}（外接）`,
      tag: p.instance_id.toUpperCase(),
      detail: `放在麵包板旁邊，不插板：接上它的排線、尾端轉成杜邦頭（${prof.pins.filter((q) => used.has(q.id)).map((q) => pinLabel(q.id)).join("、")}）`,
      holes: [],
    });
  }

  const roleOf = new Map(ir.logical.nets.map((n) => [n.id, n.role]));
  const wires = [...ir.physical.wires].sort((a, b) =>
    (ROLE_ORDER[roleOf.get(a.net_id ?? "") ?? "signal"] ?? 3) -
    (ROLE_ORDER[roleOf.get(b.net_id ?? "") ?? "signal"] ?? 3));
  // 開發板簡稱：UNO、Nano、Mega…（從 profile 名稱去掉品牌字）
  const boardShort = (profiles.get(ir.logical.board.profile_id)?.display_name ?? "UNO")
    .replace(/^Arduino\s+/, "").replace(/\s+(R3|2560|DevKit V1)$/, "");
  const label = (e: (typeof wires)[number]["from"]) =>
    e.kind === "hole" ? holeLabel(e.hole, bb)
      : e.pin.startsWith(`${ir.logical.board.instance_id}.`) ? `${boardShort} ${pinLabel(e.pin.split(".")[1])}`
      : `${e.pin.split(".")[0].toUpperCase()} ${pinLabel(e.pin.split(".")[1])}`;
  const ROLE_ZH: Record<string, string> = { ground: "地線", power: "電源線", signal: "訊號線" };
  for (const w of wires) {
    const role = roleOf.get(w.net_id ?? "") ?? "signal";
    steps.push({
      index: steps.length, kind: "wire", targetId: w.id,
      title: `接${ROLE_ZH[role] ?? "導線"}`,
      detail: `${label(w.from)}${ARROW}${label(w.to)}`,
      holes: [w.from, w.to].flatMap((e) => (e.kind === "hole" ? [e.hole] : [])),
    });
  }
  return steps;
}
