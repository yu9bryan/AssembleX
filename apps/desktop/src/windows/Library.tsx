import { useEffect, useMemo, useState } from "react";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { useProject } from "../stores/projectStore";
import { useDsJob, usePartTrash, loadPartFiles, openFile } from "../stores/dsJob";
import { loadSources } from "../ai/datasheet";
import { Thumb } from "../ui/Thumb";
import { thumbProfile } from "../engine3d/datasheetShape";
import { DatasheetImport, fmtSupply, fmtSize, unitOf } from "./DatasheetImport";

const PIN_TYPE: Record<string, string> = {
  digital_io: "數位", analog_in: "類比輸入", analog_out: "類比輸出", power_in: "電源",
  power_out: "電源輸出", ground: "接地", passive: "被動", nc: "未接",
};

/** 存檔的專案裡有哪些用到這個元件（刪掉後那些專案會出現未知元件） */
function projectsUsing(id: string) {
  return useProject.getState().projects.filter((pr) => {
    const comps = (pr.ir as { logical?: { components?: { profile_id?: string }[] } } | null)?.logical?.components;
    return Array.isArray(comps) && comps.some((c) => c?.profile_id === id);
  });
}

/**
 * 元件庫：每個元件都有 CAD 預覽（離屏渲染的模型縮圖）。
 * 分成「此專案使用」與「其他」—— 用選取樣式表示「使用中」會被誤讀成「被選取」。
 * 「待查證」：電氣規格還沒對照 datasheet，誠實標示。
 */
