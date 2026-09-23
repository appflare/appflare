import { Banner, Button, Checkbox, Dialog, Input, Text } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { isDataResourceKind, QUEUE_CONSUMER_KIND } from "../installs/resource-kinds";
import type { ResourceUsage } from "../installs/resource-usage.server";
import { getResourceUsage, retryUninstall, startUninstall } from "../installs/uninstall.functions";
import { formatBytes, resourceKindLabel } from "./format";

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
  for (const d of install.domains) out.push(`the custom domain ${d.hostname}`);
  for (const r of byKind("subdomain")) out.push(`the route ${r.name}`);
  for (const r of byKind(QUEUE_CONSUMER_KIND)) out.push(`the consumer of the queue ${r.name}`);
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
 * (removed first). The admin types the Worker name to confirm. Submitting
 * starts the uninstall job and opens its log. In `retry` mode it continues an
 * uninstall that stopped part way, listing only what is left; unticking a
 * resource keeps it (for example a bucket Cloudflare refuses to delete).
 */
export function UninstallDialog({
  install,
  mode,
}: {
  install: InstallDetail;
  mode: "start" | "retry";
}) {
  const router = useRouter();
  const data = install.resources.filter((r) => isDataResourceKind(r.kind));
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(data.map((r) => r.id)));
  const [confirm, setConfirm] = useState("");
  const [usage, setUsage] = useState<Map<string, ResourceUsage>>(new Map());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setTicked(new Set(data.map((r) => r.id)));
      setConfirm("");
      setError(null);
      if (data.length > 0) {
        getResourceUsage({ data: { installId: install.id } })
          .then((rows) => setUsage(new Map(rows.map((u) => [u.id, u]))))
          .catch(() => setUsage(new Map()));
      }
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

  const confirmed = confirm.trim() === install.workerName;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const input = { data: { installId: install.id, deleteResources: [...ticked] } };
      const { jobId } =
        mode === "retry" ? await retryUninstall(input) : await startUninstall(input);
      await router.navigate({ to: "/jobs/$jobId", params: { jobId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the uninstall.");
      setPending(false);
    }
  }

  const alsoDeleted = workerBoundSummary(install);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <Dialog.Trigger
        render={(p) =>
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
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">
              {mode === "retry" ? "Finish uninstalling" : "Uninstall"} {install.instanceName}
            </Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              {mode === "retry"
                ? "Deletes what the last attempt left, including the Worker if it is still there. Untick a resource to keep it in the account instead."
                : `Deletes the Worker "${install.workerName}"${alsoDeleted.length > 0 ? ` with ${alsoDeleted.join(", ")}` : ""}, and the resources you tick below.`}
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
        <form className="grid gap-5" onSubmit={onSubmit}>
          <Banner
            variant="alert"
            icon={<WarningIcon weight="fill" />}
            title="Deleting data is permanent"
            description="Ticked resources are deleted with everything in them, including every object in an R2 bucket. Untick a resource to keep it in the account; Appflare lists it on this page afterwards."
          />
          {install.emailRoutes.length > 0 && (
            <div className="grid gap-1.5">
              <Text bold>Email Routing</Text>
              <Text variant="secondary">
                Undone first, before the Worker, so no mail is sent to a Worker that no longer
                exists. Nothing here holds data.
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
          {install.domains.length > 0 && (
            <div className="grid gap-1.5">
              <Text bold>Custom domains</Text>
              <Text variant="secondary">
                Removed first, before the Worker. A custom domain holds no data, so there is nothing
                to keep.
              </Text>
              <ul className="grid gap-1">
                {install.domains.map((d) => (
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
                    disabled={pending}
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
          ) : (
            <Text variant="secondary">This app has no data resources besides its Worker.</Text>
          )}
          <Input
            label={`Type ${install.workerName} to confirm`}
            value={confirm}
            onChange={(e) => setConfirm(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
          {error !== null && (
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
            <Button
              type="submit"
              variant="destructive"
              icon={<TrashIcon />}
              loading={pending}
              disabled={!confirmed}
            >
              {mode === "retry" ? "Retry uninstall" : "Uninstall"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
