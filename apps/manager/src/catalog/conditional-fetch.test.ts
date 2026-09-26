import { describe, expect, it } from "vitest";
import { CatalogError, fetchCatalogJson, MAX_CATALOG_JSON_BYTES } from "./conditional-fetch";

const URL = "https://acme.test/index.json";

/** A body of `size` bytes in 64 KiB chunks, with no declared length. */
function streamOf(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  let pulls = 0;
  return new ReadableStream({
    pull(controller) {
      pulls++;
      if (sent >= size || pulls > 1000) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(64 * 1024, size - sent)).fill(0x20);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

describe("fetchCatalogJson", () => {
  it("reads a body within the limit", async () => {
    const result = await fetchCatalogJson(
      async () => Response.json({ apps: [] }, { headers: { etag: '"v1"' } }),
      URL,
      null,
      "catalog",
    );
    expect(result).toEqual({ status: "ok", json: { apps: [] }, etag: '"v1"' });
  });

  it("refuses a body that declares more than the limit, without waiting for it", async () => {
    // A body that never ends: only the declared length can refuse it.
    const body = new ReadableStream<Uint8Array>({ pull() {} });
    const refused = fetchCatalogJson(
      async () =>
        new Response(body, {
          headers: { "content-length": String(MAX_CATALOG_JSON_BYTES + 1) },
        }),
      URL,
      null,
      "catalog",
    );
    await expect(refused).rejects.toThrow(CatalogError);
    await expect(refused).rejects.toThrow("is larger than 4 MiB, the most Appflare reads.");
  });

  it("stops reading a body without a length as soon as it passes the limit", async () => {
    const max = 256 * 1024;
    await expect(
      fetchCatalogJson(async () => new Response(streamOf(10 * max)), URL, null, "catalog", max),
    ).rejects.toThrow(`The catalog at ${URL} is larger than 0.25 MiB`);
    await expect(
      fetchCatalogJson(async () => new Response(streamOf(max)), URL, null, "catalog", max),
    ).rejects.toThrow("did not return JSON");
  });
});
