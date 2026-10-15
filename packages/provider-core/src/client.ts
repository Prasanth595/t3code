import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

/**
 * Fields carry `providerSettingsForm` annotations, which the settings form
 * renders generically.
 */
export type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

export interface ProviderEnvironmentField {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly sensitive?: boolean;
}

/**
 * Colors are per theme; a path without a fill or gradient uses the icon's
 * `fill`.
 */
export interface ProviderIcon {
  readonly viewBox: string;
  readonly fill: { readonly light: string; readonly dark: string };
  readonly paths: ReadonlyArray<{
    readonly d: string;
    readonly fillRule?: "evenodd" | "nonzero";
    readonly fill?: { readonly light: string; readonly dark: string };
    /** A brand gradient, the same in both themes. Coordinates are in viewBox units. */
    readonly gradient?: ProviderIconGradient;
  }>;
}

export interface ProviderIconGradient {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stops: ReadonlyArray<{ readonly offset: number; readonly color: string }>;
}

export interface ProviderClientDefinition {
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly icon?: ProviderIcon;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly environmentFields?: ReadonlyArray<ProviderEnvironmentField>;
  /** Whether the driver has a default instance backed by legacy `providers.<kind>` settings. */
  readonly hasDefaultInstance?: boolean;
  readonly badgeLabel?: string;
}

export function defineProviderClient<const Definition extends ProviderClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

export interface ProviderClientRegistry {
  readonly definitions: ReadonlyArray<ProviderClientDefinition>;
  /** `undefined` for drivers this client does not ship, such as a fork's driver. */
  readonly get: (
    driverKind: ProviderDriverKind | undefined,
  ) => ProviderClientDefinition | undefined;
}

export function makeProviderClientRegistry(
  definitions: ReadonlyArray<ProviderClientDefinition>,
): ProviderClientRegistry {
  const byDriverKind = new Map<ProviderDriverKind, ProviderClientDefinition>();
  for (const definition of definitions) {
    if (byDriverKind.has(definition.driverKind)) {
      throw new Error(`Provider driver '${definition.driverKind}' is defined more than once.`);
    }
    byDriverKind.set(definition.driverKind, definition);
  }
  return {
    definitions,
    get: (driverKind) => (driverKind === undefined ? undefined : byDriverKind.get(driverKind)),
  };
}
