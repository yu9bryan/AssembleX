import { z } from "zod";

/**
 * CircuitIR — 整個平台唯一的電路真相來源。
 * 電腦 3D、模擬、Arduino 韌體、手機 AR 組裝全部從這一份衍生，不各自生成接線關係。
 *
 * 嚴格分三層（架構文件 §6.2）：
 *   logical  邏輯電路：元件、腳位、Netlist。改這層會讓韌體／模擬／組裝步驟全部失效。
 *   physical 實體佈局：位置、旋轉、麵包板孔位。只改這層不影響電氣正確性。
 *   runtime  執行狀態：模擬電壓、GPIO、組裝進度。不進版本控制。
 */

/**
 * `<instance_id>.<pin_id>`，例如 `mcu1.D9`。
 * 腳位名要容得下實際的命名：`+` `-`（蜂鳴器、電解電容）、`3V3`、`A0`、`SDA/SCL`。
 * instance id 保持嚴格，因為它是識別碼不是人類標籤。
 */
export const PinRef = z.string().regex(
  /^[A-Za-z0-9_]+\.[A-Za-z0-9_+\-/]+$/,
  "PinRef 格式必須是 <instance_id>.<pin_id>，例如 mcu1.D9 或 bz1.+",
);
export type PinRef = z.infer<typeof PinRef>;

export function parsePinRef(ref: string): { instanceId: string; pinId: string } {
  const i = ref.indexOf(".");
  if (i < 0) throw new Error(`PinRef 格式錯誤：${ref}`);
  return { instanceId: ref.slice(0, i), pinId: ref.slice(i + 1) };
}

// ── Logical ───────────────────────────────────────────────────────────────

export const ComponentInstance = z.object({
  id: z.string(),
  profile_id: z.string(),
  label: z.string().optional(),
  parameters: z.record(z.union([z.number(), z.string()])).default({}),
});
export type ComponentInstance = z.infer<typeof ComponentInstance>;

/** Net：一組電氣上相連的腳位。role 讓規則引擎知道這條是電源還是訊號。 */
export const Net = z.object({
  id: z.string(),
  pins: z.array(PinRef).min(1),
  role: z.enum(["signal", "power", "ground"]).default("signal"),
  nominal_voltage_v: z.number().optional(),
});
export type Net = z.infer<typeof Net>;

export const LogicalCircuit = z.object({
  board: z.object({
    instance_id: z.string(),
    profile_id: z.string(),
    fqbn: z.string().optional(),      // Arduino CLI 的 Fully Qualified Board Name
  }),
  components: z.array(ComponentInstance).default([]),
  nets: z.array(Net).default([]),
  /** 韌體常數名 → 腳位。pins.generated.h 由這裡產生，程式與接線不會對不上。 */
  firmware_bindings: z.record(PinRef).default({}),
});
export type LogicalCircuit = z.infer<typeof LogicalCircuit>;

// ── Physical ──────────────────────────────────────────────────────────────

/** 麵包板孔位名，例如 "E12"、"TOP+"、"BOT-"。 */
export const HoleRef = z.string();

export const Placement = z.object({
  instance_id: z.string(),
  /** 世界座標 mm（工作區原點＝麵包板左前角）。 */
  position_mm: z.tuple([z.number(), z.number(), z.number()]),
  /** 繞 Y 軸旋轉，度。元件平貼桌面，先只需要一個自由度。 */
  rotation_deg: z.number().default(0),
  /** 元件腳位 → 麵包板孔位。有這個才能算實體連通性。 */
  pin_to_hole: z.record(HoleRef).default({}),
});
export type Placement = z.infer<typeof Placement>;

/**
 * 導線端點可以是麵包板孔位，也可以直接是元件腳位
 * —— UNO 這種有排針母座的板子不會插在麵包板上，是用杜邦線從排針拉過去。
 * AR 端要標出「插哪一個孔 / 插哪一根腳」，所以兩種端點必須分得出來。
 */
export const WireEndpoint = z.union([
  z.object({ kind: z.literal("hole"), hole: HoleRef }),
  z.object({ kind: z.literal("pin"), pin: PinRef }),
]);
export type WireEndpoint = z.infer<typeof WireEndpoint>;

export const WireSegment = z.object({
  id: z.string(),
  from: WireEndpoint,
  to: WireEndpoint,
  color: z.string().default("#facc15"),
  /** 對應的邏輯 net；為 null 代表這條線在設計中不存在（使用者多接的）。 */
  net_id: z.string().nullable().default(null),
});
export type WireSegment = z.infer<typeof WireSegment>;

/** 端點的 DSU 節點名。 */
export function endpointKey(e: WireEndpoint): string {
  return e.kind === "hole" ? `hole:${e.hole}` : `pin:${e.pin}`;
}

export const PhysicalLayout = z.object({
  breadboard: z.object({
    instance_id: z.string(),
    profile_id: z.string(),
    position_mm: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  }).optional(),
  placements: z.array(Placement).default([]),
  wires: z.array(WireSegment).default([]),
});
export type PhysicalLayout = z.infer<typeof PhysicalLayout>;

// ── Runtime ───────────────────────────────────────────────────────────────

export const RuntimeState = z.object({
  net_voltages_v: z.record(z.number()).default({}),
  gpio_states: z.record(z.enum(["high", "low", "input", "pwm"])).default({}),
  component_states: z.record(z.record(z.unknown())).default({}),
  assembly_progress: z.object({
    completed_steps: z.array(z.string()).default([]),
    current_step: z.string().nullable().default(null),
  }).default({ completed_steps: [], current_step: null }),
}).default({});

// ── 頂層 ──────────────────────────────────────────────────────────────────

export const CircuitIR = z.object({
  schema_version: z.literal("1.0"),
  project_id: z.string(),
  /** 每次改到 logical 層就 +1。手機帶舊 revision 來同步時要擋下來。 */
  revision: z.number().int().nonnegative(),
  units: z.literal("mm").default("mm"),
  logical: LogicalCircuit,
  physical: PhysicalLayout.default({ placements: [], wires: [] }),
  runtime: RuntimeState.optional(),
  behavior: z.record(z.unknown()).optional(),
});
export type CircuitIR = z.infer<typeof CircuitIR>;

export function parseCircuitIR(input: unknown): CircuitIR {
  return CircuitIR.parse(input);
}

/** 只有 logical 層參與雜湊：拖動元件不該讓韌體與組裝步驟失效。 */
export function logicalFingerprint(ir: CircuitIR): string {
  const nets = ir.logical.nets
    .map((n) => `${n.role}:${[...n.pins].sort().join(",")}`)
    .sort().join("|");
  const comps = ir.logical.components
    .map((c) => `${c.id}@${c.profile_id}`)
    .sort().join("|");
  const binds = Object.entries(ir.logical.firmware_bindings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("|");
  return `${ir.logical.board.profile_id}#${comps}#${nets}#${binds}`;
}
