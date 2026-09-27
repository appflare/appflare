import { Badge, Button, Link, LinkButton, Popover, Text } from "@cloudflare/kumo";
import { InfoIcon, XIcon } from "@phosphor-icons/react";
import { dismissFeatured } from "../catalog/catalog.functions";
import { type FeaturedCard as FeaturedCardData, safeExternalUrl } from "../catalog/featured";
import { AppCover } from "./catalog-media";
import { Tooltip } from "./tooltip";
import { useOptimisticDismiss } from "./use-optimistic-dismiss";

/**
 * The catalog's sponsored item, as one quiet line among the rows. The
 * "Sponsored" label and the disclosure text live here, not in the index, so
 * no catalog can remove them. Links carry `noreferrer`, so the sponsor never
 * learns this manager's hostname, and nothing is ever appended to them. Hide
 * takes it away at once and saves that for this user in the background.
 */

const DISCLOSURE = "Sponsors pay for this spot, which helps fund Appflare.";

/** `rel` for every link to sponsor content. */
const SPONSORED_REL = "sponsored noopener noreferrer";

export function FeaturedCard({ item }: { item: FeaturedCardData }) {
  const { hidden, dismiss } = useOptimisticDismiss(() =>
    dismissFeatured({ data: { itemId: item.id } }),
  );
  if (hidden) return null;
  const link = item.link === null ? null : safeExternalUrl(item.link.url);
  const sponsorUrl = safeExternalUrl(item.sponsorUrl);

  return (
    <aside
      aria-label="Sponsored"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 ring ring-kumo-hairline"
    >
      {item.image !== null && (
        <div className="w-20 shrink-0 max-sm:hidden">
          <AppCover src={item.image.src} alt={item.image.alt} />
        </div>
      )}
      <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant="neutral">Sponsored</Badge>
          <Text as="span" bold truncate>
            {item.title}
          </Text>
        </span>
        <Text as="span" variant="secondary" size="sm">
          {item.text}{" "}
          <span className="whitespace-nowrap">
            By{" "}
            {sponsorUrl === null ? (
              item.sponsorName
            ) : (
              <Link href={sponsorUrl} target="_blank" rel={SPONSORED_REL}>
                {item.sponsorName}
                <Link.ExternalIcon />
              </Link>
            )}
          </span>
        </Text>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.app !== null && (
          <LinkButton href={`/catalog/${item.app.slug}`} size="sm" variant="secondary">
            View {item.app.name}
          </LinkButton>
        )}
        {link !== null && item.link !== null && (
          <LinkButton href={link} target="_blank" rel={SPONSORED_REL} size="sm" variant="secondary">
            {item.link.label}
          </LinkButton>
        )}
        <Popover>
          <Popover.Trigger
            render={
              <Button
                shape="square"
                size="sm"
                variant="ghost"
                icon={InfoIcon}
                aria-label="About sponsored items"
              />
            }
          />
          <Popover.Content>
            <Popover.Title>Sponsored</Popover.Title>
            <Popover.Description>
              {item.app !== null
                ? `${DISCLOSURE} This app is in the catalog and was tested like every other app; being sponsored changes nothing else.`
                : `${DISCLOSURE} Appflare has not reviewed what this links to.`}
            </Popover.Description>
          </Popover.Content>
        </Popover>
        <Tooltip
          content="Hide"
          render={
            <Button
              shape="square"
              size="sm"
              variant="ghost"
              icon={XIcon}
              aria-label="Hide this sponsored item"
              onClick={dismiss}
            />
          }
        />
      </div>
    </aside>
  );
}
