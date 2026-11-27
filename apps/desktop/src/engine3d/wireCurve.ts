import * as THREE from "three";
import type { Vec3 } from "@assemblex/circuit-schema";

/**
 * 把佈線演算法給的折線變成管狀幾何。
 * 每個轉角換成一段二次貝茲（圓角半徑依兩側線段長度自動縮），
 * 像真的單芯線被手折出來的彎，不是尖角。
 */
/** 圓角前先整理折線：合併相距 < 3mm 的點（兩端保留）、刪掉幾乎共線的中間點 —— 否則相鄰兩個轉角會擠出一個小 S 彎 */
function tidy(pts: THREE.Vector3[]): THREE.Vector3[] {
  // 短跳線本來就只升 2mm 左右：用同樣的 3.5mm 門檻會把「往上」那個點吃掉，線就變成斜插的直棒
  const span0 = pts.length ? Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) : 0;
  const minGap = span0 < 14 ? 0.6 : 3.5;
  let P = pts.filter((p, i) => i === 0 || i === pts.length - 1 || p.distanceTo(pts[i - 1]) >= minGap);
  // 兩個轉角之間夾著一段很短（< 5mm）的橫移、前後兩段同方向（S 折）：拿掉中間那段的兩個點，直接接成一個轉角
  for (let i = 1; i + 2 < P.length - 1; i++) {
    const seg = P[i + 1].distanceTo(P[i]);
    const a = P[i].clone().sub(P[i - 1]).normalize(), c = P[i + 2].clone().sub(P[i + 1]).normalize();
    const jog = P[i + 1].clone().sub(P[i]).normalize();
    if (seg < 5 && a.dot(c) > 0.9 && Math.abs(a.dot(jog)) < 0.2) { const mid = new THREE.Vector3(P[i + 2].x, P[i].y, P[i + 2].z); if (Math.abs(P[i].y - P[i + 2].y) < 1) { P = [...P.slice(0, i), mid, ...P.slice(i + 3)]; } }
  }
  for (let changed = true; changed && P.length > 2;) {
    changed = false;
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i].clone().sub(P[i - 1]).normalize(), b = P[i + 1].clone().sub(P[i]).normalize();
      if (a.dot(b) > Math.cos((8 * Math.PI) / 180)) { P = [...P.slice(0, i), ...P.slice(i + 1)]; changed = true; break; }
    }
  }
  // 保險：兩端幾乎同高、還有水平距離，卻只剩一段斜線 → 補成貼板的 ㄇ 形
  const first = P[0], last = P[P.length - 1];
  const span = Math.hypot(first.x - last.x, first.z - last.z);
  if (P.length < 4 && span > 1 && Math.abs(first.y - last.y) < 1.5) {
    const up = Math.max(first.y, last.y) + Math.min(2.2, Math.max(1.4, span * 0.3)) - first.y;
    P = [first, first.clone().setY(first.y + up), last.clone().setY(first.y + up), last];
  }
  return P;
}

export function routedWireGeometry(points: Vec3[], radius = 0.8, bend = 4.5) {
  const P = tidy(points.map((p) => new THREE.Vector3(...p)));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cursor = P[0].clone();
  // 短跳線（兩端水平距離小）彎角要小：不然整條線變成和跨距一樣高的 ∩，看起來像立在板上的棒子
  const span = Math.hypot(P[0].x - P[P.length - 1].x, P[0].z - P[P.length - 1].z);
  const capR = span < 14 ? Math.max(0.9, Math.min(span * 0.4, 3)) : Infinity;

  for (let i = 1; i < P.length - 1; i++) {
    const prev = P[i - 1], cur = P[i], next = P[i + 1];
    const inLen = cur.distanceTo(prev), outLen = cur.distanceTo(next);
    // 長線段用大圓弧（手折單芯線的樣子），短線段維持小彎
    // 兩個相鄰轉角各用自己那段的一半，不會互相搶線段
    const r = Math.min(Math.max(bend, Math.min(inLen, outLen) * 0.3), Math.min(inLen, outLen) * 0.5, capR, 14);
    const a = cur.clone().addScaledVector(prev.clone().sub(cur).normalize(), r);
    const b = cur.clone().addScaledVector(next.clone().sub(cur).normalize(), r);
    if (cursor.distanceTo(a) > 1e-4) path.add(new THREE.LineCurve3(cursor.clone(), a));
    path.add(new THREE.QuadraticBezierCurve3(a, cur.clone(), b));
    cursor = b;
  }
  path.add(new THREE.LineCurve3(cursor, P[P.length - 1].clone()));

  const len = path.getLength();
  const seg = THREE.MathUtils.clamp(Math.round(len / 1.2), 24, 400);
  return new THREE.TubeGeometry(path, seg, radius, 12, false);
}
