import { useEffect, useRef, useState } from "react";
import { useAiJob, useAiSeconds } from "../stores/aiJob";
import { BREADBOARD_OPTIONS } from "../stores/projectStore";
import { designCircuit, getApiKey, setApiKey, hasLocalKey, hasBuiltInKey, explainError } from "../ai/generate";
import { BOARDS, boardOf } from "../data/boards";
import { useProject } from "../stores/projectStore";
import blink from "../data/examples/blink.circuit.json";
import buttonLed from "../data/examples/button_led.circuit.json";
import dht22 from "../data/examples/dht22_alarm.circuit.json";

/**
 * 需求輸入。使用者的輸入也發生在空間裡，不是另開一個 2D 對話框。
 *
 * 兩條路：
 *  - 有 OpenAI API 金鑰（內建或手動設定）→ 任何一句需求都交給 GPT-5.5 設計，產出的 CircuitIR 要通過
 *    Schema、腳距、電氣檢查才會載進場景（沒過就把錯誤交回去修正，最多三次）。
 *  - 點內建範例 → 播放預錄的設計推理，標示為「預錄」，不假裝它在推論。
 */

interface Recipe {
  prompt: string;
  ir: unknown;
  steps: string[];
}

export const RECIPES: Recipe[] = [
  {
    prompt: "按鈕切換 LED（上拉電阻＋軟體去彈跳）",
    ir: buttonLed,
    steps: [
      "解析需求 → 一個數位輸入、一個數位輸出",
      "選用元件 → UNO R3、6mm 輕觸開關、5mm LED、330Ω、10kΩ",
      "查規格書 → UNO GPIO 建議 20mA、LED 順向壓降約 2.0V",
      "計算限流電阻 → (5.0 − 2.0) / 0.015 = 200Ω，E12 最近值是 220Ω；改用 330Ω 讓電流約 9mA，亮度足夠、腳位負擔更小",
      "按鈕上拉 → 10kΩ 接 5V，按下時拉到 GND",
      "配置腳位 → BUTTON_PIN = D2（支援外部中斷）、LED_PIN = D9（PWM）",
      "配置麵包板列位與杜邦線",
      "電氣檢查 → Union-Find 推實體連通性，比對設計 Netlist",
    ],
  },
  {
    prompt: "DHT22 溫濕度監控，超過 30°C 時蜂鳴器響，按鈕可以靜音",
    ir: dht22,
    steps: [
      "解析需求 → 一個單匯流排感測器、一個告警輸出、一個靜音輸入",
      "選用元件 → UNO R3、DHT22、主動式蜂鳴器、2N2222、輕觸開關、LED、330Ω、1kΩ、10kΩ ×2",
      "查規格書 → DHT22 供電 3.3–6V、單匯流排需要上拉電阻",
      "DHT22 DATA 上拉 → 10kΩ 接 5V",
      "蜂鳴器 → 主動式約 30mA，超過 UNO 腳位建議的 20mA → 改用 2N2222 低側開關：D8 經 1kΩ 推基極（約 4mA），蜂鳴器電流走 5V → 集極 → 射極 → GND",
      "配置腳位 → DHT_PIN = D7、BUZZER_PIN = D8、LED_PIN = D9、BUTTON_PIN = D2",
      "配置麵包板列位 → 兩條電源軌各自供電與接地",
      "電氣檢查 → Union-Find 推實體連通性，比對設計 Netlist",
    ],
  },
  {
    prompt: "最簡單的 Blink，一顆 LED 閃爍",
    ir: blink,
    steps: [
      "解析需求 → 單一數位輸出，週期閃爍",
      "選用元件 → UNO R3、5mm LED、330Ω",
      "計算限流電阻 → (5.0 − 2.0) / 0.015 = 200Ω，E12 最近值是 220Ω；改用 330Ω 讓電流約 9mA",
      "配置腳位 → LED_PIN = D9",
      "配置麵包板列位與杜邦線",
      "電氣檢查 → 無斷路、無意外短路、無未插腳位",
    ],
  },
];

