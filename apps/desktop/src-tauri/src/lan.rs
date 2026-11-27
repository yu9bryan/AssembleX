//! 內網分享（協定見 docs/LAN_PROTOCOL.md）：手機 AR 端用 QR code 或 Bonjour 找到這台電腦，
//! 以唯讀 HTTP 取得目前開著的專案。只回 JSON、每次啟動換新 token，token 錯一律 403。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct Shared {
    project: String,  // /project 的完整 JSON（前端組好）
    title: String,
    project_id: String,
    revision: u64,
    progress: serde_json::Value,   // {projectId, step, done, from, seq}；手機與桌面共用的組裝進度
    seq: u64,
}

pub struct Lan {
    shared: Arc<Mutex<Shared>>,
    pub port: u16,
    pub token: String,
    _mdns: Option<Bonjour>,
}

/// 用 macOS 內建的 dns-sd 註冊 Bonjour 服務（交給系統的 mDNSResponder，不自己搶 5353 埠）；App 關閉時一起結束。
/// 守護執行緒負責 spawn／重啟 dns-sd：廣播子行程自己結束（mDNSResponder 重啟、睡眠喚醒）時 2 秒後重新註冊。
struct Bonjour { pid: Arc<std::sync::atomic::AtomicU32>, stop: Arc<std::sync::atomic::AtomicBool> }
impl Bonjour {
    fn kill(&self) {
        use std::sync::atomic::Ordering;
        self.stop.store(true, Ordering::SeqCst);
        let pid = self.pid.load(Ordering::SeqCst);
        if pid != 0 { let _ = std::process::Command::new("/bin/kill").arg(pid.to_string()).status(); }
    }
}
impl Drop for Bonjour { fn drop(&mut self) { self.kill(); } }

/// 只清「孤兒」廣播：建立它的 App 已經不在（父行程變成 launchd，ppid 1）。
/// 另一個還開著的 Studio 的廣播不能動，不然那台電腦在手機上會消失。
fn kill_orphan_adverts() {
    let Ok(out) = std::process::Command::new("/bin/ps").args(["-axo", "pid=,ppid=,command="]).output() else { return };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (it.next(), it.next()) else { continue };
        let cmd: Vec<&str> = it.collect();
        let cmd = cmd.join(" ");
        if ppid == "1" && cmd.contains("dns-sd -R AssembleX Studio") {
            let _ = std::process::Command::new("/bin/kill").arg(pid).status();
        }
    }
}

#[derive(serde::Serialize)]
pub struct LanAddress { url: String, ip: String, port: u16, token: String, ok: bool }

/// 找出內網 IP：對外部位址「連線」UDP 只是讓系統選路由，不會真的送出封包。
fn lan_ip() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.168.0.1:9").or_else(|_| s.connect("8.8.8.8:80")).ok()?;
    match s.local_addr().ok()?.ip() { IpAddr::V4(v) if !v.is_loopback() => Some(v), _ => None }
}

fn token() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) ^ (std::process::id() as u128) << 64;
    let mut x = (n as u64) ^ ((n >> 64) as u64) ^ 0x9e37_79b9_7f4a_7c15;
    let abc = b"abcdefghjkmnpqrstuvwxyz23456789";
    (0..8).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; abc[(x % abc.len() as u64) as usize] as char }).collect()
}

