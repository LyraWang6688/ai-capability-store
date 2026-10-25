// ui.swift — 微信桌面界面的最小驱动工具（macOS）
//
// 能力：列出窗口 / 区域或窗口截图 / Vision OCR 定位文字 / 合成点击与键盘 /
//       AX 窗口级动作（置前、聚焦、设置位置、最小化）/ 激活 app。
//
// 为什么是这一套：微信桌面版的内容区不暴露 AX（只有窗框和交通灯按钮），
// System Events 的 AppleScript UI scripting 在本机被系统拒绝（-10004），
// 所以路线是「截图 + OCR 定位 → CGEvent 合成事件 → 截图核对」。
//
// 编译：scripts/build.sh
// 用法：ui <command> [args]，见文件末尾 usage。

import Foundation
import CoreGraphics
import ApplicationServices
import AppKit
import Vision

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func sattr(_ el: AXUIElement, _ name: String) -> String {
    guard let v = attr(el, name) else { return "" }
    return "\(v)"
}

func winTitle(_ w: AXUIElement) -> String { sattr(w, kAXTitleAttribute as String) }

func windows(_ app: AXUIElement) -> [AXUIElement] {
    (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
}

func findApp(_ needle: String) -> NSRunningApplication? {
    let n = needle.lowercased()
    return NSWorkspace.shared.runningApplications.first {
        ($0.localizedName ?? "").lowercased().contains(n)
            || ($0.bundleIdentifier ?? "").lowercased().contains(n)
    }
}

@discardableResult
func shell(_ path: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    try? p.run()
    p.waitUntilExit()
    return p.terminationStatus
}

func clip(_ text: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pbcopy")
    let pipe = Pipe()
    p.standardInput = pipe
    try? p.run()
    pipe.fileHandleForWriting.write(text.data(using: .utf8)!)
    pipe.fileHandleForWriting.closeFile()
    p.waitUntilExit()
}

func postKey(_ code: UInt16, _ flags: CGEventFlags) {
    let src = CGEventSource(stateID: .hidSystemState)
    let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    d?.flags = flags
    d?.post(tap: .cghidEventTap)
    usleep(50_000)
    let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    u?.flags = flags
    u?.post(tap: .cghidEventTap)
}

func clickAt(_ pt: CGPoint, robust: Bool) {
    CGWarpMouseCursorPosition(pt)
    usleep(150_000)
    let src = CGEventSource(stateID: robust ? .combinedSessionState : .hidSystemState)
    if robust {
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt,
                mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(80_000)
    }
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
    if robust {
        down?.setIntegerValueField(.mouseEventClickState, value: 1)
        up?.setIntegerValueField(.mouseEventClickState, value: 1)
    }
    down?.post(tap: .cghidEventTap)
    usleep(robust ? 120_000 : 60_000)
    up?.post(tap: .cghidEventTap)
}

func ocr(_ path: String) {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("ocr: cannot read \(path)\n".data(using: .utf8)!)
        exit(1)
    }
    let w = CGFloat(cg.width), h = CGFloat(cg.height)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = false
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    } catch {
        FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    for o in req.results ?? [] {
        guard let c = o.topCandidates(1).first else { continue }
        let bb = o.boundingBox
        let x = bb.origin.x * w
        let y = (1 - bb.origin.y - bb.size.height) * h
        print(String(format: "%.0f,%.0f,%.0f,%.0f\t%@", x, y, bb.size.width * w, bb.size.height * h, c.string))
    }
}


// ---- doctor：换一台 Mac 之前先跑这个，逐项告诉人「缺什么、怎么补」----

func ok(_ name: String, _ detail: String) {
    print("OK   \(name) — \(detail)")
}
func bad(_ name: String, _ detail: String, _ fix: String) {
    print("FAIL \(name) — \(detail)\n     修法：\(fix)")
}

func checkAX() -> Bool {
    if AXIsProcessTrusted() {
        ok("辅助功能", "已授权，合成点击可用")
        return true
    }
    bad("辅助功能", "未授权 —— 合成点击会静默无效（不报错、页面不动）",
        "系统设置 → 隐私与安全性 → 辅助功能，勾选「运行这个 Agent 的宿主程序」（Terminal / iTerm / DSH / Codex / ChatGPT 等），授权后重启该宿主")
    return false
}

