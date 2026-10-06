import { Switch, Text } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { WORKERS_DEV_COPY } from "../installs/workers-dev";
import { setWorkersDev } from "../installs/workers-dev.functions";
import { ErrorMessageBanner } from "./message-text";
import { SectionBody } from "./section";
import { NEW_ADDRESS_SETTINGS, useSettingsRefresh } from "./settings-refresh";

/**
 * `/apps/$installId`, "Serve on workers.dev" (admins): turns the app's
 * workers.dev URL off or on. Off is offered only while the app has a custom
 * or external domain, and the server checks that one of them answers as the
 * app first. While Appflare turned it off because a domain went live, a
 * one-line note says so; using the switch makes it the admin's choice.
 */
export function WorkersDevSwitch({ install }: { install: InstallDetail }) {
  const router = useRouter();
  const settingsRefresh = useSettingsRefresh();
  const [enabled, setEnabled] = useState(install.workersDevEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (install.build.kind === "self-deploying") return null;

  async function onChange(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    setError(null);
    try {
      const changed = await setWorkersDev({ data: { installId: install.id, enabled: next } });
      await router.invalidate();
      await settingsRefresh(changed, NEW_ADDRESS_SETTINGS);
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "Could not change the workers.dev URL.");
    }
    setPending(false);
  }

  const idle = install.status === "installed" && install.activeJobId === null;
  const domains = install.domains.length + install.externalDomains.length;
  // Turning it off needs another address; turning it back on never does.
  const canChange = idle && (!enabled || domains > 0);
  // The note stands for the stored state; a change in flight reloads the page.
  const note = enabled === install.workersDevEnabled ? install.workersDevNote : null;
  return (
    <SectionBody className="gap-1">
      <Switch
        label={WORKERS_DEV_COPY.label}
        checked={enabled}
        disabled={!canChange || pending}
        onCheckedChange={(next: boolean) => void onChange(next)}
      />
      {note === "auto-off" && (
        <Text as="span" size="sm">
          {WORKERS_DEV_COPY.autoOff}
        </Text>
      )}
      <Text variant="secondary" size="sm">
        {!enabled
          ? WORKERS_DEV_COPY.offHelp
          : note === "settings"
            ? WORKERS_DEV_COPY.settingsKeep
            : domains === 0
              ? WORKERS_DEV_COPY.noDomain
              : WORKERS_DEV_COPY.onHelp(install.workersDevUrl ?? "its workers.dev URL")}
      </Text>
      {error !== null && <ErrorMessageBanner message={error} />}
    </SectionBody>
  );
}
