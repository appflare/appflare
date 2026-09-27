import { type CatalogSecret, isVapidPrivateKey } from "@appflare/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  derivedNote,
  heldSecretNote,
  initialSecretValues,
  MULTILINE_SECRET_NOTE,
  normaliseMultilineSecret,
  SecretFields,
} from "./secret-fields";

const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
  "q1w2e3r4t5y6u7i8o9p0==",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("multiline secrets", () => {
  const key: CatalogSecret = {
    name: "GITHUB_APP_PRIVATE_KEY",
    label: "GitHub App private key",
    help: "The .pem file GitHub gave you.",
    generate: false,
    multiline: true,
  };

  it("keep every line break, and drop only Windows line endings and spaces after the last line", () => {
    expect(normaliseMultilineSecret(PEM)).toBe(PEM);
    expect(normaliseMultilineSecret(`${PEM}\n`)).toBe(`${PEM}\n`);
    expect(normaliseMultilineSecret(PEM.replaceAll("\n", "\r\n"))).toBe(PEM);
    expect(normaliseMultilineSecret(`${PEM}\r\n \t `)).toBe(`${PEM}\n`);
    expect(normaliseMultilineSecret(`${PEM}  \t`)).toBe(PEM);
    // Leading and inner whitespace is the value's own.
    expect(normaliseMultilineSecret("  a \n\n b\t\nc")).toBe("  a \n\n b\t\nc");
  });

  it("start empty and are never generated", () => {
    expect(initialSecretValues([key])).toEqual({ GITHUB_APP_PRIVATE_KEY: "" });
  });

  it("render a monospace text area with the value's lines and the hidden-once-saved note", () => {
    const html = renderToStaticMarkup(
      createElement(SecretFields, {
        secrets: [key],
        values: { GITHUB_APP_PRIVATE_KEY: PEM },
        onChange: () => {},
        after: "the install",
      }),
    );
    expect(html).toContain("<textarea");
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/<textarea[^>]*class="[^"]*font-mono/);
    expect(html).toContain(`>${PEM}</textarea>`);
    expect(html).toContain("GitHub App private key (GITHUB_APP_PRIVATE_KEY)");
    expect(html).toContain(`The .pem file GitHub gave you. ${MULTILINE_SECRET_NOTE}`);
  });
});

const secrets: CatalogSecret[] = [
  { name: "VAPID_PRIVATE_KEY", label: "Push signing key", generate: "vapid-private-key" },
  { name: "SESSION", label: "Session key", generate: true },
];

describe("initialSecretValues", () => {
  it("fills in a VAPID private key for a new install", () => {
    const values = initialSecretValues(secrets);
    expect(isVapidPrivateKey(values.VAPID_PRIVATE_KEY ?? "")).toBe(true);
    expect(values.SESSION).toHaveLength(32);
  });

  it("leaves a key the app already has empty, so an update never rotates it unasked", () => {
    const values = initialSecretValues(secrets, ["VAPID_PRIVATE_KEY"]);
    expect(values.VAPID_PRIVATE_KEY).toBe("");
    expect(values.SESSION).toHaveLength(32);
    expect(heldSecretNote(secrets[0] as CatalogSecret)).toBe(
      "The app already has this key. Paste it to keep existing push subscriptions, or generate a new one (subscribers must subscribe again).",
    );
  });

  it("names the vars derived from a secret in its note", () => {
    expect(
      derivedNote(secrets, "VAPID_PRIVATE_KEY", [
        {
          name: "VAPID_PUBLIC_KEY",
          derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
        },
      ]),
    ).toBe("Appflare also sets VAPID_PUBLIC_KEY from it.");
  });
});
