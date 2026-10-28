import Foundation

final class ActionStore {
  static let maximumActions = 128
  private let root: URL
  private let lock = NSRecursiveLock()
  private let manager = FileManager.default
  private let write: (Data, URL) throws -> Void

  init(root: URL, write: @escaping (Data, URL) throws -> Void = WatchFiles.write) throws {
    self.root = root
    self.write = write
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    #if os(iOS)
    try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
    #endif
  }

  private func url(_ id: String) throws -> URL {
    guard UUID(uuidString: id)?.uuidString == id else { throw WatchBridgeError.invalid("Invalid action ID") }
    return root.appendingPathComponent("\(id).json")
  }

  func save(_ action: WatchAction) throws {
    lock.lock()
    defer { lock.unlock() }
    try action.validate()
    let destination = try url(action.id)
    let data = try JSONEncoder().encode(action)
    guard data.count <= 8192 else { throw WatchBridgeError.invalid("Action exceeds storage bound") }
    if manager.fileExists(atPath: destination.path) {
      let existingData = try Data(contentsOf: destination)
      guard existingData.count <= 8192 else { throw WatchBridgeError.invalid("Stored action exceeds bound; retained") }
      let existing = try JSONDecoder().decode(WatchAction.self, from: existingData)
      guard existing == action else { throw WatchBridgeError.invalid("Conflicting action ID; original retained") }
      return
    }
    let entries = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    guard entries.count < Self.maximumActions else { throw WatchBridgeError.invalid("Action inbox full; open T3 on iPhone") }
    try write(data, destination)
  }

  func list() throws -> [WatchAction] {
    lock.lock()
    defer { lock.unlock() }
    let entries = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    return entries.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { file in
      guard let data = try? Data(contentsOf: file), data.count <= 8192,
        let action = try? JSONDecoder().decode(WatchAction.self, from: data),
        (try? action.validate()) != nil, file.lastPathComponent == "\(action.id).json"
      else { return nil }
      return action
    }
  }

  func remove(_ id: String) throws {
    lock.lock()
    defer { lock.unlock() }
    let destination = try url(id)
    if manager.fileExists(atPath: destination.path) { try manager.removeItem(at: destination) }
  }
}
