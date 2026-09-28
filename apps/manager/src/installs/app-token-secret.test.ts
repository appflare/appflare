import { type CatalogSecret, catalogSecretSchema, type TokenPermission } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { appTokenSecret } from "./app-token-secret";

const secret = (name: string, extra: Partial<z.input<typeof catalogSecretSchema>> = {}) =>
  catalogSecretSchema.parse({ name, label: name, ...extra }) as CatalogSecret;

const ANALYTICS: TokenPermission[] = [
  { group: "Account Analytics", scope: "account", access: "read", reason: "Reads the charts." },
];

describe("appTokenSecret", () => {
  it("takes the secret the entry declares with cloudflareToken, whatever it is called", () => {
    expect(
      appTokenSecret({
        secrets: [
          secret("ADMIN_PASSWORD", { generate: "password" }),
          secret("API_KEY", { cloudflareToken: true }),
        ],
        tokenPermissions: ANALYTICS,
      }),
    ).toBe("API_KEY");
  });

  it("does not guess from a secret's name", () => {
    expect(
      appTokenSecret({
        secrets: [secret("CF_API_TOKEN"), secret("CLOUDFLARE_API_TOKEN")],
        tokenPermissions: ANALYTICS,
      }),
    ).toBe(null);
  });

  it("finds none when the app needs no token of its own", () => {
    expect(
      appTokenSecret({
        secrets: [secret("CF_API_TOKEN", { cloudflareToken: true })],
        tokenPermissions: [],
      }),
    ).toBe(null);
  });

  it("skips a seed-only secret, which is used once and never reaches the app", () => {
    expect(
      appTokenSecret({
        secrets: [secret("CF_API_TOKEN", { seedOnly: true, cloudflareToken: true })],
        tokenPermissions: ANALYTICS,
      }),
    ).toBe(null);
  });

  it("takes the secret a Pipelines sink names when none is declared", () => {
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
