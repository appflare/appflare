import { describe, expect, it } from "vitest";
import {
  CATALOG_STALE_MS,
  INSTALL_PAGE_STALE_MS,
  PENDING_MIN_MS,
  PENDING_MS,
} from "./router-timing";

describe("page timing", () => {
  it("shows the loading indicator after 300 ms, for at least 200 ms", () => {
    expect(PENDING_MS).toBe(300);
    expect(PENDING_MIN_MS).toBe(200);
  });

  it("lets the catalog pages serve 30 s and an install's page 10 s", () => {
    expect(CATALOG_STALE_MS).toBe(30_000);
    expect(INSTALL_PAGE_STALE_MS).toBe(10_000);
  });
});
