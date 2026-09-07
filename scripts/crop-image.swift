// crop-image.swift — crop a pixel rect out of an image, optionally downscale, write JPEG.
// macOS only; uses ImageIO/CoreGraphics so there is nothing to install.
//
//   swift scripts/crop-image.swift <in> <out> <x> <y> <w> <h> [maxDim] [quality]
//
// x/y are top-left origin, in source pixels. maxDim (optional) scales the crop down so
// its longer side is at most maxDim. quality defaults to 0.82.
//
// Used to derive the wedding hero and the Open Graph share image — see CLAUDE.md.

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func die(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 7 else {
    die("usage: crop-image.swift <in> <out> <x> <y> <w> <h> [maxDim] [quality]")
}

let inPath = args[1]
let outPath = args[2]
guard let cropX = Int(args[3]), let cropY = Int(args[4]),
      let cropW = Int(args[5]), let cropH = Int(args[6]), cropW > 0, cropH > 0 else {
    die("x/y/w/h must be integers, w/h positive")
}
let maxDim = args.count > 7 ? (Int(args[7]) ?? 0) : 0
let quality = args.count > 8 ? (Double(args[8]) ?? 0.82) : 0.82

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: inPath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    die("cannot read image: \(inPath)")
}

// Clamp the requested rect to the image so an over-long crop trims instead of failing.
let x = max(0, min(cropX, image.width))
let y = max(0, min(cropY, image.height))
let w = min(cropW, image.width - x)
let h = min(cropH, image.height - y)
guard w > 0, h > 0 else { die("crop rect falls outside the image") }

guard let cropped = image.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else {
    die("crop failed")
}

// Optional downscale, preserving aspect ratio.
var output = cropped
if maxDim > 0 && max(w, h) > maxDim {
    let scale = Double(maxDim) / Double(max(w, h))
    let outW = Int((Double(w) * scale).rounded())
    let outH = Int((Double(h) * scale).rounded())
    guard let ctx = CGContext(
        data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { die("cannot allocate \(outW)x\(outH) context") }
    ctx.interpolationQuality = .high
    ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: outW, height: outH))
    guard let scaled = ctx.makeImage() else { die("downscale failed") }
    output = scaled
}

guard let dest = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: outPath) as CFURL, UTType.jpeg.identifier as CFString, 1, nil
) else { die("cannot write: \(outPath)") }

CGImageDestinationAddImage(dest, output, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { die("encode failed") }

print("\(outPath) — \(output.width)x\(output.height)")
