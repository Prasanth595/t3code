import Foundation
import UIKit
import WatchConnectivity

final class WatchReceiver: NSObject, WCSessionDelegate {
  static var isEnabled: Bool { Bundle.main.object(forInfoDictionaryKey: "T3WatchCompanionEnabled") as? Bool == true }
  static let shared = WatchReceiver()
  private let queue = DispatchQueue(label: "codes.t3.watch-inbox")
  private var store: RecordingStore?
  private var actionStore: ActionStore?
  private var startupError: Error?
  private var snapshot: Data?
  private var snapshotURL: URL?
  var onRecordingsChanged: (() -> Void)?
  var onAction: (([String: Any]) -> Void)?
  var observing = false

  private override init() {
    super.init()
    do { try initializeStorage() } catch { startupError = error }
  }

  private func initializeStorage() throws {
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let root = support.appendingPathComponent("T3WatchInbox", isDirectory: true)
    store = try RecordingStore(root: root)
    actionStore = try ActionStore(root: root.appendingPathComponent("actions", isDirectory: true))
    snapshotURL = root.appendingPathComponent("snapshot.json")
    if let url = snapshotURL, FileManager.default.fileExists(atPath: url.path) {
      let data = try Data(contentsOf: url)
      _ = try WatchSnapshot.decode(data)
      snapshot = data
    }
  }

  func start() throws {
    guard Self.isEnabled else { throw WatchBridgeError.invalid("Watch companion is disabled in this build") }
    guard WCSession.isSupported() else { throw WatchBridgeError.invalid("WatchConnectivity unavailable") }
    let session = WCSession.default
    guard session.delegate == nil || session.delegate === self else {
      throw WatchBridgeError.invalid("Another native component owns WCSession.delegate")
    }
    session.delegate = self
    session.activate()
  }

  private func requireStore() throws -> RecordingStore {
    if store == nil {
      do { try initializeStorage(); startupError = nil } catch { startupError = error }
    }
    guard let store else { throw startupError ?? WatchBridgeError.invalid("Watch inbox unavailable") }
    return store
  }

  func list() throws -> [[String: Any]] {
    try queue.sync {
      let store = try requireStore()
      return try store.list().map { try $0.dictionary(uri: store.audioURL($0.id)) }
    }
  }

  func remove(_ id: String) throws {
    try queue.sync { try requireStore().remove(id) }
    DispatchQueue.main.async { self.onRecordingsChanged?() }
  }

  private func requireActions() throws -> ActionStore {
    if actionStore == nil { try initializeStorage() }
    guard let actionStore else { throw WatchBridgeError.invalid("Action storage unavailable") }
    return actionStore
  }

  func listPendingActions() throws -> [[String: Any]] {
    try queue.sync { try requireActions().list().map { try $0.dictionary() } }
  }

  func removeAction(_ id: String) throws {
    try queue.sync { try requireActions().remove(id) }
  }

  func beginObservingActions() {
    observing = true
    queue.async {
      do {
        let actions = try self.requireActions().list().map { try $0.dictionary() }
        DispatchQueue.main.async {
          guard self.observing else { return }
          for action in actions { self.onAction?(action) }
        }
      } catch { NSLog("T3 Watch action replay failed: %@", error.localizedDescription) }
    }
  }

  func publish(_ json: String) throws {
    let sanitized = try JSONEncoder().encode(WatchSnapshot.decode(Data(json.utf8)))
    try queue.sync {
      _ = try requireStore()
      guard let snapshotURL else { throw WatchBridgeError.invalid("Snapshot storage unavailable") }
      try WatchFiles.write(sanitized, to: snapshotURL)
      snapshot = sanitized
      if WCSession.default.activationState == .activated {
        try WCSession.default.updateApplicationContext(["t3Snapshot": sanitized])
      }
    }
  }

  func session(_ session: WCSession, didReceive file: WCSessionFile) {
    queue.sync {
      do {
        guard let data = file.metadata?["recording"] as? Data,
          data.count <= 4096, let digest = file.metadata?["digest"] as? String
        else { throw WatchBridgeError.invalid("Missing recording metadata") }
        let recording = try JSONDecoder().decode(WatchRecording.self, from: data)
        let receipt = try requireStore().receive(file.fileURL, recording: recording, expectedDigest: digest)
        acknowledge(receipt, session: session)
        DispatchQueue.main.async { self.onRecordingsChanged?() }
      } catch {
        NSLog("T3 Watch inbox receive failed: %@", error.localizedDescription)
      }
    }
  }

  private func acknowledge(_ receipt: RecordingStore.Receipt, session: WCSession) {
    guard !session.outstandingUserInfoTransfers.contains(where: {
      $0.userInfo["t3Ack"] as? String == receipt.recording.id && $0.userInfo["digest"] as? String == receipt.digest
    }) else { return }
    session.transferUserInfo(["t3Ack": receipt.recording.id, "digest": receipt.digest])
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    guard let data = message["t3Action"] as? Data, data.count <= 8192 else {
      replyHandler(["status": "rejected"])
      return
    }
    do {
      let action = try JSONDecoder().decode(WatchAction.self, from: data)
      try action.validate()
      let payload = try action.dictionary()
      DispatchQueue.main.async {
        guard UIApplication.shared.applicationState == .active else {
          replyHandler(["id": action.id, "status": "unavailable"])
          return
        }
        self.queue.async {
          do {
            try self.requireActions().save(action)
            DispatchQueue.main.async {
              if self.observing { self.onAction?(payload) }
              replyHandler(["id": action.id, "status": "pending"])
            }
          } catch {
            replyHandler(["id": action.id, "status": "rejected"])
          }
        }
      }
    } catch { replyHandler(["status": "rejected"]) }
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    guard activationState == .activated else { return }
    queue.async {
      if let snapshot = self.snapshot {
        do { try session.updateApplicationContext(["t3Snapshot": snapshot]) } catch { NSLog("T3 Watch snapshot update failed: %@", error.localizedDescription) }
      }
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
