import { sheets_v4 } from "googleapis";
import { config, INSTRUCTIONS_TAB } from "./config";

/**
 * Writes a plain-language "Instructions" tab into the spreadsheet — the manual a
 * non-technical user can reference for where to type things and where to look for
 * results. It's code-owned and rewritten every run, so it can never drift from the
 * actual layout. Only this one tab is touched.
 */

type Line = { text: string; kind: "title" | "h2" | "body" | "tip" };

const MANUAL: Line[] = [
  { text: "How to use this spreadsheet", kind: "title" },
  { text: "It updates itself from the bank automatically. You only ever type in ONE place: the Budget tab.", kind: "body" },

  { text: "Setting your budget (the Budget tab)", kind: "h2" },
  { text: "1. In the “Monthly budget” cell at the top, type how much money you have to budget each month.", kind: "body" },
  { text: "2. Next to each category, type how much of that you want to spend there. That's it — save nothing, it's automatic.", kind: "body" },
  { text: "• “Allocated” = how much you've assigned so far. “Unallocated” = how much you still have left to assign.", kind: "body" },
  { text: "• “Spent (this month)” and “Left” update on their own as money is spent. Orange means you've gone a little over; red means over by 30% or more.", kind: "body" },
  { text: "• “Suggested” shows each category's average spend over the last 3 months — a starting point. Not sure what to budget? Copy that number into the Budget column.", kind: "body" },
  { text: "Your numbers stay put — they are never erased. You only retype if you want to change them.", kind: "tip" },

  { text: "Seeing your spending (Daily / Weekly / Monthly / Yearly tabs)", kind: "h2" },
  { text: "Each tab shows the transactions for that period only: today, this week (from Monday), this month, this year.", kind: "body" },
  { text: "The top shows an overview, then your budget vs spending (which updates live the moment you edit a budget on the Budget tab), then the biggest purchases and each card/account with its transactions.", kind: "body" },
  { text: "• The Daily tab shows “Safe to spend today” — what's left of your monthly budget, split over the days remaining in the month.", kind: "body" },
  { text: "• Weekly/Monthly/Yearly show a “Projected” total — where your spending is headed at the current pace, so you can catch overspending early.", kind: "body" },
  { text: "• The Monthly tab's “Rollover” shows budget banked this year: unspent budget from earlier months adds up (green), overspending eats into it (red).", kind: "body" },
  { text: "These tabs refresh by themselves. Don't type in them — anything typed here gets overwritten on the next update.", kind: "tip" },

  { text: "The Transactions tab", kind: "h2" },
  { text: "The full list of every transaction. It fills in automatically — nothing to do here.", kind: "body" },

  { text: "In short", kind: "h2" },
  { text: "Type your budget on the Budget tab. Look at the Monthly tab (or Daily/Weekly/Yearly) to see how you're doing. Everything else takes care of itself.", kind: "body" },
  { text: "Questions? Ask Stephan.", kind: "tip" },
];

export async function writeInstructions(
  api: sheets_v4.Sheets,
  sheetIdByTitle: Map<string, number>
): Promise<void> {
  let sheetId = sheetIdByTitle.get(INSTRUCTIONS_TAB);
  if (sheetId == null) {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: INSTRUCTIONS_TAB, index: 0 } } }],
      },
    });
    const id = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (id == null) throw new Error("Failed to create the Instructions tab.");
    sheetId = id;
    sheetIdByTitle.set(INSTRUCTIONS_TAB, sheetId);
  }

  await api.spreadsheets.values.clear({
    spreadsheetId: config.google.sheetId,
    range: `${INSTRUCTIONS_TAB}`,
  });
  await api.spreadsheets.values.update({
    spreadsheetId: config.google.sheetId,
    range: `${INSTRUCTIONS_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: MANUAL.map((l) => [l.text]) },
  });

  const slate700 = rgb(0x33, 0x41, 0x55);
  const slate600 = rgb(0x47, 0x55, 0x69);
  const amber900 = rgb(0x78, 0x35, 0x0f);
  const amber50 = rgb(0xff, 0xfb, 0xeb);
  const white = { red: 1, green: 1, blue: 1 };

  const requests: sheets_v4.Schema$Request[] = [
    // Reset formatting + widen the single text column, then style per line.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: MANUAL.length + 5, startColumnIndex: 0, endColumnIndex: 3 },
        cell: { userEnteredFormat: {} },
        fields: "userEnteredFormat",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 760 },
        fields: "pixelSize",
      },
    },
  ];

  MANUAL.forEach((line, i) => {
    let fmt: sheets_v4.Schema$CellFormat;
    switch (line.kind) {
      case "title":
        fmt = { backgroundColor: slate700, textFormat: { bold: true, fontSize: 15, foregroundColor: white } };
        break;
      case "h2":
        fmt = { textFormat: { bold: true, fontSize: 12, foregroundColor: slate700 } };
        break;
      case "tip":
        fmt = { backgroundColor: amber50, textFormat: { italic: true, foregroundColor: amber900 } };
        break;
      default:
        fmt = { textFormat: { foregroundColor: slate600 }, wrapStrategy: "WRAP" };
    }
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: fmt },
        fields: `userEnteredFormat(${Object.keys(fmt).join(",")})`,
      },
    });
  });

  await api.spreadsheets.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: { requests },
  });
}

function rgb(r: number, g: number, b: number) {
  return { red: r / 255, green: g / 255, blue: b / 255 };
}
