import { google, sheets_v4 } from "googleapis";
import { config, BALANCE_TABS } from "./config";
import { readTokens } from "./tokens";
import {
  fetchSnapshot,
  buildColumns,
  buildRow,
  periodKeys,
} from "./balances";
import { SnapshotSheet } from "./snapshot-sheet";

/**
 * Balance snapshot run. Pulls current credit limits, payments due, and cash from
 * Plaid and records one row per period into the Daily / Weekly / Monthly / Yearly
 * tabs. Additive: it never touches the Transactions or Budget tabs.
 *
 * Runnable standalone (`npm run snapshot`) and also invoked at the end of
 * `npm run sync` so a single cron entry keeps both transactions and balances fresh.
 */

async function sheetsApi(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: (await auth.getClient()) as any });
}

/** Ensure the four balance tabs exist; return their titles mapped to numeric gids. */
async function ensureBalanceTabs(
  api: sheets_v4.Sheets
): Promise<Map<string, number>> {
  const wanted = Object.values(BALANCE_TABS);
  const meta = await api.spreadsheets.get({
    spreadsheetId: config.google.sheetId,
  });
  const byTitle = new Map<string, number>();
  for (const s of meta.data.sheets ?? []) {
    const title = s.properties?.title;
    const id = s.properties?.sheetId;
    if (title != null && id != null) byTitle.set(title, id);
  }

  const missing = wanted.filter((t) => !byTitle.has(t));
  if (missing.length > 0) {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
    for (const reply of res.data.replies ?? []) {
      const p = reply.addSheet?.properties;
      if (p?.title != null && p.sheetId != null) byTitle.set(p.title, p.sheetId);
    }
  }

  const result = new Map<string, number>();
  for (const t of wanted) result.set(t, byTitle.get(t)!);
  return result;
}

/** Fetch balances and write a row into all four cadence tabs. Best-effort per run. */
export async function runSnapshot(): Promise<void> {
  const tokens = await readTokens();
  if (tokens.length === 0) {
    console.log("Snapshot: no linked institutions — skipping.");
    return;
  }

  const now = new Date();
  const accounts = await fetchSnapshot(tokens);
  if (accounts.length === 0) {
    console.log("Snapshot: no credit/deposit accounts found — skipping.");
    return;
  }

  const columns = buildColumns(accounts);
  const keys = periodKeys(now);
  const takenAt = now.toISOString().replace("T", " ").slice(0, 16); // "YYYY-MM-DD HH:MM"

  const api = await sheetsApi();
  const tabIds = await ensureBalanceTabs(api);
  const sheet = new SnapshotSheet(api, tabIds);

  const cadences: [keyof typeof keys, string][] = [
    ["daily", BALANCE_TABS.daily],
    ["weekly", BALANCE_TABS.weekly],
    ["monthly", BALANCE_TABS.monthly],
    ["yearly", BALANCE_TABS.yearly],
  ];
  for (const [cadence, tab] of cadences) {
    const row = buildRow(accounts, keys[cadence], takenAt);
    await sheet.upsert(tab, columns, row);
  }

  const credit = accounts.filter((a) => a.kind === "credit").length;
  const bank = accounts.filter((a) => a.kind === "bank").length;
  console.log(
    `Snapshot recorded: ${credit} credit card(s), ${bank} bank account(s) ` +
      `→ Daily/Weekly/Monthly/Yearly.`
  );
}

// Allow running this file directly: `npm run snapshot`.
if (require.main === module) {
  runSnapshot().catch((err) => {
    console.error("Snapshot failed:", err?.response?.data ?? err);
    process.exit(1);
  });
}
