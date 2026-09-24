import { Badge, Banner, Button, LayerCard, LayerDialog, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { TokenStatus } from "../server/token.functions";
import { CloudflareTokenForm, type SavedToken } from "./cloudflare-token-form";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { Timestamp } from "./timestamp";

/** Settings, "Cloudflare token": what the manager is connected to, and rotation. */
export function CloudflareTokenCard({
  status,
  canRotate,
}: {
  status: TokenStatus;
  canRotate: boolean;
}) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1">
          Cloudflare API token
          <DocsLink topic="tokenPermissions" />
        </span>
        {status.hasSecret ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="warning">Waiting for redeploy</Badge>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
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
        {canRotate && (
          <div className="flex justify-end">
            <RotateTokenDialog />
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
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
