/**
 * ComPDF（KDAN）文件解析：規格書先交給 ComPDF Document Parsing 做 OCR／版面／表格擷取，
 * 再把「帶頁碼的結構化文字」交給 GPT-5.5 擷取規格。每個數值都能回指到 ComPDF 解析出的頁碼。
 *
 * 金鑰：介面上設定（存在這台電腦的 localStorage），或打包時的 apps/desktop/.env.local
 *       的 VITE_COMPDF_API_KEY（不進 git）。桌面版由 Rust 端呼叫，金鑰不會出現在網頁請求裡。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { unzipSync, strFromU8 } from "three/examples/jsm/libs/fflate.module.js";

const KEY_STORE = "assemblex.compdfKey";
const BUILT_IN = (import.meta.env?.VITE_COMPDF_API_KEY as string | undefined) ?? "";
/** PDF → Markdown 轉檔：輸出 zip（.md＋圖片），.md 內每頁結尾有「[pageN]」標記、表格轉成 Markdown */
const ENDPOINT = "https://api-server.compdf.com/server/v2/process/pdf/markdown";

export function getComPdfKey(): string {
  try { return localStorage.getItem(KEY_STORE) || BUILT_IN; } catch { return BUILT_IN; }
}
export function hasLocalComPdfKey(): boolean {
  try { return !!localStorage.getItem(KEY_STORE); } catch { return false; }
}
export function setComPdfKey(k: string) {
  try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); localStorage.removeItem(BROKEN); } catch { /* 無痕模式 */ }
}

/**
 * ComPDF 回 401／403 之後記住「這把金鑰無效」（只記金鑰尾碼，不存金鑰本身），
 * 介面才不會在失敗後還寫「已啟用」。換金鑰就自動清掉。
 */
const BROKEN = "assemblex.compdfBroken";
const BROKEN_TTL = 3600_000;
/** 「重新試 ComPDF」或 ComPDF 成功一次：清掉無效標記 */
export function clearComPdfBroken() {
  try { localStorage.removeItem(BROKEN); } catch { /* 無痕模式 */ }
}
const tail = (k: string) => k.slice(-6);
export function isComPdfKeyError(msg: string | undefined | null): boolean {
  return !!msg && /金鑰無效|沒有權限|\b40[13]\b/.test(msg);
}
export function markComPdfBroken() {
  try { const k = getComPdfKey(); if (k) localStorage.setItem(BROKEN, JSON.stringify({ tail: tail(k), at: Date.now() })); } catch { /* 無痕模式 */ }
}
export function isComPdfBroken(): boolean {
  // 只算一小時：內建金鑰可能只是暫時被擋（額度、服務端問題），不能一次 403 就永遠不用 ComPDF
  try {
    const k = getComPdfKey(); if (!k) return false;
    const m = JSON.parse(localStorage.getItem(BROKEN) ?? "null") as { tail?: string; at?: number } | string | null;
    return !!m && typeof m === "object" && m.tail === tail(k) && Date.now() - (m.at ?? 0) < BROKEN_TTL;
  } catch { return false; }
}

export interface ParsedDoc {
  /** 每頁的文字（含表格轉成的 Markdown） */
  pages: { page: number; text: string }[];
  /** 交給 GPT 的全文，每頁前面有「=== 第 N 頁 ===」標記 */
  tagged: string;
  pageCount: number;
  tables: number;
}

type Json = Record<string, unknown>;
export const PDF_DAMAGED = "這個 PDF 不完整（可能下載中斷或檔案損壞）。請重新下載規格書，或改上傳截圖";
/** ComPDF 錯誤代碼 → 中文（原訊息是簡體中文、使用者看不懂代碼）。未知代碼只顯示代碼 */
const CODE_TEXT: Record<string, string> = {
  "02001": "ComPDF 不支援這種格式",
  "401": "ComPDF 金鑰無效或沒有權限（401）",
  "403": "ComPDF 金鑰無效或沒有權限（403）",
};
const asObj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** 從一個頁面物件裡盡量撈出文字：content / markdown / text，或 structured 區塊的文字 */
function pageText(p: Json): string {
  for (const k of ["markdown", "content", "text", "md"]) if (typeof p[k] === "string" && (p[k] as string).trim()) return p[k] as string;
  const blocks = (p.structured ?? p.blocks ?? p.detail) as unknown;
  if (Array.isArray(blocks)) {
    return blocks.map((b) => { const o = asObj(b); if (!o) return ""; for (const k of ["markdown", "text", "content", "html"]) if (typeof o[k] === "string") return o[k] as string; return ""; })
      .filter(Boolean).join("\n");
  }
  return "";
}
const pageNo = (p: Json, i: number) => Number(p.page_number ?? p.page_id ?? p.pageNum ?? p.page ?? p.page_index ?? i + 1) || i + 1;

