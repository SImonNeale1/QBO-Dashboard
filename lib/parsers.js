/**
 * parsers.js
 */

// ── Profit & Loss ──────────────────────────────────────────────────────────

export function parsePL(raw) {
  const result = {
    currency: raw.Header?.Currency || 'GBP',
    startDate: raw.Header?.StartPeriod,
    endDate: raw.Header?.EndPeriod,
    revenue: 0,
    costOfSales: 0,
    grossProfit: 0,
    expenses: 0,
    netIncome: 0,
    sections: [],
  };

  function walk(rows = []) {
    for (const row of rows) {

      const label = getLabel(row);

      if (row.Summary?.ColData) {
        const value = toNum(row.Summary.ColData.at(-1)?.value);

        if (label === 'Total Income') result.revenue = value;
        if (/total.*cost/i.test(label)) result.costOfSales = value;
        if (label === 'Total Expenses') result.expenses = value;
        if (label === 'Net Income') result.netIncome = value;
      }

      if (/income|revenue/i.test(label)) {
        result.sections.push({
          name: label,
          amount: findSummaryValue(row),
          rows: extractRows(row)
        });
      }

      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  }

  walk(raw.Rows?.Row || []);

  result.grossProfit = result.revenue - result.costOfSales;

  result.grossMarginPct = result.revenue
    ? round(result.grossProfit / result.revenue * 100, 1)
    : 0;

  result.netMarginPct = result.revenue
    ? round(result.netIncome / result.revenue * 100, 1)
    : 0;

  return result;
}

// ── Balance Sheet (✅ FINAL FIX) ───────────────────────────────────────────

export function parseBalanceSheet(raw) {
  const result = {
    asOf: raw.Header?.EndPeriod,
    currentAssets: 0,
    fixedAssets: 0,
    depreciation: 0,
    totalAssets: 0,
    currentLiabilities: 0,
    longTermLiabilities: 0,
    totalLiabilities: 0,
    equity: 0,
    cash: 0,
    accountsReceivable: 0,
    accountsPayable: 0,
    sections: [],
  };

  function walk(rows = []) {
    for (const row of rows) {

      const header = getLabel(row);
      const h = header.toLowerCase();

      const summary = findSummaryValue(row);
      const extractedRows = extractRows(row);

      // ✅ CASH
      if (/cash|bank/.test(h)) {
        result.cash = summary;
      }

      // ✅ AR
      if (/receivable|debtor/.test(h)) {
        result.accountsReceivable = summary;
      }

      // ✅ DEPRECIATION
      if (/depreciation/.test(h)) {
        result.depreciation = summary;
      }

      // ✅ CURRENT ASSETS
      if (/current assets/.test(h)) {
        result.currentAssets = summary;

        result.sections.push({
          name: header,
          amount: summary,
          rows: extractedRows
        });
      }

      // ✅ ✅ ✅ FIXED ASSETS (NOW DEFINITELY FOUND)
      if (
        /fixed assets/.test(h) ||
        /non.?current/.test(h) ||
        /property/.test(h) ||
        /plant/.test(h) ||
        /equipment/.test(h) ||
        /ppe/.test(h)
      ) {
        if (!/current assets|total assets/.test(h)) {
          result.fixedAssets = summary;

          result.sections.push({
            name: header,
            amount: summary,
            rows: extractedRows
          });
        }
      }

      // ✅ TOTAL ASSETS
      if (/total assets/.test(h)) {
        result.totalAssets = summary;
      }

      // ✅ LIABILITIES
      if (/current liabilities/.test(h)) {

        result.currentLiabilities = extractedRows
          .filter(r =>
            /payable|creditor|vat|tax|accrual|loan/i.test(r.name)
          )
          .reduce((s, r) => s + r.amount, 0);

        result.accountsPayable = extractedRows
          .filter(r => /payable|creditor|a\/p/i.test(r.name))
          .reduce((s, r) => s + r.amount, 0);
      }

      if (/long.?term liabilities/.test(h)) {
        result.longTermLiabilities = summary;
      }

      if (/total liabilities/.test(h)) {
        result.totalLiabilities = summary;
      }

      if (/equity/.test(h)) {
        result.equity = summary;
      }

      // ✅ recurse
      if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  if (!result.totalAssets) {
    result.totalAssets = result.currentAssets + result.fixedAssets;
  }

  if (!result.totalLiabilities) {
    result.totalLiabilities =
      result.currentLiabilities + result.longTermLiabilities;
  }

  result.netAssets = result.totalAssets - result.totalLiabilities;

  return result;
}

// ── Cash Flow ─────────────────────────────────────────────────────────────

export function parseCashFlow(raw) {
  const result = {
    startDate: raw.Header?.StartPeriod,
    endDate: raw.Header?.EndPeriod,
    operating: 0,
    investing: 0,
    financing: 0,
    netChange: 0,
    openingBalance: 0,
    closingBalance: 0,
  };

  for (const row of raw.Rows?.Row || []) {
    const header = getLabel(row).toLowerCase();
    const summary = findSummaryValue(row);

    if (/operating/.test(header)) result.operating = summary;
    else if (/investing/.test(header)) result.investing = summary;
    else if (/financing/.test(header)) result.financing = summary;
    else if (/net/.test(header)) result.netChange = summary;
    else if (/opening/.test(header)) result.openingBalance = summary;
    else if (/closing/.test(header)) result.closingBalance = summary;
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getLabel(row) {
  return (
    row.Header?.ColData?.[0]?.value ||
    row.Summary?.ColData?.[0]?.value ||
    ''
  );
}

function findSummaryValue(row) {
  const summary = row.Summary?.ColData;
  if (summary) return toNum(summary.at(-1)?.value);
  return 0;
}

function extractRows(section) {
  const rows = [];
  for (const row of section.Rows?.Row || []) {
    if (row.type === 'Data') {
      const cols = row.ColData || [];
      const name = cols[0]?.value;
      const amount = toNum(cols.at(-1)?.value);
      if (name) rows.push({ name, amount });
    }
    if (row.type === 'Section') {
      rows.push(...extractRows(row));
    }
  }
  return rows;
}

function toNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function round(n, dp) {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}
