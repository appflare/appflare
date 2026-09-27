import { Banner, CodeBlock, Collapsible, InputArea, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, InfoIcon } from "@phosphor-icons/react";
import {
  FAILURE_REPORT_COPY,
  type FailureReportPreview,
  NOTE_MAX_LENGTH,
  withNote,
} from "../telemetry/failure-report";
import { DescriptionItem, DescriptionList } from "./description-list";
import { jobKindLabel } from "./format";

/**
 * The parts of the "Send a report" dialog that need no server call (the
 * button that opens it is in job-report-dialog.tsx).
 */

/** What replaces the button once the job is reported. */
export function ReportSent() {
  return (
    <span className="flex items-center gap-1.5">
      <CheckCircleIcon weight="fill" className="shrink-0 text-kumo-success" aria-hidden />
      <Text as="span" size="sm">
        {FAILURE_REPORT_COPY.sent}
      </Text>
    </span>
  );
}

const PLAN_LABELS: Record<FailureReportPreview["summary"]["plan"], string> = {
  free: "Workers Free",
  paid: "Workers Paid",
  unset: "Not known",
};

/**
 * The dialog's body: the summary in plain words, the note, whether usage
 * data is off, and the report exactly as sent (the note included, as typed
 * so far) behind "See exactly what is sent".
 */
export function FailureReportBody({
  preview,
  note,
  onNoteChange,
  detailsOpen,
}: {
  preview: FailureReportPreview;
  note: string;
  onNoteChange: (note: string) => void;
  /** Opens "See exactly what is sent" from the start. */
  detailsOpen?: boolean;
}) {
  const { summary } = preview;
  const what = jobKindLabel(summary);
  const app =
    summary.app === null ? null : [summary.app, summary.version].filter(Boolean).join(" ");
  const exact = JSON.stringify(withNote(preview.event, note, preview.accountNames), null, 2);
  return (
    <div className="grid gap-4">
      {preview.reportedAt !== null && (
        <Banner
          variant="default"
          icon={<CheckCircleIcon weight="fill" />}
          title={FAILURE_REPORT_COPY.alreadySent}
        />
      )}
      {preview.devBuild && (
        <Banner
          variant="alert"
          icon={<InfoIcon weight="fill" />}
          title={FAILURE_REPORT_COPY.devBuild}
        />
      )}
      <div className="grid gap-2">
        <Text bold>{FAILURE_REPORT_COPY.summaryTitle}</Text>
        <DescriptionList>
          <DescriptionItem label="What failed">
            {app === null ? what : `${what} of ${app}`}
          </DescriptionItem>
          <DescriptionItem label="Where it stopped">
            {summary.failedStep ?? "Not recorded"}
          </DescriptionItem>
          <DescriptionItem label="Cloudflare error codes">
            {summary.cloudflareCodes.length === 0 ? "None" : summary.cloudflareCodes.join(", ")}
          </DescriptionItem>
          <DescriptionItem label="Appflare version">{summary.managerVersion}</DescriptionItem>
          <DescriptionItem label="Workers plan">{PLAN_LABELS[summary.plan]}</DescriptionItem>
          <DescriptionItem label="Job log">
            {summary.logLines === 0
              ? "No lines"
              : `${summary.logLines} lines${summary.logTruncated ? " (the end of the log)" : ""}, private details removed`}
          </DescriptionItem>
        </DescriptionList>
      </div>
      <InputArea
        label={FAILURE_REPORT_COPY.noteLabel}
        description={FAILURE_REPORT_COPY.noteDescription}
        value={note}
        onValueChange={onNoteChange}
        maxLength={NOTE_MAX_LENGTH}
        autoResize
        minRows={3}
        maxRows={8}
      />
      {preview.usageDataOff && (
        <Banner
          variant="default"
          icon={<InfoIcon weight="fill" />}
          title={FAILURE_REPORT_COPY.usageDataOff}
        />
      )}
      <Collapsible.Root defaultOpen={detailsOpen}>
        <Collapsible.DefaultTrigger>{FAILURE_REPORT_COPY.details}</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel className="grid gap-2">
          <Text variant="secondary" size="sm">
            {FAILURE_REPORT_COPY.detailsDescription}
          </Text>
          <CodeBlock lang="jsonc" code={exact} />
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </div>
  );
}
