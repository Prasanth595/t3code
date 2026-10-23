// The bearer credential for the factory server, encrypted with Electron safeStorage in the
// desktop state directory, the way DesktopConnectionCatalogStore keeps remote credentials.
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const { logWarning } = makeComponentLogger("desktop-factory-server");

const CredentialDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedBearer: Schema.String,
});
const CredentialDocumentJson = Schema.fromJsonString(CredentialDocument);
const decodeDocument = Schema.decodeEffect(CredentialDocumentJson);
const encodeDocument = Schema.encodeEffect(CredentialDocumentJson);

export class FactoryServerCredentialStoreError extends Schema.TaggedError<FactoryServerCredentialStoreError>()(
  "FactoryServerCredentialStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not store the factory server credential.";
  }
}

const credentialPath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  return path.join(environment.stateDir, "factory-server-credential.json");
});

/** An unreadable or undecryptable file counts as no credential, so the user pairs again. */
export const readFactoryServerBearer = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const file = yield* credentialPath;
  if (!(yield* fileSystem.exists(file))) return Option.none<string>();
  const bearer = yield* Effect.gen(function* () {
    const document = yield* decodeDocument(yield* fileSystem.readFileString(file));
    const encrypted = yield* Effect.fromResult(Base64.decode(document.encryptedBearer));
    return yield* safeStorage.decryptString(encrypted);
  });
  return Option.some(bearer);
}).pipe(
  Effect.catch((error) =>
    logWarning("could not read the stored factory server credential", { error }).pipe(
      Effect.as(Option.none<string>()),
    ),
  ),
  Effect.withSpan("desktop.factoryServer.readBearer"),
);

const wrap = (cause: unknown) => new FactoryServerCredentialStoreError({ cause });

/** Fails when a bearer could not be kept, so pairing can stop before it spends a one-time link. */
export const ensureFactoryServerBearerStorable = Effect.gen(function* () {
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.mapError(wrap)))) {
    return yield* wrap("Secure storage is unavailable.");
  }
});

export const writeFactoryServerBearer = Effect.fn("desktop.factoryServer.writeBearer")(function* (
  bearer: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const file = yield* credentialPath;
  yield* ensureFactoryServerBearerStorable;
  const tempPath = `${file}.${process.pid}.tmp`;
  yield* Effect.gen(function* () {
    const encryptedBearer = Base64.encode(yield* safeStorage.encryptString(bearer));
    const encoded = yield* encodeDocument({ version: 1, encryptedBearer });
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(tempPath, `${encoded}\n`);
    yield* fileSystem.rename(tempPath, file);
  }).pipe(
    Effect.mapError(wrap),
    Effect.ensuring(
      fileSystem
        .remove(tempPath, { force: true })
        .pipe(
          Effect.catch((error) =>
            logWarning("could not remove a temporary factory server credential file", { error }),
          ),
        ),
    ),
  );
});
