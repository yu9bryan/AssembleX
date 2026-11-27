import * as THREE from "three";
import type { ComponentProfile } from "@assemblex/circuit-schema";

/**
 * 把載入的模型整理成可以直接放進場景的樣子：材質修正＋套用 profile 的 model_transform。
 * 3D 工作台和元件庫縮圖共用這一份，兩邊看到的元件長得一樣。
 *
 * 材質規則：KiCad 的 metallicFactor 不可信（塑膠件常寫 0.75，會被畫成鍍鉻），
 * 所以先依名稱排除塑膠，金屬只認 PIN／MET 開頭的材質名；自帶 PBR 貼圖的模型（keep_materials）不動。
 */
const DEG = Math.PI / 180;

export function prepareModel(scene: THREE.Object3D, profile: ComponentProfile): THREE.Group {
  const t = profile.geometry.model_transform;
  const tint = profile.geometry.placeholder?.color;
  const isLed = profile.category === "led";
  const root = scene.clone(true);

  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    if (t?.keep_materials) return;
    // profile 指定的材質對照（節點名、父節點名或原本的材質名）
    const names = `${m.name} ${m.parent?.name ?? ""} ${(m.material as THREE.Material)?.name ?? ""}`;
    const hit = t?.materials?.find((r) => new RegExp(r.match, "i").test(names));
    if (hit) {
      m.material = new THREE.MeshPhysicalMaterial({
        color: hit.color, metalness: hit.metal, roughness: hit.rough,
        transmission: hit.transmission, thickness: hit.transmission ? 0.02 : 0,
        envMapIntensity: hit.env ?? (hit.metal > 0.5 ? 1.6 : 1),
      });
      return;
    }

    const src = m.material as THREE.MeshStandardMaterial;
    const name = (src.name || "").toUpperCase();
    const hsl = { h: 0, s: 0, l: 0 };
    src.color?.getHSL(hsl);
    const plastic = /PLASTIC|BODY|EPOXY|RES-THT|LED|CAP|IC-|CASE/.test(name);
    const metal = !plastic && (/^(PIN|MET)/.test(name) || (hsl.s < 0.08 && hsl.l > 0.45 && !t?.tint_body));

    if (metal) {
      const sz = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());   // 含節點縮放
      const big = Math.max(sz.x, sz.y, sz.z) * (t?.unit_scale ?? 1) > 5;   // 探頭、USB 殼這種大面金屬
      m.material = new THREE.MeshStandardMaterial({ color: "#b9bec6", metalness: big ? 0.6 : 0.92,
                                                    roughness: big ? 0.38 : 0.26, envMapIntensity: big ? 1.5 : 1 });
    } else if (isLed && tint) {
      // thickness／attenuationDistance 是世界單位；工作台縮放 0.01，縮圖不縮放 —— 兩邊都看得出透光就好
      m.material = new THREE.MeshPhysicalMaterial({
        color: tint, transmission: 0.6, thickness: 0.032, ior: 1.55,
        roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05,
        attenuationColor: new THREE.Color(tint), attenuationDistance: 0.004,
      });
    } else {
      m.material = new THREE.MeshPhysicalMaterial({
        color: t?.tint_body && tint ? new THREE.Color(tint) : (src.color ?? new THREE.Color("#9a9a9a")),
        roughness: t?.tint_body ? 0.6 : Math.min(0.75, src.roughness ?? 0.5),
        metalness: 0, clearcoat: t?.tint_body ? 0 : 0.3, clearcoatRoughness: 0.4,
      });
    }
  });

  // STEP 轉出來的模型常有單面或法線反向的殼（Nano 的 USB 座看起來像破一角）：一律雙面繪製
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[]) mat.side = THREE.DoubleSide;
  });
  const us = t?.unit_scale ?? 1;
  const sc = t?.scale ?? [1, 1, 1];
  const rot = t?.rotation_deg ?? [0, 0, 0];
  const scaleG = new THREE.Group(); scaleG.scale.set(sc[0] * us, sc[1] * us, sc[2] * us); scaleG.add(root);
  const rotG = new THREE.Group(); rotG.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG); rotG.add(scaleG);
  const out = new THREE.Group(); out.position.set(...(t?.offset_mm ?? [0, 0, 0])); out.add(rotG);
  return out;
}