export function Library() {
  const { profiles, ir } = useProject();
  const dsBusy = useDsJob((s) => !!s.stage || (!!s.result && !s.editingId));
  const editingId = useDsJob((s) => s.editingId);
  // 和底部「元件庫」卡同一個口徑：開發板＋元件（麵包板不算零件）
  const used = new Set([ir.logical.board.profile_id, ...ir.logical.components.map((c) => c.profile_id)]);
  const all = [...profiles.values()];
  const mine = all.filter((p) => p.component_id.startsWith("user_"));
  const builtIn = all.filter((p) => !p.component_id.startsWith("user_"));
  const groups: [string, typeof all][] = [
    ...(mine.length ? [["從規格書新增", mine] as [string, typeof all]] : []),
    ["此專案使用", builtIn.filter((p) => used.has(p.component_id))],
    ["其他", builtIn.filter((p) => !used.has(p.component_id))],
  ];
  const { verifyCustomProfile, unverifyCustomProfile } = useProject.getState();
  // 展開中的面板：查證確認、或刪除確認（有專案用到時）
  const [panel, setPanel] = useState<{ id: string; kind: "verify" | "delete" } | null>(null);
  // 刪除後可以復原（狀態在全域：關掉卡片再打開還在；最近刪除保留 7 天）
  const { trash, last: undo, remove: trashPart, restore: restorePart, dismiss } = usePartTrash();
  const [showTrash, setShowTrash] = useState(false);
  // 出處（檔名、加入日期）：元件列表上小字顯示；profiles 變了（加入、刪除、救回）就重讀
  const sources = useMemo(() => loadSources(), [profiles]);
  function remove(p: ComponentProfile) { setPanel(null); trashPart(p); }
  // 救回時元件庫已有同 id／同型號：問要取代還是兩個都留
  const [restoreAsk, setRestoreAsk] = useState<{ id: string; twin: string } | null>(null);
  function restore(id = undo?.profile.component_id, mode?: "replace" | "copy") {
    if (!id) return;
    // 「已取代 · 復原」：直接換回舊的（新的移到最近刪除），不用再問
    const isUndoReplace = !mode && !!undo?.replaced && undo.profile.component_id === id;
    if (isUndoReplace) mode = "replace";
    const twin = restorePart(id, mode, isUndoReplace ? { undo: true } : undefined);
    if (twin) { setShowTrash(true); setRestoreAsk({ id, twin }); return; }
    setRestoreAsk(null);
    setTimeout(() => {
      const el = document.getElementById(`lib-${id}`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" }); el?.classList.add("is-new");
      setTimeout(() => el?.classList.remove("is-new"), 1600);
    }, 60);
  }
  // 提示 20 秒（和專案刪除一樣）；期間 ⌘Z／Ctrl+Z 復原（攔在最前面，不讓它變成復原電路）
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(dismiss, Math.max(0, 20000 - (Date.now() - undo.deletedAt)));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault(); e.stopImmediatePropagation(); restore();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey, true); };
  });  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack" style={{ gap: 14 }}>
      <DatasheetImport />
      {groups.map(([title, list]) => (
        <div key={title} className="stack" style={{ gap: 8 }}>
          <div className="label lib-section">{title}（{list.length}）</div>
          <div className="lib-grid">
            {list.map((p) => {
              // 「待查證」只標從規格書推定的元件；內建元件只是沒附出處，用灰色小字說明，不和推定混在一起
              const mineP = p.component_id.startsWith("user_");
              const unverified = mineP && p.evidence.some((e) => e.verification_status === "unverified");
              const noSource = !mineP && p.evidence.some((e) => e.verification_status === "unverified");
              const open = panel?.id === p.component_id ? panel.kind : null;
              const supply = fmtSupply(p.electrical);
              return (
                <div key={p.component_id} id={`lib-${p.component_id}`} className={`lib-item ${mineP ? "custom" : ""} ${open ? "has-panel" : ""}`} title={noSource ? `${p.display_name} · 內建元件，部分規格未附規格書出處` : p.display_name}>
                  <Thumb profile={thumbProfile(p)} size={76} />
                  {mineP ? (
                    <span className="lib-meta">
                      <span className="lib-name">{p.display_name}</span>
                      <span className="label">{p.pins.length} 腳{supply ? <> · <span className="nw">供電 {supply}</span></> : ""}</span>
                      {unverified ? <span className="lib-flag">規格書推定 · 待查證</span> : <span className="label" style={{ color: "var(--ok)" }}>已查證</span>}
                      {(() => { const src = sources[p.component_id]; if (!src?.fileName) return null; const d = src.addedAt ? new Date(src.addedAt) : null;
                        return <span className="label lib-src" title={src.sha256 ? `SHA-256 ${src.sha256}` : undefined}>{src.fileName}{d ? ` · ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 加入` : ""}</span>; })()}
                    </span>
                  ) : <span className="lib-name">{p.display_name}</span>}
                  {mineP && (
                    <span className="lib-actions">
                      <button className="lib-act" disabled={dsBusy} title={dsBusy ? "上方正在讀取或有尚未加入的預覽，先處理完再修改" : "查看腳位、名稱並修改"}
                              onClick={() => { setPanel(null); useDsJob.getState().openEdit(p); }}>查看／修改</button>
                      {unverified
                        ? <button className="lib-act" aria-expanded={open === "verify"} title="對照規格書原文確認腳位與數值"
                                  onClick={() => setPanel(open === "verify" ? null : { id: p.component_id, kind: "verify" })}>標為已查證</button>
                        : <button className="lib-act" title="改回待查證（AI 設計會優先用內建元件）" onClick={() => unverifyCustomProfile(p.component_id)}>改回待查證</button>}
                      <button className="lib-act" disabled={used.has(p.component_id)} title={used.has(p.component_id) ? "這個專案正在使用，不能刪除" : "從元件庫移除（可復原）"}
                              onClick={() => projectsUsing(p.component_id).length ? setPanel({ id: p.component_id, kind: "delete" }) : remove(p)}>刪除</button>
                    </span>
                  )}
                  {open === "verify" && <VerifyPanel p={p} onCancel={() => setPanel(null)}
                                                     onConfirm={() => { verifyCustomProfile(p.component_id); setPanel(null); }} />}
                  {open === "delete" && (() => {
                    const users = projectsUsing(p.component_id);
                    return (
                      <div className="lib-panel warn">
                        <span>有 {users.length} 個專案用到它（{users.slice(0, 3).map((u) => `「${u.title}」`).join("、")}{users.length > 3 ? " 等" : ""}），刪除後那些專案會顯示未知元件。</span>
                        <span className="lib-panel-acts">
                          <button className="gbtn danger" onClick={() => remove(p)}>仍要刪除</button>
                          <button className="gbtn" onClick={() => setPanel(null)}>取消</button>
                        </span>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {trash.length > 0 && (
        <div className="stack lib-trash" style={{ gap: 6 }}>
          <button className="link-btn" style={{ alignSelf: "flex-start" }} aria-expanded={showTrash} onClick={() => setShowTrash((v) => !v)}>
            已刪除 {trash.length} 個元件 · 救回 {showTrash ? "▴" : "▾"}</button>
          {showTrash && trash.map((t) => (
            <div key={t.profile.component_id} className="lib-trash-row">
              <span>{t.profile.display_name}</span>
              <span className="label">{Math.max(1, Math.ceil((t.deletedAt + 7 * 864e5 - Date.now()) / 864e5))} 天後永久刪除</span>
              <button className="link-btn" onClick={() => restore(t.profile.component_id)}>救回</button>
              {restoreAsk?.id === t.profile.component_id && (
                <div className="lib-panel warn lib-restore-ask">
                  <span>元件庫已有同型號的「{profiles.get(restoreAsk.twin)?.display_name ?? restoreAsk.twin}」{restoreAsk.twin === restoreAsk.id ? "（之後又加入的較新版本）" : ""}。</span>
                  <span className="lib-panel-acts">
                    <button className="gbtn" onClick={() => restore(t.profile.component_id, "replace")}>取代它（它會移到最近刪除）</button>
                    <button className="gbtn" onClick={() => restore(t.profile.component_id, "copy")}>兩個都留</button>
                    <button className="link-btn" onClick={() => setRestoreAsk(null)}>取消</button>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {undo && (
        <div className="lib-toast" role="status">
          <span>{undo.replaced ? "已取代" : "已刪除"} {undo.profile.display_name}</span>
          <button className="link-btn" onClick={() => restore()}>復原（⌘Z）</button>
        </div>
      )}
    </div>
  );
}

/** 標為已查證前：把要對照的東西列出來（腳位＋頁碼、供電、衝突時選的值），看過才確認 */
function VerifyPanel({ p, onConfirm, onCancel }: { p: ComponentProfile; onConfirm: () => void; onCancel: () => void }) {
  const src = loadSources()[p.component_id];
  // 原檔在這台電腦（IndexedDB）就能直接打開對照
  const [files, setFiles] = useState<File[] | undefined>(undefined);
  useEffect(() => { let on = true; loadPartFiles(p.component_id, src?.fileName).then((f) => on && setFiles(f)); return () => { on = false; }; }, [p.component_id, src?.fileName]);
  const pageOf = (id: string) => src?.pinPages?.[id] ?? p.evidence.find((e) => e.field === `pins.${id}`)?.page ?? null;
  // 多檔：頁碼前加「檔2」
  const multi = (src?.files?.length ?? 0) > 1;
  const pageLabel = (id: string) => { const pg = pageOf(id); if (pg == null) return "—"; const k = src?.pinFiles?.[id]; return multi && k ? `檔${k} p.${pg}` : `p.${pg}`; };
  const nameOf = (f: File, i: number) => src?.files?.[i]?.fileName ?? (i === 0 && !multi ? src?.fileName : undefined) ?? f.name;
  const supply = fmtSupply(p.electrical);
  const chosen = (src?.conflicts ?? []).filter((c) => src?.chosen?.[c.field] != null).map((c) => {
    const v = src!.chosen![c.field];
    const pg = c.options.find((o) => o.value === v)?.page;
    return `${c.label} ${v} ${unitOf(c.field)}${pg != null ? `（第 ${pg} 頁）` : ""}`;
  });
  return (
    <div className="lib-panel">
      <span className="lib-panel-src">
        <span className="label">請打開{src?.fileName ? `「${src.fileName}」` : "規格書原文"}逐項對照：</span>
        {files?.map((f, i) => <button key={i} className="link-btn" onClick={() => openFile(f, nameOf(f, i))}>下載原檔（{nameOf(f, i)}）</button>)}
      </span>
      {files && files.length === 0 && <span className="label">這台電腦沒有留原檔（加入時沒有存到，或在別台電腦加入）：請從你下載規格書的位置打開{src?.sha256 ? `，可用 SHA-256 ${src.sha256.slice(0, 12)}… 確認是同一份` : ""}。</span>}
      <table className="ds-pins">
        <thead><tr><th>腳</th><th>類型</th><th>頁</th></tr></thead>
        <tbody>{p.pins.map((q) => { return (
          <tr key={q.id}><td className="mono">{q.id}</td><td>{PIN_TYPE[q.type] ?? q.type}</td><td className="num">{pageLabel(q.id)}</td></tr>); })}</tbody>
      </table>
      <span className="label num">供電 {supply ?? "規格書沒讀到"}{p.electrical.quiescent_current_ma != null ? ` · 靜態 ${p.electrical.quiescent_current_ma} mA` : ""}</span>
      <span className="label num">外形 {fmtSize(p.geometry.bbox_mm)}</span>
      {chosen.length > 0 && <span className="label num">規格不一致時選的值：{chosen.join("、")}</span>}
      <span className="lib-panel-acts">
        <button className="gbtn primary" onClick={onConfirm}>我已對照原文，確認</button>
        <button className="gbtn" onClick={onCancel}>取消</button>
      </span>
    </div>
  );
}
