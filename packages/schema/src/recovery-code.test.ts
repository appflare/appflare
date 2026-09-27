import { describe, expect, it } from "vitest";
import {
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  parseRecoveryCodeSecret,
  recoveryCodeSecretValue,
} from "./recovery-code";

describe("recovery codes", () => {
  it("are four groups of five characters from the unambiguous alphabet", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it("normalizes what people type: case, spaces and dashes do not matter", () => {
    const code = generateRecoveryCode();
    const typed = ` ${code.toLowerCase().replace(/-/g, " ")} `;
    expect(normalizeRecoveryCode(typed)).toBe(code.replace(/-/g, ""));
  });

  it("refuses input that cannot be a code", () => {
    expect(normalizeRecoveryCode("")).toBeNull();
    expect(normalizeRecoveryCode("ABCDE-FGHJK-LMNPQ")).toBeNull();
    // 0, O, 1 and I are not in the alphabet.
    expect(normalizeRecoveryCode("ABCDE-FGHJK-LMNPQ-RST0O")).toBeNull();
  });

  it("round-trips the secret value, and hashes the normalized code", async () => {
    const code = generateRecoveryCode();
    const value = await recoveryCodeSecretValue(code, 1_800_000);
    expect(value).not.toContain(code.replace(/-/g, ""));
    const parsed = parseRecoveryCodeSecret(value);
    expect(parsed).toEqual({
      expiresAt: 1_800_000,
      hash: await hashRecoveryCode(normalizeRecoveryCode(code) as string),
      emailBound: false,
    });
  });

  it("binds a code to one email, ignoring its case", async () => {
    const code = generateRecoveryCode();
    const normalized = normalizeRecoveryCode(code) as string;
    const parsed = parseRecoveryCodeSecret(
      await recoveryCodeSecretValue(code, 1_800_000, " Ada@Example.com "),
    );
    expect(parsed?.emailBound).toBe(true);
    expect(parsed?.hash).toBe(await hashRecoveryCode(normalized, "ada@example.com"));
    expect(parsed?.hash).not.toBe(await hashRecoveryCode(normalized));
    expect(parsed?.hash).not.toBe(await hashRecoveryCode(normalized, "bob@example.com"));
  });

  it("reads nothing from a missing or malformed secret", () => {
    expect(parseRecoveryCodeSecret(undefined)).toBeNull();
    expect(parseRecoveryCodeSecret("")).toBeNull();
    expect(parseRecoveryCodeSecret(`v2.1.${"a".repeat(64)}`)).toBeNull();
    expect(parseRecoveryCodeSecret(`v1.x.${"a".repeat(64)}`)).toBeNull();
    expect(parseRecoveryCodeSecret(`v1.1.${"a".repeat(63)}`)).toBeNull();
  });
});
