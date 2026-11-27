import { useEffect, useRef, useState } from "react";
import { useDsJob, usePartTrash, markRunning, clearRunning, saveDsFiles, clearDsFile, loadDsFiles, savePartFiles, loadPartFiles, toDraft, type DraftPin } from "../stores/dsJob";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { profileFromDatasheet, sizeMissing, quickCheck, checkFile, MAX_TOTAL, checkProfile, loadSources, saveSource, unitOf, findBySha, builtInTwinOf, customTwinOf, type DatasheetError, type DatasheetResult, type SpecConflict } from "../ai/datasheet";
import { getApiKey, explainError } from "../ai/generate";
import { getComPdfKey, setComPdfKey, hasLocalComPdfKey, isComPdfKeyError, markComPdfBroken, isComPdfBroken, clearComPdfBroken, sha256Hex } from "../ai/compdf";
import { useProject, storageFail } from "../stores/projectStore";
import { Thumb } from "../ui/Thumb";
import { SHAPE_HINTS, SHAPE_LABEL, shapeHintOf, keywordShape, withShapeHint, thumbProfile, getStoredModel, setDraftModel, saveModel, type ShapeHint } from "../engine3d/datasheetShape";
import { regenerateModel } from "../ai/datasheet";

const PIN_TYPE: Record<string, string> = {
  digital_io: "數位", analog_in: "類比輸入", analog_out: "類比輸出", power_in: "電源",
  power_out: "電源輸出", ground: "接地", passive: "被動", nc: "未接",
};
const CATEGORY: Record<string, string> = {
  passive: "被動元件", led: "LED", sensor: "感測器", display: "顯示器", actuator: "致動器", power: "電源",
};
export { unitOf };
/** 供電：一樣就寫「5 V」，不寫「5–5 V」 */
export function fmtSupply(e: ComponentProfile["electrical"]): string | null {
  const lo = e.supply_voltage_min_v, hi = e.supply_voltage_max_v;
  if (lo == null && hi == null) return null;
  return lo == null || hi == null || lo === hi ? `${hi ?? lo} V` : `${lo}–${hi} V`;
}
/** 外形一律「寬 × 深 × 高」（bbox_mm 是 [寬 x, 高 y, 深 z]） */
export const fmtSize = (b: [number, number, number] | number[]) => `${b[0]} × ${b[2]} × ${b[1]} mm（寬 × 深 × 高）`;
const sizeGuessedOf = (r: DatasheetResult) => sizeMissing(r);
/** 錯誤句尾清理：不要「。。」「。；」 */
/** ComPDF 錯誤訊息去掉重複的「ComPDF」字首與句點，好嵌進別的句子 */
const cpErr = (m: string) => m.replace(/^ComPDF\s*/, "").replace(/[。.]$/, "");
const tidyErr = (t: string) => t.replace(/[。.]\s*。/g, "。").replace(/。\s*([；，）])/g, "$1").replace(/。{2,}/g, "。");
/** AI 有明講「腳位順序／定義不確定」才警示（不能只因為句子裡有「腳位」兩個字） */
const PIN_ORDER = /(腳位|接腳|引腳|排針|針腳)[^，。；]{0,6}(順序|排列|定義|對應)|腳序|pin\s*-?\s*(order|out|assignment)|絲印/i;

/**
 * 元件庫裡的「從規格書新增元件」：選 PDF／圖片 → GPT-5.5 讀出腳位、尺寸、電氣規格 →
 * 預覽（腳位表、尺寸、3D 外形、待確認事項）→ 使用者確認才加入元件庫。
 * 同一個預覽也用來「查看／修改」已加入的自建元件（editingId）。
 */
