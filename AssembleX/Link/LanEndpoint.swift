import Foundation
import Darwin

/// 一台桌面 Studio 的位址與 token。
struct LanEndpoint: Codable, Sendable, Equatable, Hashable {
    var host: String
    var port: Int
    var token: String
    var title: String?

    var display: String { "\(host):\(port)" }

    /// 解析 QR code：`assemblex://192.168.1.23:47820/?t=8f3k2a`
    init?(qr raw: String) {
        guard let c = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == "assemblex", let host = c.host, !host.isEmpty,
              let t = c.queryItems?.first(where: { $0.name == "t" })?.value, !t.isEmpty else { return nil }
        self.init(host: host, port: c.port ?? 47820, token: t)
    }

    /// 手動輸入：「192.168.1.23:47820」或只有 IP（預設 47820）
    init?(address: String, token: String) {
        let a = address.trimmingCharacters(in: .whitespaces)
        let t = token.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty, !t.isEmpty else { return nil }
        let parts = a.split(separator: ":")
        if parts.count == 2, let p = Int(parts[1]), (1...65535).contains(p) {
            self.init(host: String(parts[0]), port: p, token: t)
        } else if parts.count == 1 {
            self.init(host: a, port: 47820, token: t)
        } else { return nil }
    }

    init(host: String, port: Int, token: String, title: String? = nil) {
        self.host = host; self.port = port; self.token = token; self.title = title
    }

    func url(_ path: String) -> URL? {
        var c = URLComponents()
        c.scheme = "http"
        c.host = host.contains(":") ? "[\(host)]" : host      // IPv6 要加中括號
        c.port = port
        c.path = path
        c.queryItems = [URLQueryItem(name: "t", value: token)]
        return c.url
    }

    // MARK: 記住上次連線

    private static let key = "lan.lastEndpoint"

    static var last: LanEndpoint? {
        get {
            guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
            return try? JSONDecoder().decode(LanEndpoint.self, from: d)
        }
        set {
            if let v = newValue, let d = try? JSONEncoder().encode(v) {
                UserDefaults.standard.set(d, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
    }
}

/// 手機目前 Wi-Fi 的 IPv4 與網路遮罩，用來判斷「不同網段」。
enum LocalNetwork {
    static func wifiIPv4() -> (ip: UInt32, mask: UInt32, text: String)? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            defer { p = cur.pointee.ifa_next }
            let ifa = cur.pointee
            guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  String(cString: ifa.ifa_name) == "en0", let maskPtr = ifa.ifa_netmask else { continue }
            let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
            let mask = maskPtr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
            return (UInt32(bigEndian: ip), UInt32(bigEndian: mask), text(UInt32(bigEndian: ip)))
        }
        return nil
    }

    static func parseIPv4(_ s: String) -> UInt32? {
        let p = s.split(separator: ".").compactMap { UInt32($0) }
        guard p.count == 4, p.allSatisfy({ $0 < 256 }) else { return nil }
        return p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]
    }

    static func text(_ ip: UInt32) -> String {
        "\(ip >> 24 & 255).\(ip >> 16 & 255).\(ip >> 8 & 255).\(ip & 255)"
    }

    /// nil＝無法判斷（沒有 Wi-Fi 或主機是名稱）
    static func sameSubnet(as host: String) -> (same: Bool, phone: String)? {
        guard let server = parseIPv4(host), let me = wifiIPv4() else { return nil }
        return ((server & me.mask) == (me.ip & me.mask), me.text)
    }
}
