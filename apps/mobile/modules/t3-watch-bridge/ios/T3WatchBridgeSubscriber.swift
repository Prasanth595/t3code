import ExpoModulesCore
import UIKit

public final class T3WatchBridgeSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    guard WatchReceiver.isEnabled else { return true }
    do { try WatchReceiver.shared.start() } catch { NSLog("T3 Watch receiver startup failed: %@", error.localizedDescription) }
    return true
  }
}
