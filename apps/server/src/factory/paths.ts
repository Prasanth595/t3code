import * as Context from "effect/Context";

/** Where the factory keeps its files. Provided by `t3/paths.ts` in the server, by tests elsewhere. */
export class FactoryPaths extends Context.Service<
  FactoryPaths,
  { readonly factoryDir: string; readonly machineConfigPath: string }
>()("t3/factory/paths/FactoryPaths") {}
