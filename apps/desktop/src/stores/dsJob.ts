import { create } from "zustand";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { loadSources, saveSource, customTwinOf, type DatasheetResult, type StoredSource } from "../ai/datasheet";
import { useProject } from "./projectStore";
import { isComPdfBroken } from "../ai/compdf";

/**
 * 「從規格書新增元件」的工作狀態放全域：讀規格書要 1–5 分鐘，
 * 使用者關掉元件庫卡、切到別的卡片時工作照跑，回來還看得到進度與結果。
 *
 * 重新整理也不能讓一次要花幾分鐘和費用的讀取默默消失：
 *  - 預覽（結果、編輯中的腳位表、衝突選擇）存在 localStorage（assemblex.dsPending），重開後還能確認加入
 *  - 讀取中記下 {fileName, t0}（assemblex.dsRunning），重開後沒有結果就顯示「被重新整理中斷 · 重新讀取」
 *  - 原檔存在 IndexedDB（盡力而為），重開後「重試／重新讀取」不用再選一次檔案
 */
type Upd<T> = T | ((prev: T) => T);
const val = <T,>(v: Upd<T>, prev: T): T => (typeof v === "function" ? (v as (p: T) => T)(prev) : v);
/** 編輯中的腳位：_k 列的固定 key、_id0 原本的腳名（改名時 evidence 跟著改）、_page 出處頁碼 */
export type DraftPin = ComponentProfile["pins"][number] & { _k?: string; _id0?: string; _page?: number | null; _file?: number };
interface DsJob {
  /** files：這次讀的檔案（一次可以多份：規格書＋機構圖＋腳位圖…）；fileName 是顯示用的合併名稱 */
  stage: string | null; fileName: string; files: File[]; t0: number;
  /** 選好、還沒開始讀的檔案（多份時先列出來，可以移除），以及逐份檢查的結果（檔名 → 錯誤） */
  staged: File[]; stagedErr: Record<string, string>;
  result: DatasheetResult | null; draft: ComponentProfile | null; error: string | null; warn: string | null;
  /** false＝同一個檔案再試也一樣（格式不對、不是規格書），不顯示「重試」 */
  retryable: boolean;
  added: string | null; choice: Record<string, number>; ctl: AbortController | null;
  /** ComPDF 回過 401／403：介面不能再寫「已啟用」 */
  compdfBroken: boolean;
  /** 「查看／修改」既有的自建元件（不是新讀的規格書） */
  editingId: string | null;
  /** 上次讀取被重新整理打斷 */
  interrupted: { fileName: string; t0: number } | null;
  /** 一次性的提示（例如「已改用內建的 …」） */
  notice: string | null;
  /** 使用者按了「停止」（顯示「已停止讀取 · 重新讀取」） */
  stopped: boolean;
  /** 讀取中 ComPDF 已經失敗：進度列立刻轉成警示，不用等 AI 讀完 */
  stageWarn: string | null;
  /** 這份規格書（SHA-256 相同）已經加入過：讀之前先問（省時間和費用、避免重複元件） */
  shaMatch: { id: string; name: string; verified: boolean; addedAt?: number; trashed?: boolean } | null;
  /** 「仍要再讀一次」：上次的結果，讀完後列出哪裡不一樣 */
  prevCompare: { profile: ComponentProfile; addedAt?: number } | null;
  /** 預覽沿用了使用者原本取的名稱時，AI 讀到的名稱（「改用 AI 讀到的名稱」用） */
  aiName: string | null;
  /** 規格書沒寫尺寸時，使用者的決定：user＝用我量的、estimate＝用推定值；null＝還沒決定（不能加入） */
  sizeChoice: "user" | "estimate" | null;
  /** 「重新生成 3D」後的圖面出處（覆蓋 result.modelRef） */
  modelRef: { file: number | null; page: number | null } | null;
  /** 「繪製 3D」這一步的狀態（背景跑，不擋確認）：running／done／none（沒有圖面）／error／nofile（沒有原檔） */
  model3d: { state: "running" | "done" | "none" | "error" | "nofile"; msg: string | null } | null;
  /** 首頁橫幅按「重新讀取」：元件庫卡一打開（或已經開著）就自動從 IndexedDB 的原檔重讀 */
  autoResume: boolean;
  /** 從別處（首頁）要求重讀被中斷／停止的那份規格書；實際讀取由元件庫卡執行 */
  resumeInterrupted: () => void;
  set: (p: Partial<Omit<DsJob, "set" | "setDraft" | "setChoice" | "openEdit" | "resumeInterrupted">>) => void;
  setDraft: (v: Upd<ComponentProfile | null>) => void;
  setChoice: (v: Upd<Record<string, number>>) => void;
  openEdit: (p: ComponentProfile) => void;
}

