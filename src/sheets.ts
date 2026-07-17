import { google, sheets_v4 } from "googleapis";
import { config, TRANSACTIONS_TAB } from "./config";

/**
 * Google Sheets writer. Owns exactly one tab — TRANSACTIONS_TAB ("Transactions").
 * It never reads or writes any other tab, so a human-edited "Budget" tab in the
 * same spreadsheet is left completely untouched.
 *
 * Rows are upserted idempotently keyed on transaction_id (column A), so re-running
 * a sync never duplicates. Removed transactions delete their row.
 */

export const HEADER = [
  "transaction_id",
  "date",
  "name",
  "merchant",
  "amount",
  "category",
  "account",
  "institution",
] as const;

/** A transaction rendered as a sheet row, in HEADER order. */
export type SheetRow = [
  string, // transaction_id
  string, // date
  string, // name
  string, // merchant
  number | string, // amount
  string, // category
  string, // account
  string // institution
];

export class TransactionsSheet {
  private api!: sheets_v4.Sheets;
  private sheetId!: number; // numeric gid of the Transactions tab
  private rowByTxnId = new Map<string, number>(); // transaction_id -> 1-based row number

  async init(): Promise<void> {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.api = google.sheets({ version: "v4", auth: await auth.getClient() as any });

    this.sheetId = await this.ensureTab();
    await this.loadIndex();
  }

  /**
   * Find the Transactions tab (creating it if missing) and guarantee that row 1
   * is the header. Handles a pre-existing tab that is empty or that somehow has
   * data without a header row, so appends and the row index stay aligned.
   */
  private async ensureTab(): Promise<number> {
    const meta = await this.api.spreadsheets.get({
      spreadsheetId: config.google.sheetId,
    });
    const existing = meta.data.sheets?.find(
      (s) => s.properties?.title === TRANSACTIONS_TAB
    );

    let sheetId: number;
    if (existing?.properties?.sheetId != null) {
      sheetId = existing.properties.sheetId;
    } else {
      const res = await this.api.spreadsheets.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: TRANSACTIONS_TAB } } }],
        },
      });
      const newId = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
      if (newId == null) {
        throw new Error("Failed to create the Transactions tab.");
      }
      sheetId = newId;
    }

    await this.ensureHeader(sheetId);
    return sheetId;
  }

  /** Make sure row 1 holds the header, inserting one above existing data if needed. */
  private async ensureHeader(sheetId: number): Promise<void> {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: config.google.sheetId,
      range: `${TRANSACTIONS_TAB}!A1:H1`,
    });
    const firstRow = res.data.values?.[0] ?? [];
    if (firstRow[0] === HEADER[0]) return; // header already present

    // Row 1 holds data (not a header) — push everything down one row first so we
    // don't overwrite a transaction. If the tab is empty this request is a no-op-ish
    // insert of a blank row, which we then fill.
    if (firstRow.length > 0) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
              },
            },
          ],
        },
      });
    }
    await this.api.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `${TRANSACTIONS_TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER as unknown as string[]] },
    });
  }

  /** Read column A to map every existing transaction_id to its row number. */
  private async loadIndex(): Promise<void> {
    this.rowByTxnId.clear();
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: config.google.sheetId,
      range: `${TRANSACTIONS_TAB}!A2:A`,
    });
    const ids = res.data.values ?? [];
    ids.forEach((row, i) => {
      const id = row[0];
      if (id) this.rowByTxnId.set(String(id), i + 2); // +2: header is row 1, data starts row 2
    });
  }

  /**
   * Apply one item's changes to the sheet.
   * Order matters: update existing rows in place, then delete removed rows
   * (bottom-up so indices stay valid), then append brand-new rows at the end.
   */
  async apply(opts: {
    upserts: SheetRow[]; // added + modified
    removedIds: string[];
  }): Promise<void> {
    const { upserts, removedIds } = opts;

    // Refresh row numbers: a previous item's deletes/appends may have shifted them.
    await this.loadIndex();

    // 1. Split upserts into in-place updates vs. appends.
    const updates: { range: string; values: SheetRow[] }[] = [];
    const appends: SheetRow[] = [];
    for (const row of upserts) {
      const txnId = row[0];
      const existingRow = this.rowByTxnId.get(txnId);
      if (existingRow) {
        updates.push({
          range: `${TRANSACTIONS_TAB}!A${existingRow}:H${existingRow}`,
          values: [row],
        });
      } else {
        appends.push(row);
      }
    }

    if (updates.length > 0) {
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }

    // 2. Delete removed rows, bottom-up so earlier deletions don't shift later ones.
    const rowsToDelete = removedIds
      .map((id) => this.rowByTxnId.get(id))
      .filter((r): r is number => r != null)
      .sort((a, b) => b - a);
    if (rowsToDelete.length > 0) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          requests: rowsToDelete.map((row) => ({
            deleteDimension: {
              range: {
                sheetId: this.sheetId,
                dimension: "ROWS",
                startIndex: row - 1, // 0-based, inclusive
                endIndex: row, // exclusive
              },
            },
          })),
        },
      });
      for (const id of removedIds) this.rowByTxnId.delete(id);
    }

    // 3. Append new rows at the bottom.
    if (appends.length > 0) {
      await this.api.spreadsheets.values.append({
        spreadsheetId: config.google.sheetId,
        range: `${TRANSACTIONS_TAB}!A:H`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: appends },
      });
    }
  }
}
