import { Badge, Banner, Button, LayerDialog, Link, Text } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { TokenStatus } from "../server/token.functions";
import { appflareDevLink } from "./appflare-dev-link";
import { CloudflareTokenForm, type SavedToken } from "./cloudflare-token-form";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { Section, SectionBody } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The account settings' Cloudflare connection: the account and Worker the
 * manager runs as, the token's state, (admins) rotating the token, and a
 * quiet link that makes appflare.dev's Install buttons open this manager.
 */
export function CloudflareTokenCard({
  status,
  canRotate,
  managerUrl,
}: {
  status: TokenStatus;
  canRotate: boolean;
  /** The address this browser uses for this manager, for the appflare.dev link; none, no link. */
  managerUrl?: string | null;
}) {
  const appflareDev = appflareDevLink(managerUrl);
  return (
    <Section
      {...settingsSection("account", "connection")}
      titleAction={<DocsLink topic="tokenPermissions" />}
      badge={
        status.hasSecret ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="warning">Waiting for redeploy</Badge>
        )
      }
      description="The Cloudflare account Appflare manages, and the API token it uses there."
      action={canRotate ? <RotateTokenDialog /> : null}
    >
      <SectionBody>
        <DescriptionList>
          <DescriptionItem label="Account">{status.accountName ?? "Unknown"}</DescriptionItem>
          <DescriptionItem label="Account ID">
            <Text variant="mono" as="span">
              {status.accountId ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Worker">
            <Text variant="mono" as="span">
              {status.workerName ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Last verified">
            <Timestamp iso={status.verifiedAt} fallback="Never" />
          </DescriptionItem>
          <DescriptionItem label="Secret binding">
            {status.hasSecret
              ? "CF_API_TOKEN is bound to the running version."
              : "The token is saved; the running version does not have it yet."}
          </DescriptionItem>
        </DescriptionList>
        {appflareDev !== null && (
          <div className="grid gap-0.5">
            <Text size="sm" as="p">
              <Link href={appflareDev} target="_blank" rel="noreferrer">
                Use this Appflare on appflare.dev
                <ArrowSquareOutIcon className="ml-1 inline" aria-hidden />
              </Link>
            </Text>
            <Text variant="secondary" size="sm" as="p">
              Remembers this Appflare in your browser so Install buttons on appflare.dev open here.
            </Text>
          </div>
        )}
      </SectionBody>
    </Section>
  );
}

/** Verify and store a replacement token on the same account and Worker. */
function RotateTokenDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedToken | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSaved(null);
  }

  async function onSaved(result: SavedToken) {
    setSaved(result);
    await router.invalidate();
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<ArrowsClockwiseIcon />}>
            Rotate token
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Rotate Cloudflare token</LayerDialog.Title>
        <LayerDialog.Description>
          The new token must be for the same account. It replaces the stored one; revoke the old
          token in the Cloudflare dashboard afterwards.
        </LayerDialog.Description>
        <LayerDialog.Body>
          {saved === null ? (
            <CloudflareTokenForm mode="rotate" onSaved={onSaved} />
          ) : (
            <Banner
              icon={<CheckCircleIcon weight="fill" />}
              title="Token rotated"
              description={`The new token is stored on "${saved.workerName}". Appflare redeploys itself to pick it up.`}
            />
          )}
        </LayerDialog.Body>
        {saved !== null && (
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary onClick={() => onOpenChange(false)}>
              Done
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
