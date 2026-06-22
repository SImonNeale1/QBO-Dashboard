
/**
 * parsers.js
 */
 //FUNCTION WRAPPER (fixes illegal return, does not remove anything) * QBO report responses are deeply nested and inconsistent.
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
          result.sections.push({
            name: header,
            amount: summary,
            rows: extractRows(row)
          });
        } else if (/cost of/i.test(header)) {
          result.sections.push({
            name: header,
            amount: summary,
            rows: extractRows(row)
          });
        } else if (/expenses?/i.test(header)) {
          result.sections.push({
            name: header,
            amount: summary,
            rows: extractRows(row)
          });
        }
      }

      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  }

  walk(raw.Rows?.Row || []);

  result.grossProfit = result.revenue - result.costOfSales;
  result.grossMarginPct = result.revenue ? round(result.grossProfit / result.revenue * 100, 1) : 0;
  result.netMarginPct = result.revenue ? round(result.netIncome / result.revenue * 100, 1) : 0;

  return result;
}


// ── Balance Sheet ─────────────────────────────────────────────────────────

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
    tradeCreditors: 0,
    creditCards: 0,
  };

  function walk(rows = []) {
    for (const row of rows) {

      const header =
        row.Header?.ColData?.[0]?.value ||
        row.Summary?.ColData?.[0]?.value ||
        '';

      const h = header.toLowerCase().trim();
      const summary = findSummaryValue(row);

      if (/cash|bank/i.test(header)) result.cash = summary;
      if (/accounts receivable|debtors|a\/r/i.test(header)) result.accountsReceivable = summary;
      if (h === 'current assets') result.currentAssets = summary;
      if (h === 'non-current assets' || h === 'non current assets') result.fixedAssets = summary;
      if (h === 'total assets') result.totalAssets = summary;
      if (h === 'total liabilities') result.totalLiabilities = summary;
      if (h.includes('long term liabilities')) result.longTermLiabilities = summary;
      if (h.includes('equity')) result.equity = summary;

      // ✅ FIXED
      if (h.includes('current liabilities') && summary) {
        result.currentLiabilities = summary;
      }

      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  }

  walk(raw.Rows?.Row || []);

  const allRows = extractRows({ Rows: raw.Rows });

  let base = 0;
  let trade = 0;
  let cards = 0;
  let creditorsDueWithinYear = null;

  for (const r of allRows) {

    const name = (r.name || '').toLowerCase();
    const value = r.amount;

    if (name.includes('trade')) {
      trade = value;
    }

    if (name.includes('credit card')) {
      cards = value;
    }

    if (name.includes('creditors') && name.includes('within one year')) {
      // debug
    }

    if (name.startsWith && name.startsWith('total for') && name.includes('trade')) {
      trade = value;
    }

    if (name.startsWith && name.startsWith('total for') && name.includes('credit card')) {
      cards = value;
    }

    if (name.includes('creditors') && name.includes('due within one year')) {
      creditorsDueWithinYear = value;
    }
  }

  result.tradeCreditors = trade;
  result.creditCards = cards;

  if (!result.currentLiabilities) {
    result.currentLiabilities = base;
  }

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
    else if (/net/i.test(header)) result.netChange = summary;
    else if (/opening|beginning/i.test(header)) result.openingBalance = summary;
    else if (/closing|ending/i.test(header)) result.closingBalance = summary;
  }

  return result;
}


// ── Helpers ───────────────────────────────────────────────────────────────

function findSummaryValue(row) {
  const summary = row.Summary?.ColData;
  if (summary) return toNum(summary[1]?.value || summary.at(-1)?.value);

  const cols = row.ColData;
  if (cols) return toNum(cols[1]?.value || cols.at(-1)?.value);

  return 0;
}

function extractRows(section) {
  const rows = [];
  for (const row of section.Rows?.Row || []) {
    if (row.type === 'Data') {
      const name = row.ColData?.[0]?.value;
      const amount = toNum(row.ColData?.at(-1)?.value);
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
