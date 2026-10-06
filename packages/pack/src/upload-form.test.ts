import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUploadForm, UploadFormError } from "./upload-form.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "appflare-upload-form-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes `metadata` and `parts` as the multipart form wrangler serializes
 * with `--outfile` (undici's FormData, as wrangler builds it) and returns its path.
 */
async function writeForm(
  metadata: Record<string, unknown>,
  parts: Array<{ name: string; type: string; content: string | Uint8Array }>,
): Promise<string> {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const part of parts) {
    form.set(part.name, new File([part.content], part.name, { type: part.type }));
  }
  const file = path.join(dir, "upload.form");
  writeFileSync(file, Buffer.from(await new Response(form).arrayBuffer()));
  return file;
}

describe("readUploadForm", () => {
  it("types each module by its part's content type, the main module first", async () => {
    const file = await writeForm({ main_module: "index.js", bindings: [] }, [
      { name: "index.js", type: "application/javascript+module", content: "export default {}" },
      // A Text rule for **/*.svg: wrangler uploads the logo as text.
      { name: "./b12e-logo.svg", type: "text/plain", content: "<svg/>" },
      // A Data rule for **/*.txt: wrangler uploads the notes as bytes.
      { name: "./aaf4-notes.txt", type: "application/octet-stream", content: "notes" },
      { name: "./3f29-add.wasm", type: "application/wasm", content: new Uint8Array([0, 97]) },
      { name: "chunks/legacy.cjs", type: "application/javascript", content: "module.exports=1" },
      { name: "index.js.map", type: "application/source-map", content: "{}" },
    ]);
    const modules = await readUploadForm(file);
    expect(modules.map((m) => [m.name, m.type, m.isMain])).toEqual([
      ["index.js", "esm", true],
      ["3f29-add.wasm", "compiled-wasm", false],
      ["aaf4-notes.txt", "data", false],
      ["b12e-logo.svg", "text", false],
      ["chunks/legacy.cjs", "commonjs", false],
    ]);
    expect(modules[3]?.bytes.toString("utf8")).toBe("<svg/>");
    expect([...(modules[1]?.bytes ?? [])]).toEqual([0, 97]);
  });

  it("takes a Python Worker's modules as wrangler uploads them", async () => {
    const file = await writeForm({ main_module: "worker.py" }, [
      { name: "worker.py", type: "text/x-python", content: "def on_fetch(): pass" },
      { name: "requirements.txt", type: "text/x-python-requirement", content: "" },
    ]);
    expect((await readUploadForm(file)).map((m) => [m.name, m.type])).toEqual([
      ["worker.py", "python"],
      ["requirements.txt", "python-requirement"],
    ]);
  });

  it("has no modules for a Worker of static assets only", async () => {
    const file = await writeForm({ assets: { jwt: "x" } }, []);
    expect(await readUploadForm(file)).toEqual([]);
  });

  it("refuses a service-worker Worker", async () => {
    const file = await writeForm({ body_part: "index.js" }, [
      { name: "index.js", type: "application/javascript", content: "addEventListener()" },
    ]);
    await expect(readUploadForm(file)).rejects.toThrow(UploadFormError);
    await expect(readUploadForm(file)).rejects.toThrow(/service-worker format/);
  });

  it("refuses a module of a content type the artifact has no type for", async () => {
    const file = await writeForm({ main_module: "index.js" }, [
      { name: "index.js", type: "application/javascript+module", content: "" },
      { name: "x.bin", type: "image/png", content: "" },
    ]);
    await expect(readUploadForm(file)).rejects.toThrow(/x\.bin as "image\/png"/);
  });

  it("refuses a module named outside the Worker's directory", async () => {
    const file = await writeForm({ main_module: "index.js" }, [
      { name: "index.js", type: "application/javascript+module", content: "" },
      { name: "../shared/logo.svg", type: "text/plain", content: "" },
    ]);
    await expect(readUploadForm(file)).rejects.toThrow(/outside the Worker's own directory/);
  });

  it("refuses two modules that name one path", async () => {
    const file = await writeForm({ main_module: "index.js" }, [
      { name: "index.js", type: "application/javascript+module", content: "" },
      { name: "./index.js", type: "application/javascript+module", content: "" },
    ]);
    await expect(readUploadForm(file)).rejects.toThrow(/two modules named index\.js/);
  });

  it("refuses an upload without the main module it names", async () => {
    const file = await writeForm({ main_module: "index.js" }, [
      { name: "other.js", type: "application/javascript+module", content: "" },
    ]);
    await expect(readUploadForm(file)).rejects.toThrow(/main module index\.js/);
  });

  it("refuses a file that is not a multipart upload", async () => {
    const file = path.join(dir, "upload.form");
    writeFileSync(file, "not a form");
    await expect(readUploadForm(file)).rejects.toThrow(/not the multipart upload/);
  });
});
