import { sheets_v4 } from "googleapis";
import { config } from "./config";

/**
 * Generic "snapshot grid" writer for the balance tabs (Daily / Weekly / Monthly /
 * Yearly). Unlike the Transactions tab — which is a keyed, append-mostly ledger —
 * a snapshot tab holds one row per period (the first column is the period key) and
 * a set of value columns that can grow as new accounts are linked.
 *
 * Each run reads the whole (small) tab, overlays the current period's row, unions
 * in any new columns, rewrites the grid sorted by period, and re-applies color
 * formatting so the sheet stays easy to read at a glance.
 *
 * Behaviour is intentionally lossless: historical rows and columns for accounts
 * that later disappear are preserved rather than dropped.
 */

export type CellFormat = "text" | "currency" | "date";

/** Which visual group a column belongs to — drives its background colour. */
export type ColumnGroup =
  | "period"
  | "meta"
  | "credit"
  | "creditTotal"
  | "bank"
  | "cash";

export interface Column {
  /** Unique key, also used verbatim as the header label. */
  key: string;
  format: CellFormat;
  group: ColumnGroup;
}

export interface SnapshotRow {
  /** Value written into the first (period) column, e.g. "2026-07-17". */
  periodKey: string;
  /** Cell values keyed by column key. Missing keys render blank. */
  values: Record<string, string | number | null>;
}

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

const WHITE: Rgb = { red: 1, green: 1, blue: 1 };

/** Header background per group (bold, white text on top). */
const HEADER_BG: Record<ColumnGroup, Rgb> = {
  period: rgb(0x33, 0x41, 0x55), // slate-700
  meta: rgb(0x47, 0x55, 0x69), // slate-600
  credit: rgb(0x25, 0x63, 0xeb), // blue-600
  creditTotal: rgb(0x1e, 0x3a, 0x8a), // blue-900
  bank: rgb(0x05, 0x96, 0x69), // emerald-600
  cash: rgb(0x06, 0x5f, 0x46), // emerald-800
};

/** Data-cell background per group (light tint). */
const DATA_BG: Record<ColumnGroup, Rgb> = {
  period: rgb(0xf1, 0xf5, 0xf9), // slate-100
  meta: rgb(0xf8, 0xfa, 0xfc), // slate-50
  credit: rgb(0xef, 0xf6, 0xff), // blue-50
  creditTotal: rgb(0xdb, 0xea, 0xfe), // blue-100
  bank: rgb(0xec, 0xfd, 0xf5), // emerald-50
  cash: rgb(0xd1, 0xfa, 0xe5), // emerald-100
};

const CURRENCY_PATTERN = '"$"#,##0.00';

export class SnapshotSheet {
  constructor(
    private readonly api: sheets_v4.Sheets,
    private readonly sheetIdByTitle: Map<string, number>
  ) {}

  /** Merge the given row into `tab`, then rewrite + reformat the whole grid. */
  async upsert(tab: string, columns: Column[], row: SnapshotRow): Promise<void> {
    const sheetId = this.sheetIdByTitle.get(tab);
    if (sheetId == null) throw new Error(`Unknown snapshot tab: ${tab}`);

    // 1. Read the existing grid into periodKey -> (columnKey -> raw cell).
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: config.google.sheetId,
      range: `${tab}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const grid = res.data.values ?? [];
    const existingHeader = (grid[0] ?? []).map((h) => String(h ?? ""));

    const rowsByPeriod = new Map<string, Map<string, unknown>>();
    for (let i = 1; i < grid.length; i++) {
      const r = grid[i] ?? [];
      const periodKey = r[0];
      if (periodKey == null || periodKey === "") continue;
      const cells = new Map<string, unknown>();
      existingHeader.forEach((h, idx) => {
        if (h) cells.set(h, r[idx]);
      });
      rowsByPeriod.set(String(periodKey), cells);
    }

    // 2. Union columns: current columns first (canonical order), then any
    //    historical columns no longer produced (preserved as plain text).
    const currentKeys = new Set(columns.map((c) => c.key));
    const leftovers: Column[] = existingHeader
      .filter((h) => h && !currentKeys.has(h))
      .map((h) => ({ key: h, format: "text", group: "meta" }));
    const finalColumns: Column[] = [...columns, ...leftovers];

    // 3. Overlay the current period's row. Set value columns first, then the
    //    period column last so it can't be blanked by a missing values[key].
    const current =
      rowsByPeriod.get(row.periodKey) ?? new Map<string, unknown>();
    for (const col of columns) {
      const v = row.values[col.key];
      current.set(col.key, v == null ? "" : v);
    }
    current.set(finalColumns[0].key, row.periodKey); // period column (A)
    rowsByPeriod.set(row.periodKey, current);

    // 4. Build the output matrix, sorted by period ascending (chronological).
    const header = finalColumns.map((c) => c.key);
    const periodKeys = [...rowsByPeriod.keys()].sort();
    const dataRows = periodKeys.map((pk) => {
      const cells = rowsByPeriod.get(pk)!;
      return finalColumns.map((col) => toCell(cells.get(col.key), col.format));
    });

    // 5. Rewrite the grid: clear first so shrinking never leaves stale cells.
    await this.api.spreadsheets.values.clear({
      spreadsheetId: config.google.sheetId,
      range: `${tab}`,
    });
    await this.api.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [header, ...dataRows] },
    });

    // 6. Re-apply formatting (colours, number formats, frozen header/column).
    await this.format(sheetId, finalColumns, dataRows.length);
  }

  /** Colour the header + data ranges by group and set number formats. */
  private async format(
    sheetId: number,
    columns: Column[],
    dataRowCount: number
  ): Promise<void> {
    const requests: sheets_v4.Schema$Request[] = [
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
          },
          fields: "gridProperties(frozenRowCount,frozenColumnCount)",
        },
      },
    ];

    columns.forEach((col, idx) => {
      // Header cell.
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: idx,
            endColumnIndex: idx + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: HEADER_BG[col.group],
              horizontalAlignment: idx === 0 ? "LEFT" : "CENTER",
              wrapStrategy: "WRAP",
              textFormat: { bold: true, foregroundColor: WHITE },
            },
          },
          fields:
            "userEnteredFormat(backgroundColor,horizontalAlignment,wrapStrategy,textFormat)",
        },
      });

      // Data cells for this column (skip if there are no data rows yet).
      if (dataRowCount > 0) {
        const numberFormat =
          col.format === "currency"
            ? { type: "NUMBER", pattern: CURRENCY_PATTERN }
            : undefined;
        requests.push({
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 1 + dataRowCount,
              startColumnIndex: idx,
              endColumnIndex: idx + 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: DATA_BG[col.group],
                horizontalAlignment: idx === 0 ? "LEFT" : "RIGHT",
                ...(numberFormat ? { numberFormat } : {}),
                textFormat: {
                  bold: col.group === "creditTotal" || col.group === "cash",
                },
              },
            },
            fields: numberFormat
              ? "userEnteredFormat(backgroundColor,horizontalAlignment,numberFormat,textFormat)"
              : "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)",
          },
        });
      }
    });

    // Size columns to their content.
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: columns.length,
        },
      },
    });

    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: { requests },
    });
  }
}

/** Coerce a stored value for writing, respecting the column's format. */
function toCell(
  value: unknown,
  format: CellFormat
): string | number {
  if (value == null || value === "") return "";
  if (format === "currency") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : "";
  }
  return String(value);
}

function rgb(r: number, g: number, b: number): Rgb {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}
