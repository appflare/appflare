import { type CatalogSecret, isVapidPrivateKey } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { derivedNote, heldSecretNote, initialSecretValues } from "./secret-fields";

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
