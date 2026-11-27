import { create } from "zustand";
import type { CircuitIR } from "@assemblex/circuit-schema";

/**
 * 手動調整模式的狀態：選了什麼、復原／重做紀錄。
 * 真正的電路還是在 projectStore（套用時呼叫它的 applyEdit），這裡只放編輯過程。
 */
export type EditSel =
  | { kind: "part"; id: string }
  | { kind: "wire"; id: string; end?: "from" | "to" }
  | null;

interface EditJob {
  on: boolean;
  /** 復原紀錄屬於哪個專案（換專案才清；結束調整、開卡片都保留） */
  projectId: string | null;
  sel: EditSel;
  /** 等使用者點一個孔：把元件移過去，或把導線的某一端移過去 */
  pickHole: boolean;
  undo: CircuitIR[];
  redo: CircuitIR[];
  msg: string | null;
  start: (projectId: string) => void;
  stop: () => void;
  select: (s: EditSel) => void;
  setPick: (v: boolean) => void;
  push: (prev: CircuitIR) => void;
  setMsg: (m: string | null) => void;
  popUndo: (cur: CircuitIR) => CircuitIR | null;
  popRedo: (cur: CircuitIR) => CircuitIR | null;
}

export const useEditJob = create<EditJob>((set, get) => ({
  on: false, projectId: null, sel: null, pickHole: false, undo: [], redo: [], msg: null,
  start: (projectId) => set((s) => s.projectId === projectId
    ? { on: true, sel: null, pickHole: false, msg: null }
    : { on: true, projectId, sel: null, pickHole: false, undo: [], redo: [], msg: null }),
  stop: () => set({ on: false, sel: null, pickHole: false, msg: null }),
  select: (sel) => set({ sel, pickHole: false, msg: null }),
  setPick: (pickHole) => set({ pickHole }),
  push: (prev) => set((s) => ({ undo: [...s.undo.slice(-49), prev], redo: [] })),
  setMsg: (msg) => set({ msg }),
  popUndo: (cur) => {
    const u = get().undo; if (!u.length) return null;
    const prev = u[u.length - 1];
    set((s) => ({ undo: s.undo.slice(0, -1), redo: [...s.redo, cur] }));
    return prev;
  },
  popRedo: (cur) => {
    const r = get().redo; if (!r.length) return null;
    const next = r[r.length - 1];
    set((s) => ({ redo: s.redo.slice(0, -1), undo: [...s.undo, cur] }));
    return next;
  },
}));

// 自動化測試／除錯用（和 window.__project 一樣）
if (typeof window !== "undefined") (window as unknown as { __edit: typeof useEditJob }).__edit = useEditJob;
