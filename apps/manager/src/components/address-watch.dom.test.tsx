import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressStatus } from "../domains/address-watch";

/** A page open at workers.dev while Appflare waits to move, with the read standing in. */
const status = vi.hoisted(() => ({
  answers: [] as AddressStatus[],
  calls: 0,
}));
vi.mock("../domains/address-status.functions", () => ({
  getAddressStatus: async () => {
    status.calls++;
    return status.answers.shift() ?? { hostname: null, pending: true };
  },
}));

const { AddressWatch } = await import("./address-watch");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = "appflare.ada.workers.dev";
const HOST = "appflare.example.com";

let container: HTMLDivElement;
let root: Root;
let assign: ReturnType<typeof vi.fn>;

function at(host: string) {
  assign = vi.fn();
  vi.stubGlobal("location", {
    ...window.location,
    host,
    pathname: "/settings/domains",
    search: "?x=1",
    hash: "#address",
    assign,
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  status.answers = [];
  status.calls = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function after15s() {
  await act(async () => vi.advanceTimersByTime(15_000));
  await flush();
}

describe("a page left open at workers.dev", () => {
  it("asks every 15 seconds, then says Appflare moved and goes to the same page there", async () => {
    at(DEV);
    status.answers = [
      { hostname: null, pending: true },
      { hostname: null, pending: true },
      { hostname: HOST, pending: false },
    ];
    act(() => root.render(<AddressWatch />));
    await flush();
    expect(status.calls).toBe(1);
    await after15s();
    expect(status.calls).toBe(2);
    expect(assign).not.toHaveBeenCalled();
    await after15s();
    expect(container.textContent).toContain(`Appflare moved to ${HOST}.`);
    expect(assign).toHaveBeenCalledWith(`https://${HOST}/settings/domains?x=1#address`);
    // And asks no more.
    await after15s();
    expect(status.calls).toBe(3);
  });

  it("does not leave a form with unsaved input: it offers to open the new address", async () => {
    at(DEV);
    status.answers = [
      { hostname: null, pending: true },
      { hostname: HOST, pending: false },
    ];
    const form = document.createElement("form");
    const input = document.createElement("input");
    form.appendChild(input);
    document.body.appendChild(form);
    act(() => root.render(<AddressWatch />));
    await flush();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await after15s();
    expect(assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`Appflare moved to ${HOST}.`);
    const open = container.querySelector("a");
    expect(open?.textContent).toBe(`Open ${HOST}`);
    expect(open?.getAttribute("href")).toBe(`https://${HOST}/settings/domains?x=1#address`);
    form.remove();
  });

  it("stops asking when nothing is pending", async () => {
    at(DEV);
    status.answers = [{ hostname: null, pending: false }];
    act(() => root.render(<AddressWatch />));
    await flush();
    await after15s();
    await after15s();
    expect(status.calls).toBe(1);
    expect(container.textContent).toBe("");
  });

  it("asks nothing at any other address", async () => {
    at(HOST);
    act(() => root.render(<AddressWatch />));
    await flush();
    await after15s();
    expect(status.calls).toBe(0);
  });
});
