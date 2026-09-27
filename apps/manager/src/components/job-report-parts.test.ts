import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FAILURE_REPORT_COPY,
  FAILURE_REPORT_EVENT,
  type FailureReportPreview,
} from "../telemetry/failure-report";
import { FailureReportBody, ReportSent } from "./job-report-parts";

const PREVIEW: FailureReportPreview = {
  jobId: "j1",
  reportedAt: null,
  usageDataOff: false,
  devBuild: false,
  summary: {
    kind: "update",
    restore: false,
    deleteRetained: false,
    app: "cut",
    version: "1.1.0",
    managerVersion: "0.5.0",
    plan: "free",
    cloudflareCodes: [10072],
    failedStep: "set cron triggers",
    logLines: 2,
    logTruncated: false,
  },
  event: {
    event: FAILURE_REPORT_EVENT,
    uuid: "0f0e0d0c-0b0a-5908-8706-050403020100",
    timestamp: "2026-09-27T11:56:00.000Z",
    distinct_id: "6f1c3c1e-2b1a-4c1d-9e1f-0a1b2c3d4e5f",
    properties: {
      kind: "update",
      slug: "cut",
      log: ["2026-09-27T11:55:00.000Z info start", "  PUT /accounts/[account id]/x -> 400"],
      note: null,
    },
  },
  accountNames: { subdomain: "ada", hostnames: ["links.ada.example"], workers: ["my-links"] },
};

function render(preview: FailureReportPreview, note = "", detailsOpen = false): string {
  return renderToStaticMarkup(
    createElement(FailureReportBody, { preview, note, onNoteChange: () => {}, detailsOpen }),
  );
}

/** Text as a browser shows it (React escapes quotes in markup). */
function decodeHtml(html: string): string {
  return html
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

describe("the Send a report dialog", () => {
  it("summarises what is sent in plain words", () => {
    const html = render(PREVIEW);
    expect(html).toContain(FAILURE_REPORT_COPY.summaryTitle);
    expect(html).toContain("Update of cut 1.1.0");
    expect(html).toContain("set cron triggers");
    expect(html).toContain("10072");
    expect(html).toContain("0.5.0");
    expect(html).toContain("Workers Free");
    expect(html).toContain("2 lines, private details removed");
    expect(html).toContain(FAILURE_REPORT_COPY.noteLabel);
    expect(html).not.toContain(FAILURE_REPORT_COPY.usageDataOff);
  });

  it("shows the exact report, with the note as typed and cleaned", () => {
    const html = decodeHtml(
      render(PREVIEW, "  my-links at links.ada.example broke, mail ada@example.com ", true),
    );
    expect(html).toContain(FAILURE_REPORT_COPY.details);
    // The report itself (the note field still shows what the admin typed).
    const sent = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
    expect(JSON.parse(sent)).toEqual({
      ...PREVIEW.event,
      properties: {
        ...PREVIEW.event.properties,
        note: "[worker] at [domain] broke, mail [email]",
      },
    });
    expect(sent).toContain(`"event": "${FAILURE_REPORT_EVENT}"`);
    expect(sent).toContain("PUT /accounts/[account id]/x -> 400");
    expect(sent).not.toContain("ada@example.com");
  });

  it("says a report is still sent when usage data is off", () => {
    expect(render({ ...PREVIEW, usageDataOff: true })).toContain(FAILURE_REPORT_COPY.usageDataOff);
  });

  it("says when the job was already reported, or when this build never sends", () => {
    expect(render({ ...PREVIEW, reportedAt: "2026-09-27T12:00:00.000Z" })).toContain(
      FAILURE_REPORT_COPY.alreadySent,
    );
    expect(render({ ...PREVIEW, devBuild: true })).toContain(FAILURE_REPORT_COPY.devBuild);
  });

  it("thanks the admin once the report is sent", () => {
    expect(renderToStaticMarkup(createElement(ReportSent))).toContain("Thanks, report sent");
  });
});
