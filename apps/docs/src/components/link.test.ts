import { describe, expect, it } from "vitest";
import { splitHref } from "./link.tsx";

describe("splitHref", () => {
  it("passes the anchor as the router's hash, not as part of the path", () => {
    expect(splitHref("/security/#protect-with-cloudflare-access")).toEqual({
      to: "/security/",
      hash: "protect-with-cloudflare-access",
    });
  });

  it("leaves hrefs without an anchor alone", () => {
    expect(splitHref("/start/install/")).toEqual({ to: "/start/install/" });
  });
});
