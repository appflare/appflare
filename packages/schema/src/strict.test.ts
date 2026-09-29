import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatPath, strictSchema, unknownKeys } from "./strict";

const schema = z.object({
  name: z.string(),
  nested: z.object({ a: z.number().default(1) }).optional(),
  list: z.array(z.object({ id: z.string() })).default([]),
  byName: z.record(z.string(), z.object({ size: z.number() })).optional(),
  loose: z.looseObject({ kept: z.string() }).optional(),
  either: z
    .union([z.object({ kind: z.literal("a"), a: z.string() }), z.object({ kind: z.literal("b") })])
    .optional(),
  piped: z
    .object({ x: z.string() })
    .transform((v) => v.x)
    .optional(),
});

describe("unknownKeys", () => {
  it("finds keys a plain object would strip, at any depth", () => {
    const found = unknownKeys(schema, {
      name: "n",
      nmae: "typo",
      nested: { a: 2, b: 3 },
      list: [{ id: "1" }, { id: "2", idd: "x" }],
      byName: { one: { size: 1, sise: 2 } },
    });
    expect(found.map((k) => formatPath(k.path))).toEqual([
      "nmae",
      "nested.b",
      "list[1].idd",
      "byName.one.sise",
    ]);
  });

  it("leaves loose objects alone", () => {
    expect(unknownKeys(schema, { name: "n", loose: { kept: "k", extra: 1 } })).toEqual([]);
  });

  it("follows a union into the option the value parses under", () => {
    expect(
      unknownKeys(schema, { name: "n", either: { kind: "b", a: "only in option a" } }).map((k) =>
        formatPath(k.path),
      ),
    ).toEqual(["either.a"]);
  });

  it("reports only keys every option strips when no option fits", () => {
    expect(
      unknownKeys(schema, { name: "n", either: { kind: "c", a: "x", z: 1 } }).map((k) =>
        formatPath(k.path),
      ),
    ).toEqual(["either.z"]);
  });

  it("looks into the input side of a transform", () => {
    expect(unknownKeys(schema, { name: "n", piped: { x: "v", y: 1 } }).map((k) => k.key)).toEqual([
      "y",
    ]);
  });
});

describe("strictSchema", () => {
  const strict = strictSchema(schema, (value) =>
    (value as { name?: unknown }).name === "bad"
      ? [{ path: ["name"], message: "name is bad" }]
      : [],
  );

  it("gives what the schema gives", () => {
    expect(strict.parse({ name: "n", nested: {} })).toEqual(
      schema.parse({ name: "n", nested: {} }),
    );
  });

  it("refuses unknown keys, naming their path, and adds its own checks", () => {
    const result = strict.safeParse({ name: "n", nested: { b: 1 } });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["nested", "b"],
        message: "nested.b is not a field here; check its spelling",
      }),
    ]);
    expect(strict.safeParse({ name: "bad" }).error?.issues[0]?.message).toBe("name is bad");
  });

  it("says where a renamed key went when it knows", () => {
    const renamed = strictSchema(schema, undefined, (path) =>
      path.join(".") === "nested.b" ? "nested.b is now nested.a" : null,
    );
    expect(
      renamed
        .safeParse({ name: "n", nested: { b: 1 }, nmae: 1 })
        .error?.issues.map((i) => i.message),
    ).toEqual(["nested.b is now nested.a", "nmae is not a field here; check its spelling"]);
  });

  it("reports unknown keys beside the schema's own problems", () => {
    const result = strict.safeParse({ nmae: "n" });
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["nmae", "name"]);
    // Its own checks run even when the schema refuses the value.
    const both = strict.safeParse({ name: "bad", nested: { a: "x" } });
    expect(both.error?.issues.map((i) => i.path.join("."))).toEqual(["nested.a", "name"]);
  });
});
