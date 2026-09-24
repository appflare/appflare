import { InputGroup } from "@cloudflare/kumo";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useState } from "react";

/**
 * A required, uncontrolled password field with a show/hide button: Kumo's
 * InputGroup password pattern. `autoComplete` tells password managers whether
 * to fill a saved password (`current-password`) or offer a new one
 * (`new-password`).
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
