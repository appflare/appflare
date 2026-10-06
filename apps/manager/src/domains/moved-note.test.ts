import { describe, expect, it } from "vitest";
import {
  loginSearchSchema,
  MOVED_SIGN_IN_NOTE,
  movedHere,
  pendingAddressNote,
  showsMovedNote,
} from "./moved-note";

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

  it("knows Appflare moved here lately, at this address only", () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const rows = {
      hostname: "appflare.example.com",
      previousHostname: "appflare.ada.workers.dev",
      movedAt: "2026-10-06T12:00:00.000Z",
    };
    expect(movedHere(rows, "Appflare.Example.com", now)).toBe(true);
    expect(movedHere(rows, "appflare.ada.workers.dev", now)).toBe(false);
    expect(movedHere({ ...rows, movedAt: "2026-09-01T00:00:00.000Z" }, rows.hostname, now)).toBe(
      false,
    );
    // Installed on the domain: nothing was left, so nobody signs in again.
    expect(movedHere({ ...rows, previousHostname: null }, rows.hostname, now)).toBe(false);
    expect(movedHere({ ...rows, hostname: null }, rows.hostname, now)).toBe(false);
  });

  it("tells the owner at workers.dev that passkeys come after the move", () => {
    expect(pendingAddressNote("appflare.example.com")).toBe(
      "Appflare moves to appflare.example.com once it is ready. Sign in there with this password, then add a passkey.",
    );
  });

  it("says why to sign in again and where passkeys work", () => {
    expect(MOVED_SIGN_IN_NOTE).toBe(
      "Sign in again at the new address. Passkeys added at the old address work only there; add new ones in Users and sign-in.",
    );
  });
});
