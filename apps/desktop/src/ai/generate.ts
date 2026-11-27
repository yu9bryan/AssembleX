import { boardOf, boardPlacement } from "../data/boards";
import { builtInTwinOf } from "./datasheet";
import { bbSpecOf } from "../stores/projectStore";
import { getStoredModel } from "../engine3d/datasheetShape";

/** 插不進麵包板的元件（排線接頭，或腳距不是 2.54mm）：外接在板子旁邊，用排線轉杜邦線接過去 */
export const isExternalPart = (p: ComponentProfile) => offGridPins(p) || !!getStoredModel(p.component_id)?.cable;
import {
  CircuitIR, optimizeLayout, fixEdgeModules, placeOffBoard, offGridPins, isEdgeModule, runElectricalChecks, detectIsolatedParts, detectPartOverlaps, footprintErrors, blockedHoleErrors, routeWires, findWireCollisions, countPlanCrossings, type ComponentProfile, type BreadboardHole,
} from "@assemblex/circuit-schema";
import dht22 from "../data/examples/dht22_alarm.circuit.json";
import buttonLed from "../data/examples/button_led.circuit.json";

/**
 * 真的 AI 設計：把一句需求交給 OpenAI（gpt-5.5），產出 CircuitIR，再用和手動電路同一套檢查驗證。
 * 檢查沒過就把錯誤原文餵回去重試；三次都沒過就誠實回報，不偷偷換成範例。
 *
 * 金鑰：預設讀打包時的 apps/desktop/.env.local（VITE_OPENAI_API_KEY，不進 git）；
 * 介面上另外設定的金鑰（localStorage）優先。請求直接從 App 送到 OpenAI。
 */
const MODEL = "gpt-5.5";
const KEY_STORE = "assemblex.openaiKey";
const BUILT_IN_KEY = (import.meta.env.VITE_OPENAI_API_KEY as string | undefined) ?? "";

/** 把錯誤翻成使用者看得懂、知道下一步怎麼做的中文；kind 給介面決定要不要展開金鑰欄 */
export function explainError(e: unknown): { kind: "network" | "auth" | "rate" | "server" | "other"; text: string; detail: string } {
  const err = e as Error & { status?: number };
  const detail = err?.message ?? String(e);
  const st = err?.status ?? Number((detail.match(/\b(4\d\d|5\d\d)\b/) ?? [])[1] ?? 0);
  if (/^連線中斷/.test(detail)) return { kind: "network", text: "連線中斷：AI 的回覆沒有收完，按「重試」再跑一次。", detail };
  if (err?.name === "TypeError" || /Failed to fetch|NetworkError|Load failed|連不上/i.test(detail))
    return { kind: "network", text: "連不上 OpenAI：請檢查網路連線後按「重試」。", detail };
  if (st === 401 || st === 403 || /api key|invalid_api_key|Incorrect API key|金鑰/i.test(detail))
    return hasLocalKey()
      ? { kind: "auth", text: "你填的 OpenAI 金鑰無效或沒有權限：請換一把，或改回內建金鑰。", detail }
      // 使用者根本沒設過金鑰：是服務問題，不能叫他「換金鑰」就沒下文
      : { kind: "server", text: "內建的 AI 金鑰暫時無法使用（不是你的設定問題）：稍後按「重試」，或在下方填入自己的 OpenAI 金鑰。", detail };
  if (st === 429 || /rate limit|quota|insufficient_quota/i.test(detail))
    return { kind: "rate", text: "OpenAI 額度用完或呼叫太頻繁：稍等一分鐘再按「重試」，或換一把金鑰。", detail };
  if (st >= 500) return { kind: "server", text: "OpenAI 暫時故障：稍後按「重試」。", detail };
  if (/三次都沒通過電氣檢查/.test(detail)) return { kind: "other", text: "AI 試了三次都沒通過電氣檢查：把需求寫具體一點（用哪些元件、接哪些腳）再試。", detail };
  return { kind: "other", text: `設計失敗：${detail}`, detail };
}

export function getApiKey(): string {
  try { return localStorage.getItem(KEY_STORE) || BUILT_IN_KEY; } catch { return BUILT_IN_KEY; }
}
/** 打包時有沒有內建金鑰 */
export function hasBuiltInKey(): boolean { return !!BUILT_IN_KEY; }
/** 有沒有在介面上另外設定金鑰（沒有＝用內建的） */
export function hasLocalKey(): boolean {
  try { return !!localStorage.getItem(KEY_STORE); } catch { return false; }
}
export function setApiKey(k: string) {
  try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch { /* 無痕模式 */ }
}

