import SwiftUI
import AppKit

// MARK: - Palette

enum Palette {
    static func accent(for id: String) -> Color {
        switch id {
        case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
        case "codex": return Color(red: 0.10, green: 0.64, blue: 0.51)
        case "antigravity": return Color(red: 0.32, green: 0.55, blue: 0.97)
        case "deepseek": return Color(red: 0.33, green: 0.45, blue: 0.95)
        default: return .accentColor
        }
    }

    /// Colour of a bar, by how much is left.
    static func level(_ remaining: Double) -> Color {
        if remaining < 20 { return Color(red: 0.98, green: 0.29, blue: 0.25) }
        if remaining < 50 { return Color(red: 0.98, green: 0.62, blue: 0.12) }
        return Color(red: 0.24, green: 0.78, blue: 0.38)
    }
}

// MARK: - App icons

enum AppIcons {
    /// Bundle identifiers first: users may keep these apps outside /Applications.
    static let bundleIDs: [String: String] = [
        "claude": "com.anthropic.claudefordesktop",
        "codex": "com.openai.codex",
        "antigravity": "com.google.antigravity",
        "deepseek": "com.deepseek.dsh",
    ]

    static let fallbackPaths: [String: String] = [
        "claude": "/Applications/Claude.app",
        "codex": "/Applications/ChatGPT.app",
        "antigravity": "/Applications/Antigravity.app",
        "deepseek": "/Applications/DeepSeek Harness.app",
    ]

    private static var cache: [String: NSImage] = [:]

    static func appURL(for id: String) -> URL? {
        if let bundleID = bundleIDs[id],
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            return url
        }
        if let path = fallbackPaths[id], FileManager.default.fileExists(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    static func icon(for id: String) -> NSImage? {
        if let hit = cache[id] { return hit }
        guard let url = appURL(for: id) else { return nil }
        let image = NSWorkspace.shared.icon(forFile: url.path)
        image.size = NSSize(width: 64, height: 64)
        cache[id] = image
        return image
    }
}

// MARK: - Frosted backdrop

/// Native vibrancy behind the card, so it matches the system widgets rather than
/// looking like a flat translucent rectangle.
struct FrostedBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        view.isEmphasized = false
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

// MARK: - Widget

struct WidgetView: View {
    @ObservedObject var store: LimitsStore
    var onRefresh: () -> Void
    var onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if let doc = store.doc {
                ForEach(doc.providers) { provider in
                    ProviderCard(provider: provider, onOpen: onOpen)
                }
            } else {
                loadingState
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(width: 336)
        .background(backdrop)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(0.07), lineWidth: 0.8)
        )
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onHover { inside in
            (inside ? NSCursor.openHand : NSCursor.arrow).set()
        }
    }

    /// Real vibrancy on screen; a solid tone when rendering an offscreen preview,
    /// because NSVisualEffectView has nothing to blend against there.
    @ViewBuilder private var backdrop: some View {
        if ProcessInfo.processInfo.arguments.contains("--snapshot") {
            Color(red: 0.11, green: 0.11, blue: 0.125)
        } else {
            ZStack {
                FrostedBackground()
                Color.black.opacity(0.30)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("Limits")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
            Spacer()
            Text(updatedLabel)
                .font(.system(size: 9.5))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .opacity(store.busy ? 0.3 : 0.75)
                    .frame(width: 16, height: 16)
            }
            .buttonStyle(.plain)
            .help("Refresh now")
        }
        .padding(.bottom, 2)
    }

    private var loadingState: some View {
        VStack(alignment: .leading, spacing: 6) {
            ProgressView().controlSize(.small)
            Text(store.problem ?? "Reading usage\u{2026}")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 28)
    }

    private var updatedLabel: String {
        guard let date = store.lastRun else { return "" }
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f.string(from: date)
    }
}

// MARK: - Provider card

