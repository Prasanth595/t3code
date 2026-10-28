import Foundation
import CryptoKit

final class RecordingStore {
  static let maximumFileBytes = 10 * 1024 * 1024
  static let maximumTotalBytes = 64 * 1024 * 1024
  static let maximumRecords = 32
  private let root: URL
  private let lock = NSRecursiveLock()
  private let manager = FileManager.default

  struct Receipt: Codable, Equatable {
    let recording: WatchRecording
    let digest: String
  }

  init(root: URL) throws {
    self.root = root
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    for folder in ["records", "reservations", "staging", "receipts", "dismissed", "conflicts"] {
      try manager.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
    }
    #if os(iOS)
    for directory in [root] + ["records", "reservations", "staging", "receipts", "dismissed", "conflicts"].map({ root.appendingPathComponent($0) }) {
      try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
    }
    #endif
    var excluded = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    for directory in try entries("reservations") {
      if manager.fileExists(atPath: directory.appendingPathComponent("audio.m4a").path) {
        try manager.moveItem(at: directory, to: root.appendingPathComponent("conflicts/\(UUID().uuidString)"))
      } else { try manager.removeItem(at: directory) }
    }
    try recoverStaging()
    for recording in try list() { try removeEmptyCapture(recording.id) }
  }

  private func synchronized<Value>(_ work: () throws -> Value) rethrows -> Value {
    lock.lock()
    defer { lock.unlock() }
    return try work()
  }

  private func entries(_ folder: String) throws -> [URL] {
    try manager.contentsOfDirectory(at: root.appendingPathComponent(folder), includingPropertiesForKeys: nil)
  }

  private func recordURL(_ id: String) throws -> URL {
    guard UUID(uuidString: id)?.uuidString == id else { throw WatchBridgeError.invalid("Invalid recording ID") }
    return root.appendingPathComponent("records/\(id)", isDirectory: true)
  }

  func audioURL(_ id: String) throws -> URL { try recordURL(id).appendingPathComponent("audio.m4a") }

  func list() throws -> [WatchRecording] {
    try synchronized {
      var recordings: [WatchRecording] = []
      for directory in try entries("records") {
        do {
          let recording = try JSONDecoder().decode(WatchRecording.self, from: Data(contentsOf: directory.appendingPathComponent("metadata.json")))
          try recording.validate()
          guard recording.id == directory.lastPathComponent else { throw WatchBridgeError.invalid("Stored recording ID mismatch") }
          recordings.append(recording)
        } catch {
          if (try? manager.contentsOfDirectory(atPath: directory.path).isEmpty) == true {
            try? manager.removeItem(at: directory)
          } else {
            try? manager.moveItem(at: directory, to: root.appendingPathComponent("conflicts/\(UUID().uuidString)"))
          }
        }
      }
      return recordings.sorted { $0.createdAt < $1.createdAt }
    }
  }

  func reserve(_ recording: WatchRecording) throws -> URL {
    try synchronized {
      try recording.validate()
      try checkCapacity(additionalBytes: 0)
      let directory = try recordURL(recording.id)
      guard !manager.fileExists(atPath: directory.path) else { throw WatchBridgeError.invalid("Recording exists") }
      let reservation = root.appendingPathComponent("reservations/\(recording.id)")
      try manager.createDirectory(at: reservation, withIntermediateDirectories: false)
      do {
        try WatchFiles.write(JSONEncoder().encode(recording), to: reservation.appendingPathComponent("metadata.json"))
        try manager.moveItem(at: reservation, to: directory)
      } catch {
        try? manager.removeItem(at: reservation)
        throw error
      }
      return directory.appendingPathComponent("audio.m4a")
    }
  }

