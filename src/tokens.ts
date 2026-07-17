import { promises as fs } from "fs";
import * as path from "path";

/**
 * Persistence for linked Plaid items. One entry per institution/bank.
 * Stored in tokens.json at the project root (gitignored — it holds access tokens).
 */
export interface ItemToken {
  item_id: string;
  access_token: string;
  institution_name: string;
  /** Plaid /transactions/sync cursor. null on first sync. */
  cursor: string | null;
}

const TOKENS_PATH = path.join(process.cwd(), "tokens.json");

export async function readTokens(): Promise<ItemToken[]> {
  try {
    const raw = await fs.readFile(TOKENS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ItemToken[]) : [];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/** Atomic write: write to a temp file then rename, so a crash can't corrupt tokens.json. */
async function writeTokens(tokens: ItemToken[]): Promise<void> {
  const tmp = `${TOKENS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2) + "\n", "utf8");
  await fs.rename(tmp, TOKENS_PATH);
}

/**
 * Add a newly linked item without clobbering existing ones.
 * If the item_id already exists, its record is refreshed (access_token /
 * institution updated) but its cursor is preserved.
 */
export async function addToken(token: Omit<ItemToken, "cursor">): Promise<void> {
  const tokens = await readTokens();
  const existing = tokens.find((t) => t.item_id === token.item_id);
  if (existing) {
    existing.access_token = token.access_token;
    existing.institution_name = token.institution_name;
  } else {
    tokens.push({ ...token, cursor: null });
  }
  await writeTokens(tokens);
}

/** Persist the updated sync cursor for a single item. */
export async function updateCursor(
  item_id: string,
  cursor: string
): Promise<void> {
  const tokens = await readTokens();
  const item = tokens.find((t) => t.item_id === item_id);
  if (!item) return;
  item.cursor = cursor;
  await writeTokens(tokens);
}
