import { Banner, CodeBlock, Collapsible, LayerCard, Loader, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { TELEMETRY_COPY, type TelemetryStatus } from "../telemetry/telemetry";
import { previewTelemetry, setTelemetry } from "../telemetry/telemetry.functions";
import { UsageDataSwitch, WhatIsSentLink } from "./usage-data-notice";

/**
 * Settings, Usage data: the notice, the switch (admins change it, members
 * see it; off and disabled while a Worker variable turns usage data off),
 * and a preview of the next daily report, built on request.
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

  const unanswered = status.state === "unset" && status.lockedBy === null;
  return (
    // The switch shows the choice; the page title names the card. What is sent in the end
    // (nothing from a development build, whatever the switch says) is spelled out below it.
    <LayerCard>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text variant="secondary">{TELEMETRY_COPY.notice}</Text>
        <UsageDataSwitch
          status={status}
          checked={enabled}
          disabled={!isAdmin || pending}
          onChange={(next) => void onChange(next)}
        />
        {unanswered && (
          <Text variant="secondary" size="sm">
            {TELEMETRY_COPY.unanswered}
          </Text>
        )}
        {!isAdmin && status.lockedBy === null && (
          <Text variant="secondary" size="sm">
            {TELEMETRY_COPY.membersOnly}
          </Text>
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <WhatIsSentLink />
        <Collapsible.Root onOpenChange={(open) => void onPreviewOpen(open)}>
          <Collapsible.DefaultTrigger>{TELEMETRY_COPY.preview}</Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel className="grid gap-2">
            <Text variant="secondary" size="sm">
              {TELEMETRY_COPY.previewDescription}
            </Text>
            {previewFailure !== null ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title={previewFailure}
              />
            ) : preview === null ? (
              <Loader size="sm" />
            ) : (
              <CodeBlock lang="jsonc" code={preview} />
            )}
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      </LayerCard.Primary>
    </LayerCard>
  );
}
