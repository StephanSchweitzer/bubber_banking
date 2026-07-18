import { readTokens, resetCursors } from "./tokens";

/**
 * One-time maintenance helper: clears every linked item's `/transactions/sync`
 * cursor so the next `npm run sync` re-pulls the full available history from
 * Plaid. Existing rows upsert in place (keyed on `transaction_id`), so this is
 * how you normalize older rows to the current shape — display-signed amounts and
 * humanized categories — without creating duplicates.
 *
 * This only edits the local `tokens.json`; nothing hits Plaid or the sheet until
 * you run `npm run sync` afterwards (which will pull more data than a normal
 * incremental run).
 */
async function main(): Promise<void> {
  const tokens = await readTokens();
  if (tokens.length === 0) {
    console.log("No linked institutions found (tokens.json is empty or missing).");
    return;
  }
  const reset = await resetCursors();
  console.log(
    `Reset ${reset} of ${tokens.length} item cursor(s). ` +
      `The next \`npm run sync\` will re-pull full history and rewrite existing rows.`
  );
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
