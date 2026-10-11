// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackWhenSettled } from "../../analytics/analytics.ts";
import { testApp } from "../../catalog/test-app.ts";
import { type CatalogSearch, useCatalogSearch } from "./use-catalog-search.ts";

vi.mock("../../analytics/analytics.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../analytics/analytics.ts")>()),
  trackWhenSettled: vi.fn(() => () => {}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS = [
  testApp({ slug: "aimail", name: "AI Mail", pitch: "Email with an assistant" }),
  testApp({ slug: "aigateway", name: "AI Gateway", pitch: "One address for every model" }),
  testApp({ slug: "cut", name: "Cut", pitch: "Short links" }),
];

let container: HTMLDivElement;
let root: Root;
let search: CatalogSearch;
const writeAddress = vi.fn();

function Probe({ fromAddress }: { fromAddress: string | undefined }) {
  search = useCatalogSearch(APPS, fromAddress, writeAddress);
  return null;
}

async function arrive(fromAddress: string | undefined) {
  await act(async () => root.render(<Probe fromAddress={fromAddress} />));
}

async function type(text: string) {
  await act(async () => search.change(text));
}

const counted = () => vi.mocked(trackWhenSettled).mock.calls;

beforeEach(() => {
  vi.mocked(trackWhenSettled).mockClear();
  writeAddress.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the apps page's search", () => {
  it("puts the search in the address back in the field, without counting it again", async () => {
    // Back to /apps/?q=AI, as one visitor did ten times.
    await arrive("AI");
    expect(search.text).toBe("AI");
    expect(search.results?.map((app) => app.slug)).toEqual(["aigateway", "aimail"]);
    expect(counted()).toEqual([]);
    expect(writeAddress).not.toHaveBeenCalled();
  });

  it("counts what the visitor types, and keeps the address in step", async () => {
    await arrive(undefined);
    expect(search.results).toBeNull();
    await type("cut");
    expect(writeAddress).toHaveBeenLastCalledWith("cut");
    expect(counted().at(-1)).toEqual([
      "catalog_search",
      { query: "cut", query_length: 3, result_count: 1 },
    ]);
  });

  it("counts a search typed after one the address brought back", async () => {
    await arrive("AI");
    await type("AI Mail");
    expect(counted()).toEqual([
      ["catalog_search", { query: "AI Mail", query_length: 7, result_count: 1 }],
    ]);
  });

  it("counts nothing for an emptied field", async () => {
    await arrive(undefined);
    await type("");
    expect(search.results).toBeNull();
    expect(counted()).toEqual([]);
    expect(writeAddress).toHaveBeenLastCalledWith("");
  });

  it("says when nothing matches, for the page to offer asking for the app", async () => {
    await arrive(undefined);
    await type("karakeep");
    expect(search.results).toEqual([]);
    expect(search.query).toBe("karakeep");
    expect(counted().at(-1)?.[1]).toMatchObject({ result_count: 0 });
  });

  it("hands the page the same change function on every render", async () => {
    await arrive(undefined);
    const first = search.change;
    await type("c");
    expect(search.change).toBe(first);
  });
});
