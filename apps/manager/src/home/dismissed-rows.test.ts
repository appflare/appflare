import { describe, expect, it } from "vitest";
import { accountRowKey } from "./attention";
import { dismissedSet, parseDismissedRows, pruneDismissed, withDismissed } from "./dismissed-rows";

const r2 = accountRowKey({ id: "r2", neededBy: ["a"] });
const zone = accountRowKey({ id: "zone", neededBy: ["a", "b"] });

describe("account rows put away with Not needed", () => {
  it("keys a row to the installs that needed it", () => {
    expect(r2).toMatch(/^r2:[0-9a-f]{8}$/);
    expect(accountRowKey({ id: "r2", neededBy: ["a"] })).toBe(r2);
    expect(accountRowKey({ id: "r2", neededBy: ["a", "c"] })).not.toBe(r2);
  });

  it("remembers keys as one sorted list without repeats", () => {
    expect(withDismissed("", zone)).toBe(zone);
    expect(withDismissed(zone, r2)).toBe(`${r2},${zone}`);
    expect(withDismissed(`${r2},${zone}`, r2)).toBe(`${r2},${zone}`);
  });

  it("reads a stored list, dropping anything that is not a row key", () => {
    expect(parseDismissedRows(null)).toBe("");
    // Plain row ids from before keys carried the apps are dropped too.
    expect(parseDismissedRows(` ${zone} , ,r2,<b>,${zone}`)).toBe(zone);
    expect([...dismissedSet(parseDismissedRows(`${zone},${r2}`))]).toEqual([r2, zone]);
    expect(dismissedSet("").size).toBe(0);
  });

  it("forgets a row once it no longer needs action for the same apps", () => {
    const stored = `${r2},${zone}`;
    expect(pruneDismissed(stored, new Set([r2, zone]))).toBe(stored);
    expect(pruneDismissed(stored, new Set([r2]))).toBe(r2);
    // R2 now needed by one more app: a new key, so the old one goes.
    const r2Later = accountRowKey({ id: "r2", neededBy: ["a", "b"] });
    expect(pruneDismissed(stored, new Set([r2Later]))).toBe("");
  });
});
