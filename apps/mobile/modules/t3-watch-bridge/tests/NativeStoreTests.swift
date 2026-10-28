import Foundation
import CryptoKit

@main
struct NativeStoreTests {
  static var count = 0

  static func check(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
    guard try condition() else { throw WatchBridgeError.invalid("FAIL: \(label)") }
    count += 1
  }

  static func rejects(_ label: String, _ work: () throws -> Void) throws {
    do { try work() } catch { count += 1; return }
    throw WatchBridgeError.invalid("FAIL: expected rejection: \(label)")
  }

  static func main() throws {
    let manager = FileManager.default
    let temporary = manager.temporaryDirectory.appendingPathComponent("t3-watch-tests-\(UUID().uuidString)")
    try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: temporary) }
    let root = temporary.appendingPathComponent("inbox")
    let store = try RecordingStore(root: root)
    let audio = Data("deterministic fixture audio".utf8)
    let digest = SHA256.hash(data: audio).map { String(format: "%02x", $0) }.joined()
    let recording = WatchRecording(id: UUID().uuidString, createdAt: "2026-10-28T11:12:13.123Z", kind: "reply", environmentId: "mac", threadId: "thread")
    func incoming(_ bytes: Data = audio) throws -> URL {
      let file = temporary.appendingPathComponent(UUID().uuidString)
      try bytes.write(to: file)
      return file
    }
    try recording.validate()
    try check(WatchDate.parse("2026-10-28T11:12:13Z") != nil, "nonfractional ISO8601")
    try check(WatchDate.parse("2026-10-28T11:12:13.123Z") != nil, "fractional ISO8601")
    try check(WatchDate.parse("not-a-date") == nil, "invalid ISO8601")
    let originalFile = try incoming()
    let receipt = try store.receive(originalFile, recording: recording, expectedDigest: digest)
    try check(!manager.fileExists(atPath: originalFile.path), "received file moved synchronously")
    try check(try store.list() == [recording], "durable list")
    try check(try store.list()[0].dictionary(uri: store.audioURL(recording.id))["createdAt"] as? String == recording.createdAt, "JS timestamp remains a string")
    try check(try store.receive(incoming(), recording: recording, expectedDigest: digest) == receipt, "identical duplicate acknowledged")
    let reopened = try RecordingStore(root: root)
    try check(try reopened.list() == [recording], "inbox survives recreation without JS")
    try rejects("wrong digest") { _ = try store.receive(incoming(), recording: recording, expectedDigest: String(repeating: "0", count: 64)) }
    let conflict = WatchRecording(id: recording.id, createdAt: recording.createdAt, kind: "reply", environmentId: "other-environment", threadId: "thread")
    try rejects("same ID different binding") { _ = try store.receive(incoming(), recording: conflict, expectedDigest: digest) }
    try check(try manager.contentsOfDirectory(atPath: root.appendingPathComponent("conflicts").path).count == 1, "conflicting incoming audio retained")
    try check(try reopened.list() == [recording], "conflict never replaces original")
    let storedAudio = try store.audioURL(recording.id)
    try Data("corrupt local copy".utf8).write(to: storedAudio)
    try rejects("duplicate cannot acknowledge corrupted stored audio") { _ = try store.receive(incoming(), recording: recording, expectedDigest: digest) }
    try audio.write(to: storedAudio)
    try rejects("wrong acknowledgement") { try store.acknowledge(recording.id, digest: String(repeating: "0", count: 64)) }
    try check(try store.list() == [recording], "wrong ack preserves Watch audio")
    try store.remove(recording.id)
    try check(try store.list().isEmpty, "explicit JS dismissal removes only recording")
    try check(try store.receive(incoming(), recording: recording, expectedDigest: digest) == receipt, "tombstone acknowledges retransmission after dismissal")
    try check(try store.list().isEmpty, "dismissed recording never resurrects")
    let reservedRoot = temporary.appendingPathComponent("watch")
    let watch = try RecordingStore(root: reservedRoot)
    let local = WatchRecording(id: UUID().uuidString, createdAt: "2026-10-28T11:12:13Z", kind: "new-thread", environmentId: nil, threadId: nil)
    let reserved = try watch.reserve(local)
    try audio.write(to: reserved)
    let recovered = try RecordingStore(root: reservedRoot)
    try check(try recovered.list() == [local], "interrupted local capture metadata recovers")
    try check(try recovered.receipt(local.id).digest == digest, "recovered local audio fingerprint")
    try recovered.acknowledge(local.id, digest: digest)
    try recovered.acknowledge(local.id, digest: digest)
    try check(try recovered.list().isEmpty, "matching durable acknowledgement removes audio")
    let emptyReservation = reservedRoot.appendingPathComponent("records/\(UUID().uuidString)")
    try manager.createDirectory(at: emptyReservation, withIntermediateDirectories: false)
    _ = try RecordingStore(root: reservedRoot)
    _ = try watch.list()
    try check(!manager.fileExists(atPath: emptyReservation.path), "crash before reservation metadata removes only empty directory")
    try rejects("path traversal") { try recovered.remove("../inbox") }
    try rejects("missing reply binding") {
      try WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "reply", environmentId: "mac", threadId: nil).validate()
    }
    for _ in 0..<RecordingStore.maximumRecords {
      _ = try watch.reserve(WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "new-thread", environmentId: nil, threadId: nil))
    }
    try rejects("record count capacity") { _ = try watch.reserve(local) }
    try check(try watch.list().count == RecordingStore.maximumRecords, "capacity never evicts unsent captures")
    let huge = Data(repeating: 1, count: RecordingStore.maximumFileBytes + 1)
    try rejects("per-file byte capacity") { _ = try store.receive(incoming(huge), recording: local, expectedDigest: digest) }
    let byteLimitedStore = try RecordingStore(root: temporary.appendingPathComponent("byte-limit"))
    let largeAudio = Data(repeating: 1, count: RecordingStore.maximumFileBytes)
    let largeDigest = SHA256.hash(data: largeAudio).map { String(format: "%02x", $0) }.joined()
    for _ in 0..<6 {
      let largeRecording = WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "new-thread", environmentId: nil, threadId: nil)
      _ = try byteLimitedStore.receive(incoming(largeAudio), recording: largeRecording, expectedDigest: largeDigest)
    }
    let refusedLargeAudio = try incoming(largeAudio)
    try rejects("total byte capacity") { _ = try byteLimitedStore.receive(refusedLargeAudio, recording: local, expectedDigest: largeDigest) }
    try check(manager.fileExists(atPath: refusedLargeAudio.path), "capacity rejection does not consume incoming source")
    try check(try byteLimitedStore.list().count == 6, "byte capacity preserves all prior audio")
    let stageRoot = temporary.appendingPathComponent("crashed-receive")
    _ = try RecordingStore(root: stageRoot)
    let stage = stageRoot.appendingPathComponent("staging/partial")
    try manager.createDirectory(at: stage, withIntermediateDirectories: false)
    let stagedReceipt = RecordingStore.Receipt(recording: local, digest: digest)
    try JSONEncoder().encode(stagedReceipt).write(to: stage.appendingPathComponent("receipt.json"))
    try JSONEncoder().encode(local).write(to: stage.appendingPathComponent("metadata.json"))
    try audio.write(to: stage.appendingPathComponent("audio.m4a"))
    let recoveredStage = try RecordingStore(root: stageRoot)
    try check(try recoveredStage.list() == [local], "crash between staging move and commit recovers")
    let unhealthy = stageRoot.appendingPathComponent("records/\(UUID().uuidString)")
    try manager.createDirectory(at: unhealthy, withIntermediateDirectories: false)
    try check(try recoveredStage.list() == [local], "healthy capture remains visible beside incomplete record")
    let corruptDirectory = stageRoot.appendingPathComponent("records/\(UUID().uuidString)")
    try manager.createDirectory(at: corruptDirectory, withIntermediateDirectories: false)
    try Data("corrupt metadata".utf8).write(to: corruptDirectory.appendingPathComponent("metadata.json"))
    try audio.write(to: corruptDirectory.appendingPathComponent("audio.m4a"))
    try check(try recoveredStage.list() == [local], "corrupt record cannot poison healthy list")
    let quarantined = try manager.contentsOfDirectory(at: stageRoot.appendingPathComponent("conflicts"), includingPropertiesForKeys: nil)
    try check(try Data(contentsOf: quarantined[0].appendingPathComponent("audio.m4a")) == audio, "per-record recovery preserves orphan audio")
    try manager.removeItem(at: stageRoot.appendingPathComponent("records/\(local.id)/metadata.json"))
    try check(try recoveredStage.list().isEmpty, "missing metadata quarantined independently")
    try rejects("quarantine is not a dismissal tombstone") { _ = try recoveredStage.receive(incoming(), recording: local, expectedDigest: digest) }
    let incompleteStage = stageRoot.appendingPathComponent("staging/no-audio")
    try manager.createDirectory(at: incompleteStage, withIntermediateDirectories: false)
    _ = try RecordingStore(root: stageRoot)
    try check(!manager.fileExists(atPath: incompleteStage.path), "empty interrupted staging removed, not captures")
    let failedRoot = temporary.appendingPathComponent("failed-start")
    let failedStore = try RecordingStore(root: failedRoot)
    let failed = WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "new-thread", environmentId: nil, threadId: nil)
    let failedURL = try failedStore.reserve(failed)
    try Data().write(to: failedURL)
    let metadataOnly = WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "new-thread", environmentId: nil, threadId: nil)
    _ = try failedStore.reserve(metadataOnly)
    let partial = WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "new-thread", environmentId: nil, threadId: nil)
    try audio.write(to: failedStore.reserve(partial))
    let reopenedFailed = try RecordingStore(root: failedRoot)
    try check(try reopenedFailed.list() == [partial], "failed starts free only empty recording slots after restart")
    try check(try Data(contentsOf: reopenedFailed.audioURL(partial.id)) == audio, "partial audio survives failed-start recovery")
    for (name, receiptBytes) in [("missing-receipt", Data()), ("bad-receipt", Data("invalid".utf8))] {
      let badStage = failedRoot.appendingPathComponent("staging/\(name)")
      try manager.createDirectory(at: badStage, withIntermediateDirectories: false)
      try audio.write(to: badStage.appendingPathComponent("audio.m4a"))
      if !receiptBytes.isEmpty { try receiptBytes.write(to: badStage.appendingPathComponent("receipt.json")) }
    }
    let afterBadStage = try RecordingStore(root: failedRoot)
    try check(try afterBadStage.list() == [partial], "damaged stages cannot hide healthy recordings")
    let damagedStages = try manager.contentsOfDirectory(at: failedRoot.appendingPathComponent("conflicts"), includingPropertiesForKeys: nil)
    try check(damagedStages.count == 2, "damaged stages isolated for recovery")
    for damaged in damagedStages {
      try check(try Data(contentsOf: damaged.appendingPathComponent("audio.m4a")) == audio, "damaged staged audio never deleted")
    }
    let historicalRoot = temporary.appendingPathComponent("historical-receipts")
    let historicalStore = try RecordingStore(root: historicalRoot)
    for _ in 0..<4096 {
      let historical = WatchRecording(id: UUID().uuidString, createdAt: local.createdAt, kind: "new-thread", environmentId: nil, threadId: nil)
      let historicalReceipt = RecordingStore.Receipt(recording: historical, digest: digest)
      try JSONEncoder().encode(historicalReceipt).write(to: historicalRoot.appendingPathComponent("receipts/\(historical.id).json"))
    }
    _ = try historicalStore.reserve(local)
    try check(try historicalStore.list() == [local], "historical receipts do not consume active recording slots")
    let snapshot = """
    {"version":1,"threads":[{"id":"same","environmentId":"mac","title":"A","projectTitle":"P","status":"idle","updatedAt":"2026-10-28T12:00:00.123Z","latestMessage":"hello"},{"id":"same","environmentId":"sii","title":"B","projectTitle":"P","status":"idle","updatedAt":"2026-10-28T12:00:00Z","latestMessage":"hello"}],"token":"must-not-forward"}
    """
    let decoded = try WatchSnapshot.decode(Data(snapshot.utf8))
    try check(decoded.threads.count == 2, "composite environment/thread identities")
    let sanitized = try JSONEncoder().encode(decoded)
    try check(!String(decoding: sanitized, as: UTF8.self).contains("must-not-forward"), "unknown credentials are never forwarded")
    try rejects("duplicate tuple") { _ = try WatchSnapshot.decode(Data(snapshot.replacingOccurrences(of: "\"environmentId\":\"sii\"", with: "\"environmentId\":\"mac\"").utf8)) }
    try rejects("snapshot bound") { _ = try WatchSnapshot.decode(Data(repeating: 32, count: 48 * 1024 + 1)) }
    try check(try WatchSnapshot.decode(Data("{\"version\":1,\"threads\":[]}".utf8)).threads.isEmpty, "empty snapshot clears account context")
    try rejects("approval from Watch") {
      try WatchAction(id: UUID().uuidString, kind: "approval", environmentId: "mac", threadId: "thread", requestId: "request", questionId: nil, answer: nil, decision: "approve", expectedUpdatedAt: nil).validate()
    }
    try WatchAction(id: UUID().uuidString, kind: "approval", environmentId: "mac", threadId: "thread", requestId: "request", questionId: nil, answer: nil, decision: "review-on-phone", expectedUpdatedAt: nil).validate()
    try rejects("approval handoff cannot include a question ID rejected by the iPhone inbox") {
      try WatchAction(id: UUID().uuidString, kind: "approval", environmentId: "mac", threadId: "thread", requestId: "request", questionId: "question", answer: nil, decision: "review-on-phone", expectedUpdatedAt: nil).validate()
    }
    let questionHandoff = WatchAction(id: UUID().uuidString, kind: "answer", environmentId: "mac", threadId: "thread", requestId: "request", questionId: nil, answer: nil, decision: "review-on-phone", expectedUpdatedAt: nil)
    try questionHandoff.validate()
    try check(try questionHandoff.dictionary()["answer"] == nil, "question handoff fabricates no answer")
    try rejects("question handoff cannot preselect question or answer") {
      try WatchAction(id: UUID().uuidString, kind: "answer", environmentId: "mac", threadId: "thread", requestId: "request", questionId: "question", answer: "yes", decision: "review-on-phone", expectedUpdatedAt: nil).validate()
    }
    let actionsRoot = temporary.appendingPathComponent("actions")
    let mutationVersion = "2026-10-28T10:00:00.123Z"
    let mutationData = try JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "kind": "settle", "environmentId": "mac", "threadId": "thread", "expectedUpdatedAt": mutationVersion])
    let versionedMutation = try JSONDecoder().decode(WatchAction.self, from: mutationData)
    try versionedMutation.validate()
    try check(try versionedMutation.dictionary()["expectedUpdatedAt"] as? String == mutationVersion, "mutation carries original Watch snapshot version across native persistence")
    let versionedActionsRoot = temporary.appendingPathComponent("versioned-actions")
    try ActionStore(root: versionedActionsRoot).save(versionedMutation)
    try check(try ActionStore(root: versionedActionsRoot).list() == [versionedMutation], "native replay preserves the original Watch snapshot version before phone shell hydration")
    try rejects("mutation without Watch snapshot version") {
      try WatchAction(id: UUID().uuidString, kind: "settle", environmentId: "mac", threadId: "thread", requestId: nil, questionId: nil, answer: nil, decision: nil, expectedUpdatedAt: nil).validate()
    }
    try rejects("mutation with invalid Watch snapshot version") {
      try WatchAction(id: UUID().uuidString, kind: "settle", environmentId: "mac", threadId: "thread", requestId: nil, questionId: nil, answer: nil, decision: nil, expectedUpdatedAt: "invalid").validate()
    }
    let actions = try ActionStore(root: actionsRoot)
    try actions.save(questionHandoff)
    try check(try actions.list() == [questionHandoff], "action durably saved before receipt")
    try check(try ActionStore(root: actionsRoot).list() == [questionHandoff], "action survives process restart and replays without JS")
    try actions.save(questionHandoff)
    try check(try actions.list().count == 1, "identical action duplicate is idempotent")
    let conflictingAction = WatchAction(id: questionHandoff.id, kind: "settle", environmentId: "mac", threadId: "thread", requestId: nil, questionId: nil, answer: nil, decision: nil, expectedUpdatedAt: mutationVersion)
    try rejects("conflicting immutable action ID") { try actions.save(conflictingAction) }
    try check(try actions.list() == [questionHandoff], "conflicting ID never replaces original")
    let failingRoot = temporary.appendingPathComponent("action-write-failure")
    let failingActions = try ActionStore(root: failingRoot, write: { _, _ in throw WatchBridgeError.invalid("Injected durable write failure") })
    try rejects("failed persistence cannot produce action receipt") { try failingActions.save(questionHandoff) }
    try check(try ActionStore(root: failingRoot).list().isEmpty, "failed write leaves no false durable action after restart")
    try actions.remove(questionHandoff.id)
    try actions.remove(questionHandoff.id)
    try check(try ActionStore(root: actionsRoot).list().isEmpty, "action removal after TS persistence survives restart and is idempotent")
    try rejects("action traversal ID") { try actions.remove("../actions") }
    try Data("broken entry".utf8).write(to: actionsRoot.appendingPathComponent("corrupt.json"))
    try actions.save(questionHandoff)
    try check(try actions.list() == [questionHandoff], "corrupt action entry retained without poisoning replay")
    try check(manager.fileExists(atPath: actionsRoot.appendingPathComponent("corrupt.json").path), "corrupt action bytes preserved")
    for _ in 2..<ActionStore.maximumActions {
      let action = WatchAction(id: UUID().uuidString, kind: "reopen", environmentId: "mac", threadId: "thread", requestId: nil, questionId: nil, answer: nil, decision: nil, expectedUpdatedAt: mutationVersion)
      try actions.save(action)
    }
    try rejects("bounded action queue") {
      try actions.save(WatchAction(id: UUID().uuidString, kind: "settle", environmentId: "mac", threadId: "thread", requestId: nil, questionId: nil, answer: nil, decision: nil, expectedUpdatedAt: mutationVersion))
    }
    try check(try actions.list().contains(questionHandoff), "full action inbox never evicts pending requests")
    print("Passed \(count) native storage/contract checks")
  }
}
