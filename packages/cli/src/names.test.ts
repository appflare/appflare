import { describe, expect, it } from "vitest";
import { autoProvisionedResourceName, validateWorkerName } from "./names.ts";

describe("worker names", () => {
  it.each(["appflare", "appflare-cli-test", "a", "x1", "a".repeat(58)])("accepts %s", (n) => {
    expect(validateWorkerName(n)).toBe(n);
  });
  it.each(["", "-a", "a-", "App", "a_b", "a.b", "a".repeat(59)])("rejects %j", (n) => {
    expect(() => validateWorkerName(n)).toThrow("not a valid Worker name");
  });
  it("mirrors wrangler's auto-provisioned names", () => {
    expect(autoProvisionedResourceName("appflare", "KV")).toBe("appflare-kv");
    expect(autoProvisionedResourceName("mgr", "MY_CACHE")).toBe("mgr-my-cache");
  });
});
