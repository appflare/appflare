import { describe, expect, it } from "vitest";
import { loginSearchSchema, MOVED_SIGN_IN_NOTE, showsMovedNote } from "./moved-note";

describe("the sign-in page after a move", () => {
  it("reads moved=1, as the router parses it or as text", () => {
    expect(loginSearchSchema.parse({ returnTo: "/apps", moved: 1 })).toEqual({
      returnTo: "/apps",
      moved: true,
    });
    expect(loginSearchSchema.parse({ moved: "1" }).moved).toBe(true);
    expect(loginSearchSchema.parse({ moved: 0 }).moved).toBeUndefined();
    expect(loginSearchSchema.parse({ moved: "yes" }).moved).toBeUndefined();
    expect(loginSearchSchema.parse({}).moved).toBeUndefined();
  });

  it("shows the note only with both the flag and a page to return to", () => {
    expect(showsMovedNote(loginSearchSchema.parse({ returnTo: "/apps", moved: 1 }))).toBe(true);
    expect(showsMovedNote(loginSearchSchema.parse({ moved: 1 }))).toBe(false);
    expect(showsMovedNote(loginSearchSchema.parse({ returnTo: "/apps" }))).toBe(false);
    // An unsafe return path is dropped, and the note with it.
    expect(showsMovedNote(loginSearchSchema.parse({ returnTo: "//evil.example", moved: 1 }))).toBe(
      false,
    );
  });

  it("says why to sign in again and where passkeys work", () => {
    expect(MOVED_SIGN_IN_NOTE).toBe(
      "Sign in again at the new address. Passkeys added at the old address work only there; add new ones in Users and sign-in.",
    );
  });
});
