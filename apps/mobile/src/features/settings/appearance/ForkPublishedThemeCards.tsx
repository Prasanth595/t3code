import { Fragment, type ReactNode } from "react";
import { View } from "react-native";

import type { MobileThemeAppearance, MobileThemeId } from "../../../lib/mobileTheme";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export interface PublishedThemeCardProps {
  readonly appearances: ReadonlyArray<MobileThemeAppearance>;
  readonly disabled: boolean;
  readonly label: string;
  readonly darkSelected: boolean;
  readonly lightSelected: boolean;
  readonly onSelect: (appearance: MobileThemeAppearance) => void;
  readonly onSelectBoth: () => void;
  readonly themeId: MobileThemeId;
}

/**
 * Fork: the "From your servers" group of the theme picker, for `mobilePublishedThemes`. The
 * picker passes its own card and label, so the published themes look like the built-in ones.
 */
export function ForkPublishedThemeCards(props: {
  readonly renderLabel: (text: string) => ReactNode;
  readonly renderCard: (card: PublishedThemeCardProps) => ReactNode;
}) {
  const {
    isReady,
    publishedThemes,
    themeIds,
    setThemeIdForAppearance,
    setThemeIdForBothAppearances,
  } = useAppearancePreferences();
  if (publishedThemes.length === 0) return null;
  return (
    <View className="gap-3">
      {props.renderLabel("From your servers")}
      <View className="flex-row flex-wrap gap-3">
        {publishedThemes.map((theme) => (
          <Fragment key={theme.id}>
            {props.renderCard({
              appearances: theme.appearances,
              disabled: !isReady,
              label: theme.label,
              darkSelected: theme.id === themeIds.dark,
              lightSelected: theme.id === themeIds.light,
              onSelect: (appearance) => setThemeIdForAppearance(appearance, theme.id),
              // A theme with colors for one appearance sets that appearance only.
              onSelectBoth: () => {
                const [only] = theme.appearances;
                if (theme.appearances.length === 1 && only) {
                  setThemeIdForAppearance(only, theme.id);
                } else {
                  setThemeIdForBothAppearances(theme.id);
                }
              },
              themeId: theme.id,
            })}
          </Fragment>
        ))}
      </View>
    </View>
  );
}
