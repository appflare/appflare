import { describe, expect, it } from "vitest";
import {
  catalogManifestSchema,
  catalogSecretSchema,
  catalogVarSchema,
  strictCatalogManifestSchema,
} from "./catalog";
import {
  catalogFieldLinkSchema,
  MAX_FIELD_LINK_LABEL_LENGTH,
  MAX_FIELD_LINK_URL_LENGTH,
} from "./field-link";

const manifest = {
  slug: "open-seo",
  name: "Open SEO",
  summary: "SEO research on your own account.",
  tagline: "SEO research on your own account",
  repo: "every-app/open-seo",
  license: "MIT",
  categories: ["utilities"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: { packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
  plan: "free",
};

const keyLink = { label: "Get a key", url: "https://openrouter.ai/settings/keys" };

describe("a secret's or var's link", () => {
  it("takes a short label and an https:// URL", () => {
    for (const link of [
      keyLink,
      { label: "Create an API login", url: "https://app.dataforseo.com/api-access" },
      { label: "Docs", url: "https://example.com/a?b=c#d" },
      { label: "x".repeat(MAX_FIELD_LINK_LABEL_LENGTH), url: "https://example.com" },
    ]) {
      expect(catalogFieldLinkSchema.safeParse(link).success, JSON.stringify(link)).toBe(true);
    }
  });

  it("refuses other schemes, credentials, spaces, control characters and labels that are not one short visible line", () => {
    const cases: unknown[] = [
      { label: "Get a key", url: "http://openrouter.ai/settings/keys" },
      { label: "Get a key", url: "javascript:alert(1)" },
      { label: "Get a key", url: "https://user:pass@openrouter.ai/" },
      { label: "Get a key", url: "https://openrouter.ai/a b" },
      { label: "Get a key", url: `https://example.com/${"a".repeat(MAX_FIELD_LINK_URL_LENGTH)}` },
      { label: "Get a key", url: "/settings/keys" },
      { label: "Get a key", url: " https://openrouter.ai/" },
      { label: "Get a key", url: "https://openrouter.ai/\t" },
      { label: "Get a key", url: "https://openrouter.ai/a\nb" },
      { label: "Get a key", url: "https://openrouter.ai/\u0000x" },
      { label: "Get a key", url: "https:///settings" },
      { label: "\u200b", url: keyLink.url },
      { label: "Get a \u202ekey", url: keyLink.url },
      { label: "", url: keyLink.url },
      { label: " Get a key", url: keyLink.url },
      { label: "Get\na key", url: keyLink.url },
      { label: "x".repeat(MAX_FIELD_LINK_LABEL_LENGTH + 1), url: keyLink.url },
      { url: keyLink.url },
      { label: "Get a key" },
    ];
    for (const link of cases) {
      expect(catalogFieldLinkSchema.safeParse(link).success, JSON.stringify(link)).toBe(false);
    }
  });

  it("is optional on secrets and vars, and kept by the lenient and strict schemas", () => {
    expect(catalogSecretSchema.parse({ name: "A", label: "A" }).link).toBeUndefined();
    expect(catalogSecretSchema.parse({ name: "A", label: "A", link: keyLink }).link).toEqual(
      keyLink,
    );
    expect(catalogVarSchema.parse({ name: "B", label: "B", link: keyLink }).link).toEqual(keyLink);
    const entry = {
      ...manifest,
      secrets: [{ name: "OPENROUTER_API_KEY", label: "OpenRouter API key", link: keyLink }],
      vars: [{ name: "MODEL", label: "Model", link: { label: "Models", url: "https://x.ai/m" } }],
    };
    expect(catalogManifestSchema.parse(entry).secrets[0]?.link).toEqual(keyLink);
    expect(strictCatalogManifestSchema.parse(entry).vars[0]?.link?.label).toBe("Models");
  });

  it("refuses a misspelled key inside the link where manifests are written", () => {
    const result = strictCatalogManifestSchema.safeParse({
      ...manifest,
      secrets: [{ name: "A", label: "A", link: { ...keyLink, href: keyLink.url } }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("secrets.0.link.href");
  });
});
