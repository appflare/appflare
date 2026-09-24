import { Badge, Banner, Button, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  InfoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  checkManagerUpdates,
  type ManagerUpdateState,
  startSelfUpdate,
} from "../catalog/manager-releases.functions";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { useJobStarted } from "./job-started";
import { Timestamp } from "./timestamp";

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
        <DescriptionList>
          <DescriptionItem label="Running version">
            <Text variant="mono" as="span">
              {state.current}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Latest release">
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
                    published <Timestamp iso={latest.publishedAt} />
                  </Text>
                )}
              </>
            )}
          </DescriptionItem>
          <DescriptionItem label="Last checked">
            <Timestamp iso={state.checkedAt} />
          </DescriptionItem>
        </DescriptionList>
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

function SelfUpdateDialog({ from, version }: { from: string; version: string }) {
  const jobStarted = useJobStarted();
  return (
    <ConfirmDialog
      size="lg"
      trigger={(p) => (
        <Button {...p} variant="primary" icon={<ArrowCircleUpIcon />}>
          Update Appflare to {version}
        </Button>
      )}
      title={`Update Appflare to ${version}`}
      description={`From ${from}. Appflare keeps the current version for a rollback.`}
      actionLabel="Update"
      destructive={false}
      onConfirm={async () => {
        const { jobId } = await startSelfUpdate({ data: { version } });
        await jobStarted(jobId, "Appflare update started");
      }}
    >
      <ol className="grid list-decimal gap-2 pl-5">
        <li>
          <Text>
            Appflare uploads the new version next to the current one; the current one keeps serving.
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
        later, roll back on the Worker's Deployments page in the Cloudflare dashboard.
      </Text>
    </ConfirmDialog>
  );
}
