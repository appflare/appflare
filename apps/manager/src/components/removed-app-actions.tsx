import { Banner, Button, Dialog, Input, Text } from "@cloudflare/kumo";
import {
  EyeSlashIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { deleteRetainedData, forgetRemovedApp } from "../installs/removed-apps.functions";
import { resourceKindLabel } from "./format";

/** An uninstalled install and what it kept in the account. */
export interface RemovedApp {
  id: string;
  instanceName: string;
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

function CloseButton() {
  return (
    <Dialog.Close
      aria-label="Close"
      render={(props) => (
        <Button {...props} variant="secondary" shape="square" icon={<XIcon />} aria-label="Close" />
      )}
    />
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setConfirm("");
      setError(null);
    }
  }

  const confirmed = confirm.trim() === app.workerName;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await deleteRetainedData({ data: { installId: app.id } });
      await router.navigate({ to: "/jobs/$jobId", params: { jobId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start deleting the data.");
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary-destructive" icon={<TrashIcon />} disabled={disabled}>
            Delete retained data
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">
              Delete what {app.instanceName} kept
            </Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              Deletes every resource below from your Cloudflare account. The app stays uninstalled,
              and its jobs stay in the history.
            </Dialog.Description>
          </div>
          <CloseButton />
        </div>
        <form className="grid gap-5" onSubmit={onSubmit}>
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
          <Input
            label={`Type ${app.workerName} to confirm`}
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
              Delete retained data
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

/**
 * "Forget" (admins): hides the app from Removed apps. Nothing is deleted:
 * the resources stay in the account, and the dialog says so and lists them.
 */
export function ForgetDialog({ app, disabled = false }: { app: RemovedApp; disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) setError(null);
  }

  async function onForget() {
    setPending(true);
    setError(null);
    try {
      await forgetRemovedApp({ data: { installId: app.id } });
      setOpen(false);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not forget the app.");
    }
    setPending(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<EyeSlashIcon />} disabled={disabled}>
            Forget
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">Forget {app.instanceName}</Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              Removes {app.instanceName} from Removed apps. Nothing is deleted: the resources below
              stay in your Cloudflare account with everything in them. Only the app's own page still
              lists them, where Delete retained data stays available; you can also delete them in
              the Cloudflare dashboard.
            </Dialog.Description>
          </div>
          <CloseButton />
        </div>
        <div className="grid gap-1.5">
          <Text bold>Stays in the account</Text>
          <RetainedList retained={app.retained} />
        </div>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
          <Button variant="primary" icon={<EyeSlashIcon />} loading={pending} onClick={onForget}>
            Forget and keep the resources
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