/** ComPDF 轉出的 Markdown：去掉圖片／排版用的 HTML，依「[pageN]」切頁（標記在每頁結尾） */
export function pagesFromMarkdown(md: string): { page: number; text: string }[] {
  const clean = md
    .replace(/<img[^>]*>/gi, "")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1")
    .replace(/<\/?div[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/^\s*_{3,}\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  const out: { page: number; text: string }[] = [];
  const re = /\[page(\d+)\]/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const text = clean.slice(last, m.index).replace(/Page \d+ of \d+\s*$/m, "").trim();
    if (text) out.push({ page: Number(m[1]), text });
    last = m.index + m[0].length;
  }
  const tail = clean.slice(last).trim();
  if (tail) out.push({ page: (out[out.length - 1]?.page ?? 0) + 1, text: tail });
  return out;
}

/** 兩種已知的回應格式都接：直接回 result（pages／markdown），或只給下載網址（Rust 端已下載回來） */
export function normalize(body: string, download?: string | null): ParsedDoc {
  let root: Json | null = null;
  try { root = asObj(JSON.parse(body)); } catch { /* 不是 JSON */ }
  const code = root?.code;
  if (root && code != null && String(code) !== "200") {
    // PDF 本身壞掉（頁面讀不出來、解析失敗）：換金鑰、重試都沒用，標成 damaged 讓上層直接停
    if (/PAGE_ERROR|PARSE_ERROR|DAMAGE|CORRUPT|INVALID_PDF|BROKEN_FILE/i.test(`${code} ${root.msg ?? ""} ${root.message ?? ""}`))
      throw Object.assign(new Error(PDF_DAMAGED), { damaged: true });
    const known = CODE_TEXT[String(code)];
    throw new Error(known ? `${known}（代碼 ${code}）` : `ComPDF 回應錯誤（代碼 ${code}）`);
  }
  let result = asObj(root?.result) ?? asObj(asObj(root?.data)?.result);
  if (!result && download) {
    let d: Json | null = null;
    try { d = asObj(JSON.parse(download)); } catch { /* 是 Markdown */ }
    if (d) result = asObj(d.result) ?? d;
    else {
      const pages = pagesFromMarkdown(download);
      if (pages.length) result = { pages: pages.map((x) => ({ page_number: x.page, markdown: x.text })), total_page_number: pages.length };
      else result = { markdown: download };
    }
  }
  if (!result) throw new Error("ComPDF 沒有回傳解析內容");
  const rawPages = Array.isArray(result.pages) ? (result.pages as unknown[]).map(asObj).filter((x): x is Json => !!x) : [];
  let pages = rawPages.map((p, i) => ({ page: pageNo(p, i), text: pageText(p).trim() })).filter((p) => p.text);
  if (!pages.length && typeof result.markdown === "string") {
    // 只有合併後的 Markdown：依分頁符號切，切不出來就當成一頁
    const parts = (result.markdown as string).split(/\f|<!--\s*page[^>]*-->/i).map((t) => t.trim()).filter(Boolean);
    pages = parts.map((text, i) => ({ page: i + 1, text }));
  }
  if (!pages.length) throw new Error("ComPDF 解析結果是空的（可能是掃描檔且 OCR 失敗）");
  const tagged = pages.map((p) => `=== 第 ${p.page} 頁 ===\n${p.text}`).join("\n\n");
  const pageCount = Number(result.total_page_number ?? result.valid_page_number ?? pages.length) || pages.length;
  const tables = (tagged.match(/^\|.*\|\s*$\n^\|[\s:|-]+\|\s*$/gm) ?? []).length + (tagged.match(/<table/gi) ?? []).length;
  return { pages, tagged, pageCount, tables };
}

/** 上傳給 ComPDF 解析。桌面版走 Rust（不受 CORS、金鑰不進網頁）；瀏覽器開發模式直接 fetch。 */
export async function parseWithComPdf(file: File, signal?: AbortSignal): Promise<ParsedDoc> {
  const key = getComPdfKey();
  if (!key) throw new Error("還沒設定 ComPDF 金鑰");
  if (isTauri()) {
    // 原始位元組直接送（不轉成數字陣列）；金鑰與檔名放 header。Rust 端是 async，視窗不會卡住
    const data = new Uint8Array(await file.arrayBuffer());
    const raw = await invoke<string>("compdf_parse", data, { headers: { "x-compdf-key": key, "x-file-name": encodeURIComponent(file.name) } });
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const r = JSON.parse(raw) as { status: number; body: string; download: string | null };
    if (r.status === 401 || r.status === 403) throw new Error("ComPDF 金鑰無效或沒有權限（403），請到 ComPDF Portal 確認金鑰");
    if (r.status && r.status >= 400) throw new Error(`ComPDF 回應錯誤：HTTP ${r.status}`);
    return normalize(r.body, r.download);
  }
  const fd = new FormData();
  fd.append("file", file); fd.append("language", "2");
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "x-api-key": key }, body: fd, signal });
  if (res.status === 401 || res.status === 403) throw new Error("ComPDF 金鑰無效或沒有權限（403）");
  const body = await res.text();
  let download: string | null = null;
  try {
    const j = JSON.parse(body) as { result?: unknown; data?: { downloadUrl?: string; fileUrl?: string } };
    const u = j.data?.downloadUrl ?? j.data?.fileUrl;
    if (!j.result && u) {
      const buf = new Uint8Array(await (await fetch(u, { signal })).arrayBuffer());
      if (buf[0] === 0x50 && buf[1] === 0x4b) {   // zip
        const files = unzipSync(buf);
        const md = Object.keys(files).find((k) => /\.md$/i.test(k));
        download = md ? strFromU8(files[md]) : null;
      } else download = strFromU8(buf);
    }
  } catch { /* normalize 會處理 */ }
  return normalize(body, download);
}

export async function sha256Hex(file: File): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
