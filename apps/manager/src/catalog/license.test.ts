import { describe, expect, it } from "vitest";
import { licenseHref, licenseParts } from "./license";

describe("licenseHref", () => {
  it("links common licenses to choosealicense.com by their base id", () => {
    expect(licenseHref("MIT")).toBe("https://choosealicense.com/licenses/mit/");
    expect(licenseHref("Apache-2.0")).toBe("https://choosealicense.com/licenses/apache-2.0/");
    expect(licenseHref("AGPL-3.0-only")).toBe("https://choosealicense.com/licenses/agpl-3.0/");
    expect(licenseHref("GPL-3.0-or-later")).toBe("https://choosealicense.com/licenses/gpl-3.0/");
    expect(licenseHref("GPL-2.0+")).toBe("https://choosealicense.com/licenses/gpl-2.0/");
  });

  it("links any other id to its SPDX page, and refuses what is not an id", () => {
    expect(licenseHref("Elastic-2.0")).toBe("https://spdx.org/licenses/Elastic-2.0.html");
    expect(licenseHref("LicenseRef-Proprietary")).toBeNull();
    expect(licenseHref("OR")).toBeNull();
    expect(licenseHref("see LICENSE")).toBeNull();
  });
});

describe("licenseParts", () => {
  it("keeps a single id as one linked part", () => {
    expect(licenseParts("MIT")).toEqual([
      { text: "MIT", href: "https://choosealicense.com/licenses/mit/" },
    ]);
  });

  it("links each id of an expression and keeps operators as text", () => {
    expect(licenseParts("(MIT OR Apache-2.0)")).toEqual([
      { text: "(", href: null },
      { text: "MIT", href: "https://choosealicense.com/licenses/mit/" },
      { text: " OR ", href: null },
      { text: "Apache-2.0", href: "https://choosealicense.com/licenses/apache-2.0/" },
      { text: ")", href: null },
    ]);
  });
});
