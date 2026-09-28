import { categoryLabel } from "@appflare/schema/catalog-display";
import { Button, cn, LayerCard, Text } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { COLLAPSED_CATEGORIES } from "../catalog/storefront";
import { CategoryIcon } from "./category-icon";

/**
 * The catalog's categories as cards (icon, name, number of apps), the
 * biggest first. A card filters the page to its category and a second click
 * clears it; the selected card is tinted blue. The first twelve show until
 * "Show all N categories", or all of them when the selected one is further
 * down the list.
 */

function CategoryCard({
  id,
  count,
  selected,
  onToggle,
}: {
  id: string;
  count: number;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <LayerCard
      render={<button type="button" />}
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "flex h-full w-full min-w-0 cursor-pointer flex-row items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand",
        selected && "bg-kumo-info-tint hover:bg-kumo-info-tint",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          // `--color-kumo-brand` is the accent blue of primary buttons; the
          // `text-kumo-brand` utility is the orange of the logo.
          selected ? "bg-kumo-base text-(--color-kumo-brand)" : "bg-kumo-recessed text-kumo-strong",
        )}
      >
        <CategoryIcon category={id} size={20} />
      </span>
      <span className="grid min-w-0 flex-1">
        <Text as="span" bold truncate>
          {categoryLabel(id)}
        </Text>
        <Text as="span" variant="secondary" size="xs">
          {count} {count === 1 ? "app" : "apps"}
        </Text>
      </span>
    </LayerCard>
  );
}

export function CategoryCards({
  categories,
  selected,
  onSelect,
}: {
  /** Every category with its number of apps, the biggest first. */
  categories: ReadonlyArray<{ id: string; count: number }>;
  selected: string | undefined;
  /** The category to filter by; undefined clears the filter. */
  onSelect: (category: string | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = categories.slice(0, COLLAPSED_CATEGORIES);
  const selectedHidden = selected !== undefined && !collapsed.some((c) => c.id === selected);
  const shown = expanded || selectedHidden ? categories : collapsed;
  if (categories.length === 0) return null;
  return (
    <section aria-label="Categories" className="grid grid-cols-1 gap-2">
      <ul
        // biome-ignore lint/a11y/noRedundantRoles: list styles are removed, and Safari then drops the list role
        role="list"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6"
      >
        {shown.map(({ id, count }) => (
          <li key={id} className="min-w-0">
            <CategoryCard
              id={id}
              count={count}
              selected={selected === id}
              onToggle={() => onSelect(selected === id ? undefined : id)}
            />
          </li>
        ))}
      </ul>
      {categories.length > COLLAPSED_CATEGORIES && !selectedHidden && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon={expanded ? CaretUpIcon : CaretDownIcon}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Show fewer categories" : `Show all ${categories.length} categories`}
          </Button>
        </div>
      )}
    </section>
  );
}
