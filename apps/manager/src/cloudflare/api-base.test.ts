import { describe, expect, it } from "vitest";
import { apiBaseOption, isLoopbackUrl } from "./api-base";

describe("CF_API_BASE_URL", () => {
  it("is honoured only for loopback hosts", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8789/client/v4")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8789/client/v4")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8789/client/v4")).toBe(true);
    expect(isLoopbackUrl("https://evil.example/client/v4")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.example/")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("falls back to the real API for any other host", () => {
    expect(apiBaseOption({})).toEqual({});
    expect(apiBaseOption({ CF_API_BASE_URL: "https://evil.example/client/v4" })).toEqual({});
    expect(apiBaseOption({ CF_API_BASE_URL: "http://127.0.0.1:1/client/v4" })).toEqual({
      baseUrl: "http://127.0.0.1:1/client/v4",
    });
  });
});
