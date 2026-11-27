import { useMemo, useState } from "react";
import { generatePinHeader, generateSketch, validateBindings, sketchLibraries } from "@assemblex/circuit-schema";
import { makeZip } from "../util/zip";
import { downloadFile } from "../util/download";
import { useProject } from "../stores/projectStore";

/**
 * 韌體面板。
 *
 * 重點不是「秀程式碼」，是證明程式和接線**共用同一份腳位資料**：
 * pins.generated.h 由 CircuitIR 直接產生，sketch 只 include 它、不自己定義腳位，
 * 所以不可能出現「程式寫 D9、實際接 D10」。改接線 → header 重生 → 編譯期就會抓到。
 */
export function Firmware() {
  const ir = useProject((s) => s.ir);
  const selectedNet = useProject((s) => s.selectedNet), selectNet = useProject((s) => s.selectNet);
  const [tab, setTab] = useState<"header" | "sketch">("sketch");
  const [copied, setCopied] = useState<false | "ok" | "fail">(false);
  const [saved, setSaved] = useState<string | null>(null);
  const behavior = (ir.behavior ?? {}) as Record<string, unknown>;
  const summary = behavior.type === "threshold_alarm"
    ? `每 ${Math.max(2, Number(behavior.interval_ms ?? 2000) / 1000)} 秒讀一次溫度；超過 ${behavior.threshold_c ?? 30}°C 蜂鳴器響、LED 亮，響的時候按按鈕可以靜音`
    : behavior.type === "toggle" ? "按一下按鈕切換 LED 開關（軟體去彈跳 30 ms）"
    : `LED 每 ${Number(behavior.interval_ms ?? 1000) / 1000} 秒閃一次`;

  const header = useMemo(() => generatePinHeader(ir), [ir]);
  const sketch = useMemo(() => generateSketch(ir), [ir]);
  const problems = useMemo(() => validateBindings(ir), [ir]);
  const libs = useMemo(() => sketchLibraries(ir), [ir]);
  const code = tab === "header" ? header : sketch;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="seg">
          <button className={tab === "header" ? "is-on" : ""}
                  onClick={() => setTab("header")}>pins.generated.h</button>
          <button className={tab === "sketch" ? "is-on" : ""}
                  onClick={() => setTab("sketch")}>{ir.project_id}.ino</button>
        </div>
        <span style={{ flex: 1 }} />
        <span className={`pill ${problems.length ? "danger" : "ok"}`}>
          {problems.length ? `${problems.length} 項腳位綁定問題` : "腳位綁定一致"}
        </span>
      </div>

      {/* 這支程式在做什麼：一句話說清楚，不讓人自己讀程式猜 */}
      <div style={{ color: "var(--text)" }}>{summary}</div>

      {/* 韌體是使用者真正要帶走的東西：複製這個檔案，或下載整個 Arduino 專案（.zip，內含同名資料夾） */}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="gbtn" onClick={async () => {
          // 只有真的複製成功才說「已複製」；失敗時退回傳統複製，再不行就請使用者自己選取
          let ok = false;
          try { await navigator.clipboard.writeText(code); ok = true; } catch {
            const ta = document.createElement("textarea"); ta.value = code; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            try { ok = document.execCommand("copy"); } catch { ok = false; }
            ta.remove();
          }
          setCopied(ok ? "ok" : "fail"); setTimeout(() => setCopied(false), ok ? 1500 : 4000);
        }}>
          {copied === "ok" ? "已複製" : copied === "fail" ? "複製失敗：請在下方程式碼按 ⌘A 選取" : "複製這個檔案"}</button>
        <button className="gbtn primary" disabled={problems.length > 0} onClick={() => {
          // 一個 zip、裡面是同名資料夾：解壓後直接用 Arduino IDE 開 .ino
          const id = ir.project_id;
          downloadFile(`${id}.zip`, makeZip([
            { name: `${id}/${id}.ino`, text: sketch },
            { name: `${id}/pins.generated.h`, text: header },
          ])).then((p) => setSaved(p)).catch((e) => setSaved(`下載失敗：${e}`));
        }}>下載 Arduino 專案 · ZIP</button>
      </div>
      {saved && <div className="label">{saved.startsWith("下載失敗") ? saved : `已存到 ${saved.replace(/^.*\/Downloads\//, "下載/")}`}</div>}

      {/* 必要的前置步驟：沒裝函式庫就編譯不過，所以用提示卡，不是灰色小字 */}
      {libs.length > 0 && (
        <div className="warn-row" style={{ alignItems: "flex-start" }}>
          <span className="pill warn"><span className="v">先安裝</span></span>
          <span style={{ wordBreak: "keep-all", lineBreak: "strict" }}>Arduino IDE ›「工具 › 管理程式庫」搜尋並安裝：<b style={{ color: "var(--text)", whiteSpace: "nowrap" }}>{libs.join("、")}</b>
            <span className="label" style={{ display: "block", marginTop: 2 }}>安裝時會一併安裝它需要的 Adafruit Unified Sensor</span></span>
        </div>
      )}

      {problems.map((p, i) => (
        <div key={i} className="card" style={{ padding: "8px 11px",
             fontSize: "var(--fs-sm)", lineHeight: "var(--lh-sm)", color: "var(--danger)" }}>{p}</div>
      ))}

      {/* 程式碼：自動換行（不再橫向截斷），註解淡一階，填滿面板剩下的高度 */}
      <div className="label">滑過前面有色條的程式行，3D 亮出同色那條線</div>
      <pre className="scroll code" style={{
        margin: 0, padding: "12px 14px", flex: 1, minHeight: 120,
        background: "var(--surface-2)", borderRadius: 12,
        boxShadow: "inset 0 0 0 1px var(--line)",
        fontFamily: "var(--mono)", fontSize: "12px", lineHeight: "18px",
        color: "var(--text)", whiteSpace: "pre", overflowX: "auto",
      }}>{code.split("\n").map((line, i) => {
        const k = line.indexOf("//");
        // 這一行提到哪個腳位常數 → 找到對應的網路，滑過時 3D 亮起那條線
        const pin = Object.keys(ir.logical.firmware_bindings).find((n) => new RegExp(`\\b${n}\\b`).test(k < 0 ? line : line.slice(0, k)));
        const ref = pin ? ir.logical.firmware_bindings[pin] : null;
        const net = ref ? ir.logical.nets.find((n) => n.pins.includes(ref))?.id : undefined;
        const wc = net ? ir.physical.wires.find((w) => w.net_id === net)?.color : undefined;
        return <div key={i} className={`code-line ${net ? "is-pin" : ""} ${net && net === selectedNet ? "is-hover" : ""}`}
                    style={wc ? ({ "--net-c": wc } as React.CSSProperties) : undefined}
                    onMouseEnter={net ? () => selectNet(net) : undefined}
                    onMouseLeave={net ? () => selectNet(null) : undefined}>
          {k < 0 ? line || " " : <>{line.slice(0, k)}<span className="cmt">{line.slice(k)}</span></>}</div>;
      })}</pre>

      <div className="label">電路版本 {ir.revision} · {Object.keys(ir.logical.firmware_bindings).length} 個腳位綁定 · {code.split("\n").length} 行</div>
    </div>
  );
}
