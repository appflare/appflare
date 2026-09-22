import { describe, expect, it } from "vitest";
import { buildUploadFormData, MODULE_CONTENT_TYPES } from "./modules";

describe("buildUploadFormData", () => {
  it("writes a metadata field and one typed part per module", () => {
    const form = buildUploadFormData({ main_module: "index.js" }, [
      { name: "index.js", content: "export default {};" }, // defaults to esm
      { name: "helper.js", content: "1;", type: "commonjs" },
      { name: "data.bin", content: new Uint8Array([1, 2, 3]), type: "buffer" },
      { name: "notes.txt", content: "hi", type: "text" },
      { name: "custom", content: "x", contentType: "application/x-custom" },
    ]);

    expect(JSON.parse(form.get("metadata") as string)).toEqual({ main_module: "index.js" });

    const index = form.get("index.js") as File;
    expect(index.name).toBe("index.js");
    expect(index.type).toBe("application/javascript+module");

    expect((form.get("helper.js") as File).type).toBe("application/javascript");
    expect((form.get("data.bin") as File).type).toBe("application/octet-stream");
    expect((form.get("notes.txt") as File).type).toBe("text/plain");
    expect((form.get("custom") as File).type).toBe("application/x-custom");
  });

  it("exposes the five recognized module content types", () => {
    expect(MODULE_CONTENT_TYPES).toEqual({
      esm: "application/javascript+module",
      commonjs: "application/javascript",
      "compiled-wasm": "application/wasm",
      text: "text/plain",
      buffer: "application/octet-stream",
    });
  });
});
