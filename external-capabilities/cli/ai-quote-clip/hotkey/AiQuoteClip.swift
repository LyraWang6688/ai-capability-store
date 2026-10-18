import Cocoa
import Carbon
import ApplicationServices

let HOTKEY_SIGNATURE: OSType = 0x4151434C // 'AQCL'

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var shared: AppDelegate?
    var hotKeyRef: EventHotKeyRef?
    var statusItem: NSStatusItem?
    var busy = false
    var launch: [String: String] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        NSApp.setActivationPolicy(.accessory)
        loadHotkeyConfig()
        registerHotKey()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "❝"
        let menu = NSMenu()
        let capture = NSMenuItem(title: "收录到飞书（⌃⌥\(launch["key"]?.uppercased() ?? "Z")）", action: #selector(trigger), keyEquivalent: "")
        capture.target = self
        menu.addItem(capture)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        _ = ensureAccessibility(prompt: false)
    }

    func loadHotkeyConfig() {
        let path = NSHomeDirectory() + "/.ai-quote-clip/hotkey.json"
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return }
        launch = json
    }

    func keyCode() -> UInt32 {
        // Letters the operator may choose through `hotkey install --key <letter>`.
        let map: [String: Int] = [
            "a": kVK_ANSI_A, "s": kVK_ANSI_S, "d": kVK_ANSI_D, "f": kVK_ANSI_F,
            "g": kVK_ANSI_G, "h": kVK_ANSI_H, "j": kVK_ANSI_J, "k": kVK_ANSI_K,
            "l": kVK_ANSI_L, "z": kVK_ANSI_Z, "x": kVK_ANSI_X, "c": kVK_ANSI_C,
            "v": kVK_ANSI_V, "b": kVK_ANSI_B, "n": kVK_ANSI_N, "m": kVK_ANSI_M,
            "q": kVK_ANSI_Q, "w": kVK_ANSI_W, "e": kVK_ANSI_E, "r": kVK_ANSI_R,
            "t": kVK_ANSI_T, "y": kVK_ANSI_Y, "u": kVK_ANSI_U, "i": kVK_ANSI_I,
            "o": kVK_ANSI_O, "p": kVK_ANSI_P,
        ]
        let letter = (launch["key"] ?? "z").lowercased()
        return UInt32(map[letter] ?? kVK_ANSI_Z)
    }

    func registerHotKey() {
        var hotKeyID = EventHotKeyID(signature: HOTKEY_SIGNATURE, id: 1)
        let modifier = UInt32(controlKey | optionKey)
        RegisterEventHotKey(keyCode(), modifier, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        _ = hotKeyID
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { (_, _, _) -> OSStatus in
            DispatchQueue.main.async { AppDelegate.shared?.trigger() }
            return noErr
        }, 1, &eventType, nil, nil)
    }

    func ensureAccessibility(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    @objc func trigger() {
        if busy { return }
        busy = true
        defer { busy = false }
        if !ensureAccessibility(prompt: true) {
            notify("需要辅助功能权限", "系统设置 → 隐私与安全性 → 辅助功能，勾选 AiQuoteClip")
            return
        }
        guard let text = captureSelection(), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            notify("没有选中文字", "先用鼠标选中一段文字，再按快捷键")
            return
        }
        let ok = runCli(text)
        notify(ok ? "已收录到飞书" : "收录失败", ok ? String(text.prefix(40)) : "运行 ai-quote-clip status 排查")
    }

    /// Read the focused element's selected text through the Accessibility API.
    func selectedTextViaAX() -> String? {
        let system = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let element = focused else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element as! AXUIElement, kAXSelectedTextAttribute as CFString, &value) == .success,
              let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    /// Copy the current selection by synthesizing ⌘C, with retries for slow apps.
    func selectedTextViaCopy() -> String? {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: true)
        down?.flags = .maskCommand
        let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: false)
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        for _ in 0..<4 {
            usleep(160_000)
            if let text = pasteboard.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text
            }
        }
        return nil
    }

    func captureSelection() -> String? {
        // 1) Accessibility route (works for native selections, no clipboard churn).
        if let text = selectedTextViaAX() { return text }
        let saved = NSPasteboard.general.string(forType: .string)
        // 2) Synthetic ⌘C (works for most apps, including Electron).
        if let text = selectedTextViaCopy() { restoreClipboard(saved); return text }
        restoreClipboard(saved)
        // 3) Last resort: the user may have copied manually before pressing the hotkey.
        if let text = saved, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        return nil
    }

    func restoreClipboard(_ saved: String?) {
        guard let saved = saved else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(saved, forType: .string)
    }

    func runCli(_ text: String) -> Bool {
        guard let node = launch["node"], let cli = launch["cli"],
              FileManager.default.fileExists(atPath: node), FileManager.default.fileExists(atPath: cli) else { return false }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [cli, "add"]
        let input = Pipe()
        process.standardInput = input
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do { try process.run() } catch { return false }
        if let data = text.data(using: .utf8) { input.fileHandleForWriting.write(data) }
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
        return process.terminationStatus == 0
    }
}

func notify(_ title: String, _ body: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", "display notification \(quoted(body)) with title \(quoted(title))"]
    try? process.run()
}

func quoted(_ value: String) -> String {
    return "\"" + value.replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
