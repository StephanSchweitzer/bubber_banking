import { sheets_v4 } from "googleapis";
import { config } from "./config";
import { PeriodView } from "./period-view";

/**
 * Renders a `PeriodView` into one of the period tabs (Daily / Weekly / Monthly /
 * Yearly). Unlike the Transactions ledger (a keyed, append-mostly table) a period
 * tab is a *laid-out dashboard*: a title band, an overview strip, a budget block,
 * and one transaction section per card/account, all stacked in a fixed 5-column
 * grid (Date / Name / Merchant / Amount / Category).
 *
 * The layout size changes run to run (transaction counts vary), so each render
 * fully rebuilds the tab: unmerge + reset formatting, clear values, write the new
 * matrix, then re-apply merges/colours/number-formats. Formatting cost is bounded
 * by the number of sections and budget rows, not by transaction count.
 */

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

const WHITE: Rgb = { red: 1, green: 1, blue: 1 };
const COLS = 5; // Date, Name, Merchant, Amount, Category

// Palette — kept in step with snapshot-sheet.ts for a consistent spreadsheet.
const C = {
  titleBg: rgb(0x33, 0x41, 0x55), // slate-700
  subtitle: rgb(0x64, 0x74, 0x8b), // slate-500
  labelBg: rgb(0xf1, 0xf5, 0xf9), // slate-100
  sectionText: rgb(0x47, 0x55, 0x69), // slate-600
  creditBg: rgb(0x25, 0x63, 0xeb), // blue-600
  bankBg: rgb(0x05, 0x96, 0x69), // emerald-600
  headBg: rgb(0xf8, 0xfa, 0xfc), // slate-50
  headText: rgb(0x64, 0x74, 0x8b), // slate-500
  good: rgb(0x05, 0x96, 0x69), // emerald-600
  bad: rgb(0xdc, 0x26, 0x26), // red-600
  neutral: rgb(0x0f, 0x17, 0x2a), // slate-900
  muted: rgb(0x94, 0xa3, 0xb8), // slate-400
  barFull: rgb(0x25, 0x63, 0xeb), // blue-600
  barOver: rgb(0xdc, 0x26, 0x26), // red-600
};

const CURRENCY = '"$"#,##0.00';
const CURRENCY_NEG_RED = '"$"#,##0.00;[Red]-"$"#,##0.00';
const AMOUNT_SIGNED = '[Green]"$"#,##0.00;[Red]-"$"#,##0.00'; // + inflow green, - outflow red
const BAR_WIDTH = 12;

type Cell = string | number;

export class PeriodSheet {
  constructor(
    private readonly api: sheets_v4.Sheets,
    private readonly sheetIdByTitle: Map<string, number>
  ) {}

  async render(tab: string, view: PeriodView): Promise<void> {
    const sheetId = this.sheetIdByTitle.get(tab);
    if (sheetId == null) throw new Error(`Unknown period tab: ${tab}`);

    const b = new GridBuilder(sheetId);
    b.build(view);

    // 1. Wipe old merges + formatting so a shrinking layout leaves nothing stale.
    const grid = await this.gridSize(sheetId);
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [
          { unmergeCells: { range: { sheetId } } },
          {
            // These tabs may carry a frozen row/column from their previous life
            // as balance grids; unfreeze so section bands can merge across all
            // five columns (Sheets forbids merging a frozen with a non-frozen col).
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 0, frozenColumnCount: 0 },
              },
              fields: "gridProperties(frozenRowCount,frozenColumnCount)",
            },
          },
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: grid.rows,
                startColumnIndex: 0,
                endColumnIndex: grid.cols,
              },
              cell: { userEnteredFormat: {} },
              fields: "userEnteredFormat",
            },
          },
        ],
      },
    });

    // 2. Replace values.
    await this.api.spreadsheets.values.clear({
      spreadsheetId: config.google.sheetId,
      range: `${tab}`,
    });
    await this.api.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: b.matrix },
    });

    // 3. Re-apply layout formatting.
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: { requests: b.requests },
    });
  }

  /** Current grid dimensions, so the format reset stays inside the sheet. */
  private async gridSize(sheetId: number): Promise<{ rows: number; cols: number }> {
    const meta = await this.api.spreadsheets.get({
      spreadsheetId: config.google.sheetId,
      fields: "sheets(properties(sheetId,gridProperties(rowCount,columnCount)))",
    });
    for (const s of meta.data.sheets ?? []) {
      if (s.properties?.sheetId === sheetId) {
        const gp = s.properties.gridProperties;
        return { rows: gp?.rowCount ?? 1000, cols: gp?.columnCount ?? 26 };
      }
    }
    return { rows: 1000, cols: 26 };
  }
}

/**
 * Accumulates the value matrix and the formatting requests together, so each row
 * is described once. Row indices are assigned as rows are pushed.
 */
