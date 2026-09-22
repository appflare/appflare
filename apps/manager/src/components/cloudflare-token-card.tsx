import { Badge, Banner, Button, Dialog, LayerCard, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, CheckCircleIcon, XIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { TokenStatus } from "../server/token.functions";
import { CloudflareTokenForm, type SavedToken } from "./cloudflare-token-form";

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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
        <span>Cloudflare API token</span>
        {status.hasSecret ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="warning">Waiting for redeploy</Badge>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <Row label="Account">{status.accountName ?? "Unknown"}</Row>
          <Row label="Account ID">
            <Text variant="mono" as="span">
              {status.accountId ?? "Unknown"}
            </Text>
          </Row>
          <Row label="Worker">
            <Text variant="mono" as="span">
              {status.workerName ?? "Unknown"}
            </Text>
          </Row>
          <Row label="Last verified">
            {status.verifiedAt ? dateTimeFormat.format(new Date(status.verifiedAt)) : "Never"}
          </Row>
          <Row label="Secret binding">
            {status.hasSecret
              ? "CF_API_TOKEN is bound to the running version."
              : "The token is saved; the running version does not have it yet."}
          </Row>
        </dl>
        {canRotate && (
          <div className="flex justify-end">
            <RotateTokenDialog />
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text as="dt" variant="secondary">
        {label}
      </Text>
      <Text as="dd">{children}</Text>
    </>
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<ArrowsClockwiseIcon />}>
            Rotate token
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">Rotate Cloudflare token</Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              The new token must be for the same account. It replaces the stored one; revoke the old
              token in the Cloudflare dashboard afterwards.
            </Dialog.Description>
          </div>
          <Dialog.Close
            aria-label="Close"
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                shape="square"
                icon={<XIcon />}
                aria-label="Close"
              />
            )}
          />
        </div>
        {saved === null ? (
          <CloudflareTokenForm mode="rotate" onSaved={onSaved} />
        ) : (
          <div className="grid gap-4">
            <Banner
              icon={<CheckCircleIcon weight="fill" />}
              title="Token rotated"
              description={`The new token is stored on "${saved.workerName}". Appflare redeploys itself to pick it up.`}
            />
            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary">
                    Done
                  </Button>
                )}
              />
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
