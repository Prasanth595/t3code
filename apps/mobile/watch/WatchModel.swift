import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

@MainActor
final class WatchAudioMeter: ObservableObject {
  @Published private(set) var levels = Array(repeating: 0.0, count: 5)

  func sample(_ power: Float) {
    let level = power.isFinite ? min(1, max(0, (Double(power) + 50) / 50)) : 0
    levels = Array(levels.dropFirst()) + [level * level]
  }

  func reset() { levels = Array(repeating: 0, count: 5) }
}

@MainActor
final class WatchModel: NSObject, ObservableObject, WCSessionDelegate, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
  @Published var threads: [WatchThread] = []
  @Published var recordings: [WatchRecording] = []
  @Published var recordingID: String?
  @Published var requestingPermission = false
  @Published var elapsed = 0
  @Published var notice = ""
  @Published var recordingTitle: String?
  @Published var playingID: String?
  @Published private(set) var canRecord = false
  @Published private(set) var recoveryIDs: Set<String> = []
  @Published private(set) var transferringIDs: Set<String> = []
  @Published var actionPending = false
  @Published var captureError: String?
  let audioMeter = WatchAudioMeter()
  var isForeground = true {
    didSet {
      if isForeground, recordingID != nil { startMetering() } else { meterTimer?.invalidate(); meterTimer = nil; audioMeter.reset() }
    }
  }
  private var store: RecordingStore?
  private var root: URL?
  private var recorder: AVAudioRecorder?
  private var timer: Timer?
  private var meterTimer: Timer?
  private var retryTimer: Timer?
  private var interruptionToken: NSObjectProtocol?
  private var lastTransfer: [String: Date] = [:]
  private var player: AVAudioPlayer?
  private var pendingActionID: String?
  private var actionTimeout: Task<Void, Never>?

  func recordingStatus(_ id: String) -> String {
    if id == recordingID { return "Recording" }
    if id == playingID { return "Playing" }
    if recoveryIDs.contains(id) { return "Needs recovery" }
    if transferringIDs.contains(id) { return "Sending to iPhone" }
    return "Waiting for iPhone"
  }

  override init() {
    super.init()
    do {
      let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      let root = support.appendingPathComponent("T3WatchCapture", isDirectory: true)
      self.root = root
      store = try RecordingStore(root: root)
      canRecord = true
      if let count = try store?.recoveryCount(), count > 0 {
        notice = "Some audio needs recovery."
      }
      let snapshotURL = root.appendingPathComponent("snapshot.json")
      if FileManager.default.fileExists(atPath: snapshotURL.path) {
        do { threads = try WatchSnapshot.decode(Data(contentsOf: snapshotURL)).threads } catch { notice = "Cannot load threads. Open T3 on iPhone." }
      }
    } catch { notice = "Storage unavailable: \(error.localizedDescription)" }
    if WCSession.isSupported() {
      if WCSession.default.delegate == nil {
        WCSession.default.delegate = self
        WCSession.default.activate()
      } else { notice = "Watch connectivity is owned by another component." }
    }
    interruptionToken = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        if self.recordingID != nil {
          self.stopRecording()
          self.notice = "Recording interrupted. Check Recordings."
        }
        self.stopPlayback()
      }
    }
    retryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshAndTransfer() }
    }
    refreshAndTransfer()
  }

  func startRecording(replyTo thread: WatchThread? = nil) {
    guard recordingID == nil, !requestingPermission, store != nil else { return }
    requestingPermission = true
    AVAudioApplication.requestRecordPermission { [weak self] granted in
      Task { @MainActor in
        guard let self else { return }
        self.requestingPermission = false
        guard granted else {
          self.notice = "Microphone access is off. Enable it in Settings to record."
          self.captureError = self.notice
          return
        }
        guard let store = self.store else {
          self.notice = "Storage unavailable; recording was not started."
          return
        }
        self.beginRecording(store: store, thread: thread)
      }
    }
  }

  private func beginRecording(store: RecordingStore, thread: WatchThread?) {
    guard isForeground, recordingID == nil else {
      notice = "Return to T3 Code to record."
      return
    }
    if let thread, !threads.contains(where: { $0.bindingID == thread.bindingID }) {
      notice = "Reply destination changed while waiting for microphone permission. Choose it again."
      return
    }
    var reservedID: String?
    do {
      stopPlayback()
      let recording = WatchRecording(id: UUID().uuidString, createdAt: ISO8601DateFormatter().string(from: Date()), kind: thread == nil ? "new-thread" : "reply", environmentId: thread?.environmentId, threadId: thread?.id)
      let url = try store.reserve(recording)
      reservedID = recording.id
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .default)
      try audio.setActive(true)
      let recorder = try AVAudioRecorder(url: url, settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 22050,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 64000,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
      ])
      recorder.delegate = self
      recorder.isMeteringEnabled = true
      guard recorder.prepareToRecord(), recorder.record(forDuration: 180) else {
        throw WatchBridgeError.invalid("Microphone could not start")
      }
      self.recorder = recorder
      recordingID = recording.id
      recordingTitle = thread?.title
      WKInterfaceDevice.current().play(.start)
      elapsed = 0
      audioMeter.reset()
      startMetering()
      notice = ""
      timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          self.elapsed = Int(self.recorder?.currentTime ?? 0)
        }
      }
      recordings = try store.list()
    } catch {
      if recordingID != nil, recordingID == reservedID { stopRecording() }
      if let reservedID { _ = try? store.removeEmptyCapture(reservedID) }
      try? AVAudioSession.sharedInstance().setActive(false)
      notice = error.localizedDescription
      captureError = notice
      refreshAndTransfer()
    }
  }

  private func startMetering() {
    meterTimer?.invalidate()
    meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.isForeground, let recorder = self.recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        self.audioMeter.sample(recorder.averagePower(forChannel: 0))
      }
    }
  }

  func stopRecording() {
    guard recordingID != nil else { return }
    let id = recordingID
    let activeRecorder = recorder
    recorder = nil
    recordingID = nil
    recordingTitle = nil
    timer?.invalidate()
    timer = nil
    meterTimer?.invalidate()
    meterTimer = nil
    audioMeter.reset()
    activeRecorder?.stop()
    WKInterfaceDevice.current().play(.stop)
    try? AVAudioSession.sharedInstance().setActive(false)
    notice = "Saved on Watch."
    if let id, let store {
      do {
        if try store.removeEmptyCapture(id) {
          notice = "No audio recorded. Try again."
        }
      } catch { notice = "Audio needs recovery. Original kept." }
    }
    refreshAndTransfer()
  }

  func play(_ recording: WatchRecording) {
    guard recordingID == nil, let store else { return }
    do {
      stopPlayback()
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback)
      try session.setActive(true)
      let player = try AVAudioPlayer(contentsOf: store.audioURL(recording.id))
      player.delegate = self
      guard player.play() else { throw WatchBridgeError.invalid("Cannot play this capture") }
      self.player = player
      playingID = recording.id
    } catch {
      stopPlayback()
      recoveryIDs.insert(recording.id)
      notice = "Cannot play. Audio kept for recovery."
    }
  }

  func stopPlayback() {
    player?.stop()
    player = nil
    playingID = nil
    if recordingID == nil { try? AVAudioSession.sharedInstance().setActive(false) }
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in
      guard self.player === player else { return }
      self.stopPlayback()
      if !flag { self.notice = "Playback stopped unexpectedly. Audio stays on Watch." }
    }
  }

  nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    Task { @MainActor in
      guard self.player === player else { return }
      self.stopPlayback()
      self.notice = "Cannot play. Audio kept for recovery."
    }
  }

  func discard(_ recording: WatchRecording) {
    guard recording.id != recordingID, let store else { return }
    for transfer in WCSession.default.outstandingFileTransfers where transfer.file.metadata?["id"] as? String == recording.id {
      transfer.cancel()
    }
    do {
      stopPlayback()
      try store.remove(recording.id)
      lastTransfer.removeValue(forKey: recording.id)
      recordings = try store.list()
      recoveryIDs.remove(recording.id)
      transferringIDs.remove(recording.id)
      notice = "Deleted from Watch."
    } catch { notice = error.localizedDescription }
  }

  func refreshAndTransfer() {
    guard let store else { return }
    do {
      recordings = try store.list()
      let session = WCSession.default
      transferringIDs = Set(session.outstandingFileTransfers.compactMap { $0.file.metadata?["id"] as? String })
      recoveryIDs = recoveryIDs.intersection(recordings.map(\.id))
      for recording in recordings where recording.id != recordingID {
        let url = try store.audioURL(recording.id)
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        do {
          let file = try AVAudioFile(forReading: url)
          guard file.length > 0, Double(file.length) / file.processingFormat.sampleRate <= 185 else {
            recoveryIDs.insert(recording.id)
            continue
          }
          recoveryIDs.remove(recording.id)
          guard session.activationState == .activated else { continue }
          let receipt = try store.receipt(recording.id)
          guard !session.outstandingFileTransfers.contains(where: { $0.file.metadata?["id"] as? String == recording.id }),
            Date().timeIntervalSince(lastTransfer[recording.id] ?? .distantPast) >= 60
          else { continue }
          session.transferFile(url, metadata: ["id": recording.id, "recording": try JSONEncoder().encode(recording), "digest": receipt.digest])
          lastTransfer[recording.id] = Date()
          transferringIDs.insert(recording.id)
        } catch { recoveryIDs.insert(recording.id) }
      }
    } catch { notice = error.localizedDescription }
  }

  func requestAction(_ kind: String, thread: WatchThread, answer: String? = nil, reviewOnPhone: Bool = false) {
    let session = WCSession.default
    guard !actionPending, session.activationState == .activated, session.isReachable else {
      notice = "Open T3 on iPhone first."
      return
    }
    let request = kind == "answer" || kind == "approval" ? thread.pendingRequest : nil
    let action = WatchAction(id: UUID().uuidString, kind: kind, environmentId: thread.environmentId, threadId: thread.id, requestId: request?.id, questionId: reviewOnPhone ? nil : request?.questionId, answer: answer, decision: kind == "approval" || reviewOnPhone ? "review-on-phone" : nil, expectedUpdatedAt: kind == "settle" || kind == "reopen" ? thread.updatedAt : nil)
    do {
      try action.validate()
      actionPending = true
      pendingActionID = action.id
      notice = "Requesting iPhone review…"
      actionTimeout?.cancel()
      actionTimeout = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(20)) } catch { return }
        self?.finishAction(action.id, notice: "Delivery uncertain. Check iPhone before retrying.")
      }
      session.sendMessage(["t3Action": try JSONEncoder().encode(action)], replyHandler: { [weak self] reply in
        let pending = reply["status"] as? String == "pending" && reply["id"] as? String == action.id
        Task { @MainActor in
          self?.finishAction(action.id, notice: pending ? "Ready for iPhone review." : "Not accepted. Open T3 on iPhone and try again.")
        }
      }, errorHandler: { [weak self] _ in
        Task { @MainActor in
          self?.finishAction(action.id, notice: "Delivery uncertain. Check iPhone before retrying.")
        }
      })
    } catch { notice = error.localizedDescription }
  }

  private func finishAction(_ id: String, notice: String) {
    guard pendingActionID == id else { return }
    actionTimeout?.cancel()
    actionTimeout = nil
    pendingActionID = nil
    actionPending = false
    self.notice = notice
  }

  nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    Task { @MainActor in
      guard self.recorder === recorder else { return }
      self.stopRecording()
      if !flag { self.notice = "Capture interrupted; original audio retained for recovery." }
    }
  }

  nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    Task { @MainActor in
      guard self.recorder === recorder else { return }
      self.stopRecording()
      self.notice = "Audio encoding failed; recoverable file retained."
    }
  }

  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    let context = session.receivedApplicationContext["t3Snapshot"] as? Data
    Task { @MainActor in
      if let error { self.notice = "iPhone connection unavailable: \(error.localizedDescription)" }
      if let context { self.receiveSnapshot(context) }
      self.refreshAndTransfer()
    }
  }

  nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    guard let data = applicationContext["t3Snapshot"] as? Data else { return }
    Task { @MainActor in self.receiveSnapshot(data) }
  }

  private func receiveSnapshot(_ data: Data) {
    do {
      let snapshot = try WatchSnapshot.decode(data)
      guard let root else { return }
      try JSONEncoder().encode(snapshot).write(to: root.appendingPathComponent("snapshot.json"), options: .atomic)
      threads = snapshot.threads
    } catch { notice = "Rejected invalid snapshot. Previous snapshot retained." }
  }

  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard let id = userInfo["t3Ack"] as? String, let digest = userInfo["digest"] as? String else { return }
    Task { @MainActor in
      do {
        for transfer in WCSession.default.outstandingFileTransfers where transfer.file.metadata?["id"] as? String == id {
          transfer.cancel()
        }
        let wasStored = self.recordings.contains { $0.id == id }
        try self.store?.acknowledge(id, digest: digest)
        if self.playingID == id { self.stopPlayback() }
        if wasStored { self.notice = "Received on iPhone." }
        self.lastTransfer.removeValue(forKey: id)
        self.refreshAndTransfer()
      } catch { self.notice = "Receipt mismatch. Audio kept." }
    }
  }

  nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
    if error != nil {
      Task { @MainActor in self.notice = "Transfer interrupted. Audio kept for retry." }
    }
  }
}
