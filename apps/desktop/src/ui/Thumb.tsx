import { useEffect, useState } from "react";
import type { ComponentProfile } from "@assemblex/circuit-schema";
import { thumbnail } from "./thumbnails";

/** 元件的 CAD 預覽縮圖（離屏渲染一次後快取）。 */
export function Thumb({ profile, size = 56 }: { profile: ComponentProfile; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    thumbnail(profile).then((u) => { if (alive) setSrc(u); }).catch(() => {});
    return () => { alive = false; };
  }, [profile]);
  return (
    <div className="thumb" style={{ width: size, height: size }}>
      {src ? <img src={src} alt={profile.display_name} /> : <span className="thumb-wait" />}
    </div>
  );
}
