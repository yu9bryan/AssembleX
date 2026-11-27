import { useMemo, useRef, useLayoutEffect } from "react";
import * as THREE from "three";
import { RoundedBox } from "@react-three/drei";
import { useEditJob } from "../stores/editJob";
import { useProject } from "../stores/projectStore";
import { assemblySteps, resolvePhysicalNets } from "@assemblex/circuit-schema";
import { bbSpecOf } from "../stores/projectStore";
import { breadboardSilkTexture, BOARD_BODY } from "./breadboardSilk";

/**
 * 麵包板。
 *
 * 重點不是外觀，是把「看不見的內部導通」畫出來：游標移到任何一個孔，
 * 同一個 tie group 的孔會整組亮起來 —— A5–E5 互通、F5–J5 是另一組、
 * 中央溝把上下隔開、電源軌中間斷開，全部直接變成看得到的東西。
 *
 * 幾何上有兩個地方一定要是「真的」，否則一眼就假：
 *   中央溝必須是凹槽（板體切成前後兩塊），不能是貼在表面的色帶；
 *   孔必須是內凹的錐井，不能是凸出板面的黑方塊。
 */

const GROOVE_W = 3.0;   // 7.62 是 E↔F 孔「中心距」，不是溝寬；用它會把 E、F 兩排孔切掉一半
const GROOVE_D = 3.4;        // 1.7 太淺，溝內會被主光打滿、沒有暗線
const BEVEL = 0.7;           // 板體倒角；直角稜線不吃光，是「紙板感」的來源

/** 孔的黑色井口：平貼在絲印上方一點點的方塊（斜面畫在絲印貼圖裡）。同時是 hover／步驟上色的載體。 */
const HOLE = (() => {
  const g = new THREE.PlaneGeometry(1.15, 1.15);
  g.rotateX(-Math.PI / 2);
  return g;
})();

const C_IDLE = new THREE.Color("#050506");
const C_TIE  = new THREE.Color("#0a84ff");
const C_USED = new THREE.Color("#0e0e10");   // 有插東西的孔被元件腳蓋住，不另外上色
const C_STEP = new THREE.Color("#ffd84a");
const C_NET  = new THREE.Color("#3fdc6e");

