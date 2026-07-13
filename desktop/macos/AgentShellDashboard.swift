import AppKit
import WebKit

final class DashboardController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var panel: NSPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var alwaysOnTopItem: NSMenuItem!
    private let dashboardURL: URL

    override init() {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--url"), arguments.indices.contains(index + 1), let url = URL(string: arguments[index + 1]) {
            dashboardURL = url
        } else {
            dashboardURL = URL(string: "http://127.0.0.1:4317/")!
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildStatusItem()
        showPanel()
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
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 280, height: 140)
        panel.maxSize = NSSize(width: 480, height: 260)
        panel.setFrameAutosaveName("AgentShellSavingsPanel")
        positionPanel()
        webView.load(URLRequest(url: dashboardURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "AS"
        statusItem.button?.toolTip = "AgentShell Dashboard"

        let menu = NSMenu()
        let showItem = NSMenuItem(title: "Show Dashboard", action: #selector(showPanel), keyEquivalent: "")
        showItem.target = self
        menu.addItem(showItem)

        let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refresh), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        alwaysOnTopItem = NSMenuItem(title: "Always on Top", action: #selector(toggleAlwaysOnTop), keyEquivalent: "")
        alwaysOnTopItem.target = self
        alwaysOnTopItem.state = .on
        menu.addItem(alwaysOnTopItem)
        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit AgentShell Dashboard", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    private func positionPanel() {
        guard let screen = NSScreen.main else {
            panel.center()
            return
        }
        let visible = screen.visibleFrame
        let frame = panel.frame
        panel.setFrameOrigin(NSPoint(x: visible.maxX - frame.width - 22, y: visible.maxY - frame.height - 22))
    }

    @objc private func showPanel() {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func refresh() {
        webView.reloadFromOrigin()
        showPanel()
    }

    @objc private func toggleAlwaysOnTop() {
        let floating = panel.level != .floating
        panel.level = floating ? .floating : .normal
        panel.isFloatingPanel = floating
        alwaysOnTopItem.state = floating ? .on : .off
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let controller = DashboardController()
application.delegate = controller
application.run()
