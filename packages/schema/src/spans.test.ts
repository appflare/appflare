import { describe, expect, it } from "vitest";
import { planSpans, SPAN_LIMITS, SpanBuilder } from "./spans";

describe("planSpans", () => {
  const file = (offset: number, size: number) => ({ path: `f${offset}`, offset, size });

  it("covers adjacent files and small gaps with one range, in offset order", () => {
    const spans = planSpans([file(30, 10), file(0, 10), file(14, 10)]);
    expect(spans.map((s) => [s.start, s.end, s.files.map((f) => f.offset)])).toEqual([
      [0, 40, [0, 14, 30]],
    ]);
  });

  it("starts a new range after a large gap or at the size limit, and skips empty files", () => {
    const limits = { maxBytes: 80, maxGap: 5 };
    expect(
      planSpans([file(0, 10), file(20, 10), file(31, 60), file(95, 10), file(50, 0)], limits).map(
        (s) => [s.start, s.end],
      ),
    ).toEqual([
      [0, 10],
      [20, 91],
      [95, 105],
    ]);
    // A file larger than the limit still gets a range of its own.
    expect(planSpans([file(0, 500)], limits).map((s) => [s.start, s.end])).toEqual([[0, 500]]);
  });

  it("keeps each range within the default limit", () => {
    const mib = 1024 * 1024;
    const files = Array.from({ length: 10 }, (_, i) => file(i * 3 * mib, 3 * mib));
    const spans = planSpans(files);
    expect(spans).toHaveLength(5);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(SPAN_LIMITS.maxBytes);
  });
});

describe("SpanBuilder", () => {
  it("previews what a file would add and counts the covered bytes, gaps included", () => {
    const builder = new SpanBuilder({ maxBytes: 100, maxGap: 4 });
    builder.add({ offset: 0, size: 10 });
    expect(builder.preview({ offset: 12, size: 5 })).toEqual({ newSpan: false, addedBytes: 7 });
    expect(builder.preview({ offset: 20, size: 5 })).toEqual({ newSpan: true, addedBytes: 5 });
    builder.add({ offset: 12, size: 5 });
    expect(builder.bytes).toBe(17);
    expect(builder.spans).toHaveLength(1);
  });
});
