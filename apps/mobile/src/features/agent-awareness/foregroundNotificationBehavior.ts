import type { Notification, NotificationBehavior } from "expo-notifications";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * `deepLinkOnScreen` is the normalized `/threads/:env/:thread` path of the
 * current route, or null when no thread is open.
 */
export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
): NotificationBehavior {
  const target = extractAgentNotificationDeepLink({ notification });
  if (target !== null && target === deepLinkOnScreen) {
    return SUPPRESS;
  }
  return SHOW;
}