const PENDING = "assemblex.dsPending";
const RUNNING = "assemblex.dsRunning";
type Pending = Pick<DsJob, "fileName" | "result" | "draft" | "choice" | "warn" | "error" | "retryable" | "sizeChoice">;
function readJson<T>(k: string): T | null {
  try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
const pending = readJson<Pending>(PENDING);
const running = readJson<{ fileName: string; t0: number }>(RUNNING);

/** 草稿腳位加上編輯用欄位 */
export function toDraft(p: ComponentProfile, pinPages: Record<string, number | null>, pinFiles?: Record<string, number>): ComponentProfile {
  return { ...p, pins: p.pins.map((q, i) => ({ ...q, _k: `k${i}`, _id0: q.id, _page: pinPages[q.id] ?? null,
    ...(pinFiles?.[q.id] ? { _file: pinFiles[q.id] } : {}) })) } as ComponentProfile;
}

export const useDsJob = create<DsJob>((set) => ({
  stage: null, fileName: pending?.fileName ?? "", files: [], t0: 0, staged: [], stagedErr: {},
  result: pending?.result ?? null, draft: pending?.draft ?? null, error: pending?.error ?? null, warn: pending?.warn ?? null,
  retryable: pending?.retryable ?? true,
  added: null, choice: pending?.choice ?? {}, ctl: null,
  compdfBroken: isComPdfBroken(), editingId: null,
  interrupted: running && !pending?.result ? running : null,
  notice: null, stopped: false, stageWarn: null, shaMatch: null, autoResume: false, prevCompare: null, aiName: null, sizeChoice: pending?.sizeChoice ?? null, modelRef: null, model3d: null,
  resumeInterrupted: () => set((s) => (s.stage ? {} : { autoResume: true })),
  set: (p) => set(p),
  setDraft: (v) => set((s) => ({ draft: val(v, s.draft) })),
  setChoice: (v) => set((s) => ({ choice: val(v, s.choice) })),
  openEdit: (p) => {
    const src = loadSources()[p.component_id];
    const pinPages = src?.pinPages ?? {};
    const result: DatasheetResult = {
      profile: p, pinPages, conflicts: [], uncertain: [], warnings: [], pinFiles: src?.pinFiles,
      source: src ?? { fileName: "", sha256: "", parser: "pdf", pageCount: null, tables: 0 },
    };
    set({ editingId: p.component_id, result, model3d: null, modelRef: null, draft: toDraft(p, pinPages, src?.pinFiles), choice: src?.chosen ?? {},
          error: null, warn: null, added: null, notice: null });
  },
}));
// 重開時有中斷紀錄：已經轉成 interrupted 顯示，紀錄本身留到使用者處理（重新讀取或關掉）

// 預覽／錯誤一出現就存；加入、捨棄後清掉。修改既有元件不存（元件本身已在元件庫）
useDsJob.subscribe((s, prev) => {
  if (s.result === prev.result && s.draft === prev.draft && s.choice === prev.choice && s.error === prev.error && s.sizeChoice === prev.sizeChoice
      && s.warn === prev.warn && s.editingId === prev.editingId) return;
  try {
    if (s.editingId) return;
    if (s.result || s.error) {
      const p: Pending = { fileName: s.fileName, result: s.result, draft: s.draft, choice: s.choice, warn: s.warn, error: s.error, retryable: s.retryable, sizeChoice: s.sizeChoice };
      localStorage.setItem(PENDING, JSON.stringify(p));
    } else localStorage.removeItem(PENDING);
  } catch { /* 存不了：只是重新整理後救不回來 */ }
});

// 讀取中離開／重新整理：瀏覽器先問一下（讀取要幾分鐘、也要花費）
const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
useDsJob.subscribe((s, prev) => {
  if (!!s.stage === !!prev.stage) return;
  if (s.stage) window.addEventListener("beforeunload", onUnload);
  else window.removeEventListener("beforeunload", onUnload);
});

export function markRunning(fileName: string, t0: number) {
  try { localStorage.setItem(RUNNING, JSON.stringify({ fileName, t0 })); } catch { /* 無痕模式 */ }
}
export function clearRunning() {
  try { localStorage.removeItem(RUNNING); } catch { /* 無痕模式 */ }
}

// ── 原檔存 IndexedDB（盡力而為：失敗就只是重開後要重選檔案）──
const DB = "assemblex-ds", STORE = "files", FILE_KEY = "last";
function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const d = await db();
    return await new Promise<T | null>((ok) => {
      const t = d.transaction(STORE, mode); const r = f(t.objectStore(STORE));
      r.onsuccess = () => ok((r.result as T) ?? null); r.onerror = () => ok(null);
    }).finally(() => d.close());
  } catch { return null; }
}
/** 這次讀的檔案（一份或多份）；重新整理後「重試／重新讀取」用 */
export const saveDsFiles = (fs: File[]) => tx<void>("readwrite", (s) => s.put(fs, FILE_KEY));
export const clearDsFile = () => tx<void>("readwrite", (s) => s.delete(FILE_KEY));
const asFile = (v: Blob | null, name: string) => !v ? null : v instanceof File ? v : new File([v], name, { type: v.type });
/** 舊資料存的是單一檔案、新資料是陣列：都轉成陣列 */
const asFiles = (v: unknown, name: string): File[] =>
  Array.isArray(v) ? v.map((x, i) => asFile(x as Blob, `${name}-${i + 1}`)).filter((x): x is File => !!x) : v ? [asFile(v as Blob, name)!] : [];
