import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { trackWhenSettled } from "../../analytics/analytics.ts";
import type { SiteApp } from "../../catalog/site-catalog.ts";
import { searchApps } from "../../catalog/storefront.ts";

export interface CatalogSearch {
  /** What the search field holds. */
  text: string;
  /** The search the results are for: {@link CatalogSearch.text}, a moment later while typing. */
  query: string;
  /** The apps that match {@link CatalogSearch.query}, or null when there is no search. */
  results: SiteApp[] | null;
  /** What the visitor typed into the field (or a button put there). The same function on every render. */
  change: (text: string) => void;
}

/**
 * The search on the apps page. The page is prerendered without a search, so
 * the one in the address (`fromAddress`, `?q=`) is put in the field once
 * the page runs in the browser; after that the field leads and
 * `writeAddress` keeps the address in step.
 *
 * The results follow the field a moment later (React's deferred value), so
 * a key press shows its letter at once and the list of apps redraws after.
 *
 * `catalog_search` counts the searches the visitor made here, once the field
 * rests. A search the address brought back, such as on returning to the
 * page with Back, was counted when it was typed.
 */
export function useCatalogSearch(
  apps: readonly SiteApp[],
  fromAddress: string | undefined,
  writeAddress: (text: string) => void,
): CatalogSearch {
  const [text, setText] = useState("");
  const typed = useRef(false);
  const write = useRef(writeAddress);
  write.current = writeAddress;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (fromAddress !== undefined) setText(fromAddress);
  }, []);

  const shown = useDeferredValue(text);
  const results = useMemo(
    () => (shown.trim() === "" ? null : searchApps(apps, shown)),
    [apps, shown],
  );
  const query = shown.trim();
  const resultCount = results?.length ?? null;
  useEffect(() => {
    if (resultCount === null || !typed.current) return;
    return trackWhenSettled("catalog_search", {
      query,
      query_length: query.length,
      result_count: resultCount,
    });
  }, [query, resultCount]);

  const change = useCallback((value: string) => {
    typed.current = true;
    setText(value);
    write.current(value);
  }, []);
  return { text, query: shown, results, change };
}
