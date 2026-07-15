import AppKit
import Foundation
import WebKit

final class DashboardController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var panel: NSPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var scopeValue: NSTextField!
    private var savingsValue: NSTextField!
    private var timeValue: NSTextField!
    private var refreshTimer: Timer?
    private var requestTask: URLSessionDataTask?
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
        refreshMetrics()
        refreshTimer = Timer.scheduledTimer(timeInterval: 5, target: self, selector: #selector(refreshMetrics), userInfo: nil, repeats: true)
        if showWindowAtLaunch { showPanel() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        requestTask?.cancel()
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
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 276, height: 184))

        let title = label("AgentShell", size: 13, weight: .semibold, color: .labelColor)
        scopeValue = label("All workspaces", size: 11, weight: .regular, color: .secondaryLabelColor)
        savingsValue = label("--", size: 22, weight: .semibold, color: .labelColor)
        timeValue = label("--", size: 22, weight: .semibold, color: .labelColor)

        let savings = metric(title: "Verified tokens saved", value: savingsValue)
        let time = metric(title: "Verified time saved", value: timeValue)
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

        let stack = NSStackView(views: [title, scopeValue, metrics, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.setCustomSpacing(14, after: scopeValue)
        stack.setCustomSpacing(13, after: metrics)
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
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 170),
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
        panel.minSize = NSSize(width: 280, height: 140)
        panel.maxSize = NSSize(width: 480, height: 260)
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
                  let dashboard = json["dashboard"] as? [String: Any],
                  let totals = dashboard["totals"] as? [String: Any] else {
                DispatchQueue.main.async { self.renderOffline() }
                return
            }
            let tokens = totals["estimatedContextAvoidedTokens"] as? NSNumber
            let time = totals["estimatedTimeSavedMs"] as? NSNumber
            let coverage = dashboard["coverage"] as? [String: Any]
            let freshness = dashboard["freshness"] as? [String: Any]
            let tokensAvailable = coverage?["verifiedTokenSavingsAvailable"] as? Bool ?? (tokens != nil)
            let timeAvailable = coverage?["verifiedTimeSavingsAvailable"] as? Bool ?? (time != nil)
            let freshnessStatus = freshness?["status"] as? String ?? "unknown"
            let exactAttribution = coverage?["exactAttributionPercent"] as? NSNumber
            let scope = dashboard["scope"] as? String
            DispatchQueue.main.async {
                self.render(
                    tokens: tokensAvailable ? tokens : nil,
                    time: timeAvailable ? time : nil,
                    scope: scope,
                    freshness: freshnessStatus,
                    exactAttribution: exactAttribution
                )
            }
        }
        requestTask?.resume()
    }

    private func render(tokens: NSNumber?, time: NSNumber?, scope: String?, freshness: String, exactAttribution: NSNumber?) {
        scopeValue.stringValue = scope == "workspace" ? "Project" : "All workspaces"
        let attribution = exactAttribution.map { "\($0.intValue)% exact attribution" } ?? "attribution unavailable"
        statusItem.button?.toolTip = "AgentShell local tooling; data \(freshness); \(attribution); Codex model tokens unavailable"
        if let tokens {
            statusItem.button?.title = "AS \(compactNumber(tokens.intValue))"
            savingsValue.stringValue = "\(formattedNumber(tokens.intValue)) tokens"
        } else {
            statusItem.button?.title = "AS --"
            savingsValue.stringValue = "--"
        }
        timeValue.stringValue = time.map { formatDuration($0.intValue) } ?? "--"
    }

    private func renderOffline() {
        statusItem.button?.title = "AS --"
        statusItem.button?.toolTip = "AgentShell metrics unavailable"
        scopeValue.stringValue = "All workspaces"
        savingsValue.stringValue = "--"
        timeValue.stringValue = "--"
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
