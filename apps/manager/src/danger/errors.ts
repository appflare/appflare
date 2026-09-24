export const OWNER_ONLY = "Only the owner can rotate the auth secret or remove Appflare.";

/**
 * A refused danger-zone action: its message is shown to the owner as is,
 * and `status` is the HTTP status of the page that shows it.
 */
export class DangerError extends Error {
  override name = "DangerError";
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 502 = 400,
  ) {
    super(message);
  }
}
