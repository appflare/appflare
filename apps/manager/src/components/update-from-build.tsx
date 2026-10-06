import { Banner, Checkbox, Text } from "@cloudflare/kumo";
import { ArrowCircleUpIcon, EnvelopeSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import type { SourceBuildReview, SourceBuildView } from "../installs/source-builds.functions";
import { updateFromSourceBuild } from "../installs/source-builds.functions";
import { BusyButton } from "./busy-button";
import { connectionsComplete, DatabaseFields, optionalConnectionsValid } from "./database-fields";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner } from "./message-text";
import {
  initialSecretValues,
  SecretFields,
  secretsComplete,
  withSecretValue,
} from "./secret-fields";
import { Section, SectionBody } from "./section";
import { filledConnections, streamTokenNotes } from "./update-banner";

/** Updating an install from its reviewed rebuild: new secrets, the preview question, then the update job. */
export function UpdateFromBuild({
  build,
  review,
  canUpdate,
}: {
  build: SourceBuildView;
  review: SourceBuildReview;
  canUpdate: boolean;
}) {
  const jobStarted = useJobStarted();
  const [secrets, setSecrets] = useState(() =>
    initialSecretValues(review.needsSecrets, review.heldSecrets),
  );
  /**
   * Connection strings of the databases the build adds, and of those an
   * earlier update connected that the admin replaces (empty keeps them);
   * never stored by Appflare.
   */
  const [connections, setConnections] = useState<Record<string, string>>({});
  const replaceable = review.replaceableDatabases;
  const [noPreview, setNoPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    canUpdate &&
    !pending &&
    secretsComplete(review.needsSecrets, secrets) &&
    connectionsComplete(review.needsDatabases, connections) &&
    optionalConnectionsValid(replaceable, connections) &&
    (review.skipsPreview === null || noPreview);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await updateFromSourceBuild({
        data: {
          buildId: build.id,
          secrets,
          ...(review.needsDatabases.length + replaceable.length === 0
            ? {}
            : { hyperdrive: filledConnections(connections) }),
          ...(review.skipsPreview === null ? {} : { confirmNoPreview: noPreview }),
          ...(review.emailRoutingKey === null
            ? {}
            : { confirmEmailRouting: review.emailRoutingKey }),
        },
      });
      await jobStarted(jobId, "Update started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
      setPending(false);
    }
  }

  return (
    <Section title={`Update ${build.install?.label ?? "the install"}`}>
      <SectionBody>
        <form className="grid gap-5" onSubmit={onSubmit}>
          <Text variant="secondary">
            The update takes a snapshot of the current version and of each D1 database, checks the
            new version before it serves traffic where Cloudflare allows it, and keeps the current
            one for a rollback.
          </Text>
          {review.skipsPreview !== null && (
            <div className="grid gap-3">
              <Banner
                variant="alert"
                icon={<WarningIcon weight="fill" />}
                title="No preview check for this update"
                description={`${review.skipsPreview}.`}
              />
              <Checkbox
                checked={noPreview}
                onCheckedChange={(checked: boolean) => setNoPreview(checked)}
                disabled={pending || !canUpdate}
                label="Update without checking the new version first"
              />
            </div>
          )}
          {review.emailRouting !== null && (
            <Banner
              variant="secondary"
              icon={<EnvelopeSimpleIcon />}
              title="Email changes with this version"
              description={review.emailRouting}
            />
          )}
          {review.needsSecrets.length > 0 && (
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <Text bold>New secrets</Text>
                <Text variant="secondary" size="sm">
                  {review.heldSecrets.length > 0
                    ? "This build needs secrets the app does not have yet, or the value of one it has again."
                    : "This build needs secrets the app does not have yet."}{" "}
                  They are stored as encrypted secrets on the app's Worker; Appflare keeps only
                  their names.
                </Text>
              </div>
              <SecretFields
                secrets={review.needsSecrets}
                vars={review.catalog.vars}
                held={review.heldSecrets}
                values={secrets}
                onChange={(name, value) => setSecrets((s) => withSecretValue(s, name, value))}
                after="the update"
                fieldExtras={streamTokenNotes(review.streamTokens)}
                disabled={pending}
              />
            </div>
          )}
          {review.needsDatabases.length > 0 && (
            <DatabaseFields
              databases={review.needsDatabases}
              values={connections}
              onChange={(binding, value) => setConnections((c) => ({ ...c, [binding]: value }))}
              disabled={pending}
            />
          )}
          {replaceable.length > 0 && (
            <DatabaseFields
              databases={replaceable}
              values={connections}
              onChange={(binding, value) => setConnections((c) => ({ ...c, [binding]: value }))}
              replacing
              disabled={pending}
            />
          )}
          {error !== null && <ErrorMessageBanner message={error} newTab />}
          <div className="flex justify-end">
            <BusyButton
              pending={pending}
              type="submit"
              variant="primary"
              icon={<ArrowCircleUpIcon />}
              disabled={!ready}
            >
              Update
            </BusyButton>
          </div>
        </form>
      </SectionBody>
    </Section>
  );
}
