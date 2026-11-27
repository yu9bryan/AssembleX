/**
 * 讀規格書新增元件：把 datasheet（PDF 或圖片）交給 GPT-5.5，產出 ComponentProfile，
 * 驗證過格式與幾何規則才給使用者確認、存進元件庫。
 *
 * 誠實原則：
 *  - 所有從規格書讀出的電氣值與腳位都標 evidence（頁碼），verification_status 一律 "unverified"，
 *    元件庫會顯示「待查證」，直到有人對照原文確認。
 *  - 3D 外形依規格書尺寸程序生成（model_source: "datasheet"），不假裝是原廠模型。
 */
import { ComponentProfile, type ComponentProfile as Profile } from "@assemblex/circuit-schema";
import { getApiKey } from "./generate";
import { getComPdfKey, hasLocalComPdfKey, parseWithComPdf, sha256Hex, clearComPdfBroken, PDF_DAMAGED } from "./compdf";
import { SHAPE_HINTS, keywordShape, withShapeHint, sanitizeModel, type ShapeHint, type ModelPart } from "../engine3d/datasheetShape";

const MODEL = "gpt-5.5";

/** 規格書裡同一個數值寫了兩種（例如 3–5 V 和 12 V）：不讓 AI 自己挑，列出來給人選 */
export interface SpecConflict {
  field: string;            // electrical.supply_voltage_max_v
  label: string;            // 最高供電電壓
  /** file：第幾份檔案（1 起算；一次丟多份檔案時才有） */
  options: { value: number; page: number | null; quote: string; file?: number }[];
}
/** 一次匯入多份檔案時，每份檔案的出處 */
export interface SourceFile {
  fileName: string; sha256: string; parser: "compdf" | "pdf" | "image"; pages: number | null; tables?: number; compdfError?: string;
}
export interface DatasheetSource {
  fileName: string;
  sha256: string;
  /** compdf = ComPDF 解析後的結構化文字；pdf = GPT 直接讀原檔（沒有金鑰或 ComPDF 失敗時）；image = 圖片直接交給 AI（ComPDF 只收 PDF） */
  parser: "compdf" | "pdf" | "image";
  pageCount: number | null;
  tables: number;
  /** ComPDF 失敗的原因（有的話，介面要說出來，不默默退回） */
  compdfError?: string;
  /** ComPDF 金鑰已知無效：這次沒有呼叫 ComPDF（換金鑰前不再浪費一次請求） */
  compdfSkipped?: boolean;
  /** 一次匯入多份檔案（規格書＋機構圖＋腳位圖…）：每份的檔名、SHA-256、頁數。fileName／sha256 是合併顯示與第一份 */
  files?: SourceFile[];
}

/** 允許列為「規格衝突」的欄位：只有 profile 的電氣數值（都有單位）。其他欄位的不一致改列「沒寫清楚的地方」 */
export const ELEC_FIELDS: Record<string, [string, string]> = {
  supply_voltage_min_v: ["最低供電", "V"], supply_voltage_max_v: ["最高供電", "V"], logic_voltage_v: ["邏輯電壓", "V"],
  quiescent_current_ma: ["靜態電流", "mA"], recommended_gpio_current_ma: ["建議 GPIO 電流", "mA"],
  absolute_max_gpio_current_ma: ["GPIO 絕對最大電流", "mA"], input_high_threshold_v: ["輸入高電位門檻", "V"],
  input_low_threshold_v: ["輸入低電位門檻", "V"],
};
export const unitOf = (field: string) => ELEC_FIELDS[field.replace(/^electrical\./, "")]?.[1] ?? "";
export interface DatasheetResult {
  profile: Profile;
  source: DatasheetSource;
  conflicts: SpecConflict[];
  /** 每隻腳的出處頁碼（ComPDF 頁碼） */
  pinPages: Record<string, number | null>;
  /** 模型自己標出的不確定處（例如「腳距規格書沒寫，依常見封裝推定」） */
  uncertain: string[];
  /** 程式檢查出的提醒（不擋存檔，但要讓人看到） */
  warnings: string[];
  /** 規格書有沒有寫外形尺寸（AI 明確回報；沒回報就用備註推斷）。false＝推定，介面要請使用者量或確認 */
  sizeFound?: boolean;
  sizePage?: number | null;
  /** 尺寸出自第幾份檔案（多檔時） */
  sizeFile?: number | null;
  /** 每隻腳的出處是第幾份檔案（多檔時；1 起算） */
  pinFiles?: Record<string, number>;
  /** 用排線接頭（不是直接插麵包板的排針），例如「ZH1.5 4P」；沒有就 null */
  cable?: string | null;
  /** 依規格書機構圖／外觀照片生成的 3D 模型（基本形狀）；沒有圖面就是空的 */
  modelParts?: ModelPart[];
  /** 模型依據哪份檔案第幾頁的圖 */
  modelRef?: { file: number | null; page: number | null } | null;
}

const CATEGORY = ["passive", "led", "sensor", "display", "actuator", "power"];

