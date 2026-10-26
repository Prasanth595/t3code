// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - synchronous fixture writer used from plain and Effect tests alike.

export interface FakeCliOptions {
  readonly directory: string;
  readonly name: string;
  readonly source: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}
