import { z } from "zod";

/**
 * Component Profile — 一個元件的「真相來源」。
 * 電氣規格、腳位、幾何三者綁在一起，桌面 3D、模擬、韌體生成、手機 AR 共用同一份。
 * 每個電氣欄位都要能追溯到 Datasheet（evidence），未驗證的要標出來。
 */

export const PinType = z.enum([
  "digital_io", "analog_in", "analog_out", "power_in", "power_out",
  "ground", "passive", "nc",
]);
export type PinType = z.infer<typeof PinType>;

export const ConnectorType = z.enum([
  "male_header", "female_header", "through_hole_lead", "smd_pad", "barrel_jack", "usb",
]);

/** 腳位：電氣身分 ＋ 三維座標（物件座標系，mm）。兩者缺一不可。 */
export const Pin = z.object({
  id: z.string(),
  type: PinType,
  functions: z.array(z.string()).default([]),
  /** 物件座標，mm。右手系 Y-up，原點＝元件底面中心。 */
  position_mm: z.tuple([z.number(), z.number(), z.number()]),
  /** 腳位插入方向的單位向量；杜邦線與插孔吸附時用。 */
  normal: z.tuple([z.number(), z.number(), z.number()]).default([0, -1, 0]),
  connector_type: ConnectorType.default("male_header"),
  /** 同一實體腳位的別名，例如 A0 也是 D14。 */
  aliases: z.array(z.string()).default([]),
});
export type Pin = z.infer<typeof Pin>;

export const Evidence = z.object({
  field: z.string(),
  document_id: z.string().nullable(),
  page: z.number().int().nullable(),
  verification_status: z.enum(["verified", "unverified", "conflicted"]).default("unverified"),
});

export const Electrical = z.object({
  logic_voltage_v: z.number().optional(),
  supply_voltage_min_v: z.number().optional(),
  supply_voltage_max_v: z.number().optional(),
  recommended_gpio_current_ma: z.number().optional(),
  absolute_max_gpio_current_ma: z.number().optional(),
  input_high_threshold_v: z.number().optional(),
  input_low_threshold_v: z.number().optional(),
  quiescent_current_ma: z.number().optional(),
});
export type Electrical = z.infer<typeof Electrical>;

export const Geometry = z.object({
  asset_id: z.string(),
  units: z.literal("mm").default("mm"),
  coordinate_system: z.literal("right_handed_y_up").default("right_handed_y_up"),
  /** 包圍盒 (x=寬, y=高, z=深)，mm。3D 擺放與碰撞用。 */
  bbox_mm: z.tuple([z.number(), z.number(), z.number()]),
  desktop_model: z.string().optional(),   // GLB
  /**
   * 模型檔和 profile 座標系之間的對齊。第三方模型的原點、單位、朝向各不相同
   * （glTF 規範是公尺、KiCad 轉出來是 mm），在這裡一次說清楚，引擎不用猜。
   * 變換順序：scale × unit_scale → rotation → offset。
   */
  model_transform: z.object({
    unit_scale: z.number().default(1),                                  // 公尺模型填 1000
    scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
    rotation_deg: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
    offset_mm: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
    keep_materials: z.boolean().default(false),   // 模型自帶 PBR 材質與貼圖時保留
    tint_body: z.boolean().default(false),        // 用 profile 顏色覆蓋本體（同系列替代模型）
    /** 依網格／節點名稱指定材質（CAD 轉檔常掉顏色）。match 是正規式，第一個命中的生效。 */
    materials: z.array(z.object({
      match: z.string(),
      color: z.string(),
      metal: z.number().default(0),
      rough: z.number().default(0.5),
      transmission: z.number().default(0),
      env: z.number().optional(),   // 環境反射強度；大面金屬在強光板下容易糊成白斑，可以壓低
    })).optional(),
  }).optional(),
  /** 模型來源：vendor＝原廠／社群 CAD，datasheet＝依規格書程序生成，borrowed＝借用外形相同的模型 */
  model_source: z.enum(["vendor", "datasheet", "borrowed"]).optional(),
  mobile_model: z.string().optional(),    // USDZ
  /** 沒有 GLB 時的程序化外觀，讓引擎先畫得出來。 */
  placeholder: z.object({
    shape: z.enum(["box", "cylinder", "breadboard", "led", "resistor"]),
    color: z.string().default("#4b5563"),
  }).optional(),
});

/** 參數化元件（電阻值、LED 顏色…）的可調參數宣告。 */
export const ParameterSpec = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string().optional(),
  default: z.union([z.number(), z.string()]),
});

export const ComponentProfile = z.object({
  component_id: z.string(),
  manufacturer: z.string().optional(),
  display_name: z.string(),
  category: z.enum([
    "microcontroller_board", "breadboard", "passive", "led", "sensor",
    "display", "actuator", "power", "wire",
  ]),
  revision: z.string().optional(),
  electrical: Electrical.default({}),
  pins: z.array(Pin).default([]),
  parameters: z.array(ParameterSpec).default([]),
  geometry: Geometry,
  /** 模擬行為模型的識別碼，Runtime 層用。 */
  behavior_model: z.string().optional(),
  evidence: z.array(Evidence).default([]),
});
export type ComponentProfile = z.infer<typeof ComponentProfile>;

/** 取腳位，支援別名。 */
export function findPin(profile: ComponentProfile, pinId: string): Pin | undefined {
  return profile.pins.find((p) => p.id === pinId || p.aliases.includes(pinId));
}
