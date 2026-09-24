import {
  Badge,
  Banner,
  Button,
  LayerCard,
  Link,
  LinkButton,
  Popover,
  Text,
  Tooltip,
} from "@cloudflare/kumo";
import { ArrowRightIcon, InfoIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { dismissFeatured } from "../catalog/catalog.functions";
import { type FeaturedCard as FeaturedCardData, safeExternalUrl } from "../catalog/featured";
import { AppCover } from "./catalog-media";

/**
 * The catalog's sponsored item. The "Sponsored" label and the disclosure
 * text live here, not in the index, so no catalog can remove them. Links
 * carry `noreferrer`, so the sponsor never learns this manager's hostname,
 * and nothing is ever appended to them.
 */

const DISCLOSURE = "Sponsors pay for this spot, which helps fund Appflare.";

/** `rel` for every link to sponsor content. */
const SPONSORED_REL = "sponsored noopener noreferrer";

export function FeaturedCard({ item }: { item: FeaturedCardData }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = item.link === null ? null : safeExternalUrl(item.link.url);
  const sponsorUrl = safeExternalUrl(item.sponsorUrl);

  async function onHide() {
    setPending(true);
    setError(null);
    try {
      await dismissFeatured({ data: { itemId: item.id } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not hide this item.");
      setPending(false);
    }
  }

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
                loading={pending}
                onClick={onHide}
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
          {error !== null && (
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
          )}
        </div>
        {item.image !== null && <AppCover src={item.image.src} alt={item.image.alt} />}
      </LayerCard.Primary>
    </LayerCard>
  );
}
