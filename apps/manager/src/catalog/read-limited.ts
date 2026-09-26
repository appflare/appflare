/**
 * The whole body, or null as soon as it passes `max` bytes (the rest is not
 * read). An empty body reads as zero bytes. Every body the manager reads
 * from a catalog site (images, avatars, indexes, stats) goes through this,
 * so a response without (or lying about) its length is cut off at the limit
 * instead of being buffered whole.
 */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
