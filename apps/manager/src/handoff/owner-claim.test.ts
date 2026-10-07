import { describe, expect, it } from "vitest";
import {
  claimNoticeFor,
  ownerClaimFromHash,
  redeemOwnerClaimWith,
  takeOwnerClaimFromAddressBar,
} from "./owner-claim";

const CODE = "Zm9vYmFyLWJhei0wMTIzNDU2Nzg5LWFiY2RlZmdoaWo";

function fakeWindow(href: string) {
  const url = new URL(href);
  const replaced: string[] = [];
  return {
    replaced,
    w: {
      location: { hash: url.hash, pathname: url.pathname, search: url.search },
      history: {
        state: { key: "k" },
        replaceState: (_state: unknown, _unused: string, next: string) => replaced.push(next),
      },
    } as unknown as Pick<Window, "location" | "history">,
  };
}

describe("exchanging the code", () => {
  it("says refused only when the server refused it", async () => {
    const answer = (outcome: "ok" | "refused" | "rate-limited") => async () => ({ outcome });
    expect(await redeemOwnerClaimWith(answer("ok"), CODE)).toBe("ok");
    expect(await redeemOwnerClaimWith(answer("refused"), CODE)).toBe("refused");
    // Asked to wait, or no answer at all: not refused; try again.
    expect(await redeemOwnerClaimWith(answer("rate-limited"), CODE)).toBe("retry");
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await redeemOwnerClaimWith(offline, CODE)).toBe("retry");
    expect(await redeemOwnerClaimWith(answer("ok"), null)).toBe("refused");
  });

  it("keeps the code for Try again, and shows notices on the first step only", () => {
    expect(claimNoticeFor({ code: CODE }, "retry", true)).toEqual({ kind: "retry", code: CODE });
    expect(claimNoticeFor({ code: CODE }, "refused", true)).toEqual({ kind: "refused" });
    expect(claimNoticeFor({ code: null }, "refused", true)).toEqual({ kind: "refused" });
    expect(claimNoticeFor({ code: CODE }, "ok", true)).toBeNull();
    expect(claimNoticeFor({ code: CODE }, "retry", false)).toBeNull();
    expect(claimNoticeFor(null, null, true)).toBeNull();
  });
});

describe("the owner claim in the address", () => {
  it("reads a well-formed code from #claim=", () => {
    expect(ownerClaimFromHash(`#claim=${CODE}`)).toBe(CODE);
    expect(ownerClaimFromHash("#claim=short")).toBeNull();
    expect(ownerClaimFromHash("#claim=has+plus/slash0123456789")).toBeNull();
    expect(ownerClaimFromHash("#other=1")).toBeNull();
    expect(ownerClaimFromHash("")).toBeNull();
  });

  it("takes it out of the address bar before it is used, keeping the rest", () => {
    const { w, replaced } = fakeWindow(`https://appflare.example.com/setup?x=1#claim=${CODE}`);
    expect(takeOwnerClaimFromAddressBar(w)).toEqual({ code: CODE });
    expect(replaced).toEqual(["/setup?x=1"]);
    // A malformed code is removed all the same, and reported as such.
    const bad = fakeWindow("https://appflare.example.com/setup#claim=bad");
    expect(takeOwnerClaimFromAddressBar(bad.w)).toEqual({ code: null });
    expect(bad.replaced).toEqual(["/setup"]);
    // Nothing to take: the address is left alone.
    const none = fakeWindow("https://appflare.example.com/setup#section");
    expect(takeOwnerClaimFromAddressBar(none.w)).toBeNull();
    expect(none.replaced).toEqual([]);
  });
});
