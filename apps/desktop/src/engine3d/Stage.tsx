import { useMemo } from "react";
import * as THREE from "three";

/**
 * 暗色實驗室場景。
 *
 * 參考的是數位孿生那種打光：深色工作面、強烈的方向主光把主體從暗背景裡拉出來、
 * 邊緣有冷色輪廓光。亮背景配亮元件會讓所有東西糊在一起，暗背景才有立體感。
 */
export function Stage() {
  const sky = useMemo(() => new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,   // 背景就是 #070708，不經 ACES（否則會被抬亮）
    uniforms: {
      // 中性近黑，不要藍灰色調 —— 藍色只留給 3D 物件本身的燈光
      top:    { value: new THREE.Color("#070708") },
      mid:    { value: new THREE.Color("#070708") },
      bottom: { value: new THREE.Color("#070708") },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y * 0.5 + 0.5;
        vec3 c = h < 0.5 ? mix(bottom, mid, h * 2.0)
                         : mix(mid, top, (h - 0.5) * 2.0);

        // 遠處的柔和光源（暖色工作燈、冷色窗光）。
        // 玻璃要有東西可以透、可以霧化，visionOS 的玻璃質感才讀得出來；
        // 背景一片均勻暗灰的話，玻璃看起來就只是一塊灰板。
        vec3 d = normalize(vPos);
        float warm = pow(max(dot(d, normalize(vec3(-0.75, 0.32, -0.58))), 0.0), 18.0);
            float back = pow(max(dot(d, normalize(vec3( 0.05, 0.22, -1.0))), 0.0), 6.0);
        // 參考圖的背景和卡片幾乎同一個黑；只留極淡的暖光，不加冷色（會讓右上偏藍）
        // 越接近地平線越淡、到地平線歸零：不然柔光在地面邊緣被切出一條明顯的天際線
        //（這只是背景，不參與照明；物件的光來自 Environment 與方向光，不受影響）
        float fade = smoothstep(0.02, 0.45, d.y);
        c += vec3(1.00, 0.85, 0.70) * warm * 0.02 * fade;
        c += vec3(0.50, 0.50, 0.52) * back * 0.02 * fade;
        gl_FragColor = vec4(c, 1.0);
        // 自訂 shader 不會自動注入這兩段，少了的話背景繞過 ACES、色值也偏
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }), []);

  /** 工作檯面：深色防靜電墊的質感 —— 細顆粒、低反射、中央一圈燈光暈。 */
  const matTex = useMemo(() => {
    const S = 2048;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d")!;

    g.fillStyle = "#0b0b0c";
    g.fillRect(0, 0, S, S);

    // 中央燈光暈，把視線帶到主體
    const pool = g.createRadialGradient(S / 2, S * 0.47, S * 0.03, S / 2, S * 0.47, S * 0.42);
    pool.addColorStop(0, "rgba(90,90,90,0.0)");
    pool.addColorStop(0.5, "rgba(60,60,60,0.0)");
    pool.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = pool;
    g.fillRect(0, 0, S, S);

    // 外緣收進背景色，否則桌面圓盤的邊會在畫面裡變成一條弧形地平線
    const edge = g.createRadialGradient(S / 2, S * 0.47, S * 0.40, S / 2, S * 0.47, S * 0.5);
    edge.addColorStop(0, "rgba(11,11,12,0)");
    edge.addColorStop(1, "rgba(11,11,12,1)");
    g.fillStyle = edge;
    g.fillRect(0, 0, S, S);

    // 防靜電墊的細顆粒
    for (let i = 0; i < 90000; i++) {
      const a = Math.random() * 0.015;
      g.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.6})`;
      g.fillRect(Math.random() * S, Math.random() * S, 1.6, 1.6);
    }

    // （原本畫了 40 條格線，攤在直徑 52 的圓盤上每格 130mm，讓麵包板看起來像玩具，拿掉）

    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, []);

  const glowTex = useMemo(() => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 512;
    const g = cv.getContext("2d")!;
    const r = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    r.addColorStop(0, "rgba(30,31,34,1)"); r.addColorStop(0.5, "rgba(20,21,23,0.8)"); r.addColorStop(1, "rgba(7,7,8,0)");
    g.fillStyle = r; g.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }, []);

  return (
    <>
      <mesh material={sky} scale={30}>
        <sphereGeometry args={[1, 32, 24]} />
      </mesh>

      {/* 地面不吃光：受光的深色材質會被主光提亮到 RGB 20+，畫面變成一片灰霧，卡片浮不起來。
          底色固定 #070708（和介面 --bg 一樣），影子另外用只收影子的透明層疊上去 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.05]}>
        <circleGeometry args={[12, 192]} />
        <meshBasicMaterial color="#070708" toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0004, -0.2]}>
        <circleGeometry args={[1.6, 96]} />
        <meshBasicMaterial map={glowTex} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0008, 0.05]} receiveShadow>
        <circleGeometry args={[3, 96]} />
        <shadowMaterial opacity={0.16} />   {/* 地面影子很淡：架空的線不會在地上投出懸空的 U 形影，影子主要落在麵包板和 PCB 上 */}
      </mesh>
    </>
  );
}
