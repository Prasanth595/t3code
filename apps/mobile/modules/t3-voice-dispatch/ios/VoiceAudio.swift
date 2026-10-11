import AVFoundation
import Foundation
import Speech

enum VoiceAudioError: LocalizedError {
  case microphoneDenied
  case speechUnavailable
  case listenerBusy

  var errorDescription: String? {
    switch self {
    case .microphoneDenied:
      return "T3 Code needs microphone access. Allow it in Settings on your iPhone."
    case .speechUnavailable:
      return "Speech recognition isn't available on this iPhone."
    case .listenerBusy:
      return "T3 Code is already listening."
    }
  }
}

/// CarPlay asks voice apps to hold the audio session only while voice is in
/// use, so a conversation activates it and its end releases it.
enum VoiceAudioSession {
  static func activate() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .default,
      options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP]
    )
    try session.setActive(true)
  }

  static func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

/// Speaks prompts and resolves when the utterance finishes or is cancelled.
@MainActor
final class VoiceSpeaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var pending: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]

  override init() {
    super.init()
    synthesizer.usesApplicationAudioSession = true
    synthesizer.delegate = self
  }

  func speak(_ text: String) async throws {
    try VoiceAudioSession.activate()
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    let id = ObjectIdentifier(utterance)
    // A stalled audio route never reports the end of speech. The deadline
    // allows for slower speech than the default rate.
    let deadline = Duration.seconds(min(30, 3 + Double(text.count) / 10))
    Task { @MainActor in
      try? await Task.sleep(for: deadline)
      if self.pending[id] != nil {
        self.synthesizer.stopSpeaking(at: .immediate)
        self.finish(id)
      }
    }
    await withCheckedContinuation { continuation in
      pending[id] = continuation
      synthesizer.speak(utterance)
    }
  }

  func stop() {
    synthesizer.stopSpeaking(at: .immediate)
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    let id = ObjectIdentifier(utterance)
    Task { @MainActor in self.finish(id) }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    let id = ObjectIdentifier(utterance)
    Task { @MainActor in self.finish(id) }
  }

  private func finish(_ id: ObjectIdentifier) {
    pending.removeValue(forKey: id)?.resume()
  }
}

struct VoiceListenRequest {
  let endSilence: Duration
  let startTimeout: Duration
  let maxDuration: Duration
  let hints: [String]
}

enum VoiceListenOutcome {
  case speech(String)
  case noSpeech
  case button(String)
}

/// Thread-safe transcript accumulation shared with the recognizer task.
private final class TranscriptState: @unchecked Sendable {
  private let lock = NSLock()
  private var finalized = ""
  private var volatile = ""
  private var lastChange: ContinuousClock.Instant?

  func apply(text: String, isFinal: Bool) {
    lock.lock()
    defer { lock.unlock() }
    if isFinal {
      finalized += text
      volatile = ""
    } else {
      volatile = text
    }
    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      lastChange = .now
    }
  }

  var snapshot: (text: String, lastChange: ContinuousClock.Instant?) {
    lock.lock()
    defer { lock.unlock() }
    let text = (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
    return (text, lastChange)
  }
}

/// Live on-device transcription with Apple's SpeechAnalyzer, the engine the
/// composer's dictation uses. Listening ends when the speaker goes quiet, a
/// screen button is tapped, or time runs out.
@available(iOS 26.0, *)
@MainActor
final class VoiceListener {
  private enum StopRequest {
    case keepTranscript
    case button(String)
  }

  private var stopRequest: StopRequest?
  private var listening = false

  var isListening: Bool { listening }

  /// Ends the current listen. Finish buttons keep what was heard.
  func stop(buttonId: String, keepTranscript: Bool) {
    guard listening else { return }
    stopRequest = keepTranscript ? .keepTranscript : .button(buttonId)
  }

  func cancel() {
    guard listening else { return }
    stopRequest = .button("")
  }

  func listen(_ request: VoiceListenRequest) async throws -> VoiceListenOutcome {
    guard !listening else { throw VoiceAudioError.listenerBusy }
    guard await AVAudioApplication.requestRecordPermission() else {
      throw VoiceAudioError.microphoneDenied
    }
    listening = true
    stopRequest = nil
    defer { listening = false }

    let capture = try await LiveCapture.start(hints: request.hints)
    let started = ContinuousClock.now
    while true {
      try? await Task.sleep(for: .milliseconds(100))
      if Task.isCancelled {
        await capture.cancel()
        return .noSpeech
      }
      switch stopRequest {
      case .keepTranscript?:
        return await capture.finish()
      case let .button(buttonId)?:
        await capture.cancel()
        return .button(buttonId)
      case nil:
        switch Self.silenceDecision(request, snapshot: capture.state.snapshot, started: started) {
        case .keepListening:
          continue
        case .finish:
          return await capture.finish()
        case .noSpeech:
          await capture.cancel()
          return .noSpeech
        }
      }
    }
  }

  private enum SilenceDecision {
    case keepListening
    case finish
    case noSpeech
  }

  /// Speech ends when the transcript stops changing; road noise keeps the
  /// level up, so the words are the signal, not loudness.
  private static func silenceDecision(
    _ request: VoiceListenRequest,
    snapshot: (text: String, lastChange: ContinuousClock.Instant?),
    started: ContinuousClock.Instant
  ) -> SilenceDecision {
    let now = ContinuousClock.now
    guard let lastChange = snapshot.lastChange else {
      return now - started >= request.startTimeout ? .noSpeech : .keepListening
    }
    if now - lastChange >= request.endSilence || now - started >= request.maxDuration {
      return .finish
    }
    return .keepListening
  }
}

