//! ComPDF 文件解析（KDAN）：從 Rust 端呼叫，金鑰不進網頁、也不受 CORS 限制。
//! 用系統的 /usr/bin/curl（和 LAN 用 dns-sd 一樣不加 HTTP 相依套件）；金鑰從 stdin 傳入 header，不出現在行程參數裡。
use std::io::Write;
use std::process::{Command, Stdio};

/// PDF → Markdown 轉檔（帶 [pageN] 頁碼標記、表格轉 Markdown）。AI documentParsing 需另購額度，轉檔額度一般帳號就有。
const ENDPOINT: &str = "https://api-server.compdf.com/server/v2/process/pdf/markdown";

fn curl(args: &[&str], header: Option<&str>) -> Result<(u16, String), String> {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-sS", "-m", "240", "-w", "\n__HTTP__%{http_code}"]);
    if header.is_some() { cmd.args(["-H", "@-"]); }
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("無法執行 curl：{e}"))?;
    if let Some(h) = header {
        child.stdin.take().unwrap().write_all(format!("{h}\n").as_bytes()).map_err(|e| e.to_string())?;
    } else { drop(child.stdin.take()); }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, code) = text.rsplit_once("\n__HTTP__").ok_or_else(|| {
        format!("連不上 ComPDF：{}", String::from_utf8_lossy(&out.stderr).trim())
    })?;
    Ok((code.trim().parse().unwrap_or(0), body.to_string()))
}

/// 上傳檔案給 ComPDF Document Parsing（同步模式），回傳 JSON 字串：
/// {"status": <http>, "body": <回應原文>, "download": <若回應只給下載網址，下載回來的內容>}
/// 前端用原始位元組傳檔（不是 2 百萬個數字的陣列），金鑰和檔名放在 header；
/// 而且是 async：網路等待在背景執行緒，不會卡住整個視窗。
#[tauri::command]
pub async fn compdf_parse(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let key = header("x-compdf-key");
    let name = percent_decode(&header("x-file-name"));
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("檔案沒有傳過來".into()),
    };
    tauri::async_runtime::spawn_blocking(move || compdf_blocking(key, name, data))
        .await.map_err(|e| e.to_string())?
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes(); let mut out = Vec::with_capacity(b.len()); let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]); i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn compdf_blocking(key: String, name: String, data: Vec<u8>) -> Result<String, String> {
    if key.trim().is_empty() { return Err("還沒設定 ComPDF 金鑰".into()); }
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let dir = std::env::temp_dir().join(format!("assemblex-compdf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(if safe.is_empty() { "datasheet.pdf".into() } else { safe });
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    let file_arg = format!("file=@{}", path.display());
    let res = curl(&["-F", &file_arg, "-F", "language=2", ENDPOINT], Some(&format!("x-api-key: {}", key.trim())));
    let _ = std::fs::remove_file(&path);
    let (status, body) = res?;
    // 轉檔結果是 zip（.md ＋圖片）：下載、解出 .md 文字
    let mut download = serde_json::Value::Null;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        let url = v.pointer("/data/downloadUrl").or_else(|| v.pointer("/data/fileUrl")).and_then(|u| u.as_str()).map(str::to_string);
        if let Some(u) = url.filter(|u| u.starts_with("https://")) {
            let zip = dir.join("out.zip");
            let zs = zip.display().to_string();
            if curl(&["-L", "-o", &zs, &u], None).is_ok() {
                let out = Command::new("/usr/bin/unzip").args(["-p", &zs, "*.md"]).output();
                if let Ok(o) = out { if !o.stdout.is_empty() { download = serde_json::Value::String(String::from_utf8_lossy(&o.stdout).to_string()); } }
                if download.is_null() {
                    // 不是 zip（直接是文字檔）
                    if let Ok(t) = std::fs::read_to_string(&zip) { download = serde_json::Value::String(t); }
                }
                let _ = std::fs::remove_file(&zip);
            }
        }
    }
    Ok(serde_json::json!({ "status": status, "body": body, "download": download }).to_string())
}
