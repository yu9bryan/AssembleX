import { holeShort } from "@assemblex/circuit-schema";
import { type ReactNode, Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  findPin, routeWires, assemblySteps, endpointPosition, type ComponentProfile, type WireEndpoint, type CircuitIR,
  type BreadboardHole, type Vec3, type AssemblyStep, HOUSING_H_MM,
} from "@assemblex/circuit-schema";
import { useAiJob } from "../stores/aiJob";
import { useEditJob } from "../stores/editJob";
import { datasheetShape, isDatasheetPart } from "./datasheetShape";
import { useProject } from "../stores/projectStore";
import { RoundedBox, Html, useGLTF } from "@react-three/drei";
import { routedWireGeometry } from "./wireCurve";
import { ArduinoUno } from "./ArduinoUno";
import { GltfPart } from "./GltfPart";
import { arduinoSilkTexture } from "./arduinoSilk";
import { cameraApi } from "../spatial/layout";
import { boardOf } from "../data/boards";

/** 掛在目標物件的座標系裡，把局部座標的點換成世界座標交給鏡頭（工作台本身有縮放與置中）。 */
function FocusHere({ points }: { points: [number, number, number][] }) {
  const ref = useRef<THREE.Group>(null);
  // 依內容比對而不是陣列參照：store 任何欄位變動都會讓這裡重新 render，
  // 用參照當依賴的話，使用者一拖曳鏡頭就會被拉回聚焦位置
  const key = JSON.stringify(points);
  useEffect(() => {
    const g = ref.current; if (!g) return;
    g.updateWorldMatrix(true, false);
    cameraApi.focus(points.map((p) => new THREE.Vector3(...p).applyMatrix4(g.matrixWorld).toArray() as [number, number, number]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <group ref={ref} />;
}

// 一開始就把所有元件模型載進來：否則首頁第一眼看到的是載入中的簡化方塊
for (const prof of useProject.getState().profiles.values()) {
  if (prof.geometry.desktop_model) useGLTF.preload(`/${prof.geometry.desktop_model}`);
}

/** 腳位 / 孔位 → 世界座標（mm）。AR 端未來要做同一件事，只是換成相機座標。 */
export function endpointWorld(
  e: WireEndpoint, ir: CircuitIR,
  profiles: Map<string, ComponentProfile>, holeIndex: Map<string, BreadboardHole>,
): THREE.Vector3 | null {
  if (e.kind === "hole") {
    const h = holeIndex.get(e.hole);
    return h ? new THREE.Vector3(...h.position_mm) : null;
  }
  // 和佈線用同一套換算（板外元件從排線末端的杜邦頭接出），標籤才會對在線頭上
  const p = endpointPosition(e, ir, profiles, holeIndex);
  return p ? new THREE.Vector3(...p) : null;
}

/** 一條已佈好的杜邦線。在電氣驗證 hover 某個 net 時，這條線會加粗發光、其餘變淡。 */
// 滑過導線要停一下才切換網路：掃過密集線束時不會整個場景一直閃
let netTimer: ReturnType<typeof setTimeout> | null = null;
function netSoon(net: string | null, ms: number, leaving?: string) {
  if (netTimer) clearTimeout(netTimer);
  netTimer = setTimeout(() => {
    const s = useProject.getState();
    if (net === null) { if (!leaving || s.selectedNet === leaving) s.selectNet(s.pinnedNet); return; }
    s.selectNet(net);
  }, ms);
}

type WireState = "normal" | "lit" | "dim" | "hidden" | "step";

/**
 * AR 步驟模式下，每個東西的狀態：已完成的步驟照常顯示、這一步高亮、還沒輪到的先不出現。
 * 這樣 3D 就是「組到第幾步」的樣子，而不是一整張完成圖上面塗顏色。
 */
export function stepState(steps: AssemblyStep[], active: number, targetId: string, done: number[] = []): "done" | "now" | "pending" | "later" | null {
  const s = steps.find((x) => x.targetId === targetId);
  if (!s) return null;
  if (s.index === active) return "now";
  if (done.includes(s.index)) return "done";
  // 在這一步之前、但還沒按完成：使用者可能只是點清單預覽，不能當成「沒插」而整個消失，
  // 以半透明留在板上，看得出這一步會插在哪些東西旁邊
  return s.index < active ? "pending" : "later";
}

function Wire({ points, color: raw, state: state0, net, onBoard = false, wireId }: {
  points: Vec3[]; color: string; state: Exclude<WireState, "hidden">; net?: string; onBoard?: boolean; wireId?: string;
}) {
  // 手動調整模式：點導線就選它（選到的亮起來）
  const editOn = useEditJob((j) => j.on);
  const editSel = useEditJob((j) => j.sel);
  const picked = editOn && editSel?.kind === "wire" && editSel.id === wireId;
  const state: Exclude<WireState, "hidden"> = picked ? "lit" : editOn && editSel ? (state0 === "lit" ? "normal" : state0) : state0;
  // 黑色地線放在深色麵包板上會消失：亮度太低的線色提到可讀的深灰，靠反光勾出輪廓
  const color = useMemo(() => {
    const c = new THREE.Color(raw); const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl);
    return hsl.l < 0.2 ? "#" + new THREE.Color().setHSL(hsl.h, hsl.s * 0.5, 0.17).getHexString() : raw;
  }, [raw]);
  // 淡化時保留原本色相，只降飽和與亮度並半透明：看得出是哪條線，但不搶焦點，也不會變成黑影
  const gray = useMemo(() => { const h = { h: 0, s: 0, l: 0 }; new THREE.Color(raw).getHSL(h); return h.s < 0.15; }, [raw]);
  const dimColor = useMemo(() => {
    const c = new THREE.Color(raw); const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl);
    return "#" + new THREE.Color().setHSL(hsl.h, hsl.s, Math.max(0.45, hsl.l)).getHexString();
  }, [raw]);
  const ghost = state === "dim" && !!useProject.getState().pinnedNet;
  const pick = editOn && wireId ? {
    onPointerOver: (e: { stopPropagation: () => void }) => { e.stopPropagation(); document.body.style.cursor = "pointer"; },
    onPointerOut: () => { document.body.style.cursor = ""; },
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); useEditJob.getState().select({ kind: "wire", id: wireId }); },
  } : net && !ghost && useProject.getState().activeStep == null ? {
    onPointerOver: (e: { stopPropagation: () => void }) => { e.stopPropagation(); netSoon(net, 110); document.body.style.cursor = "pointer"; },
    onPointerOut: () => { netSoon(null, 80, net); document.body.style.cursor = ""; },
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      const s = useProject.getState();
      if (s.openCard !== "elec") s.setOpenCard("elec");
      s.pinNet(net);
    },
  } : {};
  const geom = useMemo(() => routedWireGeometry(points, state === "lit" || state === "step" ? 1.0 : 0.8), [points, state]);
  const halo = useMemo(() => (state === "lit" || state === "step" ? routedWireGeometry(points, 1.45) : null), [points, state]);
  // 導線不對主光投影：架空的線會在地板上投出懸空的 U 形影子，看起來像穿模（接觸陰影仍保留）
  return (
    <>
      <mesh geometry={geom} {...pick} castShadow={state !== "dim"} raycast={ghost ? () => null : undefined}>
        {state === "dim" ? (
          <meshStandardMaterial key="dim" color={dimColor} roughness={0.6} transparent opacity={0.22} depthWrite={false} />
        ) : (
          <meshPhysicalMaterial key="solid" color={color} roughness={0.36} clearcoat={0.2}
                                clearcoatRoughness={0.4} emissive={color}
                                emissiveIntensity={(state === "lit" ? 0.3 : state === "step" ? 0.15 : 0) * (gray ? 0.3 : 1)} />
        )}
      </mesh>
      {/* 管子兩端封口：TubeGeometry 不封口，近看會看到切口 */}
      {state !== "dim" && [points[0], points[points.length - 1]].map((p, k) => (
        <mesh key={k} position={p}>
          <sphereGeometry args={[state === "lit" || state === "step" ? 1.0 : 0.8, 12, 8]} />
          <meshPhysicalMaterial color={color} roughness={0.36} clearcoat={0.2} />
        </mesh>
      ))}
      {halo && (
        <mesh geometry={halo}>
          <meshBasicMaterial color={state === "step" ? "#ffd84a" : color} transparent opacity={state === "step" ? 0.35 : 0.25}
                             depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

/** 全部導線交給佈線演算法排：直角平躺、分層避讓、從開發板拉出來的匯成排線。 */
export function Wires() {
  const { ir, profiles, holes, holeIndex, selectedNet, activeStep, done, view, hoveredPart, screen } = useProject();
  const routes = useMemo(() => routeWires(ir, profiles, holes), [ir, profiles, holes]);
  const steps = useMemo(() => assemblySteps(ir, profiles), [ir, profiles]);
  const step = activeStep != null ? steps[activeStep] : null;
  const hoveredNets = useMemo(() => new Set(hoveredPart
    ? ir.logical.nets.filter((n) => n.pins.some((p) => p.startsWith(`${hoveredPart}.`))).map((n) => n.id) : []), [ir, hoveredPart]);
  const hoveredGroups = useMemo(() => {
    const pl = hoveredPart ? ir.physical.placements.find((p) => p.instance_id === hoveredPart) : null;
    return new Set(Object.values(pl?.pin_to_hole ?? {}).map((h) => holeIndex.get(h)?.tie_group ?? ""));
  }, [ir, hoveredPart, holeIndex]);
  const stateOf = (w: CircuitIR["physical"]["wires"][number]): WireState => {
    // 高亮來源二選一：AR 組裝選中的步驟，或電氣驗證滑過／鎖定的網路
    if (step && activeStep != null) {
      const st = stepState(steps, activeStep, w.id, done);
      return st === "now" ? "step" : st === "later" ? "hidden" : st === "pending" ? "dim" : "normal";
    }
    // 滑過元件：接到它的線亮起，其他線退成透明（和滑過網路同一套規則）
    if (hoveredPart && screen === "project") {
      if (!hoveredNets.has(w.net_id ?? "")) return "dim";
      const role = ir.logical.nets.find((n) => n.id === w.net_id)?.role;
      if (role !== "power" && role !== "ground") return "lit";
      const touches = [w.from, w.to].some((e) => e.kind === "pin" ? e.pin.startsWith(`${hoveredPart}.`)
        : hoveredGroups.has(holeIndex.get(e.hole)?.tie_group ?? ""));
      return touches ? "lit" : "dim";
    }
    if (view === "mcu") return "dim";
    return !selectedNet ? "normal" : w.net_id === selectedNet ? "lit" : "dim";
  };
  return (
    <>
      {ir.physical.wires.map((w) => {
        const pts = routes.get(w.id);
        const state = stateOf(w);
        if (!pts || state === "hidden") return null;
        // 插在開發板排針上的那一端，畫一個杜邦公頭外殼；外殼跟著自己那條線的狀態走
        const ends = [w.from, w.to].filter((e) => e.kind === "pin")
          .map((e) => endpointPosition(e, ir, profiles, holeIndex)).filter((p): p is Vec3 => !!p);
        return (
          <group key={w.id}>
            <Wire points={pts} color={w.color} state={state} net={w.net_id ?? undefined} wireId={w.id}
                  onBoard={w.from.kind === "hole" && w.to.kind === "hole"} />
            {step && state === "step" && <FocusHere points={pts as [number, number, number][]} />}
            {ends.map((p, i) => <Housing key={i} at={p} color={w.color} state={view === "mcu" ? "normal" : state} />)}
            {/* 插進麵包板孔的那一端：一截鍍錫金屬針（線不是黏在孔面上） */}
            {state !== "dim" && [w.from, w.to].map((e, i) => e.kind === "hole" && holeIndex.get(e.hole) ? (
              <mesh key={`p${i}`} position={[holeIndex.get(e.hole)!.position_mm[0], holeIndex.get(e.hole)!.position_mm[1] - 0.6, holeIndex.get(e.hole)!.position_mm[2]]}>
                <cylinderGeometry args={[0.32, 0.32, 2.4, 10]} />
                <meshStandardMaterial color="#cfd2d6" metalness={0.95} roughness={0.25} />
              </mesh>) : null)}
          </group>
        );
      })}
    </>
  );
}


/** 杜邦公頭：黑色塑膠殼，頂端一小截線色的線尾，讓人看得出它是那條線的一部分。 */
function Housing({ at, color, state }: { at: Vec3; color: string; state: Exclude<WireState, "hidden"> }) {
  const H = HOUSING_H_MM;
  const dim = state === "dim";
  return (
    <group position={[at[0], at[1], at[2]]}>
      <mesh position={[0, H / 2 - 0.6, 0]} castShadow={!dim}>
        <boxGeometry args={[2.54, H - 1.2, 2.54]} />
        {dim ? <meshStandardMaterial key="d" color="#141416" roughness={0.6} transparent opacity={0.25} depthWrite={false} />
             : <meshStandardMaterial key="s" color="#141416" roughness={0.55} />}
      </mesh>
      <mesh position={[0, H - 0.6, 0]}>
        <cylinderGeometry args={[0.9, 1.2, 1.2, 16]} />
        {dim ? <meshStandardMaterial key="d" color={color} roughness={0.7} transparent opacity={0.25} depthWrite={false} />
             : <meshStandardMaterial key="s" color={color} roughness={0.4}
                                     emissive={color} emissiveIntensity={state === "lit" ? 0.25 : 0} />}
      </mesh>
    </group>
  );
}

/** AR 這一步的目標點（孔或開發板腳位）：貼地的脈動黃環＋標籤，回答「插在哪裡」 */
function TargetRing({ at, label }: { at: Vec3; label: string }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = 0.55 + 0.45 * Math.sin(clock.elapsedTime * 5);
  });
  return (
    <group position={[at[0], at[1] + 0.25, at[2]]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={7}>
        <ringGeometry args={[1.15, 1.6, 32]} />
        <meshBasicMaterial ref={mat} color="#ffd84a" transparent depthTest={false} toneMapped={false} />
      </mesh>
      <Html position={[0, 3, 0]} center zIndexRange={[9, 1]} style={{ pointerEvents: "none" }}>
        <span className="target-tag">{label}</span>
      </Html>
    </group>
  );
}

/** 靜態腳位標籤（不脈動）：開發板視角標出每根用到的排針接到哪；電氣驗證選中網路時標出該網路的每個腳位 */
/**
 * 腳位標籤：在「螢幕座標」排版，不在 3D 裡錯開。
 * 3D 裡往上抬或前後錯開幾 mm，換個視角投影到螢幕上可能不到 10px，標籤照樣疊在一起。
 * 這裡每一幀把腳位投影到螢幕，依 x 由左到右放標籤，和已放好的框重疊就往上推一個框高，
 * 再畫一條引線從腳位連到標籤，所以任何視角都不會互相蓋住、也看得出指的是哪一點。
 */
function ScreenTags({ tags, comb = false, avoid = [] }: { tags: { at: Vec3; label: string; group?: string; color?: string }[]; comb?: boolean; avoid?: Vec3[] }) {
  const anchor = useRef<THREE.Group>(null);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  const lines = useRef<(SVGPolylineElement | null)[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  const { camera, size, gl } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const g = anchor.current; if (!g) return;
    // 量出標籤圖層實際在哪（drei Html 會自己平移它），換算成相對畫布左上角的座標
    const lr = layer.current?.getBoundingClientRect(), cr = gl.domElement.getBoundingClientRect();
    const ox = lr ? cr.left - lr.left : 0, oy = lr ? cr.top - lr.top : 0;
    const pts = tags.map((t, i) => {
      v.set(t.at[0], t.at[1] + 0.3, t.at[2]).applyMatrix4(g.matrixWorld).project(camera);
      const el = labels.current[i];
      return { i, x: (v.x + 1) / 2 * size.width + ox, y: (1 - v.y) / 2 * size.height + oy,
               w: el?.offsetWidth ?? 60, h: el?.offsetHeight ?? 20, behind: v.z > 1 };
    }).sort((p, q) => p.x - q.x);
    if (comb) {
      // 直欄排法：標籤疊成一欄放在物體外側，順序＝腳位由上到下，引線短而不交叉。
      // 有分組（開發板的不同排針）時每組一欄、各自放在離那組排針較近的一側，引線不必橫越整塊板子
      const gap = 6, colGap = 28;
      const ax = avoid.map((a) => { v.set(a[0], a[1], a[2]).applyMatrix4(g.matrixWorld).project(camera); return (v.x + 1) / 2 * size.width + ox; });
      const vw = size.width + ox;
      const groups = new Map<string, typeof pts>();
      for (const q of pts) { const k = tags[q.i].group ?? ""; groups.set(k, [...(groups.get(k) ?? []), q]); }
      const placed: { side: boolean; y0: number; y1: number }[] = [];
      const order = [...groups.values()].sort((a, b) => a.reduce((s2, q) => s2 + q.y, 0) / a.length - b.reduce((s2, q) => s2 + q.y, 0) / b.length);
      for (const grp of order) {
        let byY = [...grp].sort((p, q) => p.y - q.y);
        const totalH = byY.reduce((s2, q) => s2 + q.h, 0) + gap * (byY.length - 1);
        const maxW = Math.max(...byY.map((q) => q.w));
        const gx = byY.reduce((s2, q) => s2 + q.x, 0) / byY.length;
        const right = Math.max(...byY.map((q) => q.x), ...ax) + colGap;
        const left = Math.min(...byY.map((q) => q.x), ...ax) - colGap - maxW;
        const mid = ax.length ? (Math.min(...ax) + Math.max(...ax)) / 2 : gx;
        let useRight = ax.length ? gx > mid : right + maxW < vw - 380;
        if (useRight && right + maxW > vw - 16) useRight = false;
        if (!useRight && left < ox + 96) useRight = true;
        const x0 = useRight ? right : left;
        // 錨點順序試三種（依 y、依 x 正序、依 x 反序），取引線交叉最少的那一種
        const yStart = byY.reduce((s2, q) => s2 + q.y, 0) / byY.length - totalH / 2;
        const crossings = (ord: typeof byY) => {
          let yy = yStart; const segs: number[][] = [];
          // 用實際畫出的折線（錨點 → 欄前 20px → 標籤）算交叉
          for (const q of ord) {
            const ex = useRight ? x0 : x0 + maxW, kx = useRight ? ex - 20 : ex + 20, cy = yy + q.h / 2;
            segs.push([q.x, q.y, kx, cy]); yy += q.h + gap;
          }
          let n = 0;
          // 斜段離別的錨點不到 10px 也算交叉（看起來像從那隻腳拉出來）
          const near = (px: number, py: number, sg: number[]) => {
            const [ax2, ay2, bx, by] = sg, dx = bx - ax2, dy = by - ay2, L2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((px - ax2) * dx + (py - ay2) * dy) / L2));
            return Math.hypot(ax2 + t * dx - px, ay2 + t * dy - py) < 14;
          };
          ord.forEach((q, qi) => ord.forEach((r, ri) => { if (qi !== ri && near(r.x, r.y, segs[qi])) n += 3; }));
          const o = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          for (let i2 = 0; i2 < segs.length; i2++) for (let j2 = i2 + 1; j2 < segs.length; j2++) {
            const [a, b] = [[segs[i2][0], segs[i2][1]], [segs[i2][2], segs[i2][3]]], [c, d] = [[segs[j2][0], segs[j2][1]], [segs[j2][2], segs[j2][3]]];
            if (o(c, d, a) * o(c, d, b) < 0 && o(a, b, c) * o(a, b, d) < 0) n += 10;
          }
          return n;
        };
        const perms = (arr: typeof byY): (typeof byY)[] => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((r) => [x, ...r]));
        const ys2 = byY.map((q) => q.y), xs2 = byY.map((q) => q.x);
        const collinear = Math.max(...ys2) - Math.min(...ys2) < (Math.max(...xs2) - Math.min(...xs2)) * 0.6;
        // 腳排成一列時，同分的排列偏好「標籤順序＝腳的左右順序」，讀起來跟實物一樣
        const xOrd = [...byY].sort((p, q) => p.x - q.x);
        const dev = (ord: typeof byY) => collinear ? ord.reduce((s3, q, k) => s3 + Math.abs(xOrd.indexOf(q) - k), 0) : 0;
        // 腳排成一列（元件滑過時的 DHT22、排針）：標籤整欄放在腳的上方，用直角引線
        // （腳 → 垂直到自己那一列 → 水平進標籤）。最左邊的腳接最上面的標籤，幾何上保證不交叉，
        // 也不會斜著擦過隔壁的腳。上方放不下才改放下方（那時最右邊的腳接最上面）。
        let ortho = false, y = yStart;
        if (collinear && byY.length > 1) {
          const topY = Math.min(...byY.map((q) => q.y)) - 16 - totalH;
          const botY = Math.max(...byY.map((q) => q.y)) + 16;
          ortho = true;
          // 欄在右側：標籤在上方時左腳接最上面；欄在左側或標籤改放下方時反過來
          const above = topY > oy + 72;
          byY = above === useRight ? xOrd : [...xOrd].reverse();
          y = above ? topY : botY;
        } else {
          byY = (byY.length <= 6 ? perms(byY) : [byY, xOrd, [...byY].sort((p, q) => q.x - p.x)])
            .map((ord) => [crossings(ord) * 100 + dev(ord), ord] as const).sort((a, b) => a[0] - b[0])[0][1] as typeof byY;
        }
        // 同一側已經有一欄：往下讓開
        for (const p2 of placed) if (p2.side === useRight && y < p2.y1 + 12 && y + totalH > p2.y0 - 12) y = p2.y1 + 12;
        placed.push({ side: useRight, y0: y, y1: y + totalH });
        for (const q of byY) {
          const lx = useRight ? x0 : x0 + maxW - q.w;
          const cy = y + q.h / 2;
          const el = labels.current[q.i], ln = lines.current[q.i];
          if (el) { el.style.transform = `translate(${lx}px, ${y}px)`; el.style.opacity = q.behind ? "0" : "1"; }
          // 折線引線：錨點 → 斜到標籤欄前 20px → 水平進標籤（每條線最後一段都在自己那一行，看得出指哪一張）
          const ex = useRight ? lx : lx + q.w, kx = useRight ? ex - 20 : ex + 20;
          if (ln) ln.setAttribute("points", ortho ? `${q.x},${q.y} ${q.x},${cy} ${ex},${cy}` : `${q.x},${q.y} ${kx},${cy} ${ex},${cy}`);
          y += q.h + gap;
        }
      }
      return;
    }
    type Box = { x0: number; x1: number; y0: number; y1: number };
    const boxes: Box[] = [];
    const leaders: [number, number, number, number][] = [];
    const boxHit = (b: Box, r: Box) => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0;
    // 線段和框是否相交（取樣檢查就夠了：框很小、線很短）
    const segHitsBox = (x1: number, y1: number, x2: number, y2: number, r: Box) => {
      for (let t = 0.04; t <= 0.96; t += 0.04) {
        const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
        if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
      }
      return false;
    };
    // 兩條線段是否真的相交（端點相碰不算）
    const cross = (a: number[], b: number[]) => {
      const o = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const [p1, p2, p3, p4] = [[a[0], a[1]], [a[2], a[3]], [b[0], b[1]], [b[2], b[3]]];
      const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
      return d1 * d2 < -1e-6 && d3 * d4 < -1e-6;
    };
    for (const p of pts) {
      // 候選位置：正上方由近到遠，再往左右錯開（引線變成斜的）；選第一個「框不撞框、框不壓引線、引線不穿框」的
      const side = p.w * 0.6 + 8;
      let best: { cx: number; cy: number } | null = null;
      search: for (const dy of [30, 54, 78, 102, 126, 150, -34, -58]) {   // 上方放不下就試下方
        for (const dx of [0, side, -side, side * 2, -side * 2, side * 3, -side * 3]) {
          const cx = p.x + dx, cy = p.y - dy;
          const b = { x0: cx - p.w / 2 - 3, x1: cx + p.w / 2 + 3, y0: cy - p.h / 2 - 3, y1: cy + p.h / 2 + 3 };
          if (boxes.some((r) => boxHit(b, r))) continue;
          if (leaders.some(([a1, b1, a2, b2]) => segHitsBox(a1, b1, a2, b2, b))) continue;
          if (boxes.some((r) => segHitsBox(p.x, p.y, cx, cy + p.h / 2, r))) continue;
          if (leaders.some((l) => cross(l, [p.x, p.y, cx, cy + p.h / 2]))) continue;   // 引線不交叉
          best = { cx, cy }; break search;
        }
      }
      const { cx, cy } = best ?? { cx: p.x, cy: p.y - 30 - boxes.length * 24 };
      boxes.push({ x0: cx - p.w / 2 - 3, x1: cx + p.w / 2 + 3, y0: cy - p.h / 2 - 3, y1: cy + p.h / 2 + 3 });
      leaders.push([p.x, p.y, cx, cy + p.h / 2]);
      const el = labels.current[p.i], ln = lines.current[p.i];
      if (el) { el.style.transform = `translate(${cx - p.w / 2}px, ${cy - p.h / 2}px)`; el.style.opacity = p.behind ? "0" : "1"; }
      if (ln) ln.setAttribute("points", `${p.x},${p.y} ${cx},${cy + p.h / 2}`);
    }
  });
  return (
    <group ref={anchor}>
      {tags.map((t, i) => (
        <mesh key={i} position={[t.at[0], t.at[1] + 0.3, t.at[2]]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={7}>
          <ringGeometry args={[0.5, 0.75, 24]} />
          <meshBasicMaterial color={t.color ?? "#ffffff"} transparent opacity={0.95} depthTest={false} toneMapped={false} />
        </mesh>
      ))}
      <Html fullscreen zIndexRange={[9, 1]} style={{ pointerEvents: "none" }}>
        <div ref={layer} className="tag-layer">
          <svg className="tag-lines" width={size.width} height={size.height}>
            {tags.map((_, i) => <polyline key={i} fill="none" ref={(el) => { lines.current[i] = el; }} />)}
          </svg>
          {tags.map((t, i) => (
            <span key={i} ref={(el) => { labels.current[i] = el; }} className="pin-tag">{t.color && <i className="tag-dot" style={{ background: t.color }} />}{t.label}</span>
          ))}
        </div>
      </Html>
    </group>
  );
}

