import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { prepareModel } from "./prepareModel";

/**
 * 載入真的 3D 模型（KiCad packages3D CC-BY-SA、CircuitLoom MIT）。整理邏輯和縮圖共用。
 * fade < 1 時把這個實例的材質複製一份再調透明度（材質可能和快取、縮圖共用，不能直接改）。
 */
export function GltfPart({ url, profile }: { url: string; profile: ComponentProfile; fade?: number }) {
  const { scene } = useGLTF(url);
  const obj = useMemo(() => prepareModel(scene, profile), [scene, profile]);
  useEffect(() => {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (!m.userData.ownMat) {
        m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
        m.userData.ownMat = true;
      }
      // 透明度與淡化交給外層 Faded 統一處理（含漸變），這裡只負責每個實例有自己的材質
    });
  }, [obj]);
  return <primitive object={obj} />;
}
