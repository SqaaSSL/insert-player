import AppKit
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import Vision

enum SegmentationError: Error, CustomStringConvertible {
  case invalidArguments
  case unreadableImage(String)
  case missingMask
  case renderFailed
  case encodeFailed

  var description: String {
    switch self {
    case .invalidArguments:
      return "Usage: swift segment-people.swift <input-image> <output-mask> [people|foreground]"
    case .unreadableImage(let path):
      return "Could not read image at \(path)"
    case .missingMask:
      return "Vision did not return a person segmentation mask"
    case .renderFailed:
      return "Core Image could not render the segmentation mask"
    case .encodeFailed:
      return "Could not encode the segmentation mask as PNG"
    }
  }
}

func writePng(_ image: CGImage, to url: URL) throws {
  guard let destination = CGImageDestinationCreateWithURL(
    url as CFURL,
    "public.png" as CFString,
    1,
    nil
  ) else {
    throw SegmentationError.encodeFailed
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw SegmentationError.encodeFailed
  }
}

do {
  guard CommandLine.arguments.count == 3 || CommandLine.arguments.count == 4 else {
    throw SegmentationError.invalidArguments
  }

  let inputPath = CommandLine.arguments[1]
  let outputPath = CommandLine.arguments[2]
  let mode = CommandLine.arguments.count == 4 ? CommandLine.arguments[3] : "people"
  let inputUrl = URL(fileURLWithPath: inputPath)
  let outputUrl = URL(fileURLWithPath: outputPath)
  guard let inputImage = CIImage(contentsOf: inputUrl) else {
    throw SegmentationError.unreadableImage(inputPath)
  }

  let handler = VNImageRequestHandler(ciImage: inputImage, orientation: .up)
  let targetExtent = inputImage.extent.integral
  let scaledMask: CIImage
  if mode == "foreground" {
    let request = VNGenerateForegroundInstanceMaskRequest()
    try handler.perform([request])
    guard let observation = request.results?.first else {
      throw SegmentationError.missingMask
    }
    let pixelBuffer = try observation.generateScaledMaskForImage(
      forInstances: observation.allInstances,
      from: handler
    )
    scaledMask = CIImage(cvPixelBuffer: pixelBuffer).cropped(to: targetExtent)
  } else {
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    try handler.perform([request])
    guard let observation = request.results?.first else {
      throw SegmentationError.missingMask
    }
    let rawMask = CIImage(cvPixelBuffer: observation.pixelBuffer)
    scaledMask = rawMask
      .transformed(by: CGAffineTransform(
        scaleX: targetExtent.width / rawMask.extent.width,
        y: targetExtent.height / rawMask.extent.height
      ))
      .cropped(to: targetExtent)
  }

  let context = CIContext(options: [.cacheIntermediates: false])
  guard let renderedMask = context.createCGImage(scaledMask, from: targetExtent) else {
    throw SegmentationError.renderFailed
  }
  try writePng(renderedMask, to: outputUrl)
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