function catalog(profiles: Map<string, ComponentProfile>): string {
  return [...profiles.values()]
    .filter((p) => p.component_id !== "breadboard_830" && p.category !== "microcontroller_board")
    .map((p) => {
      const pins = p.pins.map((q) => `${q.id}@(${q.position_mm[0]},${q.position_mm[2]})`).join(" ");
      // 使用者匯入的元件和內建同型號：一律請 AI 用內建（有原廠模型），不論有沒有查證
      const twin = p.component_id.startsWith("user_") ? builtInTwinOf(p, profiles) : null;
      const guess = twin ? `；和內建的 ${twin} 是同型號，請改用 ${twin}，不要用這個`
        : p.component_id.startsWith("user_") && p.evidence.some((e) => e.verification_status !== "verified")
        ? "；規格書推定、未查證，有內建同類元件時優先用內建" : "";
      // 規格書模組：本體架在排針上，從腳位那排往元件 +z 延伸 d mm；擺法要讓本體伸出板外，不然會蓋住整欄的孔
      const ext = isExternalPart(p)
        ? `；外接元件（${getStoredModel(p.component_id)?.cable ? "排線接頭" : "腳距不是 2.54mm"}，插不進麵包板）：placement 寫 {"instance_id":"…","position_mm":[0,0,0],"rotation_deg":0,"pin_to_hole":{}}，系統會把它擺在麵包板旁邊、用排線轉杜邦線接到板子；它的腳照常寫進 logical.nets` : "";
      const mod = !ext && isEdgeModule(p)
        ? `；模組本體 ${p.geometry.bbox_mm[0]}×${p.geometry.bbox_mm[2]}mm 從腳位排往 +z 延伸，請把腳插在 J 排（rotation_deg 0，本體伸向板外）或 A 排（rotation_deg 180），本體範圍內的孔不能用` : "";
      return `- ${p.component_id}（${p.display_name}，${p.category}${guess}${ext}${mod}）pins: ${pins}`;
    }).join("\n");
}

