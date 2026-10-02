import Foundation

let now = Date(timeIntervalSince1970: 1000)
func row(_ environmentId: String, _ phase: String) -> [String: Any] {
  ["environmentId": environmentId, "phase": phase, "status": phase, "threadTitle": "Test agent"]
}
func props(_ entry: [String: Any]) -> [String: Any] { entry["props"] as! [String: Any] }
let running: [String: Any] = ["activeCount": 1, "updatedAt": "old unchanged observation", "activities": [row("relay", "running")]]
let local: [String: Any] = ["expiresAt": now.addingTimeInterval(600).timeIntervalSince1970 * 1000,
  "activities": [row("relay", "running"), row("direct", "waiting_for_input"), row("direct", "failed")]]
let entries = AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: local, now: now)
assert(entries.count == 3)
assert(props(entries[0])["activeCount"] as? Int == 2)
let directExpired = props(entries[1])["activities"] as! [[String: Any]]
assert(directExpired.map { $0["phase"] as! String } == ["running", "stale", "failed"])
assert(props(entries[1])["isExpired"] as? Bool == false)
assert(props(entries[1])["activeCount"] as? Int == -1)
let fullyExpired = props(entries[2])["activities"] as! [[String: Any]]
assert(fullyExpired.map { $0["phase"] as! String } == ["stale", "stale", "failed"])
assert(props(entries[2])["isExpired"] as? Bool == true)
assert(entries[2]["timestamp"] as? Int == 4_600_000)

// A successful unchanged read renews freshness without inventing a state update.
let renewed = AgentWidgetState.timeline(aggregate: running, environmentIds: ["relay"], localObservation: nil, now: now.addingTimeInterval(300))
assert(renewed.last?["timestamp"] as? Int == 4_900_000)
assert(props(renewed[0])["updatedAt"] as? String == "old unchanged observation")

// An authoritative empty relay clears its own rows and retains direct observations.
let empty = AgentWidgetState.timeline(aggregate: nil, environmentIds: ["relay"], localObservation: local, now: now)
assert((props(empty[0])["activities"] as! [[String: Any]]).count == 2)
assert(props(empty[0])["activeCount"] as? Int == 1)
let terminals: [String: Any] = ["activeCount": 0, "optional": NSNull(), "activities": [row("relay", "completed"), row("relay", "failed")]]
let final = AgentWidgetState.timeline(aggregate: terminals, environmentIds: ["relay"], localObservation: nil, now: now)
assert((props(final.last!)["activities"] as! [[String: Any]]).map { $0["phase"] as! String } == ["completed", "failed"])
assert(PropertyListSerialization.propertyList(final, isValidFor: .binary))
print("AgentWidgetState: background renewal, source reconciliation, expiration, and native storage passed")
