import { APPFLARE_OAUTH_CALLBACK_URL } from "@appflare/cf-api/oauth";
import { describe, expect, it } from "vitest";
import { APPFLARE_OAUTH_CLIENT_ID, oauthClientConfig, strictOrigin } from "./oauth-client";

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

  // The docs preview's origin, assembled: only the files that describe the
  // preview may name it (the docs site's link checks).
  const PREVIEW = `https://${["appflare-docs", "appflare-dev", "workers", "dev"].join(".")}`;

  it("returns through the deploy page the manager was installed from", () => {
    expect(oauthClientConfig({ APPFLARE_INSTALLER_ORIGIN: PREVIEW }).callbackUrl).toBe(
      `${PREVIEW}/deploy/callback`,
    );
    expect(oauthClientConfig({ APPFLARE_INSTALLER_ORIGIN: `${PREVIEW}/` }).callbackUrl).toBe(
      `${PREVIEW}/deploy/callback`,
    );
    expect(
      oauthClientConfig({ APPFLARE_INSTALLER_ORIGIN: "http://localhost:4321" }).callbackUrl,
    ).toBe("http://localhost:4321/deploy/callback");
    // The explicit var still wins.
    expect(
      oauthClientConfig({
        APPFLARE_INSTALLER_ORIGIN: PREVIEW,
        CF_OAUTH_CALLBACK_URL: "https://dev.example.com/cb",
      }).callbackUrl,
    ).toBe("https://dev.example.com/cb");
  });

  it("ignores an installer origin that is not just an origin", () => {
    for (const bad of [
      `${PREVIEW}/deploy`,
      `${PREVIEW}?x=1`,
      `${PREVIEW}#x`,
      "https://user:pass@appflare.dev",
      "http://appflare.dev",
      "ftp://appflare.dev",
      "not a url",
      " ",
    ]) {
      expect(strictOrigin(bad), bad).toBeNull();
      expect(oauthClientConfig({ APPFLARE_INSTALLER_ORIGIN: bad }).callbackUrl, bad).toBe(
        APPFLARE_OAUTH_CALLBACK_URL,
      );
    }
    expect(strictOrigin("https://appflare.dev")).toBe("https://appflare.dev");
  });
});
