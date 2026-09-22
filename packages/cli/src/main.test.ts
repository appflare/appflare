import { describe, expect, it } from "vitest";
import { splitCommand } from "./main.ts";

describe("splitCommand", () => {
  it("defaults to install", () => {
    expect(splitCommand(["--yes"])).toEqual({ command: "install", args: ["--yes"] });
    expect(splitCommand([])).toEqual({ command: "install", args: [] });
  });
  it("picks a named command", () => {
    expect(splitCommand(["rollback", "--to", "v"])).toEqual({
      command: "rollback",
      args: ["--to", "v"],
    });
  });
});
