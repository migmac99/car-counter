// cc-capture — minimal AVFoundation camera grabber.
//
// Why this exists: ffmpeg's avfoundation input can only select a camera's
// UNCOMPRESSED pixel formats, and USB-2 UVC cameras (Logitech C922 et al.)
// cap uncompressed capture at 5 fps @ 1080p / 10 fps @ 720p. Their 30 fps
// modes are MJPEG-only — exactly what browsers negotiate via getUserMedia.
// AVCaptureSession can pick those formats; this helper does, then streams
// decoded NV12 frames to stdout where ffmpeg ingests them as rawvideo.
//
// Usage: cc-capture --index 0 [--name "C922"] --size 1920x1080 --fps 30
// Output: raw NV12 frames on stdout; diagnostics on stderr.
import AVFoundation
import Foundation

var index = 0
var name: String? = nil
var width: Int32 = 1920
var height: Int32 = 1080
var fps = 30.0

let argv = CommandLine.arguments
var i = 1
while i + 1 < argv.count {
  let v = argv[i + 1]
  switch argv[i] {
  case "--index": index = Int(v) ?? 0
  case "--name": name = v
  case "--size":
    let p = v.split(separator: "x")
    if p.count == 2 {
      width = Int32(p[0]) ?? 1920
      height = Int32(p[1]) ?? 1080
    }
  case "--fps": fps = Double(v) ?? 30
  default: break
  }
  i += 2
}

func warn(_ s: String) {
  FileHandle.standardError.write(("cc-capture: " + s + "\n").data(using: .utf8)!)
}

let discovery = AVCaptureDevice.DiscoverySession(
  deviceTypes: [.external, .builtInWideAngleCamera],
  mediaType: .video,
  position: .unspecified
)
let cameras = discovery.devices
guard !cameras.isEmpty else {
  warn("no cameras found")
  exit(2)
}
var device =
  cameras.first { c in name.map { c.localizedName.localizedCaseInsensitiveContains($0) } ?? false }
  ?? (index < cameras.count ? cameras[index] : cameras[0])

// Pick the format matching the requested size that can actually sustain the
// requested rate. Uncompressed formats advertise only their (low) USB-2
// rates, so the fps requirement naturally lands on the MJPEG format.
let candidates = device.formats.filter {
  let d = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
  return d.width == width && d.height == height
}
guard !candidates.isEmpty else {
  warn("\(device.localizedName) has no \(width)x\(height) mode")
  exit(2)
}
let maxRate = { (f: AVCaptureDevice.Format) in
  f.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
}
var format = candidates.first { maxRate($0) + 0.01 >= fps }
if format == nil {
  format = candidates.max { maxRate($0) < maxRate($1) }
  fps = maxRate(format!)
  warn("requested fps unsupported; using \(fps)")
}

let session = AVCaptureSession()
session.beginConfiguration()
guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
  warn("cannot open \(device.localizedName)")
  exit(2)
}
session.addInput(input)

let output = AVCaptureVideoDataOutput()
output.videoSettings = [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
]
output.alwaysDiscardsLateVideoFrames = true

final class Writer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var packed = Data()
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let w = CVPixelBufferGetWidthOfPlane(pb, 0)
    let h = CVPixelBufferGetHeightOfPlane(pb, 0)
    let frameBytes = w * h + w * (h / 2)
    if packed.count != frameBytes { packed = Data(count: frameBytes) }
    packed.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
      var off = 0
      for plane in 0..<2 {
        let base = CVPixelBufferGetBaseAddressOfPlane(pb, plane)!
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, plane)
        let rows = CVPixelBufferGetHeightOfPlane(pb, plane)
        for r in 0..<rows {
          memcpy(dst.baseAddress! + off, base + r * stride, w)
          off += w
        }
      }
    }
    // Blocking write paces us to the consumer; death of the consumer
    // (EPIPE) is our exit signal.
    let ok = packed.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Bool in
      var done = 0
      while done < src.count {
        let n = write(1, src.baseAddress! + done, src.count - done)
        if n <= 0 { return false }
        done += n
      }
      return true
    }
    if !ok { exit(0) }
  }
}

signal(SIGPIPE, SIG_IGN) // surface EPIPE as a write() error, not a kill
let writer = Writer()
output.setSampleBufferDelegate(writer, queue: DispatchQueue(label: "cc-capture"))
guard session.canAddOutput(output) else {
  warn("cannot add video output")
  exit(2)
}
session.addOutput(output)
session.commitConfiguration()

do {
  try device.lockForConfiguration()
  device.activeFormat = format!
  // Ranges are exact (e.g. 30.00003 fps); reuse the range's own CMTimes —
  // a hand-built 1/30 is rejected as out of range.
  let ranges = format!.videoSupportedFrameRateRanges
  let range =
    ranges.first { $0.maxFrameRate + 0.01 >= fps && fps + 0.01 >= $0.minFrameRate }
    ?? ranges.max { $0.maxFrameRate < $1.maxFrameRate }!
  device.activeVideoMinFrameDuration = range.minFrameDuration
  device.activeVideoMaxFrameDuration = range.maxFrameDuration
  device.unlockForConfiguration()
} catch {
  warn("could not set format: \(error.localizedDescription)")
}

let d = CMVideoFormatDescriptionGetDimensions(format!.formatDescription)
warn("capturing \(device.localizedName) \(d.width)x\(d.height)@\(Int(fps.rounded())) (\(FourCharCode(CMFormatDescriptionGetMediaSubType(format!.formatDescription)).fourCC))")

session.startRunning()
RunLoop.main.run()

extension FourCharCode {
  var fourCC: String {
    let bytes = [
      UInt8((self >> 24) & 255), UInt8((self >> 16) & 255),
      UInt8((self >> 8) & 255), UInt8(self & 255),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? "????"
  }
}
