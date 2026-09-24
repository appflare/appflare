import { Banner, Button, Text } from "@cloudflare/kumo";
import { EyeSlashIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { deleteRetainedData, forgetRemovedApp } from "../installs/removed-apps.functions";
import { ConfirmDialog } from "./confirm-dialog";
import { resourceKindLabel } from "./format";
import { useJobStarted } from "./job-started";

/** An uninstalled install and what it kept in the account. */
export interface RemovedApp {
  id: string;
  label: string;
  workerName: string;
  retained: Array<{ id: string; kind: string; name: string }>;
}

function RetainedList({ retained }: { retained: RemovedApp["retained"] }) {
  return (
    <ul className="grid gap-1">
      {retained.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
          <span>{resourceKindLabel(r.kind)}</span>
          <span className="font-mono text-[0.9em]">{r.name}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Delete retained data" (admins): deletes every resource the uninstall
 * kept, with everything in it, as a job reusing the uninstall's data
 * resource steps. The admin types the Worker name to confirm; submitting
 * opens the job's log.
 */
export function DeleteRetainedDialog({
  app,
  disabled = false,
}: {
  app: RemovedApp;
  disabled?: boolean;
}) {
  const jobStarted = useJobStarted();
  return (
    <ConfirmDialog
      size="lg"
      trigger={(p) => (
        <Button {...p} variant="secondary-destructive" icon={<TrashIcon />} disabled={disabled}>
          Delete retained data
        </Button>
      )}
      title={`Delete what ${app.label} kept`}
      description="Deletes every resource below from your Cloudflare account. The app stays uninstalled, and its jobs stay in the history."
      confirmText={app.workerName}
      actionLabel="Delete retained data"
      onConfirm={async () => {
        const { jobId } = await deleteRetainedData({ data: { installId: app.id } });
        await jobStarted(jobId, "Deleting the kept data");
      }}
    >
      <Banner
        variant="alert"
        icon={<WarningIcon weight="fill" />}
        title="Deleting data is permanent"
        description="Each resource is deleted with everything in it, including every object in an R2 bucket."
      />
      <div className="grid gap-1.5">
        <Text bold>Deleted</Text>
        <RetainedList retained={app.retained} />
      </div>
    </ConfirmDialog>
  );
}

/**
 * "Forget" (admins): hides the app from Removed apps. Nothing is deleted:
 * the resources stay in the account, and the dialog says so and lists them.
 */
export function ForgetDialog({ app, disabled = false }: { app: RemovedApp; disabled?: boolean }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      size="lg"
      trigger={(p) => (
        <Button {...p} variant="secondary" icon={<EyeSlashIcon />} disabled={disabled}>
          Forget
        </Button>
      )}
      title={`Forget ${app.label}`}
      description={`Removes ${app.label} from Removed apps. Nothing is deleted: the resources below stay in your Cloudflare account with everything in them. Only the app's own page still lists them, where Delete retained data stays available; you can also delete them in the Cloudflare dashboard.`}
      actionLabel="Forget and keep the resources"
      destructive={false}
      onConfirm={async () => {
        await forgetRemovedApp({ data: { installId: app.id } });
        await router.invalidate();
      }}
    >
      <div className="grid gap-1.5">
        <Text bold>Stays in the account</Text>
        <RetainedList retained={app.retained} />
      </div>
    </ConfirmDialog>
  );
}
