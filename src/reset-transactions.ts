import { google } from "googleapis";
import { config, TRANSACTIONS_TAB } from "./config";
import { resetCursors } from "./tokens";

/**
 * Recovery helper: wipe the Transactions data rows (keeping the header) AND reset
 * every sync cursor, so the next `npm run sync` rebuilds the ledger from scratch —
 * one clean, correctly-aligned row per transaction from the currently-linked items.
 *
 * Use this to recover from a corrupted ledger (e.g. column-shifted rows, or
 * duplicate rows left behind after re-linking created new transaction_ids).
 *
 * DESTRUCTIVE to the Transactions tab's current contents, but fully rebuildable:
 * Plaid re-supplies the full history on the next sync. It does NOT touch the
 * Budget tab (clear those rows by hand if needed) or any other tab.
 */
async function main(): Promise<void> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const api = google.sheets({ version: "v4", auth: (await auth.getClient()) as any });

  // Clear data rows only (row 1 header stays intact).
  await api.spreadsheets.values.clear({
    spreadsheetId: config.google.sheetId,
    range: `${TRANSACTIONS_TAB}!A2:H`,
  });

  const reset = await resetCursors();
  console.log(
    `Cleared the Transactions data rows and reset ${reset} cursor(s). ` +
      `Run \`npm run sync\` to rebuild the ledger cleanly.`
  );
}

main().catch((err) => {
  console.error("reset-transactions failed:", err?.response?.data ?? err);
  process.exit(1);
});