class GridBuilder {
  matrix: Cell[][] = [];
  requests: sheets_v4.Schema$Request[] = [];

  constructor(private readonly sheetId: number) {}

  build(view: PeriodView): void {
    this.titleBand(view.title, view.subtitle);
    this.spacer();
    this.overview(view.overview);
    this.spacer();
    if (view.budget.length > 0) this.budgetBlock(view.budget);
    for (const sec of view.sections) {
      this.spacer();
      this.section(sec);
    }
    this.columnWidths();
  }

  // --- Row builders -------------------------------------------------------

  private titleBand(title: string, subtitle: string): void {
    const r = this.push([title, "", "", "", ""]);
    this.merge(r, 0, COLS);
    this.rowFormat(r, {
      backgroundColor: C.titleBg,
      horizontalAlignment: "LEFT",
      textFormat: { bold: true, fontSize: 13, foregroundColor: WHITE },
    });
    const s = this.push([subtitle, "", "", "", ""]);
    this.merge(s, 0, COLS);
    this.rowFormat(s, {
      horizontalAlignment: "LEFT",
      textFormat: { italic: true, foregroundColor: C.subtitle },
    });
  }

  private overview(stats: PeriodView["overview"]): void {
    this.sectionLabel("Overview");
    // Render as label-row / value-row pairs, wrapping every COLS stats so more
    // than five stats (e.g. when "Unallocated" is present) don't get dropped.
    for (let start = 0; start < stats.length; start += COLS) {
      const chunk = stats.slice(start, start + COLS);
      const labels: Cell[] = ["", "", "", "", ""];
      const values: Cell[] = ["", "", "", "", ""];
      chunk.forEach((s, i) => {
        labels[i] = s.label;
        values[i] = s.value;
      });
      const lr = this.push(labels);
      this.rowFormat(lr, {
        backgroundColor: C.labelBg,
        horizontalAlignment: "CENTER",
        wrapStrategy: "WRAP",
        textFormat: { foregroundColor: C.headText, fontSize: 9 },
      });
      const vr = this.push(values);
      this.rowFormat(vr, {
        backgroundColor: C.labelBg,
        horizontalAlignment: "CENTER",
        numberFormat: { type: "NUMBER", pattern: CURRENCY },
        textFormat: { bold: true, fontSize: 12 },
      });
      chunk.forEach((s, i) => {
        if (s.tone === "neutral") return;
        this.cellTextColor(vr, i, s.tone === "good" ? C.good : C.bad);
      });
    }
  }

  private budgetBlock(lines: PeriodView["budget"]): void {
    this.sectionLabel("Budget by category");
    const head = this.push(["Category", "Budget", "Spent", "Left", ""]);
    this.rowFormat(head, {
      backgroundColor: C.headBg,
      horizontalAlignment: "RIGHT",
      textFormat: { foregroundColor: C.headText, fontSize: 9 },
    });
    this.cellAlign(head, 0, "LEFT");

    for (const b of lines) {
      const bar = b.fill == null ? "" : renderBar(b.fill);
      const row = this.push([
        b.category,
        b.target ?? "",
        b.spent,
        b.left ?? "",
        bar,
      ]);
      // Number formats: Budget/Spent plain, Left red-when-negative.
      this.cellNumber(row, 1, CURRENCY);
      this.cellNumber(row, 2, CURRENCY);
      this.cellNumber(row, 3, CURRENCY_NEG_RED);
      this.cellAlign(row, 0, "LEFT");
      if (b.target == null) this.cellTextColor(row, 0, C.muted);
      if (bar) this.cellTextColor(row, 4, b.over ? C.barOver : C.barFull);
    }
    const note = this.push([
      "The Budget column is yours to edit — the sync never overwrites it.",
      "",
      "",
      "",
      "",
    ]);
    this.merge(note, 0, COLS);
    this.rowFormat(note, {
      horizontalAlignment: "LEFT",
      textFormat: { italic: true, fontSize: 9, foregroundColor: C.muted },
    });
  }

