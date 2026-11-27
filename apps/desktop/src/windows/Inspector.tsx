import { useEffect, useMemo } from "react";
import { boardOf } from "../data/boards";
import { routeWires, findWireCollisions, countPlanCrossings } from "@assemblex/circuit-schema";
import { useProject } from "../stores/projectStore";

const ROLE_COLOR: Record<string, string> = { ground: "#6e6e73", power: "#ff5b4f", signal: "#a3a3a8" };
const KIND_LABEL: Record<string, string> = {
  missing_connection: "斷路", unintended_connection: "意外短路",
  power_ground_short: "電源對地短路", floating_pin: "未插腳位", pin_not_found: "找不到腳位", hole_conflict: "孔位重複",
};

/** mcu1.5V → UNO 5V、r2.2 → R2·2、bz1.- → BZ1 −：給人看的腳位名稱，原始 ID 留在 title */
function pinName(ref: string, board: string, boardShort = "UNO"): string {
  const [inst, pin] = [ref.slice(0, ref.indexOf(".")), ref.slice(ref.indexOf(".") + 1)];
  const NAMES: Record<string, string> = { "-": "負極", "+": "正極", anode: "正極", cathode: "負極", VCC: "VCC", DATA: "DATA" };
  const p = NAMES[pin] ?? (/^\d+$/.test(pin) ? `腳${pin}` : pin.replace(/^GND\d+$/, "GND"));
  return inst === board ? `${boardShort} ${p}` : `${inst.toUpperCase()} ${p}`;
}
/** 網路名稱：電源、地直接講；訊號線用它接的開發板腳位命名（D7 訊號） */
function netName(n: { id: string; role: string; pins: string[] }, board: string): string {
  if (n.role === "power") return "5V 電源";
  if (n.role === "ground") return "接地";
  const mcu = n.pins.find((p) => p.startsWith(`${board}.`));
  if (mcu) return `${mcu.split(".")[1]} 訊號`;
  // 沒接開發板的網路：用兩端元件描述（R1 → LED1）
  const ends = [...new Set(n.pins.map((p) => p.split(".")[0].toUpperCase()))];
  return ends.slice(0, 2).join(" → ");
}

/**
 * 電氣驗證。綠色不是「程式沒當」，是 Union-Find 真的推過一遍實體連通性、和設計 Netlist 對照。
 * 滑過某條網路，3D 裡對應的導線會亮起來、其他變淡。
 */
