import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadAddress } from "@t3tools/shared/threadAddress";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { enrichedContextLinkPresentation } from "../../lib/enrichedLinkPresentation";
import { markdownFileIconSource } from "../../lib/markdownFileIcons";
import type { MarkdownLinkCustomization } from "../../native/SelectableMarkdownText.types";
import { useEnvironmentServerConfig } from "../../state/entities";

// The pill of an attached thread with no record, so both looks stay one.
const threadPill = enrichedContextLinkPresentation(
  formatComposerContextHref("thread", "thread-link" as ComposerContextId),
);

/**
 * Fork: thread links in a feed of `environmentId` while its server setting `threadLinkChips` is on.
 * A `t3-thread://` link and a web address of a thread in an environment that this app knows
 * (`parseThreadAddress`) get the attached-thread pill. Such a web address opens the thread here,
 * not in the phone browser. With the setting off, both return nothing and links stay as they are.
 */
export function useForkThreadLinks(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const chips = useEnvironmentServerConfig(environmentId)?.settings.threadLinkChips === true;
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const knownThreadAddress = useCallback(
    (href: string) => {
      const address = chips ? parseThreadAddress(href) : null;
      return address && catalog.entries.has(address.environmentId) ? address : null;
    },
    [catalog, chips],
  );
  /** True when the press opened a thread. */
  const openKnownThread = useCallback(
    (href: string) => {
      const address = knownThreadAddress(href);
      if (!address) return false;
      navigation.navigate("Thread", {
        environmentId: String(address.environmentId),
        threadId: String(address.threadId),
      });
      return true;
    },
    [knownThreadAddress, navigation],
  );
  const linkCustomization = useCallback(
    (href: string): MarkdownLinkCustomization | undefined =>
      threadPill && chips && (parseThreadLinkHref(href) !== null || knownThreadAddress(href))
        ? { color: threadPill.color, icon: markdownFileIconSource(threadPill.icon) }
        : undefined,
    [chips, knownThreadAddress],
  );
  return useMemo(
    () => ({ openKnownThread, linkCustomization }),
    [linkCustomization, openKnownThread],
  );
}
