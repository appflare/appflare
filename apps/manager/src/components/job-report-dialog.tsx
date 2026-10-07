import { AppflareLoader } from "@appflare/brand/loader";
import { Button, LayerDialog } from "@cloudflare/kumo";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { FAILURE_REPORT_COPY, type FailureReportPreview } from "../telemetry/failure-report";
import { previewJobReport, sendJobReport } from "../telemetry/telemetry.functions";
import { BusyMark, busyActionProps } from "./busy-button";
import { FailureReportBody, ReportSent } from "./job-report-parts";
import { ErrorMessageBanner } from "./message-text";

/**
 * "Send a report" on a failed job (admins): a button that opens a dialog
 * with what the report contains in plain words, an optional note, and the
 * exact report on demand. Once sent, the button gives way to "Thanks,
 * report sent"; a job is reported at most once.
 */
export function SendReportButton({
  jobId,
  reportedAt,
  size = "sm",
}: {
  jobId: string;
  /** When the job was reported; null when it was not (or is not known here). */
  reportedAt: string | null;
  size?: "sm" | "base";
}) {
  const [open, setOpen] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [preview, setPreview] = useState<FailureReportPreview | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if ((sentAt ?? reportedAt) !== null) return <ReportSent />;

  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // A card that could not tell whether the job was reported learns it here.
      if (preview?.reportedAt != null) setSentAt(preview.reportedAt);
      return;
    }
    setFailure(null);
    if (preview !== null) return;
    try {
      setPreview(await previewJobReport({ data: { jobId } }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not prepare the report.");
    }
  }

  async function onSend() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const outcome = await sendJobReport({
        data: { jobId, note, installId: preview?.event.distinct_id },
      });
      setOpen(false);
      setSentAt(outcome.reportedAt);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : FAILURE_REPORT_COPY.sendFailed);
    } finally {
      setPending(false);
    }
  }

  const blocked = preview === null || preview.devBuild || preview.reportedAt !== null;
  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={(next) => void onOpenChange(next)}
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" size={size} icon={<PaperPlaneTiltIcon />}>
            {FAILURE_REPORT_COPY.action}
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>{FAILURE_REPORT_COPY.title}</LayerDialog.Title>
        <LayerDialog.Description>{FAILURE_REPORT_COPY.description}</LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            {preview === null ? (
              failure === null && <AppflareLoader size="sm" />
            ) : (
              <FailureReportBody preview={preview} note={note} onNoteChange={setNote} />
            )}
            {failure !== null && <ErrorMessageBanner message={failure} newTab />}
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            onClick={() => void onSend()}
            {...busyActionProps(pending, blocked)}
          >
            <BusyMark pending={pending} />
            {FAILURE_REPORT_COPY.send}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
