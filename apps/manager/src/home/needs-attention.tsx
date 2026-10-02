import { Button, Collapsible, LinkButton, Text, useKumoToastManager } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CheckIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { appLink } from "../components/app-links";
import { BusyButton } from "../components/busy-button";
import { Section, SectionRows } from "../components/section";
import type { StartUpdateHandle } from "../components/update-banner";
import { useOptimisticDismiss } from "../components/use-optimistic-dismiss";
import { dismissDeployCopy } from "../deploy-button/deploy-copy.functions";
import { DeployCopySteps } from "../deploy-button/deploy-copy-card";
import { checkInstallHealth } from "../installs/health.functions";
import { MANAGER_UPDATES_HREF } from "../installs/pending-updates";
import { type UpdateAllOutcome, updateAllSummary } from "../installs/update-all";
import { startAllUpdates } from "../installs/update-all.functions";
import { accountRowLink } from "./account-attention";
import {
  type AccountAttentionRow,
  type AttentionItem,
  UPDATE_ALL_MIN,
  updateAllTargets,
} from "./attention";
import { attentionCopy } from "./attention-copy";

/**
 * Home's "Needs attention": one card of rows, most severe first (see
 * `attention.ts`), each with one action; "Update all" at the right of the
 * heading for admins while several updates can start at once. Nothing at all
 * while nothing needs attention.
 */
