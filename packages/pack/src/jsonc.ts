/**
 * A small, string-aware JSONC parser: strips `//` and block comments and
 * trailing commas, then hands the result to `JSON.parse`. Used for the
 * human-authored catalog manifest (`appflare.jsonc`); the wrangler config is
 * read by wrangler's own parser via `unstable_readConfig`.
 */

/** Removes `//` line comments and block comments without touching string bodies. */
function stripComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < input.length; ) {
    const ch = input[i] as string;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Drops commas that are immediately followed (past whitespace) by `}` or `]`. */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < input.length; ) {
    const ch = input[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j] as string)) {
        j++;
      }
      if (j < input.length && (input[j] === "}" || input[j] === "]")) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Parses JSONC (comments + trailing commas) into a plain JS value. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}
