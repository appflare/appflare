import { describe, expect, it } from "vitest";
import {
  caretAt,
  chipKeyEdit,
  chipLabel,
  describeChip,
  fromSegments,
  insertPlaceholder,
  placeholderOptions,
  removeChip,
  setPart,
  toSegments,
} from "./placeholder-chips";

const URL_VALUE = "{{workerUrl}}/auth/callback?account={{ accountId }}";

describe("placeholder chips", () => {
  it("split a value into text parts with one chip between each two", () => {
    expect(toSegments(URL_VALUE)).toEqual({
      texts: ["", "/auth/callback?account=", ""],
      chips: [
        { raw: "{{workerUrl}}", key: "workerUrl", worker: null },
        { raw: "{{ accountId }}", key: "accountId", worker: null },
      ],
    });
    expect(toSegments("plain")).toEqual({ texts: ["plain"], chips: [] });
    expect(toSegments("{{workerName:api}}.{{wildcardHostname}}", ["api"]).chips).toEqual([
      { raw: "{{workerName:api}}", key: "workerName", worker: "api" },
      { raw: "{{wildcardHostname}}", key: "wildcardHostname", worker: null },
    ]);
  });

  it("keep the stored value exactly as written, spaces in braces and unknown braces included", () => {
    for (const value of [
      URL_VALUE,
      "",
      "no placeholders",
      "{{workerName}}{{workerName}}",
      "{{ somethingElse }} and {{workerUrl:web}}",
      "{{workerUrl",
    ]) {
      expect(fromSegments(toSegments(value))).toBe(value);
    }
    // Anything else in double braces stays text: only the manager's placeholders are chips.
    expect(toSegments("{{ somethingElse }}").chips).toEqual([]);
  });

  it("keep a placeholder naming a Worker the app does not have as text, since nothing fills it in", () => {
    expect(toSegments("{{workerUrl:web}}/x", ["api"])).toEqual({
      texts: ["{{workerUrl:web}}/x"],
      chips: [],
    });
    expect(toSegments("{{workerUrl:api}}/x").chips).toEqual([]);
    expect(toSegments("{{workerUrl:api}}/x", ["api"]).chips).toHaveLength(1);
  });

  it("show a label for each chip, not the placeholder", () => {
    expect(toSegments(URL_VALUE).chips.map(chipLabel)).toEqual(["App address", "Account ID"]);
    expect(chipLabel({ key: "workerName", worker: null })).toBe("Worker name");
    expect(chipLabel({ key: "wildcardHostname", worker: null })).toBe("Wildcard domain");
    expect(chipLabel({ key: "workerUrl", worker: "api" })).toBe("api address");
  });

  it("delete a chip whole with Backspace at the start of the text after it", () => {
    // The caret sits at the start of "/auth…", right after the App address chip.
    const edit = chipKeyEdit(URL_VALUE, { part: 1, offset: 0 }, "Backspace");
    expect(edit).toEqual({
      value: "/auth/callback?account={{ accountId }}",
      caret: { part: 0, offset: 0 },
    });
  });

  it("delete a chip whole with Delete at the end of the text before it", () => {
    const edit = chipKeyEdit(URL_VALUE, { part: 1, offset: 23 }, "Delete");
    expect(edit?.value).toBe("{{workerUrl}}/auth/callback?account=");
    expect(edit?.caret).toEqual({ part: 1, offset: 23 });
  });

  it("leave ordinary editing to the text part", () => {
    expect(chipKeyEdit(URL_VALUE, { part: 1, offset: 3 }, "Backspace")).toBeNull();
    expect(chipKeyEdit(URL_VALUE, { part: 0, offset: 0 }, "Backspace")).toBeNull();
    expect(chipKeyEdit(URL_VALUE, { part: 2, offset: 0 }, "Delete")).toBeNull();
    expect(chipKeyEdit(URL_VALUE, { part: 1, offset: 0 }, "a")).toBeNull();
  });

  it("merge the text on both sides of a removed chip", () => {
    const edit = removeChip("a{{workerName}}b", 0);
    expect(edit).toEqual({ value: "ab", caret: { part: 0, offset: 1 } });
    expect(removeChip("a", 3).value).toBe("a");
  });

  it("insert a placeholder at the caret and put the caret right after its chip", () => {
    const edit = insertPlaceholder(
      "https://example.com/",
      { part: 0, offset: 8 },
      "{{workerName}}",
    );
    expect(edit.value).toBe("https://{{workerName}}example.com/");
    expect(edit.caret).toEqual({ part: 1, offset: 0 });
    expect(insertPlaceholder("", { part: 0, offset: 0 }, "{{accountId}}").value).toBe(
      "{{accountId}}",
    );
  });

  it("edit one text part and keep the caret where it was", () => {
    const edit = setPart(URL_VALUE, 1, "/login", 6);
    expect(edit.value).toBe("{{workerUrl}}/login{{ accountId }}");
    expect(edit.caret).toEqual({ part: 1, offset: 6 });
  });

  it("turn a placeholder typed in full into a chip, the caret after it", () => {
    const edit = setPart("x", 0, "x{{accountId}}", 14);
    expect(toSegments(edit.value).chips).toHaveLength(1);
    expect(edit.caret).toEqual({ part: 1, offset: 0 });
    expect(caretAt("a{{workerName}}b", 5)).toEqual({ part: 1, offset: 0 });
    expect(caretAt("a{{workerName}}b", 1)).toEqual({ part: 0, offset: 1 });
  });

  it("offer the app's placeholders, the wildcard domain and each Worker only where they apply", () => {
    expect(placeholderOptions().map((o) => o.label)).toEqual([
      "App address",
      "Worker name",
      "Account ID",
    ]);
    expect(
      placeholderOptions({ wildcard: true, workers: ["api"] }).map((o) => o.placeholder),
    ).toEqual([
      "{{workerUrl}}",
      "{{workerName}}",
      "{{accountId}}",
      "{{wildcardHostname}}",
      "{{workerUrl:api}}",
      "{{workerName:api}}",
    ]);
  });

  it("say what a chip is filled in with", () => {
    const known = { workerUrl: "https://cut.acme.workers.dev", workerName: "cut" };
    expect(describeChip({ key: "workerUrl", worker: null }, known, "when it installs")).toBe(
      "Filled in with https://cut.acme.workers.dev",
    );
    expect(describeChip({ key: "accountId", worker: null }, known, "when it installs")).toBe(
      "Filled in with your Cloudflare account ID when it installs",
    );
    expect(
      describeChip(
        { key: "workerName", worker: "api" },
        { entryWorkers: { api: { workerName: "cut-api", workerUrl: null } } },
        "when it installs",
      ),
    ).toBe("Filled in with cut-api");
  });
});
