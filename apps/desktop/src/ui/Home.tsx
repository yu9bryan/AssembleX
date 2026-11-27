import { Fragment, useMemo, useRef, useState, useEffect } from "react";
import { useProject, unverifiedParts, relTime, type ProjectMeta } from "../stores/projectStore";
import { useAiJob, useAiSeconds } from "../stores/aiJob";
import { useDsJob } from "../stores/dsJob";
import { CircuitIR, buildBreadboard, BREADBOARDS, runElectricalChecks, routeWires, countPlanCrossings, findWireCollisions } from "@assemblex/circuit-schema";

/**
 * 主畫面：專案列表。
 * 滑過某個專案，後面的 3D 就換成那個電路（緩慢自轉）；點下去進入工作台。
 */
const holesBy = new Map<string, ReturnType<typeof buildBreadboard>>();
const holesFor = (id = "breadboard_830") => { let h = holesBy.get(id); if (!h) { h = buildBreadboard(BREADBOARDS[id] ?? BREADBOARDS.breadboard_830); holesBy.set(id, h); } return h; };
const PROFILES_MAP = useProject.getState().profiles;
// 只依 id 去重：自己的專案同名同需求也是兩個不同的專案，不能藏掉其中一個
const summarize = (list: ProjectMeta[]) => list.filter((p, i) => list.findIndex((q) => q.id === p.id) === i).map((p) => {
  const ir = CircuitIR.parse(p.ir);
  const holes = holesFor(ir.physical.breadboard?.profile_id);
  const errors = runElectricalChecks(ir, holes).filter((i) => i.severity === "error").length;
  return { ...p, parts: ir.logical.components.length + 1, wires: ir.physical.wires.length,
           nets: ir.logical.nets.length, errors, unverified: unverifiedParts(ir, PROFILES_MAP).length,
           crossings: 0 };
});

/** 首頁的搜尋／篩選／捲動位置：進專案再回來要接得上（Home 會被卸載，所以放在模組層） */
const homeUi = (() => {
  // 搜尋與篩選也存在 sessionStorage：重新整理後接得上
  try { const v = JSON.parse(sessionStorage.getItem("assemblex.homeUi") ?? "null"); if (v) return { q: String(v.q ?? ""), filter: (v.filter === "trash" ? "all" : v.filter ?? "all") as "all" | "mine" | "examples" | "trash", scroll: Number(v.scroll) || 0, seen: false, pick: (v.pick as string | null) ?? null }; } catch { /* */ }
  return { q: "", filter: "all" as "all" | "mine" | "examples" | "trash", scroll: 0, seen: false, pick: null as string | null };
})();
const saveHomeUi = () => { try { sessionStorage.setItem("assemblex.homeUi", JSON.stringify({ q: homeUi.q, filter: homeUi.filter, scroll: homeUi.scroll, pick: useProject.getState().previewId })); } catch { /* */ } };
/** 刪除提示：已關掉的就不再出現 */
let toastDismissedAt = 0;

