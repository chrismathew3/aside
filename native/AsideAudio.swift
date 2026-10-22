// Captures everything your Mac plays (the other side of the call) with ScreenCaptureKit
// and writes it to stdout as raw 16-bit mono PCM at 24 kHz.
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError
func log(_ s: String) { stderr.write((s + "\n").data(using: .utf8)!) }

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    let queue = DispatchQueue(label: "aside.audio")
    var reportedFormat = false

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "aside", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 24000
        config.channelCount = 1
        // We only want audio; keep the video side as small and slow as possible.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid,
              let asbd = sb.formatDescription?.audioStreamBasicDescription else { return }
        if !reportedFormat {
            reportedFormat = true
            log("format rate=\(Int(asbd.mSampleRate)) channels=\(asbd.mChannelsPerFrame)")
        }
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        try? sb.withAudioBufferList { list, _ in
            guard let first = list.first, let data = first.mData else { return }
            let stride = nonInterleaved ? 1 : channels
            var pcm: [Int16]
            if isFloat {
                let src = data.assumingMemoryBound(to: Float.self)
                let frames = Int(first.mDataByteSize) / 4 / stride
                pcm = [Int16](repeating: 0, count: frames)
                for i in 0..<frames {
                    let v = max(-1, min(1, src[i * stride]))
                    pcm[i] = Int16(v * 32767)
                }
            } else {
                let src = data.assumingMemoryBound(to: Int16.self)
                let frames = Int(first.mDataByteSize) / 2 / stride
                pcm = [Int16](repeating: 0, count: frames)
                for i in 0..<frames { pcm[i] = src[i * stride] }
            }
            pcm.withUnsafeBytes { stdout.write(Data($0)) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("error: \(error.localizedDescription)")
        exit(3)
    }
}

let capture = Capture()
signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }
Task {
    do {
        try await capture.start()
        log("ready")
    } catch {
        log("error: \(error.localizedDescription)")
        exit(2)
    }
}
dispatchMain()
