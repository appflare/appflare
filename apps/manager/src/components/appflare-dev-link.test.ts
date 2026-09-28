import { describe, expect, it } from "vitest";
import { appflareDevLink } from "./appflare-dev-link";

describe("appflareDevLink", () => {
  it("hands appflare.dev this manager's origin in the fragment, encoded", () => {
    expect(appflareDevLink("https://appflare.acme.workers.dev")).toBe(
      "https://appflare.dev/my/#manager=https%3A%2F%2Fappflare.acme.workers.dev",
    );
  });

  it("sends only the origin, never a path, query or fragment", () => {
    expect(appflareDevLink("https://apps.example.com/settings/account?x=1#connection")).toBe(
      "https://appflare.dev/my/#manager=https%3A%2F%2Fapps.example.com",
    );
  });

  it("gives no link without a web address", () => {
    for (const value of [null, undefined, "", "not a url", "javascript:alert(1)"]) {
      expect(appflareDevLink(value), String(value)).toBeNull();
    }
  });
});
