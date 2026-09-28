import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "@fumadocs/base-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { useEffect } from "react";
import { trackWhenSettled } from "../analytics/analytics.ts";
import { searchIndexPath } from "../lib/shared.ts";

/**
 * Search that runs in the browser. The build writes the whole index to
 * `/api/search.json` as a static file; the dialog downloads it once, on first
 * use, so the site needs no server.
 */
export default function StaticSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({
    client: staticClient({ from: searchIndexPath }),
  });

  // What was searched for and how many pages it found, once the field rests.
  const text = search.trim();
  const pages = Array.isArray(query.data)
    ? query.data.filter((result) => result.type === "page").length
    : null;
  useEffect(() => {
    if (text === "" || pages === null || query.isLoading) return;
    return trackWhenSettled("docs_search", {
      query: text,
      query_length: text.length,
      result_count: pages,
    });
  }, [text, pages, query.isLoading]);

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
