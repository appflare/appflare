import { describe, expect, it } from "vitest";
import { SIGNED_OUT_COOKIE, signedOutHere } from "./access-sign-in";

describe("signedOutHere", () => {
  it("finds the sign-out marker among the request's cookies", () => {
    expect(signedOutHere(new Headers({ cookie: `a=1; ${SIGNED_OUT_COOKIE}=1; b=2` }))).toBe(true);
    expect(signedOutHere(new Headers({ cookie: `${SIGNED_OUT_COOKIE}=1` }))).toBe(true);
  });

  it("is false without it, also for a cookie whose name only contains it", () => {
    expect(signedOutHere(new Headers())).toBe(false);
    expect(signedOutHere(new Headers({ cookie: "a=1" }))).toBe(false);
    expect(signedOutHere(new Headers({ cookie: `x${SIGNED_OUT_COOKIE}=1` }))).toBe(false);
    expect(signedOutHere(new Headers({ cookie: `a=${SIGNED_OUT_COOKIE}` }))).toBe(false);
    // A part without "=" is a whole name, not a name missing its last letter.
    expect(signedOutHere(new Headers({ cookie: `${SIGNED_OUT_COOKIE}x; a=1` }))).toBe(false);
    expect(signedOutHere(new Headers({ cookie: `a=1; ${SIGNED_OUT_COOKIE}` }))).toBe(true);
    expect(signedOutHere(new Headers({ cookie: "a=1; appflare.signed_ou" }))).toBe(false);
  });
});
