import { useMemo } from "react";
import * as THREE from "three";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { arduinoSilkTexture } from "./arduinoSilk";

/**
 * Arduino UNO R3 的程序化模型（單位 mm，原點＝PCB 底面左前角）。
 * 真 CAD 模型到位前的替代品，但做到能一眼認出是 UNO：
 * 板形缺角、母座排針、USB-B、電源座、DIP 晶片、電解電容、石英振盪器。
 * 排針位置直接讀 profile 的腳位座標，所以模型和電氣資料不會各說各話。
 */

const PCB_W = 68.58, PCB_D = 53.34, PCB_T = 1.6;
const TEAL = "#0f7276";   // 實物偏青綠，不是亮藍

/** UNO 的板形：右下角有一塊缺角。 */
function pcbGeometry() {
  const s = new THREE.Shape();
  const r = 3.0;              // 圓角
  const notchX = 61.0, notchD = 7.6;
  s.moveTo(r, 0);
  s.lineTo(notchX, 0);
  s.lineTo(PCB_W, notchD);
  s.lineTo(PCB_W, PCB_D - r);
  s.quadraticCurveTo(PCB_W, PCB_D, PCB_W - r, PCB_D);
  s.lineTo(r, PCB_D);
  s.quadraticCurveTo(0, PCB_D, 0, PCB_D - r);
  s.lineTo(0, r);
  s.quadraticCurveTo(0, 0, r, 0);

  const g = new THREE.ExtrudeGeometry(s, { depth: PCB_T, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2);     // XY 平面 → XZ 平面，Y 朝上
  // rotateX(-90°) 會把 shape 的 +Y 映到 -Z，板子會落在 z ∈ [-PCB_D, 0]，
  // 和照 profile 座標擺的排針分離。推回 +PCB_D 才對齊。
  g.translate(0, PCB_T, PCB_D);
  return g;
}

/** 母座排針：黑色長條 ＋ 每個孔一個凹點。 */
function Header({ x, z, count, rotated = false }: {
  x: number; z: number; count: number; rotated?: boolean;
}) {
  const len = count * 2.54;
  const w = rotated ? 2.54 : len;
  const d = rotated ? len : 2.54;
  return (
    <group position={[x + w / 2 - 1.27, PCB_T, z]}>
      <mesh position={[0, 4.3, 0]} castShadow>
        <boxGeometry args={[w, 8.6, d]} />
        <meshStandardMaterial color="#17191c" roughness={0.62} />
      </mesh>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} position={[
          rotated ? 0 : (i - (count - 1) / 2) * 2.54,
          8.62,
          rotated ? (i - (count - 1) / 2) * 2.54 : 0,
        ]}>
          <boxGeometry args={[1.5, 0.3, 1.5]} />
          <meshStandardMaterial color="#090a0b" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

export function ArduinoUno({ profile }: { profile?: ComponentProfile }) {
  const pcb = useMemo(() => pcbGeometry(), []);
  const silk = useMemo(() => profile ? arduinoSilkTexture(profile, PCB_W, PCB_D) : null,
                       [profile]);

  // 從 profile 推排針位置，模型和電氣資料共用同一份座標
  const headers = useMemo(() => {
    if (!profile) return [];
    const byZ = new Map<number, number[]>();
    for (const p of profile.pins) {
      const z = Math.round(p.position_mm[2] * 10) / 10;
      byZ.set(z, [...(byZ.get(z) ?? []), p.position_mm[0]]);
    }
    const out: { x: number; z: number; count: number }[] = [];
    for (const [z, xs] of byZ) {
      xs.sort((a, b) => a - b);
      // 連續的 2.54 間距切成一段一段
      let start = xs[0], prev = xs[0], n = 1;
      for (let i = 1; i <= xs.length; i++) {
        const cur = xs[i];
        if (cur !== undefined && Math.abs(cur - prev - 2.54) < 0.1) { n++; prev = cur; continue; }
        out.push({ x: start, z, count: n });
        if (cur !== undefined) { start = cur; prev = cur; n = 1; }
      }
    }
    return out;
  }, [profile]);

  return (
    <group>
      <mesh geometry={pcb} castShadow receiveShadow>
        <meshPhysicalMaterial color={TEAL} roughness={0.55} clearcoat={0.22}
                              clearcoatRoughness={0.4} />
      </mesh>

      {/* 絲印：UNO 的辨識度九成在這一層 */}
      {silk && (
        <mesh position={[PCB_W / 2, PCB_T + 0.012, PCB_D / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[PCB_W, PCB_D]} />
          <meshPhysicalMaterial map={silk} roughness={0.55} clearcoat={0.22}
                                clearcoatRoughness={0.4} />
        </mesh>
      )}

      {headers.map((h, i) => <Header key={i} {...h} />)}

      {/* USB-B 連接器 */}
      <mesh position={[8.9, PCB_T + 5.5, 46.5]} castShadow>
        <boxGeometry args={[12, 11, 16]} />
        <meshStandardMaterial color="#c9ccd1" metalness={0.88} roughness={0.3} />
      </mesh>
      {/* 電源座 */}
      <mesh position={[9.0, PCB_T + 5.5, 5.5]} castShadow>
        <boxGeometry args={[9, 11, 14]} />
        <meshStandardMaterial color="#111316" roughness={0.68} />
      </mesh>
      {/* ATmega328P（DIP-28） */}
      <mesh position={[42, PCB_T + 2.0, 20] } castShadow>
        <boxGeometry args={[35, 4, 10]} />
        <meshStandardMaterial color="#17181b" roughness={0.72} />
      </mesh>
      {/* 電解電容 ×2 */}
      {[[23, 11], [23, 42]].map(([x, z], i) => (
        <mesh key={i} position={[x, PCB_T + 5, z]} castShadow>
          <cylinderGeometry args={[3.2, 3.2, 10, 16]} />
          <meshStandardMaterial color="#1c2733" roughness={0.45} metalness={0.3} />
        </mesh>
      ))}
      {/* 石英振盪器 */}
      <mesh position={[31, PCB_T + 1.6, 31]} castShadow>
        <boxGeometry args={[11, 3.2, 4.5]} />
        <meshStandardMaterial color="#b8bcc2" metalness={0.8} roughness={0.28} />
      </mesh>
      {/* 重置鍵 */}
      <mesh position={[13, PCB_T + 1.8, 31]} castShadow>
        <boxGeometry args={[6, 3.6, 6]} />
        <meshStandardMaterial color="#9aa1a8" metalness={0.6} roughness={0.4} />
      </mesh>
    </group>
  );
}
