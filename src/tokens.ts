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
 * Add a newly linked item without clobbering *other* institutions.
 *
 * Re-linking is the expected way to grant a new product's consent (e.g.
 * Liabilities) to a card. Plaid's standard Link flow mints a fresh item_id each
 * time, so we dedupe by institution instead:
 *   - Same item_id  → refresh access_token in place, keep the cursor.
 *   - Same institution_name, different item_id (a genuine re-link) → REPLACE the
 *     old record: adopt the new item_id + access_token and reset the cursor to
 *     null, so the next sync re-pulls cleanly against the new item. This prevents
 *     the duplicate-item double-counting a naive append would cause.
 *   - Otherwise → append as a new institution.
 *
 * (This setup treats one institution as one login. If you ever link two distinct
 * logins at the same institution, the second would replace the first — not a case
 * that exists here.)
 */
export async function addToken(token: Omit<ItemToken, "cursor">): Promise<void> {
  const tokens = await readTokens();

  const byId = tokens.find((t) => t.item_id === token.item_id);
  if (byId) {
    byId.access_token = token.access_token;
    byId.institution_name = token.institution_name;
    await writeTokens(tokens);
    return;
  }

  const byInstitution = tokens.find(
    (t) => t.institution_name === token.institution_name
  );
  if (byInstitution) {
    byInstitution.item_id = token.item_id;
    byInstitution.access_token = token.access_token;
    byInstitution.cursor = null; // new item — re-pull from scratch
    await writeTokens(tokens);
    return;
  }

  tokens.push({ ...token, cursor: null });
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

/**
 * Clear every item's sync cursor (back to null) so the next `npm run sync`
 * re-pulls the full available history from Plaid. Because the Transactions tab
 * upserts on `transaction_id`, that re-pull rewrites existing rows in place
 * (no duplicates) — the intended way to normalize older rows to the current
 * shape (display-signed amounts, humanized categories). Local file write only;
 * the actual re-pull happens on the next sync. Returns the number reset.
 */
export async function resetCursors(): Promise<number> {
  const tokens = await readTokens();
  let reset = 0;
  for (const t of tokens) {
    if (t.cursor !== null) reset++;
    t.cursor = null;
  }
  await writeTokens(tokens);
  return reset;
}
