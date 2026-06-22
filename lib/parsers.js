/**
 * parsers.js
 *
 * QBO report ── Profit & Loss ────────────────────────────────────────────────────────── * QBO report responses are deeply nested and inconsistent.

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

      if (row.Summary?.ColData) {
        const cols = row.Summary.ColData;
        const label = cols[0]?.value || '';
        const value = toNum(cols[1]?.value || cols.at(-1)?.value);

        if (label === 'Total Income') result.revenue = value;
        if (/total.*cost.*(goods|sales|revenue)/i.test(label)) result.costOfSales = value;
        if (label === 'Total Expenses') result.expenses = value;
        if (label === 'Net Income') result.netIncome = value;
      }

      if (row.Header?.ColData?.[0]?.value) {
        const header = row.Header.ColData[0].value;
        const summary = findSummaryValue(row);

        if (/income|revenue/i.test(header)) {
          result.sections.push({ name: header, amount: summary, rows: extractRows(row) });
        } else if (/cost of (goods|sales|revenue)/i.test(header)) {
          result.sections.push({ name: header, amount: summary, rows: extractRows(row) });
        } else if (/expenses?/i.test(header)) {
          result.sections.push({ name: header, amount: summary, rows: extractRows(row) });
        }
      }

      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  }

  walk(raw.Rows?.Row || []);

  result.grossProfit = result.revenue - result.costOfSales;

  result.grossMarginPct = result.revenue !== 0
    ? round(result.grossProfit / result.revenue * 100, 1)
    : 0;

  result.netMarginPct = result.revenue !== 0
    ? round(result.netIncome / result.revenue * 100, 1)
    : 0;

  return result;
}

// ── Balance Sheet (✅ FIXED VERSION) ───────────────────────────────────────

export function parseBalanceSheet(raw) {
  const result = {
    asOf: raw.Header?.EndPeriod,
    currentAssets: 0,
    fixedAssets: 0,
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

  for (const row of raw.Rows?.Row || []) {
    const header = row.Header?.ColData?.[0]?.value || '';
    const summary = findSummaryValue(row);
    const rows = extractRows(row);

    // ✅ FIX 1 — AR as separate section
    if (/accounts receivable|debtors|a\/r/i.test(header)) {
      result.accountsReceivable = summary;
    }

    // ✅ CURRENT ASSETS
    if (/current assets/i.test(header)) {
      result.currentAssets = summary;

      // ✅ Cash (from detailed rows)
      result.cash = rows
        .filter(r => /cash|bank/i.test(r.name))
        .reduce((sum, r) => sum + r.amount, 0);

      // ✅ Fallback AR (if inside section)
      if (!result.accountsReceivable) {
        result.accountsReceivable = rows
          .filter(r => /receivable|debtor/i.test(r.name))
          .reduce((sum, r) => sum + r.amount, 0);
      }

      result.sections.push({ name: header, amount: summary, rows });
    }

    // ✅ FIXED ASSETS
    else if (/fixed assets|property|equipment/i.test(header)) {
      result.fixedAssets = summary;
      result.sections.push({ name: header, amount: summary, rows });
    }

    // ✅ TOTAL ASSETS
    else if (/total assets/i.test(header)) {
      result.totalAssets = summary;
    }

    // ✅ CURRENT LIABILITIES
    else if (/current liabilities/i.test(header)) {
      result.currentLiabilities = summary;

      result.accountsPayable = rows
        .filter(r => /payable|creditor|a\/p/i.test(r.name))
        .reduce((sum, r) => sum + r.amount, 0);

      result.sections.push({ name: header, amount: summary, rows });
    }

    // ✅ LONG TERM LIABILITIES
    else if (/long.?term liabilities/i.test(header)) {
      result.longTermLiabilities = summary;
      result.sections.push({ name: header, amount: summary, rows });
    }

    // ✅ TOTAL LIABILITIES
    else if (/total liabilities/i.test(header)) {
      result.totalLiabilities = summary;
    }

    // ✅ EQUITY
    else if (/equity/i.test(header)) {
      result.equity = summary;
    }
  }

  // ✅ FORCE TOTALS
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
    const header = row.Header?.ColData?.[0]?.value || '';
    const summary = findSummaryValue(row);

    if (/operating/i.test(header)) result.operating = summary;
    else if (/investing/i.test(header)) result.investing = summary;
    else if (/financing/i.test(header)) result.financing = summary;
    else if (/net (change|increase|decrease)/i.test(header)) result.netChange = summary;
    else if (/opening|beginning/i.test(header)) result.openingBalance = summary;
    else if (/closing|ending/i.test(header)) result.closingBalance = summary;
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function findSummaryValue(row) {
  const summary = row.Summary?.ColData;
  if (summary) return toNum(summary[1]?.value || summary[summary.length - 1]?.value);

  const cols = row.ColData;
  if (cols) return toNum(cols[1]?.value || cols[cols.length - 1]?.value);

  return 0;
}

function extractRows(section) {
  const rows = [];
  for (const row of section.Rows?.Row || []) {
    if (row.type === 'Data') {
      const cols = row.ColData || [];
      const name = cols[0]?.value;
      const amount = toNum(cols[1]?.value || cols[cols.length - 1]?.value);
      if (name) rows.push({ name, amount });
    }
    if (row.type === 'Section') {
      rows.push(...extractRows(row));
    }
  }
  return rows;
}

function findLineValue(rows, regex) {
  return rows.find(r => regex.test(r.name))?.amount || 0;
}

function toNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function round(n, dp) {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}
 * These helpers extract the numbers the dashboard actually needs.
 */

