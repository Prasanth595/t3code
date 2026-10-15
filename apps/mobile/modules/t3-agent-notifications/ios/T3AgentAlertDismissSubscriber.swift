import ExpoModulesCore
import UIKit
import UserNotifications

/// Removes a thread's delivered alerts when the relay's background push reports
/// that the thread was read on another client. Alerts carry the same thread-id.
public final class T3AgentAlertDismissSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    // Every subscriber must complete; Expo aggregates the results.
    guard let threadId = userInfo["dismissThreadId"] as? String else {
      completionHandler(.noData)
      return
    }
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { notifications in
      let identifiers = notifications
        .filter { $0.request.content.threadIdentifier == threadId }
        .map(\.request.identifier)
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
      completionHandler(identifiers.isEmpty ? .noData : .newData)
    }
  }
}
