import { sheets_v4 } from "googleapis";
import { config, BUDGET_TAB } from "./config";
import { BudgetTarget } from "./period-view";

/**
 * The Budget tab is the one place a human owns — and now the allocation cockpit.
 * Layout:
 *
 *   A1 Monthly budget   | B1  <- you type your monthly pool here
 *   A2 Allocated        | B2  =SUM(B5:B)   (live: total assigned to categories)
 *   A3 Unallocated      | B3  =B1-B2       (live: what's left to assign)
 *   A4 Category         | B4  Budget       (table header)
 *   A5 <category>       | B5  <target>     (you type per-category targets)
 *   ...
 *
 * B2/B3 are real formulas, so "allocated" and "what's left" update the instant you
 * edit a number — no sync required. The sync only ever:
 *   - READS the total (B1) and the per-category targets (A5:B), and
 *   - APPENDS categories it newly discovers (with a blank target),
 * and it NEVER overwrites B1 or a target a human has entered.
 */

const LABEL_BUDGET = "Monthly budget";
const LABEL_ALLOCATED = "Allocated";
const LABEL_UNALLOCATED = "Unallocated";
const TABLE_CATEGORY = "Category";
const TABLE_AMOUNT = "Budget";

const DATA_START_ROW = 5; // first category row (1-based)
const ALLOCATED_FORMULA = "=SUM(B5:B)";
const UNALLOCATED_FORMULA = "=B1-B2";

const CURRENCY = '"$"#,##0.00';
const CURRENCY_NEG_RED = '"$"#,##0.00;[Red]-"$"#,##0.00';

export interface BudgetData {
  /** The human's total monthly budget pool (B1), or null if unset. */
  monthlyBudget: number | null;
  /** Per-category targets the human has entered. */
  targets: BudgetTarget[];
  /** Every category already listed in the table (targeted or not). */
  knownCategories: Set<string>;
}

/** Ensure the Budget tab exists with the allocation block, and return its gid. */
export async function ensureBudgetTab(
  api: sheets_v4.Sheets,
  sheetIdByTitle: Map<string, number>
): Promise<number> {
  let sheetId = sheetIdByTitle.get(BUDGET_TAB);
  if (sheetId == null) {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: BUDGET_TAB } } }] },
    });
    const id = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (id == null) throw new Error("Failed to create the Budget tab.");
    sheetId = id;
    sheetIdByTitle.set(BUDGET_TAB, sheetId);
  }

  const head = await api.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `${BUDGET_TAB}!A1:B4`,
  });
  const rows = head.data.values ?? [];
  const a1 = String(rows[0]?.[0] ?? "");
  const a4 = String(rows[3]?.[0] ?? "");
  const blockPresent = a1 === LABEL_BUDGET && a4 === TABLE_CATEGORY;

  // Migrate an old two-column layout (header "Category" in row 1, data below) by
  // inserting three rows on top: the old header lands on row 4 (our table header)
  // and the categories on row 5+, exactly where the new layout expects them.
  if (!blockPresent && a1 === TABLE_CATEGORY) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 3 },
            },
          },
        ],
      },
    });
  }

  // Write the labels + formulas + table header — but never column B1 (the human's
  // total). Column A labels and B2:B4 are safe to (re)assert every run.
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED", // so the formulas evaluate
      data: [
        {
          range: `${BUDGET_TAB}!A1:A4`,
          values: [[LABEL_BUDGET], [LABEL_ALLOCATED], [LABEL_UNALLOCATED], [TABLE_CATEGORY]],
        },
        {
          range: `${BUDGET_TAB}!B2:B4`,
          values: [[ALLOCATED_FORMULA], [UNALLOCATED_FORMULA], [TABLE_AMOUNT]],
        },
      ],
    },
  });

  await formatBudgetTab(api, sheetId);
  return sheetId;
}

/** Read the total pool, per-category targets, and the known category set. */
export async function readBudget(api: sheets_v4.Sheets): Promise<BudgetData> {
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `${BUDGET_TAB}!A1:B`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values ?? [];

  const b1 = rows[0]?.[1];
  const monthlyBudget =
    typeof b1 === "number" ? b1 : Number.isFinite(Number(b1)) && String(b1 ?? "").trim() !== "" ? Number(b1) : null;

  const targets: BudgetTarget[] = [];
  const knownCategories = new Set<string>();
  for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
    const category = String(rows[i]?.[0] ?? "").trim();
    if (!category) continue;
    knownCategories.add(category);
    const raw = rows[i]?.[1];
    const monthly = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(monthly) && String(raw ?? "").trim() !== "") {
      targets.push({ category, monthly });
    }
  }
  return { monthlyBudget, targets, knownCategories };
}

/**
 * Append categories the ledger produced but the Budget table doesn't list yet,
 * each with a blank target. Appends below the block; never touches existing rows.
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

/** Style the allocation block: bold labels, currency, a highlighted input cell. */
async function formatBudgetTab(api: sheets_v4.Sheets, sheetId: number): Promise<void> {
  const slate700 = rgb(0x33, 0x41, 0x55);
  const amber50 = rgb(0xff, 0xfb, 0xeb);
  const white = { red: 1, green: 1, blue: 1 };

  const requests: sheets_v4.Schema$Request[] = [
    // A1:A3 bold labels.
    cell(sheetId, 0, 3, 0, 1, {
      textFormat: { bold: true },
    }),
    // B1 input: highlighted so it's obviously "type here", currency.
    cell(sheetId, 0, 1, 1, 2, {
      backgroundColor: amber50,
      numberFormat: { type: "NUMBER", pattern: CURRENCY },
      textFormat: { bold: true },
    }),
    // B2 allocated: currency.
    cell(sheetId, 1, 2, 1, 2, { numberFormat: { type: "NUMBER", pattern: CURRENCY } }),
    // B3 unallocated: currency, red when negative (over-allocated).
    cell(sheetId, 2, 3, 1, 2, {
      numberFormat: { type: "NUMBER", pattern: CURRENCY_NEG_RED },
      textFormat: { bold: true },
    }),
    // Row 4 table header band.
    cell(sheetId, 3, 4, 0, 2, {
      backgroundColor: slate700,
      textFormat: { bold: true, foregroundColor: white },
    }),
    // Category target column (B5:B) currency.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: CURRENCY } } },
        fields: "userEnteredFormat(numberFormat)",
      },
    },
    // Column widths + frozen header.
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 180 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 140 },
        fields: "pixelSize",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 4 } },
        fields: "gridProperties(frozenRowCount)",
      },
    },
  ];

  await api.spreadsheets.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: { requests },
  });
}

function cell(
  sheetId: number,
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number,
  fmt: sheets_v4.Schema$CellFormat
): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
      cell: { userEnteredFormat: fmt },
      fields: `userEnteredFormat(${Object.keys(fmt).join(",")})`,
    },
  };
}

function rgb(r: number, g: number, b: number) {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}
