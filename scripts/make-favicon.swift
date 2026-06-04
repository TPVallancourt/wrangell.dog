// make-favicon.swift — cut the foreground subject out of a photo onto a transparent
// background using the macOS Vision framework (same engine as Photos' "lift subject"),
// optionally crop to a rect, and write a PNG. No external dependencies.
//
// Usage:
//   swift scripts/make-favicon.swift <input.jpeg> <output.png> [x y w h]
//
// x y w h are in oriented-pixel space (top-left origin). Omit to keep the full subject.

import Foundation
import CoreImage
import Vision
import ImageIO
import UniformTypeIdentifiers

func die(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    die("usage: swift make-favicon.swift <input> <output.png> [x y w h]")
}
let inputPath = args[1]
let outputPath = args[2]

var cropRect: CGRect? = nil
if args.count >= 7,
   let x = Double(args[3]), let y = Double(args[4]),
   let w = Double(args[5]), let h = Double(args[6]) {
    cropRect = CGRect(x: x, y: y, width: w, height: h)
}
// Pass "pad" as the 8th arg to center the crop on a transparent square canvas
// (side = the longer crop dimension) — keeps a tall subject at full height
// without stretching or pulling in the surrounding body to fill the width.
let padSquare = args.count >= 8 && args[7] == "pad"

let inputURL = URL(fileURLWithPath: inputPath)
guard let src = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    die("could not read image at \(inputPath)")
}

// Apply EXIF orientation so pixel coordinates match what a human sees.
let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
let exifOrientation = (props?[kCGImagePropertyOrientation] as? UInt32) ?? 1
let cgOrientation = CGImagePropertyOrientation(rawValue: exifOrientation) ?? .up

var ciImage = CIImage(cgImage: cgImage).oriented(cgOrientation)
let context = CIContext(options: nil)

// Run the foreground-instance mask request on the oriented image.
let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
let request = VNGenerateForegroundInstanceMaskRequest()
do {
    try handler.perform([request])
} catch {
    die("Vision request failed: \(error)")
}
guard let result = request.results?.first else {
    die("no foreground subject detected")
}

// Composite all detected instances onto transparency.
let maskedPixelBuffer = try result.generateMaskedImage(
    ofInstances: result.allInstances,
    from: handler,
    croppedToInstancesExtent: false
)
var output = CIImage(cvPixelBuffer: maskedPixelBuffer)

if let rect = cropRect {
    // Convert top-left-origin rect to CoreImage's bottom-left origin.
    let flipped = CGRect(x: rect.origin.x,
                         y: output.extent.height - rect.origin.y - rect.height,
                         width: rect.width, height: rect.height)
    output = output.cropped(to: flipped)
    // Re-anchor to origin so the PNG isn't padded with the original offset.
    output = output.transformed(by: CGAffineTransform(translationX: -output.extent.origin.x,
                                                      y: -output.extent.origin.y))
}

if padSquare {
    let w = output.extent.width
    let h = output.extent.height
    let side = max(w, h)
    let square = CGRect(x: 0, y: 0, width: side, height: side)
    // Center the subject, then composite over a transparent square so the
    // canvas actually expands to `side` x `side` (cropped() alone only shrinks).
    output = output.transformed(by: CGAffineTransform(translationX: (side - w) / 2,
                                                      y: (side - h) / 2))
    let clear = CIImage(color: CIColor.clear).cropped(to: square)
    output = output.composited(over: clear).cropped(to: square)
}

guard let outCG = context.createCGImage(output, from: output.extent) else {
    die("failed to render output image")
}

let outURL = URL(fileURLWithPath: outputPath)
guard let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    die("could not create PNG destination at \(outputPath)")
}
CGImageDestinationAddImage(dest, outCG, nil)
guard CGImageDestinationFinalize(dest) else {
    die("failed to write PNG")
}

print("wrote \(outputPath) — \(outCG.width)x\(outCG.height)")