fn respond(mut s: TcpStream, code: &str, body: &str) {
    let _ = write!(s, "HTTP/1.1 {code}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn handle(s: TcpStream, shared: &Arc<Mutex<Shared>>, tok: &str) {
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    let mut rd = BufReader::new(&s);
    let mut line = String::new();
    if rd.read_line(&mut line).is_err() { return; }
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if rd.read_line(&mut h).is_err() || h.trim().is_empty() { break; }
        if let Some((k, v)) = h.split_once(':') { if k.eq_ignore_ascii_case("content-length") { len = v.trim().parse().unwrap_or(0).min(1 << 20); } }
    }
    let mut body = vec![0u8; len];
    if len > 0 { use std::io::Read; if rd.read_exact(&mut body).is_err() { return; } }
    let method = line.split_whitespace().next().unwrap_or("GET").to_string();
    let path = line.split_whitespace().nth(1).unwrap_or("/");
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let q: HashMap<&str, &str> = query.split('&').filter_map(|kv| kv.split_once('=')).collect();
    if q.get("t") != Some(&tok) { return respond(s, "403 Forbidden", r#"{"error":"token"}"#); }
    let mut sh = shared.lock().unwrap();
    if method == "POST" && route == "/progress" {
        let mut v: serde_json::Value = match serde_json::from_slice(&body) { Ok(v) => v, Err(_) => { drop(sh); return respond(s, "400 Bad Request", r#"{"error":"json"}"#) } };
        if v["projectId"].as_str() != Some(sh.project_id.as_str()) { drop(sh); return respond(s, "409 Conflict", r#"{"error":"project"}"#); }
        sh.seq += 1;
        v["seq"] = serde_json::json!(sh.seq);
        if v["from"].is_null() { v["from"] = serde_json::json!("phone"); }
        sh.progress = v;
        let b = serde_json::json!({ "ok": true, "seq": sh.seq }).to_string();
        drop(sh); return respond(s, "200 OK", &b);
    }
    match route {
        "/info" => {
            let body = serde_json::json!({ "v": 1, "app": "AssembleX Studio", "host": computer_name(), "title": sh.title, "projectId": sh.project_id, "revision": sh.revision, "progress": sh.progress }).to_string();
            drop(sh); respond(s, "200 OK", &body)
        }
        "/project" if !sh.project.is_empty() => { let b = sh.project.clone(); drop(sh); respond(s, "200 OK", &b) }
        "/project" => { drop(sh); respond(s, "404 Not Found", r#"{"error":"no project"}"#) }
        _ => { drop(sh); respond(s, "404 Not Found", r#"{"error":"not found"}"#) }
    }
}

impl Lan {
    pub fn start() -> Lan {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let tok = token();
        let mut port = 0;
        let mut listener = None;
        for p in 47820..=47830 {
            if let Ok(l) = TcpListener::bind(("0.0.0.0", p)) { port = p; listener = Some(l); break; }
        }
        if let Some(l) = listener {
            let (sh, t) = (shared.clone(), tok.clone());
            std::thread::spawn(move || {
                for s in l.incoming().flatten() {
                    let (sh, t) = (sh.clone(), t.clone());
                    std::thread::spawn(move || handle(s, &sh, &t));
                }
            });
        }
        // Bonjour：手機不用掃 QR 也能在清單裡看到這台電腦
        // 上次 App 被強制結束時留下的 dns-sd 廣播（token 已失效）先清掉，手機才不會連到舊 token
        kill_orphan_adverts();
        let mdns = (port != 0).then(|| {
            use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
            let host = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output().ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or("Mac".into());
            let b = Bonjour { pid: Arc::new(AtomicU32::new(0)), stop: Arc::new(AtomicBool::new(false)) };
            let (pid, stop, tok) = (b.pid.clone(), b.stop.clone(), tok.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let child = std::process::Command::new("/usr/bin/dns-sd")
                        .args(["-R", &format!("AssembleX Studio ({host})"), "_assemblex._tcp", "local.", &port.to_string(),
                               "v=1", &format!("t={tok}"), &format!("host={host}")])
                        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                        .spawn();
                    match child {
                        Ok(mut c) => { pid.store(c.id(), Ordering::SeqCst); let _ = c.wait(); pid.store(0, Ordering::SeqCst); }
                        Err(_) => {}
                    }
                    if stop.load(Ordering::SeqCst) { break; }
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            });
            Some(b)
        }).flatten();
        Lan { shared, port, token: tok, _mdns: mdns }
    }

    pub fn publish(&self, project: String, title: String, project_id: String) {
        let mut sh = self.shared.lock().unwrap();
        // /project 的 revision 一律改成伺服器的發布計數，和 /info 同一個數字（手機比對才不會每次都重抓）
        let mut v: serde_json::Value = match serde_json::from_str(&project) { Ok(v) => v, Err(_) => return };
        v["revision"] = serde_json::json!(0);
        let body0 = v.to_string();
        let prev0 = serde_json::from_str::<serde_json::Value>(&sh.project).map(|mut p| { p["revision"] = serde_json::json!(0); p.to_string() }).unwrap_or_default();
        if body0 != prev0 { sh.revision += 1; }
        v["revision"] = serde_json::json!(sh.revision);
        sh.project = v.to_string(); sh.title = title; sh.project_id = project_id;
    }

    /// App 結束時呼叫：停掉 Bonjour 廣播
    pub fn shutdown(&self) {
        if let Some(b) = &self._mdns { b.kill(); }
    }

    /// 桌面端寫入進度（from: "desktop"），回傳新的 seq
    pub fn set_progress(&self, mut v: serde_json::Value) -> u64 {
        let mut sh = self.shared.lock().unwrap();
        sh.seq += 1;
        v["seq"] = serde_json::json!(sh.seq);
        v["from"] = serde_json::json!("desktop");
        sh.progress = v;
        sh.seq
    }
    pub fn progress(&self) -> serde_json::Value { self.shared.lock().unwrap().progress.clone() }

    pub fn address(&self) -> LanAddress {
        let ip = lan_ip().map(|i| i.to_string()).unwrap_or_default();
        let ok = self.port != 0 && !ip.is_empty();
        LanAddress { url: format!("assemblex://{ip}:{}/?t={}", self.port, self.token), ip, port: self.port, token: self.token.clone(), ok }
    }
}

/// 這台電腦的名稱（手機的「最近的專案」顯示來源用）；查一次後快取
fn computer_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| std::process::Command::new("scutil").args(["--get", "ComputerName"]).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Mac".into())).clone()
}