  private func checkCapacity(additionalBytes: Int) throws {
    let count = try entries("records").count + entries("reservations").count + entries("staging").count + entries("conflicts").count
    let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey])
    var bytes = 0
    while let file = enumerator?.nextObject() as? URL {
      bytes += try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    }
    guard count < Self.maximumRecords, bytes + additionalBytes <= Self.maximumTotalBytes
    else { throw WatchBridgeError.invalid("Capture inbox full; review recordings on iPhone") }
  }

  func receipt(_ id: String) throws -> Receipt {
    try synchronized {
      let directory = try recordURL(id)
      let recording = try JSONDecoder().decode(WatchRecording.self, from: Data(contentsOf: directory.appendingPathComponent("metadata.json")))
      return Receipt(recording: recording, digest: try digest(audioURL(id)))
    }
  }

  private func digest(_ url: URL) throws -> String {
    let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
    guard !bytes.isEmpty, bytes.count <= Self.maximumFileBytes else { throw WatchBridgeError.invalid("Invalid audio size") }
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  func receive(_ file: URL, recording: WatchRecording, expectedDigest: String) throws -> Receipt {
    try synchronized {
      try recording.validate()
      guard expectedDigest.count == 64, try digest(file) == expectedDigest else {
        throw WatchBridgeError.invalid("Audio digest mismatch")
      }
      let incoming = Receipt(recording: recording, digest: expectedDigest)
      let receiptURL = root.appendingPathComponent("receipts/\(recording.id).json")
      if manager.fileExists(atPath: receiptURL.path) {
        let existing = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: receiptURL))
        if existing == incoming {
          if manager.fileExists(atPath: try recordURL(recording.id).path) {
            guard try receipt(recording.id) == incoming else {
              throw WatchBridgeError.invalid("Stored audio differs from durable receipt; Watch audio retained")
            }
          } else if !manager.fileExists(atPath: root.appendingPathComponent("dismissed/\(recording.id)").path) {
            throw WatchBridgeError.invalid("Stored audio differs from durable receipt; Watch audio retained")
          }
          return existing
        }
      } else if manager.fileExists(atPath: try recordURL(recording.id).path),
        try receipt(recording.id) == incoming {
        try WatchFiles.write(JSONEncoder().encode(incoming), to: receiptURL)
        return incoming
      }
      let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Self.maximumFileBytes
      try checkCapacity(additionalBytes: size)
      let stage = root.appendingPathComponent("staging/\(UUID().uuidString)", isDirectory: true)
      try manager.createDirectory(at: stage, withIntermediateDirectories: false)
      try WatchFiles.write(JSONEncoder().encode(incoming), to: stage.appendingPathComponent("receipt.json"))
      try WatchFiles.write(JSONEncoder().encode(recording), to: stage.appendingPathComponent("metadata.json"))
      try manager.moveItem(at: file, to: stage.appendingPathComponent("audio.m4a"))
      #if os(iOS)
      try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: stage.appendingPathComponent("audio.m4a").path)
      #endif
      try commitStage(stage, receipt: incoming)
      return incoming
    }
  }

  private func commitStage(_ stage: URL, receipt: Receipt) throws {
    let destination = try recordURL(receipt.recording.id)
    let receiptURL = root.appendingPathComponent("receipts/\(receipt.recording.id).json")
    if manager.fileExists(atPath: destination.path) || manager.fileExists(atPath: receiptURL.path) {
      try manager.moveItem(at: stage, to: root.appendingPathComponent("conflicts/\(UUID().uuidString)"))
      throw WatchBridgeError.invalid("Conflicting recording ID retained for recovery; not acknowledged")
    }
    try manager.moveItem(at: stage, to: destination)
    try WatchFiles.write(JSONEncoder().encode(receipt), to: receiptURL)
  }

  private func recoverStaging() throws {
    for stage in try entries("staging") {
      let audio = stage.appendingPathComponent("audio.m4a")
      guard manager.fileExists(atPath: audio.path) else {
        try manager.removeItem(at: stage)
        continue
      }
      do {
        let receipt = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: stage.appendingPathComponent("receipt.json")))
        try receipt.recording.validate()
        guard try digest(audio) == receipt.digest else {
          throw WatchBridgeError.invalid("Staged audio corrupted; retained")
        }
        try commitStage(stage, receipt: receipt)
      } catch {
        if manager.fileExists(atPath: stage.path) {
          try manager.moveItem(at: stage, to: root.appendingPathComponent("conflicts/\(UUID().uuidString)"))
        }
      }
    }
  }

  func recoveryCount() throws -> Int {
    try synchronized { try entries("conflicts").count }
  }

  @discardableResult
  func removeEmptyCapture(_ id: String) throws -> Bool {
    try synchronized {
      let directory = try recordURL(id)
      guard manager.fileExists(atPath: directory.path) else { return false }
      let audio = directory.appendingPathComponent("audio.m4a")
      if manager.fileExists(atPath: audio.path),
        try audio.resourceValues(forKeys: [.fileSizeKey]).fileSize != 0 { return false }
      // Never remove unknown recovery files or a received capture's durable receipt.
      let names = try manager.contentsOfDirectory(atPath: directory.path)
      guard names.allSatisfy({ ["audio.m4a", "metadata.json"].contains($0) }),
        !manager.fileExists(atPath: root.appendingPathComponent("receipts/\(id).json").path)
      else { return false }
      try manager.removeItem(at: directory)
      return true
    }
  }

  func remove(_ id: String) throws {
    try synchronized {
      let directory = try recordURL(id)
      if manager.fileExists(atPath: root.appendingPathComponent("receipts/\(id).json").path) {
        try WatchFiles.write(Data(), to: root.appendingPathComponent("dismissed/\(id)"))
      }
      if manager.fileExists(atPath: directory.path) { try manager.removeItem(at: directory) }
    }
  }

  func acknowledge(_ id: String, digest: String) throws {
    try synchronized {
      guard manager.fileExists(atPath: try recordURL(id).path) else { return }
      if try receipt(id).digest == digest { try remove(id) } else { throw WatchBridgeError.invalid("Acknowledgement does not match local audio") }
    }
  }
}
