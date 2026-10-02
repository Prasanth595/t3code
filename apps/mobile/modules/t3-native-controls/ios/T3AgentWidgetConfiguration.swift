import Foundation
import Security
import WidgetKit

// Shared with the WidgetKit extension, which runs independently of React Native.
enum T3AgentWidgetConfiguration {
  static var defaults: UserDefaults? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String else { return nil }
    return UserDefaults(suiteName: group)
  }

  static func token(identity: String) -> String? {
    guard let defaults else { return nil }
    if defaults.string(forKey: "t3_agent_widget_identity") == identity,
       let token = defaults.string(forKey: "t3_agent_widget_token") { return token }
    defaults.removeObject(forKey: "t3_agent_widget_local_observation")
    defaults.removeObject(forKey: "t3_agent_widget_url")
    defaults.removeObject(forKey: "t3_agent_widget_token")
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    let token = bytes.map { String(format: "%02x", $0) }.joined()
    defaults.set(identity, forKey: "t3_agent_widget_identity")
    defaults.set(token, forKey: "t3_agent_widget_token")
    return token
  }

  static func configure(url: String, token: String) {
    guard let defaults, defaults.string(forKey: "t3_agent_widget_token") == token else { return }
    defaults.set(url, forKey: "t3_agent_widget_url")
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
  }

  static func observe(props: String) {
    defaults?.set(props, forKey: "t3_agent_widget_local_observation")
  }

  static func clear() {
    guard let defaults else { return }
    for key in ["t3_agent_widget_identity", "t3_agent_widget_token", "t3_agent_widget_url", "t3_agent_widget_local_observation"] {
      defaults.removeObject(forKey: key)
    }
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
  }
}
