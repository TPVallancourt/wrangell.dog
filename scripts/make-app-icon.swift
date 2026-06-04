// make-app-icon.swift — composite a transparent cutout PNG onto a solid-color square
// for use as a PWA / home-screen app icon. Unlike the bare favicon, app icons read best
// filled edge-to-edge (iOS masks to a rounded rect; Android "maskable" masks to a circle),
// so the subject is centered within a safe-zone inset over an opaque background.
//
// Usage:
//   swift scripts/make-app-icon.swift <cutout.png> <out.png> <size> <bgHexRRGGBB> <insetFraction>
//
// insetFraction is the padding on each side as a fraction of the canvas (e.g. 0.14 keeps the
// subject within the central ~72%, safe for Android maskable icons).

import Foundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

func die(_ m: String) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(1) }

let a = CommandLine.arguments
guard a.count >= 6 else {
    die("usage: make-app-icon.swift <cutout.png> <out.png> <size> <bgHexRRGGBB> <insetFraction>")
}
let cutoutPath = a[1], outPath = a[2]
guard let size = Double(a[3]) else { die("bad size") }
let hexStr = a[4].hasPrefix("#") ? String(a[4].dropFirst()) : a[4]
guard hexStr.count == 6, let rgb = Int(hexStr, radix: 16) else { die("bad hex color") }
guard let inset = Double(a[5]) else { die("bad inset fraction") }

let r = Double((rgb >> 16) & 0xff) / 255.0
let g = Double((rgb >> 8) & 0xff) / 255.0
let b = Double(rgb & 0xff) / 255.0

guard let cut = CIImage(contentsOf: URL(fileURLWithPath: cutoutPath)) else {
    die("cannot read cutout at \(cutoutPath)")
}

let ext = cut.extent
let content = size * (1 - 2 * inset)
let scale = content / max(ext.width, ext.height)
let scaled = cut.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let se = scaled.extent

// Center the scaled subject on the size×size canvas.
let tx = (size - se.width) / 2 - se.origin.x
let ty = (size - se.height) / 2 - se.origin.y
let placed = scaled.transformed(by: CGAffineTransform(translationX: tx, y: ty))

let square = CGRect(x: 0, y: 0, width: size, height: size)
let bg = CIImage(color: CIColor(red: r, green: g, blue: b)).cropped(to: square)
let comp = placed.composited(over: bg).cropped(to: square)

let ctx = CIContext()
guard let cg = ctx.createCGImage(comp, from: square) else { die("render failed") }
guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL,
                                                 UTType.png.identifier as CFString, 1, nil) else {
    die("could not create PNG destination at \(outPath)")
}
CGImageDestinationAddImage(dest, cg, nil)
guard CGImageDestinationFinalize(dest) else { die("failed to write PNG") }
print("wrote \(outPath) — \(Int(size))x\(Int(size)), bg #\(hexStr)")
