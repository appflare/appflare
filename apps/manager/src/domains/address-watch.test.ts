import { describe, expect, it } from "vitest";
import { movedLine, movedUrl, watchesAddress, watchStep } from "./address-watch";

const DEV = "appflare.ada.workers.dev";
const HOST = "appflare.example.com";

describe("a page open while Appflare waits to move", () => {
  it("watches at the workers.dev address only", () => {
    expect(watchesAddress(DEV)).toBe(true);
    expect(watchesAddress("APPFLARE.ADA.WORKERS.DEV")).toBe(true);
    expect(watchesAddress(HOST)).toBe(false);
    expect(watchesAddress("localhost:5173")).toBe(false);
  });

  it("waits while a domain is pending, stops when none is, follows a move", () => {
    expect(watchStep({ hostname: null, pending: true }, DEV)).toEqual({ kind: "wait" });
    expect(watchStep({ hostname: null, pending: false }, DEV)).toEqual({ kind: "stop" });
    expect(watchStep({ hostname: HOST, pending: false }, DEV)).toEqual({
      kind: "moved",
      hostname: HOST,
    });
    // Already there: nothing to follow.
    expect(watchStep({ hostname: HOST, pending: false }, HOST)).toEqual({ kind: "stop" });
  });

  it("goes to the same page at the new address, and says so in one line", () => {
    expect(movedUrl(HOST, { pathname: "/apps/x", search: "?tab=domains", hash: "#address" })).toBe(
      `https://${HOST}/apps/x?tab=domains#address`,
    );
    expect(movedLine(HOST)).toBe(`Appflare moved to ${HOST}.`);
  });
});
