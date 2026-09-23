import { Badge, Banner, Button, Dialog, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  InfoIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  checkManagerUpdates,
  type ManagerUpdateState,
  startSelfUpdate,
} from "../catalog/manager-releases.functions";
import { formatDateTime } from "./format";

/**
 * Settings, "Appflare updates": the running version, the newest release the
 * release feed reported, "Check now", and "Update Appflare to <version>"
 * (admins). The update opens a confirmation, then the job's log.
 */
export function AppflareUpdatesCard({
  state,
  isAdmin,
}: {
  state: ManagerUpdateState;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onCheck() {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const next = await checkManagerUpdates();
      if (next.latest === null) setNotice("The release feed lists no Appflare release yet.");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for updates.");
    }
    setChecking(false);
  }

  const { latest } = state;
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>Appflare</span>
        {state.activeJobId !== null ? (
          <Badge variant="info">Updating</Badge>
        ) : state.updateAvailable ? (
          <Badge variant="warning">Update available</Badge>
        ) : latest !== null ? (
          <Badge variant="success">Up to date</Badge>
        ) : null}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <Row label="Running version">
            <Text variant="mono" as="span">
              {state.current}
            </Text>
          </Row>
          <Row label="Latest release">
            {latest === null ? (
              "None found yet"
            ) : (
              <>
                <Text variant="mono" as="span">
                  {latest.version}
                </Text>
                {latest.publishedAt !== null && (
                  <Text variant="secondary" as="span">
                    {" "}
                    published {formatDateTime(latest.publishedAt)}
                  </Text>
                )}
              </>
            )}
          </Row>
          <Row label="Last checked">{formatDateTime(state.checkedAt)}</Row>
        </dl>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        {notice !== null && (
          <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title={notice} />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {state.activeJobId !== null && (
            <LinkButton
              href={`/jobs/${state.activeJobId}`}
              variant="secondary"
              icon={<ArrowRightIcon />}
            >
              View update log
            </LinkButton>
          )}
          {isAdmin && (
            <Button
              variant="secondary"
              icon={<ArrowsClockwiseIcon />}
              loading={checking}
              onClick={onCheck}
            >
              Check now
            </Button>
          )}
          {isAdmin && state.updateAvailable && latest !== null && state.activeJobId === null && (
            <SelfUpdateDialog from={state.current} version={latest.version} />
          )}
        </div>
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

function SelfUpdateDialog({ from, version }: { from: string; version: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setPending(true);
    setError(null);
    try {
      const { jobId } = await startSelfUpdate({ data: { version } });
      await router.navigate({ to: "/jobs/$jobId", params: { jobId } });
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
    }
    setPending(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<ArrowCircleUpIcon />}>
            Update Appflare to {version}
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">
              Update Appflare to {version}
            </Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              From {from}. Appflare keeps the current version for a rollback.
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
        <ol className="grid list-decimal gap-2 pl-5">
          <li>
            <Text>
              Appflare uploads the new version next to the current one; the current one keeps
              serving.
            </Text>
          </li>
          <li>
            <Text>
              It checks the new version's preview: it must report version {version} and a working
              database. That first request already migrates Appflare's database to the new version's
              schema, before the switch; migrations only add to it, so the current version keeps
              working with it.
            </Text>
          </li>
          <li>
            <Text>
              Then it switches all traffic to the new version. The update's page reloads by itself
              once the new version answers.
            </Text>
          </li>
        </ol>
        <Text variant="secondary">
          Nothing else runs during the update: installs, updates, and uninstalls wait until it
          finishes. If the new version fails its check, the current one keeps serving. To go back
          later, run{" "}
          <Text variant="mono" as="span">
            npx @appflare/cli rollback
          </Text>{" "}
          or use the Worker's Deployments page in the Cloudflare dashboard.
        </Text>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
          <Button
            variant="primary"
            icon={<ArrowCircleUpIcon />}
            loading={pending}
            onClick={onConfirm}
          >
            Update
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
