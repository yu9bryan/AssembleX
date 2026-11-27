//! AssembleX Studio 的 Tauri 殼。
//! 本機操作以 Tauri command 的形式加在這裡 —— 那正是選 Tauri 而不是純 Web 的理由。

mod compdf;
use std::path::PathBuf;

mod lan;

/// 把檔案寫進使用者的「下載」資料夾，回傳完整路徑。
/// 桌面版的 WebView（WKWebView）不支援 `<a download>`，前端按「下載」不會有任何反應，
/// 所以下載一律走這個 command。檔名重複時自動加上 (2)、(3)…，不覆蓋舊檔。
#[tauri::command]
fn save_to_downloads(name: String, bytes: Vec<u8>) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "找不到使用者目錄".to_string())?;
    let dir = PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 只取檔名本身，避免 ../ 之類的路徑跳出下載資料夾
    let safe = PathBuf::from(&name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "檔名不合法".to_string())?;
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (safe.clone(), String::new()),
    };
    let mut path = dir.join(&safe);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 在 Finder 中顯示剛存好的檔案。
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 前端每次專案內容改變時呼叫：更新內網分享的專案 JSON（手機輪詢 /info 的 revision 會變）。
#[tauri::command]
fn lan_publish(state: tauri::State<lan::Lan>, project: String, title: String, project_id: String) {
    state.publish(project, title, project_id);
}

/// 組裝進度：桌面寫入／讀取（手機用 POST /progress 寫入同一份）
#[tauri::command]
fn lan_set_progress(state: tauri::State<lan::Lan>, progress: serde_json::Value) -> u64 { state.set_progress(progress) }
#[tauri::command]
fn lan_progress(state: tauri::State<lan::Lan>) -> serde_json::Value { state.progress() }

/// 給前端畫 QR code：assemblex://<內網 IP>:<埠>/?t=<token>
#[tauri::command]
fn lan_address(state: tauri::State<lan::Lan>) -> lan::LanAddress {
    state.address()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lan::Lan::start())
        .invoke_handler(tauri::generate_handler![save_to_downloads, reveal_in_finder, lan_publish, lan_address, lan_set_progress, lan_progress, compdf::compdf_parse])
        .build(tauri::generate_context!())
        .expect("AssembleX Studio 啟動失敗")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                use tauri::Manager;
                app.state::<lan::Lan>().shutdown();
            }
        });
}
