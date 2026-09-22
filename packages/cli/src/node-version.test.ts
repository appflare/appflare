import { describe, expect, it } from "vitest";
import { checkNodeVersion } from "./node-version.ts";

describe("checkNodeVersion", () => {
  it.each(["22.0.0", "22.23.2", "v24.1.0", "30.0.0"])("accepts %s", (v) => {
    expect(() => checkNodeVersion(v)).not.toThrow();
  });
  it.each(["20.18.0", "18.0.0", "v21.9.9", "garbage"])("rejects %s with a clear message", (v) => {
    expect(() => checkNodeVersion(v)).toThrow(/needs Node\.js 22 or newer; this is Node\.js/);
  });
});
