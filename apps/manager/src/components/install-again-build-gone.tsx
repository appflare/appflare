import { Banner, Text, useKumoToastManager } from "@cloudflare/kumo";
import { GitBranchIcon, WarningIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { InstallAgainRecord, InstallAgainSource } from "../installs/install-again";
import { buildForInstallAgain } from "../installs/source-builds.functions";
import { BusyButton } from "./busy-button";
import { ErrorMessageBanner } from "./message-text";
import { Section, SectionBody } from "./section";
import { SourceBuildCostConfirmation } from "./source-build-fields";

const mono = "font-mono text-[0.9em]";

/**
 * On a build's review for "Install again" of a failed install from a
 * repository, when that build cannot be installed again: why, and, when it
 * is gone, a new build of the same repository at the same branch, tag or
 * commit, with its cost confirmed first. That build's review opens with the
 * choices from last time (installs/install-again.ts).
 */
export function InstallAgainBuildGone({
  again,
  source,
  appName,
}: {
  again: InstallAgainRecord;
  source: InstallAgainSource;
  appName: string;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (source.build.state === "ready") return null;
  const gone = source.build.state === "gone";
  const sandboxFirst = source.build.state === "gone" && source.build.cause === "no-sandbox";
  const at = source.ref ?? "its default branch";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!costConfirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await buildForInstallAgain({
        data: { installId: again.installId, costConfirmed },
      });
      toasts.add({
        title: "Build started",
        description: "Its review opens with the choices from last time once it is built.",
        variant: "info",
      });
      await router.navigate({
        to: "/catalog/source/$buildId",
        params: { buildId: jobId },
        search: { again: again.installId },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the build.");
      setPending(false);
    }
  }

  return (
    <>
      <Banner
        variant={gone ? "alert" : "secondary"}
        icon={<WarningIcon weight="fill" />}
        title={
          gone
            ? `The build ${again.label} was installed from is gone`
            : `Appflare could not check the build ${again.label} was installed from`
        }
        description={source.build.reason}
      />
      {gone && (
        <Section title={`Build ${appName} again`}>
          <SectionBody>
            <form className="grid gap-5" onSubmit={onSubmit}>
              <Text variant="secondary">
                Builds {source.repo} at <span className={mono}>{at}</span> again, with the same
                build command; if {at} has moved on, that is its newest commit now. Once it is
                built, its review opens with the choices from last time, and installing it removes
                what {again.label} left in your account first.
              </Text>
              <SourceBuildCostConfirmation
                checked={costConfirmed}
                onChange={setCostConfirmed}
                disabled={pending}
                what={source.repo}
                sandboxFirst={sandboxFirst}
              />
              {error !== null && <ErrorMessageBanner message={error} newTab />}
              <div className="flex justify-end">
                <BusyButton
                  pending={pending}
                  type="submit"
                  variant="primary"
                  icon={<GitBranchIcon />}
                  disabled={!costConfirmed || pending}
                >
                  Build again
                </BusyButton>
              </div>
            </form>
          </SectionBody>
        </Section>
      )}
    </>
  );
}
