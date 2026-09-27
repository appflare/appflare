import type { CatalogSecret } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { appTokenSecret } from "./app-token-secret";

const secret = (name: string, extra: Partial<CatalogSecret> = {}): CatalogSecret => ({
  name,
  label: name,
  generate: false,
  ...extra,
});

const ANALYTICS = [{ name: "Account.Account Analytics:Read" }];

describe("appTokenSecret", () => {
  it("finds the secret that takes the app's Cloudflare token by the names apps give it", () => {
    for (const name of [
      "CF_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CF_TOKEN",
      "CF_BEARER_TOKEN",
      "NUXT_CF_API_TOKEN",
    ]) {
      expect(
        appTokenSecret({
          secrets: [secret("ADMIN_PASSWORD", { generate: true }), secret(name)],
          tokenPermissions: ANALYTICS,
        }),
      ).toBe(name);
    }
  });

  it("finds none when the app needs no token of its own, or no secret takes it", () => {
    expect(appTokenSecret({ secrets: [secret("CF_API_TOKEN")], tokenPermissions: [] })).toBe(null);
    expect(
      appTokenSecret({
        secrets: [secret("SETUP_TOKEN"), secret("POLAR_ACCESS_TOKEN"), secret("GITHUB_TOKEN")],
        tokenPermissions: ANALYTICS,
      }),
    ).toBe(null);
  });

  it("skips a seed-only secret, which is used once and never reaches the app", () => {
    expect(
      appTokenSecret({
        secrets: [secret("CF_API_TOKEN", { seedOnly: true })],
        tokenPermissions: ANALYTICS,
      }),
    ).toBe(null);
  });

  it("takes the secret a Pipelines sink names, whatever it is called", () => {
    expect(
      appTokenSecret({
        secrets: [secret("CF_API_TOKEN"), secret("CATALOG_TOKEN")],
        tokenPermissions: [],
        resources: {
          pipelines: {
            EVENTS: {
              sink: {
                type: "r2_data_catalog",
                bucket: "events",
                namespace: "app",
                table: "events",
                tokenSecret: "CATALOG_TOKEN",
              },
            },
          },
        },
      }),
    ).toBe("CATALOG_TOKEN");
  });
});