const shortPin = (ref: string, board: string) => {
  const [inst, pin] = [ref.slice(0, ref.indexOf(".")), ref.slice(ref.indexOf(".") + 1)];
  const NAMES: Record<string, string> = { "-": "負極", "+": "正極", anode: "正極", cathode: "負極" };
  const p = NAMES[pin] ?? (/^\d+$/.test(pin) ? `腳${pin}` : pin.replace(/^GND\d+$/, "GND"));   // 和電氣面板同一套腳位名稱
  return inst === board ? p : `${inst.toUpperCase()} ${p}`;
};

/** 滑過元件時，每隻插在麵包板上的腳畫成一根亮金屬柱（本體半透明，腳就露出來） */
export function HoverLegs() {
  const { ir, holeIndex, hoveredPart, screen } = useProject();
  if (screen !== "project" || !hoveredPart) return null;
  const pl = ir.physical.placements.find((p) => p.instance_id === hoveredPart);
  if (!pl) return null;
  return (
    <>
      {Object.values(pl.pin_to_hole).map((h) => {
        const p = holeIndex.get(h); if (!p) return null;
        const [x, y, z] = p.position_mm;
        return (
          <mesh key={h} position={[x, y + 2.5, z]} renderOrder={6}>
            <cylinderGeometry args={[0.35, 0.35, 5, 12]} />
            <meshStandardMaterial color="#e8d38a" metalness={0.9} roughness={0.25} emissive="#e8d38a" emissiveIntensity={0.35} depthTest={false} />
          </mesh>
        );
      })}
    </>
  );
}

