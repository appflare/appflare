import { InputGroup } from "@cloudflare/kumo";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useState } from "react";

/**
 * A required, uncontrolled password field with a show/hide button: Kumo's
 * InputGroup password pattern. `autoComplete` tells password managers whether
 * to fill a saved password (`current-password`) or offer a new one
 * (`new-password`). The field is named by `label`, as Kumo asks of an
 * InputGroup input.
 */
export function PasswordInput({
  label,
  name,
  autoComplete,
  description,
  minLength,
  maxLength,
}: {
  label: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  description?: string;
  minLength?: number;
  maxLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup label={label} description={description}>
      <InputGroup.Input
        // Kumo's InputGroup draws `label` above the field, but its Input only
        // counts its own aria-label or aria-labelledby (and warns without).
        aria-label={label}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        minLength={minLength}
        maxLength={maxLength}
      />
      <InputGroup.Addon align="end">
        <InputGroup.Button
          shape="square"
          className="text-kumo-subtle"
          icon={visible ? EyeSlashIcon : EyeIcon}
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible((shown) => !shown)}
        />
      </InputGroup.Addon>
    </InputGroup>
  );
}
