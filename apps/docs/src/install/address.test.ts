import { describe, expect, it } from "vitest";
import { checkAddress, checkTypedAddress, isAppflareOrigin } from "./address.ts";

function origin(check: ReturnType<typeof checkAddress>): string | null {
  return check.ok ? check.origin : null;
}

describe("checkAddress", () => {
  it("keeps the origin of an https address, never its path, query or fragment", () => {
    expect(origin(checkAddress("https://appflare.example.com"))).toBe(
      "https://appflare.example.com",
    );
    expect(origin(checkAddress(" HTTPS://Appflare.Example.com:8443/settings?x=1#top "))).toBe(
      "https://appflare.example.com:8443",
    );
    expect(origin(checkAddress("https://appflare.me.workers.dev/"))).toBe(
      "https://appflare.me.workers.dev",
    );
  });

  it("allows http only for an Appflare on this computer", () => {
    expect(origin(checkAddress("http://localhost:8787/"))).toBe("http://localhost:8787");
    expect(origin(checkAddress("http://127.0.0.1:5173"))).toBe("http://127.0.0.1:5173");
    expect(origin(checkAddress("http://[::1]:8787"))).toBe("http://[::1]:8787");
    for (const text of [
      "http://appflare.example.com",
      "http://localhost.example.com",
      "http://127.0.0.2",
      "http://10.0.0.1",
    ]) {
      expect(checkAddress(text), text).toEqual({
        ok: false,
        error:
          "Use the address that starts with https://. Only an Appflare on this computer can use http://.",
      });
    }
  });

  it("refuses other schemes, relative addresses and a user name or password", () => {
    for (const text of [
      "javascript:alert(1)",
      "JavaScript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "//evil.example",
      "/install/2fa",
      "ftp://appflare.example.com",
      "file:///etc/passwd",
      "blob:https://appflare.example.com/1",
      "appflare.example.com",
      "https://",
      "",
      "   ",
      `https://${"a".repeat(2100)}.com`,
    ]) {
      expect(checkAddress(text).ok, text).toBe(false);
    }
    expect(checkAddress("https://user:secret@appflare.example.com")).toEqual({
      ok: false,
      error: "Enter the address without a user name or password.",
    });
    expect(checkAddress("https://user@appflare.example.com").ok).toBe(false);
  });
});

describe("checkTypedAddress", () => {
  it("adds https:// to a plain host name, as people type it", () => {
    expect(origin(checkTypedAddress("appflare.me.workers.dev"))).toBe(
      "https://appflare.me.workers.dev",
    );
    expect(origin(checkTypedAddress("appflare.example.com:8443/home"))).toBe(
      "https://appflare.example.com:8443",
    );
    expect(origin(checkTypedAddress("localhost:8787"))).toBe("https://localhost:8787");
    expect(origin(checkTypedAddress("http://localhost:8787"))).toBe("http://localhost:8787");
  });

  it("does not guess at other schemes or slashes", () => {
    for (const text of [
      "javascript:alert(1)",
      "javascript://%0aalert(1)",
      "mailto:someone@example.com",
      "data:text/html,hi",
      "//evil.example",
      "\\\\evil.example",
      "/relative",
      "http://evil.example",
      "user:pass@appflare.example.com",
    ]) {
      expect(checkTypedAddress(text).ok, text).toBe(false);
    }
  });
});

describe("isAppflareOrigin", () => {
  it("accepts a checked origin and nothing more", () => {
    expect(isAppflareOrigin("https://appflare.example.com")).toBe(true);
    expect(isAppflareOrigin("http://localhost:8787")).toBe(true);
    expect(isAppflareOrigin("https://appflare.example.com/")).toBe(false);
    expect(isAppflareOrigin("https://appflare.example.com/install")).toBe(false);
    expect(isAppflareOrigin("javascript:alert(1)")).toBe(false);
    expect(isAppflareOrigin("http://evil.example")).toBe(false);
    expect(isAppflareOrigin(null)).toBe(false);
    expect(isAppflareOrigin(42)).toBe(false);
  });
});