export function PinTags() {
  const { ir, profiles, holeIndex, view, screen, selectedNet, activeStep, hoveredPart } = useProject();
  if (screen !== "project" || activeStep != null) return null;
  const board = ir.logical.board.instance_id;
  const tags: { at: Vec3; label: string; group?: string; color?: string }[] = [];
  const netName = (ref: string) => {
    const n = ir.logical.nets.find((x) => x.pins.includes(ref));
    if (!n) return "未接";
    if (n.role === "power") return boardOf(ir.logical.board.profile_id).power === "3V3" ? "3.3V" : "5V";
    if (n.role === "ground") return "GND";
    const mcu = n.pins.find((p) => p.startsWith(`${board}.`));
    return mcu ? `接 ${mcu.split(".")[1]}` : "內部";
  };
  if (hoveredPart) {
    // 滑過元件：列出它每一隻腳（名稱 · 插在哪個孔 · 屬於哪個網路）；開發板只列有用到的腳
    const pl = ir.physical.placements.find((p) => p.instance_id === hoveredPart);
    const isBoard = hoveredPart === board;
    const comp = ir.logical.components.find((c) => c.id === hoveredPart);
    const prof = profiles.get(isBoard ? ir.logical.board.profile_id : comp?.profile_id ?? "");
    const used = new Set(ir.logical.nets.flatMap((n) => n.pins));
    for (const pin of prof?.pins ?? []) {
      const ref = `${hoveredPart}.${pin.id}`;
      if (isBoard && !used.has(ref)) continue;
      const at = endpointPosition({ kind: "pin", pin: ref }, ir, profiles, holeIndex);
      const hole = pl?.pin_to_hole[pin.id];
      const pinLabel = shortPin(ref, board).replace(/^[A-Z0-9]+ /, "");
      const net = netName(ref);
      const dest = net === "GND" ? "接地" : net.replace(/^接 /, "");
      if (at) tags.push({ at, label: [pinLabel, hole ?? "—", net === "未接" ? "未接" : dest !== pinLabel ? dest : ""].filter(Boolean).join(" · ") });
    }
  } else if (selectedNet) {
    const net = ir.logical.nets.find((n) => n.id === selectedNet);
    for (const ref of net?.pins ?? []) {
      const at = endpointPosition({ kind: "pin", pin: ref }, ir, profiles, holeIndex);
      if (at) tags.push({ at, label: ref.startsWith(`${board}.`) ? `${boardOf(ir.logical.board.profile_id).short} ${shortPin(ref, board)}` : shortPin(ref, board) });
    }
  } else if (view === "mcu") {
    for (const w of ir.physical.wires) {
      const [mine, other] = w.from.kind === "pin" && w.from.pin.startsWith(`${board}.`) ? [w.from, w.to]
        : w.to.kind === "pin" && w.to.pin.startsWith(`${board}.`) ? [w.to, w.from] : [null, null];
      if (!mine || mine.kind !== "pin") continue;
      const at = endpointPosition(mine, ir, profiles, holeIndex);
      // 另一端接到哪個元件：看那個孔所在的網路裡有哪些元件腳
      const net = ir.logical.nets.find((n) => n.id === w.net_id);
      const dest = net?.pins.find((p) => !p.startsWith(`${board}.`));
      // 用人看得懂的功能名：經過電阻／電晶體的，順著網路找到真正驅動的元件
      const nameOf = (inst: string) => {
        const comp = ir.logical.components.find((c) => c.id === inst);
        const cat = comp && profiles.get(comp.profile_id)?.category;
        const n: Record<string, string> = { sensor: "感測器", actuator: "蜂鳴器", led: "LED", input: "按鈕" };
        const prof = comp && profiles.get(comp.profile_id);
        return /dht/i.test(comp?.profile_id ?? "") ? "DHT22" : /buzzer/i.test(comp?.profile_id ?? "") ? "蜂鳴器"
          : /led/i.test(comp?.profile_id ?? "") ? "LED" : /button/i.test(comp?.profile_id ?? "") ? "按鈕"
          : (cat && n[cat]) ?? prof?.display_name ?? inst.toUpperCase();
      };
      const passive = (inst: string) => /resistor|transistor/i.test(ir.logical.components.find((c) => c.id === inst)?.profile_id ?? "");
      let to = net?.role === "power" ? "電源軌" : net?.role === "ground" ? "地線軌" : "";
      if (!to && net) {
        const direct = net.pins.map((p) => p.split(".")[0]).filter((i) => i !== board);
        const main = direct.find((i) => !passive(i));
        if (main) to = nameOf(main);
        else if (direct[0]) {
          // 只接到電阻：沿著電阻另一端的網路，找到它驅動的元件（D8 → 1kΩ → Q1 → 蜂鳴器）
          const seen = new Set<string>([net.id]); let frontier = direct; let found = "";
          for (let hop = 0; hop < 3 && !found; hop++) {
            const nets = ir.logical.nets.filter((n) => !seen.has(n.id) && n.role === "signal" && n.pins.some((p) => frontier.includes(p.split(".")[0])));
            nets.forEach((n) => seen.add(n.id));
            const insts = nets.flatMap((n) => n.pins.map((p) => p.split(".")[0])).filter((i) => i !== board);
            found = insts.find((i) => !passive(i)) ? nameOf(insts.find((i) => !passive(i))!) : "";
            frontier = insts;
          }
          to = found ? `${found} · 經 ${direct[0].toUpperCase()}${frontier.some((i) => /^q/i.test(i)) ? "、" + frontier.find((i) => /^q/i.test(i))!.toUpperCase() : ""}` : direct[0].toUpperCase();
        }
      }
      const label = `${shortPin(mine.pin, board)}${to ? ` → ${to}` : ""}`;
      const bp = profiles.get(ir.logical.board.profile_id)?.pins.find((q) => q.id === mine.pin.split(".")[1]);
      if (at) tags.push({ at, label, group: bp ? `z${Math.round(bp.position_mm[2])}` : "", color: w.color });
    }
  }
  // 開發板視角：把開發板外框的 8 個角交給標籤排版，標籤欄放在板子外面
  let avoid: Vec3[] = [];
  if (view === "mcu" && !hoveredPart) {
    const pl = ir.physical.placements.find((p) => p.instance_id === board);
    const prof = profiles.get(ir.logical.board.profile_id);
    if (pl && prof && !Object.keys(pl.pin_to_hole).length) {
      const [w, h, d] = prof.geometry.bbox_mm, a = THREE.MathUtils.degToRad(pl.rotation_deg);
      const [px, py, pz] = pl.position_mm;
      for (const [x, z] of [[0, 0], [w, 0], [0, d], [w, d]]) for (const y of [0, h])
        avoid.push([px + x * Math.cos(a) + z * Math.sin(a), py + y, pz - x * Math.sin(a) + z * Math.cos(a)]);
    }
  }
  return tags.length ? <ScreenTags tags={tags} comb={!!hoveredPart || view === "mcu"} avoid={avoid} /> : null;
}

