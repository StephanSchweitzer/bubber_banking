import { sheets_v4 } from "googleapis";
import { config, PERIOD_TABS } from "./config";
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
  barFull: rgb(0x25, 0x63, 0xeb), // blue-600 — under budget
  overSome: rgb(0xea, 0x58, 0x0c), // orange-600 — over budget by < 30%
  overBad: rgb(0xdc, 0x26, 0x26), // red-600 — over budget by >= 30%
};

/** Over-budget threshold (as a fraction of the target) above which red wins. */
const OVER_RED_THRESHOLD = 0.3;

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
    // Conditional-format rules aren't cleared by resetting userEnteredFormat, so
    // delete every existing rule (index 0, repeated) before re-adding fresh ones,
    // otherwise the over-budget colour rules pile up run after run.
    const grid = await this.gridSize(sheetId);
    const clearRules: sheets_v4.Schema$Request[] = Array.from(
      { length: grid.condRules },
      () => ({ deleteConditionalFormatRule: { sheetId, index: 0 } })
    );
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [
          ...clearRules,
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

    // 2b. Overlay the live formulas (Budget/Spent/Left/bar + budget-derived overview
    // stats). Written as a separate USER_ENTERED pass so the bulk RAW write above
    // never risks re-parsing a transaction name/amount as a formula.
    if (b.formulaCells.length > 0) {
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: b.formulaCells.map((f) => ({
            range: `${tab}!${a1(f.row, f.col)}`,
            values: [[f.formula]],
          })),
        },
      });
    }

    // 3. Re-apply layout formatting (incl. the over-budget conditional-format rules).
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: { requests: b.requests },
    });
  }

  /** Grid dimensions + conditional-rule count, so resets stay inside the sheet. */
  private async gridSize(
    sheetId: number
  ): Promise<{ rows: number; cols: number; condRules: number }> {
    const meta = await this.api.spreadsheets.get({
      spreadsheetId: config.google.sheetId,
      fields:
        "sheets(properties(sheetId,gridProperties(rowCount,columnCount)),conditionalFormats)",
    });
    for (const s of meta.data.sheets ?? []) {
      if (s.properties?.sheetId === sheetId) {
        const gp = s.properties.gridProperties;
        return {
          rows: gp?.rowCount ?? 1000,
          cols: gp?.columnCount ?? 26,
          condRules: s.conditionalFormats?.length ?? 0,
        };
      }
    }
    return { rows: 1000, cols: 26, condRules: 0 };
  }
}

/**
 * Accumulates the value matrix and the formatting requests together, so each row
 * is described once. Row indices are assigned as rows are pushed.
 */
class GridBuilder {
  matrix: Cell[][] = [];
  requests: sheets_v4.Schema$Request[] = [];
  /** Cells to overwrite with live formulas (0-based row/col) after the RAW write. */
  formulaCells: { row: number; col: number; formula: string }[] = [];

  private cadence: PeriodView["cadence"] = "monthly";
  /** 1-based first/last data rows of the budget block, once it's laid out. */
  private budgetFirstRow: number | null = null;
  private budgetLastRow: number | null = null;
  /** Overview value cells that want a live formula, resolved once rows are known. */
  private overviewLive: { row: number; col: number; kind: NonNullable<PeriodView["overview"][number]["live"]> }[] = [];

  constructor(private readonly sheetId: number) {}

