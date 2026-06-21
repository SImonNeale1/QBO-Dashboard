/**
 * parsers.js
 *
 * QBO report responses are deeply nested and inconsistent.
 * These helpers extract the numbers the dashboard actually needs.
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

      // ✅ Extract TRUE totals from Summary rows
      if (row.Summary?.ColData) {
        const cols = row.Summary.ColData;
        const label = cols[0]?.value || '';
        const value = toNum(cols[1]?.value || cols.at(-1)?.value);

        if (label === 'Total Income') {
          result.revenue = value;
        }

        
        if (/total.*cost.*(goods|sales|revenue)/i.test(label)) {
          result.costOfSales = value;   
        }


        if (label === 'Total Expenses') {
          result.expenses = value;
        }

        if (label === 'Net Income') {
          result.netIncome = value;
        }
      }

      // ✅ Keep your detailed sections logic unchanged
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

      // ✅ Continue traversal
      if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
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

// ── Balance Sheet ──────────────────────────────────────────────────────────

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

    if (/current assets/i.test(header)) {
      result.currentAssets = summary;
     
      const headerLower = header.toLowerCase();
      if (headerLower.includes('cash')) {
         result.cash = summary;
      }

      result.accountsReceivable = findLineValue(rows, /accounts? receivable|debtors?/i);
      result.sections.push({ name: header, amount: summary, rows });
    } else if (/fixed assets|property|equipment/i.test(header)) {
      result.fixedAssets = summary;
      result.sections.push({ name: header, amount: summary, rows });
    } else if (/total assets/i.test(header)) {
      result.totalAssets = summary;
    } else if (/current liabilities/i.test(header)) {
      result.currentLiabilities = summary;
      result.accountsPayable = findLineValue(rows, /accounts? payable|creditors?/i);
      result.sections.push({ name: header, amount: summary, rows });
    } else if (/long.?term liabilities/i.test(header)) {
      result.longTermLiabilities = summary;
      result.sections.push({ name: header, amount: summary, rows });
    } else if (/total liabilities/i.test(header)) {
      result.totalLiabilities = summary;
    } else if (/equity/i.test(header)) {
      result.equity = summary;
    }
  }

  result.netAssets = result.totalAssets - result.totalLiabilities;
  return result;
}

// ── Cash Flow ──────────────────────────────────────────────────────────────

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

    if (/operating/i.test(header))           result.operating = summary;
    else if (/investing/i.test(header))      result.investing = summary;
    else if (/financing/i.test(header))      result.financing = summary;
    else if (/net (change|increase|decrease)/i.test(header)) result.netChange = summary;
    else if (/opening|beginning/i.test(header)) result.openingBalance = summary;
    else if (/closing|ending/i.test(header)) result.closingBalance = summary;
  }

  return result;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Find the summary/total value in a QBO report section row.
 * QBO puts totals in a Summary sub-row with ColData[1].value
 */
function findSummaryValue(row) {
  const summary = row.Summary?.ColData;
  if (summary) return toNum(summary[1]?.value || summary[summary.length - 1]?.value);

  // Sometimes it's a direct data row
  const cols = row.ColData;
  if (cols) return toNum(cols[1]?.value || cols[cols.length - 1]?.value);

  return 0;
}

/**
 * Pull all Data rows out of a section into flat { name, amount } objects
 */
function extractRows(section) {
  const rows = [];
  for (const row of section.Rows?.Row || []) {
    if (row.type === 'Data') {
      const cols = row.ColData || [];
      const name   = cols[0]?.value;
      const amount = toNum(cols[1]?.value || cols[cols.length - 1]?.value);
      if (name) rows.push({ name, amount });
    }
    // Recurse into sub-sections
    if (row.type === 'Section') {
      rows.push(...extractRows(row));
    }
  }
  return rows;
}

/**
 * Search extracted rows for a line matching a regex, return its amount
 */
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