export function StepTargets() {
  const { ir, profiles, holeIndex, activeStep } = useProject();
  const steps = useMemo(() => assemblySteps(ir, profiles), [ir, profiles]);
  const step = activeStep != null ? steps[activeStep] : null;
  if (!step) return null;
  const pts: { at: Vec3; label: string }[] = step.holes.flatMap((h) => {
    const p = holeIndex.get(h);
    // 電源軌用和步驟文字同一套短名（「A 側−軌·43 欄」），不要顯示內部代號 BOT-35；主區維持 E40（3D 上看得到排字母）
    return p ? [{ at: p.position_mm as Vec3, label: /^(TOP|BOT)/.test(h) ? holeShort(h, ir.physical.breadboard?.profile_id) : h }] : [];
  });
  if (step.kind === "wire") {
    const w = ir.physical.wires.find((x) => x.id === step.targetId);
    for (const e of w ? [w.from, w.to] : []) {
      if (e.kind !== "pin") continue;
      const p = endpointPosition(e, ir, profiles, holeIndex);
      if (p) pts.push({ at: p, label: `${boardOf(ir.logical.board.profile_id).short} ${e.pin.split(".")[1].replace(/^GND\d+$/, "GND")}` });
    }
  }
  return <>{pts.map((p) => <TargetRing key={p.label} {...p} />)}</>;
}

