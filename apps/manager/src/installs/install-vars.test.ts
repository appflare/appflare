import type { ArtifactManifest, CatalogVar, WorkerBinding } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  type InstallVarField,
  installVarFields,
  missingRequiredVar,
  resolveVars,
  varsUseWorkerUrl,
  varValueProblem,
} from "./install-vars";

function manifest(
  bindings: WorkerBinding[],
  vars: CatalogVar[],
): Pick<ArtifactManifest, "catalog" | "worker"> {
  return {
    worker: { bindings } as ArtifactManifest["worker"],
    catalog: { vars } as ArtifactManifest["catalog"],
  };
}

const v = (name: string, extra: Partial<CatalogVar> = {}): CatalogVar => ({
  name,
  label: name.toLowerCase(),
  required: false,
  ...extra,
});

describe("installVarFields", () => {
  it("shows the catalog default, else the wrangler config's value, and sends only the catalog default", () => {
    const fields = installVarFields(
      manifest(
        [
          { type: "plain_text", name: "REGION", text: "eu" },
          { type: "json", name: "ADDRESSES", json: ["a@example.com"] },
          { type: "json", name: "LIMITS", json: { max: 3 } },
        ],
        [
          v("REGION", { help: "Where it runs." }),
          v("ADDRESSES"),
          v("LIMITS", { default: '{"max":5}' }),
          v("PUBLIC_URL", { default: "{{workerUrl}}", required: true }),
        ],
      ),
    );
    expect(fields).toEqual([
      {
        name: "REGION",
        label: "region",
        help: "Where it runs.",
        required: false,
        kind: "text",
        shownDefault: "eu",
        options: null,
      },
      {
        name: "ADDRESSES",
        label: "addresses",
        required: false,
        kind: "json",
        shownDefault: '["a@example.com"]',
        options: null,
      },
      {
        name: "LIMITS",
        label: "limits",
        required: false,
        kind: "json",
        shownDefault: '{"max":5}',
        options: null,
      },
      {
        name: "PUBLIC_URL",
        label: "public_url",
        required: true,
        kind: "text",
        shownDefault: "{{workerUrl}}",
        options: null,
      },
    ]);
  });
});

describe("varValueProblem and missingRequiredVar", () => {
  const json: InstallVarField = {
    name: "ADDRESSES",
    label: "Addresses",
    required: true,
    kind: "json",
    shownDefault: "",
    options: null,
  };

  it("checks JSON only for JSON settings and leaves empty values to the required check", () => {
    expect(varValueProblem(json, '["{{workerName}}@example.com"]')).toBeNull();
    expect(varValueProblem(json, "")).toBeNull();
    expect(varValueProblem(json, "a@example.com")).toMatch(
      /^Addresses \(ADDRESSES\) is not valid JSON/,
    );
    expect(varValueProblem({ ...json, kind: "text" }, "a@example.com")).toBeNull();
    expect(missingRequiredVar(json, "  ")).toBe(true);
    expect(missingRequiredVar({ ...json, shownDefault: "[]" }, "")).toBe(false);
    expect(missingRequiredVar({ ...json, required: false }, "")).toBe(false);
  });
});

describe("resolveVars", () => {
  it("leaves {{workerUrl}} as written while the URL is unknown", () => {
    const m = manifest([{ type: "plain_text", name: "URL", text: "{{workerUrl}}/x" }], []);
    expect(resolveVars(m, {}, { workerUrl: null, workerName: "app" }).vars).toEqual([
      { type: "plain_text", name: "URL", text: "{{workerUrl}}/x" },
    ]);
  });
});

describe("varsUseWorkerUrl", () => {
  it("finds {{workerUrl}} in the wrangler config, a catalog default, or an entered value", () => {
    const own = manifest([{ type: "plain_text", name: "URL", text: "{{workerUrl}}/x" }], []);
    expect(varsUseWorkerUrl(own, {})).toBe(true);
    const json = manifest([{ type: "json", name: "CFG", json: { base: "{{workerUrl}}" } }], []);
    expect(varsUseWorkerUrl(json, {})).toBe(true);
    const byDefault = manifest([], [v("BASE", { default: "{{workerUrl}}" })]);
    expect(varsUseWorkerUrl(byDefault, {})).toBe(true);
    // The admin replaced the default with a fixed address.
    expect(varsUseWorkerUrl(byDefault, { BASE: "https://cut.example.com" })).toBe(false);
    const plain = manifest([], [v("BASE")]);
    expect(varsUseWorkerUrl(plain, {})).toBe(false);
    expect(varsUseWorkerUrl(plain, { BASE: "{{workerUrl}}/api" })).toBe(true);
  });

  it("does not count {{workerName}}", () => {
    const m = manifest([{ type: "plain_text", name: "NAME", text: "{{workerName}}" }], []);
    expect(varsUseWorkerUrl(m, {})).toBe(false);
  });
});

describe("select vars", () => {
  const options = [
    { value: "default", label: "Landing page" },
    { value: "404", label: "Not found" },
    { value: "admin", label: "Admin sign-in" },
  ];
  const home = (extra: Partial<CatalogVar> = {}) =>
    v("HOME_PAGE", { type: "select", options, ...extra });
  const placeholders = { workerUrl: null, workerName: "cut" };

  it("carry their choices, and start with the wrangler config's value only when it is one", () => {
    const fields = installVarFields(
      manifest(
        [
          { type: "plain_text", name: "HOME_PAGE", text: "admin" },
          { type: "plain_text", name: "OTHER", text: "home" },
        ],
        [home(), v("OTHER", { type: "select", options })],
      ),
    );
    expect(fields.map((f) => [f.shownDefault, f.options])).toEqual([
      ["admin", options],
      ["", options],
    ]);
    expect(installVarFields(manifest([], [home({ default: "404" })]))[0]?.shownDefault).toBe("404");
  });

  it("refuse a value that is not one of the choices", () => {
    const [field] = installVarFields(manifest([], [home({ required: true })]));
    if (field === undefined) throw new Error("no field");
    expect(varValueProblem(field, "404")).toBeNull();
    expect(varValueProblem(field, "home")).toBe(
      "home_page (HOME_PAGE) must be one of: Landing page, Not found, Admin sign-in.",
    );
    expect(varValueProblem(field, "")).toBeNull();
    expect(missingRequiredVar(field, "")).toBe(true);
  });

  it("send the stored choice, or the default when this version no longer offers it", () => {
    const m = manifest(
      [{ type: "plain_text", name: "HOME_PAGE", text: "default" }],
      [home({ default: "404" })],
    );
    expect(resolveVars(m, { HOME_PAGE: "admin" }, placeholders)).toEqual({
      vars: [{ type: "plain_text", name: "HOME_PAGE", text: "admin" }],
      warnings: [],
    });
    const gone = resolveVars(m, { HOME_PAGE: "home" }, placeholders);
    expect(gone.vars).toEqual([{ type: "plain_text", name: "HOME_PAGE", text: "404" }]);
    expect(gone.warnings).toEqual([
      "The stored value of HOME_PAGE is not one of the choices this version of the app offers; the Worker gets the catalog default instead.",
    ]);
  });

  it("send JSON choices as JSON", () => {
    const m = manifest(
      [{ type: "json", name: "OPEN", json: false }],
      [
        v("OPEN", {
          type: "select",
          options: [
            { value: "true", label: "Open" },
            { value: "false", label: "Closed" },
          ],
        }),
      ],
    );
    expect(resolveVars(m, { OPEN: "true" }, placeholders).vars).toEqual([
      { type: "json", name: "OPEN", json: true },
    ]);
  });
});
