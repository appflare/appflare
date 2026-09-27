import { describe, expect, it } from "vitest";
import { HOME_CLICK_STATE, homeLanding, isHomeClick } from "./home-landing";

describe("where / leads", () => {
  it("goes on to the catalog when nothing is installed and Home was not clicked", () => {
    expect(homeLanding(0, undefined)).toBe("catalog");
    expect(homeLanding(0, { __TSR_index: 0, key: "abc" })).toBe("catalog");
    expect(homeLanding(0, null)).toBe("catalog");
  });

  it("stays on Home after a click on Home, even with nothing installed", () => {
    expect(homeLanding(0, { ...HOME_CLICK_STATE, __TSR_index: 3 })).toBe("home");
  });

  it("stays on Home whenever something is installed", () => {
    expect(homeLanding(1, undefined)).toBe("home");
    expect(homeLanding(4, HOME_CLICK_STATE)).toBe("home");
  });

  it("recognises only the Home click's own mark", () => {
    expect(isHomeClick(HOME_CLICK_STATE)).toBe(true);
    expect(isHomeClick({ homeClick: "yes" })).toBe(false);
    expect(isHomeClick("homeClick")).toBe(false);
  });
});