/** AR 這一步要插的元件：外面罩一個呼吸的黃色框，比塗孔位明顯得多（孔會被元件本體蓋住）。 */
function StepMarker({ size, center }: { size: [number, number, number]; center: [number, number, number] }) {
  const fill = useRef<THREE.MeshBasicMaterial>(null);
  const edge = useRef<THREE.LineBasicMaterial>(null);
  const box = useMemo(() => new THREE.BoxGeometry(...size), [size]);
  const edges = useMemo(() => new THREE.EdgesGeometry(box), [box]);
  useFrame(({ clock }) => {
    const k = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5);
    if (fill.current) fill.current.opacity = 0;
    if (edge.current) edge.current.opacity = 0.25 + 0.3 * k;
  });
  return (
    <group position={center}>
      <mesh geometry={box} renderOrder={5}>
        <meshBasicMaterial ref={fill} color="#ffd84a" transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <lineSegments geometry={edges} renderOrder={6}>
        <lineBasicMaterial ref={edge} color="#ffd84a" transparent toneMapped={false} />
      </lineSegments>
    </group>
  );
}

const BAND = ["#1a1a1a", "#8b4513", "#d93025", "#e8710a", "#f4c20d",
              "#2e9e4f", "#2a63c9", "#8a4fbd", "#9aa0a6", "#f5f5f5"];

/** 四環電阻色碼：兩位有效數字 + 乘數 + 誤差（金環 5%）。 */
function colorBands(ohm: number): string[] {
  const e = Math.max(0, Math.floor(Math.log10(Math.max(ohm, 1))) - 1);
  const sig = Math.round(ohm / 10 ** e);
  return [BAND[Math.floor(sig / 10) % 10], BAND[sig % 10], BAND[e % 10], "#c9a227"];
}

/** 依 profile 的 placeholder 畫出元件。有 GLB 之後這裡換成 useGLTF。 */
function Placeholder({ profile, params, fade = 1 }: {
  profile: ComponentProfile; params?: Record<string, number | string>; fade?: number;
}) {
  const ph = profile.geometry.placeholder;
  const [w, h, d] = profile.geometry.bbox_mm;
  const color = ph?.color ?? "#4b5563";

  // 有真模型就一律優先；程序化幾何只是載入中或缺模型時的備援
  const gltf = profile.geometry.desktop_model;
  const fallback = profile.component_id === "arduino_uno_r3"
    ? <ArduinoUno profile={profile} />
    : profile.category === "microcontroller_board"
      ? <ProceduralBoard profile={profile} fade={fade} />
      : <Procedural profile={profile} params={params} />;
  if (gltf) {
    return (
      <Suspense fallback={fallback}>
        <GltfPart url={`/${gltf}`} profile={profile} fade={fade} />
        {ph?.shape === "resistor" && <Bands ohm={Number(params?.resistance_ohm ?? 330)} />}
        {profile.component_id === "sg90_servo" && <ServoLead />}
        {profile.component_id === "arduino_mega2560" && <MegaSilk profile={profile} />}
        {profile.component_id === "arduino_nano" && <NanoSilk profile={profile} />}
      </Suspense>
    );
  }
  return fallback;
}

