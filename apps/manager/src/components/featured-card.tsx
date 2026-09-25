import { Badge, Button, LayerCard, Link, LinkButton, Popover, Text } from "@cloudflare/kumo";
import { ArrowRightIcon, InfoIcon, XIcon } from "@phosphor-icons/react";
import { dismissFeatured } from "../catalog/catalog.functions";
import { type FeaturedCard as FeaturedCardData, safeExternalUrl } from "../catalog/featured";
import { AppCover } from "./catalog-media";
import { Tooltip } from "./tooltip";
import { useOptimisticDismiss } from "./use-optimistic-dismiss";

/**
 * The catalog's sponsored item. The "Sponsored" label and the disclosure
 * text live here, not in the index, so no catalog can remove them. Links
 * carry `noreferrer`, so the sponsor never learns this manager's hostname,
 * and nothing is ever appended to them. Hide takes it away at once and
 * saves that for this user in the background.
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
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant="neutral">Sponsored</Badge>
          <span className="truncate">{item.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
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
                  ? `${DISCLOSURE} This app is in the catalog and was checked like every other app; being sponsored changes nothing else.`
                  : `${DISCLOSURE} Appflare has not checked what this links to.`}
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
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="grid content-start gap-1.5">
          <Text variant="secondary" size="sm">
            Sponsored by{" "}
            {sponsorUrl === null ? (
              item.sponsorName
            ) : (
              <Link href={sponsorUrl} target="_blank" rel={SPONSORED_REL}>
                {item.sponsorName}
                <Link.ExternalIcon />
              </Link>
            )}
          </Text>
          <Text>{item.text}</Text>
          <div className="mt-2 flex flex-wrap gap-2">
            {item.app !== null && (
              <LinkButton
                href={`/catalog/${item.app.slug}`}
                variant="secondary"
                icon={<ArrowRightIcon />}
              >
                View {item.app.name}
              </LinkButton>
            )}
            {link !== null && item.link !== null && (
              <LinkButton href={link} target="_blank" rel={SPONSORED_REL} variant="secondary">
                {item.link.label}
              </LinkButton>
            )}
          </div>
        </div>
        {item.image !== null && <AppCover src={item.image.src} alt={item.image.alt} />}
      </LayerCard.Primary>
    </LayerCard>
  );
}
