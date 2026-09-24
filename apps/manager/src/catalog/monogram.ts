/**
 * The two letters shown in place of an app's icon, or a person's avatar,
 * when there is no image: "UniFi DDNS" → "UD", "FlareMo" → "FM", "Cut" →
 * "CU". Letters and digits only; always upper case. Client-safe.
 */
export function monogram(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => Array.from(w))
    .filter((w) => w.length > 0);
  const [first, second] = words;
  if (first === undefined) return "?";
  const initial = first[0] ?? "";
  if (second !== undefined) return `${initial}${second[0] ?? ""}`.toLocaleUpperCase("en");
  // One word: its first letter and the next capital (camel case), else its second letter.
  const capital = first.slice(1).find((c) => /\p{Lu}/u.test(c));
  return `${initial}${capital ?? first[1] ?? ""}`.toLocaleUpperCase("en");
}
