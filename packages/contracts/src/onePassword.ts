import * as Schema from "effect/Schema";

const ONE_PASSWORD_ACCOUNT_MAX_CHARS = 253;
const ONE_PASSWORD_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The 1Password account a reference is read from, in any form `op --account`
 * accepts: account shorthand, sign-in address (`my.1password.com`), account ID,
 * or user ID. It is passed to the CLI as an argument, so it can never start
 * with `-`.
 */
export const OnePasswordAccount = Schema.String.check(
  Schema.isMaxLength(ONE_PASSWORD_ACCOUNT_MAX_CHARS),
  Schema.makeFilter((value: string) =>
    ONE_PASSWORD_ACCOUNT_PATTERN.test(value)
      ? true
      : "1Password account must be a shorthand, sign-in address, or ID with no spaces.",
  ),
).pipe(Schema.brand("OnePasswordAccount"));
export type OnePasswordAccount = typeof OnePasswordAccount.Type;
