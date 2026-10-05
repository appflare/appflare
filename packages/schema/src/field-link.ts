import { z } from "zod";

/** The longest label of a field's link, in characters: it sits beside the field's help. */
export const MAX_FIELD_LINK_LABEL_LENGTH = 40;

/** The longest address of a field's link, in characters. */
export const MAX_FIELD_LINK_URL_LENGTH = 500;

/**
 * An https:// URL with a host and no user name or password before it, and no
 * spaces or control characters. The check runs on the value as written, since
 * `z.url` would first trim it and drop tabs and newlines; it states the same
 * rule in the JSON Schema, and `URL` then checks that it parses.
 */
const FIELD_LINK_URL_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  /^https:\/\/[^\s\x00-\x1f\x7f/?#@\\]+(?:[/?#][^\s\x00-\x1f\x7f\\]*)?$/;

/** Characters that draw nothing or turn the text around: no part of a link's label. */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A link beside one field of the install and settings forms (a catalog
 * secret's or var's `link`), such as where to create the API key the field
 * asks for. The forms show `label` as a link that opens `url` in a new tab,
 * without telling the site where the admin came from. Help text stays plain
 * text; this is how an entry links out from a field.
 */
export const catalogFieldLinkSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(MAX_FIELD_LINK_LABEL_LENGTH)
      .regex(/^\S(?:[^\r\n]*\S)?$/, "must be one line without leading or trailing spaces")
      .refine((label) => !INVISIBLE_CHARACTERS.test(label), "must not contain invisible characters")
      .describe(
        `What the link says, in a few plain words (at most ${MAX_FIELD_LINK_LABEL_LENGTH} ` +
          "characters), for example `Get a key` or `Create a bot`. The forms add the mark of a link that opens in a new tab.",
      ),
    url: z
      .string()
      .max(MAX_FIELD_LINK_URL_LENGTH)
      .regex(
        FIELD_LINK_URL_PATTERN,
        "must be an https:// URL without spaces, user name or password",
      )
      .refine(isHttpsUrl, "must be an https:// URL")
      .describe(
        "Where the link goes, as an https:// URL without a user name or password, at most " +
          `${MAX_FIELD_LINK_URL_LENGTH} characters, for example ` +
          "`https://openrouter.ai/settings/keys`.",
      ),
  })
  .describe(
    "A link shown beside the field in the install and settings forms, opened in a new tab: " +
      "where to get the value, such as the page that creates an API key. Help text is shown as " +
      "plain text, so put the link here rather than in `help`.",
  );
export type CatalogFieldLink = z.infer<typeof catalogFieldLinkSchema>;