export function DatasheetImport() {
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // 工作狀態在全域（stores/dsJob）：關掉元件庫卡也照跑、重新整理也救得回來
  const job = useDsJob();
  const { stage, fileName: file, result, error, added, choice, draft, warn, setDraft, setChoice, editingId, interrupted, notice, compdfBroken } = job;
  const [showAll, setShowAll] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const [askReplace, setAskReplace] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  // 經過秒數：讀規格書要幾分鐘，不顯示會以為當掉
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!stage) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [stage]);
  // 讀到的 3D 模型（依圖面生成）先登記成預覽用的 draft，縮圖和選單才看得到（加入時才存）
  useEffect(() => {
    if (!result || editingId) return;
    const id = (draft ?? result.profile).component_id;
    setDraftModel(id, { parts: result.modelParts ?? [], cable: !!result.cable });
    setModelTick((t) => t + 1);
  }, [result]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [modelTick, setModelTick] = useState(0);
  const photo = useRef<HTMLInputElement>(null);
  /**
   * 繪製 3D（獨立一步，任何元件都一樣）：把原檔（＋使用者另外給的照片）交給 AI，只請它依圖面拼出基本形狀。
   * 失敗或找不到圖面：維持簡單外形並說原因，不影響加入元件庫。
   */
  async function draw3d(p: ComponentProfile, extra: File[] = []) {
    const id = p.component_id;
    job.set({ model3d: { state: "running", msg: "繪製 3D：讀取圖面…" } });
    try {
      const own = job.files.length ? job.files : editingId ? await loadPartFiles(editingId) : await loadDsFiles();
      const fs = [...own, ...extra];
      if (!fs.length) { job.set({ model3d: { state: "nofile", msg: "找不到原檔（可能在別台電腦加入）：請加一張產品照片或機構圖給 3D 用" } }); return; }
      job.set({ model3d: { state: "running", msg: `繪製 3D：讀取圖面（${fs.length} 份檔案）…` } });
      const r = await regenerateModel(fs, p);
      if (!r.parts.length) { job.set({ model3d: { state: "none", msg: "規格書裡沒有找到可用的機構圖或照片：維持簡單外形（可以加一張照片再試）" } }); return; }
      setDraftModel(id, { parts: r.parts, cable: getStoredModel(id)?.cable ?? !!useDsJob.getState().result?.cable });
      job.set({ modelRef: r.ref && extra.length && r.ref.file != null && r.ref.file > own.length ? { file: null, page: null } : r.ref,
                model3d: { state: "done", msg: null } });
      // 使用者沒有另外選簡單外形，就直接用畫好的 3D
      useDsJob.getState().setDraft((d) => d && d.component_id === id ? { ...d, geometry: { ...d.geometry, asset_id: withShapeHint(d.geometry.asset_id, "model") } } : d);
      setModelTick((t) => t + 1);
    } catch (e) {
      job.set({ model3d: { state: "error", msg: `繪製 3D 失敗（${(e as Error).message.slice(0, 80)}）：維持簡單外形` } });
    }
  }
  // 首頁按「重新讀取」（resumeInterrupted）：卡片一掛上就接著讀，不用再按一次
  useEffect(() => {
    // 讀 store 的最新值（StrictMode 會把 effect 跑兩次，用 closure 的舊值會重讀兩次）
    const st = useDsJob.getState();
    if (!st.autoResume) return;
    st.set({ autoResume: false });
    if (!st.stage && (st.interrupted || st.stopped)) { st.set({ stopped: false }); void retry(); }
  }, [job.autoResume]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 從元件庫按「查看／修改」：捲到預覽
  useEffect(() => { if (editingId) root.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [editingId]);
  const editPin = (i: number, patch: Partial<ComponentProfile["pins"][number]>) =>
    setDraft((d) => d && { ...d, pins: d.pins.map((q, k) => (k === i ? { ...q, ...patch } : q)) });
  const removePin = (i: number) => setDraft((d) => d && { ...d, pins: d.pins.filter((_, k) => k !== i) });
  const addPin = () => setDraft((d) => {
    if (!d) return d;
    const last = d.pins[d.pins.length - 1];
    const pos: [number, number, number] = last ? [+(last.position_mm[0] + 2.54).toFixed(2), 0, last.position_mm[2]] : [0, 0, 0];
    return { ...d, pins: [...d.pins, { ...(last ?? { normal: [0, -1, 0], connector_type: "male_header", functions: [] }), id: `P${d.pins.length + 1}`, type: "digital_io", functions: [], position_mm: pos, _k: `n${Date.now()}`, _id0: undefined, _page: null } as DraftPin] };
  });
  const [hasPdfKey, setHasPdfKey] = useState(!!getComPdfKey());
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const profiles = useProject((s) => s.profiles);

  /** 選了檔案：一份就直接讀；多份（或已經有待讀清單）先列出來、逐份檢查，按「開始讀取」才讀 */
  async function pick(list: File[]) {
    if (!list.length) return;
    const cur = useDsJob.getState().staged;
    if (list.length === 1 && !cur.length) return run(list);
    const staged = [...cur, ...list.filter((f) => !cur.some((x) => x.name === f.name && x.size === f.size))];
    job.set({ staged, error: null, notice: null, added: null, shaMatch: null });
    const errs: Record<string, string> = { ...useDsJob.getState().stagedErr };
    for (const f of list) { const bad = await checkFile(f); if (bad) errs[f.name] = bad; else delete errs[f.name]; }
    job.set({ stagedErr: errs });
  }
  const unstage = (f: File) => {
    const st = useDsJob.getState();
    const errs = { ...st.stagedErr }; delete errs[f.name];
    job.set({ staged: st.staged.filter((x) => x !== f), stagedErr: errs });
  };

  async function run(input: File | File[], force = false) {
    const fs = Array.isArray(input) ? input : [input];
    const f = fs[0];
    const label = fs.length > 1 ? `${f.name} 等 ${fs.length} 份` : f.name;
    // 格式、大小先檢查（不用等 SHA-256、IndexedDB）：錯的檔案立刻說
    const badF = fs.find((x) => quickCheck(x));
    if (badF) { job.set({ fileName: label, files: [], error: fs.length > 1 ? `「${badF.name}」：${quickCheck(badF)}` : quickCheck(badF), retryable: false, added: null, notice: null, shaMatch: null }); return; }
    // 同一份規格書加入過：先問，不要花幾分鐘和費用再讀一次、做出第二個同名元件
    if (!force) {
      // 選完檔案立刻有回應（算 SHA-256 要一下子）
      job.set({ fileName: label, stage: "準備中", t0: Date.now(), error: null, added: null, notice: null, shaMatch: null, prevCompare: null });
      // 任何一份檔案（SHA-256）以前加入過就算
      const shas = (await Promise.all(fs.map((x) => sha256Hex(x).catch(() => "")))).filter(Boolean);
      const exists = (id: string) => useProject.getState().profiles.has(id);
      const hit = shas.map((h) => findBySha(h, exists)).find(Boolean) ?? null;
      // 元件已刪除但還在「最近刪除」：救回比重讀便宜
      const gone = !hit ? usePartTrash.getState().trash.find((t) => shas.some((h) => t.source?.sha256 === h || t.source?.files?.some((x) => x.sha256 === h))) : undefined;
      if (hit || gone) {
        const q = hit ? useProject.getState().profiles.get(hit.id)! : gone!.profile;
        job.set({ fileName: label, files: fs, stage: null, stopped: false, interrupted: null,
                  shaMatch: { id: q.component_id, name: q.display_name, verified: !q.evidence.some((e) => e.verification_status === "unverified"),
                              addedAt: hit ? hit.src.addedAt : gone!.source?.addedAt, trashed: !!gone } });
        return;
      }
    }
    const c = new AbortController();
    const t0 = Date.now();
    // 無效標記一小時後過期：每次開始都重新看
    const broken0 = isComPdfBroken();
    job.set({ fileName: label, files: fs, staged: [], stagedErr: {}, result: null, error: null, warn: null, added: null, choice: {}, draft: null, ctl: c, t0, stage: "準備中",
              retryable: true, editingId: null, interrupted: null, notice: null, stopped: false, shaMatch: null, compdfBroken: broken0,
              prevCompare: force ? useDsJob.getState().prevCompare : null, sizeChoice: null, modelRef: null, model3d: null,
              // 金鑰已知無效：這次會略過 ComPDF，進度列一開始就說清楚為什麼
              stageWarn: broken0 && getComPdfKey() && fs.some((x) => /\.pdf$|^application\/pdf$/i.test(x.type || x.name))
                ? (hasLocalComPdfKey() ? "ComPDF 金鑰無效，已略過" : "內建的 ComPDF 金鑰暫時無法使用，已略過") : null });
    setShowAll(false); setAskDiscard(false);
    markRunning(label, t0); void saveDsFiles(fs);
    const st = useDsJob.getState();
    try {
      const r = await profileFromDatasheet(fs, [...useProject.getState().profiles.keys()], (s) => useDsJob.getState().set({ stage: s }), c.signal, {
        // 金鑰已知無效：換金鑰前不再呼叫 ComPDF
        skipComPdf: broken0,
        // ComPDF 一失敗就讓進度列轉成警示（403 不用等 AI 讀完才看到）
        onComPdfError: (msg) => {
          const broken = isComPdfKeyError(msg);
          if (broken) markComPdfBroken();
          useDsJob.getState().set({ stageWarn: broken ? (hasLocalComPdfKey() ? `ComPDF 金鑰無效（${(msg.match(/40[13]/) ?? ["403"])[0]}）` : "內建的 ComPDF 金鑰暫時無法使用") : `ComPDF 失敗：${cpErr(msg)}`,
                                   ...(broken ? { compdfBroken: true } : {}) });
        },
      });
      // 每隻腳一個固定的編輯用 key（改腳名時列不會重建、游標不會跑掉），並記住原腳名與出處頁碼
      let draft = toDraft(r.profile, r.pinPages, r.pinFiles);
      // 已經新增過同型號：沿用使用者取的名稱、還適用的規格選擇（只重設真的變了的）
      const ps = useProject.getState().profiles;
      const twinId = customTwinOf(r.profile, ps);
      const old = twinId ? ps.get(twinId) : undefined;
      let aiName: string | null = null, choice0: Record<string, number> = {};
      if (old) {
        if (old.display_name !== draft.display_name) { aiName = draft.display_name; draft = { ...draft, display_name: old.display_name }; }
        const chosen = loadSources()[old.component_id]?.chosen ?? {};
        for (const c of r.conflicts) if (chosen[c.field] != null && c.options.some((o) => o.value === chosen[c.field])) choice0[c.field] = chosen[c.field];
      }
      const broken = isComPdfKeyError(r.source.compdfError);
      if (broken) markComPdfBroken();
      // 3D：主讀取沒有給出模型，就另外跑「繪製 3D」這一步（背景進行，不擋確認）
      if ((r.modelParts?.length ?? 0) < 2) setTimeout(() => void draw3d(draft), 0);
      else useDsJob.getState().set({ model3d: { state: "done", msg: null } });
      st.set({ result: r, draft, aiName, choice: choice0, compdfBroken: broken ? true : r.source.parser === "compdf" ? false : useDsJob.getState().compdfBroken,
               warn: !r.source.compdfError ? null : broken && !hasLocalComPdfKey()
                 ? "內建的 ComPDF 金鑰暫時無法使用（不是你的設定問題）。這次改由 AI 直接讀原檔"
                 : `ComPDF 沒有成功：${cpErr(r.source.compdfError)}。這次改由 AI 直接讀原檔` });
    } catch (e) {
      const err = e as DatasheetError;
      if (err.name !== "AbortError") {
        const m = err.message;
        // OpenAI／網路錯誤翻成看得懂、知道怎麼辦的中文；我們自己丟的中文錯誤照原樣
        const ai = /^(OpenAI|連不上)/.test(m) || err.name === "TypeError" ? explainError(e).text.replace(/^設計失敗：/, "") : m;
        const broken = isComPdfKeyError(err.compdfError);
        if (broken) markComPdfBroken();
        // ComPDF 先失敗、AI 接著也失敗：兩個原因都要看得到，不能讓 403 被蓋掉
        st.set({ error: tidyErr(err.compdfError ? `ComPDF 失敗：${cpErr(err.compdfError)}。\nAI 也沒有成功：${ai}` : ai),
                 retryable: err.retryable !== false, compdfBroken: broken || useDsJob.getState().compdfBroken });
      } else st.set({ stopped: true });   // 檔案留著：「重新讀取」不用再選一次
    } finally { clearRunning(); useDsJob.getState().set({ stage: null, ctl: null, stageWarn: null }); }
  }
  /** 重試／重新讀取：記憶體裡沒有檔案（重新整理過）就從 IndexedDB 拿，再沒有就請使用者重選 */
  async function retry() {
    const cur = useDsJob.getState().files;
    const fs = cur.length ? cur : await loadDsFiles();
    if (fs.length) return run(fs);
    clearRunning();
    job.set({ interrupted: null, error: null, notice: `找不到上次的檔案，請重新選擇 ${job.interrupted?.fileName ?? job.fileName}` });
    input.current?.click();
  }

  /** 去掉編輯用欄位、腳名去空白；evidence／頁碼跟著改名 */
  function finalize(p0: ComponentProfile) {
    const pins = p0.pins as DraftPin[];
    const rename = new Map(pins.filter((q) => q._id0).map((q) => [q._id0!, q.id.trim()]));
    const pinPages: Record<string, number | null> = {};
    const pinFiles: Record<string, number> = {};
    for (const q of pins) { pinPages[q.id.trim()] = q._page ?? null; if (q._file) pinFiles[q.id.trim()] = q._file; }
    const p: ComponentProfile = { ...p0, display_name: p0.display_name.trim() || p0.component_id, electrical: { ...p0.electrical },
      pins: pins.map(({ _k, _id0, _page, _file, ...q }) => { void _k; void _id0; void _page; void _file; return { ...q, id: q.id.trim() }; }),
      evidence: p0.evidence.flatMap((e) => {
        const m = e.field.match(/^pins\.(.+)$/);
        if (!m) return [e];
        const to = rename.get(m[1]);
        return to ? [{ ...e, field: `pins.${to}` }] : [];
      }) };
    return { p, pinPages, pinFiles: Object.keys(pinFiles).length ? pinFiles : undefined };
  }

  /** mode：replace＝取代已新增過的同型號元件（沿用它的 id，AI 設計與專案的參照不變） */
  function confirm(p0: ComponentProfile, replaceId?: string) {
    const { p: p1, pinPages, pinFiles } = finalize(p0);
    const p: ComponentProfile = replaceId
      ? { ...p1, component_id: replaceId, geometry: { ...p1.geometry, asset_id: p1.geometry.asset_id.replace(p1.component_id, replaceId) } } : p1;
    // 規格衝突由使用者選定的值寫回（AI 只先填了保守值）
    for (const c of result?.conflicts ?? []) {
      const k = c.field.replace(/^electrical\./, "");
      if (choice[c.field] != null) (p.electrical as Record<string, unknown>)[k] = choice[c.field];
    }
    // 3D 模型（依圖面生成）與「用排線接頭」先存，元件一加入縮圖／3D 就用得到
    const dm = getStoredModel(p0.component_id) ?? (result ? { parts: result.modelParts ?? [], cable: !!result.cable } : null);
    if (dm && !saveModel(p.component_id, dm)) storageFail();
    setDraftModel(p0.component_id, null);
    // 取代：舊的（含名稱、查證狀態、出處）先放進最近刪除，提示「已取代 · 復原」
    const old = replaceId ? useProject.getState().profiles.get(replaceId) : undefined;
    if (old) usePartTrash.getState().remove(old, { replaced: true });
    // 先存元件本身：儲存空間滿了就說清楚、預覽留著可以再按一次，不能假裝加入成功
    if (!useProject.getState().addCustomProfile(p)) {
      if (old) usePartTrash.getState().restore(old.component_id);   // 存不了：把舊的放回去
      job.set({ error: "儲存空間滿了，元件沒有存起來（關掉 App 會不見）。請刪掉不用的專案或元件後再按一次加入", retryable: false });
      setTimeout(() => root.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
      return;
    }
    // 出處：原檔名、SHA-256、解析方式（之後查證時可以對回同一份文件）
    let srcSaved = true;
    if (result) srcSaved = saveSource(p.component_id, { ...result.source, pinPages, pinFiles, conflicts: result.conflicts, chosen: choice, addedAt: Date.now(),
      sizeSource: !sizeGuessedOf(result) ? "datasheet" : job.sizeChoice === "user" ? "user" : "estimate" });
    if (!srcSaved) storageFail();
    // 原檔留一份給「查證 · 打開原檔」用
    const cur = job.files;
    void (cur.length ? Promise.resolve(cur) : loadDsFiles()).then((x) => { if (x.length) return savePartFiles(p.component_id, x); }).finally(() => clearDsFile());
    const twinB = builtInTwinOf(p, profiles);
    job.set({ added: `${replaceId ? "已取代舊的元件" : "已加入元件庫"}：` + (twinB ? `${p.display_name} · AI 設計遇到同型號會改用內建的「${profiles.get(twinB)?.display_name}」（有原廠模型）`
                           : `${p.display_name} · AI 設計可選用它（標為已查證前，同類元件優先用內建）`),
              prevCompare: null, result: null, draft: null, files: [], error: null,
              notice: srcSaved ? null : "儲存空間不足：出處紀錄（檔名、頁碼）沒有存起來，查證時要自己找原文" });
    // 「已加入」訊息在卡片最上面：捲回卡片頂端，新元件就在下方「從規格書新增」，亮一下外框
    setTimeout(() => root.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
    flash(p.component_id, "nearest", false);
  }

  /** 修改既有元件：同一個 id 存回（取代）；腳位有改就改回待查證 */
  function saveEdit(p0: ComponentProfile) {
    const orig = profiles.get(editingId!);
    const { p, pinPages } = finalize(p0);
    const sig = (x: ComponentProfile) => JSON.stringify(x.pins.map((q) => [q.id, q.type, q.position_mm]));
    const pinsChanged = !orig || sig(orig) !== sig(p);
    const out: ComponentProfile = pinsChanged
      ? { ...p, evidence: p.evidence.map((e) => ({ ...e, verification_status: "unverified" as const })) } : p;
    const src = loadSources()[p.component_id];
    // 「重新生成 3D」的結果先存（預覽時放在 draft）
    const dm = getStoredModel(p.component_id);
    if (dm && !saveModel(p.component_id, dm)) storageFail();
    setDraftModel(p.component_id, null);
    if (!useProject.getState().addCustomProfile(out)) {
      job.set({ error: "儲存空間滿了，修改沒有存起來。請刪掉不用的專案或元件後再按一次「儲存修改」", retryable: false });
      return;
    }
    if (src && !saveSource(p.component_id, { ...src, pinPages })) storageFail();
    job.set({ editingId: null, result: null, draft: null, choice: {},
              notice: `已儲存「${out.display_name}」的修改${pinsChanged && orig?.evidence.every((e) => e.verification_status === "verified") ? "（腳位有改，改回待查證）" : ""}` });
    flash(p.component_id);
  }

  // 元件捲進畫面並亮一下外框，不然看起來像什麼都沒發生
  function flash(id: string, block: ScrollLogicalPosition = "nearest", scroll = true) {
    setTimeout(() => {
      const el = document.getElementById(`lib-${id}`);
      if (scroll) el?.scrollIntoView({ block, behavior: "smooth" }); el?.classList.add("is-new");
      setTimeout(() => el?.classList.remove("is-new"), 1800);
    }, 60);
  }
  function discard() {
    setAskDiscard(false);
    job.set({ result: null, draft: null, choice: {}, editingId: null, warn: null, aiName: null, prevCompare: null, sizeChoice: null, modelRef: null, model3d: null });
    void clearDsFile();
  }
  // 元件庫已經有同型號（內建的有完整 3D 模型）：先提示，不要默默再做一個方塊
  const dupOf = (p: ComponentProfile) => {
    if (editingId) return undefined;
    const id = builtInTwinOf(p, profiles);
    return id ? profiles.get(id) : undefined;
  };
  function useBuiltIn(q: ComponentProfile) {
    job.set({ added: null, result: null, draft: null, choice: {}, error: null, warn: null,
              notice: `已改用內建的 ${q.display_name}（元件庫已有完整 3D 模型）` });
    void clearDsFile();
    flash(q.component_id, "center");
  }

  const keyLine = (
    <div className="ds-key">
      {keyOpen
        ? <><input className="ds-key-input" type="password" placeholder="貼上 ComPDF API Key" value={keyDraft}
                   onChange={(e) => setKeyDraft(e.target.value)} autoFocus />
            <button className="gbtn primary" disabled={!keyDraft.trim()}
                    onClick={() => { setComPdfKey(keyDraft.trim()); setKeyDraft(""); setKeyOpen(false); setHasPdfKey(true); job.set({ compdfBroken: false }); }}>儲存</button>
            <button className="gbtn" onClick={() => { setKeyDraft(""); setKeyOpen(false); }}>取消</button></>
        : !hasPdfKey
          ? <><span className="label"><i className="warn-dot" />未設定 ComPDF 金鑰：會改由 AI 直接讀原檔（沒有版面與表格解析）</span>
              <button className="link-btn" onClick={() => setKeyOpen(true)}>設定金鑰</button></>
          : compdfBroken
            ? hasLocalComPdfKey()
              ? <><span className="label ds-bad"><i className="warn-dot" />ComPDF 金鑰無效 · 目前改由 AI 直接讀原檔</span>
                  <button className="link-btn" onClick={() => setKeyOpen(true)}>更換金鑰</button>
                  <button className="link-btn" title="可能只是暫時被擋；下次讀取會再試一次 ComPDF（一小時後也會自動再試）"
                          onClick={() => { clearComPdfBroken(); job.set({ compdfBroken: false }); }}>重新試 ComPDF</button>
                  <button className="link-btn" onClick={() => { setComPdfKey(""); setHasPdfKey(!!getComPdfKey()); job.set({ compdfBroken: false }); }}>改回內建金鑰</button></>
              // 內建金鑰被擋：不是使用者的設定問題，不能說「你的金鑰無效」
              : <><span className="label ds-bad"><i className="warn-dot" />內建的 ComPDF 金鑰暫時無法使用（不是你的設定問題）· 這次改由 AI 直接讀原檔</span>
                  <button className="link-btn" title="下次讀取會再試一次 ComPDF（一小時後也會自動再試）"
                          onClick={() => { clearComPdfBroken(); job.set({ compdfBroken: false }); }}>重新試 ComPDF</button>
                  <button className="link-btn" onClick={() => setKeyOpen(true)}>改用自己的金鑰</button></>
            : <><span className="label"><i className="ok-dot" />ComPDF 文件解析已啟用{hasLocalComPdfKey() ? "" : "（內建金鑰）"}</span>
                <button className="link-btn" onClick={() => setKeyOpen(true)}>更換金鑰</button>
                {hasLocalComPdfKey() && <button className="link-btn" onClick={() => { setComPdfKey(""); setHasPdfKey(!!getComPdfKey()); }}>移除</button>}</>}
    </div>
  );

  return (
    <div className={`ds-import ${dragOver ? "is-drop" : ""}`} ref={root}
         // 同一個元件的好幾份檔案（規格書、機構圖、腳位圖）可以一起拖進來
         onDragOver={(e) => { if (stage || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setDragOver(true); }}
         onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
         onDrop={(e) => { if (stage) return; e.preventDefault(); setDragOver(false); const fs = [...e.dataTransfer.files];
                          if (result) { setAskReplace(true); return; } void pick(fs); }}>
      <div className="ds-head">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="ds-title">從規格書新增元件</span>
          <span className="label">上傳 PDF 或圖片格式的 datasheet（同一個元件可以一次選或拖進多份：規格書、機構圖、腳位圖）：PDF 由 ComPDF 解析文件與表格；圖片由 AI 直接讀。AI 擷取腳位、尺寸與電氣規格，確認後加入元件庫</span>
        </div>
        {stage ? <button className="gbtn" onClick={() => job.ctl?.abort()}>停止</button>
               : <button className="gbtn" disabled={!getApiKey()} title={!getApiKey() ? "要先在 AI 設計設定 OpenAI 金鑰" : ""}
                         onClick={() => (result ? setAskReplace(true) : input.current?.click())}>選擇檔案</button>}
        <input ref={input} type="file" accept="application/pdf,image/*" hidden multiple
               onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void pick(fs); }} />
      </div>

      {askReplace && result && !stage && (
        <div className="ds-note warn ds-shamatch">
          <span>{editingId ? `正在修改「${(draft ?? result.profile).display_name}」，要放棄修改並讀新的嗎？` : `還有一份「${(draft ?? result.profile).display_name}」沒確認，要捨棄它並讀新的嗎？`}</span>
          <span className="ds-shamatch-acts">
            <button className="gbtn danger" onClick={() => { setAskReplace(false); discard(); input.current?.click(); }}>{editingId ? "放棄修改，選新檔案" : "捨棄，選新檔案"}</button>
            <button className="gbtn" onClick={() => setAskReplace(false)}>取消</button>
          </span>
        </div>
      )}
      {job.staged.length > 0 && !stage && !result && (() => {
        const total = job.staged.reduce((a, f) => a + f.size, 0);
        const errs = job.staged.filter((f) => job.stagedErr[f.name]);
        const over = total > MAX_TOTAL;
        const size = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
        return (
          <div className="ds-staged">
            <span className="label">同一個元件的檔案（AI 會合併讀成一個元件）</span>
            {job.staged.map((f) => (
              <div key={f.name + f.size} className={`ds-staged-row ${job.stagedErr[f.name] ? "bad" : ""}`}>
                <span className="ds-staged-name">{f.name}</span><span className="label num">{size(f.size)}</span>
                <button className="link-btn" aria-label={`移除 ${f.name}`} title="移除這份" onClick={() => unstage(f)}>✕</button>
                {job.stagedErr[f.name] && <span className="ds-staged-err">{job.stagedErr[f.name]}</span>}
              </div>
            ))}
            {over && <span className="ds-staged-err">合計 {size(total)}，超過 20 MB：請移除一些，或只留有腳位圖與尺寸圖的頁面</span>}
            <span className="ds-staged-acts">
              <button className="gbtn primary" disabled={errs.length > 0 || over} title={errs.length ? "先移除有問題的檔案" : ""}
                      onClick={() => void run(job.staged)}>開始讀取（{job.staged.length} 份）</button>
              <button className="link-btn" onClick={() => input.current?.click()}>＋ 再加檔案</button>
              <button className="link-btn" onClick={() => job.set({ staged: [], stagedErr: {} })}>清除</button>
            </span>
            {errs.length > 0 && <span className="label" style={{ color: "var(--warn)" }}>有 {errs.length} 份檔案有問題，移除後才能開始</span>}
          </div>
        );
      })()}
      {!stage && (!result || keyOpen) && keyLine}
      {job.shaMatch && !stage && !result && (() => {
        const m = job.shaMatch;
        const d = m.addedAt ? new Date(m.addedAt) : null;
        return (
          <div className="ds-note warn ds-shamatch">
            <span>你{d ? `在 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ` : "之前"}已經用這份規格書（{file}）加入過「{m.name}」（{m.verified ? "已查證" : "待查證"}）{m.trashed ? "，它現在在「最近刪除」裡" : ""}。</span>
            {m.trashed ? <span className="ds-shamatch-acts">
              <button className="gbtn primary" onClick={() => {
                const twin = usePartTrash.getState().restore(m.id);
                job.set({ shaMatch: null, files: [], notice: twin ? `元件庫已有同型號的「${profiles.get(twin)?.display_name ?? twin}」：請到下方「已刪除 · 救回」選擇取代或兩個都留` : `已救回「${m.name}」` });
                if (!twin) flash(m.id, "center");
              }}>救回</button>
              <button className="gbtn" title="再讀一次會花幾分鐘與 API 費用" onClick={() => { const fs = job.files; job.set({ shaMatch: null }); if (fs.length) void run(fs, true); }}>仍要再讀一次</button>
              <button className="link-btn" onClick={() => job.set({ shaMatch: null, files: [] })}>取消</button>
            </span> : <span className="ds-shamatch-acts">
              <button className="gbtn primary" onClick={() => { job.set({ shaMatch: null }); flash(m.id, "center"); }}>打開已加入的</button>
              <button className="gbtn" title="打開上次讀出的腳位與名稱，可以直接修改（不用再花時間與費用讀一次）"
                      onClick={() => { const q = profiles.get(m.id); job.set({ shaMatch: null }); if (q) useDsJob.getState().openEdit(q); }}>用上次的結果</button>
              <button className="gbtn" title="再讀一次會花幾分鐘與 API 費用，結果可能略有不同" onClick={() => { const fs = job.files; const q = profiles.get(m.id);
                        job.set({ shaMatch: null, prevCompare: q ? { profile: q, addedAt: m.addedAt } : null }); if (fs.length) void run(fs, true); }}>仍要再讀一次</button>
              <button className="link-btn" onClick={() => job.set({ shaMatch: null, files: [] })}>取消</button>
            </span>}
          </div>
        );
      })()}
      {interrupted && !stage && !result && (
        <div className="ds-row ds-interrupted"><i className="warn-dot" />
          <span>上次讀取 <b>{interrupted.fileName}</b> 被重新整理中斷</span>
          <button className="gbtn" onClick={retry}>重新讀取</button>
          <button className="link-btn" onClick={() => { clearRunning(); void clearDsFile(); job.set({ interrupted: null }); }}>不用了</button>
        </div>
      )}
      {stage && <div className={`ds-row ${job.stageWarn ? "ds-stage-warn" : ""}`}><span className="spin" /> <span>{file} · {job.stageWarn && !/ComPDF/.test(stage) ? <><i className="warn-dot" />{job.stageWarn}，改由 AI 直接讀原檔 · </> : null}{stage}… <span className="num" style={{ color: "var(--text-3)" }}>{Math.max(0, Math.round((now - job.t0) / 1000))} 秒</span></span></div>}
      {stage && <div className="label">通常 1–4 分鐘。可以關掉這張卡做別的事，完成後回來確認（讀取中請不要重新整理）。</div>}
      {warn && !stage && result && <div className="ds-row" style={{ color: "var(--warn)" }}><i className="warn-dot" />{warn}
        {isComPdfKeyError(result.source.compdfError) && <button className="link-btn nw" onClick={() => { setKeyOpen(true); job.set({ warn: null }); }}>{hasLocalComPdfKey() ? "更換金鑰" : "改用自己的金鑰"}</button>}</div>}
      {error && !stage && <div className="ds-row ds-error">
        <span className="ds-error-text">{error}</span>
        <span className="ds-error-acts">
          {job.retryable && <button className="gbtn" onClick={retry}>重試</button>}
          {!result && <button className="link-btn" onClick={() => input.current?.click()}>{job.retryable ? "換一個檔案" : "選擇其他檔案"}</button>}
          <button className="link-btn" onClick={() => { job.set({ error: null }); void clearDsFile(); }}>關閉</button>
        </span></div>}
      {job.stopped && !stage && !result && <div className="ds-row"><i className="warn-dot" />已停止讀取 {file}
        <button className="gbtn" onClick={() => { job.set({ stopped: false }); void retry(); }}>重新讀取</button>
        <button className="link-btn" onClick={() => { job.set({ stopped: false }); void clearDsFile(); }}>關閉</button></div>}
      {notice && !stage && <div className="ds-row"><span style={{ color: "var(--ok)" }}>✓</span> {notice}
        <button className="link-btn" onClick={() => job.set({ notice: null })}>知道了</button></div>}
      {added && !stage && <div className="ds-row"><span style={{ color: "var(--ok)" }}>✓</span> {added}</div>}

      {result && (() => {
        const p = draft ?? result.profile;
        const blocking = checkProfile(p).errors;
        if (!p.display_name.trim()) blocking.push("元件名稱是空的");
        // 模型自己說尺寸是推定的（規格書沒寫）：不能寫成「依規格書」
        // 尺寸：AI 明確回報（size_found）優先；舊結果沒有這欄才看備註
        const sizeGuessed = sizeGuessedOf(result);
        const sizePending = !editingId && sizeGuessed && !job.sizeChoice;
        void modelTick;   // 重新生成 3D 後重算
        const hint = shapeHintOf(p);
        const hasModel = !!getStoredModel(p.component_id)?.parts.length;
        const ref = job.modelRef ?? result.modelRef;
        const m3 = job.model3d;
        const refLabel = ref ? `（${ref.file && (result.source.files?.length ?? 0) > 1 ? `檔${ref.file} ` : ""}${ref.page ? `p.${ref.page}` : ""}）`.replace("（）", "") : "";
        // 腳位順序推定比尺寸推定危險（VCC/GND 接反會燒元件）：表上標黃、加警示
        const pinGuessed = result.uncertain.some((x) => PIN_ORDER.test(x));
        // 推定事項：去掉內部欄位名、數值範圍不斷行；和腳位有關的排第一並標黃
        const tidy = (t: string) => t.replace(/bbox_mm/g, "外形尺寸").replace(/parameters\s*中?/g, "預設參數").replace(/position_mm/g, "腳位座標")
          .replace(/pins?\[\]/g, "腳位").replace(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)(?:\s*(V|mA|mm|°C|Hz|秒|s)\b)?/g, (_m, a, b, u) => `${a}⁠–⁠${b}${u ? " " + u : ""}`);
        const isPin = (t: string) => PIN_ORDER.test(t);
        // AI 的備註常寫「暫以 5 V 建檔」：使用者已經選了別的值，就在後面註明，不要和選擇互相矛盾
        const youChose = (t: string) => {
          const hits = result.conflicts.filter((c) => choice[c.field] != null && (t.includes(c.label) || t.includes(c.label.replace(/電壓|電流$/, ""))
            || (/supply_voltage/.test(c.field) && /供電|工作電壓|電源電壓/.test(t))));
          return hits.length && /暫|先|保守|採用|填|建檔|預設/.test(t)
            ? `${t}（你已選 ${hits.map((c) => `${c.label} ${choice[c.field]}\u00A0${unitOf(c.field)}`).join("、")}）` : t;
        };
        const notes = [...result.warnings.map((t) => ({ text: tidy(t), warn: true })),
                       ...result.uncertain.map((t) => ({ text: youChose(tidy(t)), warn: isPin(t) }))]
          .sort((a, b) => Number(b.warn) - Number(a.warn));
        const dup = dupOf(p);
        // 已經新增過同型號的自建元件（不同檔案或重讀）：問要取代還是另存
        const twinCId = editingId ? null : customTwinOf(p, profiles);
        const twinC = twinCId ? profiles.get(twinCId) : undefined;
        const twinSrc = twinCId ? loadSources()[twinCId] : undefined;
        // 套用選擇後的電氣值（加入前讓人看到最後會存成什麼）
        const finalElec = { ...p.electrical } as Record<string, unknown>;
        for (const c of result.conflicts) if (choice[c.field] != null) finalElec[c.field.replace(/^electrical\./, "")] = choice[c.field];
        const unchosen = result.conflicts.some((c) => choice[c.field] == null) || sizePending;
        const conflictsLeft = result.conflicts.filter((c) => choice[c.field] == null).length;
        // 供電還有不一致沒選：任何地方都不能先顯示 AI 填的保守值，像是已經定案
        const supplyPending = result.conflicts.some((c) => /supply_voltage_(min|max)/.test(c.field) && choice[c.field] == null);
        // 重讀同一份：和上次比，哪裡不一樣
        const prev = job.prevCompare?.profile;
        const diffs: string[] = [];
        if (prev && !editingId) {
          const ids = (x: ComponentProfile) => x.pins.map((q) => q.id.trim()).join("、");
          if (ids(prev) !== ids(p)) diffs.push(`腳位 ${ids(prev)} → ${ids(p)}`);
          if (prev.geometry.bbox_mm.join() !== p.geometry.bbox_mm.join()) diffs.push(`外形 ${fmtSize(prev.geometry.bbox_mm).replace(/（.*$/, "")} → ${fmtSize(p.geometry.bbox_mm).replace(/（.*$/, "")}`);
          // 供電還沒選：不算差異（選了才比）
          if (!supplyPending && fmtSupply(prev.electrical) !== fmtSupply(finalElec as ComponentProfile["electrical"])) diffs.push(`供電 ${fmtSupply(prev.electrical) ?? "—"} → ${supplyPending ? "待選" : fmtSupply(finalElec as ComponentProfile["electrical"]) ?? "—"}`);
          if (prev.display_name !== p.display_name) diffs.push(`名稱「${prev.display_name}」→「${p.display_name}」`);
        }
        return (
          <div className="ds-preview">
            {editingId && <div className="ds-edit-title"><b>查看／修改</b><span className="label">改完按「儲存修改」；腳位有改會改回待查證</span></div>}
            {dup && <div className="ds-note warn">元件庫已有內建的「{dup.display_name}」（{dup.geometry.model_source === "vendor" ? "原廠 CAD 模型" : "完整 3D 模型"}{dup.evidence.some((e) => e.verification_status === "unverified") ? "" : "、已查證"}）。建議改用內建；仍要新增會多一個待查證的版本。</div>}
            {twinC && <div className="ds-note warn">你已新增過「{twinC.display_name}」（{twinSrc?.addedAt ? `${new Date(twinSrc.addedAt).getFullYear()}/${new Date(twinSrc.addedAt).getMonth() + 1}/${new Date(twinSrc.addedAt).getDate()}` : "日期不明"}{twinSrc?.fileName ? `，${twinSrc.fileName}` : ""}）。可以取代舊的（沿用同一個元件，專案不用改），或另存一份。
              {job.aiName && <> 名稱沿用你取的「{p.display_name}」<button className="link-btn" onClick={() => { const n = job.aiName!; setDraft((d) => d && { ...d, display_name: n }); job.set({ aiName: null }); }}>改用 AI 讀到的名稱（{job.aiName}）</button></>}
              {twinC.evidence.length > 0 && twinC.evidence.every((e) => e.verification_status === "verified") && <><br /><b>舊的已查證：取代後會變回待查證。</b></>}</div>}
            {prev && !editingId && <div className={`ds-note ${diffs.length ? "pin" : ""}`}>{diffs.length ? <>和上次讀的結果不同：{diffs.join("；")}</> : "和上次讀的結果相同（腳位、外形、供電、名稱）"}</div>}
            {!editingId && <div className="label">AI 讀取，每次結果可能略有不同，請對照規格書核對腳位與數值。</div>}
            <div className="ds-meta">
              <span className="stack ds-thumb-col">
                <Thumb profile={thumbProfile(p)} size={84} />
              </span>
              <div className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
                <input className="ds-cell ds-name ds-name-input" value={p.display_name} aria-label="元件名稱" title="元件名稱（可以改）"
                       onChange={(e) => setDraft((d) => d && { ...d, display_name: e.target.value })} />
                <span className="label">{CATEGORY[p.category] ?? p.category}{p.manufacturer ? ` · ${p.manufacturer}` : ""} · {p.pins.length} 腳</span>
                <span className="label num"><span className="nw">外形 {fmtSize(p.geometry.bbox_mm)}</span>
                  {/* 規格書的「高」「深」常被讀反（例如 HC-SR04）：一鍵對調，3D 跟著變 */}
                  <button className="link-btn ds-swap" title="深和高讀反了？對調後 3D 外形跟著改"
                          onClick={() => setDraft((d) => d && { ...d, geometry: { ...d.geometry, bbox_mm: [d.geometry.bbox_mm[0], d.geometry.bbox_mm[2], d.geometry.bbox_mm[1]] } })}>深／高對調</button></span>
                <span className="label num">{!result.source.fileName
                  ? "沒有出處紀錄"
                  : (result.source.files?.length ?? 0) > 1
                    ? <button className="link-btn ds-files-toggle" aria-expanded={showFiles} onClick={() => setShowFiles((v) => !v)}>
                        來源：{result.source.files!.length} 份檔案{result.source.compdfError ? "（有 ComPDF 失敗）" : ""} {showFiles ? "▴" : "▾"}</button>
                  : result.source.parser === "image"
                    ? <>來源 {result.source.fileName} · 圖片 · AI 直接讀</>
                  : result.source.parser === "compdf"
                    ? <>來源 {result.source.fileName} · ComPDF 解析 {result.source.pageCount ?? "?"} 頁{result.source.tables ? `、${result.source.tables} 張表` : ""}</>
                    : <>來源 {result.source.fileName} · <i className="warn-dot" />{result.source.compdfError ? `ComPDF 失敗 · ${cpErr(result.source.compdfError)} · ` : result.source.compdfSkipped ? "ComPDF 金鑰無效，已略過 · " : "未用 ComPDF · "}AI 直接讀原檔</>}</span>
                {(result.source.files?.length ?? 0) > 1
                  ? showFiles && <span className="ds-files">{result.source.files!.map((f, i) => (
                      <span key={i} className="label num">檔{i + 1} {f.fileName} · {f.parser === "compdf" ? `ComPDF ${f.pages ?? "?"} 頁` : f.parser === "image" ? "圖片 · AI 直接讀" : f.compdfError ? `ComPDF 失敗（${cpErr(f.compdfError)}）· AI 直接讀` : "AI 直接讀原檔"} · <span className="mono" title={f.sha256}>{f.sha256.slice(0, 10)}…</span></span>))}</span>
                  : result.source.sha256 && <span className="label num mono" title={result.source.sha256}>SHA-256 {result.source.sha256.slice(0, 12)}…</span>}
                {!editingId && <span className="label">{!sizeGuessed ? `依規格書尺寸${result.sizePage ? `（${result.sizeFile && result.source.files ? `檔${result.sizeFile} ${result.source.files[result.sizeFile - 1]?.fileName ?? ""} ` : ""}第 ${result.sizePage} 頁）` : ""} · 3D 依此生成`
                  : job.sizeChoice === "user" ? "尺寸是你量的 · 3D 依此生成"
                  : job.sizeChoice === "estimate" ? <><i className="warn-dot" />尺寸為推定 · 3D 只是示意</>
                  : <span style={{ color: "var(--warn)" }}><i className="warn-dot" />規格書沒寫尺寸 · 待確認（見下方）</span>}</span>}
                {(supplyPending || fmtSupply(finalElec as ComponentProfile["electrical"])) && (
                  <span className="label num">{supplyPending ? <span style={{ color: "var(--warn)" }}>供電（待選）</span> : `供電 ${fmtSupply(finalElec as ComponentProfile["electrical"])}`}
                    {p.electrical.quiescent_current_ma != null && !result.conflicts.some((c) => c.field === "electrical.quiescent_current_ma")
                      ? ` · 靜態 ${p.electrical.quiescent_current_ma} mA` : ""}</span>
                )}
              </div>
            </div>
            {/* 順序固定：最危險的腳位警示與腳位表 → 推定事項（腳位相關排第一）→ 確認鈕。看完才按得到 */}
            {/* 3D：依規格書圖面繪製 或 簡單外形（任何元件都可以選；之後在「查看／修改」也能重畫） */}
            <div className="ds-3d">
              <span className="seg small ds-3d-seg" role="radiogroup" aria-label="3D 外形">
                <button role="radio" aria-checked={hint === "model"} className={hint === "model" ? "is-on" : ""} disabled={m3?.state === "running"}
                        onClick={() => hasModel ? setDraft((d) => d && { ...d, geometry: { ...d.geometry, asset_id: withShapeHint(d.geometry.asset_id, "model") } }) : void draw3d(p)}>
                  繪製 3D 模型（依規格書圖面）</button>
                <button role="radio" aria-checked={hint !== "model"} className={hint !== "model" ? "is-on" : ""}
                        onClick={() => setDraft((d) => d && { ...d, geometry: { ...d.geometry, asset_id: withShapeHint(d.geometry.asset_id, keywordShape(d) ?? "box") } })}>簡單外形</button>
              </span>
              <span className={`label ds-3d-status ${m3 && /none|error|nofile/.test(m3.state) ? "warn" : ""}`}>
                {m3?.state === "running" ? <><span className="spin" /> {m3.msg}</>
                  : hint === "model" ? `3D 依規格書圖面生成${refLabel}（基本形狀拼成，細節以實物為準）`
                  : m3?.msg ?? ((hint === "box" || hint === "module") ? "外形示意（依尺寸生成，不是實物外觀）" : "簡單外形（依元件種類與尺寸生成）")}
              </span>
              <span className="ds-3d-acts">
                {hint !== "model" && (
                  <select className="ds-cell ds-shape" value={hint} aria-label="簡單外形種類" title="簡單外形種類"
                          onChange={(e) => { const h = e.target.value as ShapeHint; setDraft((d) => d && { ...d, geometry: { ...d.geometry, asset_id: withShapeHint(d.geometry.asset_id, h) } }); }}>
                    {SHAPE_HINTS.filter((h) => h !== "model").map((h) => <option key={h} value={h}>{SHAPE_LABEL[h]}</option>)}
                  </select>
                )}
                <button className="link-btn" disabled={m3?.state === "running"} onClick={() => void draw3d(p)}>{hasModel ? "重新繪製" : "繪製 3D 模型"}</button>
                <button className="link-btn" disabled={m3?.state === "running"} title="另外給一張產品照片或機構圖，只用來畫 3D" onClick={() => photo.current?.click()}>＋ 加一張照片給 3D 用</button>
                <input ref={photo} type="file" accept="image/*,application/pdf" hidden
                       onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void draw3d(p, [f]); }} />
              </span>
            </div>
            {result.cable && !editingId && <div className="ds-note pin">這個元件用排線接頭{result.cable !== "排線接頭" ? `（${result.cable}）` : ""}，不是直接插麵包板：接線時要用對應的排線或轉接板；3D 暫時以排針示意。</div>}
            {result.conflicts.length > 0 && <ConflictPicker conflicts={result.conflicts} choice={choice} setChoice={setChoice} fileNames={(result.source.files?.length ?? 0) > 1 ? result.source.files!.map((f) => f.fileName) : undefined} />}
            {!editingId && sizeGuessed && (
              <SizeBlock bbox={p.geometry.bbox_mm} estimate={result.profile.geometry.bbox_mm} choice={job.sizeChoice}
                         onEdit={(b) => { setDraft((d) => d && { ...d, geometry: { ...d.geometry, bbox_mm: b } }); job.set({ sizeChoice: null }); }}
                         onChoose={(c) => {
                           if (c === "estimate") setDraft((d) => d && { ...d, geometry: { ...d.geometry, bbox_mm: [...result.profile.geometry.bbox_mm] as [number, number, number] } });
                           job.set({ sizeChoice: c });
                         }} />
            )}
            {pinGuessed && <div className="ds-note warn"><b>腳位順序為推定</b><br />接線前請對照實物上的絲印，<span className="nw">VCC 和 GND 接反</span>會燒壞元件</div>}
            <table className="ds-pins">
              <thead><tr><th>腳{pinGuessed && <i className="warn-dot" style={{ marginLeft: 6 }} title="腳位順序為推定" />}</th><th>類型</th><th>功能</th><th>位置 mm</th><th>頁</th><th /></tr></thead>
              <tbody>
                {(p.pins as DraftPin[]).map((q, i) => (
                  <tr key={q._k ?? q.id}><td><input className="ds-cell mono" value={q.id} aria-label="腳名" onChange={(e) => editPin(i, { id: e.target.value })} /></td>
                    <td><select className="ds-cell" value={q.type} aria-label="類型" onChange={(e) => editPin(i, { type: e.target.value as typeof q.type })}>
                      {Object.entries(PIN_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                    <td>{q.functions.join("、") || "—"}</td><td className="num">{q.position_mm[0]}, {q.position_mm[2]}</td>
                    <td className="num">{q._page != null ? `${q._file && (result.source.files?.length ?? 0) > 1 ? `檔${q._file} ` : ""}p.${q._page}` : "—"}</td>
                    <td><button className="link-btn" title="刪除這隻腳" aria-label={`刪除 ${q.id}`} onClick={() => removePin(i)}>✕</button></td></tr>
                ))}
              </tbody>
            </table>
            <div className="ds-edit-row">
              <button className="link-btn" onClick={addPin}>＋ 加一隻腳</button>
              <span className="label">名稱、腳名、類型可以直接改；位置依 2.54mm 排列</span>
            </div>
            {blocking.length > 0 && <div className="ds-note warn"><b>還不能{editingId ? "儲存" : "加入"}：</b>{blocking.join("；")}</div>}
            {notes.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="label">規格書沒寫清楚的地方（加入後標為待查證）</span>
                {(showAll ? notes : notes.slice(0, 3)).map((n, i) => <span key={i} className={`ds-note ${n.warn ? "pin" : ""}`}>{n.text}</span>)}
                {notes.length > 3 && !showAll && <button className="link-btn" onClick={() => setShowAll(true)}>再看 {notes.length - 3} 項 ▾</button>}
              </div>
            )}
            {!editingId && (
              <div className="ds-summary label num">
                <span>加入後：{p.pins.length} 腳（{p.pins.map((q) => q.id.trim()).join("、")}）{!supplyPending && fmtSupply(finalElec as ComponentProfile["electrical"]) ? ` · 供電 ${fmtSupply(finalElec as ComponentProfile["electrical"])}` : ""}</span>
                {result.conflicts.map((c) => {
                  const o = c.options.find((x) => x.value === choice[c.field]);
                  return <span key={c.field} className="ds-sum-row"><span>{c.label}</span>
                    {o ? <span>{o.value}{"\u00A0"}{unitOf(c.field)}{o.page != null ? `（第 ${o.page} 頁）` : ""}</span> : <span style={{ color: "var(--warn)" }}>（待選）</span>}</span>;
                })}
              </div>
            )}
            {!editingId && !askDiscard && (unchosen || blocking.length > 0) && (
              <div className="ds-why label">{[
                conflictsLeft ? `還有 ${conflictsLeft} 項規格要選（上方黃色框）` : "",
                sizePending ? "外形尺寸還沒確認（上方「尺寸」）" : "",
                blocking.length ? `${blocking.length} 個問題要先修正（見上方）` : "",
              ].filter(Boolean).join(" · ")}，才能{dup || twinC ? "新增（「不新增，改用內建」不受影響）" : "加入"}</div>
            )}
            <div className="ds-actions">
              {askDiscard
                ? <><span className="ds-ask">捨棄這次讀取的結果？（讀取花了幾分鐘與 API 費用，捨棄後要重新讀）</span>
                    <button className="gbtn danger" onClick={discard}>確定捨棄</button>
                    <button className="gbtn" onClick={() => setAskDiscard(false)}>取消</button></>
                : editingId
                  ? <><button className="gbtn primary" disabled={blocking.length > 0} onClick={() => saveEdit(p)}>儲存修改</button>
                      <button className="gbtn" onClick={discard}>取消</button></>
                  : twinC
                    ? <><button className="gbtn primary" disabled={blocking.length > 0 || unchosen} title="沿用舊的元件 id：用到它的專案會自動換成新資料"
                                onClick={() => confirm(p, twinC.component_id)}>取代舊的</button>
                        <button className="gbtn" disabled={blocking.length > 0 || unchosen} onClick={() => confirm(p)}>仍要另存一份</button>
                        {dup && <button className="gbtn" onClick={() => useBuiltIn(dup)}>不新增（改用內建的 {dup.display_name}）</button>}
                        <button className="gbtn" onClick={() => setAskDiscard(true)}>捨棄</button></>
                  : dup
                    ? <><button className="gbtn primary" onClick={() => useBuiltIn(dup)}>不新增（改用內建的 {dup.display_name}）</button>
                        <button className="gbtn" disabled={blocking.length > 0 || unchosen} onClick={() => confirm(p)}>仍要新增</button>
                        <button className="gbtn" onClick={() => setAskDiscard(true)}>捨棄</button></>
                    : <><button className="gbtn primary" disabled={blocking.length > 0 || unchosen}
                                title={unchosen ? "先選定規格不一致的數值" : ""}
                                onClick={() => confirm(p)}>加入元件庫</button>
                        <button className="gbtn" onClick={() => setAskDiscard(true)}>捨棄</button></>}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/**
 * 規格衝突：每個欄位各選一個值。各欄位分開選可能拼出「規格書哪一頁都沒寫過」的組合，
 * 所以提供「一次採用第 N 頁的數值」，混用不同頁時明講。
 */
function ConflictPicker({ conflicts, choice, setChoice, fileNames }: {
  conflicts: SpecConflict[]; choice: Record<string, number>; setChoice: (v: (p: Record<string, number>) => Record<string, number>) => void;
  /** 多檔時：選項的頁碼前面加檔名 */
  fileNames?: string[];
}) {
  // 「位置」＝哪份檔案的第幾頁（多檔時 檔1 p.4 和 檔2 p.4 是不同地方）
  type Loc = string;
  const locOf = (o: SpecConflict["options"][number]): Loc | null => o.page == null ? null : `${o.file ?? 0}:${o.page}`;
  const locLabel = (l: Loc) => { const [f, pg] = l.split(":").map(Number); return f && fileNames ? `檔${f} 第 ${pg} 頁` : `第 ${pg} 頁`; };
  const locs = [...new Set(conflicts.flatMap((c) => c.options.map(locOf)).filter((x): x is Loc => x != null))]
    .sort((a, b) => { const [fa, pa] = a.split(":").map(Number), [fb, pb] = b.split(":").map(Number); return fa - fb || pa - pb; });
  // 一個位置能涵蓋兩個以上欄位才值得「一次採用」
  const groupLocs = conflicts.length > 1 ? locs.filter((l) => conflicts.filter((c) => c.options.some((o) => locOf(o) === l)).length >= 2) : [];
  const chosenLoc = (c: SpecConflict) => { const o = c.options.find((x) => x.value === choice[c.field]); return o ? locOf(o) : null; };
  const chosenPages = new Set(conflicts.map(chosenLoc).filter((x) => x != null));
  // 只有「明明有同一處的值可選，卻混用了別處」才警告：某欄位在主要那處根本沒寫，就不算拼湊
  const counts = new Map<Loc, number>();
  for (const c of conflicts) { const l = chosenLoc(c); if (l != null) counts.set(l, (counts.get(l) ?? 0) + 1); }
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const coverAll = locs.filter((l) => conflicts.every((c) => c.options.some((o) => locOf(o) === l)));
  const mixed = main == null ? [] : conflicts.filter((c) => { const l = chosenLoc(c); return l != null && l !== main && c.options.some((o) => locOf(o) === main); });
  const allChosen = conflicts.every((c) => choice[c.field] != null);
  // 「一次採用」之後，那一處沒寫到的欄位：講出來並標亮，不要默默留著沒選
  const [applied, setApplied] = useState<{ loc: Loc; missing: string[] } | null>(null);
  const stillMissing = applied ? conflicts.filter((c) => applied.missing.includes(c.field) && choice[c.field] == null) : [];
  return (
    <div className="stack" style={{ gap: 8 }}>
      {groupLocs.length > 0 && (
        <div className="ds-row" style={{ flexWrap: "wrap" }}>
          <span className="label">同一頁的數值一起用比較不會拼錯：</span>
          {groupLocs.map((l) => (
            <button key={l} className="link-btn" onClick={() => {
              const missing = conflicts.filter((c) => !c.options.some((o) => locOf(o) === l)).map((c) => c.field);
              setChoice((x) => {
                const n = { ...x };
                for (const c of conflicts) { const o = c.options.find((q) => locOf(q) === l); if (o) n[c.field] = o.value; }
                return n;
              });
              setApplied({ loc: l, missing });
            }}>一次採用{locLabel(l)}的數值</button>
          ))}
        </div>
      )}
      {applied && stillMissing.length > 0 && (
        <div className="ds-note pin">{locLabel(applied.loc)}沒有寫{stillMissing.map((c) => `「${c.label}」`).join("、")}，請在下方另外選。</div>
      )}
      {conflicts.map((c) => (
        <div key={c.field} className={`ds-note warn ds-conflict ${stillMissing.includes(c) ? "needs-pick" : ""}`}>
          <b>規格書前後不一致：{c.label}</b>
          <span>請選一個（以實物板上標示為準）：</span>
          <div className="ds-choices">
            {c.options.map((o) => (
              <label key={o.value} className={`ds-choice ${choice[c.field] === o.value ? "is-on" : ""}`}>
                <input type="radio" name={c.field} checked={choice[c.field] === o.value}
                       onChange={() => setChoice((x) => ({ ...x, [c.field]: o.value }))} />
                <span className="num">{o.value}{unitOf(c.field) ? " " + unitOf(c.field) : ""}</span>
                {(o.page != null || (fileNames && o.file)) && <span className="label">{fileNames && o.file ? `${fileNames[o.file - 1] ?? `檔${o.file}`} ` : ""}{o.page != null ? `第 ${o.page} 頁` : ""}</span>}
                {o.quote && <span className="label ds-quote">「{o.quote}」</span>}
              </label>
            ))}
          </div>
        </div>
      ))}
      {allChosen && chosenPages.size > 1 && (mixed.length > 0 || coverAll.length > 0) && (
        <div className="ds-note pin">注意：選的數值來自不同地方（{[...chosenPages].map((l) => locLabel(l as string)).join("、")}），這個組合規格書沒有同一處寫過，請對照實物確認。
          {coverAll.length > 0 && <>{coverAll.map(locLabel).join("、")}同時寫了這幾項，可以按上方「一次採用」。</>}</div>
      )}
    </div>
  );
}

/**
 * 規格書沒寫外形尺寸：不能默默用 AI 估的值。請使用者量實物填入，或明確接受推定值（3D 只是示意）。
 * 輸入順序是「寬 × 深 × 高」；bbox_mm 存的是 [寬 x, 高 y, 深 z]。
 */
function SizeBlock({ bbox, estimate, choice, onEdit, onChoose }: {
  bbox: [number, number, number]; estimate: [number, number, number]; choice: "user" | "estimate" | null;
  onEdit: (b: [number, number, number]) => void; onChoose: (c: "user" | "estimate") => void;
}) {
  const fields: [string, number][] = [["寬", 0], ["深", 2], ["高", 1]];
  // 輸入中的字串（可以暫時是空的）；三個都是正數才同步到預覽的 3D
  const [vals, setVals] = useState<string[]>(() => bbox.map(String));
  const nums = vals.map((v) => parseFloat(v));
  const valid = nums.every((v) => v > 0 && Number.isFinite(v));
  const asBbox = () => nums.slice(0, 3) as [number, number, number];
  if (choice) return (
    <div className="ds-note ds-size done">
      <span>尺寸：{choice === "user" ? "你量的" : "推定值（3D 只是示意）"} {bbox[0]} × {bbox[2]} × {bbox[1]} mm（寬 × 深 × 高）</span>
      <button className="link-btn" onClick={() => { setVals(bbox.map(String)); onEdit([...bbox] as [number, number, number]); }}>改</button>
    </div>
  );
  return (
    <div className="ds-note warn ds-size">
      <b>尺寸</b>
      <span>規格書沒有寫外形尺寸。請量一下實物填入（寬 × 深 × 高 mm），或確定用推定值。</span>
      <span className="ds-size-inputs">
        {fields.map(([label, i], k) => (
          <label key={label} className="ds-size-field">
            <span className="label">{label}</span>
            <input type="number" min={0.1} step={0.1} inputMode="decimal" className="ds-key-input num" aria-label={`${label}（mm）`}
                   value={vals[i]}
                   onChange={(e) => { const v = [...vals]; v[i] = e.target.value; setVals(v);
                                      const n = v.map((x) => parseFloat(x)); if (n.every((x) => x > 0 && Number.isFinite(x))) onEdit(n as [number, number, number]); }} />
            {k < 2 && <span className="label">×</span>}
          </label>
        ))}
        <span className="label">mm</span>
      </span>
      <span className="label">預先填的是 AI 推定的 {estimate[0]} × {estimate[2]} × {estimate[1]} mm</span>
      <span className="ds-size-acts">
        <button className="gbtn primary" disabled={!valid} title={valid ? "" : "三個數字都要大於 0"} onClick={() => { onEdit(asBbox()); onChoose("user"); }}>用我填的尺寸</button>
        <button className="gbtn" onClick={() => { setVals(estimate.map(String)); onChoose("estimate"); }}>用推定值（3D 只是示意）</button>
      </span>
    </div>
  );
}