function systemPrompt(profiles: Map<string, ComponentProfile>, boardId: string, bbId: string): string {
  const board = boardOf(boardId);
  const bprof = profiles.get(board.id);
  const bb = bbSpecOf(bbId);
  const placement = boardPlacement(board, bprof?.pins ?? [], bb.size_mm[0]);
  const bbName = bbId.replace("breadboard_", "") + " 孔";
  const railN = bb.rail_holes ?? 50;
  const rails = railN > 0 ? `上下各有一組＋／−電源軌（孔名 BOT+n、BOT-n、TOP+n、TOP-n，n 為 1–${railN}）` : "沒有電源軌：電源與地要在主區找一欄當匯流用";
  const boardRule = board.mount === "beside"
    ? `- 開發板（mcu1，${board.id}）不插麵包板：placement 固定為 ${JSON.stringify(placement)}。線直接接開發板腳位 {"kind":"pin","pin":"mcu1.D7"}。地用 mcu1.${board.ground}，電源用 mcu1.${board.power}。`
    : `- 開發板（mcu1，${board.id}）直接插在麵包板上：placement 固定為 ${JSON.stringify(placement)}。它的腳已經插在那些孔，接它的腳位要從同一欄的其他孔拉線（不能再插同一個孔），也可以直接用 {"kind":"pin","pin":"mcu1.xxx"}。地用 mcu1.${board.ground}，電源用 mcu1.${board.power}${board.power === "3V3" ? "（這是 3.3V 板：感測器要接 3.3V，不能接 5V）" : ""}。這些孔被開發板佔走，元件不能放在它的欄位範圍內。`;
  return `你是 AssembleX 的硬體設計引擎。使用者用一句話描述想做的 Arduino 專案，你要設計出可以真的插在 ${bbName}麵包板上的電路，輸出 CircuitIR JSON。

## 可用元件（只能用這些 profile_id；pins 是「腳位id@(x,z) mm」，相對第一根腳）
${catalog(profiles)}

## 麵包板規則
- 麵包板：${bbName}（physical.breadboard.profile_id 固定為 "${bbId}"）。主區孔位：列 A–J、欄 1–${bb.columns}，寫成 "E12"；${rails}。空間有限時元件要排緊，但仍要留給導線的空孔。同一欄的 A–E 互通、F–J 互通；E 與 F 之間是中央溝，不互通。
- 6mm 按鈕一定跨中間溝槽插：腳 1/2 在同一欄的 E、F 列（內部相通），腳 3/4 在隔兩欄的 E、F 列，例如 1:E8 2:F8 3:E10 4:F10；按下時 1↔3 接通。
- 一個孔只能插一隻腳。元件腳不能插在別的元件本體底下。
- 每個需要接線的腳，它那一欄（同一個導通群組）至少要留 1 個沒被元件本體蓋住的空孔給導線用。
- 元件腳位插的孔，相對位置必須和 pins 的座標一致（欄距 2.54mm、列距 2.54mm，rotation_deg 0 時 x 對應欄號增加方向、z 對應列 A→J 方向）。例如腳距 10.16mm 的電阻是 E10、E14。
${boardRule}
- logical.board 固定為 {"instance_id":"mcu1","profile_id":"${board.id}","fqbn":"${board.fqbn}"}。
- 導線由系統依接線規範自動產生（選孔、走電源軌、補橋接線、配色、避碰撞），你不要寫導線。
  為了讓自動接線不交叉：元件依它接的開發板腳位順序由左到右排（例如 D2 的元件放最左邊）。
- 元件之間留 2 欄以上空隙。
- 使用者點名要用的元件一定要用，不能換成別的元件。插不進麵包板的元件（標「外接元件」）就外接：不寫孔位，腳照常接進電路，這不算需求打折，不要寫進 unmet。
- 電阻參數寫 parameters.resistance_ohm（數字）。LED 一定要串限流電阻。

## CircuitIR 規則
- logical.nets 列出每個電氣網路的全部腳位（"元件id.腳位id"），role 是 signal / power / ground。
- physical.wires 一律輸出空陣列 []。
- firmware_bindings 把韌體常數名對應到開發板腳位，例如 {"LED_PIN":"mcu1.D9"}。
- 實體連通（板子內部互通＋線＋插孔）必須和 logical.nets 完全一致：不能少接、不能多接。

## 範例（DHT22 告警）
${JSON.stringify({ ...dht22, physical: { ...dht22.physical, wires: [] } })}

## 範例（按鈕控制 LED）
${JSON.stringify({ ...buttonLed, physical: { ...buttonLed.physical, wires: [] } })}

## 輸出格式
只輸出一個 JSON 物件，放在 \`\`\`json 區塊裡，形狀是：
{"title": "簡短中文專案名", "steps": ["設計推理第 1 步", "..."], "unmet": ["需求中做不到或打折的部分，沒有就空陣列"], "ir": { CircuitIR }}
steps 用 5–8 條簡短中文說明你怎麼選元件、算電阻、配腳位（寫元件名稱，例如「LD06」，不要寫 profile_id）。project_id 用英文小寫加底線。
如果需求超出可用元件，選最接近的可行設計，並把做不到或打折的地方逐條寫進 unmet（例如「主動式蜂鳴器只有固定音調，無法用可變電阻調音調」）。不要隱瞞。`;
}

function extractJson(text: string): unknown {
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text);
  if (!m) throw new Error("回覆裡找不到 JSON");
  return JSON.parse(m[1]);
}

/**
 * 串流呼叫 OpenAI Responses API：一邊算一邊回報「它在幹嘛」。
 * - 推理階段：模型的思考摘要（reasoning summary），取最新一段的標題與內容
 * - 輸出階段：數已經寫出幾個零件、幾條網路
 * 帳號不能用思考摘要時（需要組織驗證）自動改成不要摘要再試一次。
 */
/** GPT 運算中「它在幹嘛」：stage 是中文階段名；body 是模型自己寫的內容（推理摘要為英文原文時 en = true） */
export interface Thought { stage: string; body?: string; en?: boolean }

/** 串流中已經寫完整的元件與擺放（給 3D 先畫半透明的「預覽」；導線等通過電氣檢查才畫） */
export interface PartialLayout {
  components: { id: string; profile_id: string; parameters?: Record<string, unknown> }[];
  placements: { instance_id: string; position_mm: number[]; rotation_deg: number; pin_to_hole: Record<string, string> }[];
}

