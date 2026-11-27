/**
 * 下載檔案：桌面版（Tauri）寫進「下載」資料夾並在 Finder 標出來；瀏覽器開發模式用一般的 <a download>。
 * 桌面版的 WKWebView 不支援 <a download>，直接用會「按了沒反應」。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export async function downloadFile(name: string, blob: Blob): Promise<string> {
  if (isTauri()) {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const path = await invoke<string>("save_to_downloads", { name, bytes });
    invoke("reveal_in_finder", { path }).catch(() => {});
    return path;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);   // 立刻撤銷會讓某些瀏覽器下載失敗
  return name;
}
