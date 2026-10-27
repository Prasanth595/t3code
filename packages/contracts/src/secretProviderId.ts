import * as Schema from "effect/Schema";

export const SecretProviderId = Schema.String.pipe(Schema.brand("SecretProviderId"));
export type SecretProviderId = typeof SecretProviderId.Type;