export async function loadDsFiles(): Promise<File[]> {
  return asFiles(await tx<unknown>("readonly", (s) => s.get(FILE_KEY)), useDsJob.getState().fileName || "datasheet.pdf");
}
/** 每個自建元件的原檔（查證時「下載原檔」用，多份就每份一個按鈕）；元件永久刪除時一起刪 */
export const savePartFiles = (id: string, fs: File[]) => tx<void>("readwrite", (s) => s.put(fs, `part:${id}`));
export const deletePartFile = (id: string) => tx<void>("readwrite", (s) => s.delete(`part:${id}`));
export async function loadPartFiles(id: string, name = "datasheet.pdf"): Promise<File[]> {
  return asFiles(await tx<unknown>("readonly", (s) => s.get(`part:${id}`)), name);
}
/** 下載原檔：用 <a download> 帶原本的檔名（直接開 blob 網址另存會變成一串亂碼檔名） */
export function openFile(f: File, name = f.name) {
  const url = URL.createObjectURL(f);
  const a = document.createElement("a"); a.href = url; a.download = name || "datasheet.pdf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── 最近刪除的自建元件：保留 7 天可救回（關掉元件庫卡、重新整理都還在）──
const TRASH = "assemblex.partTrash";
const WEEK = 7 * 24 * 3600 * 1000;
/** replaced：被「取代舊的」換掉的（提示寫「已取代」，復原＝換回來） */
export interface TrashedPart { profile: ComponentProfile; source?: StoredSource; deletedAt: number; replaced?: boolean }
function loadTrash(): TrashedPart[] {
  const all = readJson<TrashedPart[]>(TRASH) ?? [];
  const keep = all.filter((t) => Date.now() - t.deletedAt < WEEK);
  // 超過 7 天的才真的刪原檔
  for (const t of all) if (!keep.includes(t)) void deletePartFile(t.profile.component_id);
  return keep;
}
function writeTrash(list: TrashedPart[]) {
  try { localStorage.setItem(TRASH, JSON.stringify(list)); } catch { /* 無痕模式 */ }
}
interface PartTrash {
  trash: TrashedPart[];
  /** 剛刪除的那一個：20 秒內顯示「復原」提示（狀態在全域，關掉卡片再打開還在） */
  last: TrashedPart | null;
  remove: (p: ComponentProfile, opts?: { replaced?: boolean }) => void;
  /** 救回。mode：replace＝取代元件庫裡同型號／同 id 的元件（舊的進最近刪除）；copy＝兩個都留（救回的換新 id）。
   *  沒給 mode 而且有衝突：不動作，回傳衝突的元件 id 讓介面問 */
  restore: (id: string, mode?: "replace" | "copy", opts?: { undo?: boolean }) => string | null;
  dismiss: () => void;
}
export const usePartTrash = create<PartTrash>((set, get) => ({
  trash: loadTrash(),
  last: null,
  remove: (p, opts) => {
    const t: TrashedPart = { profile: p, source: loadSources()[p.component_id], deletedAt: Date.now(), ...(opts?.replaced ? { replaced: true } : {}) };
    useProject.getState().removeCustomProfile(p.component_id);
    saveSource(p.component_id, null);
    const ds = useDsJob.getState();
    if (ds.editingId === p.component_id) ds.set({ editingId: null, result: null, draft: null });
    const trash = [t, ...get().trash.filter((x) => x.profile.component_id !== p.component_id)];
    writeTrash(trash); set({ trash, last: t });
  },
  restore: (id, mode, opts) => {
    const t = get().trash.find((x) => x.profile.component_id === id);
    if (!t) return null;
    const live = useProject.getState().profiles;
    // 同 id（之後又加了一個較新的）或同型號：不能默默蓋掉或多出一份
    const twin = live.has(id) ? id : customTwinOf(t.profile, live);
    if (twin && !mode) return twin;
    let profile = t.profile;
    if (twin && mode === "replace") {
      if (opts?.undo) {
        // 復原「取代」：新版本直接拿掉（它本來就是要被復原的那一步），不放進最近刪除
        useProject.getState().removeCustomProfile(twin); saveSource(twin, null);
      } else get().remove(live.get(twin)!);
    }
    if (twin && mode === "copy") {
      const nid = `${id.replace(/_c[a-z0-9]{8}$/, "")}_c${Date.now().toString(36)}`;   // 「另一份」：_c＋時間，型號比對時會去掉
      profile = { ...profile, component_id: nid, geometry: { ...profile.geometry, asset_id: profile.geometry.asset_id.replace(id, nid) } };
    }
    if (!useProject.getState().addCustomProfile(profile)) return null;   // 存不了：留在最近刪除，不要兩邊都沒有
    if (t.source) saveSource(profile.component_id, t.source);
    const trash = get().trash.filter((x) => x !== t);
    writeTrash(trash); set({ trash, last: get().last?.profile.component_id === id ? null : get().last });
    return null;
  },
  dismiss: () => set({ last: null }),
}));
