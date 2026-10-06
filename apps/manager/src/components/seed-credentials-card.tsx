import { Banner, ClipboardText, Text } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { BANNER_ICON } from "./message-text";
import { Section, SectionBody } from "./section";
import { forgetSeedCredentials, peekSeedCredentials } from "./seed-credentials";

/**
 * The generated seed-only secrets of an install this tab just started (its
 * first admin's password, say), shown once on the install's job page with a
 * copy button each. Read when the page first renders and forgotten at once,
 * so leaving or reloading the page drops them for good.
 */
export function SeedCredentialsCard({ jobId }: { jobId: string }) {
  // Read without forgetting, so a render React repeats sees the same values.
  const [credentials] = useState(() => peekSeedCredentials(jobId));
  useEffect(() => forgetSeedCredentials(jobId), [jobId]);
  if (credentials.length === 0) return null;
  return (
    <Section title="First sign-in">
      <SectionBody>
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title="Copy it now"
          description="The install uses it once to create the first admin account. Appflare does not keep it, and this page shows it only until you leave."
        />
        {credentials.map((c) => (
          <div key={c.name} className="grid gap-1.5">
            <Text bold>
              {c.label} ({c.name})
            </Text>
            <ClipboardText text={c.value} />
          </div>
        ))}
      </SectionBody>
    </Section>
  );
}