  build(view: PeriodView): void {
    this.cadence = view.cadence;
    this.titleBand(view.title, view.subtitle);
    this.spacer();
    this.overview(view.overview);
    this.spacer();
    if (view.budget.length > 0) this.budgetBlock(view.budget);
    if (view.rollover.length > 0) {
      this.spacer();
      this.rolloverBlock(view.rollover);
    }
    for (const sec of view.sections) {
      this.spacer();
      this.section(sec);
    }
    // Now that the budget block's rows are known, wire up the live overview stats
    // (Spent / Left to spend reference the block; Unallocated references Budget!B3).
    this.resolveOverviewFormulas();
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
        if (s.live) this.overviewLive.push({ row: vr, col: i, kind: s.live });
        if (s.tone === "neutral") return;
        this.cellTextColor(vr, i, s.tone === "good" ? C.good : C.bad);
      });
    }
  }

  /** Turn the flagged overview stats into live formulas (see `build`). */
  private resolveOverviewFormulas(): void {
    const { budgetFirstRow: f, budgetLastRow: l } = this;
    for (const o of this.overviewLive) {
      let formula: string | null = null;
      if (o.kind === "unallocated") {
        // Pool minus allocations already lives on the Budget tab as B3.
        formula = "=Budget!$B$3";
      } else if (o.kind === "safeToday") {
        // Monthly pool (Budget B1) − month-to-date spend, ÷ days left in the month.
        // Month spend is the Monthly tab's "Spent this month" overview cell, which
        // the fixed layout pins at D6 (row 6 = first overview value row, col D = the
        // 4th stat). MAX(0,…) so an overspent month reads $0, not negative.
        formula =
          `=IFERROR(MAX(0,(Budget!$B$1-'${PERIOD_TABS.monthly}'!$D$6))` +
          `/(DAY(EOMONTH(TODAY(),0))-DAY(TODAY())+1),0)`;
      } else if (f != null && l != null) {
        // The rest reference the tab's own live budget block.
        formula =
          o.kind === "spent"
            ? `=SUM(C${f}:C${l})`
            : o.kind === "leftToSpend"
            ? `=IFERROR(SUM(B${f}:B${l})-SUM(C${f}:C${l}),0)`
            : /* projected */ `=IFERROR(SUM(C${f}:C${l})/(${this.elapsedFormula()}),0)`;
      }
      if (formula) this.formulaCells.push({ row: o.row, col: o.col, formula });
    }
  }

  /** How far through the current period we are, in (0, 1], as a live formula. */
  private elapsedFormula(): string {
    switch (this.cadence) {
      case "weekly":
        return "(WEEKDAY(TODAY(),3)+1)/7";
      case "monthly":
        return "DAY(TODAY())/DAY(EOMONTH(TODAY(),0))";
      case "yearly":
        return "(TODAY()-DATE(YEAR(TODAY()),1,1)+1)/(DATE(YEAR(TODAY())+1,1,1)-DATE(YEAR(TODAY()),1,1))";
      case "daily":
        return "1"; // unused — projection isn't shown on the daily tab
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

    const pro = this.prorationSuffix();
    const firstRow0 = this.matrix.length; // 0-based row of the first category
    for (const b of lines) {
      // Category text only; Budget/Spent/Left/bar are overwritten by live formulas
      // below so they track Budget-tab edits and new transactions without a sync.
      const row = this.push([b.category, "", "", "", ""]);
      const r = row + 1; // 1-based sheet row
      // Budget: this category's monthly target from the Budget tab, prorated to this
      // cadence. Blank when the category has no target (VLOOKUP miss or empty cell).
      const budgetF =
        `=IFERROR(IF(VLOOKUP($A${r},Budget!$A$5:$B,2,FALSE)="","",` +
        `VLOOKUP($A${r},Budget!$A$5:$B,2,FALSE)${pro}),"")`;
      // Spent: outflow magnitude for this category within the current period.
      const spentF = this.spentFormula(r);
      const leftF = `=IF(B${r}="","",B${r}-C${r})`;
      // Proportional bar; full (and later recoloured) once spend passes the target.
      const barF =
        `=IF(OR(B${r}="",B${r}=0),"",REPT("█",ROUND(MIN(1,C${r}/B${r})*${BAR_WIDTH},0))` +
        `&REPT("░",${BAR_WIDTH}-ROUND(MIN(1,C${r}/B${r})*${BAR_WIDTH},0)))`;
      this.formulaCells.push(
        { row, col: 1, formula: budgetF },
        { row, col: 2, formula: spentF },
        { row, col: 3, formula: leftF },
        { row, col: 4, formula: barF }
      );
      // Number formats: Budget/Spent plain, Left red-when-negative.
      this.cellNumber(row, 1, CURRENCY);
      this.cellNumber(row, 2, CURRENCY);
      this.cellNumber(row, 3, CURRENCY_NEG_RED);
      this.cellAlign(row, 0, "LEFT");
    }
    const lastRow0 = this.matrix.length; // exclusive
    this.budgetFirstRow = firstRow0 + 1;
    this.budgetLastRow = lastRow0; // 1-based inclusive == exclusive 0-based

    // Bar column base colour (blue = under budget); conditional rules recolour it
    // orange/red when overspent (see below).
    this.requests.push({
      repeatCell: {
        range: { sheetId: this.sheetId, startRowIndex: firstRow0, endRowIndex: lastRow0, startColumnIndex: 4, endColumnIndex: 5 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: C.barFull } } },
        fields: "userEnteredFormat.textFormat.foregroundColor",
      },
    });

    // Over-budget colouring on the Left + bar columns (D:E). Two live conditional
    // rules keyed on the sheet's own live cells, so the colour follows the numbers
    // the instant a budget or a transaction changes:
    //   red    — overspent by >= 30% of the target,
    //   orange — overspent by anything less.
    // Red is added last at index 0 so it sits above orange and wins where both hit.
    const f = this.budgetFirstRow;
    this.requests.push(
      this.overBudgetRule(firstRow0, lastRow0, `=AND($B${f}>0,$C${f}>$B${f})`, C.overSome),
      this.overBudgetRule(firstRow0, lastRow0, `=AND($B${f}>0,($C${f}-$B${f})>=${OVER_RED_THRESHOLD}*$B${f})`, C.overBad)
    );

    const note = this.push([
      "Budgets are set on the Budget tab — these figures update live as you edit them.",
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

  /** How much of a monthly target applies to one period of this cadence (as a formula suffix). */
  private prorationSuffix(): string {
    switch (this.cadence) {
      case "daily":
        return "/DAY(EOMONTH(TODAY(),0))"; // ÷ days in the current month
      case "weekly":
        return "*12/52";
      case "monthly":
        return "*1";
      case "yearly":
        return "*12";
    }
  }

  /**
   * The live "Spent this period" formula for category row `r`, as an outflow
   * magnitude scoped to the current period. Ledger dates are ISO *text*, which
   * governs how each cadence is expressed:
   *
   *  - day / month / year use SUMIFS with an equality/`*` wildcard on the text —
   *    text-matching works and full-column SUMIFS is cheap.
   *  - week can't use that (a 7-day span isn't one prefix) and SUMIFS `>=`/`<=`
   *    inequalities silently return 0 against text-stored dates, so the week uses
   *    SUMPRODUCT, whose array `>=`/`<=` compares the text lexicographically (ISO
   *    dates sort correctly) over a bounded range.
   */
  private spentFormula(r: number): string {
    if (this.cadence === "weekly") {
      const mon = `TEXT(TODAY()-WEEKDAY(TODAY(),3),"yyyy-mm-dd")`;
      const sun = `TEXT(TODAY()-WEEKDAY(TODAY(),3)+6,"yyyy-mm-dd")`;
      return (
        `=IFERROR(SUMPRODUCT((Transactions!$F$2:$F$10000=$A${r})` +
        `*(Transactions!$B$2:$B$10000>=${mon})*(Transactions!$B$2:$B$10000<=${sun})` +
        `*(Transactions!$E$2:$E$10000<0)*(-Transactions!$E$2:$E$10000)),0)`
      );
    }
    const crit =
      this.cadence === "daily"
        ? `,Transactions!$B:$B,TEXT(TODAY(),"yyyy-mm-dd")`
        : this.cadence === "monthly"
        ? `,Transactions!$B:$B,TEXT(TODAY(),"yyyy-mm")&"*"`
        : `,Transactions!$B:$B,TEXT(TODAY(),"yyyy")&"*"`; // yearly
    return (
      `=IFERROR(-SUMIFS(Transactions!$E:$E,Transactions!$F:$F,$A${r},` +
      `Transactions!$E:$E,"<0"${crit}),0)`
    );
  }

  /** A conditional-format rule tinting D:E of the budget block when `formula` holds. */
  private overBudgetRule(startRow0: number, endRow0: number, formula: string, color: Rgb): sheets_v4.Schema$Request {
    return {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [
            { sheetId: this.sheetId, startRowIndex: startRow0, endRowIndex: endRow0, startColumnIndex: 3, endColumnIndex: 5 },
          ],
          booleanRule: {
            condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
            format: { textFormat: { foregroundColor: color, bold: true } },
          },
        },
      },
    };
  }

  /**
   * Rollover table (monthly tab only): each budgeted category's year-to-date
   * "banked" figure = target × months-elapsed − spent-YTD. Positive means unspent
   * budget has accumulated; negative (red) means you've overspent for the year.
   * Approximates YNAB rollover under the assumption that the *current* monthly
   * target held for every month so far (we don't snapshot historical targets).
   */
  private rolloverBlock(categories: string[]): void {
    this.sectionLabel("Rollover — budget banked this year");
    const head = this.push(["Category", "Banked YTD", "", "", ""]);
    this.rowFormat(head, {
      backgroundColor: C.headBg,
      horizontalAlignment: "RIGHT",
      textFormat: { foregroundColor: C.headText, fontSize: 9 },
    });
    this.cellAlign(head, 0, "LEFT");

    for (const category of categories) {
      const row = this.push([category, "", "", "", ""]);
      const r = row + 1;
      // SUMIFS over this year's (negative) outflow is already −spentYTD, so ADD it.
      const bankedF =
        `=IFERROR(VLOOKUP($A${r},Budget!$A$5:$B,2,FALSE)*MONTH(TODAY())` +
        `+SUMIFS(Transactions!$E:$E,Transactions!$F:$F,$A${r},Transactions!$E:$E,"<0",` +
        `Transactions!$B:$B,TEXT(TODAY(),"yyyy")&"*"),"")`;
      this.formulaCells.push({ row, col: 1, formula: bankedF });
      this.cellNumber(row, 1, CURRENCY_NEG_RED);
      this.cellAlign(row, 0, "LEFT");
    }

    const note = this.push([
      "Unspent budget from earlier months this year is banked; overspending eats into it. Assumes your current targets held all year.",
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

/** 0-based (row, col) -> A1 address, e.g. (4, 1) -> "B5". */
function a1(row: number, col: number): string {
  let c = col;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (c % 26)) + letters;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${letters}${row + 1}`;
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
