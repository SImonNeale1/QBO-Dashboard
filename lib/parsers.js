/**
 * QuickBooks Online report parsers.
 */

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

  walkReport(raw.Rows?.Row || [], row => {
    const label = rowLabel(row);
    const value = rowValue(row);

    if (/^total income$/i.test(label)) result.revenue = value;
    if (/^total cost of (goods sold|sales|revenue)$/i.test(label)) result.costOfSales = value;
    if (/^total expenses$/i.test(label)) result.expenses = value;
    if (/^net income$/i.test(label)) result.netIncome = value;
  });

  result.grossProfit = result.revenue - result.costOfSales;
  result.grossMarginPct = result.revenue
    ? round((result.grossProfit / result.revenue) * 100, 1)
    : 0;
  result.netMarginPct = result.revenue
    ? round((result.netIncome / result.revenue) * 100, 1)
    : 0;

  return result;
}

export function parseBalanceSheet(raw) {
  const result = {
    currency: raw.Header?.Currency || 'GBP',
    asOf: raw.Header?.EndPeriod || null,
    fixedAssets: 0,
    cash: 0,
    accountsReceivable: 0,
    currentAssets: 0,
    totalAssets: 0,
    accountsPayable: 0,
    currentLiabilities: 0,
    longTermLiabilities: 0,
    totalLiabilities: 0,
    equity: 0,
    netAssets: 0,
    depreciation: 0,
    provisions: 0,
    sections: [],
  };

  const candidates = {
    fixedAssets: [],
    cash: [],
    receivables: [],
    currentAssets: [],
    totalAssets: [],
    payables: [],
    currentLiabilities: [],
    longTermBase: [],
    provisions: [],
    totalLiabilities: [],
    equity: [],
  };

  walkReport(raw.Rows?.Row || [], (row, depth) => {
    const label = normalise(rowLabel(row));
    if (!label) return;

    const value = rowValue(row);
    const sectionRows = extractRows(row);
    const record = { label, value, depth, sectionRows };

    if (isFixedAssets(label)) candidates.fixedAssets.push(record);
    if (isCashSection(label)) candidates.cash.push(record);
    if (isReceivables(label)) candidates.receivables.push(record);
    if (isCurrentAssets(label)) candidates.currentAssets.push(record);
    if (/^total assets?$/i.test(label)) candidates.totalAssets.push(record);
    if (isPayables(label)) candidates.payables.push(record);
    if (isCurrentLiabilities(label)) candidates.currentLiabilities.push(record);
    if (isLongTermBase(label)) candidates.longTermBase.push(record);
    if (isProvision(label)) candidates.provisions.push(record);
    if (/^total liabilities$/i.test(label)) candidates.totalLiabilities.push(record);
    if (isEquity(label)) candidates.equity.push(record);
  });

  const allAccounts = extractAllDataRows(raw.Rows?.Row || []);

  // Use authoritative QBO section summaries first. Deepest matching section is
  // normally the specific category rather than its parent container.
  result.fixedAssets = bestValue(candidates.fixedAssets);
  result.cash = bestValue(candidates.cash);
  result.accountsReceivable = bestValue(candidates.receivables);
  result.currentAssets = bestValue(candidates.currentAssets);
  result.totalAssets = bestValue(candidates.totalAssets);
  result.accountsPayable = bestValue(candidates.payables);
  result.currentLiabilities = bestValue(candidates.currentLiabilities);
  result.equity = bestValue(candidates.equity);

  // UK balance sheets often show provisions as a separate sibling section.
  // Keep it separate from loans/creditors, then include it once in long term liabilities.
  const longTermBase = bestValue(candidates.longTermBase);
  result.provisions = bestValue(candidates.provisions);
  result.longTermLiabilities = longTermBase + result.provisions;

  // Fallbacks only run when QBO supplied no recognised section summary.
  if (!result.cash) {
    result.cash = sumAccounts(allAccounts, isCashAccount);
  }

  if (!result.accountsReceivable) {
    result.accountsReceivable = sumAccounts(
      allAccounts,
      name => /accounts receivable|trade debtors|trade receivables|^debtors$|^a\/r$/i.test(name)
    );
  }

  if (!result.accountsPayable) {
    result.accountsPayable = sumAccounts(
      allAccounts,
      name => /accounts payable|trade creditors|trade payables|^a\/p$/i.test(name)
    );
  }

  if (!result.fixedAssets) {
    result.fixedAssets = sumAccounts(
      allAccounts,
      name => /fixed asset|property|plant|machinery|equipment|vehicle|fixture|fitting|building|land/i.test(name)
        && !/depreciation/i.test(name)
    );
  }

  if (!result.provisions) {
    result.provisions = sumAccounts(
      allAccounts,
      name => /provision for liabilities and charges|provisions? for liabilities|provisions? and charges|warranty provision|deferred tax provision/i.test(name)
    );
    result.longTermLiabilities = longTermBase + result.provisions;
  }

  if (!result.currentLiabilities) {
    result.currentLiabilities = sumAccounts(
      allAccounts,
      name => /accounts payable|trade creditors|trade payables|vat|sales tax|paye|national insurance|accrual|credit card|short.?term loan|current portion/i.test(name)
        && !isProvision(name)
    );
  }

  if (!result.longTermLiabilities) {
    result.longTermLiabilities = sumAccounts(
      allAccounts,
      name => /long.?term loan|long.?term debt|finance lease|hire purchase|mortgage|debenture|amounts falling due after more than one year/i.test(name)
        || isProvision(name)
    );
  }

  if (!result.currentAssets) {
    result.currentAssets = result.cash
      + result.accountsReceivable
      + sumAccounts(
        allAccounts,
        name => /inventory|stock|prepayment|prepaid|other current asset/i.test(name)
      );
  }

  // Recalculate totals from the category totals shown on the dashboard.
  // Cash and receivables are already included in current assets.
  result.totalAssets = result.fixedAssets + result.currentAssets;

  // Accounts payable is already included in current liabilities.
  result.totalLiabilities = result.currentLiabilities + result.longTermLiabilities;
  result.netAssets = result.totalAssets - result.totalLiabilities;

  return result;
}

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

  walkReport(raw.Rows?.Row || [], row => {
    const label = rowLabel(row);
    const value = rowValue(row);

    if (/operating/i.test(label)) result.operating = value;
    else if (/investing/i.test(label)) result.investing = value;
    else if (/financing/i.test(label)) result.financing = value;
    else if (/net (change|increase|decrease)/i.test(label)) result.netChange = value;
    else if (/opening|beginning/i.test(label)) result.openingBalance = value;
    else if (/closing|ending/i.test(label)) result.closingBalance = value;
  });

  return result;
}