  private section(sec: PeriodView["sections"][number]): void {
    // Coloured, merged header band carrying the account's facts.
    const header = this.push([sec.title, "", "", "", sec.facts]);
    this.merge(header, 0, 4); // title spans A:D, facts sit in E
    this.rowFormat(header, {
      backgroundColor: sec.kind === "credit" ? C.creditBg : C.bankBg,
      horizontalAlignment: "LEFT",
      textFormat: { bold: true, foregroundColor: WHITE },
    });
    this.cellFormat(header, 4, {
      backgroundColor: sec.kind === "credit" ? C.creditBg : C.bankBg,
      horizontalAlignment: "RIGHT",
      textFormat: { foregroundColor: WHITE, fontSize: 9 },
    });

    if (sec.txns.length === 0) {
      const empty = this.push(["No transactions this period", "", "", "", ""]);
      this.merge(empty, 0, COLS);
      this.rowFormat(empty, {
        horizontalAlignment: "LEFT",
        textFormat: { italic: true, foregroundColor: C.muted, fontSize: 9 },
      });
      return;
    }

    const colHead = this.push(["Date", "Name", "Merchant", "Amount", "Category"]);
    this.rowFormat(colHead, {
      backgroundColor: C.headBg,
      horizontalAlignment: "LEFT",
      textFormat: { foregroundColor: C.headText, fontSize: 9 },
    });
    this.cellAlign(colHead, 3, "RIGHT");

    const firstDataRow = this.matrix.length;
    for (const t of sec.txns) {
      this.push([t.date, t.name, t.merchant, t.amount, t.category]);
    }
    const lastDataRow = this.matrix.length; // exclusive
    // Amount column: signed currency (green inflow / red outflow), right-aligned.
    this.requests.push({
      repeatCell: {
        range: {
          sheetId: this.sheetId,
          startRowIndex: firstDataRow,
          endRowIndex: lastDataRow,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "RIGHT",
            numberFormat: { type: "NUMBER", pattern: AMOUNT_SIGNED },
          },
        },
        fields: "userEnteredFormat(horizontalAlignment,numberFormat)",
      },
    });
  }

  // --- Low-level helpers --------------------------------------------------

  private sectionLabel(text: string): void {
    const r = this.push([text.toUpperCase(), "", "", "", ""]);
    this.merge(r, 0, COLS);
    this.rowFormat(r, {
      horizontalAlignment: "LEFT",
      textFormat: { bold: true, fontSize: 9, foregroundColor: C.sectionText },
    });
  }

  private spacer(): void {
    this.push(["", "", "", "", ""]);
  }

  private push(cells: Cell[]): number {
    const idx = this.matrix.length;
    this.matrix.push(padRow(cells));
    return idx;
  }

  private merge(row: number, startCol: number, endCol: number): void {
    this.requests.push({
      mergeCells: {
        mergeType: "MERGE_ALL",
        range: {
          sheetId: this.sheetId,
          startRowIndex: row,
          endRowIndex: row + 1,
          startColumnIndex: startCol,
          endColumnIndex: endCol,
        },
      },
    });
  }

  private rowFormat(row: number, fmt: sheets_v4.Schema$CellFormat): void {
    this.requests.push({
      repeatCell: {
        range: {
          sheetId: this.sheetId,
          startRowIndex: row,
          endRowIndex: row + 1,
          startColumnIndex: 0,
          endColumnIndex: COLS,
        },
        cell: { userEnteredFormat: fmt },
        fields: fieldMask(fmt),
      },
    });
  }

  private cellFormat(row: number, col: number, fmt: sheets_v4.Schema$CellFormat): void {
    this.requests.push({
      repeatCell: {
        range: {
          sheetId: this.sheetId,
          startRowIndex: row,
          endRowIndex: row + 1,
          startColumnIndex: col,
          endColumnIndex: col + 1,
        },
        cell: { userEnteredFormat: fmt },
        fields: fieldMask(fmt),
      },
    });
  }

  private cellNumber(row: number, col: number, pattern: string): void {
    this.cellFormat(row, col, {
      horizontalAlignment: "RIGHT",
      numberFormat: { type: "NUMBER", pattern },
    });
  }

  private cellAlign(row: number, col: number, alignment: string): void {
    this.cellFormat(row, col, { horizontalAlignment: alignment });
  }

  private cellTextColor(row: number, col: number, color: Rgb): void {
    // Precise field mask so we tint the text without clobbering bold/size set by
    // the row-level format (e.g. the bold overview value cells).
    this.requests.push({
      repeatCell: {
        range: {
          sheetId: this.sheetId,
          startRowIndex: row,
          endRowIndex: row + 1,
          startColumnIndex: col,
          endColumnIndex: col + 1,
        },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: color } } },
        fields: "userEnteredFormat.textFormat.foregroundColor",
      },
    });
  }

  private columnWidths(): void {
    const widths = [92, 190, 150, 110, 150];
    widths.forEach((px, i) => {
      this.requests.push({
        updateDimensionProperties: {
          range: { sheetId: this.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px },
          fields: "pixelSize",
        },
      });
    });
  }
}

// --- helpers ---------------------------------------------------------------

/** A proportional bar drawn with block glyphs, e.g. "████████░░░░". */
function renderBar(fill: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fill)) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function padRow(cells: Cell[]): Cell[] {
  const out = cells.slice(0, COLS);
  while (out.length < COLS) out.push("");
  return out;
}

/** Build the update field mask from whichever format keys are present. */
function fieldMask(fmt: sheets_v4.Schema$CellFormat): string {
  const keys = Object.keys(fmt);
  return `userEnteredFormat(${keys.join(",")})`;
}

function rgb(r: number, g: number, b: number): Rgb {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}
