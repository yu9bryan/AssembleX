import Foundation

/// 一種元件的定位設定（tools/step_lite.py 從 STEP 自動產生 `<id>.profile.json`）。
/// 新增元件＝把 STEP 丟給 step_lite.py，產生 mesh＋profile 兩個 JSON 放進 Resources，不用改程式。
///
/// 物件座標（和 mesh 一致，公尺）：原點＝底板上表面中心，+Z 朝上，+Y 朝最高的零件那一側。
struct ComponentProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String              // 例："L298N"
    let displayName: String
    let mesh: String            // Resources 內的 mesh 檔名（不含 .json），例："L298N.mesh"
    let boardWidthMM: Double    // 底板 X 方向
    let boardDepthMM: Double    // 底板 Y 方向
    let baseHueMin: Double      // 底板顏色在 CbCr 平面的色相角範圍（度，atan2(Cr−128, Cb−128)）
    let baseHueMax: Double
    var satMin: Int? = nil      // 飽和度門檻，預設 22
    /// CAD 裡底板的顏色（0…1）。實物顏色常和 CAD 不同（例：W5500 實物黃綠 −100°、CAD 深綠 −135°），
    /// 色相範圍依實物設定，CAD 網格則用這個顏色認出底板。
    var baseRGB: [Double]? = nil

    var boardWidth: Double { boardWidthMM / 1000 }
    var boardDepth: Double { boardDepthMM / 1000 }

    /// App bundle 內所有 `*.profile.json`
    static func bundled() -> [ComponentProfile] {
        let urls = Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? []
        return urls.filter { $0.lastPathComponent.hasSuffix(".profile.json") }
            .compactMap { try? JSONDecoder().decode(ComponentProfile.self, from: Data(contentsOf: $0)) }
            .sorted { $0.displayName < $1.displayName }
    }

    static func load(url: URL) -> ComponentProfile? {
        (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(ComponentProfile.self, from: $0) }
    }
}

/// 顏色類別（影像和 CAD 網格用同一套規則，才能互相比對）。
///   0 none（渲染背景）、1 base（底板色）、2 dark（黑／深灰）、3 light（白／銀／淺灰，不計分）、4…9 其他飽和色（每 60° 一格）
/// 用 256×256 的 (Cb, Cr) 查表，每個像素只要一次查表＋一次 Y 比較。
struct ColorClassifier: Sendable {
    static let none: UInt8 = 0, base: UInt8 = 1, dark: UInt8 = 2, light: UInt8 = 3
    static let classCount = 10

    private let lut: [UInt8]        // [cb << 8 | cr] → base / 4…9 / lowSat(255)
    private static let lowSat: UInt8 = 255
    private let baseRGB: [Double]?

    init(profile: ComponentProfile) {
        baseRGB = profile.baseRGB
        let sat = profile.satMin ?? 22
        var t = [UInt8](repeating: Self.lowSat, count: 65536)
        for cb in 0..<256 {
            for cr in 0..<256 {
                let dcb = Double(cb - 128), dcr = Double(cr - 128)
                guard dcb * dcb + dcr * dcr >= Double(sat * sat) else { continue }
                var ang = atan2(dcr, dcb) * 180 / .pi
                if ang < 0 { ang += 360 }
                let lo = profile.baseHueMin < 0 ? profile.baseHueMin + 360 : profile.baseHueMin
                let hi = profile.baseHueMax < 0 ? profile.baseHueMax + 360 : profile.baseHueMax
                let inBase = lo <= hi ? (ang >= lo && ang <= hi) : (ang >= lo || ang <= hi)
                t[cb << 8 | cr] = inBase ? Self.base : UInt8(4 + min(5, Int(ang / 60)))
            }
        }
        lut = t
    }

    /// darkY：影像用 70（真實黑色零件），CAD 顏色用 100（CAD 的深灰常是 0.3）
    @inline(__always)
    func classify(y: UInt8, cb: UInt8, cr: UInt8, darkY: Int = 70) -> UInt8 {
        let c = lut[Int(cb) << 8 | Int(cr)]
        if c == Self.base { return y >= 30 ? Self.base : Self.dark }
        if c != Self.lowSat { return c }
        return Int(y) < darkY ? Self.dark : Self.light
    }

    func classify(rgb r: Double, _ g: Double, _ b: Double) -> UInt8 {
        if let c = baseRGB, abs(c[0] - r) + abs(c[1] - g) + abs(c[2] - b) < 0.03 { return Self.base }
        let R = r * 255, G = g * 255, B = b * 255
        let y = 0.299 * R + 0.587 * G + 0.114 * B
        let cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B
        let cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B
        func u8(_ v: Double) -> UInt8 { UInt8(max(0, min(255, v.rounded()))) }
        return classify(y: u8(y), cb: u8(cb), cr: u8(cr), darkY: 100)
    }

    func isBase(y: UInt8, cb: UInt8, cr: UInt8) -> Bool { classify(y: y, cb: cb, cr: cr) == Self.base }
}