export function Breadboard() {
  const holes = useProject((s) => s.holes);
  const ir = useProject((s) => s.ir);
  const hovered = useProject((s) => s.hoveredHole);
  const activeStep = useProject((s) => s.activeStep);
  const profiles = useProject((s) => s.profiles);
  const setHovered = useProject((s) => s.setHoveredHole);
  // 開發板視角：麵包板從這個方向看是倒的，淡成背景，不和開發板搶
  const fadeView = useProject((s) => s.view === "mcu" && s.screen === "project");
  const fade = fadeView ? { transparent: true, opacity: 0.07, depthWrite: false } : { transparent: false, opacity: 1 };
  const mesh = useRef<THREE.InstancedMesh>(null);
  // 手動調整「選孔」時：整塊板面都能點，自動吸附到最近的孔（不必剛好點中孔）
  const picking = useEditJob((j) => j.on && j.pickHole);
  const hoveredPos = picking && hovered ? holes.find((h) => h.id === hovered)?.position_mm : null;

  const spec = bbSpecOf(useProject((s) => s.ir.physical.breadboard?.profile_id));
  const [W, H, D] = spec.size_mm;

  // 板體：用「斷面擠出」做成一整塊，中央溝是真的凹槽（之前用兩塊疊起來，側面看得到分層線；
  // 用一塊實心板＋貼一條暗帶，溝又是假的）。斷面＝矩形頂部中央挖掉 GROOVE_W × GROOVE_D
  const bodyGeom = useMemo(() => {
    const b = BEVEL, zl = (D - GROOVE_W) / 2, zr = (D + GROOVE_W) / 2;
    const s = new THREE.Shape();
    s.moveTo(b, b); s.lineTo(D - b, b); s.lineTo(D - b, H - b);
    s.lineTo(zr + b, H - b); s.lineTo(zr + b, H - GROOVE_D + b); s.lineTo(zl - b, H - GROOVE_D + b);
    s.lineTo(zl - b, H - b); s.lineTo(b, H - b); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: W - 2 * b, bevelEnabled: true, bevelThickness: b,
                                            bevelSize: b, bevelSegments: 3, curveSegments: 4 });
    // 斷面座標 (sx, sy) → 世界 (z, y)，擠出方向 → 世界 x
    g.rotateY(Math.PI / 2);
    g.translate(b, 0, D);
    g.computeVertexNormals();
    return g;
  }, [W, H, D]);

  // 絲印貼圖切成前後兩半，分別貼在溝兩側的板面上
  const [silkFront, silkBack] = useMemo(() => {
    const base = breadboardSilkTexture(spec);
    const half = (D - GROOVE_W) / 2;
    const frac = half / D;
    const front = base.clone();            // z ∈ [0, half]
    front.needsUpdate = true;
    front.repeat.set(1, frac);
    front.offset.set(0, 1 - frac);
    const back = base.clone();             // z ∈ [D-half, D]
    back.needsUpdate = true;
    back.repeat.set(1, frac);
    back.offset.set(0, 0);
    return [front, back];
  }, [D, spec]);

  const used = useMemo(() => {
    const s = new Set<string>();
    for (const p of ir.physical.placements) Object.values(p.pin_to_hole).forEach((h) => s.add(h));
    for (const w of ir.physical.wires) {
      if (w.from.kind === "hole") s.add(w.from.hole);
      if (w.to.kind === "hole") s.add(w.to.hole);
    }
    return s;
  }, [ir]);

  // AR 組裝選中的步驟：這一步要插的孔整組亮起來
  const stepHoles = useMemo(() => {
    if (activeStep == null) return new Set<string>();
    const s = assemblySteps(ir, profiles)[activeStep];
    return new Set(s?.holes ?? []);
  }, [activeStep, ir, profiles]);

  // 電氣驗證選中的網路：實體上導通的孔（含整條 tie group）全部亮起來，看得出「這幾隻腳真的通」
  const selectedNet = useProject((s) => s.selectedNet);
  const netHoles = useMemo(() => {
    if (!selectedNet) return new Set<string>();
    const pins = new Set(ir.logical.nets.find((n) => n.id === selectedNet)?.pins ?? []);
    const phys = resolvePhysicalNets(ir, holes).find((n) => n.pins.some((p) => pins.has(p)));
    return new Set(phys?.holes ?? []);
  }, [selectedNet, ir, holes]);

  const hoveredGroup = useMemo(
    () => holes.find((h) => h.id === hovered)?.tie_group ?? null,
    [holes, hovered],
  );

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const dummy = new THREE.Object3D();
    holes.forEach((h, i) => {
      dummy.position.set(h.position_mm[0], h.position_mm[1] + 0.09, h.position_mm[2]);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, stepHoles.has(h.id) ? C_STEP
                    : netHoles.has(h.id) ? C_NET
                    : hoveredGroup && h.tie_group === hoveredGroup ? C_TIE
                    : used.has(h.id) ? C_USED : C_IDLE);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [holes, hoveredGroup, used, stepHoles, netHoles, fadeView]);

  const half = (D - GROOVE_W) / 2;
  const bands: Array<[number, number, THREE.Texture]> = [
    [0, half, silkFront],
    [D - half, D, silkBack],
  ];

  // 切換淡化時整組重建，讓材質的 transparent 設定真的生效
  return (
    <group key={fadeView ? "fade" : "solid"}>
      {/* 板體：一體成型的一整塊（之前底座＋兩條板條疊起來，側面看得到分層線） */}
      <mesh geometry={bodyGeom} castShadow receiveShadow>
        <meshPhysicalMaterial {...fade} color={BOARD_BODY} roughness={0.55} clearcoat={0.35}
                              clearcoatRoughness={0.3} envMapIntensity={0.6} />
      </mesh>

      {/* 板面絲印：列標 A–J、欄號、電源軌 +/− 與紅藍線 */}
      {bands.map(([z0, z1, tex], i) => (
        <mesh key={i} position={[W / 2, H + 0.05, (z0 + z1) / 2]}
              rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[W, z1 - z0]} />
          <meshPhysicalMaterial {...fade} map={tex} roughness={0.46}
                                clearcoat={0.12} clearcoatRoughness={0.35} envMapIntensity={0.2} />
        </mesh>
      ))}

      {/* 中央溝底：比槽壁再暗一階，從上往下看是一條真的暗縫 */}
      <mesh position={[W / 2, H - GROOVE_D + 0.05, D / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[W - BEVEL * 4, GROOVE_W - 0.4]} />
        <meshBasicMaterial {...fade} color="#050506" />
      </mesh>

      {picking && (
        <mesh position={[W / 2, H + 0.6, D / 2]} rotation={[-Math.PI / 2, 0, 0]}
              onPointerMove={(e) => {
                e.stopPropagation();
                const p = e.object.parent!.worldToLocal(e.point.clone());
                let best: string | null = null, bd = Infinity;
                for (const h of holes) {
                  const d = (h.position_mm[0] - p.x) ** 2 + (h.position_mm[2] - p.z) ** 2;
                  if (d < bd) { bd = d; best = h.id; }
                }
                setHovered(bd < 36 ? best : null);   // 6mm 內才算
              }}
              onPointerOut={() => setHovered(null)}>
          <planeGeometry args={[W, D]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {/* 選孔時：游標下會吸附到的那個孔畫一圈亮環 */}
      {hoveredPos && (
        <mesh position={[hoveredPos[0], hoveredPos[1] + 0.7, hoveredPos[2]]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.0, 1.6, 24]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
      )}
      {/* 830 個內凹錐井，單一 InstancedMesh */}
      <instancedMesh
        ref={mesh}
        args={[HOLE, undefined as never, holes.length]}
        onPointerMove={(e) => {
          e.stopPropagation();
          if (e.instanceId != null) setHovered(holes[e.instanceId].id);
        }}
        onPointerOut={() => setHovered(null)}
      >
        <meshStandardMaterial {...fade} roughness={0.95} polygonOffset polygonOffsetFactor={-2} />
      </instancedMesh>
    </group>
  );
}
