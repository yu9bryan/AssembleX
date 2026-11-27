import Foundation

enum LinkError: Error, Equatable {
    case badAddress
    case badToken
    case noProject
    case unreachable(host: String, phoneIP: String?, differentSubnet: Bool)
    case badData(String)
    case http(Int)
    /// POST /progress 回 409：桌面已換專案
    case projectChanged

    var message: String {
        switch self {
        case .badAddress:
            return "位址格式不對，請輸入「IP:埠」，例如 192.168.1.23:47820"
        case .badToken:
            return "token 錯誤：桌面 Studio 重開過就會換 token。請重新掃描桌面上的 QR code，或點本頁「同一個 Wi-Fi 上的 Studio」清單裡的電腦重新連線"
        case .noProject:
            return "桌面 Studio 還沒開啟專案"
        case let .unreachable(host, phoneIP, different):
            if host.hasPrefix("127.") || host == "localhost" || host == "::1" {
                return "\(host) 是手機自己，請輸入電腦的 IP（在電腦 Studio 的「手機 AR」視窗可以看到）"
            }
            if different, let phoneIP {
                return "不同網段：手機是 \(phoneIP)，電腦是 \(host)。請讓兩台連到同一個 Wi-Fi"
            }
            return "無法連線到 \(host)：確認桌面 Studio 開著、手機和電腦在同一個 Wi-Fi，並在「設定」允許 AssembleX 使用區域網路"
        case let .badData(s):
            return "看不懂桌面傳來的資料（\(s)），桌面和手機版本可能不一致"
        case .projectChanged:
            return "電腦已切換到其他專案"
        case let .http(code):
            return "桌面回應錯誤（HTTP \(code)）"
        }
    }
}

/// GET /info、/project（協定見 docs/LAN_PROTOCOL.md）。
struct LanClient: Sendable {
    let endpoint: LanEndpoint

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 4
        c.timeoutIntervalForResource = 8
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    func info() async throws -> LanInfo { try await get("/info") }

    /// 電腦狀態：在線（附 /info，可看開著哪個專案）／token 失效／不在線
    enum Reach: Equatable { case online(LanInfo), badToken, offline }

    /// 很快地看一下電腦在不在、開著哪個專案（約 1 秒逾時），給「最近的專案」用
    static func probe(_ ep: LanEndpoint, timeout: TimeInterval = 1) async -> Reach {
        guard let url = ep.url("/info") else { return .offline }
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        guard let (data, resp) = try? await session.data(for: req), let code = (resp as? HTTPURLResponse)?.statusCode else { return .offline }
        if code == 403 { return .badToken }
        guard code == 200, let info = try? JSONDecoder().decode(LanInfo.self, from: data) else { return .offline }
        return .online(info)
    }
    func project() async throws -> LanProject { try await get("/project") }

    /// v1.1：送出手機端進度，回傳新的 seq
    func post(progress: LanProgress) async throws -> LanProgressReply {
        let body = try JSONEncoder().encode(progress)
        return try await get("/progress", body: body)
    }

    private func get<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        guard let url = endpoint.url(path) else { throw LinkError.badAddress }
        var req = URLRequest(url: url)
        if let body {
            req.httpMethod = "POST"
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            let sub = LocalNetwork.sameSubnet(as: endpoint.host)
            throw LinkError.unreachable(host: endpoint.host, phoneIP: sub?.phone, differentSubnet: sub.map { !$0.same } ?? false)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 200: break
        case 403: throw LinkError.badToken
        case 404 where path == "/project": throw LinkError.noProject
        case 409 where path == "/progress": throw LinkError.projectChanged
        default: throw LinkError.http(code)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch let DecodingError.keyNotFound(k, _) {
            throw LinkError.badData("缺少 \(k.stringValue)")
        } catch let DecodingError.typeMismatch(_, ctx) {
            throw LinkError.badData("型別不符：" + ctx.codingPath.map(\.stringValue).joined(separator: "."))
        } catch {
            throw LinkError.badData("JSON 格式錯誤")
        }
    }
}
