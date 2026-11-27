import Foundation
import Network
import Observation

/// 用 Bonjour 找同一個 Wi-Fi 上的 AssembleX Studio（`_assemblex._tcp`，TXT：v、t、title）。
@MainActor
@Observable
final class BonjourBrowser {
    struct Studio: Identifiable, Hashable, Sendable {
        let name: String
        let title: String?
        let token: String?
        let endpoint: NWEndpoint
        var id: String { name }
    }

    private(set) var studios: [Studio] = []
    private(set) var problem: String?
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_assemblex._tcp", domain: nil), using: .tcp)
        b.stateUpdateHandler = { [weak self] state in
            let msg: String?
            switch state {
            case .failed, .waiting: msg = "找不到電腦時，請到「設定 › 隱私權 › 區域網路」允許 AssembleX"
            default: msg = nil
            }
            Task { @MainActor [weak self] in self?.problem = msg }
        }
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list: [Studio] = results.compactMap { r in
                guard case let .service(name, _, _, _) = r.endpoint else { return nil }
                var title: String?, token: String?
                if case let .bonjour(txt) = r.metadata {
                    title = txt["host"] ?? txt["title"]
                    token = txt["t"]
                }
                return Studio(name: name, title: title, token: token, endpoint: r.endpoint)
            }.sorted { $0.name < $1.name }
            Task { @MainActor [weak self] in self?.studios = list }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    /// 服務名稱 → IPv4 位址與埠（連一次 TCP 再讀對方位址）。
    nonisolated static func resolve(_ studio: Studio) async throws -> LanEndpoint {
        guard let token = studio.token, !token.isEmpty else { throw LinkError.badToken }
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let conn = NWConnection(to: studio.endpoint, using: params)
        let once = Once()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<LanEndpoint, Error>) in
            @Sendable func finish(_ r: Result<LanEndpoint, Error>) {
                guard once.claim() else { return }
                conn.cancel()
                cont.resume(with: r)
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case let .hostPort(host, port)? = conn.currentPath?.remoteEndpoint {
                        var h: String
                        switch host {
                        case let .ipv4(a): h = "\(a)"
                        case let .ipv6(a): h = "\(a)"
                        case let .name(n, _): h = n
                        @unknown default: h = "\(host)"
                        }
                        if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }   // 去掉介面後綴
                        finish(.success(LanEndpoint(host: h, port: Int(port.rawValue), token: token, title: studio.title)))
                    } else {
                        finish(.failure(LinkError.unreachable(host: studio.name, phoneIP: nil, differentSubnet: false)))
                    }
                case .failed, .waiting:
                    finish(.failure(LinkError.unreachable(host: studio.name, phoneIP: nil, differentSubnet: false)))
                default: break
                }
            }
            conn.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                finish(.failure(LinkError.unreachable(host: studio.name, phoneIP: nil, differentSubnet: false)))
            }
        }
    }
}

/// 只允許第一次呼叫通過（continuation 只能 resume 一次）。
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
