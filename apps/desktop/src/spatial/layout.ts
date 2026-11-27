import * as THREE from "three";
import type { ViewId, Screen } from "../stores/projectStore";
import { type CircuitIR, type BreadboardHole } from "@assemblex/circuit-schema";
import { bbSpecOf, useProject } from "../stores/projectStore";

/**
 * 總覽要框的是「有東西的地方」：用到的孔＋外擴 3 孔、元件高度、開發板。
 * 框整塊麵包板的話，右下四成畫面只剩空孔陣，主角被擠到角落。
 */
export function usedPoints(ir: CircuitIR, holeIndex: Map<string, BreadboardHole>): [number, number, number][] {
  const MM = 0.01, [BW, , BD] = bbSpecOf(ir.physical.breadboard?.profile_id).size_mm;
  const ids = [...ir.physical.placements.flatMap((p) => Object.values(p.pin_to_hole)),
               ...ir.physical.wires.flatMap((w) => [w.from, w.to]).flatMap((e) => e.kind === "hole" ? [e.hole] : [])];
  const pts = ids.map((h) => holeIndex.get(h)?.position_mm).filter((p): p is [number, number, number] => !!p);
  if (pts.length < 2) return [];
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  const pad = 3 * 2.54;
  const x0 = Math.max(0, Math.min(...xs) - pad), x1 = Math.min(BW, Math.max(...xs) + pad);
  const z0 = Math.max(0, Math.min(...zs) - pad), z1 = Math.min(BD, Math.max(...zs) + pad);
  const w = (x: number, y: number, z: number): [number, number, number] => [x * MM - (BW * MM) / 2, y * MM, z * MM - (BD * MM) / 2];
  // 外接在麵包板旁邊的元件（排線接頭）也要框進來，不然它會被切在畫面外
  const profiles = useProject.getState().profiles;
  const ext = ir.physical.placements.filter((p) => p.instance_id !== ir.logical.board.instance_id && !Object.keys(p.pin_to_hole).length)
    .flatMap((p) => {
      const pid = ir.logical.components.find((c) => c.id === p.instance_id)?.profile_id;
      const [bw, bh, bd] = (pid && profiles.get(pid)?.geometry.bbox_mm) || [30, 20, 30];
      return [w(p.position_mm[0], 0, p.position_mm[2]), w(p.position_mm[0] + bw, bh, p.position_mm[2] + bd)];
    });
  return [w(x0, 0, z0), w(x1, 0, z0), w(x0, 0, z1), w(x1, 0, z1), w(x0, 26, z0), w(x1, 26, z1), ...ext];
}

/** 開發板要框的範圍：插在麵包板上的（Nano、ESP32）用它實際佔的孔；放在旁邊的（UNO、Mega）用固定位置 MCU。 */
export function boardPoints(ir: CircuitIR, holeIndex: Map<string, BreadboardHole>): [number, number, number][] | null {
  const MM = 0.01, [BW, , BD] = bbSpecOf(ir.physical.breadboard?.profile_id).size_mm;
  const pl = ir.physical.placements.find((p) => p.instance_id === ir.logical.board.instance_id);
  const pts = Object.values(pl?.pin_to_hole ?? {}).map((h) => holeIndex.get(h)?.position_mm).filter((p): p is [number, number, number] => !!p);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  const x0 = Math.min(...xs) - 8, x1 = Math.max(...xs) + 8, z0 = Math.min(...zs) - 3, z1 = Math.max(...zs) + 3;
  const w = (x: number, y: number, z: number): [number, number, number] => [x * MM - (BW * MM) / 2, y * MM, z * MM - (BD * MM) / 2];
  return [w(x0, 0, z0), w(x1, 0, z0), w(x0, 0, z1), w(x1, 0, z1), w(x0, 18, z0), w(x1, 18, z1)];
}

/**
 * 鏡頭取景：框的是「介面留下的空白區」，不是整個畫面。
 *  - camera.setViewOffset 把投影中心移到空白區中央
 *  - 求解距離時只允許內容落在空白區內，並做水平＋垂直置中修正
 * 留白依畫面而不同：主畫面左邊是專案列表；工作台上方是標題、下方是儀表板。
 */
export const FOV = 34;

export interface Chrome { left: number; right: number; top: number; bottom: number; }
export const CHROME: Record<Screen, Chrome> = {
  home:    { left: 452, right: 40, top: 40,  bottom: 40 },
  project: { left: 96,  right: 40, top: 208, bottom: 216 },  // top 讓過兩行標題，物件不鑽到字後面
};
/** 右側詳細面板展開時，空白區右邊要再讓出面板寬度 */
export const DETAIL_W = 440;
export function chromeFor(screen: Screen, panelOpen: boolean): Chrome {
  const c = CHROME[screen];
  return screen === "project" && panelOpen ? { ...c, right: c.right + DETAIL_W + 12 } : c;
}

