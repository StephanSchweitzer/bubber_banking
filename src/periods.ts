import { google, sheets_v4 } from "googleapis";
import { config, PERIOD_TABS, TRANSACTIONS_TAB } from "./config";
import { readTokens } from "./tokens";
import { AccountSnapshot, Cadence, fetchSnapshot } from "./balances";
import { buildPeriodView, humanizeCategory, LedgerTxn } from "./period-view";
import { PeriodSheet } from "./period-sheet";
import { ensureBudgetTab, readBudget, seedCategories, writeBudgetFormulas } from "./budget";
import { writeInstructions } from "./instructions";

/**
 * Renders the four period tabs (Daily / Weekly / Monthly / Yearly) as current-
 * period budgeting dashboards. Reads the Transactions ledger (source of truth),
 * the human Budget targets, and the current Plaid balances, then lays out each
 * tab via `period-view` + `period-sheet`.
 *
 * Runnable standalone (`npm run periods`) and also invoked at the end of
 * `npm run sync`. It only touches its own tabs plus a read/append of Budget — it
 * never modifies the Transactions ledger or human-entered budget cells.
 */

async function sheetsApi(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: (await auth.getClient()) as any });
}

/** Ensure the four period tabs exist; return every tab title mapped to its gid. */
async function ensurePeriodTabs(
  api: sheets_v4.Sheets
): Promise<Map<string, number>> {
  const wanted = Object.values(PERIOD_TABS);
  const meta = await api.spreadsheets.get({ spreadsheetId: config.google.sheetId });
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
  return byTitle;
}

/**
 * Whether a string is a real budgetable category worth seeding — not blank, not
 * "Uncategorized", and not something numeric (a defensive guard so a column-shift
 * bug can never again seed amounts like "-22.91" as budget categories).
 */
function isRealCategory(c: string): boolean {
  if (!c || c === "Uncategorized") return false;
  if (/^[-+$\d.,\s]+$/.test(c)) return false; // purely numeric / currency-ish
  return true;
}

/** Read the whole Transactions ledger into LedgerTxn rows (source of truth). */
async function readLedger(api: sheets_v4.Sheets): Promise<LedgerTxn[]> {
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `${TRANSACTIONS_TAB}!A2:H`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values ?? [];
  const out: LedgerTxn[] = [];
  for (const r of rows) {
    // Columns: 0 txn_id, 1 date, 2 name, 3 merchant, 4 amount, 5 category, 6 account, 7 institution.
    const date = String(r[1] ?? "").trim();
    if (!date) continue;
    const amountRaw = r[4];
    const amount = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
    out.push({
      date,
      name: String(r[2] ?? ""),
      merchant: String(r[3] ?? ""),
      amount: Number.isFinite(amount) ? amount : 0,
      // Humanize defensively at read time (idempotent): older rows written before
      // the sync started humanizing still hold raw enums like FOOD_AND_DRINK, and
      // the views + budget seeding should treat both forms identically.
      category: humanizeCategory(String(r[5] ?? "").trim()),
      account: String(r[6] ?? "").trim(),
      institution: String(r[7] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Render all four period tabs. Balances may be passed in (so a `sync` run fetches
 * them once and shares them); otherwise they're fetched here.
 */
export async function renderPeriods(accounts?: AccountSnapshot[]): Promise<void> {
  const tokens = await readTokens();
  if (tokens.length === 0) {
    console.log("Periods: no linked institutions — skipping.");
    return;
  }

  const now = new Date();
  const resolvedAccounts = accounts ?? (await fetchSnapshot(tokens));

  const api = await sheetsApi();
  const tabIds = await ensurePeriodTabs(api);
  const ledger = await readLedger(api);

  // Budget: ensure the tab, read human targets, seed any newly-seen categories.
  await ensureBudgetTab(api, tabIds);
  const { monthlyBudget, targets, knownCategories } = await readBudget(api);
  const ledgerCategories = new Set(
    ledger.map((t) => t.category).filter(isRealCategory)
  );
  const added = await seedCategories(api, knownCategories, ledgerCategories);
  if (added.length > 0) {
    console.log(`Periods: seeded ${added.length} new budget categor(ies): ${added.join(", ")}`);
  }
  // Refresh the live Spent/Left formulas so they cover every category row.
  await writeBudgetFormulas(api);

  const takenAt = now.toISOString().replace("T", " ").slice(0, 16); // "YYYY-MM-DD HH:MM"
  const sheet = new PeriodSheet(api, tabIds);

  const cadences: [Cadence, string][] = [
    ["daily", PERIOD_TABS.daily],
    ["weekly", PERIOD_TABS.weekly],
    ["monthly", PERIOD_TABS.monthly],
    ["yearly", PERIOD_TABS.yearly],
  ];
  for (const [cadence, tab] of cadences) {
    const view = buildPeriodView({
      cadence,
      now,
      txns: ledger,
      accounts: resolvedAccounts,
      budgets: targets,
      monthlyBudget,
      takenAt,
    });
    await sheet.render(tab, view);
  }

  // Keep the user manual in sync with the layout (best-effort — a failure here
  // must not fail the render the tabs actually depend on).
  try {
    await writeInstructions(api, tabIds);
  } catch (err: unknown) {
    console.error("Instructions tab update failed:", (err as any)?.response?.data ?? err);
  }

  console.log(
    `Periods rendered: ${ledger.length} ledger row(s), ${targets.length} budget target(s) ` +
      `→ Daily/Weekly/Monthly/Yearly.`
  );
}

// Allow running this file directly: `npm run periods`.
if (require.main === module) {
  renderPeriods().catch((err) => {
    console.error("Periods failed:", err?.response?.data ?? err);
    process.exit(1);
  });
}
