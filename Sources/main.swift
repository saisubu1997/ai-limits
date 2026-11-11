import AppKit
import SwiftUI
import Combine
import Security
import CommonCrypto

// MARK: - Claude safeStorage key

/// Claude Desktop encrypts its token cache with a key derived from a Keychain
/// password. Reading it prompts once; the derived key is cached next to the
/// widget data so later runs never touch the Keychain again.
enum ClaudeKey {
    static var path: URL { LimitsStore.dataDir.appendingPathComponent("claude_aes_key") }

    static func ensure() {
        if let existing = try? String(contentsOf: path, encoding: .utf8), existing.count == 32 {
            return
        }
        guard let password = readPassword(), !password.isEmpty else { return }

        var key = [UInt8](repeating: 0, count: 16)
        let status = password.withCString { cstr -> Int in
            Int(CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2), cstr, strlen(cstr),
                "saltysalt", 9,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003,
                &key, 16))
        }
        guard status == Int(kCCSuccess) else { return }

        let fm = FileManager.default
        try? fm.createDirectory(at: LimitsStore.dataDir, withIntermediateDirectories: true)
        let hex = key.map { String(format: "%02x", $0) }.joined()
        try? hex.write(to: path, atomically: true, encoding: .utf8)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    private static func readPassword() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Safe Storage",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let secret = String(data: data, encoding: .utf8) {
            return secret
        }

        // Fallback for environments where the app itself is not trusted yet.
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        proc.arguments = ["find-generic-password", "-s", "Claude Safe Storage", "-w"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Antigravity credential

/// The Antigravity desktop app keeps its Google session in a Keychain item
/// (service "gemini", account "antigravity"). Copy it out once so the fetcher
/// never has to touch the Keychain again.
enum AntigravitySecret {
    static var path: URL { LimitsStore.dataDir.appendingPathComponent("antigravity_secret.txt") }

    static func ensure() {
        if let existing = try? String(contentsOf: path, encoding: .utf8),
           existing.hasPrefix("go-keyring-base64:") {
            return
        }
        guard let secret = read() else { return }
        try? FileManager.default.createDirectory(at: LimitsStore.dataDir,
                                                 withIntermediateDirectories: true)
        try? secret.write(to: path, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                               ofItemAtPath: path.path)
    }

    private static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "gemini",
            kSecAttrAccount as String: "antigravity",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let secret = String(data: data, encoding: .utf8) {
            return secret
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        proc.arguments = ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Window dragging

/// SwiftUI's hosting view consumes background mouse events, so AppKit's
/// `isMovableByWindowBackground` never fires. A local event monitor sees every
/// drag in this process no matter which view claimed it, which makes the whole
/// card draggable while leaving clicks on buttons untouched.
final class WindowDragController {
    weak var window: NSWindow?
    private var monitor: Any?
    private var startOrigin: NSPoint?
    private var startMouse: NSPoint?
    private var didMove = false

    func attach(to window: NSWindow) {
        self.window = window
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            guard let self else { return event }
            return self.handle(event) ? nil : event
        }
    }

    /// Returns true when the event should be swallowed (so a drag does not
    /// also register as a click on whatever control it started over).
    private func handle(_ event: NSEvent) -> Bool {
        guard let window, event.window === window else { return false }
        switch event.type {
        case .leftMouseDown:
            startOrigin = window.frame.origin
            startMouse = NSEvent.mouseLocation
            didMove = false
        case .leftMouseDragged:
            guard let origin = startOrigin, let mouse = startMouse else { return false }
            let now = NSEvent.mouseLocation
            let target = NSPoint(x: origin.x + (now.x - mouse.x),
                                 y: origin.y + (now.y - mouse.y))
            window.setFrameOrigin(target)
            clampToVisibleArea(window)
            didMove = true
        case .leftMouseUp:
            if didMove {
                let frame = window.frame
                UserDefaults.standard.set("\(frame.origin.x),\(frame.maxY)", forKey: "panelTop")
                UserDefaults.standard.set("free", forKey: "panelAnchor")
            }
            let consumed = didMove
            startOrigin = nil
            startMouse = nil
            didMove = false
            return consumed
        default:
            break
        }
        return false
    }
}

// MARK: - Screen clamping

/// Keeps the card fully inside the usable area, so it can never end up behind
/// the Dock or off the edge when its height changes.
func clampToVisibleArea(_ window: NSWindow, origin: NSPoint? = nil) {
    guard let area = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
    let margin: CGFloat = 6
    let safe = area.insetBy(dx: margin, dy: margin)
    var frame = window.frame
    if let proposed = origin { frame.origin = proposed }

    if frame.height <= safe.height {
        if frame.maxY > safe.maxY { frame.origin.y = safe.maxY - frame.height }
        if frame.minY < safe.minY { frame.origin.y = safe.minY }
    } else {
        frame.origin.y = safe.maxY - frame.height      // taller than the screen: keep the top
    }
    if frame.width <= safe.width {
        if frame.maxX > safe.maxX { frame.origin.x = safe.maxX - frame.width }
        if frame.minX < safe.minX { frame.origin.x = safe.minX }
    }
    if frame.origin != window.frame.origin {
        window.setFrameOrigin(frame.origin)
    }
}

// MARK: - Panel

final class WidgetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: WidgetPanel?
    private var statusItem: NSStatusItem?
    private let store = LimitsStore()
    private let drag = WindowDragController()
    private var cancellables = Set<AnyCancellable>()
    private let width: CGFloat = 336

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildStatusItem()
        store.start()

        DispatchQueue.global(qos: .utility).async {
            ClaudeKey.ensure()
            AntigravitySecret.ensure()
            DispatchQueue.main.async { [weak self] in self?.store.refresh() }
        }

        store.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { self?.resizePanel() }
            }
            .store(in: &cancellables)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.resizePanel() }
    }



    /// Render the widget offscreen; used to check layout without a screenshot.
    func writeSnapshot(to path: String) {
        store.load()
        let root = WidgetView(store: store, onRefresh: {}, onOpen: { _ in })
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(x: 0, y: 0, width: width, height: 200)
        host.layoutSubtreeIfNeeded()
        let height = max(140, ceil(host.fittingSize.height))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
        }
    }

    // MARK: window

    /// Just above the desktop icon layer: on the wallpaper, under normal windows.
    private var desktopLevel: NSWindow.Level {
        NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    }

    private func buildPanel() {
        let root = WidgetView(
            store: store,
            onRefresh: { [weak self] in self?.store.refresh() },
            onOpen: { [weak self] id in self?.openProvider(id) }
        )
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(x: 0, y: 0, width: width, height: 320)
        host.autoresizingMask = [.width, .height]

        let panel = WidgetPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: 320),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        // Desktop layer only: never floats above other windows.
        panel.level = desktopLevel
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.contentView = host
        panel.menu = contextMenu()
        self.panel = panel
        drag.attach(to: panel)

        restorePosition()
        panel.orderFrontRegardless()
    }

    private func resizePanel() {
        guard let panel, let host = panel.contentView else { return }
        let fitting = host.fittingSize
        let height = max(140, ceil(fitting.height))
        guard abs(panel.frame.height - height) > 0.5 else { return }

        let old = panel.frame
        let safeBottom = ((panel.screen ?? NSScreen.main)?.visibleFrame.minY ?? 0) + 6

        var frame = old
        frame.size = NSSize(width: width, height: height)
        // Deterministic: the top edge stays put, so the card grows downward.
        frame.origin.y = old.maxY - height
        // Unless that would push it under the Dock - then hold the bottom edge
        // and grow upward instead.
        if frame.minY < safeBottom {
            frame.origin.y = old.minY
        }

        panel.setFrame(frame, display: true, animate: false)
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        if anchor != "free" { restorePosition() } else { clampToVisibleArea(panel) }
    }

    /// "tr", "tl", "br", "bl", "cr" or "free" when the user dragged it somewhere.
    private var anchor: String {
        UserDefaults.standard.string(forKey: "panelAnchor") ?? "tr"
    }

    /// Top-left corner in screen coordinates; y is the top edge.
    private func storedTopLeft() -> NSPoint? {
        if let saved = UserDefaults.standard.string(forKey: "panelTop") {
            let parts = saved.split(separator: ",").compactMap { Double($0) }
            if parts.count == 2 { return NSPoint(x: parts[0], y: parts[1]) }
        }
        // Migrate the old bottom-origin value once.
        if let saved = UserDefaults.standard.string(forKey: "panelOrigin"),
           let panel {
            let parts = saved.split(separator: ",").compactMap { Double($0) }
            if parts.count == 2 { return NSPoint(x: parts[0], y: parts[1] + panel.frame.height) }
        }
        return nil
    }

    private func corner(_ key: String, size: NSSize) -> NSPoint? {
        guard key != "free", let area = NSScreen.main?.visibleFrame else { return nil }
        let m: CGFloat = 24
        switch key {
        case "tl": return NSPoint(x: area.minX + m, y: area.maxY - size.height - m)
        case "tr": return NSPoint(x: area.maxX - size.width - m, y: area.maxY - size.height - m)
        case "bl": return NSPoint(x: area.minX + m, y: area.minY + m)
        case "br": return NSPoint(x: area.maxX - size.width - m, y: area.minY + m)
        case "cr": return NSPoint(x: area.maxX - size.width - m, y: area.midY - size.height / 2)
        default: return nil
        }
    }

    /// Keeps the card glued to its corner when it grows or shrinks.
    private func restorePosition() {
        guard let panel else { return }
        if let point = corner(anchor, size: panel.frame.size) {
            panel.setFrameOrigin(point)
        } else if let topLeft = storedTopLeft() {
            panel.setFrameOrigin(NSPoint(x: topLeft.x, y: topLeft.y - panel.frame.height))
        }
        clampToVisibleArea(panel)
    }

    private func contextMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh now", action: #selector(menuRefresh), keyEquivalent: "r")
            .target = self
        let move = NSMenuItem(title: "Move to", action: nil, keyEquivalent: "")
        move.submenu = positionMenu()
        menu.addItem(move)
        menu.addItem(withTitle: "Reset position", action: #selector(resetPosition), keyEquivalent: "")
            .target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit AI Limits", action: #selector(quit), keyEquivalent: "q")
            .target = self
        return menu
    }

    private func positionMenu() -> NSMenu {
        let sub = NSMenu()
        let spots = [("Top right", "tr"), ("Top left", "tl"),
                     ("Middle right", "cr"), ("Bottom right", "br"), ("Bottom left", "bl")]
        for (title, key) in spots {
            let item = NSMenuItem(title: title, action: #selector(snapTo(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            sub.addItem(item)
        }
        return sub
    }

    @objc private func menuRefresh() { store.refresh() }

    /// Menu-driven placement, useful when other windows hide the card.
    @objc private func snapTo(_ sender: NSMenuItem) {
        guard let panel, let screen = NSScreen.main else { return }
        let area = screen.visibleFrame
        let size = panel.frame.size
        let margin: CGFloat = 24
        let spots: [String: NSPoint] = [
            "tl": NSPoint(x: area.minX + margin, y: area.maxY - size.height - margin),
            "tr": NSPoint(x: area.maxX - size.width - margin, y: area.maxY - size.height - margin),
            "bl": NSPoint(x: area.minX + margin, y: area.minY + margin),
            "br": NSPoint(x: area.maxX - size.width - margin, y: area.minY + margin),
            "cr": NSPoint(x: area.maxX - size.width - margin,
                          y: area.midY - size.height / 2),
        ]
        guard let key = sender.representedObject as? String, spots[key] != nil else { return }
        UserDefaults.standard.set(key, forKey: "panelAnchor")
        restorePosition()
    }

    @objc private func resetPosition() {
        UserDefaults.standard.set("tr", forKey: "panelAnchor")
        UserDefaults.standard.removeObject(forKey: "panelOrigin")
        restorePosition()
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: status item

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "gauge.with.dots.needle.33percent",
                                     accessibilityDescription: "AI Limits")
        item.button?.image?.isTemplate = true

        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh now", action: #selector(menuRefresh), keyEquivalent: "r")
            .target = self
        menu.addItem(withTitle: "Show / hide widget", action: #selector(toggleVisibility), keyEquivalent: "")
            .target = self
        let move = NSMenuItem(title: "Move to", action: nil, keyEquivalent: "")
        move.submenu = positionMenu()
        menu.addItem(move)
        menu.addItem(.separator())
        for (title, id) in [("Open Claude", "claude"), ("Open Codex", "codex"), ("Open Antigravity", "antigravity")] {
            let entry = NSMenuItem(title: title, action: #selector(openFromMenu(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = id
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit AI Limits", action: #selector(quit), keyEquivalent: "q")
            .target = self
        item.menu = menu
        statusItem = item
    }

    @objc private func toggleVisibility() {
        guard let panel else { return }
        if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    @objc private func openFromMenu(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { openProvider(id) }
    }

    private func openProvider(_ id: String) {
        guard let url = AppIcons.appURL(for: id) else { return }
        NSWorkspace.shared.openApplication(at: url,
                                           configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
    }
}

let app = NSApplication.shared

if let flag = CommandLine.arguments.firstIndex(of: "--snapshot"),
   flag + 1 < CommandLine.arguments.count {
    let delegate = AppDelegate()
    delegate.writeSnapshot(to: CommandLine.arguments[flag + 1])
    exit(0)
}

let delegate = AppDelegate()
app.delegate = delegate
app.run()