/** 從還沒寫完的 JSON 取出某個陣列裡已經完整的物件（逐字掃描括號深度，略過字串內容） */
function completeObjects(text: string, key: string): unknown[] {
  const k = text.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
  if (k < 0) return [];
  let i = text.indexOf("[", k) + 1, depth = 0, start = -1, inStr = false;
  const out: unknown[] = [];
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 還沒寫完 */ } start = -1; } }
    else if (c === "]" && depth === 0) break;
  }
  return out;
}

/** 截到字（或中文字）邊界，刪節號不會落在英文單字中間 */
function clip(t: string, n: number): string {
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return (/[A-Za-z]$/.test(cut) ? cut.replace(/\s+\S*$/, "") : cut) + "…";
}

async function callModel(apiKey: string, messages: { role: string; content: string }[], onThought: (t: Thought) => void, signal?: AbortSignal,
                         onPartial?: (p: PartialLayout) => void): Promise<string> {
  const go = async (summary: boolean) => fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    // 每次呼叫最多 10 分鐘：伺服器不回應時不會無限等
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
    body: JSON.stringify({ model: MODEL, input: messages, stream: true, max_output_tokens: 64000,
                           reasoning: summary ? { effort: "high", summary: "auto" } : { effort: "high" } }),
  });
  let res: Response;
  try { res = await go(true); } catch (e) {
    if ((e as Error).name === "AbortError" && !signal?.aborted) throw Object.assign(new Error("連線中斷：AI 超過 10 分鐘沒有回應"), { name: "TypeError" });
    throw e;
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    if (res.status === 400 && /summary|verif/i.test(msg)) res = await go(false);
    else throw Object.assign(new Error(`OpenAI 回應錯誤：${(() => { try { return JSON.parse(msg).error?.message; } catch { return ""; } })() || res.status}`), { status: res.status });
  }
  if (!res.ok || !res.body) throw Object.assign(new Error(`OpenAI 回應錯誤：${res.status}`), { status: res.status });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", out = "", thought = "", status = "", refusal = "", errMsg = "";
  onThought({ stage: "推理中", body: "模型先想完整個電路才開始寫，這一步通常最久" });
  const showThought = () => {
    // 摘要通常是「**標題**\n\n內容」：顯示最新一段的標題＋內容開頭
    const parts = thought.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    const heads = [...thought.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
    const head = heads[heads.length - 1] ?? "";
    const FMT = /json|code block|schema|format|output|field|key[s]?\b|markdown|restrict|constrain|requirement|instruct|prompt|allowed|must (use|not)|fixed|placement|I(?:'m| am) (?:told|asked|required|limited)|user (?:wants|asked|requested)|breadboard\s*\d+/i;
    const body = (parts.filter((x) => !/^\*\*.+\*\*$/.test(x)).pop() ?? "")
      .split(/(?<=[.!?])\s+/).filter((x) => !FMT.test(x)).join(" ");
    if (FMT.test(head) && !body) return;
    const headOk = FMT.test(head) ? "" : head;
    // 摘要由 OpenAI 另外產生，語言不受提示控制（多半是英文）：標明是原文，不假裝是翻譯
    const t = `${headOk ? headOk + (body ? "：" : "") : ""}${body.replace(/\*\*/g, "").slice(0, 160)}`;
    if (t) onThought({ stage: "推理摘要 · 英文原文", body: clip(t.replace(/：/, ": "), 115), en: true });
  };
  // 輸出的 JSON 依序是 title → steps（模型自己寫的設計推理）→ ir：邊收邊顯示它正在寫哪一步、寫到第幾個零件
  let lastPl = 0;
  const showOutput = () => {
    const strs = (from: number, upto: number) => [...out.slice(from, upto < 0 ? undefined : upto).matchAll(/"((?:[^"\\]|\\.)*)("|$)/g)].map((m) => m[1]);
    const si = out.search(/"steps"\s*:\s*\[/), ii = out.search(/"ir"\s*:/), ui = out.search(/"unmet"\s*:/);
    if (ii < 0 && ui > si && si >= 0) { onThought({ stage: "整理做不到或打折的需求" }); return; }
    if (si >= 0 && ii < 0) {
      const steps = strs(out.indexOf("[", si) + 1, out.indexOf("]", si));
      const cur = steps[steps.length - 1];
      if (cur) { onThought({ stage: `寫設計推理 · 第 ${steps.length} 步`, body: clip(cur.replace(/\\n/g, " "), 200) }); return; }
    }
    if (ii >= 0) {
      const body = out.slice(ii);
      const comps = [...body.matchAll(/"profile_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).slice(1);   // 第一個是開發板
      const nets = (body.match(/"role"\s*:/g) ?? []).length;
      const pl = (body.match(/"pin_to_hole"/g) ?? []).length;
      if (pl && onPartial && pl !== lastPl) {
        lastPl = pl;
        onPartial({ components: completeObjects(body, "components") as PartialLayout["components"],
                    placements: completeObjects(body, "placements") as PartialLayout["placements"] });
      }
      const stage = pl ? `擺放元件到麵包板 · 第 ${pl} 個` : nets ? `接網路 · 第 ${nets} 條` : comps.length ? `選元件 · ${comps[comps.length - 1]}` : "寫電路結構";
      onThought({ stage });
      return;
    }
    onThought({ stage: "開始輸出" });
  };
  try { for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev: { type?: string; delta?: string; response?: { status?: string; incomplete_details?: { reason?: string }; error?: { message?: string } }; message?: string };
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      switch (ev.type) {
        case "response.reasoning_summary_text.delta": thought += ev.delta ?? ""; showThought(); break;
        case "response.reasoning_summary_part.added": thought += "\n\n"; break;
        case "response.output_text.delta": out += ev.delta ?? ""; showOutput(); break;
        case "response.refusal.delta": refusal += ev.delta ?? ""; break;
        case "response.completed": status = "completed"; break;
        case "response.incomplete": status = ev.response?.incomplete_details?.reason ?? "incomplete"; break;
        case "response.failed": errMsg = ev.response?.error?.message ?? "失敗"; break;
        case "error": errMsg = ev.message ?? "串流錯誤"; break;
      }
    }
  } } finally { reader.releaseLock(); }
  if (errMsg) throw new Error(`OpenAI 回應錯誤：${errMsg}`);
  if (refusal) throw new Error("模型拒絕了這個需求");
  if (status && status !== "completed") throw new Error(status === "max_output_tokens" ? "回覆太長被截斷" : `回覆未完成（${status}）`);
  // 串流中途斷掉（沒收到 completed）：是連線問題，不是設計問題——不要拿半截回覆去「修正」
  if (!status) throw Object.assign(new Error("連線中斷：AI 的回覆沒有收完"), { name: "TypeError" });
  return out;
}

export interface DesignResult { title: string; steps: string[]; ir: CircuitIR; attempts: number; unmet: string[] }

export async function designCircuit(
  request: string, boardId: string, bbId: string, profiles: Map<string, ComponentProfile>, holes: BreadboardHole[],
  holeIndex: Map<string, BreadboardHole>, onProgress: (line: string) => void,
  onThought: (t: Thought) => void = () => {}, signal?: AbortSignal, onPartial?: (p: PartialLayout) => void,
): Promise<DesignResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("還沒設定 OpenAI API 金鑰");
  const system = systemPrompt(profiles, boardId, bbId);
  type Msg = { role: "system" | "user" | "assistant"; content: string };
  const messages: Msg[] = [{ role: "system", content: system }, { role: "user", content: request }];

  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    onProgress(attempt === 1 ? "AI 設計中…" : `第 ${attempt} 次修正中…`);
    const text = await callModel(apiKey, messages, onThought, signal, attempt === 1 ? onPartial : undefined);

    let problems: string[] = [];
    let remapNote = "", moveNote = "", edgeNote = "", extNote = "";
    let parsed = null as { title?: string; steps?: string[]; ir?: unknown } | null;
    let ir: CircuitIR | null = null;
    try {
      parsed = extractJson(text) as { title?: string; steps?: string[]; ir?: unknown };
      const r = CircuitIR.safeParse(parsed?.ir);
      if (!r.success) problems = r.error.issues.slice(0, 12).map((i) => `${i.path.join(".")}: ${i.message}`);
      else ir = { ...r.data, physical: { ...r.data.physical, breadboard: { ...(r.data.physical.breadboard ?? { instance_id: "bb1", position_mm: [0, 0, 0] }), profile_id: bbId } } } as CircuitIR;
    } catch (e) {
      problems = [`JSON 解析失敗：${(e as Error).message}`];
    }
    if (ir && ir.logical.components.every((c) => profiles.has(c.profile_id))) {
      // 板邊模組（OLED 這類）放在中間會蓋住那幾欄所有的孔：先自動移到板邊，不必退回給 AI
      const off = placeOffBoard(ir, profiles, holes, isExternalPart);
      if (off.placed.length) { ir = off.ir; extNote = `${off.placed.join("、")} 插不進麵包板，外接在麵包板左邊：用它的排線轉杜邦線接到板子`; }
      const fix = fixEdgeModules(ir, profiles, holes);
      if (fix.moved.length) { ir = fix.ir; edgeNote = `${fix.moved.join("、")} 移到麵包板邊緣（本體伸出板外，不蓋住孔）`; }
    }
    if (ir) {
      const unknown = ir.logical.components.filter((c) => !profiles.has(c.profile_id)).map((c) => `未知元件 ${c.profile_id}`);
      const badHoles = ir.physical.placements.flatMap((p) => Object.values(p.pin_to_hole))
        .concat(ir.physical.wires.flatMap((w) => [w.from, w.to]).flatMap((e) => (e.kind === "hole" ? [e.hole] : [])))
        .filter((h) => !holeIndex.has(h)).map((h) => `孔位 ${h} 不存在`);
      problems = [...unknown, ...badHoles, ...footprintErrors(ir, profiles, holeIndex), ...blockedHoleErrors(ir, profiles, holeIndex)];
      if (!problems.length) {
        // 接線一律由演算法依規範產生（AI 寫的導線全部丟掉），不靠模型自己挑孔位
        onProgress(attempt > 1 ? "修正後重新產生導線…" : "依接線規範自動產生導線…");
        // 先在功能相同的腳之間重新分配，讓排線不交叉；再依規範接線
        const opt = optimizeLayout(ir, profiles, holes);
        moveNote = opt.moved ? `${opt.moved} 個元件左右微調了位置` : "";
        const aw = opt.result;
        remapNote = Object.entries(opt.remap).map(([a, b]) => `${a.split(".")[1]}→${b.split(".")[1]}`).join("、");
        ir = { ...opt.ir, physical: { ...opt.ir.physical, wires: aw.wires } };
        problems = aw.problems.map((p) => `自動接線失敗：${p}（請調整元件擺放，讓每個要接線的腳那一欄留空孔）`);
        if (!problems.length && aw.score.collisions) problems = [`自動接線後仍有 ${aw.score.collisions} 處導線碰撞，請把元件拉開一點`];
        if (!problems.length) onProgress(`自動接線：${aw.wires.length} 條線 · 碰撞 0${aw.score.crossings ? ` · 俯視交叉 ${aw.score.crossings} 處` : " · 俯視不交叉"}`);
      }
      if (!problems.length) {
        problems = [...runElectricalChecks(ir, holes), ...detectIsolatedParts(ir, profiles), ...detectPartOverlaps(ir, profiles, holeIndex)]
          .filter((i) => i.severity === "error").map((i) => i.message);
      }
    }
    if (!problems.length && ir && parsed) {
      onProgress(`電氣檢查通過（第 ${attempt} 次）`);
      const guessed = ir.logical.components.map((c) => profiles.get(c.profile_id)).filter((p) => p && p.component_id.startsWith("user_") && p.evidence.some((e) => e.verification_status !== "verified"));
      if (guessed.length) onProgress(`⚠ 使用了未查證的元件：${guessed.map((p) => p!.display_name).join("、")}\n腳位為規格書推定 · 接線前請對照實物`);
      const steps = [...(parsed.steps ?? []), ...(extNote ? [`外接：${extNote}`] : []), ...(edgeNote ? [`擺放修正：${edgeNote}`] : []), ...(moveNote ? [`接線演算法為了讓導線更短、少交叉，${moveNote}（電路不變）`] : []), ...(remapNote ? [`接線演算法為了讓導線不交叉，把腳位換成功能相同的腳：${remapNote}（韌體腳位對照已同步）`] : [])];
      return { title: parsed.title ?? ir.project_id, steps, ir, attempts: attempt, unmet: Array.isArray((parsed as { unmet?: unknown }).unmet) ? ((parsed as { unmet: unknown[] }).unmet).map(String).filter(Boolean) : [] };
    }
    lastProblems = problems;
    onProgress(`檢查發現 ${problems.length} 個問題，交回去修正`);
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: `驗證沒通過，請修正後輸出完整 JSON：\n${problems.slice(0, 20).map((p) => `- ${p}`).join("\n")}` });
  }
  throw new Error(`三次都沒通過電氣檢查。最後一次的問題：\n${lastProblems.slice(0, 8).map((p) => `- ${p}`).join("\n")}`);
}
