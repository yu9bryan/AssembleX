import { useMemo, useState, useEffect, useRef, useLayoutEffect } from "react";
import { validateBindings, assemblySteps, generateSketch, generatePinHeader, sketchLibraries } from "@assemblex/circuit-schema";
import { getApiKey } from "../ai/generate";
import { downloadFile } from "../util/download";
import { boardOf } from "../data/boards";
import { useAiJob, useAiSeconds } from "../stores/aiJob";
import { useDsJob } from "../stores/dsJob";
import { useEditJob } from "../stores/editJob";
import { EditBar, bindFinishWarn } from "../edit/EditBar";
import { unverifiedParts } from "../stores/projectStore";
import { buildSharePayload, publishToLan, lanProgress, lanSetProgress } from "../link/share";
import { RECIPES } from "../windows/Prompt";
import { useProject, type ViewId, type CardId } from "../stores/projectStore";
import { Thumb } from "./Thumb";
import { cameraApi } from "../spatial/layout";
import { Prompt } from "../windows/Prompt";
import { Library } from "../windows/Library";
import { Inspector } from "../windows/Inspector";
import { Firmware } from "../windows/Firmware";
import { Assembly } from "../windows/Assembly";

/**
 * 工作台：3D 工作台在畫面上半部，四周是介面。
 *  左上：返回＋專案標題（大字細體）　頂部中間：視角分頁＋狀態晶片　左側：縮放鈕
 *  底部：儀表板卡片 —— AI 設計｜電氣驗證｜韌體｜AR 組裝｜元件庫（CAD 預覽）
 * 版面要和 spatial/layout.ts 的 CHROME.project 一致，鏡頭才會把工作台框在中間的空白區。
 */
/**
 * 底部儀表卡只放摘要（小灰標籤＋大的細體數字＋一行說明／進度條），點開才在右側展開細節。
 * 把完整內容塞進五張窄卡，結果是每張都被裁切 —— 參考圖的卡片本來就是儀表，不是內容容器。
 */
const CARDS: { id: CardId; label: string; Summary: () => JSX.Element; Detail: () => JSX.Element }[] = [
  { id: "ai",   label: "AI 設計",  Summary: AiSummary,   Detail: Prompt },
  { id: "elec", label: "電氣驗證", Summary: ElecSummary, Detail: Inspector },
  { id: "fw",   label: "韌體",     Summary: FwSummary,   Detail: Firmware },
  { id: "ar",   label: "組裝引導",  Summary: ArSummary,   Detail: Assembly },
  { id: "lib",  label: "元件庫",   Summary: LibSummary,  Detail: Library },
];