function systemPrompt(existingIds: string[]): string {
  return `你是 AssembleX 的元件建檔引擎。使用者給你一份元件規格書（datasheet），你要讀出這個元件的資料，輸出一份 ComponentProfile JSON，讓它可以插在麵包板上、被電路設計與 3D 顯示使用。

只輸出一個 JSON 物件：{"profile": {...}, "shape_hint": "...", "size_found": {"found": true, "page": 5, "file": 1}, "connection": {"type": "breadboard_pins"}, "uncertain": ["規格書沒寫清楚、你是推定的地方，用繁體中文，一句一項"], "conflicts": [...]}
size_found：{"found": true 或 false, "page": 頁碼或 null, "file": 第幾份檔案}——任何一份檔案裡有沒有明確寫出整體外形尺寸：文字寫的長寬高、表格、機構圖／外形尺寸圖上標註的數字（包含圖片檔裡的標註）都算 true。bbox_mm 直接用那些標註的數字。完全沒有、是你從外觀照片估的才填 false
connection：{"type": "breadboard_pins" 或 "cable_connector", "connector": "接頭型號，例如 ZH1.5 4P（沒有就省略）"}——元件是用排針直接插麵包板，還是用排線接頭
多份檔案：使用者可能一次給同一個元件的好幾份檔案（規格書、機構圖、腳位圖、照片），全部合併成一個元件。任何一份有標整體尺寸（例如機構圖）就 size_found.found=true，並加 "file": 第幾份；conflicts 的每個 option 也加 "file"
model_parts（3D 模型）：如果檔案裡有機構圖、外形尺寸圖或產品照片，依圖面用基本形狀拼出元件外觀（最多 20 個）；沒有任何圖面就輸出 []。每個：
  {"shape": "box"|"rounded_box"|"cylinder"|"cone"|"dome"|"torus", "size": [...], "position": [x, y, z], "rotation_deg": [x, y, z], "color": "#hex", "material": "plastic"|"metal"|"rubber"|"pcb"|"glass", "label": "部件名"}
  - 座標 mm、y 朝上；原點＝元件底面中心（x 沿寬、z 沿深）；position 的 y 是這個形狀的「底面」高度；全部要在 bbox_mm 範圍內
  - 姿態：插在麵包板上（或平放）的樣子——電路板平放、感測面／鏡頭／探頭朝上（+y）
  - size：box／rounded_box＝[寬, 高, 深]；cylinder／cone／dome＝[直徑, 高]；torus＝[外徑, 管徑]
  - 要畫出圖上看得到的特徵：底座、上蓋、旋轉頭、鏡頭／感測窗（深色或 glass）、接頭插座、固定孔（深色小圓柱）、PCB 等；顏色照照片（看不出就用深灰）
  - 例（雷射雷達 38×38×34 mm）：深灰 rounded_box 底座 [38, 18, 38]、上面一個 cylinder 旋轉頭 [34, 14] 在 y=18、頭上一圈深色 glass 窗 [34.4, 6] 在 y=22、側面白色小 box 接頭
model_ref：{"file": 第幾份檔案, "page": 頁碼}——model_parts 依據的圖在哪裡；沒有圖就 null
shape_hint（3D 外形種類，依規格書的外觀圖選一個）：pir_dome（PIR 人體紅外線：白色半球透鏡）／ultrasonic_pair（超音波測距：兩顆圓筒探頭）／display（有螢幕面板）／module（其他電路板模組）
如果這份檔案根本不是電子元件的規格書（空白、無關文件、看不出任何腳位／尺寸／電氣規格），不要編造：輸出 {"profile": null, "reason": "用一句繁體中文說明看到了什麼"}

## profile 規則
- component_id：小寫英數與底線，以 "user_" 開頭，不能和這些重複：${existingIds.join(", ")}
- display_name：短名稱，型號＋6 個字以內的中文，例如「HC-SR501 人體紅外線」（完整名稱不要塞進來）
- manufacturer：規格書上的廠商（沒有就省略）
- category：只能是 ${CATEGORY.join(" / ")} 其中之一
- electrical：從規格書讀得到的才填（supply_voltage_min_v、supply_voltage_max_v、logic_voltage_v、quiescent_current_ma…），讀不到就不要填，不要猜
- pins：每一隻要插麵包板的腳
  - id：規格書上的腳名（VCC、GND、OUT、SDA…；沒有名字就用 "1"、"2"）
  - type：digital_io / analog_in / analog_out / power_in / power_out / ground / passive / nc
  - functions：用繁體中文短語，例如 ["I2C 資料"]、["數位輸出（偵測到為 HIGH）"]，沒有就 []
  - position_mm：[x, 0, z]，第一隻腳在 [0,0,0]；x 沿一排腳的方向、z 是排與排之間；直插（DIP/排針）腳距一律是 2.54 的整數倍
  - normal [0,-1,0]；connector_type 只能是 "male_header"（排針）或 "through_hole_lead"（元件腳）；用排線接頭的元件也填 "male_header"，接頭型號寫在 connection
- parameters：[]（除非是可調參數元件）
- geometry：{"asset_id": "<component_id>_v1", "bbox_mm": [寬 x, 高 y, 深 z]（規格書外形尺寸，mm）, "placeholder": {"shape": "box", "color": "<本體顏色 hex>"}, "model_source": "datasheet"}
  - 軸向一定要照這個定義（同一份規格書每次都要一樣）：寬 x＝沿排針那一排的方向；深 z＝板子在垂直排針方向的長度；高 y＝從板面到元件最高點（含探頭、透鏡、螢幕框，不含排針）
  - 例：HC-SR04 板子 45×20 mm、探頭高約 15 mm → [45, 15, 20]
- evidence：每個你填的電氣值一筆、每隻腳一筆，page 必須是你讀到它的頁碼（文件內容有「=== 第 N 頁 ===」標記時用那個 N）：
  - 電氣值：{"field": "electrical.supply_voltage_max_v", "document_id": "file1", "page": 2, "verification_status": "unverified"}（document_id 填第幾份檔案：file1、file2…）
  - 腳位：{"field": "pins.VCC", "document_id": "datasheet", "page": 1, "verification_status": "unverified"}（每隻腳各一筆，用腳的 id）

## conflicts（規格衝突）
- 只限這些電氣欄位：${Object.keys(ELEC_FIELDS).map((k) => "electrical." + k).join("、")}。其他資訊（尺寸、腳距、量測距離、角度…）前後不一致時寫進 uncertain，不要列進 conflicts
- 同一個電氣數值在文件裡出現不同的值（例如晶片 3–5 V、模組板 5–12 V），不要自己挑：列進 conflicts，每項
  {"field": "electrical.supply_voltage_max_v", "label": "最高供電電壓（中文）", "options": [{"value": 5, "page": 1, "quote": "原文短句（20 字內）"}, {"value": 12, "page": 2, "quote": "…"}]}
- profile 裡這個欄位先填比較保守（比較不會燒壞元件）的值
- 典型值（typ、「輸入電壓 5V」）和範圍（min／max，例如 4.5–5.5 V）不算衝突：min／max 用範圍，典型值落在範圍內就不要列
- 沒有衝突就輸出 "conflicts": []

## 注意
- 這是麵包板用的元件：SMD 晶片若規格書只給晶片本身，請以常見的 DIP／模組板（排針 2.54mm）建檔，並在 uncertain 說明。
- 讀不到的就寫進 uncertain，不要編造數字。
- uncertain 只能用一般中文描述，不能出現欄位名（bbox_mm、parameters、pins、position_mm…）；數值範圍寫成「3–5 V」。`;
}

