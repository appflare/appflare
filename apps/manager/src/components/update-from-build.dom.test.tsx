import type { CatalogManifest } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceBuildReview, SourceBuildView } from "../installs/source-builds.functions";
import { secretsOf } from "../test/artifact-fixture";

const calls = vi.hoisted(() => ({
  updateFromSourceBuild: vi.fn(),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("../installs/source-builds.functions", () => ({
  updateFromSourceBuild: calls.updateFromSourceBuild,
}));
vi.mock("./job-started", () => ({ useJobStarted: () => calls.jobStarted }));
// The update dialog's module, whose helpers the form shares, imports server functions.
vi.mock("../installs/versions.functions", () => ({ startUpdate: vi.fn() }));

const { UpdateFromBuild } = await import("./update-from-build");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTION = "postgres://app:db-pass@db.example.com:5432/app";

/** What the form reads of a build that updates Feedlog. */
const BUILD = { id: "build1", install: { label: "Feedlog" } } as Partial<SourceBuildView>;

/**
 * A rebuild that adds a database elsewhere and a stream whose sink token the
 * Worker has, and replaces nothing else; only the fields the form reads.
 */
const REVIEW = {
  catalog: { vars: [] } as Partial<CatalogManifest> as CatalogManifest,
  needsSecrets: secretsOf([{ name: "CATALOG_TOKEN", label: "R2 API token" }]),
  heldSecrets: ["CATALOG_TOKEN"],
  streamTokens: ["CATALOG_TOKEN"],
  needsDatabases: [{ binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" }],
  replaceableDatabases: [{ binding: "ANALYTICS", protocol: "mysql", label: "Analytics database" }],
  skipsPreview: null,
  emailRouting: null,
  emailRoutingKey: null,
} as Partial<SourceBuildReview>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.updateFromSourceBuild.mockReset();
  calls.jobStarted.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** Types into an input the way React notices. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function inputOf(label: string): HTMLInputElement {
  const found = [...document.body.querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field for ${label}`);
  return input;
}

describe("the update from a reviewed build while it starts", () => {
  it("lets no connection or secret field be changed until the answer comes", async () => {
    act(() =>
      root.render(
        <UpdateFromBuild
          build={BUILD as SourceBuildView}
          review={REVIEW as SourceBuildReview}
          canUpdate
        />,
      ),
    );
    const fields = ["R2 API token", "Main database", "Analytics database"];
    for (const label of fields) expect(inputOf(label).disabled).toBe(false);
    type(inputOf("R2 API token"), "r2-token");
    type(inputOf("Main database"), CONNECTION);
    let answer: (value: { jobId: string }) => void = () => {};
    calls.updateFromSourceBuild.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => container.querySelector("form")?.requestSubmit());
    expect(calls.updateFromSourceBuild).toHaveBeenCalledWith({
      data: {
        buildId: "build1",
        secrets: { CATALOG_TOKEN: "r2-token" },
        hyperdrive: { HYPERDRIVE: CONNECTION },
      },
    });
    for (const label of fields) expect(inputOf(label).disabled).toBe(true);
    await act(async () => answer({ jobId: "job1" }));
    expect(calls.jobStarted).toHaveBeenCalledWith("job1", "Update started");
  });

  it("gives the fields back when the update does not start", async () => {
    act(() =>
      root.render(
        <UpdateFromBuild
          build={BUILD as SourceBuildView}
          review={REVIEW as SourceBuildReview}
          canUpdate
        />,
      ),
    );
    type(inputOf("R2 API token"), "r2-token");
    type(inputOf("Main database"), CONNECTION);
    calls.updateFromSourceBuild.mockRejectedValueOnce(new Error("The build was thrown away."));
    await act(async () => container.querySelector("form")?.requestSubmit());
    expect(container.textContent).toContain("The build was thrown away.");
    expect(inputOf("Main database").disabled).toBe(false);
    expect(inputOf("R2 API token").disabled).toBe(false);
  });
});
