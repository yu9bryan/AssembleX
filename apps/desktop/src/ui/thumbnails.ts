import * as THREE from "three";
import { datasheetShape, isDatasheetPart } from "../engine3d/datasheetShape";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { prepareModel } from "../engine3d/prepareModel";

/**
 * 元件 CAD 預覽縮圖。
 *
 * 不能每一列各開一個 3D 畫布：瀏覽器同時能開的 WebGL context 大約只有 16 個，
 * 元件庫一長就會開始有畫布被回收、變黑。所以用**一個**離屏渲染器依序拍，
 * 拍完轉成圖片網址並快取 —— 同一個元件只渲染一次。
 */
const SIZE = 224;
let ctx: { r: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera } | null = null;
const cache = new Map<string, Promise<string>>();
const loader = new GLTFLoader();
let queue: Promise<unknown> = Promise.resolve();

function setup() {
  if (ctx) return ctx;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(SIZE, SIZE);
  r.setPixelRatio(1);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight("#ffffff", 2.2); key.position.set(-2, 4, 3);
  const rim = new THREE.DirectionalLight("#7fb4ff", 1.2); rim.position.set(3, 2, -3);
  scene.add(key, rim, new THREE.AmbientLight("#ffffff", 0.25));
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 5000);
  ctx = { r, scene, cam };
  return ctx;
}

function procedural(p: ComponentProfile): THREE.Object3D {
  if (isDatasheetPart(p)) return datasheetShape(p);
  const [w, h, d] = p.geometry.bbox_mm;
  const g = new RoundedBoxGeometry(w, h, d, 3, Math.min(1.2, Math.min(w, h, d) / 4));
  const m = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({
    color: p.geometry.placeholder?.color ?? "#5a5a5e", roughness: 0.5, clearcoat: 0.3,
  }));
  m.position.set(w / 2, h / 2, 0);
  return m;
}

async function render(p: ComponentProfile): Promise<string> {
  const { r, scene, cam } = setup();
  let obj: THREE.Object3D;
  if (p.geometry.desktop_model) {
    const gltf = await loader.loadAsync(`/${p.geometry.desktop_model}`);
    obj = prepareModel(gltf.scene, p);
  } else {
    obj = procedural(p);
  }
  scene.add(obj);

  // 3/4 等角視角，依包圍球自動框住
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.02;
  const dir = new THREE.Vector3(0.62, 0.55, 0.9).normalize();
  cam.position.copy(sphere.center).addScaledVector(dir, dist);
  cam.near = dist / 100; cam.far = dist * 10;
  cam.lookAt(sphere.center);
  cam.updateProjectionMatrix();

  r.render(scene, cam);
  const url = r.domElement.toDataURL("image/png");
  scene.remove(obj);
  return url;
}

export function thumbnail(p: ComponentProfile): Promise<string> {
  // 從規格書新增的元件：同一個 id 可能被修改或重新匯入，外形不同就不能沿用舊縮圖
  const key = p.component_id.startsWith("user_")
    ? `${p.component_id}|${p.geometry.asset_id}|${p.category}|${p.geometry.bbox_mm.join("x")}|${p.pins.length}|${p.display_name}` : p.component_id;
  const hit = cache.get(key);
  if (hit) return hit;
  // 單一渲染器，排隊依序拍
  // 一張一張拍，中間讓出主執行緒（等瀏覽器有空再拍下一張）：元件庫打開時不會整頁卡住
  const job = queue.then(() => new Promise<void>((r) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => r(), { timeout: 300 }); else setTimeout(r, 16);
  })).then(() => render(p));
  queue = job.catch(() => undefined);
  cache.set(key, job);
  return job;
}
