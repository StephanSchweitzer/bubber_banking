import { google, sheets_v4 } from "googleapis";
import { config, BALANCE_HISTORY_TAB } from "./config";
import { readTokens } from "./tokens";
import {
  AccountSnapshot,
  fetchSnapshot,
  buildColumns,
  buildRow,
  periodKeys,
} from "./balances";
import { SnapshotSheet } from "./snapshot-sheet";

/**
 * Balance history snapshot. Pulls current credit limits, payments due, and cash
 * from Plaid and records one row per day into the hidden Balance History tab, so
 * the net-worth / owed / limit trend is preserved over time. (The Daily / Weekly
 * / Monthly / Yearly tabs now show current-period budgeting — see `periods.ts`.)
 *
 * Additive and lossless: it never touches the Transactions, Budget, or period
 * tabs. Runnable standalone (`npm run snapshot`) and also invoked by `npm run
 * sync`, which passes in already-fetched balances so Plaid is hit only once.
 */

async function sheetsApi(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: (await auth.getClient()) as any });
}

/** Ensure the hidden Balance History tab exists; return its numeric gid. */
async function ensureHistoryTab(api: sheets_v4.Sheets): Promise<number> {
  const meta = await api.spreadsheets.get({ spreadsheetId: config.google.sheetId });
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.title === BALANCE_HISTORY_TAB && s.properties.sheetId != null) {
      return s.properties.sheetId;
    }
  }
  // Create it hidden — it's an archive, not a day-to-day view.
  const res = await api.spreadsheets.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: BALANCE_HISTORY_TAB, hidden: true } } },
      ],
    },
  });
  const id = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (id == null) throw new Error("Failed to create the Balance History tab.");
  return id;
}

/**
 * Fetch balances (unless provided) and record one daily row into Balance History.
 * Best-effort per run.
 */
export async function runSnapshot(accounts?: AccountSnapshot[]): Promise<void> {
  const tokens = await readTokens();
  if (tokens.length === 0) {
    console.log("Snapshot: no linked institutions — skipping.");
    return;
  }

  const now = new Date();
  const resolved = accounts ?? (await fetchSnapshot(tokens));
  if (resolved.length === 0) {
    console.log("Snapshot: no credit/deposit accounts found — skipping.");
    return;
  }

  const columns = buildColumns(resolved);
  const dailyKey = periodKeys(now).daily; // one archived row per day
  const takenAt = now.toISOString().replace("T", " ").slice(0, 16); // "YYYY-MM-DD HH:MM"

  const api = await sheetsApi();
  const historyId = await ensureHistoryTab(api);
  const sheet = new SnapshotSheet(api, new Map([[BALANCE_HISTORY_TAB, historyId]]));
  await sheet.upsert(BALANCE_HISTORY_TAB, columns, buildRow(resolved, dailyKey, takenAt));

  const credit = resolved.filter((a) => a.kind === "credit").length;
  const bank = resolved.filter((a) => a.kind === "bank").length;
  console.log(
    `Snapshot recorded: ${credit} credit card(s), ${bank} bank account(s) → Balance History.`
  );
}

// Allow running this file directly: `npm run snapshot`.
if (require.main === module) {
  runSnapshot().catch((err) => {
    console.error("Snapshot failed:", err?.response?.data ?? err);
    process.exit(1);
  });
}
