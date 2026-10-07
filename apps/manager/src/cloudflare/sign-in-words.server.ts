import { connectionKindOf } from "./connection.server";
import { hasTokenWords, inConnectionWords } from "./sign-in-words";

/**
 * `message` in the words for how this manager connects now
 * (`inConnectionWords`). Reads the connection (one D1 read) only when the
 * message holds a token message; on a read failure keeps it as it is.
 */
export async function inConnectionWordsOf(db: D1Database, message: string): Promise<string> {
  if (!hasTokenWords(message)) return message;
  const kind = await connectionKindOf(db).catch(() => "api_token" as const);
  return inConnectionWords(kind, message);
}
