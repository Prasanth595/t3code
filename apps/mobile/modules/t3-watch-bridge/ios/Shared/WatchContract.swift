import Foundation

enum WatchFiles {
  static func write(_ data: Data, to url: URL) throws {
    #if os(iOS)
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: url, options: .atomic)
    #endif
  }
}

enum WatchDate {
  static func parse(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }
}

enum WatchBridgeError: Error, LocalizedError {
  case invalid(String)
  var errorDescription: String? {
    switch self {
    case .invalid(let reason): return reason
    }
  }
}

struct WatchRecording: Codable, Equatable {
  let id: String
  let createdAt: String
  let kind: String
  let environmentId: String?
  let threadId: String?

  func validate() throws {
    guard UUID(uuidString: id)?.uuidString == id,
      WatchDate.parse(createdAt) != nil,
      kind == "new-thread" || kind == "reply"
    else { throw WatchBridgeError.invalid("Invalid recording metadata") }
    if kind == "reply" {
      guard Self.identifier(environmentId), Self.identifier(threadId) else {
        throw WatchBridgeError.invalid("Reply requires exact environment and thread")
      }
    } else if environmentId != nil || threadId != nil {
      throw WatchBridgeError.invalid("New capture cannot carry a reply destination")
    }
  }

  static func identifier(_ value: String?) -> Bool {
    guard let value else { return false }
    return !value.isEmpty && value.utf8.count <= 512 && !value.unicodeScalars.contains { $0.value < 32 }
  }

  func dictionary(uri: URL) -> [String: Any] {
    var result: [String: Any] = ["id": id, "uri": uri.absoluteString, "createdAt": createdAt, "kind": kind]
    if let environmentId { result["environmentId"] = environmentId }
    if let threadId { result["threadId"] = threadId }
    return result
  }
}

struct WatchSnapshot: Codable {
  let version: Int
  let threads: [WatchThread]

  static func decode(_ data: Data) throws -> WatchSnapshot {
    guard data.count <= 48 * 1024 else { throw WatchBridgeError.invalid("Snapshot exceeds 48 KiB") }
    let snapshot = try JSONDecoder().decode(Self.self, from: data)
    guard snapshot.version == 1, snapshot.threads.count <= 20 else {
      throw WatchBridgeError.invalid("Unsupported or oversized snapshot")
    }
    var bindings = Set<[String]>()
    for thread in snapshot.threads {
      guard WatchRecording.identifier(thread.id), WatchRecording.identifier(thread.environmentId),
        bindings.insert([thread.environmentId, thread.id]).inserted,
        thread.title.utf8.count <= 256, thread.projectTitle.utf8.count <= 256,
        thread.status.utf8.count <= 64, thread.latestMessage.utf8.count <= 2048,
        WatchDate.parse(thread.updatedAt) != nil
      else { throw WatchBridgeError.invalid("Invalid thread snapshot") }
      if let request = thread.pendingRequest {
        guard WatchRecording.identifier(request.id), ["question", "approval"].contains(request.kind),
          request.title.utf8.count <= 256, request.detail.utf8.count <= 2048,
          request.questionId == nil || WatchRecording.identifier(request.questionId),
          (request.options?.count ?? 0) <= 8
        else { throw WatchBridgeError.invalid("Invalid pending request") }
        var values = Set<String>()
        for option in request.options ?? [] {
          guard !option.label.isEmpty, option.label.utf8.count <= 160,
            !option.value.isEmpty, option.value.utf8.count <= 512,
            values.insert(option.value).inserted
          else { throw WatchBridgeError.invalid("Invalid answer option") }
        }
      }
    }
    return snapshot
  }
}

struct WatchThread: Codable {
  var bindingID: [String] { [environmentId, id] }
  let id: String
  let environmentId: String
  let title: String
  let projectTitle: String
  let status: String
  let updatedAt: String
  let latestMessage: String
  let pendingRequest: WatchPendingRequest?
}

struct WatchPendingRequest: Codable {
  struct Option: Codable { let label: String; let value: String }
  let id: String
  let kind: String
  let title: String
  let detail: String
  let questionId: String?
  let options: [Option]?
  let allowCustomAnswer: Bool?
}

struct WatchAction: Codable, Equatable {
  let id: String
  let kind: String
  let environmentId: String
  let threadId: String
  let requestId: String?
  let questionId: String?
  let answer: String?
  let decision: String?
  let expectedUpdatedAt: String?

  private func validateSnapshotVersion() throws {
    if let expectedUpdatedAt {
      guard expectedUpdatedAt.utf8.count <= 64, WatchDate.parse(expectedUpdatedAt) != nil else {
        throw WatchBridgeError.invalid("Invalid Watch snapshot version")
      }
    }
  }

  func validate() throws {
    try validateSnapshotVersion()
    guard UUID(uuidString: id)?.uuidString == id,
      ["settle", "reopen", "answer", "approval"].contains(kind),
      WatchRecording.identifier(environmentId), WatchRecording.identifier(threadId),
      requestId == nil || WatchRecording.identifier(requestId),
      questionId == nil || WatchRecording.identifier(questionId),
      (answer?.utf8.count ?? 0) <= 2048
    else { throw WatchBridgeError.invalid("Invalid action") }
    switch kind {
    case "answer":
      if decision == "review-on-phone" {
        guard requestId != nil, answer == nil, questionId == nil else {
          throw WatchBridgeError.invalid("Question handoff cannot fabricate an answer")
        }
      } else if requestId == nil || answer?.isEmpty != false || decision != nil {
        throw WatchBridgeError.invalid("Answer requires a request and nonempty response")
      }
    case "approval":
      guard requestId != nil, decision == "review-on-phone", answer == nil, questionId == nil else {
        throw WatchBridgeError.invalid("Approvals require full iPhone review")
      }
    default:
      guard requestId == nil, questionId == nil, answer == nil, decision == nil, expectedUpdatedAt != nil else {
        throw WatchBridgeError.invalid("Unexpected action fields")
      }
    }
  }

  func dictionary() throws -> [String: Any] {
    guard let dictionary = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any] else {
      throw WatchBridgeError.invalid("Invalid action payload")
    }
    return dictionary
  }
}
