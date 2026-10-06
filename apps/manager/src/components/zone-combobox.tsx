import { Combobox } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/** A zone of the account, as the pickers list them. */
export interface ZoneChoice {
  id: string;
  name: string;
}

/**
 * Picks one of the account's zones (its domains on Cloudflare): Kumo's
 * Combobox, its trigger showing the chosen domain, with a search field at
 * the top of its list, since an account may hold many domains. `value` and
 * `onChange` speak in zone ids.
 */
export function ZoneCombobox({
  zones,
  value,
  onChange,
  label = "Domain",
  description,
  placeholder = "Choose a domain",
  disabled = false,
}: {
  zones: readonly ZoneChoice[];
  value: string | null;
  onChange(zoneId: string): void;
  label?: string;
  description?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
}) {
  const selected = zones.find((z) => z.id === value) ?? null;
  return (
    <Combobox
      label={label}
      description={description}
      items={zones}
      value={selected}
      onValueChange={(next) => {
        const zone = next as ZoneChoice | null;
        if (zone !== null) onChange(zone.id);
      }}
      isItemEqualToValue={(a: ZoneChoice, b: ZoneChoice) => a.id === b.id}
      itemToStringLabel={(z: ZoneChoice) => z.name}
      disabled={disabled}
    >
      <Combobox.TriggerValue className="w-full" placeholder={placeholder} />
      <Combobox.Content>
        {/* Named by the field's label, as Base UI labels it, like the trigger. */}
        <Combobox.Input placeholder="Search your domains…" />
        <Combobox.Empty>No domain matches.</Combobox.Empty>
        <Combobox.List>
          {(zone: ZoneChoice) => (
            <Combobox.Item key={zone.id} value={zone}>
              <span translate="no">{zone.name}</span>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}
