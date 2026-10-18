// Grunter: a small Mac app that turns one master key visual into many ratio adapts in Adobe Illustrator.
//
// The window is a WKWebView showing Resources/web/index.html (served on the grunter:// scheme).
// The page calls window.webkit.messageHandlers.grunter.postMessage({ cmd, payload }) and gets a reply:
//   analyse  read a master (and export its preview)     -> engine in tool mode, no document changes
//   make     build the adapt artboards                   -> engine adds artboards, never saves
//   pick     native file chooser for a photo
//   loadAll / save   settings and learned roles, kept in ~/Library/Application Support/Grunter/store.json
// Illustrator is driven through osascript running Resources/adapt_maker.jsx with an ADAPT_JOB.
// Everything stays on this Mac; nothing needs the internet.

import Cocoa
import UniformTypeIdentifiers
import WebKit

final class Bridge: NSObject, WKScriptMessageHandlerWithReply, WKURLSchemeHandler {
    let resources = Bundle.main.resourceURL!
    let work: URL
    let storeFile: URL
    let roleNames: Set<String> = ["auto", "photo", "cutout", "headline", "panel", "logo", "legal", "decor", "focal"]
    private var store: [String: Any] = [:]
    private var running: Process?   // the osascript waiting on Illustrator, so Stop waiting can end it
    private var cancelled = false
    private let lock = NSLock()      // running and cancelled are set by the job queue and by Stop waiting on the main thread
    private let jobs = DispatchQueue(label: "grunter.jobs", qos: .userInitiated)   // Illustrator takes one script at a time

    override init() {
        let fm = FileManager.default
        work = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Grunter")
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Grunter")
        let oldSupport = support.deletingLastPathComponent().appendingPathComponent("Adapter")   // the app was called Adapter: keep its saved anchors and roles
        if !fm.fileExists(atPath: support.path) { try? fm.moveItem(at: oldSupport, to: support) }
        try? fm.createDirectory(at: work, withIntermediateDirectories: true)
        try? fm.createDirectory(at: support, withIntermediateDirectories: true)
        storeFile = support.appendingPathComponent("store.json")
        try? fm.removeItem(at: work.appendingPathComponent("runs"))   // left over from a crash
        if let data = try? Data(contentsOf: storeFile) {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { store = obj }
            else { try? data.write(to: storeFile.appendingPathExtension("bak")) }   // unreadable: keep it before the next save replaces it
        }
        super.init()
    }

