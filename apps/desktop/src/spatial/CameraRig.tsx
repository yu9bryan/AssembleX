import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitImpl } from "three-stdlib";
import { poseFor, fitPose, viewOffset, chromeFor, TARGET_BOUNDS, cameraApi, usedPoints, boardPoints } from "./layout";
import { useProject } from "../stores/projectStore";

/**
 * 鏡頭：可以自由縮放、旋轉、平移，預設視角只是「起點」。
 *  - 按視角鈕 → 沿弧線飛過去（smootherstep），期間暫停手動操作；同一個鈕再按一次回正
 *  - 手動操作後標記 cameraDirty，按鈕顯示「可回正」，狀態不說謊
 *  - 平移時目標點被夾在工作台範圍內，工作台不會被推到介面底下；縮放上限依當前視角距離決定
 *  - 主畫面緩慢自轉，展示專案
 */
const DUR = 0.6;
const smootherstep = (t: number) => t * t * t * (t * (6 * t - 15) + 10);

export function CameraRig() {
  const { camera, size } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const controls = useRef<OrbitImpl>(null);
  const dragFrom = useRef<{ az: number; po: number; d: number } | null>(null);
  const view = useProject((s) => s.view);
  const nonce = useProject((s) => s.viewNonce);
  const screen = useProject((s) => s.screen);
  const setDirty = useProject((s) => s.setCameraDirty);
  const panelOpen = useProject((s) => s.openCard !== null);

  // 畫面中心讓開介面（面板、儀表卡）的偏移量：開關面板時平滑移過去，不是一幀跳過去
  const offTarget = useRef({ x: 0, y: 0 });
  const offCur = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    offTarget.current = viewOffset(chromeFor(screen, panelOpen));
    if (!offCur.current) offCur.current = { ...offTarget.current };   // 第一次直接就位
    cam.setViewOffset(size.width, size.height, offCur.current.x, offCur.current.y, size.width, size.height);
    cam.updateProjectionMatrix();
  }, [cam, size.width, size.height, screen, panelOpen]);
  useFrame((_, dt) => {
    const c = offCur.current, t = offTarget.current;
    if (!c || (c.x === t.x && c.y === t.y)) return;
    const k = 1 - Math.exp(-Math.min(dt, 0.05) * 9);   // 約 0.35 秒到位，先快後慢
    c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k;
    if (Math.abs(c.x - t.x) < 0.3) c.x = t.x;
    if (Math.abs(c.y - t.y) < 0.3) c.y = t.y;
    cam.setViewOffset(size.width, size.height, c.x, c.y, size.width, size.height);
    cam.updateProjectionMatrix();
  });

  const anim = useRef({
    t: 1, from: new THREE.Vector3(), fromT: new THREE.Vector3(),
    ctrl: new THREE.Vector3(), to: new THREE.Vector3(), toT: new THREE.Vector3(), dist: 2,
  });
  const started = useRef(false);

  const flyTo = (immediate = false, override?: ReturnType<typeof poseFor>) => {
    const c = controls.current;
    if (!c) return;
    const pose = override ?? poseFor(view, screen, { w: size.width, h: size.height }, panelOpen, usedPoints(useProject.getState().ir, useProject.getState().holeIndex), boardPoints(useProject.getState().ir, useProject.getState().holeIndex));
    const a = anim.current;
    a.dist = pose.distance;
    // 特寫（AR 步驟）時不能把縮放上限鎖在特寫距離：使用者要能拉遠看這一步在整塊板子上的位置
    const viewPose = poseFor(view, screen, { w: size.width, h: size.height }, panelOpen, usedPoints(useProject.getState().ir, useProject.getState().holeIndex), boardPoints(useProject.getState().ir, useProject.getState().holeIndex));
    c.maxDistance = Math.max(pose.distance, viewPose.distance) * 1.6;
    if (immediate) {
      camera.position.copy(pose.position); c.target.copy(pose.target); c.update(); return;
    }
    a.from.copy(camera.position); a.fromT.copy(c.target);
    a.to.copy(pose.position); a.toT.copy(pose.target);
    const mid = a.from.clone().lerp(a.to, 0.5);
    a.ctrl.copy(mid).addScaledVector(mid.clone().sub(a.toT).normalize(), 0.2);
    a.t = 0;
    c.enabled = false;
  };

  // 只有「切視角／切畫面／再按一次」才飛；改視窗大小不要把使用者調好的鏡頭丟掉
  useEffect(() => {
    if (!controls.current) return;
    if (!started.current) { flyTo(true); started.current = true; return; }
    flyTo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, nonce, screen]);

  // 開關面板：使用者自己調過鏡頭就保留（畫面中心已由 viewOffset 讓開面板），沒調過才重新取景
  useEffect(() => {
    if (!controls.current || !started.current) return;
    const st = useProject.getState();
    if (!st.cameraDirty && st.activeStep == null) flyTo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  useEffect(() => {
    cameraApi.zoom = (dir) => {
      const c = controls.current; if (!c) return;
      const off = camera.position.clone().sub(c.target).multiplyScalar(dir > 0 ? 0.8 : 1.25);
      const len = THREE.MathUtils.clamp(off.length(), c.minDistance, c.maxDistance);
      camera.position.copy(c.target).add(off.setLength(len));
      c.update(); setDirty(true);
    };
    cameraApi.recenter = () => {
      const st = useProject.getState();
      if (st.activeStep != null && cameraApi.lastFocus) cameraApi.focus(cameraApi.lastFocus);
      else st.setView(st.view);
    };
    // 拉近到 AR 步驟的目標：保留一點周圍（fit 0.42），看得出它插在板子的哪裡
    cameraApi.focus = (pts) => {
      cameraApi.lastFocus = pts;
      setDirty(false);
      const st = useProject.getState();
      // 斜 68° 還看得出腳插進孔的方向，又能把後方墊高的開發板推出畫面頂端，不搶這一步的焦點
      // 目標點太集中（短線、一顆小元件）會拉得太近：至少框住約 20mm × 20mm，看得到旁邊的欄號與排字母
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2, y = pts[0]?.[1] ?? 0;
      const padded: [number, number, number][] = [...pts, [cx - 10, y, cz - 10], [cx + 10, y, cz + 10]];
      const pose = fitPose(padded, 0, 68, { w: size.width, h: size.height },
                           chromeFor(st.screen, st.openCard !== null), 0.48);
      flyTo(false, pose);
    };
  });

  // 離開 AR 步驟（看完整電路）→ 回到目前視角
  const activeStep = useProject((s) => s.activeStep);
  const hadStep = useRef(false);
  useEffect(() => {
    if (activeStep == null && hadStep.current) flyTo();
    hadStep.current = activeStep != null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep]);

  useFrame((_, dt) => {
    const c = controls.current;
    const a = anim.current;
    if (!c) return;
    if (a.t < 1) {
      a.t = Math.min(1, a.t + dt / DUR);
      const e = smootherstep(a.t);
      camera.position.copy(a.from.clone().lerp(a.ctrl, e).lerp(a.ctrl.clone().lerp(a.to, e), e));
      c.target.copy(a.fromT).lerp(a.toT, e);
      c.update();
      if (a.t >= 1) c.enabled = true;
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping dampingFactor={0.08}
      zoomToCursor zoomSpeed={0.9}
      screenSpacePanning panSpeed={0.8}
      rotateSpeed={0.6}
      minDistance={0.3}
      maxPolarAngle={Math.PI * 0.42}
      autoRotate={screen === "home"} autoRotateSpeed={0.5}
      onStart={() => { dragFrom.current = { az: controls.current?.getAzimuthalAngle?.() ?? 0, po: controls.current?.getPolarAngle?.() ?? 0, d: controls.current?.getDistance?.() ?? 0 }; }}
      onEnd={() => {
        const c = controls.current, f = dragFrom.current;
        if (!c || !f || anim.current.t < 1 || screen !== "project") return;
        const moved = Math.abs(c.getAzimuthalAngle() - f.az) + Math.abs(c.getPolarAngle() - f.po) > 0.01 || Math.abs(c.getDistance() - f.d) > f.d * 0.01;
        if (moved) setDirty(true);
      }}
      onChange={() => {
        // 平移邊界：目標點夾在工作台範圍內，相機跟著同樣位移，不然視角會被拉歪
        const c = controls.current; if (!c) return;
        const clamped = c.target.clone().clamp(TARGET_BOUNDS.min, TARGET_BOUNDS.max);
        if (!clamped.equals(c.target)) {
          camera.position.add(clamped.clone().sub(c.target));
          c.target.copy(clamped);
        }
      }}
    />
  );
}
