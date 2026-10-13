import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("sourceControlClients", () => {
  it("opens Bitbucket token creation with the scopes needed by T3 Code", () => {
    const tokenCreationUrl = sourceControlClients.get("bitbucket").tokenCreationUrl;
    if (tokenCreationUrl === undefined) throw new Error("Bitbucket has no API token link");
    const url = new URL(tokenCreationUrl);

    expect(url.origin).toBe("https://id.atlassian.com");
    expect(url.pathname).toBe("/manage-profile/security/api-tokens");
    expect(url.searchParams.get("autofillToken")).toBe("");
    expect(url.searchParams.get("appId")).toBe("bitbucket");
    expect(url.searchParams.get("expiryDays")).toBe("30");
    expect(url.searchParams.get("selectedScopes")).toBe(
      JSON.stringify([
        "read:user:bitbucket",
        "read:workspace:bitbucket",
        "read:repository:bitbucket",
        "write:repository:bitbucket",
        "admin:repository:bitbucket",
        "read:pullrequest:bitbucket",
        "write:pullrequest:bitbucket",
      ]),
    );
  });

  it("reads a missing kind as the first host and an unshipped kind as the generic one", () => {
    expect(sourceControlClients.get(undefined).kind).toBe("github");
    expect(sourceControlClients.get("forkhost").kind).toBe("unknown");
  });

  it("gives a change request URL to the first host whose shape it has", () => {
    // GitCafe and Forgejo share `/pulls/`; GitCafe only claims its own hostnames.
    const kindOf = (url: string) => sourceControlClients.findByChangeRequestUrl(url)?.kind;
    expect(kindOf("https://git.cafe/acme/web/pulls/7")).toBe("gitcafe");
    expect(kindOf("https://codeberg.org/acme/web/pulls/7")).toBe("forgejo");
  });
});