struct ProviderCard: View {
    let provider: ProviderLimit
    var onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                badge
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 5) {
                        Text(provider.name)
                            .font(.system(size: 12.5, weight: .semibold))
                        if let plan = provider.plan, !plan.isEmpty {
                            Text(plan.uppercased())
                                .font(.system(size: 8, weight: .bold))
                                .tracking(0.3)
                                .padding(.horizontal, 4.5)
                                .padding(.vertical, 1.5)
                                .background(
                                    Capsule().fill(Palette.accent(for: provider.id).opacity(0.18))
                                )
                                .foregroundStyle(Palette.accent(for: provider.id))
                        }
                        if provider.stale {
                            Image(systemName: "clock.arrow.circlepath")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(.orange)
                        }
                    }
                    Text(subtitle)
                        .font(.system(size: 9.5, weight: hasSession ? .medium : .regular))
                        .foregroundStyle(hasSession
                                         ? Palette.accent(for: provider.id).opacity(0.9)
                                         : Color.secondary.opacity(0.75))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 2)
                statusBadge
                openButton
            }

            if provider.ok && !provider.metrics.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(provider.metrics) { metric in
                        MetricRow(metric: metric)
                    }
                }
                .padding(.top, 1)
            } else {
                unavailable
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.primary.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.05), lineWidth: 0.7)
        )
    }

    // MARK: live status

    private var statusText: String {
        guard let s = provider.status else { return "" }
        if s.state == "waiting" { return "Needs you" }
        if !s.running { return s.sessions > 0 ? "\(s.sessions) recent" : "Not open" }
        if s.state == "working" { return "Working" }
        if s.sessions > 0 { return "\(s.sessions) active" }
        return "Running"
    }

    private var statusColor: Color {
        guard let s = provider.status else { return .secondary }
        if s.state == "waiting" { return .orange }
        if !s.running { return .secondary.opacity(0.75) }
        return Color(red: 0.24, green: 0.78, blue: 0.38)
    }

    @ViewBuilder private var statusBadge: some View {
        if provider.status != nil {
            HStack(spacing: 3.5) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 5, height: 5)
                Text(statusText)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(statusColor)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 2.5)
            .background(
                Capsule().fill(statusColor.opacity(provider.status?.state == "waiting" ? 0.16 : 0.08))
            )
            .fixedSize()
            .help(provider.status?.state == "waiting"
                  ? "\(provider.name) is waiting for your input"
                  : "\(provider.name): \(statusText)")
        }
    }

    @ViewBuilder private var openButton: some View {
        Button {
            onOpen(provider.id)
        } label: {
            Group {
                if let icon = AppIcons.icon(for: provider.id) {
                    Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 17, height: 17)
                    .clipShape(RoundedRectangle(cornerRadius: 4.5, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.6)
                    )
                    .opacity(0.95)
                } else {
                    Image(systemName: "arrow.up.forward.app")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 17, height: 17)
                }
            }
        }
        .buttonStyle(.plain)
        .help("Open " + provider.name)
    }

    private var subtitle: String {
        if let session = provider.status?.sessionName, !session.isEmpty {
            return "\u{25B8} " + session
        }
        var parts: [String] = []
        if !provider.vendor.isEmpty { parts.append(provider.vendor) }
        if let account = provider.account, !account.isEmpty { parts.append(account) }
        return parts.joined(separator: " \u{00B7} ")
    }

    private var hasSession: Bool {
        (provider.status?.sessionName?.isEmpty == false)
    }

    private var badge: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Palette.accent(for: provider.id).opacity(0.17))
            Text(String(provider.name.prefix(1)))
                .font(.system(size: 11.5, weight: .bold, design: .rounded))
                .foregroundStyle(Palette.accent(for: provider.id))
        }
        .frame(width: 24, height: 24)
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(provider.error ?? "No limit data available")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                onOpen(provider.id)
            } label: {
                Text("Open " + provider.name)
                    .font(.system(size: 10, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.accent(for: provider.id))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    }
}

// MARK: - Metric row

struct MetricRow: View {
    let metric: LimitMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(metric.label)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if let value = metric.valueText {
                    Text(value)
                        .font(.system(size: 14, weight: .semibold))
                        .monospacedDigit()
                } else {
                    Text(percentLabel)
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Palette.level(metric.remaining))
                }
            }
            if metric.remainingPct != nil { bar }
            HStack(spacing: 3) {
                Image(systemName: glyph)
                    .font(.system(size: 8, weight: .semibold))
                    .opacity(0.8)
                Text(metric.sublabel)
                if let detail = metric.detailText, !detail.isEmpty {
                    Text("\u{00B7}")
                    Text(detail)
                } else if let reset = resetLabel {
                    Text("\u{00B7}")
                    Text(reset)
                }
                Spacer(minLength: 0)
            }
            .font(.system(size: 9))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
    }

    private var glyph: String {
        switch metric.id {
        case "session": return "clock"
        case "weekly": return "calendar"
        case "credits": return "creditcard"
        default: return "chart.bar"
        }
    }

    private var bar: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let fraction = CGFloat(metric.remaining / 100.0)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.09))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [Palette.level(metric.remaining).opacity(0.75),
                                     Palette.level(metric.remaining)],
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
                    .frame(width: max(4, width * fraction))
                    .animation(.easeOut(duration: 0.3), value: fraction)
            }
        }
        .frame(height: 6)
    }

    private var percentLabel: String {
        String(format: "%.0f%% left", metric.remaining)
    }

    private var resetLabel: String? {
        guard let date = LimitsStore.parseDate(metric.resetAt) else {
            return metric.remaining >= 99.5 ? "fresh window" : nil
        }
        let seconds = date.timeIntervalSinceNow
        if seconds <= 0 { return "resetting" }
        let total = Int(seconds)
        let days = total / 86400
        let hours = (total % 86400) / 3600
        let minutes = (total % 3600) / 60
        if days > 0 { return "resets in \(days)d \(hours)h" }
        if hours > 0 { return "resets in \(hours)h \(minutes)m" }
        return "resets in \(max(1, minutes))m"
    }
}
