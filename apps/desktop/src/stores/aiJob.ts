import { create } from "zustand";
import type { Thought } from "../ai/generate";

/**
 * AI 設計工作的狀態放在全域，不放在 AI 面板元件裡：
 * 面板收起、切到別的卡片時工作照跑，頂列狀態晶片與底部 AI 卡仍看得到「設計中 · N 秒」，回來也還能按「停止」。
 */
type Upd<T> = T | ((prev: T) => T);
interface AiJob {
  running: boolean; t0: number; thought: Thought | null; log: string[]; error: string | null;
  ctl: AbortController | null;
  /** 輸入框的需求文字：面板關掉、停止、失敗都留著 */
  draft: string; setDraft: (v: string) => void;
  /** 錯誤的原文（收在「詳細」裡）與類型 */
  errorDetail: string | null; errorKind: string | null; setErrorInfo: (detail: string | null, kind: string | null) => void;
  /** 設計開始時的空白專案：使用者跑去首頁，要能回來 */
  base: unknown | null; setBase: (v: unknown | null) => void;
  /** 使用者不在原專案時完成的設計：首頁提示「打開」 */
  finishedId: string | null; setFinishedId: (v: string | null) => void;
  /** 這次工作屬於哪個專案（設計開始時的 project_id）；別的專案的 AI 面板不顯示這次的紀錄 */
  jobProjectId: string | null; setJobProjectId: (v: string | null) => void;
  /** 上次設計被重新整理／關閉中斷（啟動時從 localStorage 讀到還在跑的紀錄） */
  interrupted: { prompt: string; at: number; boardId?: string; bbId?: string } | null; clearInterrupted: () => void;
  /** 這次設計用的開發板／麵包板（中斷後重來要還原） */
  runMeta: { boardId?: string; bbId?: string }; setRunMeta: (m: { boardId?: string; bbId?: string }) => void;
  /** 首頁按「重新設計」：AI 面板一打開就直接開始跑 */
  pendingRun: boolean; setPendingRun: (v: boolean) => void;
  /** 清掉上一次的紀錄（換專案時，沒有工作在跑才清） */
  clearIdle: () => void;
  setRunning: (v: boolean) => void; setT0: (v: number) => void; setThought: (v: Thought | null) => void;
  setLog: (v: Upd<string[]>) => void; setError: (v: string | null) => void; setCtl: (c: AbortController | null) => void;
}
export const useAiJob = create<AiJob>((set) => ({
  running: false, t0: 0, thought: null, log: [], error: null, ctl: null,
  // 需求文字也存 localStorage：重新整理不會不見
  draft: (() => { try { return localStorage.getItem("assemblex.aiDraft") ?? ""; } catch { return ""; } })(),
  setDraft: (draft) => { try { localStorage.setItem("assemblex.aiDraft", draft); } catch { /* */ } set({ draft }); },
  errorDetail: null, errorKind: null, setErrorInfo: (errorDetail, errorKind) => set({ errorDetail, errorKind }),
  base: null, setBase: (base) => set({ base }),
  // 背景完成的設計：重新整理後首頁仍有「設計完成 · 打開」
  finishedId: (() => { try { return localStorage.getItem("assemblex.aiFinished"); } catch { return null; } })(),
  setFinishedId: (finishedId) => { try { finishedId ? localStorage.setItem("assemblex.aiFinished", finishedId) : localStorage.removeItem("assemblex.aiFinished"); } catch { /* */ } set({ finishedId }); },
  jobProjectId: null, setJobProjectId: (jobProjectId) => set({ jobProjectId }),
  clearIdle: () => set((s) => (s.running ? {} : { log: [], error: null, errorDetail: null, errorKind: null, jobProjectId: null })),
  setRunning: (running) => {
    // 跑的時候記一筆：如果被重新整理打斷，下次打開能說「上次被中斷」並一鍵重來
    try {
      if (running) { localStorage.setItem("assemblex.aiRunning", JSON.stringify({ prompt: useAiJob.getState().draft, at: Date.now(), ...useAiJob.getState().runMeta })); localStorage.removeItem("assemblex.aiInterrupted"); }
      else localStorage.removeItem("assemblex.aiRunning");
    } catch { /* */ }
    set(running ? { running, interrupted: null } : { running });
  },
  // 啟動時：上次還在跑的紀錄轉成「被中斷」，留到使用者按「重新設計」或「不用了」才刪（重新整理兩次也不會不見）
  interrupted: (() => {
    try {
      const run = localStorage.getItem("assemblex.aiRunning");
      if (run) { localStorage.setItem("assemblex.aiInterrupted", run); localStorage.removeItem("assemblex.aiRunning"); }
      return JSON.parse(localStorage.getItem("assemblex.aiInterrupted") ?? "null");
    } catch { return null; }
  })(),
  runMeta: {}, setRunMeta: (runMeta) => set({ runMeta }),
  pendingRun: false, setPendingRun: (pendingRun) => set({ pendingRun }),
  clearInterrupted: () => { try { localStorage.removeItem("assemblex.aiInterrupted"); } catch { /* */ } set({ interrupted: null }); }, setT0: (t0) => set({ t0 }), setThought: (thought) => set({ thought }),
  setLog: (v) => set((s) => ({ log: typeof v === "function" ? v(s.log) : v })),
  setError: (error) => set({ error }), setCtl: (ctl) => set({ ctl }),
}));

/** 每秒跳一次的經過秒數（多個元件共用同一個計時來源） */
import { useEffect, useState } from "react";
export function useAiSeconds(): number {
  const { running, t0 } = useAiJob();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return running ? Math.max(0, Math.round((now - t0) / 1000)) : 0;
}

// 設計進行中關掉或重新整理：先提醒（工作會中斷）
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => { if (useAiJob.getState().running) { e.preventDefault(); e.returnValue = ""; } });
}