export function Inspector() {
  const { ir, issues, selectNet, selectedNet, pinnedNet, pinNet, profiles, holes } = useProject();
  // 佈線真的排不開時（極少見）要說出來，不能默默畫出交叉的線
  // 「碰撞」＝實體上兩條線擠在一起；「交叉」＝從上往下看線疊在一起。兩件事分開算、分開顯示
  const { collisions, crossings } = useMemo(() => {
    const r = routeWires(ir, profiles, holes);
    return { collisions: findWireCollisions(r).length, crossings: countPlanCrossings(r) };
  }, [ir, profiles, holes]);
  // 從 3D 點線過來：把那一列捲到看得見
  useEffect(() => {
    const id = pinnedNet ?? selectedNet;
    const row = id ? document.getElementById(`net-${id}`) : null;
    if (row && !row.parentElement?.matches(":hover")) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pinnedNet, selectedNet]);
  const wireColor = (net: string) => ir.physical.wires.find((w) => w.net_id === net)?.color;
  const errors = issues.filter((i) => i.severity === "error");
  const count = (...k: string[]) => errors.filter((e) => k.includes(e.kind)).length;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="big">{errors.length}</span>
        <span style={{ color: "var(--text-2)" }}>{errors.length ? "項問題要修正" : "項問題 · 接線檢查通過"} · {ir.physical.wires.length} 條杜邦線</span>
      </div>
      <div className="bar"><i style={{ width: `${Math.round(100 * (ir.logical.nets.length - new Set(errors.flatMap((e) => e.net_id ? [e.net_id] : [])).size) / Math.max(1, ir.logical.nets.length))}%`,
        background: errors.length ? "var(--danger)" : "var(--ok)" }} /></div>

      {/* 五項錯誤統計壓成一列晶片：省下空間讓 7 條網路全部放得下 */}
      {(() => {
        const chips = [["斷路", count("missing_connection")], ["短路", count("unintended_connection", "power_ground_short")],
          ["未插", count("floating_pin")], ["同孔多腳", count("hole_conflict")], ["孤立", count("isolated_part")],
          ["碰撞", collisions + count("part_overlap")], ["交叉", crossings]] as const;
        // 全部是 0 時收成一顆：一整列「x | 0」只傳達一個資訊
        return chips.every(([, n]) => n === 0)
          ? <div className="stat-chips"><span className="pill plain" title="斷路、短路、未插、同孔多腳、孤立元件、碰撞、交叉都檢查過">
              <span className="dot ok" /><span className="v">0 錯誤</span><i className="sep" /><span className="k">7 項檢查全過</span></span></div>
          : <div className="stat-chips">{chips.map(([k, n]) => (
              <span key={k} className={`pill ${n ? "danger" : "plain"}`}>
                <span className="k">{k}</span><i className="sep" /><span className="v">{n}</span></span>))}</div>;
      })()}
      {/* 沒有對應網路的錯誤（元件重疊、孤立元件）：網路清單裡看不到，單獨列出 */}
      {errors.filter((e) => !e.net_id).map((e, k) => (
        <div key={`e${k}`} className="warn-row is-error clickable"
             onMouseEnter={() => useProject.getState().setHoveredPart(e.pins?.[e.kind === "part_overlap" ? 1 : 0]?.split(".")[0] ?? null)}
             onMouseLeave={() => useProject.getState().setHoveredPart(null)}>
          <span className="dot danger" /><span>{e.message}</span></div>
      ))}

      {/* 提醒：不擋組裝，但要說出來（例如腳位直驅電流超過建議值） */}
      {issues.filter((x) => x.severity === "warning").map((w, k) => (
        <div key={k} className="warn-row clickable"
             onMouseEnter={() => w.net_id && selectNet(w.net_id)} onMouseLeave={() => selectNet(pinnedNet)}
             onClick={() => w.net_id && pinNet(pinnedNet === w.net_id ? null : w.net_id)}>
          <span className="pill warn"><span className="v">提醒</span></span>{w.message}</div>
      ))}

      {errors.filter((e) => !!e.net_id).map((e, i) => (
        <div key={i} className="row" style={{ background: "var(--surface-2)", alignItems: "flex-start" }}>
          <span className="pill danger">{KIND_LABEL[e.kind] ?? e.kind}</span>
          <span style={{ color: "var(--text-2)" }}>{e.message}</span>
        </div>
      ))}

      <div className="label">連線網路 · 點一下鎖定</div>
      <div className="stack">
        {ir.logical.nets.map((n) => (
          <div key={n.id} id={`net-${n.id}`} className={`net-row ${pinnedNet === n.id ? "is-pinned" : selectedNet === n.id ? "is-hover" : ""}`}
               title={`${n.id}：${n.pins.join(" · ")}`}
               onMouseEnter={() => selectNet(n.id)} onMouseLeave={() => selectNet(pinnedNet)}
               onClick={() => pinNet(pinnedNet === n.id ? null : n.id)}>
            <span className={`dot ${n.role === "ground" ? "is-ground" : ""}`}
                  style={{ background: wireColor(n.id) ?? ROLE_COLOR[n.role] ?? "#a3a3a8" }} />
            <span className="id">{netName(n, ir.logical.board.instance_id)}</span>
            <span className="pins">
              {n.pins.map((p, i) => (
                // 分隔點黏在前一個腳位後面，斷行只會發生在點之後的空格
                <span key={p} style={{ display: "contents" }}>
                  <span className="pin">{pinName(p, ir.logical.board.instance_id, boardOf(ir.logical.board.profile_id).short)}</span>
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
