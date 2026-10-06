import { Select } from "@cloudflare/kumo/components/select";
import { useTheme } from "@fumadocs/base-ui/provider/base";
import { useSyncExternalStore } from "react";

const CHOICES = { light: "Light", dark: "Dark", system: "System" } as const;
type Choice = keyof typeof CHOICES;

const isChoice = (value: unknown): value is Choice =>
  typeof value === "string" && Object.hasOwn(CHOICES, value);

const noop = () => () => {};

/**
 * Light, dark, or follow the system, like the switch in the rest of the
 * site's header, and remembered with it. Until the page runs, it shows
 * the site's default (light).
 */
export function Appearance() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const value: Choice = mounted && isChoice(theme) ? theme : "light";
  return (
    <Select
      aria-label="Appearance"
      size="sm"
      className="w-28 max-sm:h-11"
      value={value}
      onValueChange={(next) => {
        if (isChoice(next)) setTheme(next);
      }}
      items={CHOICES}
    />
  );
}
