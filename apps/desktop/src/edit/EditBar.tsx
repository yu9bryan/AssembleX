import { useEffect, useMemo } from "react";
import { useProject } from "../stores/projectStore";
import { useEditJob } from "../stores/editJob";
import { movePart, rotatePart, moveWireEnd, deleteWire, rewire, checkEdit, isMovable } from "./editOps";
import { applyEdit, undoEdit, redoEdit } from "./apply";

/**
 * 手動調整零件與走線的工具列（浮在 3D 左下）：
 *  - 點零件選取 → 方向鍵／按鈕平移一孔、R 旋轉 180°、「移到…」再點一個孔
 *  - 點導線選取 → 「移動起點／終點」再點一個孔、Delete 刪掉這條線
 *  - 「重新自動接線」依目前擺放重接；每一步都即時做擺放與電氣檢查
 *  - ⌘Z／⇧⌘Z 復原／重做；Esc 取消選取，再按一次結束調整
 */
/** 結束調整時還有問題：工作台顯示一次提醒（EditBar 卸載後由 Workspace 讀取） */
export let setFinishWarn: (n: number) => void = () => {};
export function bindFinishWarn(fn: (n: number) => void) { setFinishWarn = fn; }

export function EditBar() {
  const { ir, profiles, holes } = useProject();
  const job = useEditJob();
  const check = useMemo(() => checkEdit(ir, profiles, holes), [ir, profiles, holes]);
  const sel = job.sel;
  const partName = (id: string) => {
    const c = ir.logical.components.find((x) => x.id === id) ?? (ir.logical.board.instance_id === id ? { profile_id: ir.logical.board.profile_id } : null);
    return `${id.toUpperCase()} ${c ? profiles.get(c.profile_id)?.display_name ?? "" : ""}`.trim();
  };
  const wire = sel?.kind === "wire" ? ir.physical.wires.find((w) => w.id === sel.id) : null;
  const endText = (e: { kind: string; hole?: string; pin?: string }) => e.kind === "hole" ? e.hole : `${e.pin}`;

  const run = (fn: () => { ir: typeof ir } | { error: string }) => {
    const r = fn();
    if ("error" in r) job.setMsg(r.error); else { job.setMsg(null); applyEdit(r.ir); }
  };
  const nudge = (dc: number, dr: number) => { if (sel?.kind === "part") run(() => movePart(useProject.getState().ir, holes, sel.id, dc, dr)); };
  const rotate = () => { if (sel?.kind === "part") run(() => rotatePart(useProject.getState().ir, holes, sel.id)); };
  const del = () => { if (sel?.kind === "wire") { run(() => deleteWire(useProject.getState().ir, sel.id)); job.select(null); } };
  const autoRewire = () => {
    job.setPick(false);
    const cur = useProject.getState().ir;
    const r = rewire(cur, profiles, holes);
    if ("error" in r) { job.setMsg(r.error); return; }
    // 結果和現在一樣：不記一筆復原
    if (JSON.stringify(r.ir.physical.wires) === JSON.stringify(cur.physical.wires)) { job.setMsg("接線已經是最新的，沒有變更"); return; }
    applyEdit(r.ir); job.setMsg(r.problems?.length ? `重新接線完成，但有 ${r.problems.length} 處接不到：${human(r.problems[0])}` : "已依目前擺放重新接線");
  };
  // 檢查訊息裡的內部代號換成看得懂的名稱：dht1.VCC → DHT22 的 VCC、net_gnd → 「gnd」這條線路
  const human = (t: string) => t
    .replace(/\b([a-z]+\d+)\.([A-Za-z0-9+\-_]+)/g, (m, id: string, pin: string) => {
      const name = partShort(id); return name ? `${name} 的 ${pin}` : m; })
    .replace(/\bnet_([a-z0-9_]+)/gi, (_m, n: string) => `「${n.toUpperCase()}」線路`);
  const partShort = (id: string) => {
    const c = ir.logical.components.find((x) => x.id === id) ?? (ir.logical.board.instance_id === id ? { profile_id: ir.logical.board.profile_id } : null);
    const p = c ? profiles.get(c.profile_id) : null;
    return p ? `${p.display_name.split(/\s/)[0]}（${id.toUpperCase()}）` : null;
  };

  // 點到孔：依目前要做的事移動元件或導線端點
  const hovered = useProject((s) => s.hoveredHole);
  useEffect(() => {
    if (!job.pickHole) return;
    // 拖動鏡頭結束在孔上不算點擊：按下和放開的位置差太多就忽略
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onClick = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
      if ((e.target as HTMLElement)?.closest?.(".edit-bar")) return;
      const h = useProject.getState().hoveredHole;
      if (!h) return;
      const cur = useProject.getState().ir;
      if (sel?.kind === "part") {
        const pl = cur.physical.placements.find((p) => p.instance_id === sel.id);
        const first = pl && Object.values(pl.pin_to_hole)[0];
        const a = first ? holes.find((x) => x.id === first) : null, b = holes.find((x) => x.id === h);
        if (!a || !b || a.kind !== "main" || b.kind !== "main") { job.setMsg("請點麵包板主區（A–J 排）的孔"); return; }
        const rows = "ABCDEFGHIJ";
        run(() => movePart(cur, holes, sel.id, (b.column ?? 0) - (a.column ?? 0), rows.indexOf(b.row ?? "") - rows.indexOf(a.row ?? "")));
      } else if (sel?.kind === "wire" && sel.end) {
        run(() => moveWireEnd(cur, holes, sel.id, sel.end!, h));
      }
      job.setPick(false);
    };
    // 用 pointerup：3D 的點擊事件會被 OrbitControls 吃掉一部分
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onClick);
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("pointerup", onClick); };
  }, [job.pickHole, sel, holes]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); job.setPick(false); if (e.shiftKey ? !redoEdit() : !undoEdit()) job.setMsg(e.shiftKey ? "沒有可以重做的" : "沒有可以復原的"); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (job.pickHole) job.setPick(false); else if (sel) job.select(null); else job.stop(); return; }
      if (sel?.kind === "part") {
        const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (d[e.key]) { e.preventDefault(); e.stopPropagation(); nudge(...d[e.key]); }
        if (e.key.toLowerCase() === "r" && !mod) { e.preventDefault(); rotate(); }
      }
      if (sel?.kind === "wire" && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); del(); }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });

  useEffect(() => {
    useProject.setState({ hoveredPart: sel?.kind === "part" ? sel.id : null });
    return () => { useProject.setState({ hoveredPart: null }); };
  }, [sel]);
  const movable = sel?.kind === "part" && isMovable(ir, sel.id, holes);
  return (
    <div className="edit-bar" role="toolbar" aria-label="手動調整">
      <div className="eb-head">
        <b>手動調整</b>
        <span className="label">{job.pickHole ? (sel?.kind === "part" ? "點一個孔：元件的第一隻腳會移到那裡" : "點一個孔：這一端會移到那裡")
          : sel?.kind === "part" ? `已選 ${partName(sel.id)}`
          : wire ? `已選導線：${endText(wire.from)} → ${endText(wire.to)}`
          : "點一下零件或導線來選取"}{job.pickHole && hovered ? ` · ${hovered}` : ""}</span>
        <button className="gbtn primary" onClick={() => { if (check.errors.length) setFinishWarn(check.errors.length); job.stop(); }}>完成</button>
      </div>
      {sel?.kind === "part" && (
        <div className="eb-row">
          {movable ? <>
            <button className="gbtn" title="左移一欄（←）" onClick={() => nudge(-1, 0)}>←</button>
            <button className="gbtn" title="右移一欄（→）" onClick={() => nudge(1, 0)}>→</button>
            <button className="gbtn" title="上移一排（↑）" onClick={() => nudge(0, -1)}>↑</button>
            <button className="gbtn" title="下移一排（↓）" onClick={() => nudge(0, 1)}>↓</button>
            <button className="gbtn" title="轉 180°（R）" onClick={rotate}>旋轉</button>
            <button className={`gbtn ${job.pickHole ? "is-on" : ""}`} onClick={() => job.setPick(!job.pickHole)}>移到…</button>
          </> : <span className="label">開發板與插在電源軌上的元件不能移動</span>}
        </div>
      )}
      {wire && (
        <div className="eb-row">
          {wire.from.kind === "hole" && <button className={`gbtn ${job.pickHole && sel?.kind === "wire" && sel.end === "from" ? "is-on" : ""}`} onClick={() => { job.select({ kind: "wire", id: wire.id, end: "from" }); job.setPick(true); }}>移動起點（{endText(wire.from)}）</button>}
          {wire.to.kind === "hole" && <button className={`gbtn ${job.pickHole && sel?.kind === "wire" && sel.end === "to" ? "is-on" : ""}`} onClick={() => { job.select({ kind: "wire", id: wire.id, end: "to" }); job.setPick(true); }}>移動終點（{endText(wire.to)}）</button>}
          <button className="gbtn" title="Delete" onClick={del}>刪除這條線</button>
        </div>
      )}
      <div className="eb-row">
        <button className="gbtn" onClick={autoRewire} title="依目前的元件擺放，重新自動產生全部導線">重新自動接線</button>
        <button className="gbtn" disabled={!job.undo.length} onClick={() => { job.setPick(false); undoEdit(); }} title="⌘Z">復原</button>
        <button className="gbtn" disabled={!job.redo.length} onClick={() => { job.setPick(false); redoEdit(); }} title="⇧⌘Z">重做</button>
      </div>
      {job.msg && <div className="label" style={{ color: "var(--warn)" }}>{job.msg}</div>}
      <div className="eb-check" role="status">
        {check.errors.length === 0
          ? <span style={{ color: "var(--ok)" }}>✓ 擺放與接線都通過檢查{check.warnings.length ? ` · ${check.warnings.length} 項提醒` : ""}</span>
          : <>
              <span style={{ color: "var(--warn)" }}>! {check.errors.length} 個問題（移動元件後通常要按「重新自動接線」）</span>
              {check.errors.slice(0, 3).map((e, i) => <span key={i} className="label">· {human(e)}</span>)}
            </>}
      </div>
      <div className="label">方向鍵移動 · R 旋轉 · Delete 刪線 · ⌘Z 復原 · Esc 取消選取</div>
    </div>
  );
}