export function NeedsAttention({
  items,
  isAdmin,
  update,
  onDismissAccountRow,
  onUpdateAllOutcome,
}: {
  items: readonly AttentionItem[];
  isAdmin: boolean;
  /** Home's start-update handle; its dialog is rendered by Home. */
  update: StartUpdateHandle;
  onDismissAccountRow(row: AccountAttentionRow): void;
  /** What the last "Update all" started and left, for Home to remember. */
  onUpdateAllOutcome(outcome: UpdateAllOutcome): void;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [updatingAll, setUpdatingAll] = useState(false);
  const [notStarted, setNotStarted] = useState<UpdateAllOutcome["notStarted"]>([]);
  const [error, setError] = useState<string | null>(null);
  const targets = updateAllTargets(items);

  if (items.length === 0) return null;

  async function onUpdateAll() {
    setUpdatingAll(true);
    setError(null);
    setNotStarted([]);
    try {
      const outcome = await startAllUpdates({
        data: { installIds: targets.map((t) => t.installId) },
      });
      onUpdateAllOutcome(outcome);
      setNotStarted(outcome.notStarted);
      toasts.add({
        title: updateAllSummary(outcome),
        description:
          outcome.started.length > 0 ? "Each app's page shows its update as it runs." : undefined,
        variant: outcome.started.length > 0 ? "info" : "warning",
      });
      // The started apps show as updating and leave the list.
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the updates.");
    }
    setUpdatingAll(false);
  }

  const bannerError =
    error ??
    (update.error !== null ? update.error.message : null) ??
    (notStarted.length > 0 ? (
      <ul className="grid gap-1">
        {notStarted.map((item) => (
          <li key={item.installId}>
            {/* Home's name for the app, not the server's (which may be its Worker name). */}
            {targets.find((t) => t.installId === item.installId)?.label ?? item.label}:{" "}
            {item.reason}
          </li>
        ))}
      </ul>
    ) : null);

  return (
    <Section
      id="needs-attention"
      title="Needs attention"
      description="The most urgent first."
      action={
        isAdmin && targets.length >= UPDATE_ALL_MIN ? (
          <BusyButton
            pending={updatingAll}
            variant="primary"
            icon={<ArrowsClockwiseIcon />}
            onClick={() => void onUpdateAll()}
          >
            Update all
          </BusyButton>
        ) : null
      }
      error={bannerError}
    >
      <SectionRows>
        {items.map((item) => (
          <AttentionRow
            key={item.key}
            item={item}
            isAdmin={isAdmin}
            update={update}
            onDismissAccountRow={onDismissAccountRow}
          />
        ))}
      </SectionRows>
    </Section>
  );
}

function AttentionRow({
  item,
  isAdmin,
  update,
  onDismissAccountRow,
}: {
  item: AttentionItem;
  isAdmin: boolean;
  update: StartUpdateHandle;
  onDismissAccountRow(row: AccountAttentionRow): void;
}) {
  const { title, description } = attentionCopy(item);
  if (item.kind === "deploy-copy") return <DeployCopyRow item={item} />;
  let action: ReactNode;
  switch (item.kind) {
    case "failed-job":
      action = (
        <LinkButton href={`/jobs/${item.job.id}`} variant="secondary" icon={<ArrowRightIcon />}>
          View log
        </LinkButton>
      );
      break;
    case "not-responding":
      action = isAdmin ? (
        <CheckAgainButton installId={item.installId} />
      ) : (
        <ManageLink installId={item.installId} />
      );
      break;
    case "access-required":
      action = isAdmin ? (
        <LinkButton href={appLink(item.installId, "access")} variant="secondary">
          Turn on
        </LinkButton>
      ) : (
        <ManageLink installId={item.installId} />
      );
      break;
    case "update":
      action = !isAdmin ? (
        <ManageLink installId={item.installId} />
      ) : item.needs !== null ? (
        <LinkButton href={`/apps/${item.installId}`} variant="secondary">
          Review
        </LinkButton>
      ) : (
        <BusyButton
          pending={update.pendingId === item.installId}
          variant="secondary"
          icon={<ArrowCircleUpIcon />}
          onClick={() => update.start({ id: item.installId, label: item.label })}
        >
          Update
        </BusyButton>
      );
      break;
    case "account":
      action = (
        <>
          {/* Never for what every app needs, such as the token's permissions. */}
          {item.row.dismissible && (
            <Button variant="ghost" onClick={() => onDismissAccountRow(item.row)}>
              Not needed
            </Button>
          )}
          <LinkButton href={accountRowLink(item.row)} variant="secondary">
            Go to Your account
          </LinkButton>
        </>
      );
      break;
    case "downgrade":
      action = (
        <LinkButton href={MANAGER_UPDATES_HREF} variant="secondary">
          Update Appflare
        </LinkButton>
      );
      break;
  }
  return <AttentionRowLayout title={title} description={description} actions={action} />;
}

/**
 * One row: the title and its line, with the actions at the right; on a
 * phone, the actions go full width under the text.
 */
function AttentionRowLayout({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-3 px-5 py-4">
      <div className="grid min-w-0 gap-3 sm:flex sm:items-center sm:justify-between sm:gap-4">
        <div className="grid min-w-0 max-w-prose gap-1">
          <Text bold as="span">
            {title}
          </Text>
          <Text variant="secondary">{description}</Text>
        </div>
        <div className="flex flex-col-reverse gap-2 *:w-full *:justify-center sm:shrink-0 sm:flex-row sm:items-center sm:*:w-auto">
          {actions}
        </div>
      </div>
      {children}
    </div>
  );
}

function ManageLink({ installId }: { installId: string }) {
  return (
    <LinkButton href={`/apps/${installId}`} variant="secondary">
      Manage
    </LinkButton>
  );
}

/** "Check again": one health check of the app now, then the list follows its result. */
function CheckAgainButton({ installId }: { installId: string }) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [pending, setPending] = useState(false);

  async function onCheck() {
    setPending(true);
    try {
      await checkInstallHealth({ data: { installId } });
      await router.invalidate();
    } catch (err) {
      toasts.add({
        title: err instanceof Error ? err.message : "Could not check the app.",
        variant: "error",
      });
    }
    setPending(false);
  }

  return (
    <BusyButton
      pending={pending}
      variant="secondary"
      icon={<ArrowsClockwiseIcon />}
      onClick={() => void onCheck()}
    >
      Check again
    </BusyButton>
  );
}

/**
 * "Clean up the deploy copy": the two steps behind "Show the steps", and
 * "Done", which hides the row for every admin.
 */
function DeployCopyRow({ item }: { item: Extract<AttentionItem, { kind: "deploy-copy" }> }) {
  const { title, description } = attentionCopy(item);
  const { hidden, dismiss } = useOptimisticDismiss(() => dismissDeployCopy());
  if (hidden) return null;
  return (
    <AttentionRowLayout
      title={title}
      description={description}
      actions={
        <Button variant="secondary" icon={<CheckIcon />} onClick={dismiss}>
          Done
        </Button>
      }
    >
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>Show the steps</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <DeployCopySteps cleanup={item.cleanup} />
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </AttentionRowLayout>
  );
}
