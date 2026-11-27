import { create } from "zustand";
import { useAiJob } from "./aiJob";
import { boardOf, boardPlacement } from "../data/boards";
import { loadCustomProfiles, saveCustomProfiles, loadSources, builtInTwinOf } from "../ai/datasheet";
import {
  CircuitIR, type CircuitIR as IR, type ComponentProfile,
  buildBreadboard, indexHoles, runElectricalChecks, resolvePhysicalNets, detectGpioOvercurrent, detectIsolatedParts, detectPartOverlaps,
  type BreadboardHole, type ElectricalIssue, ComponentProfile as ProfileSchema,
  BREADBOARDS, BREADBOARD_830, type BreadboardSpec,
} from "@assemblex/circuit-schema";

import dht22 from "../data/examples/dht22_alarm.circuit.json";
import buttonLed from "../data/examples/button_led.circuit.json";
import blink from "../data/examples/blink.circuit.json";

/** 專案列表。目前是內建範例；之後接上本機檔案／後端時換掉這裡的來源就好。 */
export interface ProjectMeta {
  id: string;
  title: string;
  brief: string;          // 當初的自然語言需求
  updated: string;        // 舊資料的顯示字串（新資料看 updatedAt）
  /** 建立／最後修改的時間（ms）。首頁依此排序、顯示「3 分鐘前」 */
  updatedAt?: number;
  /** 最後一次打開的時間（ms） */
  openedAt?: number;
  /** AI 設計完成的時間：首頁「新」標記只看這個（改名、複製不算新） */
  designedAt?: number;
  /** 建立時間（複製出來的副本用這個排序） */
  createdAt?: number;
  /** 來源：ai＝AI 設計；example＝從內建範例複製；copy＝自己專案的副本 */
  origin?: "ai" | "example" | "copy";
  ir: unknown;
  /** 設計推理；claude = 真的由 AI（目前是 OpenAI GPT-5.5）生成並通過檢查；欄位名沿用舊值以相容已存的專案，recorded = 內建範例的預錄推理 */
  steps?: string[];
  source?: "recorded" | "claude";
  /** AI 誠實列出的「需求做不到或打折」的地方 */
  unmet?: string[];
}

