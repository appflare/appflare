import type { ArtifactManifest, CatalogVar, WorkerBinding } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  type InstallVarField,
  installVarFields,
  missingRequiredVar,
  resolveVars,
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
      },
      {
        name: "ADDRESSES",
        label: "addresses",
        required: false,
        kind: "json",
        shownDefault: '["a@example.com"]',
      },
      {
        name: "LIMITS",
        label: "limits",
        required: false,
        kind: "json",
        shownDefault: '{"max":5}',
      },
      {
        name: "PUBLIC_URL",
        label: "public_url",
        required: true,
        kind: "text",
        shownDefault: "{{workerUrl}}",
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