async function fileToPart(file: File): Promise<Record<string, unknown>> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return { type: "input_file", filename: file.name, file_data: `data:application/pdf;base64,${b64}` };
  }
  return { type: "input_image", image_url: `data:${file.type || "image/png"};base64,${b64}` };
}

function extractJson(text: string): unknown {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("回覆裡沒有 JSON");
  return JSON.parse(text.slice(s, e + 1));
}

/** 程式檢查：格式之外的幾何規則（腳距、重複腳名、尺寸） */
export function checkProfile(p: Profile): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (!p.pins.length) errors.push("沒有讀到任何腳位");
  const ids = p.pins.map((x) => x.id.trim());
  if (ids.some((x) => !x)) errors.push("有腳位沒有名稱");
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) errors.push(`腳名重複：${[...new Set(dup)].join("、")}`);
  if (p.geometry.bbox_mm.some((v) => !(v > 0))) errors.push("外形尺寸缺少或不是正數");
  const off = p.pins.filter((x) => [x.position_mm[0], x.position_mm[2]].some((v) => Math.abs(v / 2.54 - Math.round(v / 2.54)) > 0.05));
  if (off.length) warnings.push(`這些腳不在 2.54mm 格點上，插麵包板會對不準：${off.map((x) => x.id).join("、")}`);
  if (p.pins[0] && (p.pins[0].position_mm[0] !== 0 || p.pins[0].position_mm[2] !== 0)) warnings.push("第一隻腳不在原點，擺放時會整體偏移");
  if (!Object.keys(p.electrical).length) warnings.push("規格書沒有讀到任何電氣數值");
  return { errors, warnings };
}

/** 讀規格書丟出的錯誤：retryable=false 表示同一個檔案再試也一樣（格式不對、不是規格書），介面不給「重試」；
 *  compdfError：ComPDF 先失敗過（例如 403），不能因為 OpenAI 接著也失敗就把它蓋掉 */
export type DatasheetError = Error & { retryable?: boolean; compdfError?: string; status?: number };
const fatal = (msg: string): DatasheetError => Object.assign(new Error(msg), { retryable: false });

/** 不用讀檔內容就能判斷的錯誤（格式、大小）：介面在做任何慢的事之前先檢查，錯的檔案立刻說 */
export function quickCheck(file: File): string | null {
  if (file.size > 20 * 1024 * 1024) return "檔案超過 20 MB，請先擷取有腳位圖與尺寸圖的頁面";
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImg = /^image\/(png|jpe?g|webp|gif)$/.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
  if (!isPdf && !isImg) return `只支援 PDF 或圖片（PNG／JPG／WebP）的規格書，這個檔案是 ${(file.name.match(/\.[^.]+$/) ?? ["未知格式"])[0]}`;
  if (file.size < 200) return "檔案是空的或太小，請確認選對了檔案";
  return null;
}

