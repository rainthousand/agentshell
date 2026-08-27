import AppKit
import Foundation
import WebKit

final class DashboardController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, NSPopoverDelegate {
    private var panel: NSPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var scopeValue: NSTextField!
    private var savingsValue: NSTextField!
    private var timeValue: NSTextField!
    private var allTimeValue: NSTextField!
    private var refreshTimer: Timer?
    private var requestTask: URLSessionDataTask?
    private var localEventMonitor: Any?
    private var globalEventMonitor: Any?
    private var resignActiveObserver: NSObjectProtocol?
    private let dashboardURL: URL
    private let showWindowAtLaunch: Bool

    override init() {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--url"),
           arguments.indices.contains(index + 1),
           let url = URL(string: arguments[index + 1]) {
            dashboardURL = url
        } else {
            dashboardURL = URL(string: "http://127.0.0.1:4317/")!
        }
        showWindowAtLaunch = arguments.contains("--show-window")
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildPopover()
        buildStatusItem()
        resignActiveObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApp,
            queue: .main
        ) { [weak self] _ in
            self?.closePopover()
        }
        refreshMetrics()
        refreshTimer = Timer.scheduledTimer(timeInterval: 5, target: self, selector: #selector(refreshMetrics), userInfo: nil, repeats: true)
        if showWindowAtLaunch { showPanel() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        requestTask?.cancel()
        removePopoverDismissHandlers()
        if let resignActiveObserver {
            NotificationCenter.default.removeObserver(resignActiveObserver)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        panel.orderOut(nil)
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let allowed = url.scheme == "http" && url.host == "127.0.0.1"
        decisionHandler(allowed ? .allow : .cancel)
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        button.title = "AS --"
        button.toolTip = "AgentShell verified savings"
        button.target = self
        button.action = #selector(togglePopover)
    }

    private func buildPopover() {
        let controller = NSViewController()
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 276, height: 202))

        let title = label("AgentShell", size: 13, weight: .semibold, color: .labelColor)
        scopeValue = label("All workspaces", size: 11, weight: .regular, color: .secondaryLabelColor)
        savingsValue = label("--", size: 22, weight: .semibold, color: .labelColor)
        timeValue = label("--", size: 22, weight: .semibold, color: .labelColor)
        allTimeValue = label("All time --", size: 10, weight: .regular, color: .tertiaryLabelColor)

        let savings = metric(title: "Estimated verified context saved", value: savingsValue)
        let time = metric(title: "Verified cache time saved", value: timeValue)
        let metrics = NSStackView(views: [savings, time])
        metrics.orientation = .horizontal
        metrics.distribution = .fillEqually
        metrics.spacing = 18

        let openButton = NSButton(title: "Open dashboard", target: self, action: #selector(showPanel))
        openButton.bezelStyle = .inline
        openButton.controlSize = .small
        let quitButton = NSButton(title: "Quit", target: self, action: #selector(quit))
        quitButton.bezelStyle = .inline
        quitButton.controlSize = .small
        let actions = NSStackView(views: [openButton, NSView(), quitButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY

        let stack = NSStackView(views: [title, scopeValue, metrics, allTimeValue, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.setCustomSpacing(14, after: scopeValue)
        stack.setCustomSpacing(6, after: metrics)
        stack.setCustomSpacing(10, after: allTimeValue)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            metrics.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])

        controller.view = content
        popover.contentViewController = controller
        popover.contentSize = content.frame.size
        popover.behavior = .transient
        popover.delegate = self
        popover.animates = true
    }

    private func metric(title: String, value: NSTextField) -> NSView {
        let caption = label(title, size: 11, weight: .medium, color: .secondaryLabelColor)
        let stack = NSStackView(views: [caption, value])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 7
        return stack
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = NSFont.systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        return field
    }

    private func buildPanel() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 380),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "AgentShell"
        panel.contentView = webView
        panel.delegate = self
        panel.level = .normal
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 340, height: 300)
        panel.maxSize = NSSize(width: 640, height: 560)
        panel.setFrameAutosaveName("AgentShellSavingsPanel")
        panel.center()
        webView.load(URLRequest(url: dashboardURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            refreshMetrics()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            installPopoverDismissHandlers()
        }
    }

    func popoverDidClose(_ notification: Notification) {
        removePopoverDismissHandlers()
    }

    private func closePopover() {
        guard popover.isShown else { return }
        popover.performClose(nil)
    }

    private func installPopoverDismissHandlers() {
        removePopoverDismissHandlers()

        let mouseEvents: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: mouseEvents) { [weak self] event in
            guard let self else { return event }
            self.closePopoverIfClickIsOutside(event)
            return event
        }
        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(matching: mouseEvents) { [weak self] _ in
            DispatchQueue.main.async {
                self?.closePopover()
            }
        }
    }

    private func removePopoverDismissHandlers() {
        if let localEventMonitor {
            NSEvent.removeMonitor(localEventMonitor)
            self.localEventMonitor = nil
        }
        if let globalEventMonitor {
            NSEvent.removeMonitor(globalEventMonitor)
            self.globalEventMonitor = nil
        }
    }

    private func closePopoverIfClickIsOutside(_ event: NSEvent) {
        guard popover.isShown else { return }
        let popoverWindow = popover.contentViewController?.view.window
        let statusWindow = statusItem.button?.window
        if event.window !== popoverWindow && event.window !== statusWindow {
            closePopover()
        }
    }

    @objc private func refreshMetrics() {
        requestTask?.cancel()
        var components = URLComponents(url: dashboardURL.appendingPathComponent("api/metrics"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scope", value: "global")]
        guard let metricsURL = components?.url else {
            renderOffline()
            return
        }
        requestTask = URLSession.shared.dataTask(with: URLRequest(url: metricsURL, cachePolicy: .reloadIgnoringLocalCacheData)) { [weak self] data, _, error in
            guard let self else { return }
            guard error == nil,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dashboard = json["dashboard"] as? [String: Any] else {
                DispatchQueue.main.async { self.renderOffline() }
                return
            }
            let verifiedSavings = dashboard["verifiedSavings"] as? [String: Any]
            let today = verifiedSavings?["today"] as? [String: Any]
            let allTime = verifiedSavings?["allTime"] as? [String: Any]
            let availability = verifiedSavings?["availability"] as? [String: Any]
            let tokensAvailable = availability?["contextTokens"] as? Bool == true
            let timeAvailable = availability?["time"] as? Bool == true
            let tokens = tokensAvailable ? today?["contextTokens"] as? NSNumber : nil
            let time = timeAvailable ? today?["timeMs"] as? NSNumber : nil
            let allTimeTokens = tokensAvailable ? allTime?["contextTokens"] as? NSNumber : nil
            let allTimeMs = timeAvailable ? allTime?["timeMs"] as? NSNumber : nil
            let coverage = dashboard["coverage"] as? [String: Any]
            let freshness = dashboard["freshness"] as? [String: Any]
            let freshnessStatus = freshness?["status"] as? String ?? "unknown"
            let exactAttribution = coverage?["exactAttributionPercent"] as? NSNumber
            let scope = dashboard["scope"] as? String
            DispatchQueue.main.async {
                self.render(
                    tokens: tokensAvailable ? tokens : nil,
                    time: timeAvailable ? time : nil,
                    allTimeTokens: tokensAvailable ? allTimeTokens : nil,
                    allTimeMs: timeAvailable ? allTimeMs : nil,
                    scope: scope,
                    freshness: freshnessStatus,
                    exactAttribution: exactAttribution
                )
            }
        }
        requestTask?.resume()
    }

    private func render(tokens: NSNumber?, time: NSNumber?, allTimeTokens: NSNumber?, allTimeMs: NSNumber?, scope: String?, freshness: String, exactAttribution: NSNumber?) {
        scopeValue.stringValue = scope == "workspace" ? "Today · Project" : "Today · All workspaces"
        let attribution = exactAttribution.map { "\($0.intValue)% exact attribution" } ?? "attribution unavailable"
        statusItem.button?.toolTip = "Estimated context saved from compact output; cache time saved versus measured uncached baseline; data \(freshness); \(attribution); Codex model tokens unavailable"
        if let tokens {
            statusItem.button?.title = "AS \(compactNumber(tokens.intValue))"
            savingsValue.stringValue = formattedNumber(tokens.intValue)
        } else {
            statusItem.button?.title = "AS --"
            savingsValue.stringValue = "--"
        }
        timeValue.stringValue = time.map { formatDuration($0.intValue) } ?? "--"
        let allTokens = allTimeTokens.map { "\(compactNumber($0.intValue)) est. context" } ?? "--"
        let allDuration = allTimeMs.map { formatDuration($0.intValue) } ?? "--"
        allTimeValue.stringValue = "All time  \(allTokens) · \(allDuration)"
    }

    private func renderOffline() {
        statusItem.button?.title = "AS --"
        statusItem.button?.toolTip = "AgentShell metrics unavailable"
        scopeValue.stringValue = "All workspaces"
        savingsValue.stringValue = "--"
        timeValue.stringValue = "--"
        allTimeValue.stringValue = "All time --"
    }

    private func compactNumber(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000).replacingOccurrences(of: ".0M", with: "M") }
        if value >= 1_000 { return String(format: "%.0fK", Double(value) / 1_000) }
        return "\(value)"
    }

    private func formattedNumber(_ value: Int) -> String {
        NumberFormatter.localizedString(from: NSNumber(value: value), number: .decimal)
    }

    private func formatDuration(_ milliseconds: Int) -> String {
        if milliseconds < 1_000 { return "\(milliseconds)ms" }
        if milliseconds < 60_000 { return String(format: "%.1fs", Double(milliseconds) / 1_000) }
        return String(format: "%.1fm", Double(milliseconds) / 60_000)
    }

    @objc private func showPanel() {
        popover.performClose(nil)
        webView.reloadFromOrigin()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let controller = DashboardController()
application.delegate = controller
application.run()