func checkScreenPermission() -> Bool {
    let out = "/tmp/wechat-invoice-doctor.png"
    try? FileManager.default.removeItem(atPath: out)
    _ = shell("/usr/sbin/screencapture", ["-x", "-R0,0,160,120", out])
    guard let img = NSImage(contentsOfFile: out),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        bad("屏幕录制", "截图失败 —— 拿不到屏幕内容",
            "系统设置 → 隐私与安全性 → 屏幕录制，勾选宿主程序后重启宿主")
        return false
    }
    // 全黑/全白都可能是「权限给了但内容被隐藏」，这里只做基本判据
    guard let data = cg.dataProvider?.data as Data?, data.count > 1000 else {
        bad("屏幕录制", "截图内容为空", "同上：检查屏幕录制授权后重启宿主")
        return false
    }
    ok("屏幕录制", "截图正常（\(cg.width)x\(cg.height)）")
    return true
}

func checkVisionOCR() -> Bool {
    // 自己画一张带字的图再识别：不依赖屏幕内容，只验证系统 OCR 是否可用
    let size = NSSize(width: 480, height: 120)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 40),
        .foregroundColor: NSColor.black,
    ]
    NSAttributedString(string: "INVOICE 发票", attributes: attrs)
        .draw(at: NSPoint(x: 20, y: 30))
    img.unlockFocus()
    guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        bad("文字识别", "无法生成测试图", "报告给 skill 维护者")
        return false
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    } catch {
        bad("文字识别（Vision OCR）", "系统 OCR 报错：\(error.localizedDescription)",
            "可先用「模型看图」降级路径（见 SKILL.md §如果 ui ocr 报错）；设备上可重启后重试，或装 tesseract 作为第二引擎")
        return false
    }
    let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined()
    if text.isEmpty {
        bad("文字识别（Vision OCR）", "没识别出测试图里的字", "同上：走降级路径或装 tesseract")
        return false
    }
    ok("文字识别（Vision OCR）", "可用（识别出「\(text.prefix(20))」）")
    return true
}

func checkWeChat() -> Bool {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.tencent.xinWeChat") else {
        bad("微信", "没装微信（com.tencent.xinWeChat）", "从 App Store / 微信官网安装 macOS 版微信并登录")
        return false
    }
    var version = "?"
    if let b = Bundle(url: url), let v = b.infoDictionary?["CFBundleShortVersionString"] as? String {
        version = v
    }
    let running = !NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat").isEmpty
    ok("微信", "已安装 \(version)，\(running ? "正在运行" : "未运行（流程第 1 步会需要它）")")
    return true
}

func checkDisplays() -> Bool {
    let screens = NSScreen.screens
    let desc = screens.map { "\(Int($0.frame.width))x\(Int($0.frame.height))@\(Int($0.backingScaleFactor))x" }
        .joined(separator: " ")
    if screens.count > 1 {
        ok("显示器", "\(screens.count) 块：\(desc) —— 多屏时坐标是全局坐标，可能为负；换算一律用截图实测的 scale，不要假设 2x")
    } else {
        ok("显示器", "\(desc) —— 换算用截图实测的 scale（Retina 通常 2，外接 1x 为 1），不要写死 2")
    }
    return true
}

func checkClipboard() -> Bool {
    clip("wechat-invoice-doctor")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pbpaste")
    let pipe = Pipe()
    p.standardOutput = pipe
    try? p.run()
    p.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    if out.contains("wechat-invoice-doctor") {
        ok("剪贴板", "pbcopy/pbpaste 正常（粘贴中文靠它）")
        return true
    }
    bad("剪贴板", "pbcopy/pbpaste 往返失败", "检查是否有剪贴板管理软件拦截；这是粘贴中文的必经之路")
    return false
}

func checkArch() -> Bool {
    var sysinfo = utsname()
    uname(&sysinfo)
    let machine = withUnsafeBytes(of: &sysinfo.machine) { raw -> String in
        String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
    }
    if machine == "arm64" {
        ok("架构", "arm64（Apple Silicon）—— 本 skill 当前支持的唯一架构")
        return true
    }
    bad("架构", "当前机器是 \(machine)，本 skill 只支持 arm64（Apple Silicon）",
        "换 Apple Silicon 机器；或在 Intel 上自行改 skill（未支持，不在维护范围）")
    return false
}

func checkSwift() -> Bool {
    if FileManager.default.isExecutableFile(atPath: "/usr/bin/swiftc") {
        ok("swiftc", "存在（scripts/build.sh 用它编译 ui）")
        return true
    }
    bad("swiftc", "缺 Swift 编译器，ui 编译不出来",
        "终端执行 xcode-select --install 装 Command Line Tools（约 1-2 GB），装完重跑 scripts/build.sh")
    return false
}