/** 讀檔頭／檔尾的檢查（副檔名被改、HTML 另存、下載中斷）。沒問題回 null。多檔時介面先逐份檢查，壞的那份可以單獨移除 */
export async function checkFile(file: File): Promise<string | null> {
  const bad = quickCheck(file);
  if (bad) return bad;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (/^(\uFEFF|\xEF\xBB\xBF)?\s*<(!doctype\s+html|html)/i.test(ascii))
    return "這是網頁（HTML），不是 PDF：請在規格書頁面按下載 PDF，或用瀏覽器『列印 → 存成 PDF』";
  if (isPdf) {
    if (!ascii.includes("%PDF-")) return "這個檔案不是有效的 PDF（可能改了副檔名或檔案已損壞）。請重新下載規格書，或改上傳截圖";
    const tailTxt = String.fromCharCode(...new Uint8Array(await file.slice(Math.max(0, file.size - 2048)).arrayBuffer()));
    if (!tailTxt.includes("%%EOF") || !/startxref|xref/.test(tailTxt)) return PDF_DAMAGED;
    return null;
  }
  const realImg = (head[0] === 0x89 && ascii.slice(1, 4) === "PNG") || (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    || ascii.startsWith("GIF8") || (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP");
  return realImg ? null : "這個檔案不是有效的圖片（可能改了副檔名或檔案已損壞）。請重新截圖，或改上傳 PDF 規格書";
}
/** 一次送給 AI 的檔案合計上限 */
export const MAX_TOTAL = 20 * 1024 * 1024;

export interface DatasheetOptions {
  /** ComPDF 金鑰已知無效：直接跳過 ComPDF */
  skipComPdf?: boolean;
  /** ComPDF 一失敗就通知（不用等整個 AI 讀完才知道） */
  onComPdfError?: (msg: string) => void;
}

export async function profileFromDatasheet(
  input: File | File[], existingIds: string[], onStage: (s: string) => void, signal?: AbortSignal, opts: DatasheetOptions = {},
): Promise<DatasheetResult> {
  const files = Array.isArray(input) ? input : [input];
  const multi = files.length > 1;
  const apiKey = getApiKey();
  if (!apiKey) throw fatal("還沒設定 OpenAI API 金鑰");
  if (!files.length) throw fatal("沒有選檔案");
  // 每份檔案先檢查（格式、大小、檔頭）：壞的那份講檔名
  for (const f of files) {
    const bad = await checkFile(f);
    if (bad) throw fatal(multi ? `「${f.name}」：${bad}` : bad);
  }
  if (multi && files.reduce((a, f) => a + f.size, 0) > MAX_TOTAL) throw fatal("這幾份檔案合計超過 20 MB：請移除一些，或只留有腳位圖與尺寸圖的頁面");
  onStage(`步驟 1/4：讀取檔案 · 計算 SHA-256${multi ? `（${files.length} 份）` : ""}`);
  const shas = await Promise.all(files.map((f) => sha256Hex(f)));
  const isPdfF = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const nPdf = files.filter(isPdfF).length;
  const srcFiles: SourceFile[] = files.map((f, i) => ({ fileName: f.name, sha256: shas[i], parser: isPdfF(f) ? "pdf" : "image", pages: null }));
  const parts: Record<string, unknown>[] = [];
  let skip = !!opts.skipComPdf, compdfError: string | undefined, compdfSkipped = false, pdfK = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], sf = srcFiles[i];
    const tag = multi ? `檔案 ${i + 1}：${f.name}` : "";
    // ComPDF 只收 PDF：圖片直接給 AI（送過去只會得到格式錯誤）
    if (isPdfF(f) && getComPdfKey() && skip) compdfSkipped = true;
    if (isPdfF(f) && getComPdfKey() && !skip) {
      pdfK++;
      onStage(nPdf > 1 ? `步驟 2/4：ComPDF 解析 ${pdfK}/${nPdf} 份（${f.name}）` : "步驟 2/4：ComPDF 解析文件（OCR、版面、表格、頁碼）");
      try {
        const doc = await parseWithComPdf(f, signal);
        sf.parser = "compdf"; sf.pages = doc.pageCount; sf.tables = doc.tables;
        clearComPdfBroken();
        // 多檔：每頁標記改成「=== 檔案 k：name · 第 N 頁 ===」，AI 才能分清楚是哪份的第幾頁
        const tagged = multi ? doc.tagged.replace(/=== 第 (\d+) 頁 ===/g, `=== ${tag} · 第 $1 頁 ===`) : doc.tagged;
        parts.push({ type: "input_text", text: multi
          ? `以下是 ComPDF 從${tag}解析出的內容（共 ${doc.pageCount} 頁，每頁前有「=== ${tag} · 第 N 頁 ===」標記，表格已轉成 Markdown）：\n\n${tagged.slice(0, Math.floor(150000 / files.length))}`
          : `以下是 ComPDF 從規格書「${f.name}」解析出的內容（共 ${doc.pageCount} 頁，每頁前有「=== 第 N 頁 ===」標記，表格已轉成 Markdown）。頁碼以這份標記為準；腳位圖、尺寸圖在附上的原檔裡：\n\n${tagged.slice(0, 150000)}` });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        if ((e as { damaged?: boolean }).damaged) throw fatal(multi ? `「${f.name}」：${PDF_DAMAGED}` : PDF_DAMAGED);
        sf.compdfError = (e as Error).message;
        compdfError ??= sf.compdfError;
        opts.onComPdfError?.(sf.compdfError);
        // 金鑰問題：其他份也不用再試
        if (/金鑰無效|沒有權限|\b40[13]\b/.test(sf.compdfError)) skip = true;
        onStage(`步驟 2/4：ComPDF 失敗${multi ? `（${f.name}）` : ""}：${sf.compdfError.replace(/^ComPDF\s*/, "").replace(/[。.]$/, "")}，改由 AI 直接讀原檔`);
      }
    } else if (!multi) {
      onStage(compdfSkipped ? (hasLocalComPdfKey() ? "步驟 2/4：ComPDF 金鑰無效，已略過" : "步驟 2/4：內建的 ComPDF 金鑰暫時無法使用，已略過") : isPdfF(f) ? "步驟 2/4：準備原檔" : "步驟 2/4：圖片直接交給 AI");
    }
    if (multi) parts.push({ type: "input_text", text: `（以下是${tag}的原檔）` });
    parts.push(await fileToPart(f));
  }
  const first = srcFiles[0];
  const source: DatasheetSource = {
    fileName: srcFiles.map((x) => x.fileName).join("、"), sha256: first.sha256,
    parser: srcFiles.every((x) => x.parser === "image") ? "image" : srcFiles.some((x) => x.parser === "compdf") ? "compdf" : "pdf",
    pageCount: srcFiles.some((x) => x.pages != null) ? srcFiles.reduce((a, x) => a + (x.pages ?? 0), 0) : null,
    tables: srcFiles.reduce((a, x) => a + (x.tables ?? 0), 0),
    ...(compdfError ? { compdfError } : {}), ...(compdfSkipped ? { compdfSkipped } : {}),
    ...(multi ? { files: srcFiles } : {}),
  };
  try {
    return await askModel(files, existingIds, onStage, signal, apiKey, shas, source, parts);
  } catch (e) {
    if (source.compdfError && e instanceof Error) (e as DatasheetError).compdfError = source.compdfError;
    throw e;
  }
}