/// One microphone capture feeding a SpeechAnalyzer until finished or cancelled.
@available(iOS 26.0, *)
@MainActor
private final class LiveCapture {
  let state: TranscriptState
  private let engine: AVAudioEngine
  private let analyzer: SpeechAnalyzer
  private let inputBuilder: AsyncStream<AnalyzerInput>.Continuation
  private let results: Task<Void, Error>

  private init(
    state: TranscriptState,
    engine: AVAudioEngine,
    analyzer: SpeechAnalyzer,
    inputBuilder: AsyncStream<AnalyzerInput>.Continuation,
    results: Task<Void, Error>
  ) {
    self.state = state
    self.engine = engine
    self.analyzer = analyzer
    self.inputBuilder = inputBuilder
    self.results = results
  }

  static func start(hints: [String]) async throws -> LiveCapture {
    let transcription = try await LiveTranscription.make(locale: Locale.current)
    let analyzer = SpeechAnalyzer(modules: [transcription.module])
    if !hints.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = hints
      try? await analyzer.setContext(context)
    }

    try VoiceAudioSession.activate()
    let engine = AVAudioEngine()
    let inputFormat = engine.inputNode.outputFormat(forBus: 0)
    let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
      compatibleWith: [transcription.module],
      considering: inputFormat
    ) ?? inputFormat
    let (inputs, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self)
    engine.inputNode.installTap(
      onBus: 0,
      bufferSize: 4096,
      format: inputFormat,
      block: makeTap(from: inputFormat, to: analyzerFormat, into: inputBuilder)
    )

    let state = TranscriptState()
    let results = Task {
      for try await (text, isFinal) in transcription.results {
        state.apply(text: text, isFinal: isFinal)
      }
    }
    let capture = LiveCapture(
      state: state,
      engine: engine,
      analyzer: analyzer,
      inputBuilder: inputBuilder,
      results: results
    )

    engine.prepare()
    do {
      try engine.start()
      try await analyzer.start(inputSequence: inputs)
    } catch {
      await capture.cancel()
      throw error
    }
    return capture
  }

  /// Stops the microphone and waits for the words still being recognized.
  func finish() async -> VoiceListenOutcome {
    stopMicrophone()
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
    _ = try? await results.value
    let text = state.snapshot.text
    return text.isEmpty ? .noSpeech : .speech(text)
  }

  func cancel() async {
    stopMicrophone()
    await analyzer.cancelAndFinishNow()
    results.cancel()
  }

  private func stopMicrophone() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    inputBuilder.finish()
  }

  /// Built outside the main actor: the tap runs on the audio render thread.
  private nonisolated static func makeTap(
    from inputFormat: AVAudioFormat,
    to analyzerFormat: AVAudioFormat,
    into builder: AsyncStream<AnalyzerInput>.Continuation
  ) -> AVAudioNodeTapBlock {
    let converter = inputFormat == analyzerFormat
      ? nil
      : AVAudioConverter(from: inputFormat, to: analyzerFormat)
    return { buffer, _ in
      guard let converter else {
        builder.yield(AnalyzerInput(buffer: buffer))
        return
      }
      let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
      let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
      guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
        return
      }
      var supplied = false
      var error: NSError?
      converter.convert(to: converted, error: &error) { _, status in
        if supplied {
          status.pointee = .noDataNow
          return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
      }
      if error == nil, converted.frameLength > 0 {
        builder.yield(AnalyzerInput(buffer: converted))
      }
    }
  }
}

/// The transcriber module plus its results as plain text. SpeechTranscriber
/// is preferred; DictationTranscriber covers devices without it.
@available(iOS 26.0, *)
private struct LiveTranscription {
  let module: any SpeechModule
  let results: AsyncThrowingStream<(String, Bool), Error>

  static func make(locale: Locale) async throws -> LiveTranscription {
    if SpeechTranscriber.isAvailable,
       let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
      let transcriber = SpeechTranscriber(
        locale: supported,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults],
        attributeOptions: []
      )
      try await installAssets(for: transcriber)
      return LiveTranscription(module: transcriber, results: mapped(transcriber.results) {
        (String($0.text.characters), $0.isFinal)
      })
    }
    guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else {
      throw VoiceAudioError.speechUnavailable
    }
    let transcriber = DictationTranscriber(
      locale: supported,
      contentHints: [.farField],
      transcriptionOptions: [.punctuation],
      reportingOptions: [.volatileResults],
      attributeOptions: []
    )
    try await installAssets(for: transcriber)
    return LiveTranscription(module: transcriber, results: mapped(transcriber.results) {
      (String($0.text.characters), $0.isFinal)
    })
  }

  private static func installAssets(for module: any SpeechModule) async throws {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
      try await request.downloadAndInstall()
    }
  }

  private static func mapped<Results: AsyncSequence & Sendable>(
    _ results: Results,
    _ transform: @escaping @Sendable (Results.Element) -> (String, Bool)
  ) -> AsyncThrowingStream<(String, Bool), Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await result in results {
            continuation.yield(transform(result))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
