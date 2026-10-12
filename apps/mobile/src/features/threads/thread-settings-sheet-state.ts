import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ProviderInstanceId } from "@t3tools/contracts";

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

/** Keep catalog order within each group when favorites move to the front. */
export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Refresh catalog metadata on another tap without discarding staged options. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key
    ? { ...input.pressed, selection: input.current.selection }
    : input.pressed;
}

/** Refresh staged metadata and remove revoked Daybreak choices before display or Save. */
export function resolvePendingModel(pending: ModelOption, groups: ReadonlyArray<ProviderGroup>) {
  const model = groups
    .flatMap((group) => group.models)
    .find((model) => model.key === pending.key && !model.isUnavailable && !model.isHidden);
  return model
    ? {
        ...model,
        selection: {
          ...pending.selection,
          options: pending.selection.options?.filter(
            (option) =>
              option.id !== "cyberAccessProgram" ||
              model.capabilities?.optionDescriptors?.some(
                (descriptor) =>
                  descriptor.id === option.id &&
                  descriptor.type === "select" &&
                  descriptor.options.some((choice) => choice.id === option.value),
              ),
          ),
        },
      }
    : null;
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