function walkReport(rows, callback, depth = 0) {
  for (const row of rows || []) {
    callback(row, depth);
    if (row.Rows?.Row) walkReport(row.Rows.Row, callback, depth + 1);
  }
}

function rowLabel(row) {
  return String(
    row?.Header?.ColData?.[0]?.value
      || row?.Summary?.ColData?.[0]?.value
      || row?.ColData?.[0]?.value
      || ''
  ).trim();
}

function rowValue(row) {
  return amountFromColumns(
    row?.Summary?.ColData
      || row?.ColData
      || []
  );
}

function amountFromColumns(columns) {
  for (let i = columns.length - 1; i >= 1; i -= 1) {
    const raw = columns[i]?.value;
    if (raw !== undefined && raw !== null && raw !== '' && isNumeric(raw)) {
      return toNum(raw);
    }
  }
  return 0;
}

function bestValue(records) {
  const nonZero = records.filter(record => Math.abs(record.value) > 0.000001);
  if (!nonZero.length) return 0;

  nonZero.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return labelPriority(b.label) - labelPriority(a.label);
  });

  return nonZero[0].value;
}

function labelPriority(label) {
  if (/^total /i.test(label)) return 4;
  if (/^bank accounts?$|^cash and cash equivalents$|^cash at bank and in hand$/i.test(label)) return 5;
  return 1;
}

