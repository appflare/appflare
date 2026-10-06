import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";
import type { SnapshotView } from "../installs/versions.server";

const calls = vi.hoisted(() => ({ restoreDatabase: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock("../installs/versions.functions", () => ({
  restoreDatabase: calls.restoreDatabase,
  startRollback: vi.fn(),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));

const { VersionsSection } = await import("./versions-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the section reads of an installed app with one D1 database. */
const INSTALL = {
  id: "i1",
  label: "Links for Ada",
  workerName: "cut-links",
  status: "installed",
  activeJobId: null,
  build: { kind: "artifact", image: null, builtAt: null, installer: null, stage: null },
  emailRoutes: [],
} as Partial<InstallDetail> as InstallDetail;

const SNAPSHOT: SnapshotView = {
  id: "s1",
  takenAt: "2026-10-05T09:00:00.000Z",
  fromVersionId: "v-before",
  toVersionId: "v-after",
  fromCatalogVersion: "1.1.0",
  toCatalogVersion: "1.2.0",
  jobId: "j1",
  jobStatus: "succeeded",
  jobKind: "update",
  isCurrent: false,
  sameCode: false,
  crossesDoMigration: false,
  lostDatabase: null,
  emailNote: null,
  databases: [{ resourceId: "r1", name: "cut-db", databaseId: "d1", bookmark: "bm-then" }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.restoreDatabase.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<VersionsSection install={INSTALL} snapshots={[SNAPSHOT]} isAdmin />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function button(name: string, within: HTMLElement = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

/** Types into an input the way React notices. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("restoring a database to a snapshot", () => {
  it("announces the result in a status region that was there before it landed", async () => {
    let finish: (value: unknown) => void = () => {};
    calls.restoreDatabase.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await act(async () => button("Restore cut-db to this point", container).click());
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    if (dialog === null) throw new Error("no dialog");
    const status = dialog.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");

    const input = dialog.querySelector("input");
    if (input === null) throw new Error("no confirmation field");
    type(input, "cut-db");
    await act(async () => button("Restore database", dialog).click());
    expect(calls.restoreDatabase).toHaveBeenCalledWith({
      data: { installId: "i1", snapshotId: "s1", databaseResourceId: "r1" },
    });
    await act(async () =>
      finish({
        jobId: "j2",
        databaseName: "cut-db",
        bookmark: "bm-then",
        previousBookmark: "bm-now",
      }),
    );

    // The same region, not a new one: its text changed while it stayed on the page.
    expect(dialog.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toContain("Restored cut-db");
    // The banner in it is not a second live region.
    expect(status?.querySelector('[role="status"]')).toBeNull();
    // The bookmark is shown, but not read out with the result.
    expect(status?.textContent).not.toContain("bm-now");
    expect(dialog.textContent).toContain("bm-now");
  });
});
