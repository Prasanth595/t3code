/**
 * Fork: sidebar thread groups, the value of the `sidebarGroups` server setting.
 *
 * Every machine holds this value, and a newer T3 version can write a rule that an older one does
 * not know. So a stored rule decodes with open strings, and clients skip a rule that is not a
 * `SidebarGroupRule`. A closed schema here would make an older server reject the whole settings
 * patch, or reset every setting when it reads a newer `settings.json`.
 *
 * @module sidebarGroups
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What a rule compares. `group` compares the group that holds the thread. */
export const SidebarGroupRuleField = Schema.Literals([
  "group",
  "project",
  "owner",
  "status",
  "provider",
  "createdBy",
  "background",
  "title",
]);
export type SidebarGroupRuleField = typeof SidebarGroupRuleField.Type;

/**
 * A rule this version knows. "is" matches a thread that has one of `values`, and "is_not" matches
 * a thread that has none of them. A `title` value matches when the title contains it. Null stands
 * for "none", for example a project without a repository.
 */
export const SidebarGroupRule = Schema.Struct({
  field: SidebarGroupRuleField,
  operator: Schema.Literals(["is", "is_not"]),
  values: Schema.Array(Schema.NullOr(Schema.String)),
});
export type SidebarGroupRule = typeof SidebarGroupRule.Type;

/** A rule as stored. It can come from a newer version; see `isKnownSidebarGroupRule`. */
const SidebarGroupStoredRule = Schema.Struct({
  field: Schema.String,
  operator: Schema.String,
  values: Schema.Array(Schema.NullOr(Schema.String)),
});
export type SidebarGroupStoredRule = typeof SidebarGroupStoredRule.Type;

export const isKnownSidebarGroupRule = Schema.is(SidebarGroupRule);

/** A group. A thread matches the group when it matches every known rule. */
export const SidebarGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  rules: Schema.Array(SidebarGroupStoredRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SidebarGroup = typeof SidebarGroup.Type;

export const SidebarGroups = Schema.Struct({
  /** Groups in tab order. The default tab is not in this list. */
  groups: Schema.Array(SidebarGroup).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Thread key (`environmentId:threadId`) to the group that the user dragged the thread into.
   * The id `default` keeps a thread in the default tab when a group rule matches it. Clients
   * drop an entry when its thread is gone or archived, or when the rules give the same group.
   */
  assignments: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type SidebarGroups = typeof SidebarGroups.Type;
