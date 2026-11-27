import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { lanAddress, type LanAddress } from "../link/share";
import { assemblySteps } from "@assemblex/circuit-schema";
import { loadProgress, useProject } from "../stores/projectStore";

/**
 * AR 組裝：步驟由 CircuitIR 推導（先插元件、再接線；地線 → 電源 → 訊號）。
 * 點一步，3D 就高亮對應的元件或導線 —— 手機 AR 端拿的是同一份步驟資料。
 * 手機端：掃描下方 QR code（或在同一個 Wi-Fi 下自動找到這台電腦），在實體麵包板上逐步疊出孔位與導線。
 */
export function Assembly() {
  const { ir, profiles, activeStep, setActiveStep, done, markDone, unmarkDone, resetProgress } = useProject();
  const firstOpen = (() => { for (let i = 0; i < 1e4; i++) if (!done.includes(i)) return i; return 0; })();
  // 繼續組裝：回到上次停的那一步（只是被切走、還沒按完成的那步），沒有紀錄才到第一個未完成
  const saved = loadProgress(ir.project_id)?.step;
  const resumeAt = saved != null && saved >= 0 && !done.includes(saved) ? saved : firstOpen;
  const steps = useMemo(() => assemblySteps(ir, profiles), [ir, profiles]);
  const list = useRef<HTMLOListElement>(null);
  const n = steps.length;
  const cur = activeStep != null ? steps[activeStep] : null;

  // 換步驟時清單自己捲到那一步，不用每走一步就上下找
  useEffect(() => {
    if (activeStep == null) return;
    list.current?.children[activeStep]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeStep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // 輸入框裡所有鍵都交還；焦點在按鈕或連結上時只把 Enter／空白鍵交還給它，方向鍵照樣翻頁
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const onControl = t && /^(BUTTON|A)$/.test(t.tagName);
      // → 只翻頁（預覽），不算完成；Enter（不在按鈕上）才等於按「完成這步，下一步」
      if (e.key === "ArrowRight") { e.preventDefault(); setActiveStep(activeStep == null ? Math.min(firstOpen, n - 1) : Math.min(n - 1, activeStep + 1)); }
      if (e.key === "Enter" && !onControl) { e.preventDefault(); if (!e.repeat) nextRef.current(); }   // 按住不放不會連續完成好幾步
      if (e.key === "ArrowLeft" && activeStep != null) setActiveStep(Math.max(0, activeStep - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeStep, setActiveStep, n, firstOpen]);

  const nextRef = useRef(() => {});
  const lastNext = useRef(0);
  const next = () => {
    // 防連點：剛換過步驟的 350ms 內不再前進（雙擊不會把沒做的下一步也標成完成）
    const now = performance.now();
    if (now - lastNext.current < 350) return;
    lastNext.current = now;
    if (activeStep == null) return setActiveStep(resumeAt);
    markDone(activeStep);
    // 下一個「還沒完成」的步驟（補做跳過的步驟時，不必一步步翻過已完成的）
    const after = steps.find((x) => x.index > activeStep && !done.includes(x.index));
    if (after) return setActiveStep(after.index);
    // 最後一步：還有沒確認的就留在這裡，列出是哪幾步讓使用者決定；全部完成才結束
    const missing = steps.filter((s) => s.index !== activeStep && !done.includes(s.index));
    if (missing.length) { setLeft(missing.map((s) => s.index)); return; }
    setActiveStep(null);
  };
  const [left, setLeft] = useState<number[] | null>(null);
  useEffect(() => { setLeft(null); }, [activeStep]);

  nextRef.current = next;

  return (
    <div className="stack" style={{ gap: 12 }}>
      {/* 手機 AR 入口放最上面：沒開始組裝時完整顯示 QR；組裝中縮成一行，不擋步驟 */}
      {activeStep == null && <PhoneLink compact={false} />}
      {/* 動作列固定在最上面：引導的核心是「下一步」，不能藏在 21 步清單底下 */}
      <div className="ar-bar">
        {/* 組裝中手機區塊在固定列裡：按「手機 AR」展開 QR 時，QR 和目前步驟都看得到 */}
        {activeStep != null && <PhoneLink compact />}
        <div className="ar-now">
          <span className="ar-count">{cur ? `第 ${activeStep! + 1} / ${n} 步` : `已完成 ${done.length} / ${n} 步`}</span>
          {cur ? <span className="ar-title">{cur.title}</span>
               : <span className="ar-title">{done.length >= n && n > 0 ? "全部完成了"
                   : resumeAt !== firstOpen ? `上次停在第 ${resumeAt + 1} 步 · 第 ${firstOpen + 1} 步還沒確認`
                   : done.length ? `已完成 ${done.length} 步 · 下一個是第 ${Math.min(firstOpen, n - 1) + 1} 步` : "準備好就從第 1 步開始"}</span>}
          {!cur && <span className="label">{done.length >= n && n > 0 ? "可以到「韌體」下載程式上傳到開發板" : done.length ? "進度已存在這台電腦，按「繼續組裝」接著做" : "每一步只顯示組到當下的狀態，當前步驟用黃框標出"}</span>}
          {cur && done.includes(cur.index) && <span className="label" style={{ color: "var(--ok)" }}>✓ 這一步已完成</span>}
          {cur && <span className="label">Enter 完成這步 · ← → 只翻頁不算完成 · Esc 結束組裝（進度保留）</span>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {cur && <button className="gbtn" disabled={activeStep === 0}
                          onClick={(e) => { setActiveStep(Math.max(0, activeStep! - 1)); (e.currentTarget as HTMLElement).blur(); }}>上一步</button>}
          {!(done.length >= n && n > 0 && !cur) && <button className="gbtn primary" onClick={next}
                  onKeyDown={(e) => { if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault(); }}>
            {!cur ? (done.length || saved != null ? `繼續組裝（第 ${Math.min(resumeAt, n - 1) + 1} 步）` : "開始組裝") : activeStep === n - 1 ? "完成組裝" : done.includes(cur.index) ? "下一步" : "完成這步，下一步"}
          </button>}
          {cur && <button className="gbtn" title="離開組裝特寫，進度會保留" onClick={() => setActiveStep(null)}>結束組裝</button>}
          {!cur && resumeAt !== firstOpen && firstOpen < n && <button className="gbtn" onClick={() => setActiveStep(firstOpen)}>從第 {firstOpen + 1} 步補做</button>}
          {!cur && done.length > 0 && <button className="gbtn" onClick={() => { if (confirm("清除這個專案的組裝進度，從第 1 步重新開始？")) resetProgress(); }}>重新開始</button>}
        </div>
        {/* 提醒放在固定的動作列裡：清單很長時也不會被捲走，按了「完成組裝」一定看得到 */}
      {left && left.length > 0 && (
          <div className="warn-row">
            <span className="pill warn"><span className="v">還差 {left.length} 步</span></span>
            第 {left.slice(0, 4).map((i) => i + 1).join("、")}{left.length > 4 ? " …" : ""} 步還沒確認
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="gbtn" onClick={() => setActiveStep(left[0])}>前往第 {left[0] + 1} 步</button>
              <button className="gbtn" onClick={() => { left.forEach((i) => markDone(i)); if (activeStep != null) markDone(activeStep); setActiveStep(null); }}>全部標為完成</button>
            </span>
          </div>
        )}
        {/* 預覽到後面的步驟時，前面還沒確認的要說清楚，並給一鍵補標 */}
        {activeStep != null && !(left && left.length) && (() => {
          const before = steps.filter((x) => x.index < activeStep && !done.includes(x.index));
          return before.length ? (
            <div className="warn-row">
              <span className="pill warn"><span className="v">未確認</span></span>
              前面 {before.length} 步還沒確認
              <button className="gbtn" style={{ marginLeft: "auto" }} onClick={() => before.forEach((x) => markDone(x.index))}>全部標為完成</button>
            </div>
          ) : null;
        })()}
      </div>


      <ol className="steps" ref={list}>
        {steps.map((s) => (
          <li key={s.index}
              className={`${activeStep === s.index ? "is-active" : ""} ${done.includes(s.index) ? "is-done" : activeStep != null && s.index < activeStep ? "is-past" : ""}`}
              onClick={() => setActiveStep(s.index)}>
            <span className="step-no" role="checkbox" aria-checked={done.includes(s.index)} tabIndex={-1}
                  title={done.includes(s.index) ? "點一下取消完成" : "點一下標為完成"}
                  onClick={(e) => { e.stopPropagation(); done.includes(s.index) ? unmarkDone(s.index) : markDone(s.index); }}>
              {done.includes(s.index) ? "✓" : s.index + 1}</span>
            <span className="step-body">
              <span className="step-title">{s.title}{s.tag && <span className="step-tag mono">{s.tag}</span>}</span>
              <span className="step-detail num">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>


    </div>
  );
}

/** 手機 AR：掃 QR code 經內網取得這個專案（協定 docs/LAN_PROTOCOL.md） */
function PhoneLink({ compact = false }: { compact?: boolean }) {
  const [addr, setAddr] = useState<LanAddress | null | undefined>(undefined);
  const [svg, setSvg] = useState("");
  const [expand, setExpand] = useState(false);   // 組裝中：預設一行，按「顯示 QR」就地展開，不用退出組裝
  useEffect(() => { lanAddress().then(setAddr); }, []);
  useEffect(() => {
    const show = () => {
      setExpand(true);
      // 組裝中 QR 在固定列裡一定看得到；沒在組裝時把面板捲回最上面看 QR
      setTimeout(() => { if (!document.querySelector(".steps li.is-active")) document.querySelector(".phone-link")?.scrollIntoView({ block: "start", behavior: "smooth" }); }, 60);
    };
    window.addEventListener("assemblex:showqr", show);
    return () => window.removeEventListener("assemblex:showqr", show);
  }, []);
  useEffect(() => {
    if (!addr?.ok) return;
    QRCode.toString(addr.url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#f0f0f1", light: "#0000" } })
      .then(setSvg).catch(() => setSvg(""));
  }, [addr]);
  if (addr === undefined) return null;
  if (!addr || !addr.ok) {
    // 組裝中也要說：按了「手機 AR」卻什麼都沒出現，會以為按鈕壞了
    const why = addr ? "這台電腦沒有連上區域網路（Wi-Fi），手機找不到它" : "手機 AR 需要桌面版 App（瀏覽器預覽無法分享）";
    return <div className="label phone-link" style={{ color: expand || !compact ? "var(--warn)" : undefined }}>手機 AR 無法使用 · {why}</div>;
  }
  if (compact && !expand) return (
    <div className="label" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      手機 AR · <span className="mono">{addr.ip}:{addr.port}</span>
      <button className="gbtn" style={{ marginLeft: "auto", padding: "2px 10px" }} onClick={() => setExpand(true)}>顯示 QR</button>
    </div>
  );
  return (
    <div className="phone-link">
      <div className="pl-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="stack" style={{ gap: 4, minWidth: 0 }}>
        <span className="pl-title">用手機在實體麵包板上看接線</span>
        <span className="pl-note">手機 AssembleX 掃描後對準麵包板，會逐步標出<span style={{ whiteSpace: "nowrap" }}>孔位與導線</span> · 手機和電腦要在同一個 <span style={{ whiteSpace: "nowrap" }}>Wi-Fi</span></span>
        <span className="pl-url mono">{addr.ip}:{addr.port}</span>
      </div>
    </div>
  );
}