const SAVED = "assemblex.projects";
/** 組裝進度依專案存：回首頁、重新整理、重開 App 都接得回來 */
const PROGRESS = "assemblex.progress";
type Progress = { done: number[]; step: number | null; at: number };
export function loadProgress(id: string): Progress | null {
  try { return (JSON.parse(localStorage.getItem(PROGRESS) ?? "{}") as Record<string, Progress>)[id] ?? null; } catch { return null; }
}
function saveProgress(id: string, done: number[], step: number | null) {
  if (!id || id === "new_project") return;
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS) ?? "{}") as Record<string, Progress>;
    all[id] = { done, step, at: Date.now() };
    localStorage.setItem(PROGRESS, JSON.stringify(all));
  } catch { storageFail(); }
}
/** 重新整理後回到剛才的專案 */
const LAST_OPEN = "assemblex.lastOpen";
function loadSaved(): ProjectMeta[] {
  try { return JSON.parse(localStorage.getItem(SAVED) ?? "[]") as ProjectMeta[]; } catch { return []; }
}
function writeSaved(list: ProjectMeta[]): boolean {
  try { localStorage.setItem(SAVED, JSON.stringify(list)); storageOk(); return true; } catch { storageFail(); return false; }
}
/** 儲存空間滿了（localStorage 寫不進去）：首頁與工作台顯示警告，不默默丟資料 */
let storageErr = false;
export function storageFail() { if (!storageErr) { storageErr = true; queueMicrotask(() => useProject.setState({ storageError: true })); } }
export function storageOk() { if (storageErr) { storageErr = false; queueMicrotask(() => useProject.setState({ storageError: false })); } }
const TRASH = "assemblex.trash";
function loadTrash(): (ProjectMeta & { deletedAt: number })[] {
  try {
    const t = JSON.parse(localStorage.getItem(TRASH) ?? "[]") as (ProjectMeta & { deletedAt: number })[];
    return t.filter((x) => Date.now() - x.deletedAt < 7 * 86400e3);
  } catch { return []; }
}
function writeTrash(t: (ProjectMeta & { deletedAt: number })[]) {
  try { localStorage.setItem(TRASH, JSON.stringify(t)); } catch { storageFail(); }
}
/** 「剛剛」「5 分鐘前」「昨天」「11/24」 */
export function relTime(ms?: number): string {
  if (!ms) return "";
  const d = Date.now() - ms, m = Math.floor(d / 60000);
  if (d < 60000) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小時前`;
  const days = Math.round(h / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const t = new Date(ms); return `${t.getMonth() + 1}/${t.getDate()}`;
}
export const PROJECTS: ProjectMeta[] = [
  { id: "dht22_alarm", title: "DHT22 溫濕度告警", updated: "",
    brief: "DHT22 溫濕度監控，超過 30°C 時蜂鳴器響，按鈕可以靜音", ir: dht22 },
  { id: "button_led", title: "按鈕控制 LED", updated: "",
    brief: "按鈕切換 LED（上拉電阻＋軟體去彈跳）", ir: buttonLed },
  { id: "blink_demo", title: "Blink", updated: "",
    brief: "最簡單的 Blink，一顆 LED 閃爍", ir: blink },
];
const defaultCircuit = dht22;

/** 新專案：只有麵包板和開發板，沒有任何元件與接線，等使用者描述需求。 */
/** 新專案：只有麵包板和選定的開發板，沒有任何元件與接線，等使用者描述需求。 */
/** 可選的麵包板 */
export const BREADBOARD_OPTIONS = [
  { id: "breadboard_830", short: "830 孔", note: "63 欄 · 有電源軌" },
  { id: "breadboard_400", short: "400 孔", note: "30 欄 · 有電源軌" },
  { id: "breadboard_170", short: "170 孔", note: "17 欄 · 無電源軌" },
] as const;
/** 專案用到的「從規格書匯入、尚未查證」元件（腳位可能是推定的，不能當成確定可以接線） */
export function unverifiedParts(ir: IR, profiles: Map<string, ComponentProfile>): ComponentProfile[] {
  return [...new Set(ir.logical.components.map((c) => c.profile_id))].map((id) => profiles.get(id))
    .filter((p): p is ComponentProfile => !!p && p.component_id.startsWith("user_") && p.evidence.some((e) => e.verification_status !== "verified"));
}
export function bbSpecOf(id: string | undefined): BreadboardSpec { return BREADBOARDS[id ?? ""] ?? BREADBOARD_830; }

function emptyProject(boardId: string, bbId = "breadboard_830") {
  const board = boardOf(boardId);
  const prof = PROFILES.find((p) => p.component_id === board.id);
  return {
    schema_version: "1.0", project_id: "new_project", revision: 0, units: "mm",
    logical: { board: { instance_id: "mcu1", profile_id: board.id, fqbn: board.fqbn },
               components: [], nets: [], firmware_bindings: {} },
    physical: { breadboard: { instance_id: "bb1", profile_id: bbId, position_mm: [0, 0, 0] },
                placements: [boardPlacement(board, prof?.pins ?? [], bbSpecOf(bbId).size_mm[0])], wires: [] },
  };
}

/**
 * 元件庫：整個資料夾自動載入，新增元件只要丟一個 JSON 進去。
 * 任何一個 profile 不合 schema 就讓它在啟動時炸掉 —— 壞掉的規格資料比沒有更危險。
 */
const PROFILE_MODULES = import.meta.glob<{ default: unknown }>(
  "../data/components/*.json", { eager: true },
);
const PROFILES: ComponentProfile[] = Object.entries(PROFILE_MODULES)
  .map(([path, m]) => {
    try {
      return ProfileSchema.parse(m.default);
    } catch (e) {
      throw new Error(`元件 profile 格式錯誤：${path}\n${String(e)}`);
    }
  })
  .sort((a, b) => a.display_name.localeCompare(b.display_name, "zh-Hant"));

/** 鏡頭的預設視角。3D 只負責工作台本身，不給自由繞，只在這幾個姿態之間飛。 */
export type ViewId = "overview" | "board" | "mcu";
export type LeftTab = "prompt" | "library";
export type Screen = "home" | "project";
export type CardId = "ai" | "elec" | "fw" | "ar" | "lib";
export type RightTab = "inspector" | "firmware" | "assembly";

interface State {
  screen: Screen;
  /** 底部儀表卡展開成右側詳細面板的是哪一張（null＝都收起來） */
  openCard: CardId | null;
  setOpenCard: (c: CardId | null) => void;
  openProject: (id: string) => void;
  previewProject: (id: string) => void;
  /** 首頁正在預覽的那張專案卡 */
  previewId: string | null;
  goHome: () => void;
  newProject: (boardId?: string, opts?: { keepJob?: boolean }) => void;
  /** 新專案／AI 設計用的開發板 */
  boardId: string;
  setBoard: (id: string) => void;
  /** 新專案／AI 設計用的麵包板尺寸 */
  bbId: string;
  setBreadboard: (id: string) => void;
  /** 從規格書新增的元件（存在這台電腦，啟動時載入） */
  /** 存進元件庫；儲存空間滿了存不了回傳 false（介面要說，不能假裝加入成功） */
  addCustomProfile: (p: ComponentProfile) => boolean;
  removeCustomProfile: (id: string) => void;
  verifyCustomProfile: (id: string) => void;
  /** 「改回待查證」：verifyCustomProfile 的反向 */
  unverifyCustomProfile: (id: string) => void;
  /** 自建元件的說明：出處檔名、加入日期、和哪個內建元件同型號（AI 設計會改用內建的） */
  customPartInfo: (id: string) => { fileName?: string; addedAt?: number; twinId: string | null; twinName: string | null };
  ir: IR;
  profiles: Map<string, ComponentProfile>;
  holes: BreadboardHole[];
  holeIndex: Map<string, BreadboardHole>;
  issues: ElectricalIssue[];

  /** hover 一個孔就把同一導通群組整組點亮 —— 麵包板內部連通性是看不見的，要讓它看得見。 */
  hoveredHole: string | null;
  /** 滑鼠停在哪個元件上：該元件半透明、顯示它的每隻腳插在哪裡 */
  hoveredPart: string | null;
  setHoveredPart: (id: string | null) => void;
  /** 在電氣驗證 hover／點選某個 net，3D 裡對應的導線與孔位一起亮起來。 */
  selectedNet: string | null;
  view: ViewId;
  /** 使用者手動轉過鏡頭，按鈕要顯示「可回正」而不是假裝還在預設視角。 */
  cameraDirty: boolean;
  /** AR 組裝分頁目前選到的步驟（3D 會高亮對應的元件或導線）。 */
  activeStep: number | null;
  /** 已完成的組裝步驟數（按「完成這步」才前進；只是點來看不算完成） */
  /** 真的按過「完成」的步驟（集合，不是最高水位：跳到最後一步按完成，不會把前面全算成完成） */
  done: number[];
  markDone: (i: number) => void;
  unmarkDone: (i: number) => void;
  /** 清掉這個專案的組裝進度（重新開始） */
  resetProgress: () => void;
  /** 手機回傳的組裝進度：整份取代 done，組裝中時也跟著跳到手機那一步 */
  applyRemoteProgress: (done: number[], step: number | null) => void;
  /** 從 3D 點選或在清單點選而鎖定的網路：滑鼠移開也不會取消 */
  pinnedNet: string | null;
  pinNet: (id: string | null) => void;
  /** 每次按視角鈕都 +1，即使是同一個視角也會重新飛回去（使用者轉亂了可以一鍵回正）。 */
  viewNonce: number;
  leftTab: LeftTab;
  rightTab: RightTab;

  setView: (v: ViewId) => void;
  setCameraDirty: (d: boolean) => void;
  setActiveStep: (i: number | null) => void;
  setLeftTab: (t: LeftTab) => void;
  setRightTab: (t: RightTab) => void;
  setHoveredHole: (id: string | null) => void;
  selectNet: (id: string | null) => void;
  loadIR: (raw: unknown) => void;
  projects: ProjectMeta[];
  /** 存下 AI 生成的專案（只存在這台電腦），並打開它 */
  addProject: (p: ProjectMeta, open?: boolean) => void;
  renameProject: (id: string, title: string) => void;
  /** 複製一份成為自己的專案（範例也可以複製來改）；回傳新 id */
  duplicateProject: (id: string, patch?: Partial<ProjectMeta>) => string | null;
  /** 刪除自己的專案（範例不能刪）；回傳被刪的那筆，給「復原」用 */
  deleteProject: (id: string) => ProjectMeta | null;
  restoreProject: (p: ProjectMeta) => void;
  /** 最近刪除（保留 7 天，可救回；重新整理、離開首頁都還在） */
  trash: (ProjectMeta & { deletedAt: number })[];
  storageError: boolean;
  clearTrash: () => void;
}

function recompute(ir: IR, holes: BreadboardHole[]) {
  const profiles = new Map([...PROFILES, ...loadCustomProfiles()].map((p) => [p.component_id, p]));
  const index = new Map(holes.map((h) => [h.id, h]));
  return [...runElectricalChecks(ir, holes), ...detectGpioOvercurrent(ir, profiles),
          ...detectIsolatedParts(ir, profiles), ...detectPartOverlaps(ir, profiles, index)];
}

const holes = buildBreadboard();
let holesOf = "breadboard_830";

export const useProject = create<State>((set, get) => ({
  projects: [...loadSaved(), ...PROJECTS],
  addProject: (p, open = true) => {
    const now = Date.now();
    const mine = [{ ...p, updatedAt: p.updatedAt ?? now, openedAt: open ? now : p.openedAt }, ...loadSaved().filter((x) => x.id !== p.id)];
    writeSaved(mine);
    set({ projects: [...mine, ...PROJECTS] });
    if (open) {
      get().loadIR(p.ir);
      set({ previewId: p.id });
      try { sessionStorage.setItem(LAST_OPEN, p.id); } catch { /* */ }
    }
  },
  renameProject: (id, title) => {
    const t = title.trim(); if (!t) return;
    // 改名不算「修改電路」：不動 updatedAt，清單順序不跳（點下一張卡不會點空）
    const mine = loadSaved().map((x) => (x.id === id ? { ...x, title: t.slice(0, 60) } : x));
    writeSaved(mine);
    set({ projects: [...mine, ...PROJECTS] });
  },
  duplicateProject: (id, patch) => {
    const src = get().projects.find((x) => x.id === id);
    if (!src) return null;
    const nid = `${id.replace(/_copy_[a-z0-9]+$/, "")}_copy_${Date.now().toString(36)}`;
    const ir = { ...(src.ir as Record<string, unknown>), project_id: nid };
    const mine = loadSaved();
    const names = new Set(mine.map((x) => x.title));
    // 副本的副本不要疊成「（副本）（副本）」：去掉原本的後綴再編號，也不超過 60 字
    const base = src.title.replace(/（副本(?: \d+)?）$/, "").slice(0, 52);
    let title: string;
    // 範例的副本從「Blink 2」開始：和範例本身同名的話，清單裡會有兩張一模一樣的「Blink」
    if (src.source !== "claude") { names.add(src.title); title = base; for (let n = 2; names.has(title); n++) title = `${base} ${n}`; }
    else { title = `${base}（副本）`; for (let n = 2; names.has(title); n++) title = `${base}（副本 ${n}）`; }
    // 副本不是新設計：不帶 designedAt；來源標清楚（範例的副本不能說是 AI 生成）
    const copy: ProjectMeta = { ...src, id: nid, title, ir, source: "claude", updatedAt: Date.now(), createdAt: Date.now(), openedAt: undefined,
      designedAt: undefined, origin: src.source === "claude" ? (src.origin ?? "copy") : "example", steps: src.steps, updated: "", ...patch };
    // 範例本身沒有存推理：呼叫端（播放範例）會用 patch 帶完整的預錄推理，不要蓋掉
    if (src.source !== "claude" && !patch?.steps) copy.steps = [...(src.steps ?? []), "從範例複製"];
    // 存不進去（空間滿了）就不要假裝建好了：重新整理後會不見
    if (!writeSaved([copy, ...mine])) return null;
    set({ projects: [copy, ...mine, ...PROJECTS] });
    return nid;
  },
  deleteProject: (id) => {
    const mine = loadSaved();
    const gone = mine.find((x) => x.id === id) ?? null;
    if (!gone) return null;
    const rest = mine.filter((x) => x.id !== id);
    writeSaved(rest);
    const trash = [...get().trash.filter((x) => x.id !== id), { ...gone, deletedAt: Date.now() }];
    writeTrash(trash);
    set((s) => ({ projects: [...rest, ...PROJECTS], previewId: s.previewId === id ? null : s.previewId, trash }));
    return gone;
  },
  restoreProject: (p) => {
    const { deletedAt: _d, ...clean } = p as ProjectMeta & { deletedAt?: number }; void _d;
    const mine = [clean, ...loadSaved().filter((x) => x.id !== p.id)];
    writeSaved(mine);
    const trash = get().trash.filter((x) => x.id !== p.id);
    writeTrash(trash);
    set({ projects: [...mine, ...PROJECTS], trash });
  },
  trash: loadTrash(),
  storageError: false,
  clearTrash: () => { writeTrash([]); set({ trash: [] }); },
  screen: "home",
  openCard: null,
  // 組裝中打開別的卡片（看電氣、韌體）不結束組裝；只有「結束組裝」或 Esc 才結束
  setOpenCard: (c) => set((s) => ({ openCard: s.openCard === c ? null : c, selectedNet: null, pinnedNet: null })),
  openProject: (id) => {
    set({ previewId: id });
    if (useAiJob.getState().finishedId === id) useAiJob.getState().setFinishedId(null);   // 打開過了，「設計完成 · 打開」就收掉
    if (loadSaved().some((x) => x.id === id)) {
      const mine = loadSaved().map((x) => (x.id === id ? { ...x, openedAt: Date.now() } : x));
      writeSaved(mine); set({ projects: [...mine, ...PROJECTS] });
    }
    const p = get().projects.find((x) => x.id === id);
    if (p) get().loadIR(p.ir);
    set((s) => ({ screen: "project", view: "overview", viewNonce: s.viewNonce + 1, cameraDirty: false, openCard: null }));
    try { sessionStorage.setItem(LAST_OPEN, id); } catch { /* */ }
    // 瀏覽器／觸控板的「上一頁」＝回到專案列表（不要直接離開 App）
    try { if (history.state?.assemblexProject !== id) history.pushState({ assemblexProject: id }, ""); } catch { /* */ }
  },
  previewProject: (id) => {
    const p = get().projects.find((x) => x.id === id);
    if (!p || get().previewId === id) return;
    set({ previewId: id });   // 首頁選取框看這個（不能看 ir.project_id：不同專案可能是同一份電路複製來的）
    get().loadIR(p.ir);
  },
  goHome: () => { try { sessionStorage.removeItem(LAST_OPEN); } catch { /* */ } set((s) => ({ screen: "home", view: "overview", viewNonce: s.viewNonce + 1 })); },
  previewId: null,
  boardId: "arduino_uno_r3",
  setBoard: (id) => {
    set({ boardId: id });
    // 還沒設計的新專案：換板子就直接換 3D 裡的板子
    if (get().ir.project_id === "new_project") get().loadIR(emptyProject(id, get().bbId));
  },
  bbId: "breadboard_830",
  setBreadboard: (id) => {
    set({ bbId: id });
    if (get().ir.project_id === "new_project") get().loadIR(emptyProject(get().boardId, id));
  },
  newProject: (boardId, opts) => {
    try { sessionStorage.removeItem(LAST_OPEN); } catch { /* */ }
    // 上一個新專案的錯誤（例如金鑰無效）不要帶到這個新專案；從「回到設計」進來的要保留
    if (!opts?.keepJob) useAiJob.getState().clearIdle();
    const id = boardId ?? get().boardId;
    set({ boardId: id });
    get().loadIR(emptyProject(id, get().bbId));
    set((s) => ({ screen: "project", view: "overview", viewNonce: s.viewNonce + 1,
                  cameraDirty: false, openCard: "ai" }));
  },
  ir: CircuitIR.parse(defaultCircuit),
  profiles: new Map([...PROFILES, ...loadCustomProfiles()].map((p) => [p.component_id, p])),
  addCustomProfile: (p) => {
    const custom = [...loadCustomProfiles().filter((x) => x.component_id !== p.component_id), p];
    if (!saveCustomProfiles(custom)) { storageFail(); return false; }
    storageOk();
    set((st) => ({ profiles: new Map([...st.profiles, [p.component_id, p]]) }));
    return true;
  },
  removeCustomProfile: (id) => {
    saveCustomProfiles(loadCustomProfiles().filter((x) => x.component_id !== id));
    set((st) => { const m = new Map(st.profiles); m.delete(id); return { profiles: m }; });
  },
  // 使用者對照規格書原文確認過：evidence 全部改成 verified，元件庫不再顯示「待查證」
  verifyCustomProfile: (id) => {
    const list = loadCustomProfiles().map((x) => x.component_id !== id ? x
      : { ...x, evidence: x.evidence.map((e) => ({ ...e, verification_status: "verified" as const })) });
    if (!saveCustomProfiles(list)) storageFail();
    const p = list.find((x) => x.component_id === id);
    if (p) set((st) => ({ profiles: new Map([...st.profiles, [id, p]]) }));
  },
  customPartInfo: (id) => {
    const ps = get().profiles, p = ps.get(id), src = loadSources()[id];
    const twinId = p ? builtInTwinOf(p, ps) : null;
    return { fileName: src?.fileName, addedAt: src?.addedAt, twinId, twinName: twinId ? ps.get(twinId)?.display_name ?? null : null };
  },
  unverifyCustomProfile: (id) => {
    const list = loadCustomProfiles().map((x) => x.component_id !== id ? x
      : { ...x, evidence: x.evidence.map((e) => ({ ...e, verification_status: "unverified" as const })) });
    if (!saveCustomProfiles(list)) storageFail();
    const p = list.find((x) => x.component_id === id);
    if (p) set((st) => ({ profiles: new Map([...st.profiles, [id, p]]) }));
  },
  holes,
  holeIndex: indexHoles(holes),
  issues: recompute(CircuitIR.parse(defaultCircuit), holes),

  hoveredHole: null,
  hoveredPart: null,
  setHoveredPart: (id) => set({ hoveredPart: id }),
  selectedNet: null,
  view: "overview",
  cameraDirty: false,
  activeStep: null,
  done: [],
  markDone: (i) => set((st) => {
    const done = st.done.includes(i) ? st.done : [...st.done, i];
    saveProgress(st.ir.project_id, done, st.activeStep);
    return { done };
  }),
  unmarkDone: (i) => set((st) => {
    const done = st.done.filter((x) => x !== i);
    saveProgress(st.ir.project_id, done, st.activeStep);
    return { done };
  }),
  resetProgress: () => set((st) => { saveProgress(st.ir.project_id, [], null); return { done: [], activeStep: null }; }),
  // 手機帶著目前步驟：電腦跟著打開組裝引導、跳到同一步（3D 也只顯示組到這一步）
  applyRemoteProgress: (done, step) => set((st) => {
    saveProgress(st.ir.project_id, [...done], step ?? st.activeStep);
    return step != null && st.screen === "project"
      ? { done: [...done], activeStep: step, openCard: "ar" }
      : { done: [...done] };
  }),
  pinnedNet: null,
  pinNet: (id) => set({ pinnedNet: id, selectedNet: id }),
  viewNonce: 0,
  leftTab: "prompt",
  rightTab: "inspector",

  // 組裝中切視角（想看整塊板子）不結束組裝：步驟留著，切回來接著做
  setView: (v) => set((s) => ({ view: v, viewNonce: s.viewNonce + 1, cameraDirty: false,
                                selectedNet: s.pinnedNet })),
  setCameraDirty: (d) => set({ cameraDirty: d }),
  setActiveStep: (i) => set((st) => { if (i != null) saveProgress(st.ir.project_id, st.done, i); return { activeStep: i }; }),
  setLeftTab: (t) => set({ leftTab: t }),
  setRightTab: (t) => set({ rightTab: t }),
  setHoveredHole: (id) => set({ hoveredHole: id }),
  selectNet: (id) => set({ selectedNet: id }),
  loadIR: (raw) => {
    const ir = CircuitIR.parse(raw);
    // 麵包板尺寸跟著專案：換了型號就重建孔位表（830／400／170）
    let holes = get().holes;
    const want = ir.physical.breadboard?.profile_id ?? "breadboard_830";
    if (holesOf !== want) { holes = buildBreadboard(bbSpecOf(want)); holesOf = want; }
    set({ ir, holes, holeIndex: indexHoles(holes), issues: recompute(ir, holes), selectedNet: null, pinnedNet: null, hoveredHole: null,
          activeStep: null, done: loadProgress(ir.project_id)?.done ?? [] });
  },
}));

/** 某個孔屬於哪一團實體 net（給 3D 上色用）。 */
export function useNetOfHole() {
  const { ir, holes } = useProject();
  const nets = resolvePhysicalNets(ir, holes);
  const map = new Map<string, number>();
  nets.forEach((n, i) => n.holes.forEach((h) => map.set(h, i)));
  return map;
}

// 開發模式：讓截圖腳本可以直接讀寫狀態（正式版不會掛）
if (import.meta.env.DEV) (window as unknown as { __project: typeof useProject }).__project = useProject;

// 重新整理（或開發時熱更新）後回到剛才開著的專案
try {
  const last = sessionStorage.getItem(LAST_OPEN);
  if (last && useProject.getState().projects.some((p) => p.id === last)) useProject.getState().openProject(last);
} catch { /* */ }

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => { if (useProject.getState().screen === "project") useProject.getState().goHome(); });
}