/** 儀表數字一律「大字分子 ＋ 小字 /分母 單位」：7 /7 網路、0 /22 步 */
function Metric({ big, of, unit, note, bar, tone = "ok", ticks, muted = false }: {
  big: string | number; of?: number; unit?: string; note: string; bar?: number; tone?: "ok" | "danger" | "warn"; muted?: boolean;
  /** 右側垂直刻度尺（參考圖的 Readiness 刻度）：total 格，前 on 格亮 */
  ticks?: { total: number; on: number; here?: number };
}) {
  return (
    <>
      {ticks && ticks.total > 0 && (
        <span className="ticks" aria-hidden>
          {/* 固定 24 格（每 4 格一根長刻度），密度和參考圖一致；由下往上填；here 標出正在看的位置 */}
          {Array.from({ length: 24 }, (_, i) => {
            const fromBottom = 23 - i;
            const lit = fromBottom < Math.round(ticks.on * 24 / ticks.total);
            const here = ticks.here != null && fromBottom === Math.min(23, Math.floor(ticks.here * 24 / ticks.total));
            return <i key={i} className={here ? "here" : lit ? `on ${tone}` : ""} />;
          })}
        </span>
      )}
      <span className={`metric ${tone === "danger" ? "is-danger" : ""} ${muted ? "is-muted" : ""}`}><span className="big">{big}</span>
        {(of != null || unit) && <span className="unit">{of != null && <><span className="slash">/</span>{` ${of} `}</>}{unit}</span>}</span>
      <span className="note">{note}</span>
      <span className={`bar ${bar == null ? "is-empty" : ""}`}><i style={{ width: `${Math.round((bar ?? 0) * 100)}%`,
        background: `var(--${tone})` }} /></span>
    </>
  );
}
function AiSummary() {
  const { projects, ir } = useProject();
  const job = useAiJob(), sec = useAiSeconds();
  // 設計進行中：卡片也說同一件事（秒數與目前階段），三處狀態一致
  if (job.running && job.jobProjectId === ir.project_id) return <Metric big={sec} unit="秒 · 設計中" note={job.thought?.stage ?? "推理中"} tone="warn" />;
  // 這個專案的設計失敗了：卡片要說，不能還寫「點開描述你要的硬體」
  if (!job.running && job.error && job.jobProjectId === ir.project_id) return <Metric big="!" note="設計沒有完成 · 點開看原因與重試" tone="warn" />;
  const meta = projects.find((p) => p.id === ir.project_id);
  const live = projects.filter((p) => p.source === "claude").length;
  const unvN = unverifiedParts(ir, useProject.getState().profiles).length;
  const errNow = useProject.getState().issues.filter((i) => i.severity === "error").length;
  if (meta?.source === "claude" && errNow) return <Metric big={meta.steps?.length ?? 0} unit="項設計決策" note={`修改後有 ${errNow} 個問題 · 看電氣驗證`} tone="warn" />;
  if (meta?.source === "claude" && meta.origin === "example") return <Metric big={meta.steps?.length ?? 0} unit="項設計決策" note="範例副本 · 已通過電氣檢查" tone="ok" />;
  if (meta?.source === "claude") return <Metric big={meta.steps?.length ?? 0} unit="項設計決策" note={meta.unmet?.length ? `AI 生成 · ${meta.unmet.length} 項需求打折` : unvN ? `AI 生成 · ${unvN} 個元件待查證` : "AI 生成 · 已通過電氣檢查"} tone={meta.unmet?.length || unvN ? "warn" : "ok"} />;
  // 內建範例：顯示這個專案的（預錄）設計推理有幾步，而不是一條「—」
  const recipe = RECIPES.find((r) => (r.ir as { project_id: string }).project_id === ir.project_id);
  if (recipe) {
    const orig = recipe.ir as { logical: { components: unknown[] }; physical: { wires: unknown[] } };
    const changed = orig.logical.components.length !== ir.logical.components.length || orig.physical.wires.length !== ir.physical.wires.length;
    return <Metric big={recipe.steps.length} unit="項設計決策" note={changed ? "已修改 · 預錄推理只適用原始範例" : "預錄範例 · 點開看"} tone={changed ? "warn" : undefined} />;
  }
  // 空專案：還沒設計就是「—」（首頁的專案數不屬於這個專案，不放在這裡）
  return <Metric big="—"
                 note={getApiKey() ? "點開描述你要的硬體" : "內建範例為預錄 · 點開設定金鑰"} />;
}
function ElecSummary() {
  const { ir, issues } = useProject();
  const warns = issues.filter((x) => x.severity === "warning").length;
  const bad = new Set(issues.filter((i) => i.severity === "error").flatMap((e) => (e.net_id ? [e.net_id] : []))).size;
  const n = ir.logical.nets.length;
  const parts = issues.filter((i) => i.severity === "error" && !i.net_id).length;   // 孤立元件、本體重疊
  if (n === 0) return <Metric big="—" note="尚未設計" />;
  // 對使用者只講「能不能照著接」與問題數，不講網路數（內部名詞）
  if (bad || parts) return <Metric big={bad + parts} unit="項問題" note="點開看哪裡要改" tone="danger" />;
  return <Metric big="0" unit="項問題" note={warns ? `可以組裝 · ${warns} 項提醒` : "接線檢查通過 · 可以組裝"}
                 bar={1} tone={warns ? "warn" : "ok"} />;
}
function FwSummary() {
  const { ir, issues } = useProject();
  const errs = issues.filter((i) => i.severity === "error").length;
  const total = Object.keys(ir.logical.firmware_bindings).length;
  const bad = validateBindings(ir).length;
  if (total === 0) return <Metric big="—" note="尚未設計" />;
  // 和韌體面板一致：只算主程式（.ino）的行數
  const lines = generateSketch(ir).split("\n").length;
  const libs = sketchLibraries(ir);
  // 電路有錯時不能顯示全綠：程式綁定一致，但接線錯了一樣不會動
  if (errs) return <Metric big={total - bad} of={total} unit="腳位" note="待電路修正 · 腳位可能失效" tone="warn" />;
  return <Metric big={total - bad} of={total} unit="腳位" note={`綁定一致 · ${lines} 行程式${libs.length ? ` · 需 ${libs.map((l) => l.replace(/（.*）/, "")).join("、")}` : ""}`} bar={(total - bad) / Math.max(total, 1)}
                 tone={bad ? "warn" : "ok"} />;
}
function ArSummary() {
  const { ir, profiles, done, activeStep } = useProject();
  const steps = useMemo(() => assemblySteps(ir, profiles), [ir, profiles]);
  const n = steps.length;
  // 大數字只算真的確認完成的步驟；正在看哪一步寫在說明裡，不灌進進度
  const at = done.length;
  const errs = useProject.getState().issues.filter((i) => i.severity === "error").length;
  if (errs && activeStep == null && n > 0 && ir.logical.nets.length > 0)
    return <Metric big={at} of={n} unit="步完成" note="待電氣驗證通過" muted />;
  if (n === 0 || ir.logical.nets.length === 0) return <Metric big="—" note="尚未設計" />;
  // 組裝中：大數字就是現在在第幾步（和面板一致）；說明寫已完成和待補
  // 大數字和進度條是同一個量：完成了幾步。正在看哪一步寫在說明
  if (activeStep != null) return <Metric big={at} of={n} unit="步完成" note={`正在第 ${activeStep + 1} 步`} bar={at / n} />;
  return <Metric big={at} of={n} unit="步完成"
                 note={at >= n && n > 0 ? "全部完成 · 下一步：上傳韌體" : at ? "點開繼續組裝 · 可用手機 AR" : "點開開始組裝 · 可用手機 AR"} bar={at / n} />;
}
function LibSummary() {
  const { ir, profiles } = useProject();
  // 規格書工作在背景跑：卡片關著也要看得到進度與「待確認」
  const ds = useDsJob();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!ds.stage) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [ds.stage]);
  const dsSec = Math.max(0, Math.round((now - ds.t0) / 1000));
  const used = [...new Set([ir.logical.board.profile_id, ...ir.logical.components.map((c) => c.profile_id)])]
    .map((id) => profiles.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  return (
    <>
      <span className="metric"><span className="big">{used.length}</span><span className="unit">種零件</span>
        <span className="thumbs">{used.slice(0, 3).map((p) => <Thumb key={p.component_id} profile={p} size={30} />)}</span>
      </span>
      <span className="note">{ds.stage ? <><span className="spin" /> 讀規格書中 · {dsSec} 秒</>
        : ds.result ? <span style={{ color: "var(--warn)" }}>● 規格書讀完 · 待確認</span>
        : ds.error ? <span style={{ color: "var(--warn)" }}>規格書讀取失敗 · 點開看原因</span>
        : ds.interrupted ? <span style={{ color: "var(--warn)" }}>規格書讀取被中斷 · 點開重新讀取</span>
        : "此專案使用 · 點開看全部"}</span>
    </>
  );
}

