import { describe, expect, it } from "vitest";
import { randomNamespaceId, rateLimitBindings } from "./rate-limits";

describe("rate limit namespaces", () => {
  it("draws positive 32-bit ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = randomNamespaceId();
      expect(id).toMatch(/^[1-9]\d*$/);
      expect(Number(id)).toBeLessThanOrEqual(2_147_483_647);
      ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(190);
  });

  it("lists the Worker's rate limit bindings", () => {
    expect(
      rateLimitBindings([
        { type: "ratelimit", name: "A", namespace_id: "1" },
        { type: "kv_namespace", name: "KV" },
        { type: "ratelimit", name: "B", namespace_id: "1" },
      ]),
    ).toEqual(["A", "B"]);
  });
});