export function Prompt() {
  const s = useProject();
  const { loadIR, setView, addProject } = s;
  // 既有專案：直接顯示當初的設計推理 —— 「AI 想了什麼」是這個產品最該被看見的部分
  const meta = s.projects.find((p) => p.id === s.ir.project_id);
  const recipe = RECIPES.find((r) => (r.ir as { project_id: string }).project_id === s.ir.project_id);
  const history = meta?.steps?.length ? { prompt: meta.brief, steps: meta.steps, live: meta.source === "claude" }
    : recipe ? { prompt: recipe.prompt, steps: recipe.steps, live: false } : null;
  // 工作狀態（含輸入的需求）在全域 store：面板收起或切卡片時照跑，回來還能看到進度、按停止，文字也不會不見
  const { log, setLog, thought, setThought, setT0, running, setRunning, error, setError, ctl, setCtl,
          draft: text, setDraft: setText, errorDetail, errorKind, setErrorInfo, setBase, setFinishedId, jobProjectId, setJobProjectId } = useAiJob();
  const [showDetail, setShowDetail] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 從首頁「重新設計」進來：直接開始，不用再按一次
  useEffect(() => {
    const j = useAiJob.getState();
    if (j.pendingRun && j.draft.trim() && !j.running) { j.setPendingRun(false); j.clearInterrupted(); setTimeout(run, 0); }
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const { interrupted, clearInterrupted } = useAiJob();
  const myParts = [...s.profiles.values()].filter((p) => p.component_id.startsWith("user_"));
  // 這次 AI 工作的紀錄只屬於它開始（或完成後存成）的那個專案；換到別的專案看不到別人的「已停止」或需求
  const mine = !jobProjectId || jobProjectId === s.ir.project_id;
  // 背景正在設計「別的」專案：這裡不顯示它的紀錄、也不能再開一個
  const elsewhere = running && !mine;
  const [otherDraft, setOtherDraft] = useState("");
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [error]);
  const sec = useAiSeconds();
  // 設計進行中：最新那一行（含即時說明）一直捲在看得到的地方
  const lastRow = useRef<HTMLDivElement>(null);
  // 設計中、以及剛完成（「已存成專案」那一行和下一步按鈕）都捲到看得見
  useEffect(() => { if (running || log.some((l) => l.startsWith("已存成專案"))) lastRow.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [log.length, thought?.stage, running]);
  const [hasKey, setHasKey] = useState(() => !!getApiKey());
  const [keyDraft, setKeyDraft] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const timers = useRef<number[]>([]);

  function playRecipe(r: Recipe) {
    timers.current.forEach(clearTimeout);
    setText(r.prompt); setLog([]); setError(null); setRunning(true);
    const exId = (r.ir as { project_id: string }).project_id;
    const startedIn = useProject.getState().ir.project_id;
    // 使用者還在原本這個新專案才把範例畫進場景（中途回首頁時不能換掉首頁的預覽）
    const here = () => { const st = useProject.getState(); return st.screen === "project" && (st.ir.project_id === startedIn || st.ir.project_id === exId); };
    r.steps.forEach((line, i) => {
      timers.current.push(window.setTimeout(() => {
        setLog((l) => [...l, line]);
        // 「配置麵包板列位」這一步就把電路載進場景，讓人看著它長出來
        if (line.startsWith("配置麵包板") && here()) { loadIR(r.ir); setView("board"); }
        if (i === r.steps.length - 1) {
          setRunning(false); if (here()) setView("overview");
          // 從「新專案」播的範例：播完存成一份自己的專案（可以改名、組裝進度算自己的），不要把人留在範例裡
          const st = useProject.getState();
          // 從新專案做出來的就是自己的專案：用範例名稱（重名時加編號），不叫「（副本）」
          // 命名規則和「複製成我的專案」一致（由 duplicateProject 決定：範例名稱，和自己的專案重名才加編號）
          const id = st.duplicateProject(exId, { steps: [...r.steps, "從範例複製"], brief: r.prompt });
          if (id) {
            setJobProjectId(id); setText("");
            const t = useProject.getState().projects.find((x) => x.id === id)?.title ?? "";
            // 使用者已經離開（回首頁或開了別的專案）：不要把人拉回來，首頁用「已存到我的專案 · 打開」告訴他
            if (st.screen === "project" && st.ir.project_id === exId) {
              st.openProject(id); useProject.setState({ openCard: "ai" });
              setLog((l) => [...l, `已存成專案「${t}」（範例副本） · 可以點標題改名 · 下一步：看「電氣驗證」，或打開「組裝引導」照步驟接線`]);
            } else { setFinishedId(id); if (st.screen === "home") st.previewProject(id); }
          }
        }
      }, 340 * (i + 1)));
    });
  }

  async function run() {
    // 在「別的專案」的面板按設計：這次的需求是這裡輸入的那段，接手成為新的工作
    const here = !jobProjectId || jobProjectId === useProject.getState().ir.project_id;
    if (!here && !useAiJob.getState().running) { const d = otherDraft; useAiJob.getState().clearIdle(); setText(d); setOtherDraft(""); }
    const q = useAiJob.getState().draft.trim();   // 讀最新的（重試、重新設計會在同一輪先改文字）
    if (!q) return;
    // 已經有一個設計在跑：不開第二個（⌘Enter、連點都擋下）
    if (useAiJob.getState().running) return;
    useAiJob.getState().clearInterrupted();
    const r = RECIPES.find((x) => x.prompt === q);
    if (r) return playRecipe(r);
    // 沒有金鑰時不要靜默回落到某個範例：打了「超音波測距」卻冒出 DHT22，是當場失去信任的那種翻車
    if (!hasKey) { setError("要讓 AI 設計新的電路，先在下面填入 OpenAI API 金鑰。"); return; }
    useAiJob.getState().setRunMeta({ boardId: s.boardId, bbId: s.bbId });
    setLog([]); setError(null); setErrorInfo(null, null); setShowDetail(false); setRunning(true); setThought(null); setT0(Date.now()); setFinishedId(null);
    const ctl = new AbortController(); setCtl(ctl);
    const startedIn = useProject.getState().ir.project_id;
    setJobProjectId(startedIn);
    const base = useProject.getState().ir;   // 設計前的空白專案：停止或失敗時還原
    setBase(base);
    try {
      const res = await designCircuit(q, s.boardId, s.bbId, s.profiles, s.holes, s.holeIndex,
                                      (line) => { setLog((l) => [...l, line]); setThought(null); },
                                      (t) => setThought(t), ctl.signal, (part) => {
        // 元件一寫完就先在 3D 擺出來（不含導線、不含網路：還沒通過電氣檢查，不能當成完成的電路）
        const st = useProject.getState();
        if (st.ir.project_id !== startedIn) return;
        const known = part.components.filter((c) => st.profiles.has(c.profile_id) && c.id !== base.logical.board.instance_id);
        const ids = new Set(known.map((c) => c.id));
        try {
          st.loadIR({ ...base, logical: { ...base.logical, components: known.map((c) => ({ ...c, parameters: c.parameters ?? {} })), nets: [] },
                      physical: { ...base.physical, placements: [...base.physical.placements, ...part.placements.filter((x) => ids.has(x.instance_id))], wires: [] } });
        } catch { /* 半成品不合格式就先不畫 */ }
      });
      const id = `${res.ir.project_id}_${Date.now().toString(36)}`;
      const ir = { ...res.ir, project_id: id };
      // 使用者等的時候跑去看別的專案：只加進清單，不把人拉回來
      const stay = useProject.getState().screen === "project" && useProject.getState().ir.project_id === startedIn;
      addProject({ id, title: res.title, brief: q, updated: "", updatedAt: Date.now(), designedAt: Date.now(), createdAt: Date.now(), origin: "ai", ir, steps: res.steps, source: "claude", unmet: res.unmet }, stay);
      if (stay) { setView("overview"); useProject.setState({ previewId: id }); setJobProjectId(id);
        setLog((l) => [...l, `已存成專案「${res.title}」 · 下一步：看「電氣驗證」，或打開「組裝引導」照步驟接線`]); }
      else { setFinishedId(id); setJobProjectId(id); }
      setText("");
    } catch (e) {
      if (useProject.getState().ir.project_id === startedIn) useProject.getState().loadIR(base);   // 收掉預覽的半成品
      if ((e as Error).name === "AbortError") setLog((l) => [...l.filter((x) => !x.endsWith("…")), "⚠ 已停止 · 需求還在輸入框，可以修改後再設計"]);
      else {
        const x = explainError(e);
        setLog((l) => [...l.filter((y) => !y.endsWith("…")), `⚠ ${x.kind === "other" ? "設計失敗" : "沒有完成"}`]);
        setError(x.text); setErrorInfo(x.detail, x.kind);
        if (x.kind === "auth") setKeyOpen(true);
      }
    } finally {
      setRunning(false); setThought(null); setCtl(null); setBase(null);
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {!running && !mine && error && (
        <div className="err-box" role="status">
          <span>另一個專案的設計沒有完成：{error}</span>
          <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => {
            const st = useProject.getState(); const id = jobProjectId;
            if (id && id !== "new_project" && st.projects.some((p) => p.id === id)) st.openProject(id); else st.newProject(undefined, { keepJob: true });
            useProject.setState({ openCard: "ai" });
          }}>回到那個設計 →</button>
        </div>
      )}
      {elsewhere && (
        <div className="err-box" role="status" style={{ color: "var(--text-2)" }}>
          <span><span className="spin" /> AI 正在設計另一個專案{useAiJob.getState().draft ? `：「${useAiJob.getState().draft.slice(0, 30)}」` : ""}，完成前不能再開新的設計</span>
          <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => {
            const b = useAiJob.getState().base; if (b) useProject.getState().loadIR(b);
            useProject.setState((x) => ({ openCard: "ai", view: "overview", viewNonce: x.viewNonce + 1 }));
          }}>回到那個設計 →</button>
        </div>
      )}
      {/* 需求輸入放最上面：視窗矮的時候也一打開就看得到、能直接打字 */}
      <textarea value={mine ? text : otherDraft} onChange={(e) => { if (mine) { setText(e.target.value); setError(null); } else setOtherDraft(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); if (e.key === "Escape") { (e.target as HTMLElement).blur(); useProject.getState().setOpenCard(null); } }}
                placeholder="描述你要的硬體，例如：光線變暗時自動亮燈" rows={3} className="field" readOnly={running && mine}
                title={running && mine ? "設計中不能修改需求；按「停止」後可以改" : undefined}
                autoFocus={s.ir.project_id === "new_project" && !running} ref={taRef} />
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {running && !elsewhere
          ? <button className="gbtn" onClick={() => { if (Date.now() - useAiJob.getState().t0 < 800) return; ctl?.abort(); }}>停止</button>
          : (s.ir.project_id !== "new_project" && s.ir.logical.nets.length > 0)
            ? <button className="gbtn" onClick={run} disabled={!(mine ? text : otherDraft).trim() || elsewhere}>重新設計（另存新專案）</button>
            : <button className="gbtn primary" onClick={run} disabled={!(mine ? text : otherDraft).trim() || elsewhere}>{hasKey ? "設計電路" : "先設定金鑰"}</button>}
        <span className="label">{!hasKey ? "未設定金鑰：只能播放內建範例"
          : elsewhere ? "等另一個設計完成"
          : !(mine ? text : otherDraft).trim() ? (history?.prompt ? "先寫需求，或按下方「帶入修改」" : "先寫需求")
          : "通過電氣檢查才會載入"}</span>
      </div>

      {interrupted && !running && s.ir.project_id === "new_project" && (
        <div className="err-box" role="status">
          <span>上次的設計在完成前被重新整理或關閉了{interrupted.prompt ? `：「${interrupted.prompt.slice(0, 40)}」` : ""}</span>
          <span style={{ display: "flex", gap: 10 }}>
            {interrupted.prompt && <button className="gbtn" onClick={() => {
              const it = interrupted as { prompt: string; boardId?: string; bbId?: string };
              if (it.boardId) useProject.getState().setBoard(it.boardId);
              if (it.bbId) useProject.getState().setBreadboard(it.bbId);
              setText(it.prompt); clearInterrupted(); setTimeout(run, 0);
            }}>重新設計（{boardOf((interrupted as { boardId?: string }).boardId ?? s.boardId).short}）</button>}
            <button className="link-btn" onClick={clearInterrupted}>不用了</button>
          </span>
        </div>
      )}
      {/* 使用者從規格書新增的元件：讓人知道 AI 可以用，也能一鍵加進需求 */}
      {!running && myParts.length > 0 && (
        <div className="my-parts">
          <span className="label">你新增的元件（點一下加進需求）</span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {myParts.map((p) => {
              // 和內建元件同型號：AI 設計會用內建的（有原廠模型），晶片上直接講，不要讓人以為選到的是自己這份
              const info = useProject.getState().customPartInfo(p.component_id);
              const unv = p.evidence.some((e) => e.verification_status !== "verified");
              const d = info.addedAt ? new Date(info.addedAt) : null;
              const src = info.fileName ? `出處：${info.fileName}${d ? ` · ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 加入` : ""}` : "";
              const name = info.twinName ?? p.display_name;
              return (
                <button key={p.component_id} className="chip"
                        title={[info.twinName ? `同型號已有內建的「${info.twinName}」（原廠模型）：AI 設計會用內建的，點一下會加進內建的名稱` : unv ? "規格書推定，還沒查證" : "已查證", src].filter(Boolean).join("\n")}
                        onClick={() => { const cur = mine ? text : otherDraft; const v = `${cur.trim()}${cur.trim() ? "，" : ""}用${/^[A-Za-z0-9]/.test(name) ? " " : ""}${name}`; if (mine) setText(v); else setOtherDraft(v); taRef.current?.focus(); }}>
                  ＋ {p.display_name}{info.twinName ? ` · 會用內建的 ${info.twinName}` : unv ? " · 待查證" : ""}</button>
              );
            })}
          </span>
        </div>
      )}
      {/* 開發板型號：新專案可以選；換了會直接換掉 3D 裡的板子 */}
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">開發板</span>
        {/* 已經有電路的專案不能換板：收成一行，把位置讓給設計結果 */}
        {(s.ir.project_id !== "new_project" && s.ir.logical.nets.length > 0) || (running && mine) ? (
          <span className="board-line">{boardOf(s.ir.logical.board.profile_id).name}
            <span className="label"> · {(s.ir.physical.breadboard?.profile_id ?? "breadboard_830").replace("breadboard_", "")} 孔麵包板 · {running && mine ? "設計中不能換" : "換板請開新專案"}</span></span>
        ) : (
        <div className="board-picker">
          {BOARDS.map((b) => (
            <button key={b.id} className={`board-opt ${s.boardId === b.id ? "is-on" : ""}`}
                    disabled={(running && mine) || (s.ir.project_id !== "new_project" && s.ir.logical.nets.length > 0)}
                    title={b.hasModel ? `${b.logic} · ${b.spec}` : `${b.logic} · ${b.spec} · 3D 借用 UNO 外形（板型與排母位置相同，USB 與晶片不同）`}
                    onClick={() => s.setBoard(b.id)}>
              <span className="bo-name">{b.short}</span>
              <span className="bo-note">{b.logic}</span>
              {!b.hasModel && <span className="bo-note bo-warn nb"><i className="warn-dot" />3D 用 UNO 外形</span>}
              {b.pinNote && <span className="bo-note bo-warn"><i className="warn-dot" />{b.pinNote}</span>}
            </button>
          ))}
        </div>
        )}
      </div>
      {/* 麵包板尺寸：新專案可以選；AI 會照這塊板子的欄數與電源軌設計 */}
      {!(s.ir.project_id !== "new_project" && s.ir.logical.nets.length > 0) && !running && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">麵包板</span>
          <div className="bb-picker">
            {BREADBOARD_OPTIONS.map((b) => (
              <button key={b.id} className={`board-opt ${s.bbId === b.id ? "is-on" : ""}`} disabled={running}
                      onClick={() => s.setBreadboard(b.id)}>
                <span className="bo-name">{b.short}</span>
                <span className="bo-note">{b.note}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {mine && !running && log.some((l) => l.startsWith("已存成專案")) && s.ir.logical.nets.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="gbtn" onClick={() => useProject.getState().setOpenCard("elec")}>看電氣驗證</button>
          <button className="gbtn primary" onClick={() => useProject.getState().setOpenCard("ar")}>開始組裝</button>
          <button className="gbtn" onClick={() => useProject.getState().setOpenCard("fw")}>看韌體</button>
        </div>
      )}
      {error && mine && (
        <div className="err-box" role="alert" ref={errRef}>
          <span>{error}</span>
          <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            {errorKind && errorKind !== "auth" && text.trim() && <button className="gbtn" onClick={run}>重試</button>}
            {errorKind === "auth" && <button className="gbtn" onClick={() => setKeyOpen(true)}>換金鑰</button>}
            {errorKind === "auth" && hasLocalKey() && hasBuiltInKey() && <button className="gbtn" onClick={() => {
              setApiKey(""); setHasKey(!!getApiKey()); setError(null); setErrorInfo(null, null);
              setLog((l) => [...l.filter((x) => !/^⚠ (沒有完成|設計失敗)/.test(x)), "已改回內建金鑰 · 按「設計電路」再試一次"]);
            }}>改回內建金鑰</button>}
            {errorDetail && <button className="link-btn" onClick={() => setShowDetail((v) => !v)}>{showDetail ? "收起詳細" : "詳細"}</button>}
          </span>
          {showDetail && errorDetail && <code className="err-detail">{errorDetail}</code>}
        </div>
      )}
      {!running && (
        <button className="link-btn" onClick={() => useProject.getState().setOpenCard("lib")}>
          元件不在庫裡？上傳規格書，讓 AI 讀出腳位後加入元件庫 →</button>
      )}

      {(meta?.unmet?.length ?? 0) > 0 && (
        <div className="warn-row" style={{ alignItems: "flex-start" }}>
          <span className="pill warn"><span className="v">需求打折</span></span>
          <span>{meta!.unmet!.join("；")}</span>
        </div>
      )}
      {log.length > 0 && mine && (
        <div className="stack" style={{ gap: 7 }}>
          {log.map((l, i) => {
            const live = running && i === log.length - 1 && l.endsWith("…");
            // 已經過去的「進行中」行改寫成完成式，打勾和刪節號不同時出現
            const text = l.startsWith("⚠") ? l.replace(/^⚠\s*/, "") : live ? l : l.replace(/^AI 設計中…$/, "AI 已產生設計").replace(/^第 (\d) 次修正中…$/, "第 $1 次修正完成").replace(/…$/, "");
            return (
              <div key={i} ref={i === log.length - 1 ? lastRow : undefined} style={{ display: "flex", gap: 9, alignItems: "flex-start",
                                    fontSize: "var(--fs-sm)", lineHeight: "var(--lh-sm)" }}>
                {l.startsWith("⚠") ? <span style={{ color: "var(--warn)", flexShrink: 0 }}>!</span>
                  : live ? <span className="spin" style={{ flexShrink: 0, marginTop: 3 }} />
                      : <span style={{ color: "var(--ok)", flexShrink: 0, fontWeight: "var(--w-semi)" }}>✓</span>}
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ color: l.startsWith("⚠") ? "var(--warn)" : live ? "var(--text)" : "var(--text-2)" }}>
                    {l.startsWith("⚠") && text.includes("\n")
                      ? <>{text.split("\n")[0]}<br /><span className="nw" style={{ color: "var(--text-2)" }}>{text.split("\n")[1]}</span></>
                      : text}{live && <span className="num ai-sec"> · {sec} 秒</span>}
                  </span>
                  {live && thought && (
                    <span className="ai-thought" key={thought.stage.replace(/\d+/g, "")}>
                      {/* 中文階段進度：英文推理摘要只是目前這一階段的小字附註 */}
                      <span className="ai-phases">{["推理", "寫設計", "選元件與接網路", "擺放"].map((ph, k) => {
                        const at = /擺放/.test(thought.stage) ? 3 : /接網路|選元件|寫電路/.test(thought.stage) ? 2 : /寫設計推理|整理|開始輸出/.test(thought.stage) ? 1 : 0;
                        return <span key={ph} className={`ph ${k < at ? "done" : k === at ? "now" : ""}`}>{k < at ? "✓ " : ""}{ph}</span>;
                      })}</span>
                      <span className="ai-stage">{thought.stage}</span>
                      {thought.body && <span className="ai-body" lang={thought.en ? "en" : undefined}>{thought.body}</span>}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 設計決策和上面的「檢查」分開：打勾只代表驗證通過，設計理由用編號列 */}
      {history && !(running && mine) && (
        <div className="stack" style={{ gap: 8 }}>
          {history.prompt && (
            <div className="label" style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <span>當初的需求：「{history.prompt}」</span>
              {!running && <button className="link-btn" onClick={() => { if (mine) setText(history.prompt); else setOtherDraft(history.prompt); taRef.current?.focus(); }}>帶入修改</button>}
            </div>
          )}
          <span className="label">設計決策 · {history.steps.length}{meta?.origin === "example" ? "（預錄範例）" : history.live ? "（AI 生成）" : "（預錄）"}</span>
          <div className="card" style={{ padding: "12px 14px", background: "var(--surface-2)" }}>
            <div className="decision-list">
              {history.steps.map((l, i) => (
                <div key={i} className="d"><span className="n">{String(i + 1).padStart(2, "0")}</span><span>{l}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}

      {(log.length === 0 || !mine) && !running && s.ir.project_id === "new_project" && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">內建範例（預錄）</span>
          {RECIPES.map((r) => (
            <button key={r.prompt} className="chip" onClick={() => playRecipe(r)}>{r.prompt}</button>
          ))}
        </div>
      )}

      {/* 設計進行中不顯示金鑰設定：只留正在發生的事 */}
      <div className="stack" style={{ gap: 6, marginTop: 6, display: running || (!keyOpen && s.ir.project_id !== "new_project" && s.ir.logical.nets.length > 0) ? "none" : undefined }}>
        <span className="label">OpenAI API 金鑰</span>
        {hasKey && !keyOpen ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--text-2)" }}>
            {hasLocalKey() ? "已設定，只存在這台電腦" : "使用內建金鑰"}
            <button className="link-btn" onClick={() => setKeyOpen(true)}>{hasLocalKey() ? "更換" : "改用自己的金鑰"}</button>
            {hasLocalKey() && <button className="gbtn" onClick={() => { if (confirm(hasBuiltInKey() ? "移除你填的金鑰，改用內建金鑰？" : "移除金鑰？移除後就不能用 AI 設計，要再貼一次。")) { setApiKey(""); setHasKey(!!getApiKey()); } }}>移除</button>}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field" type="password" placeholder="貼上 OpenAI 金鑰（sk-…）" value={keyDraft}
                   onChange={(e) => setKeyDraft(e.target.value)} style={{ flex: 1 }} />
            <button className="gbtn" disabled={!keyDraft.trim()}
                    onClick={() => { setApiKey(keyDraft.trim()); setKeyDraft(""); setHasKey(true); setKeyOpen(false); setError(null); setErrorInfo(null, null); }}>
              儲存
            </button>
            {keyOpen && <button className="gbtn" onClick={() => { setKeyDraft(""); setKeyOpen(false); }}>取消</button>}
          </div>
        )}
      </div>
    </div>
  );
}
