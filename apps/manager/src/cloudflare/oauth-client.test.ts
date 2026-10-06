import { APPFLARE_OAUTH_CALLBACK_URL } from "@appflare/cf-api/oauth";
import { describe, expect, it } from "vitest";
import { APPFLARE_OAUTH_CLIENT_ID, oauthClientConfig } from "./oauth-client";

describe("oauthClientConfig", () => {
  it("defaults to Appflare's public client and callback", () => {
    expect(oauthClientConfig({})).toEqual({
      clientId: APPFLARE_OAUTH_CLIENT_ID,
      callbackUrl: APPFLARE_OAUTH_CALLBACK_URL,
    });
    expect(APPFLARE_OAUTH_CLIENT_ID).toBe("b99863433175d812f9595af56dd1b71d");
  });

  it("takes a development client and callback from the vars, ignoring blanks", () => {
    expect(
      oauthClientConfig({
        CF_OAUTH_CLIENT_ID: " dev-client ",
        CF_OAUTH_CALLBACK_URL: "http://localhost:4321/deploy/callback",
      }),
    ).toEqual({ clientId: "dev-client", callbackUrl: "http://localhost:4321/deploy/callback" });
    expect(oauthClientConfig({ CF_OAUTH_CLIENT_ID: " ", CF_OAUTH_CALLBACK_URL: "" })).toEqual({
      clientId: APPFLARE_OAUTH_CLIENT_ID,
      callbackUrl: APPFLARE_OAUTH_CALLBACK_URL,
    });
  });
});