async function askModel(files: File[], existingIds: string[], onStage: (s: string) => void, signal: AbortSignal | undefined,
                        apiKey: string, shas: string[], source: DatasheetSource, parts: Record<string, unknown>[]): Promise<DatasheetResult> {
  const multi = files.length > 1;
  /** document_id「file2」→ 第 2 份（1 起算）；沒寫就當第 1 份 */
  const fileIdx = (doc: unknown) => { const m = String(doc ?? "").match(/file\s*(\d+)/i); const k = m ? Number(m[1]) : 1; return k >= 1 && k <= files.length ? k : 1; };
  let lastProblems: string[] = [];
  let prevRaw: { shape_hint?: unknown; size_found?: unknown; connection?: unknown; model_parts?: unknown; model_ref?: unknown } = {};
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 內部格式錯誤（例如「display_name: Required」）只進 console，進度列講人話
    if (attempt > 1) console.info("[datasheet] AI 回傳格式問題，重試", attempt - 1, lastProblems);
    onStage(attempt === 1 ? (source.parser === "compdf" ? "步驟 3/4：AI 從 ComPDF 解析結果擷取腳位、尺寸、電氣規格" : "步驟 3/4：AI 閱讀規格書（腳位、尺寸、電氣規格）")
                          : `步驟 3/4：AI 回傳的格式不完整，自動重新整理中（第 ${attempt - 1} 次）`);
    const userContent: Record<string, unknown>[] = [...parts, { type: "input_text", text:
      attempt === 1 ? (multi ? `這 ${files.length} 份檔案是同一個元件的資料（${files.map((f, i) => `檔案 ${i + 1}：${f.name}`).join("、")}）：請合併成一份元件資料。evidence 的 document_id 填 file1、file2…（第幾份檔案），page 用那份檔案的頁碼。`
                                : `請替這份規格書（${files[0].name}）建立元件資料。`)
                    : `上一次的結果有這些問題，請修正後重新輸出完整 JSON（profile、shape_hint、size_found、connection、uncertain、conflicts 全部都要）：\n- ${lastProblems.join("\n- ")}` }];
    const tmo = AbortSignal.timeout(300_000);
    const sig = signal ? AbortSignal.any([signal, tmo]) : tmo;
    let res: Response;
    try { res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: sig,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, reasoning: { effort: "medium" }, max_output_tokens: 32000,
                             input: [{ role: "system", content: systemPrompt(existingIds) }, { role: "user", content: userContent }] }),
    }); } catch (e) {
      if (signal?.aborted) throw e;
      if (tmo.aborted) { lastProblems = ["AI 超過 5 分鐘沒有回應"]; continue; }
      throw Object.assign(new Error(`連不上 OpenAI：${(e as Error).message}`), { name: "TypeError" });
    }
    const data = await res.json().catch(() => null) as { error?: { message?: string }; output_text?: string;
      output?: { type: string; content?: { type: string; text?: string }[] }[] } | null;
    if (!res.ok) throw Object.assign(new Error(`OpenAI 回應錯誤：${data?.error?.message ?? res.status}`), { status: res.status });
    const text = data?.output_text ?? (data?.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    onStage("步驟 4/4：檢查格式與腳位");
    let raw: { profile?: unknown; uncertain?: string[]; conflicts?: unknown; reason?: string; shape_hint?: unknown;
               size_found?: { found?: unknown; page?: unknown; file?: unknown }; connection?: { type?: unknown; connector?: unknown };
               model_parts?: unknown; model_ref?: { file?: unknown; page?: unknown } | null };
    try { raw = extractJson(text) as typeof raw; } catch (e) { lastProblems = [`JSON 解析失敗：${(e as Error).message}`]; continue; }
    if (raw.profile === null) {
      // AI 的理由常常已經說了「不是規格書／是空白圖」：不要再前面加一次同樣的話
      const why = (raw.reason ?? "找不到腳位、尺寸或電氣規格").trim().replace(/[。．.！!]+$/, "");
      const lead = /不是.*規格書|空白|沒有.*(內容|文字)|無關/.test(why) ? why : `這份檔案看起來不是元件規格書：${why}`;
      throw fatal(`${lead}。請上傳有腳位圖與尺寸的 datasheet（掃描檔請挑那幾頁）。`);
    }
    // 修正回合 AI 常漏掉 profile 以外的欄位：沿用上一輪的
    for (const k of ["shape_hint", "size_found", "connection", "model_parts", "model_ref"] as const) if (raw[k] == null && prevRaw[k] != null) (raw as Record<string, unknown>)[k] = prevRaw[k];
    prevRaw = raw;
    // 接頭型別填了清單外的值（例如 cable_connector）：改成排針、記成排線接頭，不要為這個整個重讀一次
    const rp = raw.profile as { pins?: { connector_type?: unknown }[] } | null | undefined;
    if (rp && Array.isArray(rp.pins)) for (const q of rp.pins) {
      if (q && typeof q.connector_type === "string" && !["male_header", "female_header", "through_hole_lead", "smd_pad", "barrel_jack", "usb"].includes(q.connector_type)) {
        if (/cable|connector|wire|排線|接頭/i.test(q.connector_type) && raw.connection == null) raw.connection = { type: "cable_connector" };
        q.connector_type = "male_header";
      }
    }
    const parsed = ComponentProfile.safeParse(raw.profile);
    if (!parsed.success) { lastProblems = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`); continue; }
    const profile: Profile = { ...parsed.data, geometry: { ...parsed.data.geometry, model_source: "datasheet", desktop_model: undefined },
      evidence: parsed.data.evidence.map((e) => ({ ...e, document_id: `sha256:${shas[fileIdx(e.document_id) - 1].slice(0, 16)}`, verification_status: "unverified" as const })) };
    // 腳位出自第幾份檔案（document_id 改寫成 sha 之前先記下）
    const evFile = new Map(parsed.data.evidence.map((e) => [e.field, fileIdx(e.document_id)]));
    // 同一份規格書每次讀的腳位順序可能不同：一律依位置排（先排、再同排由左到右），表格順序穩定
    profile.pins = [...profile.pins].sort((a, b) => a.position_mm[2] - b.position_mm[2] || a.position_mm[0] - b.position_mm[0]);
    // component_id 由程式依型號決定（AI 每次取的 id 不同，同一個元件會變成好幾個）
    profile.component_id = stableId(profile);
    if (existingIds.includes(profile.component_id)) profile.component_id = `${profile.component_id}_c${Date.now().toString(36)}`;
    // 名稱要以主名詞結尾（「人體紅外線」→「人體紅外線感測器」）
    const NOUN: Record<string, string> = { sensor: "感測器", display: "顯示器", actuator: "致動器", power: "電源模組", led: "LED", passive: "元件" };
    const noun = NOUN[profile.category];
    if (noun && !/(器|模組|元件|LED|板|電阻|電容|二極體|晶片)$/.test(profile.display_name)) profile.display_name += noun;
    // 3D 外形種類：AI 給的優先，否則依名稱關鍵字（placeholder.shape 是固定列舉，所以記在 asset_id 字尾）
    // 認不出來（AI 說 module 或沒給、名稱也沒有關鍵字）：用中性方塊「外形示意」，不畫假的電路板
    const ai = SHAPE_HINTS.includes(raw.shape_hint as ShapeHint) ? raw.shape_hint as ShapeHint : null;
    // 有依圖面生成的模型就用它（至少 2 個形狀才算看得出樣子）；PIR／超音波這類程序外形還是比較準，優先
    const modelParts = sanitizeModel(raw.model_parts, profile.geometry.bbox_mm);
    const kw = (ai && ai !== "module" && ai !== "box" && ai !== "model" ? ai : null) ?? keywordShape(profile);
    const hint: ShapeHint = kw ?? (modelParts.length >= 2 ? "model" : "box");
    profile.geometry = { ...profile.geometry, asset_id: withShapeHint(`${profile.component_id}_v1`, hint) };
    // 超音波模組：高＝探頭高度（較小的那個）、深＝板子長度（較大的），不隨 AI 每次讀法對調
    if (hint === "ultrasonic_pair") {
      const [bw, bh, bd] = profile.geometry.bbox_mm;
      profile.geometry.bbox_mm = [bw, Math.min(bh, bd), Math.max(bh, bd)];
    }
    const { errors, warnings } = checkProfile(profile);
    if (errors.length) { lastProblems = errors; continue; }
    // 規格衝突：只收電氣數值、至少兩個不同的值
    const uncertain = [...(raw.uncertain ?? [])];
    const conflicts0: SpecConflict[] = (Array.isArray(raw.conflicts) ? raw.conflicts : []).flatMap((c) => {
      const o = c as { field?: unknown; label?: unknown; options?: unknown };
      if (typeof o.field !== "string" || !Array.isArray(o.options)) return [];
      if (!ELEC_FIELDS[o.field.replace(/^electrical\./, "")]) {
        // 不是電氣數值（沒有單位、不影響接線安全）：不擋加入，改列「沒寫清楚的地方」
        const vals = o.options.map((x) => x as { value?: unknown; page?: unknown })
          .map((x) => `${String(x.value)}${typeof x.page === "number" ? `（第 ${x.page} 頁）` : ""}`).join("、");
        uncertain.push(`${typeof o.label === "string" ? o.label : o.field}：規格書前後寫了不同的值 ${vals}`);
        return [];
      }
      const opts = o.options.map((x) => x as { value?: unknown; page?: unknown; quote?: unknown; file?: unknown })
        .filter((x) => typeof x.value === "number" && isFinite(x.value))
        .map((x) => ({ value: x.value as number, page: typeof x.page === "number" ? x.page : null, quote: typeof x.quote === "string" ? x.quote.slice(0, 60) : "",
                       ...(multi && typeof x.file === "number" && x.file >= 1 && x.file <= files.length ? { file: x.file } : {}) }));
      const uniq = opts.filter((x, i) => opts.findIndex((y) => y.value === x.value) === i);
      const field = o.field.startsWith("electrical.") ? o.field : `electrical.${o.field}`;
      return [{ field, label: typeof o.label === "string" ? o.label : ELEC_FIELDS[field.replace("electrical.", "")][0], options: uniq }];
    });
    // 同一欄位被拆成好幾組（每次讀法不同）：依欄位合併、同值只留一個、依數值排序，至少兩個不同值才算衝突
    const byField = new Map<string, SpecConflict>();
    for (const c of conflicts0) {
      const m = byField.get(c.field);
      if (!m) { byField.set(c.field, { ...c, options: [...c.options] }); continue; }
      for (const o of c.options) if (!m.options.some((x) => x.value === o.value)) m.options.push(o);
    }
    const conflicts = [...byField.values()].map((c) => ({ ...c, options: [...c.options].sort((a, b) => a.value - b.value) })).filter((c) => c.options.length >= 2);
    // 外形已經由種類決定（PIR 半球、超音波探頭）：拿掉「外觀／形狀沒寫清楚」這類和畫面矛盾的備註（尺寸、顏色的備註保留）
    if (hint !== "module" && hint !== "box") {
      for (let i = uncertain.length - 1; i >= 0; i--)
        if (/外觀|形狀|造型|外形/.test(uncertain[i]) && !/尺寸|mm|\d|顏色|色/.test(uncertain[i])) uncertain.splice(i, 1);
    }
    const pinPages: Record<string, number | null> = {};
    const pinFiles: Record<string, number> = {};
    for (const pin of profile.pins) {
      pinPages[pin.id] = profile.evidence.find((e) => e.field === `pins.${pin.id}`)?.page ?? null;
      if (multi) pinFiles[pin.id] = evFile.get(`pins.${pin.id}`) ?? 1;
    }
    if (source.parser === "compdf" && Object.values(pinPages).some((v) => v == null)) warnings.push("有些腳位沒有標出處頁碼，請對照原文");
    // 尺寸有沒有寫：AI 明確回報優先，沒回報才看備註有沒有提到尺寸是推定的
    console.info("[datasheet] size_found", raw.size_found, "connection", raw.connection);
    const sizeFound = typeof raw.size_found?.found === "boolean" ? raw.size_found.found as boolean : !sizeMissing({ uncertain });
    const sizePage = typeof raw.size_found?.page === "number" ? raw.size_found.page as number : null;
    const sizeFile = multi && typeof raw.size_found?.file === "number" ? raw.size_found.file as number : null;
    // 排線接頭：AI 回報，或腳位接頭型別不是排針／插腳，或備註提到排線、接頭型號
    const cableText = [...uncertain, ...profile.pins.flatMap((q) => q.functions)].join(" ");
    const cable = raw.connection?.type === "cable_connector"
      ? (typeof raw.connection.connector === "string" && raw.connection.connector.trim() ? raw.connection.connector.trim() : "排線接頭")
      : profile.pins.some((q) => !["male_header", "female_header", "through_hole_lead"].includes(q.connector_type))
        || /排線|線材接頭|cable|ZH\s?1\.5|JST|PH\s?2\.0|GH\s?1\.25/i.test(cableText) ? "排線接頭" : null;
    const mr = raw.model_ref;
    const modelRef = modelParts.length && mr ? { file: typeof mr.file === "number" ? mr.file : null, page: typeof mr.page === "number" ? mr.page : null } : null;
    return { profile, uncertain, warnings, source, conflicts, pinPages, sizeFound, sizePage, cable, modelParts, modelRef, ...(multi ? { pinFiles, sizeFile } : {}) };
  }
  console.info("[datasheet] 三次都失敗", lastProblems);
  throw new Error(lastProblems.some((x) => /超過 5 分鐘/.test(x))
    ? "AI 超過 5 分鐘沒有回應，請按「重試」；一直這樣的話，改上傳只有腳位圖與尺寸圖的那幾頁"
    : "AI 試了三次都沒有回傳完整的元件資料，請按「重試」；一直失敗的話，改上傳只有腳位圖與尺寸圖的那幾頁");
}

/** 使用者新增的元件存在這台電腦（不會寫回 data/components） */
const KEY = "assemblex.customParts";
export function loadCustomProfiles(): Profile[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown[];
    return list.map((x) => ComponentProfile.safeParse(x)).filter((r) => r.success).map((r) => r.data);
  } catch { return []; }
}
/** 存不了（儲存空間滿、無痕模式）回傳 false */
export function saveCustomProfiles(list: Profile[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** 每個自建元件的出處（原檔名、SHA-256、腳位頁碼、規格衝突與使用者的選擇），查證、修改時對回原文用 */
export type StoredSource = DatasheetSource & {
  pinPages?: Record<string, number | null>;
  conflicts?: SpecConflict[];
  chosen?: Record<string, number>;
  /** 尺寸來源：datasheet＝規格書有寫；user＝使用者量的；estimate＝推定（3D 只是示意） */
  sizeSource?: "datasheet" | "user" | "estimate";
  /** 多檔時每隻腳出自第幾份檔案 */
  pinFiles?: Record<string, number>;
  /** 加入的時間（ms）；同一份規格書再匯入時告訴使用者「你在哪天加入過」 */
  addedAt?: number;
};
/** 同一份規格書（SHA-256 相同）已經加入過、而且元件還在：回傳那個元件 id */
export function findBySha(sha: string, exists: (id: string) => boolean): { id: string; src: StoredSource } | null {
  for (const [id, src] of Object.entries(loadSources()))
    if ((src.sha256 === sha || src.files?.some((f) => f.sha256 === sha)) && exists(id)) return { id, src };
  return null;
}
const SOURCES = "assemblex.datasheetSources";
export function loadSources(): Record<string, StoredSource> {
  try { return JSON.parse(localStorage.getItem(SOURCES) ?? "{}") as Record<string, StoredSource>; } catch { return {}; }
}
/** src = null 表示刪掉這筆 */
export function saveSource(id: string, src: StoredSource | null): boolean {
  try {
    const all = loadSources();
    if (src) all[id] = src; else delete all[id];
    localStorage.setItem(SOURCES, JSON.stringify(all));
    return true;
  } catch { return false; }
}

/**
 * 這個（從規格書讀出的）元件是不是和某個內建元件同型號？是的話回傳內建元件的 id。
 * 規則：英文字母＋數字的型號片段（HC-SR04、SSD1306…）出現在內建元件的名稱或 id；
 * 或型號只有數字（BB830 ↔ 「830 孔麵包板」）而且是同一類東西（麵包板、伺服馬達、OLED、LCD）。
 * AI 設計挑元件時也用它：同型號就用內建的（有原廠 CAD 模型），不要用規格書生成的方塊。
 */
/** 型號片段：字母＋數字（HC-SR04 → hcsr04、SSD1306 → ssd1306），比對同型號用 */
const MODEL_RE = /[A-Za-z]+(?:[-_]?[A-Za-z]+)*[-_ ]?\d+[A-Za-z0-9]*(?:-[A-Za-z0-9]+)?/g;
function modelKeys(p: Profile): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const fromName = p.display_name.match(MODEL_RE) ?? [];
  const fromId = p.component_id.startsWith("user_") ? [p.component_id.replace(/^user_/, "").replace(/_c?[a-z0-9]{8}$/, "")] : [];
  return [...fromName, ...fromId].map(norm).filter((k) => k.length >= 4 && /\d/.test(k));
}
const sameModel = (a: string[], b: string[]) => a.some((x) => b.some((y) => x === y || (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x)))));
/** 依型號決定的 component_id（user_ + 型號；沒有型號才用廠商＋AI 給的 id） */
export function stableId(p: Profile): string {
  const m = p.display_name.match(MODEL_RE);
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (m) return `user_${clean(m[0]).replace(/_/g, "")}`;
  const base = clean(p.component_id.replace(/^user_/, ""));
  return `user_${p.manufacturer && !base.startsWith(clean(p.manufacturer)) ? clean(p.manufacturer) + "_" : ""}${base}`.slice(0, 48);
}
/** 這個元件是不是已經新增過（同型號的自建元件）？回傳那個元件的 id；excludeId 是自己 */
export function customTwinOf(p: Profile, profiles: Map<string, Profile> | Iterable<Profile>, excludeId?: string): string | null {
  const list = profiles instanceof Map ? [...profiles.values()] : [...profiles];
  const keys = modelKeys(p);
  const mine = list.filter((q) => q.component_id.startsWith("user_") && q.component_id !== excludeId);
  const hit = mine.find((q) => q.component_id === p.component_id)
    ?? (keys.length ? mine.find((q) => sameModel(modelKeys(q), keys)) : undefined)
    // 沒有型號（例如「PIR 人體紅外線感測器」）：同類別、同一組腳名，再加上同廠商或名稱很像，就當成同一個元件
    ?? mine.find((q) => !modelKeys(q).length || !keys.length ? similarPart(p, q) : false);
  return hit?.component_id ?? null;
}
function similarPart(a: Profile, b: Profile): boolean {
  if (a.category !== b.category) return false;
  const pinSet = (x: Profile) => x.pins.map((q) => q.id.trim().toLowerCase()).sort().join(",");
  if (pinSet(a) !== pinSet(b)) return false;
  const mfr = (x: Profile) => (x.manufacturer ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").replace(/(industries|inc|co|ltd|corp|company)+$/g, "");
  if (mfr(a) && mfr(a) === mfr(b)) return true;
  // 名稱相似：英數詞＋中文單字的 Jaccard
  const toks = (x: Profile) => new Set((x.display_name.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []).filter((t) => !/^(感|測|器|模|組)$/.test(t)));
  const ta = toks(a), tb = toks(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(1, new Set([...ta, ...tb]).size) >= 0.5;
}

/** 規格書沒寫尺寸？AI 明確回報（size_found）優先；沒回報時，只有備註說尺寸是推定／沒寫、而且備註裡沒有「寬×深×高」數字才算沒寫 */
export function sizeMissing(r: { sizeFound?: boolean; uncertain: string[] }): boolean {
  if (r.sizeFound != null) return !r.sizeFound;
  const dims = /\d+(\.\d+)?\s*(mm)?\s*[×xX*＊]\s*\d+(\.\d+)?/;
  return r.uncertain.some((x) => /(尺寸|外形|bbox|dimension)/i.test(x) && /推定|估|沒有|未|不明|not/i.test(x) && !dims.test(x));
}

export function builtInTwinOf(p: Profile, profiles: Map<string, Profile> | Iterable<Profile>): string | null {
  const list = profiles instanceof Map ? [...profiles.values()] : [...profiles];
  const builtIns = list.filter((q) => !q.component_id.startsWith("user_"));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const keys = [p.display_name, p.component_id.replace(/^user_/, "")].map(norm).flatMap((k) => k.match(/[a-z]+\d+[a-z0-9]*/g) ?? []);
  const byModel = builtIns.find((q) => keys.some((k) => k.length >= 4 && (norm(q.display_name).includes(k) || norm(q.component_id).includes(k))));
  if (byModel) return byModel.component_id;
  const text = (q: Profile) => `${q.display_name} ${q.component_id} ${q.manufacturer ?? ""}`.toLowerCase();
  const KIND = [/breadboard|麵包板|\bbb[-_ ]?\d/, /servo|伺服/, /oled/, /lcd|液晶/];
  const nums = text(p).match(/\d{3,}/g) ?? [];
  const byNum = builtIns.find((q) => nums.some((n) => (text(q).match(/\d{3,}/g) ?? ([] as string[])).includes(n))
    && KIND.some((re) => re.test(text(p)) && re.test(text(q))));
  return byNum?.component_id ?? null;
}

/**
 * 「重新生成 3D」：只請 AI 依圖面重拼模型（不重讀腳位、電氣），附上原檔讓它看機構圖／照片。
 * 回傳空陣列表示找不到可用的圖面。
 */
export async function regenerateModel(files: File[], p: Profile, signal?: AbortSignal): Promise<{ parts: ModelPart[]; ref: { file: number | null; page: number | null } | null }> {
  const apiKey = getApiKey();
  if (!apiKey) throw fatal("還沒設定 OpenAI API 金鑰");
  const [w, h, d] = p.geometry.bbox_mm;
  const parts: Record<string, unknown>[] = [];
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) parts.push({ type: "input_text", text: `（以下是檔案 ${i + 1}：${files[i].name}）` });
    parts.push(await fileToPart(files[i]));
  }
  parts.push({ type: "input_text", text: `元件：${p.display_name}（${p.manufacturer ?? ""}），外形 寬 ${w} × 高 ${h} × 深 ${d} mm。
請只依檔案裡的機構圖、外形尺寸圖或產品照片，用基本形狀拼出這個元件的 3D 外觀。只輸出 JSON：{"model_parts": [...], "model_ref": {"file": 第幾份, "page": 頁碼}}；沒有任何圖面就輸出 {"model_parts": [], "model_ref": null}。
每個形狀：{"shape": "box"|"rounded_box"|"cylinder"|"cone"|"dome"|"torus", "size": [...], "position": [x, y, z], "rotation_deg": [x, y, z], "color": "#hex", "material": "plastic"|"metal"|"rubber"|"pcb"|"glass", "label": "部件名"}
座標 mm、y 朝上；原點＝元件底面中心；position 的 y 是形狀底面高度；全部要在外形範圍內。
姿態：畫成插在麵包板上（或平放在桌上）的樣子——電路板平放（板厚是 y），感測面、鏡頭、探頭、螢幕朝上（+y），接頭／排針在底面或側面。size：box／rounded_box＝[寬, 高, 深]；cylinder／cone／dome＝[直徑, 高]；torus＝[外徑, 管徑]。最多 20 個，畫出圖上看得到的特徵（底座、上蓋、旋轉頭、感測窗、接頭、固定孔…）。` });
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, reasoning: { effort: "medium" }, max_output_tokens: 16000, input: [{ role: "user", content: parts }] }),
  });
  const data = await res.json().catch(() => null) as { error?: { message?: string }; output_text?: string; output?: { content?: { type: string; text?: string }[] }[] } | null;
  if (!res.ok) throw Object.assign(new Error(`OpenAI 回應錯誤：${data?.error?.message ?? res.status}`), { status: res.status });
  const text = data?.output_text ?? (data?.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
  const raw = extractJson(text) as { model_parts?: unknown; model_ref?: { file?: unknown; page?: unknown } | null };
  const out = sanitizeModel(raw.model_parts, p.geometry.bbox_mm);
  const mr = raw.model_ref;
  return { parts: out, ref: out.length && mr ? { file: typeof mr.file === "number" ? mr.file : null, page: typeof mr.page === "number" ? mr.page : null } : null };
}
