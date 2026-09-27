import { Banner, Button, Checkbox, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import {
  HYPERDRIVE_KIND,
  HYPERDRIVE_SUPERSEDED_KIND,
  isDataResourceKind,
  PIPELINE_STREAM_KIND,
  QUEUE_CONSUMER_KIND,
} from "../installs/resource-kinds";
import type { ResourceUsage } from "../installs/resource-usage.server";
import { getResourceUsage, retryUninstall, startUninstall } from "../installs/uninstall.functions";
import { ConfirmDialog } from "./confirm-dialog";
import { formatBytes, resourceKindLabel } from "./format";
import { useJobStarted } from "./job-started";

function usageText(usage: ResourceUsage | undefined): string | null {
  if (usage?.kvKeys !== undefined) {
    const { count, more } = usage.kvKeys;
    return more ? `${count.toLocaleString()}+ keys` : `${count.toLocaleString()} keys`;
  }
  if (usage?.d1Bytes !== undefined) return formatBytes(usage.d1Bytes);
  return null;
}

/** What goes with the Worker, as short phrases ("2 secrets", "Durable Object Counter"). */
function workerBoundSummary(install: InstallDetail): string[] {
  const out: string[] = [];
  const byKind = (kind: string) => install.resources.filter((r) => r.kind === kind);
  // An app of several Workers: its other Workers go too.
  for (const r of byKind("worker")) {
    if (r.name !== install.workerName) out.push(`the Worker "${r.name}"`);
  }
  for (const d of install.domains) out.push(`the custom domain ${d.hostname}`);
  for (const d of install.externalDomains) out.push(`the external domain ${d.hostname}`);
  for (const r of byKind("subdomain")) out.push(`the route ${r.name}`);
  for (const r of byKind(QUEUE_CONSUMER_KIND)) out.push(`the consumer of the queue ${r.name}`);
  // The database itself is the admin's and stays as it is.
  for (const r of [...byKind(HYPERDRIVE_KIND), ...byKind(HYPERDRIVE_SUPERSEDED_KIND)]) {
    out.push(`the Hyperdrive configuration ${r.name}`);
  }
  // What a sink wrote stays in its bucket, which is listed with the data.
  for (const r of byKind(PIPELINE_STREAM_KIND)) {
    out.push(`the Pipelines stream ${r.name} with its sink and pipeline`);
  }
  const crons = byKind("cron").length;
  if (crons > 0) out.push(`${crons} cron trigger${crons === 1 ? "" : "s"}`);
  const secrets = install.secretNames.length;
  if (secrets > 0) out.push(`${secrets} secret${secrets === 1 ? "" : "s"}`);
  for (const r of byKind("workflow")) out.push(`the Workflow ${r.name}`);
  for (const r of byKind("durable_object")) {
    out.push(`the Durable Object class ${r.name} and everything it stored`);
  }
  return out;
}

/**
 * The uninstall confirmation of `/apps/$installId` (admins only). Lists the
 * data resources with a checkbox each (all ticked by default) and, where the
 * API reports it cheaply, what they hold; what goes with the Worker, custom
 * domains included (they hold no data, and are removed before the Worker), is
 * listed without a choice, and so is what the install set up in Email Routing
 * (removed first). The admin types the Worker name to confirm, as Kumo's
 * delete-resource pattern has it. Submitting starts the uninstall job and
 * opens its log. In `retry` mode it continues an
 * uninstall that stopped part way, listing only what is left; unticking a
 * resource keeps it (for example a bucket Cloudflare refuses to delete).
 * A self-deploying app is removed by its own installer's destroy command,
 * which deletes everything it created: the dialog lists it without a choice.
 */
export function UninstallDialog({
  install,
  mode,
}: {
  install: InstallDetail;
  mode: "start" | "retry";
}) {
  const jobStarted = useJobStarted();
  const selfDeploying = install.build.kind === "self-deploying";
  const data = selfDeploying ? [] : install.resources.filter((r) => isDataResourceKind(r.kind));
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(data.map((r) => r.id)));
  const [usage, setUsage] = useState<Map<string, ResourceUsage>>(new Map());

  function onOpen() {
    setTicked(new Set(data.map((r) => r.id)));
    if (data.length > 0) {
      getResourceUsage({ data: { installId: install.id } })
        .then((rows) => setUsage(new Map(rows.map((u) => [u.id, u]))))
        .catch(() => setUsage(new Map()));
    }
  }

  function toggle(id: string, checked: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function onConfirm() {
    const input = { data: { installId: install.id, deleteResources: [...ticked] } };
    const { jobId } = mode === "retry" ? await retryUninstall(input) : await startUninstall(input);
    await jobStarted(jobId, "Uninstall started");
  }

  const alsoDeleted = workerBoundSummary(install);
  return (
    <ConfirmDialog
      size="lg"
      trigger={(p) =>
        mode === "retry" ? (
          <Button {...p} variant="secondary-destructive" icon={<ArrowClockwiseIcon />}>
            Retry uninstall
          </Button>
        ) : (
          <Button {...p} variant="secondary-destructive" icon={<TrashIcon />}>
            Uninstall
          </Button>
        )
      }
      title={`${mode === "retry" ? "Finish uninstalling" : "Uninstall"} ${install.label}`}
      description={
        selfDeploying
          ? "Runs the app's own installer in your sandbox Worker to delete everything it created, then removes the app's token and secrets from the sandbox Worker. Nothing can be kept."
          : mode === "retry"
            ? "Deletes what the last attempt left, including the Worker if it is still there. Untick a resource to keep it in the account instead."
            : `Deletes the Worker "${install.workerName}"${alsoDeleted.length > 0 ? ` with ${alsoDeleted.join(", ")}` : ""}, and the resources you tick below.`
      }
      confirmText={install.workerName}
      actionLabel={mode === "retry" ? "Retry uninstall" : "Uninstall"}
      onOpen={onOpen}
      onConfirm={onConfirm}
    >
      <Banner
        variant="alert"
        icon={<WarningIcon weight="fill" />}
        title="Deleting data is permanent"
        description={
          selfDeploying
            ? "The installer's destroy command deletes the app's databases, buckets and namespaces with everything in them. It runs in a container on Workers Paid, like an install."
            : "Ticked resources are deleted with everything in them, including every object in an R2 bucket. Untick a resource to keep it in the account; Appflare then lists it on this app's page and under Settings, Removed apps, until you delete it or forget the app."
        }
      />
      {selfDeploying && install.resources.length > 0 && (
        <div className="grid gap-1.5">
          <Text bold>Deleted by the app's installer</Text>
          <ul className="grid gap-1">
            {install.resources.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <span>{resourceKindLabel(r.kind)}</span>
                <span className="font-mono text-[0.9em]">{r.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {install.emailRoutes.length > 0 && (
        <div className="grid gap-1.5">
          <Text bold>Email Routing</Text>
          <Text variant="secondary">
            Undone first, before the Worker, so no mail is sent to a Worker that no longer exists.
            Nothing here holds data.
          </Text>
          <ul className="grid list-disc gap-1 pl-5">
            {install.emailRoutes.map((r) => (
              <li key={r.id}>
                <Text as="span">{r.onUninstall}</Text>
              </li>
            ))}
          </ul>
        </div>
      )}
      {install.domains.length + install.externalDomains.length > 0 && (
        <div className="grid gap-1.5">
          <Text bold>Domains</Text>
          <Text variant="secondary">
            Removed first, before the Worker. A domain holds no data, so there is nothing to keep.
            External domains stop answering at once; their owners can delete the DNS records they
            added.
          </Text>
          <ul className="grid gap-1">
            {[...install.domains, ...install.externalDomains].map((d) => (
              <li key={d.id} className="font-mono text-[0.9em]">
                {d.hostname}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.length > 0 ? (
        <div className="grid gap-3">
          <Text bold>Data resources</Text>
          {data.map((r) => {
            const held = usageText(usage.get(r.id));
            return (
              <Checkbox
                key={r.id}
                checked={ticked.has(r.id)}
                onCheckedChange={(checked: boolean) => toggle(r.id, checked)}
                label={
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span>{resourceKindLabel(r.kind)}</span>
                    <span className="font-mono text-[0.9em]">{r.name}</span>
                    {held !== null && (
                      <Text as="span" variant="secondary" size="sm">
                        {held}
                      </Text>
                    )}
                  </span>
                }
              />
            );
          })}
        </div>
      ) : selfDeploying ? null : (
        <Text variant="secondary">This app has no data resources besides its Worker.</Text>
      )}
    </ConfirmDialog>
  );
}
