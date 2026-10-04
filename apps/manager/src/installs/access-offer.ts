import { type AccessOffer, accessOfferOf, type CatalogAccess } from "@appflare/schema";

/**
 * How an app's catalog entry offers Cloudflare Access protection, and what
 * an install or a change of protection may ask for. Client-safe: the install
 * form and the server share it.
 *
 * - `required`: installed only protected; protection cannot be turned off.
 * - `recommended`: the install form's switch starts on.
 * - `offered` (no `access.mode`): the switch starts off.
 */

/** Why an app whose entry requires protection is not installed without it. */
export function accessRequiredRefusal(appName: string): string {
  return `${appName} must be protected with Cloudflare Access: its catalog entry requires it, since the app relies on Access to keep people out. Install it with protection on.`;
}

/** Why the protection of such an app cannot be turned off. */
export function accessRequiredOffRefusal(appName: string): string {
  return `${appName} must stay protected with Cloudflare Access: its catalog entry requires it, since the app relies on Access to keep people out, so its protection cannot be turned off. Uninstall the app instead.`;
}

/** Whether the install form's protection switch starts on. */
export function accessStartsOn(catalog: { access?: CatalogAccess | undefined }): boolean {
  return accessOfferOf(catalog) !== "offered";
}

/**
 * Whether an install starting with `requested` (the form's switch; absent
 * from a form or a caller that does not know it) is protected: an entry
 * that requires protection is protected when nothing was asked, and refuses
 * a start that asks for none. Otherwise only an explicit `true` protects.
 */
export function installAccessChoice(
  catalog: { name: string; access?: CatalogAccess | undefined },
  requested: boolean | undefined,
): { ok: true; access: boolean; offer: AccessOffer } | { ok: false; error: string } {
  const offer = accessOfferOf(catalog);
  if (offer === "required") {
    if (requested === false) return { ok: false, error: accessRequiredRefusal(catalog.name) };
    return { ok: true, access: true, offer };
  }
  return { ok: true, access: requested === true, offer };
}
