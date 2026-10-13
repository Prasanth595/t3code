/**
 * MM-407: the editor of each managed setting comes from the T3 settings schemas in
 * `@t3tools/contracts`. Keys that the schemas do not know get the JSON editor.
 */
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import { ClientSettingsSchema, ServerSettings } from "@t3tools/contracts/settings";
import type { SettingScope } from "@t3tools/contracts/machineMap";

export type SettingControl =
  | { readonly _tag: "switch" }
  | { readonly _tag: "choice"; readonly options: ReadonlyArray<string | number> }
  | { readonly _tag: "number" }
  | { readonly _tag: "text" }
  | { readonly _tag: "json" };

type Field = Schema.Codec<unknown, unknown, never, unknown>;

const FIELDS: Record<SettingScope, Record<string, Field>> = {
  server: ServerSettings.fields,
  client: ClientSettingsSchema.fields,
};

export const knownKeys = (scope: SettingScope): ReadonlyArray<string> =>
  Object.keys(FIELDS[scope]).sort();

const fieldOf = (scope: SettingScope, key: string): Field | undefined =>
  Object.hasOwn(FIELDS[scope], key) ? FIELDS[scope][key] : undefined;

function controlOf(ast: SchemaAST.AST): SettingControl {
  switch (ast._tag) {
    case "Boolean":
      return { _tag: "switch" };
    case "Number":
      return { _tag: "number" };
    case "String":
      return { _tag: "text" };
    case "Literal":
      return typeof ast.literal === "string" || typeof ast.literal === "number"
        ? { _tag: "choice", options: [ast.literal] }
        : { _tag: "json" };
    case "Union": {
      const options: Array<string | number> = [];
      for (const member of ast.types) {
        if (member._tag !== "Literal") return { _tag: "json" };
        if (typeof member.literal !== "string" && typeof member.literal !== "number")
          return { _tag: "json" };
        options.push(member.literal);
      }
      return { _tag: "choice", options };
    }
    default:
      return { _tag: "json" };
  }
}

export function settingControl(scope: SettingScope, key: string): SettingControl {
  const field = fieldOf(scope, key);
  return field ? controlOf(field.ast) : { _tag: "json" };
}

/** Null for a valid value, or the reason the T3 schema refuses it. Unknown keys accept any JSON. */
export function settingProblem(scope: SettingScope, key: string, value: unknown): string | null {
  const field = fieldOf(scope, key);
  if (!field) return null;
  const result = Schema.decodeUnknownExit(field)(value);
  return result._tag === "Success" ? null : `Not a valid value for ${key}.`;
}