function isFixedAssets(label) {
  return /^total fixed assets?$|^fixed assets?$|^property,? plant and equipment$|^tangible fixed assets?$|^non.?current assets?$/i.test(label);
}

function isCashSection(label) {
  return /^bank accounts?$|^total bank accounts?$|^cash$|^total cash$|^cash and cash equivalents$|^total cash and cash equivalents$|^cash at bank and in hand$/i.test(label);
}

function isCashAccount(name) {
  const text = normalise(name);
  const excluded = /loan|overdraft|credit card|mortgage|payable|liability|finance|hire purchase/i.test(text);
  const cashLike = /cash|bank|current account|business account|savings|deposit|reserve account/i.test(text);
  return cashLike && !excluded;
}

function isReceivables(label) {
  return /^accounts receivable$|^total accounts receivable$|^trade debtors$|^trade receivables$|^debtors$|^a\/r$/i.test(label);
}

function isCurrentAssets(label) {
  return /^current assets?$|^total current assets?$/i.test(label);
}

function isPayables(label) {
  return /^accounts payable$|^total accounts payable$|^trade creditors$|^trade payables$|^a\/p$/i.test(label);
}

function isCurrentLiabilities(label) {
  return /^current liabilities$|^total current liabilities$|^other current liabilities$|^total other current liabilities$/i.test(label)
    || /creditors.*within one year|amounts falling due within one year|short.?term liabilities/i.test(label);
}

function isLongTermBase(label) {
  return /^long.?term liabilities$|^total long.?term liabilities$|^non.?current liabilities$|^total non.?current liabilities$/i.test(label)
    || /creditors.*after more than one year|amounts falling due after more than one year/i.test(label);
}

function isProvision(label) {
  return /provisions? for liabilities and charges|provisions? for liabilities|provisions? and charges|^provisions?$/i.test(label);
}

function isEquity(label) {
  return /^equity$|^total equity$|shareholders.? equity|stockholders.? equity|capital and reserves/i.test(label);
}

function extractRows(section) {
  const rows = [];
  walkReport(section?.Rows?.Row || [], row => {
    if ((row.type === 'Data' || row.ColData) && row.ColData) {
      const name = String(row.ColData[0]?.value || '').trim();
      if (name) rows.push({ name, amount: amountFromColumns(row.ColData) });
    }
  });
  return rows;
}

function extractAllDataRows(rows) {
  const output = [];
  walkReport(rows, row => {
    if ((row.type === 'Data' || row.ColData) && row.ColData) {
      const name = String(row.ColData[0]?.value || '').trim();
      if (name) output.push({ name, amount: amountFromColumns(row.ColData) });
    }
  });
  return output;
}

function sumAccounts(rows, matcher) {
  return rows.reduce((sum, row) => {
    const name = normalise(row.name);
    return matcher(name) ? sum + toNum(row.amount) : sum;
  }, 0);
}

function normalise(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNumeric(value) {
  const cleaned = String(value).trim().replace(/[£$€,\s()]/g, '');
  return cleaned !== '' && Number.isFinite(Number.parseFloat(cleaned));
}

function toNum(value) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim().replace(/[£$€,]/g, '');
  const negative = /^\(.*\)$/.test(text);
  const number = Number.parseFloat(text.replace(/[()]/g, ''));
  if (!Number.isFinite(number)) return 0;
  return negative ? -Math.abs(number) : number;
}

function round(number, decimalPlaces) {
  return Math.round(number * (10 ** decimalPlaces)) / (10 ** decimalPlaces);
}