/** 麵包板外框（世界座標，以板子中心為原點）：830 孔時和原本的常數相同 */
function boardBox(): [number, number, number][] {
  const [W, , D] = bbSpecOf(useProject.getState().ir.physical.breadboard?.profile_id).size_mm;
  const x = W * 0.005 + 0.004, z = D * 0.005 + 0.003;
  return [[-x, 0, -z], [x, 0, -z], [-x, 0, z], [x, 0, z], [-x, 0.26, -0.1], [x, 0.12, -0.1]];
}
const MCU: [number, number, number][] = [
  [-0.36, 0, -0.96], [0.36, 0, -0.96], [-0.36, 0.13, -0.4], [0.36, 0.13, -0.4],
];
/** 工作台實體的可移動範圍（平移時目標點不能離開它，否則工作台會被推到介面底下） */
export const TARGET_BOUNDS = new THREE.Box3(new THREE.Vector3(-0.95, 0, -1.05), new THREE.Vector3(0.95, 0.3, 0.4));

export interface CameraPose { position: THREE.Vector3; target: THREE.Vector3; distance: number; }
interface Frame { w: number; h: number; }

export function viewOffset(c: Chrome) {
  return { x: (c.right - c.left) / 2, y: (c.bottom - c.top) / 2 };
}

export function fitPose(
  points: [number, number, number][], azDeg: number, elDeg: number, f: Frame, c: Chrome, fit = 0.9,
): CameraPose {
  const P = points.map((p) => new THREE.Vector3(...p));
  const target = new THREE.Box3().setFromPoints(P).getCenter(new THREE.Vector3());
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const fx = Math.max(0.25, (f.w - c.left - c.right) / f.w);
  const fy = Math.max(0.25, (f.h - c.top - c.bottom) / f.h);
  const tv = Math.tan(THREE.MathUtils.degToRad(FOV) / 2), th = tv * (f.w / f.h);

  const project = (d: number) => {
    const cam = target.clone().addScaledVector(dir, d);
    const fwd = target.clone().sub(cam).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    return { right, up, ndc: P.map((p) => {
      const v = p.clone().sub(cam); const z = Math.max(1e-4, v.dot(fwd));
      return [v.dot(right) / (z * th), v.dot(up) / (z * tv), z] as const;
    }) };
  };
  const solve = () => {
    let lo = 0.3, hi = 14;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      const ok = project(mid).ndc.every(([x, y]) => Math.abs(x) <= fx * fit && Math.abs(y) <= fy * fit);
      if (ok) hi = mid; else lo = mid;
    }
    return hi;
  };
  // 水平＋垂直置中：透視會讓投影不對稱，用投影後的中點把目標點拉回來，迭代幾次收斂
  let d = solve();
  for (let k = 0; k < 4; k++) {
    const { right, up, ndc } = project(d);
    const xs = ndc.map(([x]) => x), ys = ndc.map(([, y]) => y);
    const zAvg = ndc.reduce((s, [, , z]) => s + z, 0) / ndc.length;
    target.addScaledVector(right, ((Math.min(...xs) + Math.max(...xs)) / 2) * zAvg * th);
    target.addScaledVector(up, ((Math.min(...ys) + Math.max(...ys)) / 2) * zAvg * tv);
    d = solve();
  }
  return { position: target.clone().addScaledVector(dir, d), target, distance: d };
}

const cache = new Map<string, CameraPose>();
export function poseFor(view: ViewId, screen: Screen, f: Frame, panelOpen = false, used: [number, number, number][] = [],
                        onBoard: [number, number, number][] | null = null): CameraPose {
  const key = `${screen}:${view}:${f.w}x${f.h}:${panelOpen}:${used.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(";")}:${useProject.getState().ir.physical.breadboard?.profile_id}:${onBoard ? onBoard.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(";") : "-"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = chromeFor(screen, panelOpen);
  // 板子插在麵包板上時，旁邊不會有開發板：不要替不存在的 UNO 留位置
  const side = onBoard ? [] : MCU;
  const pose =
    screen === "home"   ? fitPose([...boardBox(), ...side], 32, 30, f, c, 0.86)
    : view === "board"  ? fitPose([...boardBox(), ...side], 0, onBoard ? 76 : 58, f, c, 0.94)   // 插在板上的開發板：接近俯視，看得出腳插哪一排
    : view === "mcu"    ? fitPose(onBoard ?? MCU, onBoard ? 0 : 190, onBoard ? 62 : 70, f, c, 0.7)
    : used.length ? fitPose([...used, ...side], 32, 34, f, c, 0.78)   // 有電路：框用到的範圍＋開發板，四周留白
    : fitPose([...boardBox(), ...side], 32, 34, f, c, 0.92);                                         // 3/4 總覽
  cache.set(key, pose);
  return pose;
}

/** 讓 2D 介面（縮放按鈕）可以操作鏡頭，由 CameraRig 掛上實作。 */
export const cameraApi = {
  zoom: (_dir: 1 | -1) => {}, recenter: () => {},
  /** AR 步驟：把鏡頭拉近到這一步的目標（世界座標點） */
  focus: (_points: [number, number, number][]) => {},
  /** 最後一次 AR 聚焦的點：◎／雙擊在步驟模式下回到這裡，而不是退出步驟 */
  lastFocus: null as [number, number, number][] | null,
};
