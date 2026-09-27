import { Banner, LayerCard, Link, Radio, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { DocsLink } from "../components/docs-link";
import { settingsLink } from "../components/settings-links";
import type { InstallDetail } from "../installs/installs.functions";
import {
  AUTO_UPDATE_CHOICES,
  AUTO_UPDATE_COPY,
  type AutoUpdateChoice,
  effectiveAutoUpdate,
} from "./auto-update";
import { setInstallAutoUpdate } from "./auto-update.functions";

function isChoice(value: string): value is AutoUpdateChoice {
  return (AUTO_UPDATE_CHOICES as readonly string[]).includes(value);
}

/**
 * `/apps/$installId`, "Automatic updates": whether the cron may update this
 * app on its own, following the account default (Settings) or overriding it.
 * Admins change it; members see it.
 */
export function InstallAutoUpdateCard({
  install,
  isAdmin,
}: {
  install: InstallDetail;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<AutoUpdateChoice>(install.autoUpdate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: string) {
    if (!isChoice(next) || next === choice) return;
    const previous = choice;
    setChoice(next);
    setPending(true);
    setError(null);
    try {
      await setInstallAutoUpdate({ data: { installId: install.id, choice: next } });
      await router.invalidate();
    } catch (err) {
      setChoice(previous);
      setError(err instanceof Error ? err.message : "Could not save the choice.");
    }
    setPending(false);
  }

  const on = effectiveAutoUpdate(choice, install.autoUpdateDefault);
  const needsApproval = install.build.kind !== "artifact";
  return (
    // The radio group's legend titles the card; each choice says what it does.
    <LayerCard>
      <LayerCard.Primary className="grid gap-3 px-5 py-4">
        <Radio.Group
          legend={AUTO_UPDATE_COPY.installLegend}
          description={
            <>
              <Link href={settingsLink("general", "automatic-updates")}>Change the default</Link>
              {" · "}
              <DocsLink topic="automaticUpdates" variant="inline" />
            </>
          }
          value={choice}
          onValueChange={(next: string) => void onChange(next)}
          disabled={!isAdmin || pending}
          appearance="card"
        >
          <Radio.Item
            label={AUTO_UPDATE_COPY.choiceLabels.inherit(install.autoUpdateDefault)}
            description={AUTO_UPDATE_COPY.inheritDescription}
            value="inherit"
          />
          <Radio.Item
            label={AUTO_UPDATE_COPY.choiceLabels.on}
            // For an app whose updates an admin approves, "On" changes nothing yet; say so.
            description={
              needsApproval ? AUTO_UPDATE_COPY.installOnNeedsApproval : AUTO_UPDATE_COPY.installOn
            }
            value="on"
          />
          <Radio.Item
            label={AUTO_UPDATE_COPY.choiceLabels.off}
            description={AUTO_UPDATE_COPY.installOff}
            value="off"
          />
        </Radio.Group>
        {/* The choices describe themselves; only an app the cron never updates needs a word more. */}
        {needsApproval && (
          <Text variant="secondary" size="sm">
            {AUTO_UPDATE_COPY.needsApproval}
          </Text>
        )}
        {on &&
          !needsApproval &&
          install.updateAvailable &&
          install.autoUpdateWaiting !== null &&
          install.autoUpdateWaiting === install.latestVersion && (
            <Text variant="secondary" size="sm">
              {AUTO_UPDATE_COPY.waiting(install.autoUpdateWaiting)}
            </Text>
          )}
        {!isAdmin && (
          <Text variant="secondary" size="sm">
            Only admins can change it.
          </Text>
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
