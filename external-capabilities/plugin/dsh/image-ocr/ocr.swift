import Foundation
import Vision
import AppKit

func loadImage(_ path: String?) -> CGImage? {
    if let p = path {
        guard let img = NSImage(contentsOfFile: p) else { return nil }
        var rect = NSRect(origin: .zero, size: img.size)
        return img.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }
    // 从剪贴板读图
    let pb = NSPasteboard.general
    guard let data = pb.data(forType: .png) ?? pb.data(forType: .tiff),
          let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage else { return nil }
    return cg
}

func ocr(_ cg: CGImage) -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([request]) } catch { return ["[OCR 失败] \(error)"] }
    let observations = request.results ?? []
    // 按视觉位置从上到下、从左到右排序
    let sorted = observations.sorted { a, b in
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.01 { return ay > by }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    return sorted.compactMap { $0.topCandidates(1).first?.string }
}

let args = CommandLine.arguments
let path = args.count > 1 && args[1] != "--clipboard" ? args[1] : nil
guard let cg = loadImage(path) else {
    FileHandle.standardError.write("找不到图片（传路径或 --clipboard）\n".data(using: .utf8)!)
    exit(2)
}
let start = Date()
let lines = ocr(cg)
print(lines.joined(separator: "\n"))
FileHandle.standardError.write(String(format: "[%.2fs, %d 行]\n", Date().timeIntervalSince(start), lines.count).data(using: .utf8)!)
