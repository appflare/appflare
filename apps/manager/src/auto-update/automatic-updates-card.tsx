import { Banner, LayerCard, Switch, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AUTO_UPDATE_COPY, type AutoUpdateSettings } from "./auto-update";
import { setAutoUpdateDefaults } from "./auto-update.functions";

/**
 * Settings, "Automatic updates": "Automatically update apps" (the default of
 * every app that follows it) on General, or "Automatically update Appflare"
 * on Appflare updates, as `which` says. Admins change them; members see them.
 */
export function AutomaticUpdatesCard({
  settings,
  isAdmin,
  which,
}: {
  settings: AutoUpdateSettings;
  isAdmin: boolean;
  which: "apps" | "manager";
}) {
  const router = useRouter();
  const [apps, setApps] = useState(settings.apps);
  const [manager, setManager] = useState(settings.manager);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(change: { apps?: boolean; manager?: boolean }) {
    const previous = { apps, manager };
    if (change.apps !== undefined) setApps(change.apps);
    if (change.manager !== undefined) setManager(change.manager);
    setPending(true);
    setError(null);
    try {
      await setAutoUpdateDefaults({ data: change });
      await router.invalidate();
    } catch (err) {
      setApps(previous.apps);
      setManager(previous.manager);
      setError(err instanceof Error ? err.message : "Could not save the setting.");
    }
    setPending(false);
  }

  return (
    <LayerCard>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        {which === "apps" ? (
          <div className="grid gap-1">
            <Switch
              label={AUTO_UPDATE_COPY.appsLabel}
              checked={apps}
              disabled={!isAdmin || pending}
              onCheckedChange={(next: boolean) => void save({ apps: next })}
            />
            <Text variant="secondary" size="sm">
              {AUTO_UPDATE_COPY.appsHelp}
            </Text>
          </div>
        ) : (
          <div className="grid gap-1">
            <Switch
              label={AUTO_UPDATE_COPY.managerLabel}
              checked={manager}
              disabled={!isAdmin || pending}
              onCheckedChange={(next: boolean) => void save({ manager: next })}
            />
            <Text variant="secondary" size="sm">
              {AUTO_UPDATE_COPY.managerHelp}
            </Text>
            {settings.devBuild && (
              <Text variant="secondary" size="sm">
                {AUTO_UPDATE_COPY.devBuild}
              </Text>
            )}
          </div>
        )}
        {!isAdmin && (
          <Text variant="secondary" size="sm">
            {AUTO_UPDATE_COPY.membersOnly}
          </Text>
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
