import { Badge, Button, DropdownMenu, InputGroup } from "@cloudflare/kumo";
import { FunnelIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { BrowseQuery } from "../catalog/browse";
import { LICENSE_FILTERS, type LicenseFilter } from "../catalog/license";
import type { CatalogSource } from "../catalog/sources";
import { type FilterPill, PLAN_WORDS, removePill } from "../catalog/storefront";
import { Tooltip } from "./tooltip";

/**
 * The catalog's search field: the words typed search as they are typed, and
 * the active filters sit in the field as removable pills ("Category:
 * Email"), each with its own ×; Backspace at the start of the field removes
 * the last one. One × at the end clears the words and every filter. A funnel
 * menu adds the plan, license, installed and (with several catalogs) catalog
 * filters.
 */

/** A query patch; `undefined` removes a key. */
type Patch = Partial<BrowseQuery>;

const ANY = "any";

/**
 * The search box's text: the URL's `q`, so back and forward bring the words
 * back, and while someone types, their own draft (every keystroke replaces
 * `q`, and a navigation still in flight must not overwrite newer letters).
 * A `q` the box did not write itself (back, forward, the clear control)
 * drops the draft.
 */
export function useSearchText(
  q: string | undefined,
  write: (q: string | undefined) => void,
): [string, (text: string) => void] {
  const [draft, setDraft] = useState<string | null>(null);
  // Values the box wrote that the URL has not reached yet, and the newest one.
  const inFlight = useRef(new Set<string>());
  const latest = useRef<string | null>(null);
  useEffect(() => {
    const current = q ?? "";
    if (current === latest.current) {
      inFlight.current.clear();
      latest.current = null;
      return;
    }
    if (inFlight.current.has(current)) return;
    inFlight.current.clear();
    latest.current = null;
    setDraft(null);
  }, [q]);
  function type(text: string) {
    const next = text.trim() === "" ? undefined : text;
    inFlight.current.add(next ?? "");
    latest.current = next ?? "";
    setDraft(text);
    write(next);
  }
  return [draft ?? q ?? "", type];
}

/**
 * The pills. `InputGroup.Addon` hands its icon size to every child, so this
 * accepts (and ignores) a `size` prop.
 */
function Pills({
  pills,
  onRemove,
}: {
  pills: readonly FilterPill[];
  onRemove: (pill: FilterPill) => void;
  size?: number;
}) {
  if (pills.length === 0) return null;
  return (
    <ul
      // biome-ignore lint/a11y/noRedundantRoles: list styles are removed, and Safari then drops the list role
      role="list"
      aria-label="Active filters"
      // Many pills scroll sideways inside the field rather than squeeze out the words.
      className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {pills.map((pill) => (
        <li key={pill.key}>
          <Badge variant="secondary" className="h-6 gap-0.5 whitespace-nowrap py-0 pr-0.5 text-sm">
            {pill.label}
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={<XIcon size={12} />}
              aria-label={`Remove ${pill.label}`}
              className="size-5 rounded-full"
              onClick={() => onRemove(pill)}
            />
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** The funnel menu; also accepts the Addon's `size`. */
function FilterMenu({
  query,
  sources,
  onChange,
}: {
  query: BrowseQuery;
  /** Every enabled catalog; the catalog filter shows only when there are several. */
  sources: readonly CatalogSource[];
  onChange: (patch: Patch) => void;
  size?: number;
}) {
  return (
    <DropdownMenu>
      <Tooltip
        content="Filter by plan, license or installed"
        render={
          <DropdownMenu.Trigger
            render={<InputGroup.Button shape="square" icon={FunnelIcon} aria-label="Filters" />}
          />
        }
      />
      <DropdownMenu.Content align="end" className="min-w-56">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Plan</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={query.plan ?? ANY}
            onValueChange={(value: unknown) =>
              onChange({ plan: value === "free" || value === "paid" ? value : undefined })
            }
          >
            <DropdownMenu.RadioItem value={ANY}>
              Any plan
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
            {(["free", "paid"] as const).map((plan) => (
              <DropdownMenu.RadioItem key={plan} value={plan}>
                {PLAN_WORDS[plan].word}
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>License</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={query.license ?? ANY}
            onValueChange={(value: unknown) =>
              onChange({
                license:
                  typeof value === "string" && value in LICENSE_FILTERS
                    ? (value as LicenseFilter)
                    : undefined,
              })
            }
          >
            <DropdownMenu.RadioItem value={ANY}>
              Any license
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
            {(Object.keys(LICENSE_FILTERS) as LicenseFilter[]).map((license) => (
              <DropdownMenu.RadioItem key={license} value={license}>
                {LICENSE_FILTERS[license]}
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
        {sources.length > 1 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.Label>Catalog</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={query.source ?? ANY}
                onValueChange={(value: unknown) =>
                  onChange({
                    source: typeof value === "string" && value !== ANY ? value : undefined,
                  })
                }
              >
                <DropdownMenu.RadioItem value={ANY}>
                  Every catalog
                  <DropdownMenu.RadioItemIndicator />
                </DropdownMenu.RadioItem>
                {sources.map((source) => (
                  <DropdownMenu.RadioItem key={source.id} value={source.id}>
                    {source.label}
                    <DropdownMenu.RadioItemIndicator />
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>
          </>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.CheckboxItem
          checked={query.installed !== undefined}
          onCheckedChange={(checked) => onChange({ installed: checked ? 1 : undefined })}
        >
          Installed only
        </DropdownMenu.CheckboxItem>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

export function CatalogSearch({
  text,
  onText,
  query,
  pills,
  sources,
  onChange,
  onClear,
}: {
  /** The words in the field. */
  text: string;
  onText: (text: string) => void;
  query: BrowseQuery;
  pills: readonly FilterPill[];
  sources: readonly CatalogSource[];
  onChange: (patch: Patch) => void;
  /** Clears the words and every filter. */
  onClear: () => void;
}) {
  const last = pills.at(-1);
  const clearLabel = pills.length > 0 ? "Clear search and filters" : "Clear search";
  return (
    <InputGroup size="lg" className="w-full">
      <InputGroup.Addon className="min-w-0 max-w-[65%] shrink">
        <MagnifyingGlassIcon className="shrink-0" />
        <Pills pills={pills} onRemove={(pill) => onChange(removePill(pill))} />
      </InputGroup.Addon>
      <InputGroup.Input
        // Not `type="search"`: the browser's own clear button would sit next to this one.
        type="text"
        enterKeyHint="search"
        autoComplete="off"
        value={text}
        placeholder={pills.length === 0 ? "Search apps by name, purpose or author" : "Search"}
        aria-label="Search apps"
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          const field = e.currentTarget;
          if (
            e.key === "Backspace" &&
            last !== undefined &&
            field.selectionStart === 0 &&
            field.selectionEnd === 0
          ) {
            e.preventDefault();
            onChange(removePill(last));
          }
        }}
      />
      <InputGroup.Addon align="end">
        {(text !== "" || pills.length > 0) && (
          <InputGroup.Button
            shape="square"
            icon={XIcon}
            tooltip={clearLabel}
            aria-label={clearLabel}
            onClick={onClear}
          />
        )}
        <FilterMenu query={query} sources={sources} onChange={onChange} />
      </InputGroup.Addon>
    </InputGroup>
  );
}
