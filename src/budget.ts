import { sheets_v4 } from "googleapis";
import { config, BUDGET_TAB } from "./config";
import { BudgetTarget } from "./period-view";

/**
 * The Budget tab is the one place a human owns. Column A is the category, column
 * B is the monthly dollar target. This module only ever:
 *   - READS those targets, and
 *   - APPENDS categories it has newly discovered (with a blank target),
 * so the person is never hunting for the category list. It NEVER overwrites a
 * cell someone has filled in — that ownership split is what makes budgets safe
 * to edit by hand while the sync keeps running.
 */

const HEADER = ["Category", "Monthly Budget"] as const;

export interface BudgetData {
  /** Targets with a numeric value the human has entered. */
  targets: BudgetTarget[];
  /** Every category already listed on the tab (targeted or not). */
  knownCategories: Set<string>;
}

/** Ensure the Budget tab exists (with a header) and return its numeric gid. */
export async function ensureBudgetTab(
  api: sheets_v4.Sheets,
  sheetIdByTitle: Map<string, number>
): Promise<number> {
  let sheetId = sheetIdByTitle.get(BUDGET_TAB);
  if (sheetId == null) {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: BUDGET_TAB } } }],
      },
    });
    const id = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (id == null) throw new Error("Failed to create the Budget tab.");
    sheetId = id;
    sheetIdByTitle.set(BUDGET_TAB, sheetId);
  }

  // Guarantee the header row, without disturbing any existing rows below it.
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `${BUDGET_TAB}!A1:B1`,
  });
  const firstRow = res.data.values?.[0] ?? [];
  if (firstRow[0] !== HEADER[0]) {
    await api.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `${BUDGET_TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER as unknown as string[]] },
    });
  }
  return sheetId;
}

/** Read the human-entered category → monthly-target map. */
export async function readBudget(api: sheets_v4.Sheets): Promise<BudgetData> {
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `${BUDGET_TAB}!A2:B`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values ?? [];
  const targets: BudgetTarget[] = [];
  const knownCategories = new Set<string>();
  for (const row of rows) {
    const category = String(row[0] ?? "").trim();
    if (!category) continue;
    knownCategories.add(category);
    const raw = row[1];
    const monthly = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(monthly) && String(raw ?? "").trim() !== "") {
      targets.push({ category, monthly });
    }
  }
  return { targets, knownCategories };
}

/**
 * Append categories the ledger has produced but the Budget tab doesn't list yet,
 * each with a blank target for the human to fill in. Never touches existing rows.
 */
export async function seedCategories(
  api: sheets_v4.Sheets,
  known: Set<string>,
  discovered: Iterable<string>
): Promise<string[]> {
  const toAdd: string[] = [];
  const seen = new Set(known);
  for (const cat of discovered) {
    const c = (cat ?? "").trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    toAdd.push(c);
  }
  if (toAdd.length === 0) return [];

  toAdd.sort((a, b) => a.localeCompare(b));
  await api.spreadsheets.values.append({
    spreadsheetId: config.google.sheetId,
    range: `${BUDGET_TAB}!A:B`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAdd.map((c) => [c, ""]) },
  });
  return toAdd;
}
