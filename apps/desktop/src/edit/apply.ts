import type { CircuitIR } from "@assemblex/circuit-schema";
import { useProject } from "../stores/projectStore";
import { useEditJob } from "../stores/editJob";

/** 套用一次手動調整：記進復原紀錄、更新畫面與檢查、存回專案（版本 +1） */
export function applyEdit(next: CircuitIR, opts: { record?: boolean } = {}) {
  const s = useProject.getState();
  const prev = s.ir;
  if (opts.record !== false) useEditJob.getState().push(prev);
  const ir = { ...next, revision: (prev.revision ?? 1) + 1 } as CircuitIR;
  s.loadIR(ir);
  persist(ir);
}

/** 存回自己的專案（範例不能改：要先複製，編輯列會擋） */
export function persist(ir: CircuitIR) {
  const s = useProject.getState();
  const meta = s.projects.find((p) => p.id === ir.project_id);
  if (!meta || meta.source !== "claude") return;
  s.addProject({ ...meta, ir, updatedAt: Date.now() }, false);
  // addProject(open=false) 不會重新載入畫面；目前畫面已是 ir
}

export function undoEdit() {
  const cur = useProject.getState().ir;
  const prev = useEditJob.getState().popUndo(cur);
  if (!prev) return false;
  useProject.getState().loadIR(prev); persist(prev);
  return true;
}
export function redoEdit() {
  const cur = useProject.getState().ir;
  const next = useEditJob.getState().popRedo(cur);
  if (!next) return false;
  useProject.getState().loadIR(next); persist(next);
  return true;
}