    // MARK: messages from the page

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(["ok": false, "error": "Bad request."], nil); return
        }
        let p = body["payload"] as? [String: Any] ?? [:]
        switch cmd {
        case "loadAll":
            replyHandler(["ok": true, "store": store], nil)
        case "save":
            var saved = false
            if let key = p["key"] as? String {
                store[key] = p["value"] ?? NSNull()
                if let data = try? JSONSerialization.data(withJSONObject: store), (try? data.write(to: storeFile, options: .atomic)) != nil { saved = true }
            }
            replyHandler(["ok": saved], nil)
        case "cancel":
            lock.lock(); cancelled = true; running?.terminate(); lock.unlock()
            replyHandler(["ok": true], nil)
        case "pick":
            pick(prompt: p["prompt"] as? String ?? "Choose a photo") { path in
                replyHandler(["ok": true, "path": (path as Any?) ?? NSNull()], nil)
            }
        case "analyse", "make":
            do {
                let job = try buildJob(cmd, p)
                runJob(job) { replyHandler($0, nil) }
            } catch {
                replyHandler(["ok": false, "error": error.localizedDescription], nil)
            }
        default:
            replyHandler(["ok": false, "error": "Unknown command \(cmd)."], nil)
        }
    }

    // MARK: job building (validates everything the page sends before it reaches Illustrator)

    struct Bad: LocalizedError { let errorDescription: String? }

    func roles(_ any: Any?) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in (any as? [String: Any]) ?? [:] {
            if let id = Int(k), let role = v as? String, roleNames.contains(role) { out[String(id)] = role }
        }
        return out
    }

    func focal(_ any: Any?) -> Any {
        if let a = any as? [Any], (2...3).contains(a.count), let x = (a[0] as? NSNumber)?.doubleValue, let y = (a[1] as? NSNumber)?.doubleValue {
            let r = a.count == 3 ? max(0, (a[2] as? NSNumber)?.doubleValue ?? 0) : 0
            return a.count == 3 ? [x, y, r] : [x, y]
        }
        return NSNull()
    }

    func sizes(_ any: Any?) throws -> [[String: Any]] {
        var out: [[String: Any]] = []
        for z in (any as? [[String: Any]]) ?? [] {
            guard let w = (z["w"] as? NSNumber)?.doubleValue, let h = (z["h"] as? NSNumber)?.doubleValue,
                  (1...16000).contains(w), (1...16000).contains(h) else { throw Bad(errorDescription: "A size is not valid.") }
            let label = String((z["label"] as? String ?? "\(Int(w))x\(Int(h))").prefix(60))
            var item: [String: Any] = ["w": w, "h": h, "label": label]
            if let plate = z["plate"] as? String, !plate.isEmpty {
                guard FileManager.default.fileExists(atPath: plate) else { throw Bad(errorDescription: "\(label): photo not found.") }
                item["plate"] = plate
            }
            if let m = (z["master"] as? NSNumber)?.intValue { item["master"] = m }
            out.append(item)
        }
        return out
    }

    // Recorded Makes live only while the app runs: the newest `keep` stay, everything goes on quit.
    func pruneRuns(keep: Int) -> URL {
        let dir = work.appendingPathComponent("runs"), fm = FileManager.default
        let old = ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).sorted().dropLast(keep)   // folder names are timestamps
        old.forEach { try? fm.removeItem(at: dir.appendingPathComponent($0)) }
        return dir
    }
    func clearRuns() { try? FileManager.default.removeItem(at: work.appendingPathComponent("runs")) }

    func buildJob(_ cmd: String, _ p: [String: Any]) throws -> [String: Any] {
        var job: [String: Any] = ["mode": cmd, "roles": roles(p["roles"]), "focal": focal(p["focal"]),
                                  "follow": (p["follow"] as? Bool) ?? true]
        if let doc = p["doc"] as? String { job["doc"] = doc }
        if let ab = (p["artboard"] as? NSNumber)?.intValue { job["artboard"] = ab }
        if cmd == "analyse" {
            job["checks"] = try sizes(p["checks"])
            if (p["preview"] as? Bool) == true { job["png"] = work.appendingPathComponent("master_{i}.png").path }
        } else {
            let s = try sizes(p["sizes"])
            if s.isEmpty { throw Bad(errorDescription: "Pick at least one size.") }
            job["sizes"] = s
            job["runs"] = pruneRuns(keep: 29).path   // the Make about to run is the 30th
            job["masters"] = ((p["masters"] as? [[String: Any]]) ?? []).compactMap { m -> [String: Any]? in
                guard let ab = (m["artboard"] as? NSNumber)?.intValue else { return nil }
                return ["artboard": ab, "focal": focal(m["focal"]), "roles": roles(m["roles"]), "follow": (m["follow"] as? Bool) ?? true]
            }
        }
        return job
    }

    // MARK: talking to Illustrator

    // Illustrator may misread UTF-8 in a script file, so every non-ASCII character (paths, names) goes in as \uXXXX.
    func asciiOnly(_ s: String) -> String {
        s.utf16.map { $0 < 128 ? String(UnicodeScalar(UInt8($0))) : String(format: "\\u%04x", $0) }.joined()
    }

    func runJob(_ jobIn: [String: Any], done: @escaping ([String: Any]) -> Void) {
        let out = work.appendingPathComponent("result_\(UUID().uuidString).json")
        var job = jobIn
        job["out"] = out.path
        let engine = resources.appendingPathComponent("adapt_maker.jsx").path
        guard let jobData = try? JSONSerialization.data(withJSONObject: job),
              let jobJSON = String(data: jobData, encoding: .utf8).map(asciiOnly),
              let engineJSON = (try? JSONSerialization.data(withJSONObject: [engine])).flatMap({ String(data: $0, encoding: .utf8) }).map(asciiOnly) else {
            done(["ok": false, "error": "Could not prepare the job."]); return
        }
        // ADAPT_JOB is cleared afterwards so a later run never picks up a stale job
        let runner = work.appendingPathComponent("runner_\(UUID().uuidString).jsx")
        let script = "var ADAPT_JOB = \(jobJSON);\ntry { $.evalFile(new File(\(engineJSON)[0])); } finally { ADAPT_JOB = undefined; }\n"
        do { try script.write(to: runner, atomically: true, encoding: .utf8) } catch {
            done(["ok": false, "error": "Could not write the job file."]); return
        }

        jobs.async {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            proc.arguments = ["-e", "tell application \"Adobe Illustrator\" to do javascript (POSIX file \"\(runner.path)\")"]
            // errors go to a file: an unread pipe blocks osascript once it holds 64 KB
            let logURL = self.work.appendingPathComponent("osa_\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            let logHandle = try? FileHandle(forWritingTo: logURL)
            proc.standardError = logHandle; proc.standardOutput = FileHandle.nullDevice   // only errors are read
            var result: [String: Any]
            self.lock.lock(); self.cancelled = false; self.lock.unlock()
            do {
                try proc.run()
                self.lock.lock(); self.running = proc; self.lock.unlock()
                let killer = DispatchWorkItem { if proc.isRunning { proc.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 1800, execute: killer)   // a 400 MB master with many sizes can take many minutes
                proc.waitUntilExit()
                killer.cancel()
                self.lock.lock(); self.running = nil; let stopped = self.cancelled; self.lock.unlock()
                let msg = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
                if let data = try? Data(contentsOf: out), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    result = obj
                } else if stopped {
                    result = ["ok": false, "error": "Stopped waiting. Illustrator may still be working or showing a dialog: check it before trying again."]
                } else if msg.contains("-1743") {
                    result = ["ok": false, "error": "macOS blocked Grunter from controlling Illustrator. Allow it in System Settings › Privacy & Security › Automation."]
                } else if msg.contains("-600") || msg.contains("-1728") {
                    result = ["ok": false, "error": "Illustrator isn't open. Open your master in Illustrator first."]
                } else {
                    result = ["ok": false, "error": msg.isEmpty ? "Illustrator didn't answer within 30 minutes. It may still be working: check the file before trying again." : msg.trimmingCharacters(in: .whitespacesAndNewlines)]
                }
            } catch {
                result = ["ok": false, "error": "Could not reach Illustrator."]
            }
            try? logHandle?.close()
            try? FileManager.default.removeItem(at: logURL)
            try? FileManager.default.removeItem(at: out)
            try? FileManager.default.removeItem(at: runner)
            DispatchQueue.main.async { done(result) }
        }
    }

    func pick(prompt: String, done: @escaping (String?) -> Void) {
        let panel = NSOpenPanel()
        panel.message = prompt
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType.image, UTType.pdf, UTType("com.adobe.photoshop-image"), UTType("com.adobe.illustrator.ai-image")].compactMap { $0 }
        if let window = NSApp.keyWindow {
            panel.beginSheetModal(for: window) { done($0 == .OK ? panel.url?.path : nil) }
        } else {
            done(panel.runModal() == .OK ? panel.url?.path : nil)
        }
    }

    // MARK: grunter:// scheme. grunter://app/<file> = the page, grunter://app/preview/<n>.png = master previews

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let host = url.host else { return fail(task) }
        var file: URL?
        if host == "app", url.path.hasPrefix("/preview/") {
            let n = url.deletingPathExtension().lastPathComponent
            if Int(n) != nil { file = work.appendingPathComponent("master_\(n).png") }
        } else if host == "app" {
            let name = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
            if !name.contains("..") { file = resources.appendingPathComponent("web").appendingPathComponent(name) }
        }
        guard let f = file, let data = try? Data(contentsOf: f) else { return fail(task) }
        let type = f.pathExtension == "html" ? "text/html" : f.pathExtension == "png" ? "image/png" : f.pathExtension == "js" ? "text/javascript" : "application/octet-stream"
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": type, "Cache-Control": "no-store"])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func fail(_ task: WKURLSchemeTask) {
        task.didFailWithError(NSError(domain: "Grunter", code: 404))
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let bridge = Bridge()

    func applicationWillTerminate(_ note: Notification) { bridge.clearRuns() }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "grunter")
        config.setURLSchemeHandler(bridge, forURLScheme: "grunter")
        let web = WKWebView(frame: .zero, configuration: config)
        web.load(URLRequest(url: URL(string: "grunter://app/index.html")!))

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Grunter"
        window.minSize = NSSize(width: 980, height: 640)
        window.contentView = web
        window.setFrameAutosaveName("GrunterMain")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // a real menu bar, so Cmd+Q, Cmd+C/V/A and Undo work in text fields
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Grunter", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Grunter", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Grunter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
