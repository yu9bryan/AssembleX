import { holeLabel } from "@assemblex/circuit-schema";
import { useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, SoftShadows, Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { Breadboard } from "./engine3d/Breadboard";
import { Parts, Wires, StepTargets, PinTags, HoverLegs } from "./engine3d/Parts";
import { Stage } from "./engine3d/Stage";
import { cameraApi } from "./spatial/layout";
import { CameraRig } from "./spatial/CameraRig";
import { FOV } from "./spatial/layout";
import { Home } from "./ui/Home";
import { Workspace as WorkspaceUI } from "./ui/Workspace";
import { Callouts } from "./engine3d/Callouts";
import { useProject } from "./stores/projectStore";
import { bbSpecOf } from "./stores/projectStore";

const MM = 0.01;

/** 工作台：所有實體都在這一層，單位 mm，整組縮放到世界尺度並以麵包板置中。 */
/** 柔邊接觸陰影：一張徑向漸層的暗面貼在物體正下方（不動光源），讓板子「落地」、看得出前後 */
const shadowTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,0.8)"); grd.addColorStop(0.65, "rgba(0,0,0,0.45)"); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
function SoftShadow({ x, z, w, d, rot = 0 }: { x: number; z: number; w: number; d: number; rot?: number }) {
  return (
    <mesh position={[x, 0.15, z]} rotation={[-Math.PI / 2, 0, rot]} renderOrder={-1}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial map={shadowTex} transparent depthWrite={false} />
    </mesh>
  );
}
function BoardShadows() {
  const { ir, profiles } = useProject();
  const [BW, , BD] = bbSpecOf(ir.physical.breadboard?.profile_id).size_mm;
  const pl = ir.physical.placements.find((p) => p.instance_id === ir.logical.board.instance_id);
  const prof = profiles.get(ir.logical.board.profile_id);
  const beside = pl && !Object.keys(pl.pin_to_hole).length && prof;
  let mcu = null;
  if (beside) {
    const [w, , d] = prof!.geometry.bbox_mm, ry = (pl!.rotation_deg * Math.PI) / 180;
    // profile 原點在板角：中心＝原點＋旋轉後的 (w/2, d/2)
    const cx = pl!.position_mm[0] + (w / 2) * Math.cos(ry) + (d / 2) * Math.sin(ry);
    const cz = pl!.position_mm[2] - (w / 2) * Math.sin(ry) + (d / 2) * Math.cos(ry);
    mcu = <SoftShadow x={cx} z={cz} w={w * 1.25} d={d * 1.3} rot={ry} />;
  }
  return <>{<SoftShadow x={BW / 2} z={BD / 2} w={BW * 1.12} d={BD * 1.25} />}{mcu}</>;
}

function Workspace() {
  const bb = useProject((s) => s.ir.physical.breadboard?.profile_id);
  const [BW, , BD] = bbSpecOf(bb).size_mm;
  return (
    <group scale={MM} position={[-(BW * MM) / 2, 0, -(BD * MM) / 2]}>
      <BoardShadows />
      <Breadboard />
      <Parts />
      <Wires />
      <StepTargets />
      <PinTags />
      <HoverLegs />
      <Callouts />
    </group>
  );
}

function HoleReadout() {
  const hovered = useProject((s) => s.hoveredHole);
  const holes = useProject((s) => s.holes);
  const h = holes.find((x) => x.id === hovered);
  const bbId = useProject((s) => s.ir.physical.breadboard?.profile_id);
  if (!h) return null;
  return (
    <div className="readout card">
      <span style={{ fontWeight: "var(--w-semi)" }}>{h.kind === "main" ? `${h.row} 排 ${h.column} 欄` : holeLabel(h.id, bbId)}</span>
      {/* 用看得懂的說法講「和哪些孔是通的」，不顯示座標與內部群組代號 */}
      <span className="label">{h.kind === "main"
        ? `和同一欄的 ${"ABCDE".includes(h.row ?? "") ? "A–E" : "F–J"} 排是通的`
        : "整條電源軌是通的（亮起來的孔）"}</span>
    </div>
  );
}

export default function App() {
  const setView = useProject((s) => s.setView);
  const screen = useProject((s) => s.screen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key !== "Escape") return;
      const st = useProject.getState();
      if (st.activeStep != null) st.setActiveStep(null);
      else if (st.openCard) st.setOpenCard(st.openCard);
      else setView("overview");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <>
      <Canvas
        className="scene"
        shadows
        camera={{ position: [0, 1.2, 2.6], fov: FOV }}
        dpr={[1, 2]}
        onDoubleClick={() => cameraApi.recenter()}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.85 }}
      >
        <SoftShadows size={12} focus={0.4} samples={16} />
        <hemisphereLight args={["#d8d8dc", "#0a0a0b", 0.25]} />
        {/* 主光在主體後方、不和相機同側，立面才有明暗、影子才看得到 */}
        <directionalLight
          position={[0.6, 3.2, 0.9]} intensity={2.4} color="#fff4e4" castShadow
          shadow-mapSize={[4096, 4096]}
          shadow-camera-left={-1.05} shadow-camera-right={1.05}
          shadow-camera-top={1.05} shadow-camera-bottom={-1.05}
          shadow-camera-near={0.5} shadow-camera-far={8}
          shadow-bias={-0.0004} shadow-normalBias={0.002}
        />
        <directionalLight position={[-1.9, 0.75, 2.6]} intensity={0.7} color="#d0d6e0" />
        {/* 冷色輪廓光：藍色只出現在物件邊緣，像參考圖那樣 */}
        <directionalLight position={[-0.6, 1.0, -2.4]} intensity={0.7} color="#8fb8ff" />

        {/* 程序化環境貼圖，不抓外部 HDR，App 要能完全離線 */}
        <Environment resolution={512} frames={1}>
          <color attach="background" args={["#0a0a0b"]} />
          <Lightformer form="rect" intensity={4} position={[1.5, 2.3, 1.1]}
                       scale={[0.9, 4.5, 1]} rotation-y={-0.55} color="#ffffff" />
          <Lightformer form="rect" intensity={6} position={[-0.6, 1.05, -2.6]}
                       scale={[5, 0.6, 1]} rotation-x={0.25} color="#ffffff" />
          <Lightformer intensity={1.2} position={[0, 3, 1]} scale={[8, 3, 1]} color="#e8e8e8" />
          <Lightformer intensity={1.1} position={[-4, 1.5, 1]} scale={[3, 4, 1]}
                       rotation-y={Math.PI / 2.6} color="#e8e8e8" />
        </Environment>

        <Stage />
        <ContactShadows position={[0, 0.0015, -0.2]} opacity={0.85} color="#000000"
                        scale={6} blur={1.6} far={0.04} resolution={2048} />
        <Workspace />
        <CameraRig />
      </Canvas>

      {screen === "home" ? <Home /> : <WorkspaceUI />}
      {screen === "project" && <HoleReadout />}
    </>
  );
}
