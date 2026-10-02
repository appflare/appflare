import { describe, expect, it } from "vitest";
import {
  accessRequiredOffRefusal,
  accessRequiredRefusal,
  accessStartsOn,
  installAccessChoice,
} from "./access-offer";

describe("installAccessChoice", () => {
  const app = (mode?: "required" | "recommended") => ({
    name: "Cut",
    ...(mode === undefined ? {} : { access: { mode } }),
  });

  it("protects an app whose entry requires it, and refuses a start that asks for none", () => {
    expect(installAccessChoice(app("required"), undefined)).toEqual({
      ok: true,
      access: true,
      offer: "required",
    });
    expect(installAccessChoice(app("required"), true)).toMatchObject({ ok: true, access: true });
    expect(installAccessChoice(app("required"), false)).toEqual({
      ok: false,
      error: accessRequiredRefusal("Cut"),
    });
  });

  it("protects any other app only when asked to", () => {
    expect(installAccessChoice(app("recommended"), undefined)).toMatchObject({ access: false });
    expect(installAccessChoice(app("recommended"), true)).toMatchObject({ access: true });
    expect(installAccessChoice(app(), false)).toMatchObject({ access: false, offer: "offered" });
  });

  it("starts the form's switch on for a required or recommended entry", () => {
    expect(accessStartsOn(app("required"))).toBe(true);
    expect(accessStartsOn(app("recommended"))).toBe(true);
    expect(accessStartsOn(app())).toBe(false);
    expect(accessRequiredOffRefusal("Cut")).toContain("cannot be turned off");
  });
});