func doctor() {
    print("== 微信开票 skill · 环境自检 ==")
    var fails = 0
    for pass in [checkArch(), checkSwift(), checkAX(), checkScreenPermission(), checkVisionOCR(),
                 checkWeChat(), checkClipboard(), checkDisplays()] where !pass { fails += 1 }
    print(fails == 0 ? "== 全部通过，可以按 SKILL.md 走 =="
                     : "== \(fails) 项不通过：按上面「修法」补齐再继续，不要硬点 ==")
    exit(fails == 0 ? 0 : 1)
}

let a = CommandLine.arguments
let cmd = a.count > 1 ? a[1] : "status"

switch cmd {
case "doctor":
    doctor()

case "status":
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
    print("axTrusted=\(AXIsProcessTrusted()) front=\(front)")

case "pid":
    if let app = findApp(a[2]) { print(app.processIdentifier) } else { exit(2) }

case "windows":
    let needle = (a.count > 2 ? a[2] : "").lowercased()
    if let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] {
        for w in list {
            let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
            let name = (w[kCGWindowName as String] as? String) ?? ""
            if !needle.isEmpty,
               !(owner.lowercased().contains(needle) || name.lowercased().contains(needle)) { continue }
            let id = w[kCGWindowNumber as String] as? Int ?? -1
            let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
            let layer = w[kCGWindowLayer as String] as? Int ?? -1
            let onscreen = w[kCGWindowIsOnscreen as String] as? Int ?? -1
            print("id=\(id) owner=\(owner) name=\(name) layer=\(layer) onscreen=\(onscreen) bounds=\(b)")
        }
    }

case "shotwin":
    exit(shell("/usr/sbin/screencapture", ["-x", "-l\(a[2])", a[3]]))

case "shotregion":
    let w = Double(a[4])!
    let rc = shell("/usr/sbin/screencapture", ["-x", "-R\(a[2]),\(a[3]),\(a[4]),\(a[5])", a[6]])
    if rc != 0 { exit(rc) }
    if let img = NSImage(contentsOfFile: a[6]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        let sx = Double(cg.width) / w
        print("scale=\(sx) global_origin=(\(a[2]),\(a[3])) image=\(cg.width)x\(cg.height) — 全局点 = 原点 + 像素/scale")
    }

case "ocr":
    ocr(a[2])

case "click", "click2":
    clickAt(CGPoint(x: Double(a[2])!, y: Double(a[3])!), robust: cmd == "click2")
    print("\(cmd) \(a[2]),\(a[3])")

case "paste":
    clip(a[2])
    usleep(120_000)
    postKey(9, .maskCommand)   // ⌘V
    print("pasted \(a[2].count) chars")

case "type":
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in a[2].unicodeScalars {
        var u = Array(String(ch).utf16)
        let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
        d?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        d?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        up?.post(tap: .cghidEventTap)
        usleep(25_000)
    }
    print("typed")

case "key":
    var flags = CGEventFlags()
    if a.count > 3 {
        for f in a[3].split(separator: ",") {
            switch f {
            case "cmd": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            default: break
            }
        }
    }
    postKey(UInt16(a[2])!, flags)
    print("key \(a[2])")

case "focuswin":
    let pid = pid_t(a[2])!, needle = a[3]
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    usleep(250_000)
    let app = AXUIElementCreateApplication(pid)
    for w in windows(app) where winTitle(w).contains(needle) {
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        print("focused \(winTitle(w))")
    }

case "setwin":
    let pid = pid_t(a[2])!, needle = a[3]
    var p = CGPoint(x: Double(a[4])!, y: Double(a[5])!)
    var s = CGSize(width: Double(a[6])!, height: Double(a[7])!)
    let pv = AXValueCreate(.cgPoint, &p)!, sv = AXValueCreate(.cgSize, &s)!
    for w in windows(AXUIElementCreateApplication(pid)) where winTitle(w).contains(needle) {
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, pv)
        usleep(120_000)
        AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, sv)
        usleep(120_000)
        AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, pv)
        print("set \(winTitle(w))")
    }

case "minwin":
    let pid = pid_t(a[2])!
    for w in windows(AXUIElementCreateApplication(pid)) {
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
        print("minimized \(winTitle(w))")
    }

case "activate":
    guard let app = findApp(a[2]) else { exit(2) }
    print("activate \(app.localizedName ?? "?") -> \(app.activate(options: []))")

default:
    print("""
    usage: ui <command>
      status
      pid <bundle-or-name>
      windows [needle]
      shotwin <winid> <out.png>
      shotregion <x> <y> <w> <h> <out.png>
      ocr <img.png>
      click <x> <y> | click2 <x> <y>
      paste <text> | type <text> | key <code> [cmd,shift,alt,ctrl]
      focuswin <pid> <title-substr>
      setwin <pid> <title-substr> <x> <y> <w> <h>
      minwin <pid>
      activate <app-name-substr>
    """)
}
