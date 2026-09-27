import { Switch, Text } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { DocsLink } from "../components/docs-link";
import { ErrorMessageBanner } from "../components/message-text";
import { Section, SectionBody } from "../components/section";
import { settingsSection } from "../components/settings-links";
import { AUTO_UPDATE_COPY, type AutoUpdateSettings } from "./auto-update";
import { setAutoUpdateDefaults } from "./auto-update.functions";

/**
 * The automatic update switches: "Automatically update apps" (the default of
 * every app that follows it), the first section of the Updates settings,
 * and "Automatically update Appflare", a row of its Appflare version
 * section. Admins change them; members see them. A switch saves on change.
 */

/** Saves one switch at once; the switch goes back when the save fails. */
function useAutoUpdateSwitch(initial: boolean, key: "apps" | "manager") {
  const router = useRouter();
  const [checked, setChecked] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: boolean) {
    const previous = checked;
    setChecked(next);
    setPending(true);
    setError(null);
    try {
      await setAutoUpdateDefaults({ data: key === "apps" ? { apps: next } : { manager: next } });
      await router.invalidate();
    } catch (err) {
      setChecked(previous);
      setError(err instanceof Error ? err.message : "Could not save the setting.");
    }
    setPending(false);
  }

  return { checked, pending, error, save };
}

function MembersNote({ isAdmin }: { isAdmin: boolean }) {
  if (isAdmin) return null;
  return (
    <Text variant="secondary" size="sm">
      {AUTO_UPDATE_COPY.membersOnly}
    </Text>
  );
}

/** The Updates settings' automatic app updates section. */
export function AppsAutomaticUpdatesSection({
  settings,
  isAdmin,
}: {
  settings: AutoUpdateSettings;
  isAdmin: boolean;
}) {
  const { checked, pending, error, save } = useAutoUpdateSwitch(settings.apps, "apps");
  return (
    <Section
      {...settingsSection("updates", "apps")}
      description="Whether apps update on their own when a new version needs nothing from you."
      error={error}
    >
      <SectionBody>
        <div className="grid gap-1">
          <Switch
            label={AUTO_UPDATE_COPY.appsLabel}
            checked={checked}
            disabled={!isAdmin || pending}
            onCheckedChange={(next: boolean) => void save(next)}
          />
          <Text variant="secondary" size="sm">
            {AUTO_UPDATE_COPY.appsHelp} <DocsLink topic="automaticUpdates" variant="inline" />
          </Text>
        </div>
        <MembersNote isAdmin={isAdmin} />
      </SectionBody>
    </Section>
  );
}

/** "Automatically update Appflare", for the Appflare version section of the Updates settings. */
export function AppflareAutomaticUpdates({
  settings,
  isAdmin,
}: {
  settings: AutoUpdateSettings;
  isAdmin: boolean;
}) {
  const { checked, pending, error, save } = useAutoUpdateSwitch(settings.manager, "manager");
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Switch
          label={AUTO_UPDATE_COPY.managerLabel}
          checked={checked}
          disabled={!isAdmin || pending}
          onCheckedChange={(next: boolean) => void save(next)}
        />
        <Text variant="secondary" size="sm">
          {AUTO_UPDATE_COPY.managerHelp}{" "}
          <DocsLink topic="appflareAutomaticUpdates" variant="inline" />
        </Text>
        {settings.devBuild && (
          <Text variant="secondary" size="sm">
            {AUTO_UPDATE_COPY.devBuild}
          </Text>
        )}
      </div>
      <MembersNote isAdmin={isAdmin} />
      {error !== null && <ErrorMessageBanner message={error} />}
    </div>
  );
}
