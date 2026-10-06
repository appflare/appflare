import { AppflareLoader } from "@appflare/brand/loader";
import { CodeBlock, Collapsible, Text } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { TELEMETRY_COPY, type TelemetryStatus } from "../telemetry/telemetry";
import { previewTelemetry, setTelemetry } from "../telemetry/telemetry.functions";
import { ErrorMessageBanner } from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsSection } from "./settings-links";
import { UsageDataBenefits, UsageDataSummary, UsageDataSwitch } from "./usage-data-parts";

/**
 * The usage data settings' one section: what it is for, the switch (admins change it,
 * members see it; off and disabled while a Worker variable turns usage data
 * off), what is and is not sent, and a preview of the next daily report,
 * built on request.
 */
export function UsageDataCard({ status, isAdmin }: { status: TelemetryStatus; isAdmin: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(status.state === "on");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);

  async function onChange(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    setError(null);
    try {
      await setTelemetry({ data: { enabled: next } });
      await router.invalidate();
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "Could not save the choice.");
    }
    setPending(false);
  }

  async function onPreviewOpen(open: boolean) {
    if (!open || preview !== null) return;
    setPreviewFailure(null);
    try {
      setPreview(await previewTelemetry());
    } catch (err) {
      setPreviewFailure(err instanceof Error ? err.message : "Could not build the preview.");
    }
  }

  return (
    // The switch shows the choice. What is sent in the end (nothing from a
    // development build, whatever the switch says) is spelled out below it.
    <Section
      {...settingsSection("usageData", "usage-data")}
      description="What the report is for, what it holds, and the switch that turns it off."
      error={error}
    >
      <SectionBody>
        <UsageDataBenefits />
        <UsageDataSwitch
          status={status}
          checked={enabled}
          disabled={!isAdmin || pending}
          onChange={(next) => void onChange(next)}
        />
        {!isAdmin && status.lockedBy === null && (
          <Text variant="secondary" size="sm">
            {TELEMETRY_COPY.membersOnly}
          </Text>
        )}
        <UsageDataSummary />
        <Collapsible.Root onOpenChange={(open) => void onPreviewOpen(open)}>
          <Collapsible.DefaultTrigger>{TELEMETRY_COPY.preview}</Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel className="grid gap-2">
            <Text variant="secondary" size="sm">
              {TELEMETRY_COPY.previewDescription}
            </Text>
            {previewFailure !== null ? (
              <ErrorMessageBanner message={previewFailure} />
            ) : preview === null ? (
              <AppflareLoader size="sm" />
            ) : (
              <CodeBlock lang="jsonc" code={preview} />
            )}
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      </SectionBody>
    </Section>
  );
}