/** Mega 2560 的絲印：CAD 模型只有素板，沿用 UNO 的絲印產生器（同樣讀 profile 腳位座標）。PCB 頂面 y=2.0。 */
function MegaSilk({ profile }: { profile: ComponentProfile }) {
  const tex = useMemo(() => arduinoSilkTexture(profile, 101.6, 53.34,
    { model: "MEGA  2560", maxPinX: 90, analogX: 52, digitalX: 30, logoX: 24 }), [profile]);
  return (
    <mesh position={[50.8, 2.012, 26.67]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[101.6, 53.34]} />
      <meshPhysicalMaterial map={tex} roughness={0.55} clearcoat={0.22} clearcoatRoughness={0.4} />
    </mesh>
  );
}

/**
 * Nano 絲印：CAD 模型只有素板，依 profile 的腳位座標在每隻腳內側印上腳名，中間印板名。
 * 板子範圍＝模型外框（profile 座標，含 180° 旋轉與位移後的結果），貼在 PCB 頂面上方一點點避免閃爍。
 */
function NanoSilk({ profile }: { profile: ComponentProfile }) {
  const X0 = -7.3, X1 = 39.8, Z0 = -1.46, Z1 = 16.54, TOP = 4.02;
  const tex = useMemo(() => {
    const PX = 24, W = Math.round((X1 - X0) * PX), H = Math.round((Z1 - Z0) * PX);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1a4d78"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#e9eef2"; g.textAlign = "center"; g.textBaseline = "middle";
    const zs = [...new Set(profile.pins.map((p) => p.position_mm[2]))].sort((a, b) => a - b);
    g.font = `600 ${1.05 * PX}px "Helvetica Neue", Arial, sans-serif`;
    for (const p of profile.pins) {
      const [x, , z] = p.position_mm;
      const inward = z === zs[0] ? 2.0 : -2.0;
      // 腳位焊盤：鍍錫小方框
      g.strokeStyle = "#c9ccd1"; g.lineWidth = 0.18 * PX;
      g.strokeRect((x - X0 - 0.8) * PX, (z - Z0 - 0.8) * PX, 1.6 * PX, 1.6 * PX);
      g.save(); g.translate((x - X0) * PX, (z + inward - Z0) * PX); g.rotate(-Math.PI / 2);
      g.fillText(p.id.replace(/^GND\d*$/, "GND").replace(/^RESET\d*$/, "RST"), 0, 0); g.restore();
    }
    // 板名放在兩排腳名中間、晶片右側，不和任何腳名重疊
    g.font = `700 ${1.0 * PX}px "Helvetica Neue", Arial, sans-serif`;
    g.fillText("ARDUINO NANO", ((X1 - X0) / 2 + 14) * PX, (Z1 - Z0) / 2 * PX);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }, [profile]);
  return (
    <mesh position={[(X0 + X1) / 2, TOP, (Z0 + Z1) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[X1 - X0, Z1 - Z0]} />
      <meshPhysicalMaterial map={tex} roughness={0.6} clearcoat={0.2} clearcoatRoughness={0.4} />
    </mesh>
  );
}

/** SG90 的 3 芯排線（棕 GND／紅 VCC／橘 SIG）與 3 針杜邦母座：CAD 模型沒有線，這段依實物補上。 */
function ServoLead() {
  const wires = useMemo(() => ["#6b3a1e", "#c62828", "#f08a1c"].map((c, i) => {
    const x = i * 2.54;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, 14.5, 0), new THREE.Vector3(x, 18, -0.5),
      new THREE.Vector3(x * 0.4 + 1.5, 19, -1.8), new THREE.Vector3(x * 0.3 + 2.0, 17, -2.2),
    ]);
    return { c, g: new THREE.TubeGeometry(curve, 24, 0.55, 8, false) };
  }), []);
  return (
    <group>
      <mesh position={[2.54, 7.2, 0]} castShadow>
        <boxGeometry args={[7.62, 14.4, 2.54]} />
        <meshStandardMaterial color="#141416" roughness={0.6} />
      </mesh>
      {wires.map((w, i) => (
        <mesh key={i} geometry={w.g} castShadow>
          <meshStandardMaterial color={w.c} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

/** 疊在 KiCad 電阻模型本體上的色環（模型本體：x 1.93–8.23mm、半徑 1.25mm、中心高 1.25mm）。阻值看得出來。 */
function Bands({ ohm }: { ohm: number }) {
  return (
    <group>
      {colorBands(ohm).map((c, i) => (
        <mesh key={i} position={[5.08 + [-2.1, -1.25, -0.4, 1.9][i], 1.25, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[1.27, 1.27, 0.5, 24]} />
          <meshStandardMaterial color={c} roughness={0.42} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * GLB 載入中（或缺檔）時的開發板備援：程序生成 PCB＋排母／排針＋主晶片＋USB 座。
 * 外形由 profile 的腳位與 bbox 推出，所以腳位一定對得上；介面上標明「程序生成外形」。
 * 放旁邊的板子腳在排母頂端（y≈10）；插麵包板的板子腳在底面（y=0），本體墊高在排針上。
 */
function ProceduralBoard({ profile, fade = 1 }: { profile: ComponentProfile; fade?: number }) {
  const [w, , d] = profile.geometry.bbox_mm;
  const pins = profile.pins;
  const xs = pins.map((p) => p.position_mm[0]), zs = pins.map((p) => p.position_mm[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const beside = Math.max(...pins.map((p) => p.position_mm[1])) > 5;
  const pcbY = beside ? 1.0 : 3.6;             // PCB 中心高度
  const color = profile.geometry.placeholder?.color ?? "#1d5f8a";
  const mat = { transparent: fade < 1, opacity: fade, depthWrite: fade >= 1 };
  return (
    <group>
      <RoundedBox args={[w, 1.6, d]} radius={0.6} smoothness={2} position={[cx, pcbY, cz]} castShadow receiveShadow>
        <meshPhysicalMaterial {...mat} color={color} roughness={0.45} clearcoat={0.5} clearcoatRoughness={0.3} />
      </RoundedBox>
      {pins.map((p) => beside ? (
        // 排母：黑色塑膠塊，頂面對齊腳位高度
        <mesh key={p.id} position={[p.position_mm[0], 6.3, p.position_mm[2]]} castShadow>
          <boxGeometry args={[2.54, 7.4, 2.54]} />
          <meshStandardMaterial {...mat} color="#141416" roughness={0.6} />
        </mesh>
      ) : (
        // 排針：黑色塑膠座＋露出的金色針腳
        <group key={p.id} position={[p.position_mm[0], 0, p.position_mm[2]]}>
          <mesh position={[0, 1.6, 0]}><boxGeometry args={[2.54, 2.5, 2.54]} /><meshStandardMaterial {...mat} color="#141416" roughness={0.6} /></mesh>
          <mesh position={[0, 0.3, 0]}><boxGeometry args={[0.64, 0.8, 0.64]} /><meshStandardMaterial {...mat} color="#d8c27a" metalness={0.9} roughness={0.3} /></mesh>
        </group>
      ))}
      {/* 主晶片與 USB 座：讓人一眼認得是開發板 */}
      <mesh position={[cx + w * 0.05, pcbY + 1.3, cz]} castShadow>
        <boxGeometry args={[Math.min(14, w * 0.3), 1.2, Math.min(14, d * 0.45)]} />
        <meshStandardMaterial {...mat} color="#111214" roughness={0.4} />
      </mesh>
      <mesh position={[Math.min(...xs) - (beside ? -2 : 3), pcbY + 1.8, cz]} castShadow>
        <boxGeometry args={[beside ? 12 : 6, 3.4, beside ? 11 : 8]} />
        <meshStandardMaterial {...mat} color="#b9bdc4" metalness={0.85} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Procedural({ profile, params }: {
  profile: ComponentProfile; params?: Record<string, number | string>;
}) {
  // 從規格書新增的元件：依類別的參數化外形（PCB＋排針＋辨識特徵），不是純色方塊
  const ds = useMemo(() => (isDatasheetPart(profile) ? datasheetShape(profile) : null), [profile]);
  if (ds) return <primitive object={ds} />;
  const ph = profile.geometry.placeholder;
  const [w, h, d] = profile.geometry.bbox_mm;
  const color = ph?.color ?? "#4b5563";

  if (ph?.shape === "led") {
    return (
      <group>
        <mesh position={[1.27, 5.0, 0]} castShadow>
          <capsuleGeometry args={[2.5, 3.2, 8, 32]} />
          <meshPhysicalMaterial color={color} transmission={0.88} thickness={3.5} ior={1.55}
                                roughness={0.1} clearcoat={1} clearcoatRoughness={0.04}
                                attenuationColor={color} attenuationDistance={5}
                                emissive={color} emissiveIntensity={0} />
        </mesh>
        {/* 底部凸緣：5mm LED 的辨識特徵 */}
        <mesh position={[1.27, 1.35, 0]} castShadow>
          <cylinderGeometry args={[2.95, 2.95, 0.9, 32]} />
          <meshPhysicalMaterial color={color} transmission={0.7} roughness={0.25} />
        </mesh>
        {/* 腳位要插進板子裡，不是停在板面上 */}
        {[0, 2.54].map((x) => (
          <mesh key={x} position={[x, -0.4, 0]}>
            <cylinderGeometry args={[0.28, 0.28, 7.0, 8]} />
            <meshStandardMaterial color="#9aa0a6" metalness={0.85} roughness={0.25} />
          </mesh>
        ))}
      </group>
    );
  }
  if (ph?.shape === "resistor") {
    const ohm = Number(params?.resistance_ohm ?? 330);
    const bands = colorBands(ohm);
    return (
      <group>
        <mesh position={[w / 2, 3.6, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <capsuleGeometry args={[1.25, 4.0, 6, 24]} />
          <meshPhysicalMaterial color={color} roughness={0.38} clearcoat={0.4} />
        </mesh>
        {/* 色環：阻值直接畫在元件上，和 CircuitIR 的參數同一來源 */}
        {bands.map((c, i) => (
          <mesh key={i} position={[w / 2 + [-2.0, -1.0, 0.2, 1.6][i], 3.6, 0]}
                rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[1.3, 1.3, 0.55, 24]} />
            <meshStandardMaterial color={c} roughness={0.42} />
          </mesh>
        ))}
        {[0, w].map((x) => (
          <mesh key={x} position={[x, 0.2, 0]}>
            <cylinderGeometry args={[0.26, 0.26, 7.0, 8]} />
            <meshStandardMaterial color="#9aa0a6" metalness={0.85} roughness={0.25} />
          </mesh>
        ))}
      </group>
    );
  }
  // 直角盒子的稜線不吃光，讀起來就是樂高。倒角 0.5mm 是真實塑膠外殼的量級。
  return (
    <RoundedBox args={[w, h, d]} radius={Math.min(0.5, Math.min(w, h, d) / 3)} smoothness={3}
                position={[w / 2, h / 2, d / 2]} castShadow receiveShadow>
      <meshPhysicalMaterial color={color} roughness={0.58} clearcoat={0.18}
                            clearcoatRoughness={0.5} />
    </RoundedBox>
  );
}

/**
 * 統一處理淡化：走訪底下所有材質（程序幾何、色環、GLB 都一樣），設定透明度並強制重新編譯 shader
 * （three.js 的 transparent 改了不 needsUpdate 不會生效，這是上一版滑過時沒變透明的原因）。
 * 淡得很低時順便把顏色壓暗、關掉 clearcoat：白色外殼 18% 透明在暗背景上仍會發亮成一塊鬼影。
 */
function Faded({ fade, children }: { fade: number; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const cur = useRef(fade);
  const shown = useRef(-1);
  const BG = useMemo(() => new THREE.Color("#1c1d20"), []);
  // 半透明時先畫一次「只寫深度」的殼（在其他物件之後、自己之前），只留最外層那一面：
  // 不會看到格柵孔壁、背面這些內部的面疊成一團。金屬腳不參與，維持不透明、畫在最上層，才看得到插在哪。
  const depthMat = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true }), []);
  const apply = (f: number) => {
    const see = f < 0.45;
    // 幾乎看不見（組裝特寫時無關的開發板）：直接整個隱藏。半透明殼＋另外貼的絲印層淡不乾淨，反而像破圖
    if (g.current) g.current.visible = f >= 0.1;
    g.current?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.prepass) return;
      const mats0 = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshPhysicalMaterial[];
      const metal = mats0.every((x) => (x.metalness ?? 0) >= 0.5);
      if (!metal) {
        let pre = m.children.find((c) => c.userData.prepass) as THREE.Mesh | undefined;
        if (!pre && see) { pre = new THREE.Mesh(m.geometry, depthMat); pre.userData.prepass = true; pre.raycast = () => {}; m.add(pre); }
        if (pre) { pre.visible = see; pre.renderOrder = 1; }
        m.renderOrder = see ? 2 : 0;
      } else {
        // 金屬腳在外殼之後畫、照常做深度測試：板面以下（插進孔裡）的部分被麵包板擋住，不會穿出板底
        m.renderOrder = see ? 3 : 0;
      }
      if (metal && see) {
        for (const mat of mats0) { mat.transparent = false; mat.opacity = 1; mat.depthWrite = true; }
        m.castShadow = false;
        return;
      }
      m.castShadow = f >= 0.98 && m.userData.cast0 !== false;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshPhysicalMaterial[]) {
        const ud = mat.userData;
        if (ud.c0 === undefined && mat.color) { ud.c0 = mat.color.getHex(); ud.cc0 = mat.clearcoat ?? 0; ud.t0 = mat.transparent; ud.o0 = mat.opacity; }
        // 0.45 以上：不透明，顏色往背景混 —— 退到背景但外形完整；以下才真的半透明（看得到裡面的腳）
        const want = see || !!ud.t0;
        const op = see ? f : (ud.o0 ?? 1);
        if (ud.s0 === undefined) ud.s0 = mat.side;
        const side = see ? THREE.FrontSide : ud.s0;
        if (mat.transparent !== want || mat.side !== side) { mat.transparent = want; mat.side = side; mat.needsUpdate = true; }
        mat.opacity = op; mat.depthWrite = !see;
        if (ud.c0 !== undefined && mat.color) {
          mat.color.setHex(ud.c0);
          if (!see) mat.color.lerp(BG, (1 - f) * 0.85);
          else if (f < 0.2) mat.color.multiplyScalar(0.6);
          if ("clearcoat" in mat) mat.clearcoat = f < 0.98 ? 0 : ud.cc0;
        }
      }
    });
  };
  useEffect(() => { shown.current = -1; });   // 子元件換材質（GLB 載入）後重新套用
  useFrame((_, dt) => {
    cur.current += (fade - cur.current) * (1 - Math.exp(-dt * 14));
    if (Math.abs(cur.current - fade) < 0.004) cur.current = fade;
    if (Math.abs(cur.current - shown.current) > 0.003) { apply(cur.current); shown.current = cur.current; }
  });
  return <group ref={g}>{children}</group>;
}

// 滑過元件要停一下才生效；移到別的元件直接換過去，不先閃回全亮
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function hoverSoon(id: string | null, ms: number, leaving?: string) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const s = useProject.getState();
    if (id === null && leaving && s.hoveredPart !== leaving) return;
    s.setHoveredPart(id);
  }, ms);
}
/** 組裝中點元件：點到這一步的元件＝完成這步、到下一步；點到其他步驟的元件＝跳到那一步。不離開組裝流程。 */
function stepClick(id: string) {
  const s = useProject.getState();
  const steps = assemblySteps(s.ir, s.profiles);
  const st = steps.find((x) => x.targetId === id);
  if (!st || s.activeStep == null) return;
  if (st.index === s.activeStep) { s.markDone(st.index); s.setActiveStep(Math.min(steps.length - 1, st.index + 1)); }
  else s.setActiveStep(st.index);
}
/** 點元件：打開電氣面板並鎖定它的第一條訊號網路（沒有就鎖電源／地） */
function openPartNet(id: string) {
  const s = useProject.getState();
  const nets = s.ir.logical.nets.filter((n) => n.pins.some((p) => p.startsWith(`${id}.`)));
  const net = nets.find((n) => n.role === "signal") ?? nets[0];
  if (!net) return;
  if (s.openCard !== "elec") s.setOpenCard("elec");
  s.pinNet(net.id);
}

export function Parts() {
  const { ir, profiles, activeStep, done, view, screen, hoveredPart, setHoveredPart, selectedNet, issues } = useProject();
  const badParts = new Set(issues.filter((i) => i.severity === "error" && !i.net_id).flatMap((i) => (i.pins ?? []).map((p) => p.split(".")[0])));
  const steps = useMemo(() => assemblySteps(ir, profiles), [ir, profiles]);
  const all = [
    { id: ir.logical.board.instance_id, profile_id: ir.logical.board.profile_id },
    ...ir.logical.components.map((c) => ({ id: c.id, profile_id: c.profile_id })),
  ];

  // 淡化：開發板視角時板上元件退成背景；組裝「插元件」步驟時開發板退成背景（不和這一步搶注意力）
  const isBoard = (id: string) => id === ir.logical.board.instance_id;
  // 選到網路時：網路裡最高的那顆元件（高於 15mm，例如 DHT22）會擋住同一網路其他元件的腳，讓它半透明
  const tallMember = useMemo(() => {
    const net = selectedNet ? ir.logical.nets.find((n) => n.id === selectedNet) : null;
    if (!net) return null;
    const ids = [...new Set(net.pins.map((p) => p.split(".")[0]))].filter((i) => i !== ir.logical.board.instance_id);
    const tall = ids.map((i) => ({ i, h: profiles.get(ir.logical.components.find((c) => c.id === i)?.profile_id ?? "")?.geometry.bbox_mm[1] ?? 0 }))
      .filter((x) => x.h > 15).sort((a, b) => b.h - a.h)[0];
    return tall && ids.length > 1 ? tall.i : null;
  }, [ir, profiles, selectedNet]);
  const cur = activeStep != null ? steps[activeStep] : null;
  // 只有正在設計的就是「這個」專案時，零件才用設計中的半透明預覽（在背景設計別的專案時不影響這裡）
  const curId = useProject((x) => x.ir.project_id);
  const aiRunning = useAiJob((j) => j.running && j.jobProjectId === curId);
  const fadeOf = (id: string) => {
    if (screen !== "project") return 1;
    // AI 設計中先擺出來的元件是預覽（還沒通過電氣檢查）：半透明，和完成的電路分得出來
    if (aiRunning && !isBoard(id)) return 0.4;
    if (hoveredPart === id && activeStep == null) return 0.28;   // 滑過的元件變半透明，看得到裡面的腳
    // 使用者要求：一次只有滑過的那一個元件半透明，其他元件維持原樣（不跟著淡）
    if (hoveredPart && activeStep == null) return 1;
    if (selectedNet && activeStep == null && view !== "mcu" && id === tallMember) return 0.28;   // 其他元件退一步，焦點留在滑過的那顆
    if (view === "mcu" && activeStep == null && !isBoard(id)) return 0.18;
    if (cur?.kind === "place" && isBoard(id)) return 0.08;
    if (activeStep != null && stepState(steps, activeStep, id, done) === "pending") return 0.35;
    return 1;
  };
  return (
    <>
      {all.map(({ id, profile_id }) => {
        const prof = profiles.get(profile_id);
        const pl = ir.physical.placements.find((p) => p.instance_id === id);
        if (!prof || !pl) return null;

        // 插在麵包板上的元件，位置由「第一根腳插在哪個孔」決定，不是自由擺放
        const holeIndex = useProject.getState().holeIndex;
        // 減掉那隻腳在元件座標裡的位置（依旋轉轉過），第一隻腳不在原點的元件（Nano、ESP32）才不會整塊偏掉
        const [firstPin, firstHole] = Object.entries(pl.pin_to_hole)[0] ?? [];
        const anchor = firstHole ? holeIndex.get(firstHole) : undefined;
        const fp = prof.pins.find((q) => q.id === firstPin)?.position_mm ?? [0, 0, 0];
        const ry = THREE.MathUtils.degToRad(pl.rotation_deg);
        const pos: [number, number, number] = anchor
          ? [anchor.position_mm[0] - (fp[0] * Math.cos(ry) + fp[2] * Math.sin(ry)),
             anchor.position_mm[1] - fp[1],
             anchor.position_mm[2] - (-fp[0] * Math.sin(ry) + fp[2] * Math.cos(ry))]
          : (pl.position_mm as [number, number, number]);

        const st = activeStep != null ? stepState(steps, activeStep, id, done) : null;
        if (st === "later") return null;
        const [bw, bh, bd] = prof.geometry.bbox_mm;
        return (
          <group key={id} position={pos} rotation={[0, THREE.MathUtils.degToRad(pl.rotation_deg), 0]}
                 onPointerOver={screen === "project" ? (e) => { e.stopPropagation(); if (activeStep == null && !useEditJob.getState().on) hoverSoon(id, isBoard(id) ? 250 : 110); document.body.style.cursor = "pointer"; } : undefined}
                 onPointerOut={screen === "project" ? (e) => { e.stopPropagation(); if (!useEditJob.getState().on) hoverSoon(null, 80, id); document.body.style.cursor = ""; } : undefined}
                 onClick={screen === "project" ? (e) => {
                   e.stopPropagation();
                   // 手動調整模式：點零件就選它（等著點孔的時候不搶點擊）
                   const ej = useEditJob.getState();
                   if (ej.on) { if (!ej.pickHole) ej.select({ kind: "part", id }); return; }
                   activeStep == null ? openPartNet(id) : stepClick(id);
                 } : undefined}>
            <Faded fade={fadeOf(id)}>
              <Placeholder profile={prof} params={ir.logical.components.find((c) => c.id === id)?.parameters}
                           fade={fadeOf(id)} />
            </Faded>
            {/* 元件類錯誤（重疊、沒接線）：頂上一顆紅點，對應電氣面板的錯誤列 */}
            {badParts.has(id) && screen === "project" && !aiRunning && (() => {
              const ps = prof.pins.map((q) => q.position_mm);
              const cx = ps.reduce((a, q) => a + q[0], 0) / Math.max(1, ps.length), cz = ps.reduce((a, q) => a + q[2], 0) / Math.max(1, ps.length);
              // 固定螢幕大小的錯誤點（不隨鏡頭遠近變成大紅球）；被模型擋住時 drei 會淡化
              return (
                <Html position={[cx, bh + 3, cz]} center occlude={false} zIndexRange={[8, 2]} style={{ pointerEvents: "none" }}>
                  <span className="issue-dot" title="這個元件有錯誤，見電氣驗證" />
                </Html>
              );
            })()}
            {st === "now" && (
              <>
                <FocusHere points={[[-14, 0, -10], [bw + 14, bh, bd + 10], [-14, 0, bd + 10], [bw + 14, 0, -10]]} />
              </>
            )}
          </group>
        );
      })}
    </>
  );
}
