import { describe, expect, it } from "vitest";
import { assetContentType, NO_CONTENT_TYPE } from "./mime";

describe("assetContentType", () => {
  it("matches wrangler: text types get a charset, unknown ones no Content-Type", () => {
    expect(assetContentType("/assets/styles.css")).toBe("text/css; charset=utf-8");
    expect(assetContentType("/app.js")).toBe("text/javascript; charset=utf-8");
    expect(assetContentType("/logo.svg")).toBe("image/svg+xml");
    expect(assetContentType("/font.WOFF2")).toBe("font/woff2");
    expect(assetContentType("/LICENSE")).toBe(NO_CONTENT_TYPE);
    expect(assetContentType("/data.xyz")).toBe(NO_CONTENT_TYPE);
  });
});
