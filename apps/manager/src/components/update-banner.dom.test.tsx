import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";
import type { UpdateNeeds } from "../installs/versions.server";
import { secretsOf } from "../test/artifact-fixture";

const calls = vi.hoisted(() => ({
  startUpdate: vi.fn(),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("../installs/versions.functions", () => ({ startUpdate: calls.startUpdate }));
vi.mock("./job-started", () => ({ useJobStarted: () => calls.jobStarted }));

const { UpdateBanner, useStartUpdate } = await import("./update-banner");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASSWORD = "db-pass-DO-NOT-LEAK";

/** A version that adds a database elsewhere and a stream whose sink token the Worker has. */
const NEEDS: UpdateNeeds = {
  version: "1.1.0",
  needsSecrets: secretsOf([{ name: "CATALOG_TOKEN", label: "R2 API token" }]),
  heldSecrets: ["CATALOG_TOKEN"],
  streamTokens: ["CATALOG_TOKEN"],
  needsDatabases: [{ binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" }],
  skipsPreview: null,
  build: null,
  cronTriggers: null,
};

function Harness() {
  const update = useStartUpdate();
  return (
    <>
      <button type="button" onClick={() => update.start({ id: "i1", label: "Feedlog" })}>
        Start
      </button>
      {update.dialog}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.startUpdate.mockReset();
  calls.jobStarted.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function openDialog(needs: UpdateNeeds = NEEDS) {
  calls.startUpdate.mockResolvedValueOnce(needs);
  act(() => root.render(<Harness />));
  const start = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start");
  await act(async () => start?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

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

function updateButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent === "Update",
  );
  if (button === undefined) throw new Error("no Update button");
  return button;
}

describe("the update dialog of a version that adds a database and a stream", () => {
  it("asks for the connection string and the sink token again, and says why", async () => {
    await openDialog();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Update Feedlog to 1.1.0");
    expect(text).toContain("Databases");
    expect(text).toContain("Appflare never stores the connection string.");
    expect(text).toContain("Cloudflare keeps this token as the credential its event stream");
    expect(text).toContain("The app already has this secret.");
    expect(inputOf("Main database").value).toBe("");
    expect(inputOf("R2 API token").value).toBe("");
  });

  it("starts only with a usable connection string and the token, and sends both", async () => {
    await openDialog();
    expect(updateButton().disabled).toBe(true);
    type(inputOf("R2 API token"), "r2-token");
    type(inputOf("Main database"), `mysql://app:${PASSWORD}@db.example.com/app`);
    expect(updateButton().disabled).toBe(true);
    expect(document.body.textContent).not.toContain(PASSWORD.slice(0, 7));
    const connection = `postgres://app:${PASSWORD}@db.example.com:5432/app`;
    type(inputOf("Main database"), connection);
    expect(updateButton().disabled).toBe(false);
    calls.startUpdate.mockResolvedValueOnce({ jobId: "job1" });
    const form = document.body.querySelector("form");
    await act(async () => form?.requestSubmit());
    expect(calls.startUpdate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        installId: "i1",
        secrets: { CATALOG_TOKEN: "r2-token" },
        hyperdrive: { HYPERDRIVE: connection },
      }),
    });
    expect(calls.jobStarted).toHaveBeenCalledWith("job1", "Update started");
  });
});

describe("the update dialog of a version that also changes the app's email", () => {
  const EMAIL_NOTE =
    "Version 1.1.0 changes the email the app receives: mail to alerts@example.com starts reaching the app.";

  it("shows the email change and the database field, and sends both with the update", async () => {
    await openDialog({
      ...NEEDS,
      needsSecrets: [],
      heldSecrets: [],
      streamTokens: [],
      emailRouting: EMAIL_NOTE,
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Email changes with this version");
    expect(text).toContain(EMAIL_NOTE);
    expect(text).toContain("Databases");
    // The email change is seen, but the database still needs its connection string.
    expect(updateButton().disabled).toBe(true);
    const connection = `postgres://app:${PASSWORD}@db.example.com:5432/app`;
    type(inputOf("Main database"), connection);
    expect(updateButton().disabled).toBe(false);
    calls.startUpdate.mockResolvedValueOnce({ jobId: "job1" });
    await act(async () => document.body.querySelector("form")?.requestSubmit());
    expect(calls.startUpdate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        hyperdrive: { HYPERDRIVE: connection },
        confirmEmailRouting: "1.1.0",
      }),
    });
  });
});

describe("the update dialog while the update starts", () => {
  it("lets nothing be changed until the answer comes", async () => {
    await openDialog();
    type(inputOf("R2 API token"), "r2-token");
    type(inputOf("Main database"), `postgres://app:${PASSWORD}@db.example.com:5432/app`);
    let answer: (value: { jobId: string }) => void = () => {};
    calls.startUpdate.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => document.body.querySelector("form")?.requestSubmit());
    expect(inputOf("Main database").disabled).toBe(true);
    expect(inputOf("R2 API token").disabled).toBe(true);
    await act(async () => answer({ jobId: "job1" }));
    expect(calls.jobStarted).toHaveBeenCalledWith("job1", "Update started");
  });
});

describe("the update dialog of a version whose database an earlier update connected", () => {
  const REPLACING: UpdateNeeds = {
    version: "1.1.0",
    needsSecrets: [],
    replaceableDatabases: [{ binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" }],
    skipsPreview: null,
    build: null,
    cronTriggers: null,
  };

  it("offers to replace its connection string, and keeps it when the field stays empty", async () => {
    await openDialog(REPLACING);
    // Pressing Update asks for the optional choices too.
    expect(calls.startUpdate).toHaveBeenNthCalledWith(1, {
      data: { installId: "i1", offerChoices: true },
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Databases already connected");
    expect(text).toContain("Leave a field empty to keep that connection");
    expect(inputOf("Main database").required).toBe(false);
    expect(updateButton().disabled).toBe(false);
    calls.startUpdate.mockResolvedValueOnce({ jobId: "job1" });
    await act(async () => document.body.querySelector("form")?.requestSubmit());
    expect(calls.startUpdate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ installId: "i1", hyperdrive: {} }),
    });
  });

  it("sends a usable connection string, which replaces the connection", async () => {
    await openDialog(REPLACING);
    type(inputOf("Main database"), "postgres://nope");
    expect(updateButton().disabled).toBe(true);
    const connection = `postgres://app:${PASSWORD}@db.example.com:5432/app`;
    type(inputOf("Main database"), connection);
    expect(updateButton().disabled).toBe(false);
    calls.startUpdate.mockResolvedValueOnce({ jobId: "job1" });
    await act(async () => document.body.querySelector("form")?.requestSubmit());
    expect(calls.startUpdate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ hyperdrive: { HYPERDRIVE: connection } }),
    });
  });
});

describe("the banner while an update runs", () => {
  it("shows the moving mark as decoration, with the link to the log", () => {
    const install = {
      id: "i1",
      status: "updating",
      activeJobId: "job1",
      jobs: [{ id: "job1", kind: "update" }],
      build: { kind: "artifact", image: null, builtAt: null, installer: null, stage: null },
    } as Partial<InstallDetail> as InstallDetail;
    act(() => root.render(<UpdateBanner install={install} isAdmin />));
    expect(container.textContent).toContain("Updating");
    expect(container.querySelector('a[href="/jobs/job1"]')?.textContent).toContain("View log");
    // The banner says what runs; the mark in it is not a second "Loading" status.
    expect(container.querySelector("svg")?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
