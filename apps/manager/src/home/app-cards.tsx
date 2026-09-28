import { Grid, LinkButton, Text } from "@cloudflare/kumo";
import { AppIcon } from "../components/catalog-media";
import { OpenAppButton } from "../components/open-app-button";
import { Section } from "../components/section";
import { StatusDot } from "../components/status-dot";
import { installLabel } from "../installs/display-name";
import { appLine } from "./app-line";
import type { AppSignal } from "./attention";
import type { HomeApp } from "./layout-data";

/**
 * Home's "Your apps": a section with a tile per install, by name, with its
 * icon, its name and one quiet line on its state (`appLine`), then Open (the
 * app at its address, in a new tab, when it has one) and Manage (its page
 * here). The tiles share the section's card, split by hairlines instead of
 * each drawing a card of its own. One column on a phone, with the buttons
 * full width under the text.
 */
export function YourApps({
  apps,
  signals,
  now,
}: {
  apps: readonly HomeApp[];
  signals: ReadonlyMap<string, AppSignal>;
  now: Date;
}) {
  const sorted = [...apps].sort((a, b) =>
    installLabel(a).localeCompare(installLabel(b), undefined, { sensitivity: "base" }),
  );
  return (
    <Section id="your-apps" title="Your apps">
      {/* Every tile draws a hairline on its right and bottom; the grid reaches 1 px
          past the card's body on both sides, which hides the lines at its edges. */}
      <Grid variant="3up" gap="none" className="-mr-px -mb-px">
        {sorted.map((app) => (
          <AppCard key={app.id} app={app} signal={signals.get(app.id)} now={now} />
        ))}
      </Grid>
    </Section>
  );
}

function AppCard({ app, signal, now }: { app: HomeApp; signal: AppSignal | undefined; now: Date }) {
  // Home never shows Worker names, even for two installs of one app.
  const name = installLabel(app);
  return (
    <div
      data-app-card={app.id}
      data-app-name={name}
      className="flex h-full min-w-0 flex-col gap-4 border-r border-b border-kumo-hairline px-5 py-4"
    >
      <div className="flex min-w-0 items-center gap-3">
        <AppIcon src={app.icon} name={app.name} size={40} />
        <div className="grid min-w-0 gap-0.5">
          <Text as="span" bold truncate>
            {name}
          </Text>
          {/* The line wraps (two lines at most) rather than hiding its end. */}
          <span className="flex min-w-0 items-start gap-1.5">
            {signal !== undefined && (
              <span className="flex h-lh items-center text-sm">
                <StatusDot signal={signal} />
              </span>
            )}
            <Text as="span" variant="secondary" size="sm">
              <span className="line-clamp-2 break-words">{appLine(app, signal, now)}</span>
            </Text>
          </span>
        </div>
      </div>
      <div className="mt-auto flex flex-col gap-2 *:w-full *:justify-center sm:flex-row sm:justify-end sm:*:w-auto">
        {app.address !== null && (
          <OpenAppButton href={app.address} label={name} size="sm" variant="primary" />
        )}
        <LinkButton
          href={`/apps/${app.id}`}
          size="sm"
          variant="secondary"
          aria-label={`Manage ${name}`}
        >
          Manage
        </LinkButton>
      </div>
    </div>
  );
}