export function Home() {
  const { openProject, previewProject, ir, projects } = useProject();
  const SUMMARY = useMemo(() => summarize(projects), [projects]);
  // 訂閱式讀取（不是 getState 快照），數字才會跟著元件庫載入完成更新
  const profiles = useProject((s) => s.profiles);

  const previewId = useProject((s) => s.previewId);
  const aiJob = useAiJob(), aiSec = useAiSeconds();
  const ds = useDsJob();
  // 回到某個專案並打開指定卡片（設計失敗、規格書待確認時用）
  const backTo = (card: "ai" | "lib", projectId: string | null) => {
    const st = useProject.getState();
    if (projectId && projectId !== "new_project" && st.projects.some((p) => p.id === projectId)) st.openProject(projectId);
    else if (card === "ai") st.newProject(undefined, { keepJob: true });
    else if (st.projects[0]) st.openProject(st.projects[0].id);
    useProject.setState({ openCard: card });
  };
  // 專案管理：搜尋、篩選、排序、重新命名、複製、刪除（可復原）
  const [q, setQ0] = useState(homeUi.q);
  const [filter, setFilter0] = useState(homeUi.filter);
  const setQ = (v: string) => { homeUi.q = v; saveHomeUi(); setQ0(v); };
  const setFilter = (v: typeof filter | ((f: typeof filter) => typeof filter)) =>
    setFilter0((f) => { const n = typeof v === "function" ? v(f) : v; homeUi.filter = n; saveHomeUi(); return n; });
  const [sort, setSort] = useState<"opened" | "updated" | "name">(() => {
    try { return (localStorage.getItem("assemblex.homeSort") as "opened" | "updated" | "name") || "opened"; } catch { return "opened"; }
  });
  useEffect(() => { try { localStorage.setItem("assemblex.homeSort", sort); } catch { /* */ } }, [sort]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const hoverLock = useRef(0);
  useEffect(() => { if (previewId) saveHomeUi(); }, [previewId]);
  const storageError = useProject((x) => x.storageError);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  // 可以連續刪好幾個：復原一次全部救回；滑鼠停在提示上時不倒數
  // 刪除可復原：資料在 store 的「最近刪除」（7 天），離開首頁、重新整理都救得回來；提示只顯示 20 秒內刪的
  const trash = useProject((x) => x.trash);
  const [toastHold, setToastHold] = useState(false);
  const [tick, setTick] = useState(0);
  const undo = trash.filter((x) => x.deletedAt > toastDismissedAt && (toastHold || Date.now() - x.deletedAt < 20000));
  useEffect(() => { if (!undo.length) return; const t = setTimeout(() => setTick((n) => n + 1), 1000); return () => clearTimeout(t); }, [undo.length, tick]);
  const setUndo = (_: unknown) => { void _; };
  const doUndo = () => {
    const back = [...undo].sort((a, b) => b.deletedAt - a.deletedAt);
    back.forEach((p) => st().restoreProject(p));
    if (back.length) { previewProject(back[back.length - 1].id); focusCard(back[back.length - 1].id); }
  };
  const [hint, setHint] = useState<string | null>(null);
  // 離開「已刪除」分頁：3D 換回目前選取的專案（滑過已刪除的卡片時預覽過它們）
  useEffect(() => {
    if (filter === "trash") return;
    const st0 = useProject.getState();
    const want = st0.previewId;
    if (want && st0.ir.project_id !== want) { const p = st0.projects.find((x) => x.id === want); if (p) st0.loadIR(p.ir); }
  }, [filter]);
  // 救回最後一筆後「已刪除」分頁會消失：自動回到全部，不要停在空白的刪除清單
  useEffect(() => { if (filter === "trash" && trash.length === 0) setFilter("all"); }, [trash.length, filter]);
  const hintAt = useRef(0);
  useEffect(() => { if (!hint) return; hintAt.current = Date.now(); const t = setTimeout(() => setHint(null), 3500); return () => clearTimeout(t); }, [hint]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && undo.length && !/^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName)) { e.preventDefault(); doUndo(); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });
  useEffect(() => {
    if (!menuId) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".pc-menu, .pc-more")) setMenuId(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuId(null); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [menuId]);
  // 名稱排序：英數開頭的排前面，中文照注音（筆畫序看起來像沒排）
  const byName = (a: { title: string }, b: { title: string }) =>
    (Number(!/^[A-Za-z0-9]/.test(a.title)) - Number(!/^[A-Za-z0-9]/.test(b.title))) || a.title.localeCompare(b.title, "zh-Hant-u-co-zhuyin", { numeric: true });
  const VIEW = useMemo(() => {
    const k = q.trim().toLowerCase();
    const hit = (p: (typeof SUMMARY)[number]) => !k || `${p.title} ${p.brief}`.toLowerCase().includes(k);
    const mine = SUMMARY.filter((p) => p.source === "claude" && hit(p)).sort((a, b) =>
      sort === "name" ? byName(a, b)
      : sort === "opened" ? (Math.max(b.openedAt ?? 0, b.designedAt ?? 0, b.createdAt ?? 0) - Math.max(a.openedAt ?? 0, a.designedAt ?? 0, a.createdAt ?? 0)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      : (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const ex = SUMMARY.filter((p) => p.source !== "claude" && hit(p));
    if (sort === "name") ex.sort(byName);
    return filter === "mine" ? mine : filter === "examples" ? ex : filter === "trash" ? [] : [...mine, ...ex];
  }, [SUMMARY, q, filter, sort]);
  useEffect(() => {
    if (filter === "trash") return;
    if (!VIEW.length) {
      // 沒有符合的專案：右邊不要留著不相干的電路，換成只有開發板的空麵包板
      const cur = useProject.getState().ir;
      useProject.setState({ previewId: null });
      useProject.getState().loadIR({ ...cur, logical: { ...cur.logical, components: [], nets: [] },
        physical: { ...cur.physical, placements: cur.physical.placements.filter((x) => x.instance_id === cur.logical.board.instance_id), wires: [] } });
      return;
    }
    if (previewId && !VIEW.some((x) => x.id === previewId)) previewProject(VIEW[0].id);
  }, [VIEW]);   // eslint-disable-line react-hooks/exhaustive-deps
  // AI 剛設計完：停在「範例」或搜尋擋住它的話，切回全部、清掉搜尋，把新專案選起來
  const finishedSeen = useRef<string | null>(aiJob.finishedId);   // 進首頁前就完成的不算（不要蓋掉使用者留著的篩選）
  useEffect(() => {
    const id = aiJob.finishedId;
    if (!id || aiJob.running || finishedSeen.current === id || !SUMMARY.some((p) => p.id === id)) return;
    finishedSeen.current = id;
    if (!VIEW.some((p) => p.id === id)) { setFilter("all"); setQ(""); }
    setTimeout(() => { previewProject(id); document.querySelector(`[data-pid="${id}"]`)?.scrollIntoView({ block: "center" }); }, 60);
  }, [aiJob.finishedId, aiJob.running, SUMMARY]);   // eslint-disable-line react-hooks/exhaustive-deps
  const st = useProject.getState;
  // 搜尋命中的字標出來：看得出為什麼符合（例如是需求裡寫了 LED）
  const mark = (t: string) => {
    const k = q.trim(); if (!k) return t;
    const i = t.toLowerCase().indexOf(k.toLowerCase()); if (i < 0) return t;
    return <>{t.slice(0, i)}<mark className="hit">{t.slice(i, i + k.length)}</mark>{t.slice(i + k.length)}</>;
  };
  const [renameErr, setRenameErr] = useState(false);
  const focusCard = (id: string) => setTimeout(() => (document.querySelector(`[data-pid="${id}"]`) as HTMLElement | null)?.focus(), 30);
  const renameEndAt = useRef(0);
  const commitRename = () => {
    if (!renaming) return;
    renameEndAt.current = Date.now();
    if (!renaming.text.trim()) { setRenameErr(true); return; }   // 空白名稱：不默默還原，留在輸入框並提示
    const dupName = projects.some((x) => x.id !== renaming.id && x.title === renaming.text.trim());
    st().renameProject(renaming.id, renaming.text); const id = renaming.id; setRenaming(null); setRenameErr(false); focusCard(id);
    if (dupName) setHint(`已有同名的專案「${renaming.text.trim()}」，可以再改一個名字分辨`);
  };
  const doDelete = (p: ProjectMeta) => {
    const i = VIEW.findIndex((x) => x.id === p.id);
    st().deleteProject(p.id); setMenuId(null); setUndo(null);
    hoverLock.current = Date.now() + 600;   // 清單往上縮時滑鼠底下換了一張：不要讓它搶走選取（亮的卡和鍵盤焦點要是同一張）
    const next = VIEW[i + 1] ?? VIEW[i - 1];
    if (next && next.id !== p.id) { previewProject(next.id); focusCard(next.id); setTimeout(() => document.querySelector(`[data-pid="${next.id}"]`)?.scrollIntoView({ block: "center" }), 60); }
    else setTimeout(() => (document.querySelector(".home-cta") as HTMLElement | null)?.focus(), 30);
  };
  const doDuplicate = (p: ProjectMeta) => { const id = st().duplicateProject(p.id); setMenuId(null); hoverLock.current = Date.now() + 600;
    if (!id) { setHint("儲存空間滿了，沒有建立副本"); return; }
    if (id) { setFilter((f) => (f === "examples" ? "all" : f)); previewProject(id);
      const t = st().projects.find((x) => x.id === id)?.title ?? ""; setRenaming({ id, text: t }); } };
  // 首頁打開時，右邊 3D 預覽清單第一張（標成選中的那張），不要沿用上一次載入的電路
  useEffect(() => {
    // 重新整理後也接回上次選的那張（sessionStorage）
    const pick = previewId ?? homeUi.pick;
    const keep = pick != null && SUMMARY.some((x) => x.id === pick) ? pick : null;
    // 選取的專案被目前的篩選藏起來（例如在工作台從範例複製了一份）：切回「全部」讓它看得到
    if (keep && !VIEW.some((x) => x.id === keep)) {
      if (homeUi.q) setHint(`「${SUMMARY.find((x) => x.id === keep)?.title ?? ""}」不符合搜尋「${homeUi.q}」，已清除搜尋`);
      setFilter("all"); setQ("");
    }
    const target = keep ?? VIEW[0]?.id;
    if (target && ir.project_id !== target) { useProject.setState({ previewId: null }); previewProject(target); }
    else if (target && previewId !== target) useProject.setState({ previewId: target });
    // 回到首頁：捲回上次位置，並把選取的那張捲進畫面；從專案回來時鍵盤焦點也放回那張卡
    const back = homeUi.seen; homeUi.seen = true;
    requestAnimationFrame(() => {
      const l = listRef.current; if (l) l.scrollTop = homeUi.scroll;
      const el = target ? document.querySelector(`[data-pid="${target}"]`) as HTMLElement | null : null;
      el?.scrollIntoView({ block: "nearest" });
      if (back) el?.focus({ preventScroll: true });
    });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const listRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [above, setAbove] = useState(false);
  const checkMore = () => { const l = listRef.current; if (l) { setMore(l.scrollTop + l.clientHeight < l.scrollHeight - 1); setAbove(l.scrollTop > 1); } };
  useEffect(() => {
    checkMore();
    const l = listRef.current; if (!l) return;
    const ro = new ResizeObserver(checkMore); ro.observe(l); if (l.firstElementChild) ro.observe(l.firstElementChild);
    return () => ro.disconnect();
  }, [projects.length]);
  return (
    <div className="overlay">
      <section className="home-list">
        {/* 標誌：麵包板上兩排孔＋一條跳線 */}
        <div className="brand"><div className="logo" aria-hidden>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#e2c939" strokeWidth="1.8" strokeLinecap="round">
            {[6, 10, 14, 18].map((x) => <circle key={x} cx={x} cy="8" r="0.9" fill="#e2c939" stroke="none" />)}
            {[6, 10, 14, 18].map((x) => <circle key={x} cx={x} cy="17" r="0.9" fill="#e2c939" stroke="none" />)}
            <path d="M6 8 V12.5 H18 V17" />
          </svg>
        </div>
          <span className="wordmark">AssembleX <span>Studio</span></span></div>
        {/* 還沒有自己的專案時，標題講「開始」而不是「我的專案」（不然下面寫「還沒有」會互相矛盾） */}
        <h1 className="display" style={{ margin: "28px 0 6px" }}>
          {projects.some((p) => p.source === "claude") ? "我的專案" : "開始一個專案"}</h1>
        <div className="home-sub" style={{ color: "var(--text-2)", marginBottom: 24, maxWidth: 440 }}>
          <span style={{ display: "block" }}>{(() => { const n = projects.filter((p) => p.source === "claude").length; return n ? `${n} 個自己的專案` : "還沒有自己的專案"; })()} · {projects.filter((p) => p.source !== "claude").length} 個範例</span>
          <span style={{ display: "block" }}>用一句話描述硬體，AssembleX 設計電路並帶你組裝</span>
        </div>

        {storageError && (
          <div className="home-job warn" role="alert">
            <span style={{ color: "var(--warn)" }}>!</span> 這台電腦的儲存空間滿了，最近的變更沒有存起來
            {trash.length > 0 && <button className="link-btn" onClick={() => { if (confirm(`永久刪除「最近刪除」裡的 ${trash.length} 個專案來騰出空間？`)) st().clearTrash(); }}>清空最近刪除 →</button>}
          </div>
        )}
        {/* AI 設計在背景跑：首頁也看得到，能回去；完成時給「打開」 */}
        {aiJob.running && (
          <div className="home-job" role="status">
            <span className="spin" /> AI 設計中 · {aiSec} 秒
            <button className="link-btn" onClick={() => {
              const b = aiJob.base; if (b) useProject.getState().loadIR(b);
              useProject.setState((s) => ({ screen: "project", openCard: "ai", view: "overview", viewNonce: s.viewNonce + 1 }));
            }}>回到設計 →</button>
          </div>
        )}
        {!aiJob.running && aiJob.finishedId && projects.some((p) => p.id === aiJob.finishedId) && (
          <div className="home-job done" role="status">
            <span style={{ color: "var(--ok)" }}>✓</span> 「{projects.find((p) => p.id === aiJob.finishedId)!.title}」設計完成，已存到我的專案
            <button className="link-btn" onClick={() => { const id = aiJob.finishedId!; aiJob.setFinishedId(null); openProject(id); useProject.setState({ openCard: "ai" }); }}>打開 →</button>
            <button className="link-btn" aria-label="關閉" style={{ marginLeft: 0 }} onClick={() => aiJob.setFinishedId(null)}>✕</button>
          </div>
        )}
        {!aiJob.running && aiJob.interrupted && (
          <div className="home-job warn" role="status">
            <span style={{ color: "var(--warn)" }}>!</span> 上次的設計被中斷{aiJob.interrupted.prompt ? `：「${aiJob.interrupted.prompt.slice(0, 30)}」` : ""}
            <button className="link-btn" onClick={() => {
              const it = aiJob.interrupted!; const st = useProject.getState();
              if (it.bbId) st.setBreadboard(it.bbId);
              st.newProject(it.boardId, { keepJob: true }); if (it.prompt) { aiJob.setDraft(it.prompt); aiJob.setPendingRun(true); }
            }}>重新設計 →</button>
            <button className="link-btn" aria-label="不用了" style={{ marginLeft: 0 }} onClick={aiJob.clearInterrupted}>✕</button>
          </div>
        )}
        {!aiJob.running && aiJob.error && aiJob.jobProjectId && (
          <div className="home-job warn" role="alert">
            <span style={{ color: "var(--warn)" }}>!</span> AI 設計沒有完成：{aiJob.error}
            <button className="link-btn" onClick={() => backTo("ai", aiJob.jobProjectId)}>回到設計 →</button>
          </div>
        )}
        {!ds.stage && !ds.result && ds.interrupted && (
          <div className="home-job warn" role="status">
            <span style={{ color: "var(--warn)" }}>!</span> 讀規格書「{ds.interrupted.fileName}」被中斷
            <button className="link-btn" onClick={() => { useDsJob.getState().resumeInterrupted(); backTo("lib", useProject.getState().ir.project_id); }}>重新讀取 →</button>
          </div>
        )}
        {(ds.stage || ds.result) && (
          <div className="home-job" role="status">
            {ds.stage ? <><span className="spin" /> 讀規格書「{ds.fileName}」中</> : <><span style={{ color: "var(--warn)" }}>●</span> 規格書「{ds.fileName}」讀完，等你確認後加入元件庫</>}
            <button className="link-btn" onClick={() => backTo("lib", useProject.getState().ir.project_id)}>打開 →</button>
          </div>
        )}
        {/* 主要動作放最上面、做成主按鈕 */}
        <button className="gbtn primary home-cta" onClick={() => useProject.getState().newProject()}>
          ＋ 新專案：用一句話描述你要的硬體</button>

        <div className="home-tools">
          <input className="home-search" type="search" placeholder="搜尋專案名稱或需求" value={q} aria-label="搜尋專案"
                 onChange={(e) => setQ(e.target.value)} />
          <div className="seg small" role="tablist" aria-label="篩選">
            {([["all", "全部"], ["mine", "我的"], ["examples", "範例"], ...(trash.length ? [["trash", `已刪除 ${trash.length}`] as const] : [])] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "is-on" : ""} onClick={() => setFilter(k)}>{l}</button>))}
          </div>
          <select className="home-sort" value={sort} aria-label="排序" onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="opened">最近開啟</option><option value="updated">最近修改</option><option value="name">名稱</option>
          </select>
        </div>
        {/* 只有專案清單這一區捲動：標題、新專案按鈕固定在上方 */}
        <div ref={listRef} className={`home-scroll scroll ${more ? "has-more" : ""} ${above ? "has-above" : ""}`} onScroll={() => { checkMore(); if (listRef.current) { homeUi.scroll = listRef.current.scrollTop; saveHomeUi(); } }}>
        <div className="stack" style={{ gap: 10 }}>
          {filter === "trash" && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="label home-section">最近刪除 · 保留 7 天</div>
              {trash.length === 0 && <div className="home-empty">沒有刪除的專案</div>}
              {trash.length > 0 && q.trim() && !trash.some((p) => `${p.title} ${p.brief}`.toLowerCase().includes(q.trim().toLowerCase())) && <div className="home-empty">最近刪除裡找不到「{q}」</div>}
              {[...trash].filter((p) => !q.trim() || `${p.title} ${p.brief}`.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.deletedAt - a.deletedAt).map((p) => (
                <div key={p.id} className="project-card card trash-card" tabIndex={0} aria-label={`${p.title}，${relTime(p.deletedAt)}刪除，按 Enter 救回`}
                     onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); (e.currentTarget.querySelector(".gbtn") as HTMLButtonElement | null)?.click(); } }}
                     onMouseEnter={() => { if (Date.now() > hoverLock.current) useProject.getState().loadIR(p.ir); }} onFocus={() => useProject.getState().loadIR(p.ir)}>
                  <div className="pc-top"><span className="pc-title">{p.title}</span>
                    <button className="gbtn" onClick={() => {
                      hoverLock.current = Date.now() + 600;   // 下一張滑到滑鼠底下時不要換掉預覽
                      st().restoreProject(p); setHint(`已救回「${p.title}」，回到「我的專案」`);
                      setFilter("all"); useProject.setState({ previewId: null }); previewProject(p.id); focusCard(p.id);
                    }}>救回</button></div>
                  {p.brief && <div className="pc-brief">{p.brief}</div>}
                  <div className="pc-stats"><span className="pc-time">{relTime(p.deletedAt)}刪除 · Enter 救回</span></div>
                </div>
              ))}
              {trash.length > 0 && <button className="link-btn" onClick={() => { if (confirm(`永久刪除 ${trash.length} 個專案？這個動作不能復原。`)) { const n = trash.length; st().clearTrash(); setHint(`已永久刪除 ${n} 個專案`); setTimeout(() => (document.querySelector("[data-pid]") as HTMLElement | null ?? document.querySelector(".home-cta") as HTMLElement | null)?.focus(), 60); } }}>清空（永久刪除）</button>}
            </div>
          )}
          {VIEW.length === 0 && filter !== "trash" && (
            <div className="home-empty">{q ? <>{filter === "all" ? "" : filter === "mine" ? "「我的專案」裡" : "「範例」裡"}找不到「{q}」
                {filter !== "all" && <button className="link-btn" onClick={() => { setFilter("all"); setTimeout(() => (document.querySelector(".home-search") as HTMLElement | null)?.focus(), 30); }}>在全部專案中搜尋</button>}
                <button className="link-btn" onClick={() => { setQ(""); setTimeout(() => (document.querySelector(".home-search") as HTMLElement | null)?.focus(), 30); }}>清除搜尋</button></>
              : filter === "mine" ? <>還沒有自己的專案。按上面的「新專案」，或從範例複製一份來改。</> : "沒有專案"}</div>
          )}
          {VIEW.map((p, i) => (
            <Fragment key={p.id}>
            {filter === "all" && p.source === "claude" && i === 0 && (
              <div className="label home-section">我的專案 · {VIEW.filter((x) => x.source === "claude").length}</div>
            )}
            {filter === "all" && p.source !== "claude" && (i === 0 || VIEW[i - 1].source === "claude") && (
              <div className="label home-section">範例 · {VIEW.filter((x) => x.source !== "claude").length}</div>
            )}
            <div role="button" tabIndex={0} data-pid={p.id}
                    className={`project-card card ${(previewId ?? VIEW[0]?.id) === p.id ? "is-hover" : ""} ${menuId === p.id ? "menu-open" : ""}`}
                    // pointermove 而不是 mouseenter：清單重排時滑鼠沒動，Chrome 也會送 mouseenter
                    // 滑到哪張就把鍵盤焦點也給哪張：亮著的卡就是 ⌘⌫／F2 作用的那張
                    onPointerMove={(e) => {
                      if (Date.now() <= hoverLock.current || renaming || useProject.getState().previewId === p.id) return;
                      previewProject(p.id);
                      if (document.activeElement?.closest?.(".project-card")) (e.currentTarget as HTMLElement).focus({ preventScroll: true });
                    }}
                    onFocus={() => previewProject(p.id)}
                    onClick={() => {
                      // 正在改別張的名字時點這張：只是結束改名，不要直接打開
                      if (renaming && renaming.id !== p.id) { commitRename(); return; }
                      if (Date.now() - renameEndAt.current < 400) return;   // 這次點擊只是結束改名
                      if (renaming?.id !== p.id) openProject(p.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter") openProject(p.id);
                      // 上下鍵在卡片之間移動
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const k = VIEW.findIndex((x) => x.id === p.id) + (e.key === "ArrowDown" ? 1 : -1);
                        const t = VIEW[Math.max(0, Math.min(VIEW.length - 1, k))]; if (t) { focusCard(t.id); previewProject(t.id); }
                      }
                      if (e.key === "F2" && p.source === "claude") setRenaming({ id: p.id, text: p.title });
                      if ((e.key === "F2" || e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && p.source !== "claude") { e.preventDefault(); setHint("範例不能改名或刪除，可以從 ⋯ 選「複製成我的專案」"); }
                      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); setMenuId(p.id); }
                      // 和 Finder 一樣 ⌘⌫ 才刪（單按 ⌫ 太容易誤按）（有復原與「已刪除」可救回）
                      if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && p.source === "claude") { e.preventDefault(); doDelete(p); }
                    }}>
              <div className="pc-top">
                {renaming?.id === p.id
                  ? <input className="pc-rename" value={renaming.text} autoFocus aria-label="專案名稱" maxLength={60}
                           onFocus={(e) => e.currentTarget.select()}
                           onClick={(e) => e.stopPropagation()}
                           onChange={(e) => { setRenaming({ id: p.id, text: e.target.value }); setRenameErr(false); }}
                           onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setRenaming(null); setRenameErr(false); focusCard(p.id); } }}
                           onBlur={() => { renameEndAt.current = Date.now(); if (renaming?.text.trim()) commitRename(); else { setRenaming(null); setRenameErr(false); } }} />
                  : <span className="pc-title" title={`${p.title}（Shift+F10 更多動作）`}>{mark(p.title)}</span>}
                {p.source === "claude" && p.origin === "example" && <span className="pill plain" title="從內建範例複製"><span className="v">範例副本</span></span>}
                {p.source === "claude" && p.designedAt && !p.openedAt && Date.now() - p.designedAt < 24 * 3600e3 && <span className="pill warn" title="剛設計完成、還沒打開過"><span className="v">新</span></span>}
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {p.source !== "claude" ? <span className="pill plain">範例</span>
                    : <span className={`pill ${p.errors ? "danger" : p.unverified ? "warn" : "ok"}`}>{p.errors ? `${p.errors} 項問題` : p.unverified ? "待查證" : "可以組裝"}</span>}
                  <button className="pc-more icon-btn small" tabIndex={-1} aria-label={`${p.title} 的更多動作`} title="更多動作"
                          onClick={(e) => { e.stopPropagation(); setMenuId(menuId === p.id ? null : p.id); }}>⋯</button>
                </span>
                {menuId === p.id && (
                  <div className="pc-menu" role="menu" onClick={(e) => e.stopPropagation()}
                       ref={(el) => { if (el && !el.contains(document.activeElement)) (el.querySelector("button") as HTMLElement | null)?.focus(); }}
                       onKeyDown={(e) => {
                         e.stopPropagation();
                         const items = [...e.currentTarget.querySelectorAll("button")] as HTMLElement[];
                         const i = items.indexOf(document.activeElement as HTMLElement);
                         if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
                         if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
                         if (e.key === "Escape") { setMenuId(null); (e.currentTarget.closest("[data-pid]") as HTMLElement | null)?.focus(); }
                       }}>
                    <button role="menuitem" onClick={() => { setMenuId(null); openProject(p.id); }}>開啟</button>
                    {p.source === "claude" && <button role="menuitem" onClick={() => { setMenuId(null); setRenaming({ id: p.id, text: p.title }); }}>重新命名<kbd>F2</kbd></button>}
                    <button role="menuitem" onClick={() => doDuplicate(p)}>{p.source === "claude" ? "建立副本" : "複製成我的專案"}</button>
                    {p.source === "claude" && <button role="menuitem" className="danger" onClick={() => doDelete(p)}>刪除<kbd>⌘⌫</kbd></button>}
                  </div>
                )}
              </div>
              {renaming?.id === p.id && renameErr && <div className="label" style={{ color: "var(--warn)" }}>名稱不能空白（按 Esc 取消）</div>}
              {/* 只在逗號後斷行：不會把「超過 30°C 時」這種詞組切成兩半 */}
              <div className="pc-brief">{p.brief.split(/(?<=，)/).map((c, k) => <span key={k} className="clause">{mark(c)}</span>)}</div>
              <div className="pc-stats">
                <span><b>{p.parts}</b> 個零件</span>
                <span><b>{p.wires}</b> 條線</span>
                <span className="pc-time" title={p.updatedAt ? new Date(p.updatedAt).toLocaleString() : undefined}>
                  {p.source !== "claude" ? "" : sort === "updated" ? (p.updatedAt ? `${relTime(p.updatedAt)}修改` : p.updated)
                    : p.openedAt ? `${relTime(p.openedAt)}開啟` : p.designedAt ? `${relTime(p.designedAt)}設計` : p.createdAt ? `${relTime(p.createdAt)}建立`
                    : p.updatedAt ? `尚未開啟 · ${relTime(p.updatedAt)}修改` : "尚未開啟"}</span>
              </div>
            </div>
            </Fragment>
          ))}
        </div>
        </div>
        {undo.length > 0 && !(hint && hintAt.current > Math.max(...undo.map((x) => x.deletedAt))) && (
          <div className="home-toast" role="status" onMouseEnter={() => setToastHold(true)} onMouseLeave={() => setToastHold(false)}
               onFocus={() => setToastHold(true)} onBlur={() => setToastHold(false)}>
            {undo.length === 1 ? `已刪除「${undo[0].title}」` : `已刪除 ${undo.slice(0, 3).map((x) => `「${x.title}」`).join("")}${undo.length > 3 ? ` 等 ${undo.length} 個專案` : ""}`}
            <span style={{ display: "flex", gap: 12 }}>
              <button className="link-btn" onClick={doUndo}>復原（⌘Z）</button>
              <button className="link-btn" aria-label="關閉" onClick={() => { toastDismissedAt = Date.now(); setTick((n) => n + 1); }}>✕</button>
            </span>
          </div>
        )}
        {/* 同時只顯示最新的一條提示，不要兩條疊住清單 */}
        {hint && (!undo.length || hintAt.current > Math.max(...undo.map((x) => x.deletedAt))) && <div className="home-toast" role="status">{hint}</div>}
      </section>

      {/* 首頁不放統計數字（導線、網路總數對使用者沒有用）：清單用滿整個高度 */}
    </div>
  );
}
