import { Badge, Banner, Button, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { AutoUpdateSettings } from "../auto-update/auto-update";
import { AppflareAutomaticUpdates } from "../auto-update/automatic-updates-card";
import {
  checkManagerUpdates,
  type ManagerUpdateState,
  startSelfUpdate,
} from "../catalog/manager-releases.functions";
import { BusyButton } from "./busy-button";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { useJobStarted } from "./job-started";
import { Section, SectionBody, SectionFormActions, SectionRows } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The Appflare version section of the Updates settings: the running version,
 * the newest release the release feed reported, and "Update Appflare to
 * <version>" at the right of the header when there is one (admins; else
 * "Check now" is there). The update opens a confirmation, then the job's log.
 * Below, whether Appflare updates itself.
 */
export function AppflareUpdatesCard({
  state,
  autoUpdate,
  isAdmin,
}: {
  state: ManagerUpdateState;
  autoUpdate: AutoUpdateSettings;
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
  const update =
    isAdmin && state.updateAvailable && latest !== null && state.activeJobId === null
      ? latest
      : null;
  const checkNow = isAdmin ? (
    <BusyButton
      pending={checking}
      variant="secondary"
      icon={<ArrowsClockwiseIcon />}
      onClick={onCheck}
    >
      Check now
    </BusyButton>
  ) : null;
  return (
    <Section
      {...settingsSection("updates", "appflare")}
      badge={
        state.activeJobId !== null ? (
          <Badge variant="info">Updating</Badge>
        ) : state.updateAvailable ? (
          <Badge variant="warning">Update available</Badge>
        ) : latest !== null ? (
          <Badge variant="success">Up to date</Badge>
        ) : null
      }
      description="The version of Appflare running here, its newest release, and whether it updates itself."
      action={
        update !== null ? (
          <SelfUpdateDialog from={state.current} version={update.version} />
        ) : (
          checkNow
        )
      }
      error={error}
    >
      <SectionRows>
        <SectionBody>
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
          {notice !== null && (
            <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title={notice} />
          )}
          {(state.activeJobId !== null || update !== null) && (
            <SectionFormActions>
              {state.activeJobId !== null && (
                <LinkButton
                  href={`/jobs/${state.activeJobId}`}
                  variant="secondary"
                  icon={<ArrowRightIcon />}
                >
                  View update log
                </LinkButton>
              )}
              {update !== null && checkNow}
            </SectionFormActions>
          )}
        </SectionBody>
        <SectionBody>
          <AppflareAutomaticUpdates settings={autoUpdate} isAdmin={isAdmin} />
        </SectionBody>
      </SectionRows>
    </Section>
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
        later, roll back under Versions on this page.
      </Text>
    </ConfirmDialog>
  );
}