const VIEWS: [ViewId, string][] = [["overview", "總覽"], ["board", "麵包板"], ["mcu", "開發板"]];

export function Workspace() {
  const s = useProject();
  const open = CARDS.find((c) => c.id === s.openCard);
  // 面板收起時先播完淡出動畫再卸載（不是直接消失）
  const [panel, setPanel] = useState(open ?? null);
  useEffect(() => {
    if (open) { setPanel(open); return; }
    // 保險：動畫事件沒觸發（分頁在背景、畫面很忙）也要在動畫長度後卸載
    const t = setTimeout(() => setPanel(null), 240);
    return () => clearTimeout(t);
  }, [open]);
  const meta = s.projects.find((p) => p.id === s.ir.project_id);
  // 範例被改過（零件或導線和原始資料不同）就不能再說是「預錄」：預錄的推理只適用原始範例
  const orig = meta?.ir as { logical: { components: unknown[]; nets: unknown[] }; physical: { wires: unknown[] } } | undefined;
  const modified = !!orig && meta!.id !== "new_project" && (orig.logical.components.length !== s.ir.logical.components.length
    || orig.physical.wires.length !== s.ir.physical.wires.length || orig.logical.nets.length !== s.ir.logical.nets.length);
  const aiLabel = meta?.source === "claude" && meta.origin === "example" ? (modified ? "範例副本 · 已修改" : "範例副本")
    : meta?.source === "claude" ? (modified ? "AI 生成 · 已修改" : "AI 生成") : meta && meta.id !== "new_project" ? (modified ? "範例 · 已修改" : "範例 · 預錄") : "—";
  const errors = s.issues.filter((i) => i.severity === "error").length;
  const empty = s.ir.logical.nets.length === 0;   // 沒有電路時不能說「檢查通過」
  const bindingIssues = useMemo(() => validateBindings(s.ir).length, [s.ir]);
  const parts = s.ir.logical.components.length + 1;
  const title = s.ir.project_id === "new_project" ? "新專案" : (meta?.title ?? s.ir.project_id);
  // 自己的專案可以直接點標題改名（範例不行：要先複製）
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const canRename = meta?.source === "claude";
  // 範例不能改的提示：從標題來（想改名）或從鉛筆來（想手動調整），複製後各自接著做
  const [exHint, setExHint] = useState<false | "rename" | "edit">(false);
  const [toast, setToast] = useState<string | null>(null);
  const [wsMenu, setWsMenu] = useState(false);
  useEffect(() => {
    if (!wsMenu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".ws-menu-wrap")) setWsMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setWsMenu(false); } };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc, true); };
  }, [wsMenu]);
  const edit = useEditJob();
  // 換專案或打開面板時結束手動調整
  useEffect(() => { if (edit.on) edit.stop(); }, [s.ir.project_id]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 打開卡片會結束調整：還有問題就提醒一次（復原紀錄保留，可以再按鉛筆接著改）
  useEffect(() => {
    if (edit.on && s.openCard) {
      const n = s.issues.filter((i) => i.severity === "error").length;
      edit.stop();
      if (n) setToast(`已結束手動調整 · 還有 ${n} 個問題，可再按鉛筆接著改（可復原）`);
    }
  }, [s.openCard]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bindFinishWarn((n) => setToast(`已結束手動調整 · 還有 ${n} 個問題，可再按鉛筆接著改（可復原）`)); }, []);
  const [storageHidden, setStorageHidden] = useState(false);
  useEffect(() => { if (!s.storageError) setStorageHidden(false); }, [s.storageError]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { setExHint(false); }, [s.ir.project_id]);
  const endEdit = () => { setEditTitle(null); setTimeout(() => h1Ref.current?.focus(), 0); };
  const ai = useAiJob(), aiSec = useAiSeconds();
  // 背景在設計別的專案時，這個專案的狀態照常顯示，不冒充「設計中」
  const aiHere = ai.running && ai.jobProjectId === s.ir.project_id;
  // 標題不能壓到右邊的頁籤列：依頁籤列實際左緣算出可用寬度，超出就省略號（完整名稱在 tooltip）
  const h1Ref = useRef<HTMLHeadingElement>(null), navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const h = h1Ref.current, n = navRef.current;
      if (h && n) h.style.maxWidth = `${Math.max(160, n.getBoundingClientRect().left - h.getBoundingClientRect().left - 40)}px`;
    };
    fit(); document.fonts?.ready.then(fit);
    const ro = new ResizeObserver(fit);
    if (navRef.current) ro.observe(navRef.current);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  });
  const unv = useMemo(() => unverifiedParts(s.ir, s.profiles), [s.ir, s.profiles]);
  // 組裝進度和手機雙向同步：本機改了就寫進伺服器；每秒讀一次，手機寫的（seq 變了）就套用
  const seqSeen = useRef(0), remoteApplied = useRef("");
  useEffect(() => {
    if (empty) return;
    const key = JSON.stringify([s.ir.project_id, s.done]);
    if (key === remoteApplied.current) return;   // 剛套用手機的進度，不要再寫回去
    const t = setTimeout(() => { lanSetProgress(s.ir.project_id, s.activeStep, s.done).then((q) => { if (q) seqSeen.current = q; }); }, 250);
    return () => clearTimeout(t);
  }, [s.done, s.activeStep, s.ir.project_id, empty]);
  useEffect(() => {
    const id = setInterval(async () => {
      const p = await lanProgress();
      if (!p || !p.seq || p.seq <= seqSeen.current) return;
      seqSeen.current = p.seq;
      const st = useProject.getState();
      if (p.from === "phone" && p.projectId === st.ir.project_id) {
        remoteApplied.current = JSON.stringify([p.projectId, p.done]);
        st.applyRemoteProgress(p.done, p.step);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);
  // 內網分享給手機 AR：專案一改就推一次（停 300ms 再推，連續操作不會一直重組）
  useEffect(() => {
    if (empty) return;
    const t = setTimeout(() => publishToLan(buildSharePayload(s.ir, s.profiles, s.holeIndex, title)), 300);
    return () => clearTimeout(t);
  }, [s.ir, s.profiles, s.holeIndex, title, empty]);

  return (
    <div className="overlay">
      <div className="scrim-top" />
      <div className="scrim-bottom" />
      {(s.activeStep != null && s.openCard !== "ar") || (ai.running && !aiHere) || (!ai.running && ai.jobProjectId && ai.jobProjectId !== s.ir.project_id && (ai.error || ai.finishedId)) ? (
        <div className="ws-strip" role="status">
          {s.activeStep != null && s.openCard !== "ar" && (
            <span>組裝中 · 第 {s.activeStep + 1} 步 <button className="link-btn" onClick={() => s.setOpenCard("ar")}>回到組裝</button></span>)}
          {ai.running && !aiHere && (
            <span><span className="spin" /> 另一個專案設計中 · {aiSec} 秒 <button className="link-btn" onClick={() => {
              const b = ai.base; if (b) s.loadIR(b); useProject.setState({ openCard: "ai" }); }}>回去看</button></span>)}
          {!ai.running && ai.jobProjectId && ai.jobProjectId !== s.ir.project_id && ai.error && (
            <span style={{ color: "var(--warn)" }}>另一個專案的設計沒有完成 <button className="link-btn" onClick={() => {
              const id = ai.jobProjectId!; if (id !== "new_project" && s.projects.some((p) => p.id === id)) s.openProject(id); else s.newProject(undefined, { keepJob: true });
              useProject.setState({ openCard: "ai" }); }}>回去看</button></span>)}
          {!ai.running && ai.finishedId && ai.finishedId !== s.ir.project_id && !ai.error && (
            <span style={{ color: "var(--ok)" }}>✓ 「{s.projects.find((p) => p.id === ai.finishedId)?.title}」設計完成 <button className="link-btn" onClick={() => { const id = ai.finishedId!; ai.setFinishedId(null); s.openProject(id); useProject.setState({ openCard: "ai" }); }}>打開</button></span>)}
        </div>
      ) : null}
      {s.storageError && !storageHidden && (
        <div className="storage-warn" role="alert">
          <span>這台電腦的儲存空間滿了，最近的變更（進度、改名、新專案）沒有存起來。回首頁清空「最近刪除」、刪掉不用的專案可以騰出空間。</span>
          <button className="link-btn" aria-label="關閉" onClick={() => setStorageHidden(true)}>✕</button>
        </div>
      )}
      <header className="ws-title">
        <button className="icon-btn" title="回到專案列表" onClick={s.goHome}>
          <svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6" /></svg></button>
        <div>
          {/* 不手動切行：短標題一行排完，長的交給 balance 平均分行 */}
          {editTitle != null
            ? <input className="display ws-h1 ws-title-input" value={editTitle} autoFocus aria-label="專案名稱" maxLength={60}
                     onFocus={(e) => e.currentTarget.select()}
                     onChange={(e) => setEditTitle(e.target.value)}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") {
                         if (!editTitle.trim()) return;
                         if (meta) { s.renameProject(meta.id, editTitle);
                           if (s.projects.some((x) => x.id !== meta.id && x.title === editTitle.trim())) setToast(`已有同名的專案「${editTitle.trim()}」，可以再改一個名字分辨`); }
                         endEdit();
                       }
                       if (e.key === "Escape") endEdit();
                     }}
                     onBlur={() => {
                       if (meta && editTitle.trim()) {
                         s.renameProject(meta.id, editTitle);
                         if (s.projects.some((x) => x.id !== meta.id && x.title === editTitle.trim())) setToast(`已有同名的專案「${editTitle.trim()}」，可以再改一個名字分辨`);
                       }
                       setEditTitle(null);
                     }} />
            : null}
          {editTitle != null && !editTitle.trim() && <div className="label" style={{ color: "var(--warn)" }}>名稱不能空白（Esc 取消）</div>}
          {editTitle != null ? null
            : <h1 ref={h1Ref} className={`display ws-h1 ${canRename ? "renamable" : ""}`}
                  title={canRename ? `${title}（點一下或按 Enter 改名）` : meta && meta.source !== "claude" ? `${title}（範例不能改名：回首頁用 ⋯「複製成我的專案」後可改）` : title}
                  tabIndex={canRename ? 0 : undefined} role={canRename ? "button" : undefined}
                  onKeyDown={(e) => { if (canRename && (e.key === "Enter" || e.key === "F2")) { e.preventDefault(); setEditTitle(title); } }}
                  onClick={() => { if (canRename) setEditTitle(title); else if (meta && meta.source !== "claude") setExHint("rename"); }}>{title}</h1>}
          {exHint && meta && (
            <div className="label" style={{ display: "flex", gap: 10, alignItems: "baseline", marginTop: 4 }}>
              {exHint === "edit" ? "範例不能直接調整" : "範例不能改名"}
              <button className="link-btn" onClick={() => {
                const from = exHint;
                const id = s.duplicateProject(meta.id); setExHint(false);
                if (!id) return;
                s.openProject(id);
                // 從標題來的：直接改名；從鉛筆來的：直接進入手動調整
                if (from === "edit") setTimeout(() => { s.setView("board"); useEditJob.getState().start(id); }, 60);
                else setTimeout(() => setEditTitle(useProject.getState().projects.find((x) => x.id === id)?.title ?? ""), 50);
              }}>{exHint === "edit" ? "複製成我的專案並開始調整" : "複製成我的專案"}</button>
              <button className="link-btn" onClick={() => setExHint(false)}>✕</button>
            </div>
          )}
          {/* 專案管理不用回首頁：改名、建立副本、刪除（刪除後回首頁，提示可以復原） */}
          {meta && editTitle == null && (
            <span className="ws-menu-wrap">
              <button className="link-btn ws-more" aria-haspopup="menu" aria-expanded={wsMenu} title="專案選項" onClick={() => setWsMenu((v) => !v)}>⋯ 專案</button>
              {wsMenu && (
                <div className="pc-menu ws-menu" role="menu">
                  {canRename && <button role="menuitem" onClick={() => { setWsMenu(false); setEditTitle(title); }}>改名<kbd>F2</kbd></button>}
                  <button role="menuitem" onClick={() => {
                    setWsMenu(false);
                    const id = s.duplicateProject(meta.id);
                    if (!id) { setToast("儲存空間滿了，沒有建立副本"); return; }
                    s.openProject(id);
                    setTimeout(() => setToast(`已建立副本「${useProject.getState().projects.find((x) => x.id === id)?.title ?? ""}」，現在開著的是副本`), 60);
                  }}>{meta.source === "claude" ? "建立副本" : "複製成我的專案"}</button>
                  {meta.source === "claude" && <button role="menuitem" className="danger" onClick={() => {
                    setWsMenu(false);
                    s.deleteProject(meta.id); s.goHome();
                  }}>刪除（回首頁可復原）</button>}
                </div>
              )}
            </span>
          )}
          <div style={{ color: "var(--text-3)", marginTop: 8 }}>
            {s.ir.logical.nets.length === 0 ? (aiHere ? "AI 設計中 · 通過電氣檢查後才會載入電路" : "描述你要的硬體，AI 會配好零件與接線")
              : `${parts} 個零件 · ${s.ir.physical.wires.length} 條線 · 版本 ${s.ir.revision}`}
          </div>
        </div>
      </header>

      <nav ref={navRef} className="ws-nav">
        <div className="seg">
          {VIEWS.map(([id, label]) => {
            const on = s.view === id && s.activeStep == null;   // 組裝特寫時鏡頭不屬於任何一個視角，不亮
            return (
              <button key={id} className={on ? (s.cameraDirty ? "is-dirty" : "is-on") : ""}
                      title={on && s.cameraDirty ? "鏡頭已手動調整，再按一次回到這個視角" : undefined}
                      onClick={() => s.setView(id)}>
                {label}{on && s.cameraDirty ? " ↺" : ""}
              </button>
            );
          })}
        </div>
        {/* 頂列只放總狀態和儀表卡沒有的資訊，不重複底下的數字 */}
        <span className={`pill clickable ${aiHere ? "warn" : empty ? "" : errors || bindingIssues ? "danger" : unv.length || s.issues.some((x) => x.severity === "warning") ? "warn" : "ok"}`}
              onClick={() => s.setOpenCard(aiHere ? "ai" : "elec")}>
          <span className="k">狀態</span><i className="sep" />
          <span className="v num">{aiHere ? `設計中 · ${aiSec} 秒` : empty ? "尚未設計" : errors || bindingIssues ? `${errors + bindingIssues} 項問題`
            : unv.length ? `可以組裝 · ${unv.length} 待查證`
            : s.issues.some((x) => x.severity === "warning") ? `可以組裝 · ${s.issues.filter((x) => x.severity === "warning").length} 項提醒` : "可以組裝"}</span></span>
        <span className="pill board-chip plain">
          <span className="k">板型</span><i className="sep" /><span className="v" title={boardOf(s.ir.logical.board.profile_id).name}>{boardOf(s.ir.logical.board.profile_id).short === "UNO" ? "UNO R3" : boardOf(s.ir.logical.board.profile_id).short}</span></span>
        <span className="pill plain clickable" onClick={() => s.setOpenCard("ai")}>
          <span className="k">來源</span><i className="sep" /><span className="v">{aiLabel}</span></span>
        {/* 手機 AR 入口放在頂列：不用先找到「組裝引導」面板。點了打開面板，QR code 在最上方 */}
        {!empty && <button className="pill plain clickable phone-pill"
                title={empty ? "設計好電路後，可以用手機在實體麵包板上看接線" : "用手機掃 QR code，在實體麵包板上逐步看接線"}
                onClick={() => {
                  // 不退出組裝：打開面板（沒開的話），再請手機區塊展開 QR 並捲到看得見
                  if (s.openCard !== "ar") s.setOpenCard("ar");
                  setTimeout(() => window.dispatchEvent(new Event("assemblex:showqr")), 60);
                }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></svg>
          <span className="v">手機 AR</span>
        </button>}
      </nav>

      {toast && <div className="ws-toast" role="status">{toast}</div>}
      {edit.on && <EditBar />}
      <div className="ws-tools">
        {/* 手動調整零件與走線：自己的專案才能改（範例要先複製） */}
        {!empty && !aiHere && (
          <button className={`icon-btn ${edit.on ? "is-on" : ""}`} title={edit.on ? "結束手動調整" : "手動調整零件與走線"}
                  onClick={() => {
                    if (edit.on) { edit.stop(); return; }
                    if (meta && meta.source !== "claude") { setExHint("edit"); return; }
                    s.setActiveStep(null); useProject.setState({ openCard: null }); s.setView("board"); edit.start(s.ir.project_id);
                  }}>
            <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
          </button>
        )}
        <button className="icon-btn" title={empty ? "尚未設計，沒有可匯出的電路" : "匯出電路檔（.json，存到「下載」）"} disabled={empty} onClick={() => {
          // 存好要說存到哪；失敗也要說（不能按了沒反應）
          downloadFile(`${s.ir.project_id}.circuit.json`, new Blob([JSON.stringify(s.ir, null, 2)], { type: "application/json" }))
            .then((p) => setToast(`已匯出：${p.split("/").pop()}（下載資料夾）`))
            .catch((e) => setToast(`匯出失敗：${(e as Error)?.message ?? e}`));
        }}>
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
        </button>
      </div>

      <div className="zoom-stack">
        <button className="icon-btn" title="放大" onClick={() => cameraApi.zoom(1)}>
          <svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12" /></svg></button>
        <button className="icon-btn" title="回到目前視角" onClick={() => cameraApi.recenter()}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="1.5" /></svg></button>
        <button className="icon-btn" title="縮小" onClick={() => cameraApi.zoom(-1)}>
          <svg viewBox="0 0 24 24"><path d="M6 12h12" /></svg></button>
      </div>

      {/* 操作提示只在沒開面板、還沒動過鏡頭時出現；會用了就不要一直擋在 3D 上 */}
      {!s.openCard && !s.cameraDirty && s.view === "overview" && s.ir.logical.nets.length > 0 &&
        <div className="hint" key={s.ir.project_id}>拖曳旋轉 · 滾輪縮放 · ⇧＋拖曳 平移 · Esc {s.activeStep != null ? "結束組裝（進度保留）" : s.openCard ? "關閉面板" : "回到總覽"}</div>}

      {panel && <div className={`detail-veil ${open ? "" : "is-closing"}`} aria-hidden />}
      <section className="dock">
        {CARDS.map((c) => (
          <button key={c.id} className={`card dock-card ${s.openCard === c.id ? "is-open" : ""}`}
                  onClick={() => s.setOpenCard(c.id)}>
            <span className="label">{c.label}</span>
            <c.Summary />
          </button>
        ))}
      </section>

      {panel && (
        <aside className={`card detail ${open ? "" : "is-closing"}`} onAnimationEnd={(e) => { if (e.target === e.currentTarget && !open) setPanel(null); }}>
          <div className="card-head">
            <span className="card-title" key={`t-${panel.id}`}>{panel.label}</span>
            <span style={{ flex: 1 }} />
            <button className="icon-btn small" title="收起" onClick={() => s.setOpenCard(null)}>✕</button>
          </div>
          {/* 換卡片時內容淡入，不整塊閃掉 */}
          <div className={`card-body scroll detail-swap ${panel.id === "ai" && aiHere ? "" : "fade-bottom"}`} key={panel.id}><panel.Detail /></div>
        </aside>
      )}
    </div>
  );
}
