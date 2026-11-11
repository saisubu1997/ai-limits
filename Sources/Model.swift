import Foundation
import Combine

// MARK: - Data model (mirrors fetch.py output)

struct LimitsDocument: Codable {
    let generatedAt: String?
    let providers: [ProviderLimit]

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case providers
    }
}

struct ProviderLimit: Codable, Identifiable {
    let id: String
    let name: String
    let vendor: String
    let plan: String?
    let account: String?
    let ok: Bool
    let stale: Bool
    let error: String?
    let metrics: [LimitMetric]
    let notes: [String]
    let fetchedAt: String?
    let status: ProviderStatus?

    enum CodingKeys: String, CodingKey {
        case id, name, vendor, plan, account, ok, stale, error, metrics, notes, status
        case fetchedAt = "fetched_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id.capitalized
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor) ?? ""
        plan = try c.decodeIfPresent(String.self, forKey: .plan)
        account = try c.decodeIfPresent(String.self, forKey: .account)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale) ?? false
        error = try c.decodeIfPresent(String.self, forKey: .error)
        metrics = try c.decodeIfPresent([LimitMetric].self, forKey: .metrics) ?? []
        notes = try c.decodeIfPresent([String].self, forKey: .notes) ?? []
        fetchedAt = try c.decodeIfPresent(String.self, forKey: .fetchedAt)
        status = try c.decodeIfPresent(ProviderStatus.self, forKey: .status)
    }
}

struct ProviderStatus: Codable {
    let running: Bool
    let sessions: Int
    let state: String
    let sessionName: String?

    enum CodingKeys: String, CodingKey {
        case running, sessions, state
        case sessionName = "session_name"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "idle"
        sessionName = try c.decodeIfPresent(String.self, forKey: .sessionName)
    }
}

struct LimitMetric: Codable, Identifiable {
    let id: String
    let label: String
    let sublabel: String
    let usedPct: Double?
    let remainingPct: Double?
    let resetAt: String?
    let windowSecs: Double?
    let valueText: String?
    let detailText: String?

    enum CodingKeys: String, CodingKey {
        case id, label, sublabel
        case usedPct = "used_pct"
        case remainingPct = "remaining_pct"
        case resetAt = "reset_at"
        case windowSecs = "window_secs"
        case valueText = "value_text"
        case detailText = "detail_text"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "Limit"
        sublabel = try c.decodeIfPresent(String.self, forKey: .sublabel) ?? ""
        usedPct = try c.decodeIfPresent(Double.self, forKey: .usedPct)
        remainingPct = try c.decodeIfPresent(Double.self, forKey: .remainingPct)
        resetAt = try c.decodeIfPresent(String.self, forKey: .resetAt)
        windowSecs = try c.decodeIfPresent(Double.self, forKey: .windowSecs)
        valueText = try c.decodeIfPresent(String.self, forKey: .valueText)
        detailText = try c.decodeIfPresent(String.self, forKey: .detailText)
    }

    var remaining: Double {
        if let r = remainingPct { return max(0, min(100, r)) }
        if let u = usedPct { return max(0, min(100, 100 - u)) }
        return 0
    }
}

// MARK: - Store

final class LimitsStore: ObservableObject {
    @Published var doc: LimitsDocument?
    @Published var busy = false
    @Published var problem: String?
    @Published var lastRun: Date?

    private var timer: Timer?
    private var running = false

    static let dataDir: URL = {
        if let override = ProcessInfo.processInfo.environment["AILIMITS_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".limitswidget", isDirectory: true)
    }()
    static var dataURL: URL { dataDir.appendingPathComponent("data.json") }

    func start() {
        load()
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func load() {
        guard let data = try? Data(contentsOf: Self.dataURL),
              let parsed = try? JSONDecoder().decode(LimitsDocument.self, from: data) else {
            return
        }
        doc = parsed
        if let stamp = Self.parseDate(parsed.generatedAt) { lastRun = stamp }
    }

    func refresh() {
        guard !running else { return }
        running = true
        busy = true

        guard let script = Self.scriptURL() else {
            running = false
            busy = false
            problem = "fetch.py is missing from the app bundle"
            return
        }

        let outURL = Self.dataURL
        DispatchQueue.global(qos: .utility).async {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            proc.arguments = [script.path, "--out", outURL.path]
            let errPipe = Pipe()
            proc.standardError = errPipe
            proc.standardOutput = Pipe()
            var failure: String?
            do {
                try proc.run()
                proc.waitUntilExit()
                if proc.terminationStatus != 0 {
                    let data = errPipe.fileHandleForReading.readDataToEndOfFile()
                    failure = String(data: data, encoding: .utf8)?
                        .split(separator: "\n").last.map(String.init)
                        ?? "fetch failed"
                }
            } catch {
                failure = error.localizedDescription
            }

            DispatchQueue.main.async {
                self.running = false
                self.busy = false
                self.problem = failure
                self.load()
            }
        }
    }

    private static func scriptURL() -> URL? {
        if let bundled = Bundle.main.url(forResource: "fetch", withExtension: "py") {
            return bundled
        }
        // Development fallback: alongside the binary's folder tree.
        let exe = Bundle.main.executableURL?.deletingLastPathComponent()
        let candidates = [
            exe?.deletingLastPathComponent().appendingPathComponent("fetch.py"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("fetch.py"),
        ]
        return candidates.compactMap { $0 }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func parseDate(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: string) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: string) { return d }
        // Some payloads carry microseconds; trim to milliseconds and retry.
        if let dot = string.firstIndex(of: "."), string.count > 24 {
            let head = String(string[..<dot])
            let tail = string[string.index(after: dot)...]
            let millis = String(tail.prefix(3))
            let suffix = tail.drop { $0.isNumber }
            return withFraction.date(from: head + "." + millis + suffix)
        }
        return nil
    }
}
