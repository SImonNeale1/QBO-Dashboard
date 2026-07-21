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
      if (row.Summary?.ColData) {
        const cols = row.Summary.ColData;
        const label = getColumnLabel(cols);
        const value = getColumnAmount(cols);

        if (/^total income$/i.test(label)) {
          result.revenue = value;
        }

        if (/total.*cost.*(goods|sales|revenue)/i.test(label)) {
          result.costOfSales = value;
        }

        if (/^total expenses$/i.test(label)) {
          result.expenses = value;
        }

        if (/^net income$/i.test(label)) {
          result.netIncome = value;
        }
      }

      const header = getRowHeader(row);

      if (header) {
        const summary = findSummaryValue(row);

        if (/income|revenue/i.test(header)) {
          result.sections.push({
            name: header,
            amount: summary,
            rows: extractRows(row),
          });
        } else if (/cost of (goods|sales|revenue)/i.test(header)) {
          result.sections.push({
            name: header,
            amount: summary,
            rows: extractRows(row),
          });
        } else if (/expenses?/i.test(header)) {
          result.sections.push({
            name: header,
            amount: summary,
            rows: extractRows(row),
          });
        }
      }

      if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  result.grossProfit = result.revenue - result.costOfSales;

  result.grossMarginPct =
    result.revenue !== 0
      ? round((result.grossProfit / result.revenue) * 100, 1)
      : 0;

  result.netMarginPct =
    result.revenue !== 0
      ? round((result.netIncome / result.revenue) * 100, 1)
      : 0;

  return result;
}

// ── Balance Sheet ──────────────────────────────────────────────────────────

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
    sections: [],
  };

  function walk(rows = []) {
    for (const row of rows) {
      const header = getRowHeader(row);
      const summaryLabel = getSummaryLabel(row);
      const label = header || summaryLabel;

      const normalLabel = normaliseLabel(label);
      const summary = findSummaryValue(row);
      const sectionRows = extractRows(row);

      // Fixed assets
      if (isFixedAssetsLabel(normalLabel)) {
        result.fixedAssets = preferSectionValue(
          summary,
          sectionRows
        );

        const depreciation = sumMatchingAccounts(
          sectionRows,
          /accumulated depreciation|depreciation/i
        );

        if (depreciation !== 0) {
          result.depreciation = depreciation;
        }

        addSection(
          result,
          label,
          result.fixedAssets,
          sectionRows
        );
      }

      // Cash and bank
      if (isCashLabel(normalLabel)) {
        const value = preferSectionValue(
          summary,
          sectionRows
        );

        if (value !== 0) {
          result.cash = value;
        }
      }

      // Accounts receivable
      if (isReceivablesLabel(normalLabel)) {
        const value = preferSectionValue(
          summary,
          sectionRows
        );

        if (value !== 0) {
          result.accountsReceivable = value;
        }
      }

      // Current assets
      if (isCurrentAssetsLabel(normalLabel)) {
        result.currentAssets = preferSectionValue(
          summary,
          sectionRows
        );

        const cash = sumMatchingAccounts(
          sectionRows,
          /cash|bank|current account|deposit/i
        );

        if (cash !== 0) {
          result.cash = cash;
        }

        const receivables = sumMatchingAccounts(
          sectionRows,
          /accounts receivable|trade debtors|debtors|a\/r/i
        );

        if (receivables !== 0) {
          result.accountsReceivable = receivables;
        }

        addSection(
          result,
          label,
          result.currentAssets,
          sectionRows
        );
      }

      // Total assets
      if (/^total assets?$/i.test(normalLabel)) {
        result.totalAssets = summary;
      }

      // Accounts payable
      if (isPayablesLabel(normalLabel)) {
        const value = preferSectionValue(
          summary,
          sectionRows
        );

        if (value !== 0) {
          result.accountsPayable = value;
        }
      }

      // Current liabilities
      if (isCurrentLiabilitiesLabel(normalLabel)) {
        result.currentLiabilities = preferSectionValue(
          summary,
          sectionRows
        );

        const accountsPayable = sumMatchingAccounts(
          sectionRows,
          /accounts payable|trade creditors|creditors|a\/p/i
        );

        if (accountsPayable !== 0) {
          result.accountsPayable = accountsPayable;
        }

        addSection(
          result,
          label,
          result.currentLiabilities,
          sectionRows
        );
      }

      // Long-term liabilities
      if (isLongTermLiabilitiesLabel(normalLabel)) {
        result.longTermLiabilities = preferSectionValue(
          summary,
          sectionRows
        );

        addSection(
          result,
          label,
          result.longTermLiabilities,
          sectionRows
        );
      }

      // Total liabilities
      if (
        /^total liabilities$/i.test(normalLabel) ||
        /^liabilities total$/i.test(normalLabel)
      ) {
        result.totalLiabilities = summary;
      }

      // Equity
      if (
        /^equity$/i.test(normalLabel) ||
        /^total equity$/i.test(normalLabel) ||
        /shareholders.? equity/i.test(normalLabel) ||
        /stockholders.? equity/i.test(normalLabel) ||
        /capital and reserves/i.test(normalLabel)
      ) {
        result.equity = preferSectionValue(
          summary,
          sectionRows
        );
      }

      if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  const allAccounts = extractAllDataRows(
    raw.Rows?.Row || []
  );

  // Account-level fallbacks

  if (!result.cash) {
    result.cash = sumMatchingAccounts(
      allAccounts,
      /cash|bank|current account|deposit/i
    );
  }

  if (!result.accountsReceivable) {
    result.accountsReceivable = sumMatchingAccounts(
      allAccounts,
      /accounts receivable|trade debtors|debtors|a\/r/i
    );
  }

  if (!result.accountsPayable) {
    result.accountsPayable = sumMatchingAccounts(
      allAccounts,
      /accounts payable|trade creditors|creditors|a\/p/i
    );
  }

  if (!result.fixedAssets) {
    result.fixedAssets = sumMatchingAccounts(
      allAccounts,
      /fixed asset|plant|machinery|equipment|vehicle|motor vehicle|fixture|fitting|property|building|land/i
    );
  }

  if (!result.currentLiabilities) {
    result.currentLiabilities = sumMatchingAccounts(
      allAccounts,
      /accounts payable|trade creditors|creditors|a\/p|vat|sales tax|paye|payroll tax|national insurance|accrual|accrued|credit card|short.?term loan|current portion/i
    );
  }

  if (!result.longTermLiabilities) {
    result.longTermLiabilities = sumMatchingAccounts(
      allAccounts,
      /long.?term loan|long.?term debt|non.?current liabilit|finance lease|hire purchase|mortgage|debenture/i
    );
  }

  /*
   * Current Assets already includes Cash and Accounts Receivable.
   *
   * Cash and Accounts Receivable must not be added separately
   * to Total Assets or they will be counted twice.
   */
  if (!result.currentAssets) {
    result.currentAssets =
      result.cash +
      result.accountsReceivable +
      sumMatchingAccounts(
        allAccounts,
        /inventory|stock|prepayment|prepaid|other current asset/i
      );
  }

  /*
   * Total Assets = Fixed Assets + Current Assets
   */
  if (!result.totalAssets) {
    result.totalAssets =
      result.fixedAssets +
      result.currentAssets;
  }

  /*
   * Accounts Payable is already included inside Current Liabilities.
   * It must not be added separately to Total Liabilities.
   */
  if (!result.currentLiabilities && result.accountsPayable) {
    result.currentLiabilities =
      result.accountsPayable;
  }

  /*
   * Total Liabilities =
   * Current Liabilities + Long-Term Liabilities
   */
  if (!result.totalLiabilities) {
    result.totalLiabilities =
      result.currentLiabilities +
      result.longTermLiabilities;
  }

  /*
   * Derive a missing category from the official total,
   * where QuickBooks provides enough information.
   */
  if (
    result.totalLiabilities &&
    !result.currentLiabilities &&
    result.longTermLiabilities
  ) {
    result.currentLiabilities =
      result.totalLiabilities -
      result.longTermLiabilities;
  }

  if (
    result.totalLiabilities &&
    !result.longTermLiabilities &&
    result.currentLiabilities
  ) {
    const difference =
      result.totalLiabilities -
      result.currentLiabilities;

    if (Math.abs(difference) > 0.005) {
      result.longTermLiabilities = difference;
    }
  }

  /*
   * Net Assets = Total Assets - Total Liabilities
   */
  result.netAssets =
    result.totalAssets -
    result.totalLiabilities;

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

  function walk(rows = []) {
    for (const row of rows) {
      const header =
        getRowHeader(row) ||
        getSummaryLabel(row);

      const summary = findSummaryValue(row);

      if (/operating/i.test(header)) {
        result.operating = summary;
      } else if (/investing/i.test(header)) {
        result.investing = summary;
      } else if (/financing/i.test(header)) {
        result.financing = summary;
      } else if (
        /net (change|increase|decrease)/i.test(header)
      ) {
        result.netChange = summary;
      } else if (
        /opening|beginning/i.test(header)
      ) {
        result.openingBalance = summary;
      } else if (
        /closing|ending/i.test(header)
      ) {
        result.closingBalance = summary;
      }

      if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  return result;
}

// ── Balance-sheet label helpers ────────────────────────────────────────────

function isCurrentAssetsLabel(label) {
  return (
    /^current assets?$/i.test(label) ||
    /^total current assets?$/i.test(label)
  );
}

function isFixedAssetsLabel(label) {
  return (
    /fixed assets?/i.test(label) ||
    /property.*plant.*equipment/i.test(label) ||
    /property and equipment/i.test(label) ||
    /non.?current assets?/i.test(label) ||
    /tangible assets?/i.test(label) ||
    /capital assets?/i.test(label)
  );
}

function isCashLabel(label) {
  return (
    /cash and cash equivalents/i.test(label) ||
    /^cash$/i.test(label) ||
    /^bank$/i.test(label) ||
    /bank accounts?/i.test(label)
  );
}

function isReceivablesLabel(label) {
  return (
    /accounts receivable/i.test(label) ||
    /trade debtors/i.test(label) ||
    /^debtors$/i.test(label) ||
    /^a\/r$/i.test(label)
  );
}

function isPayablesLabel(label) {
  return (
    /accounts payable/i.test(label) ||
    /trade creditors/i.test(label) ||
    /^creditors$/i.test(label) ||
    /^a\/p$/i.test(label)
  );
}

function isCurrentLiabilitiesLabel(label) {
  return (
    /^current liabilities$/i.test(label) ||
    /^total current liabilities$/i.test(label) ||
    /^other current liabilities$/i.test(label) ||
    /creditors.*within one year/i.test(label) ||
    /amounts falling due within one year/i.test(label) ||
    /short.?term liabilities/i.test(label)
  );
}

function isLongTermLiabilitiesLabel(label) {
  return (
    /long.?term liabilities/i.test(label) ||
    /long.?term debt/i.test(label) ||
    /non.?current liabilities/i.test(label) ||
    /creditors.*after more than one year/i.test(label) ||
    /amounts falling due after more than one year/i.test(label)
  );
}

// ── General report helpers ─────────────────────────────────────────────────

function getRowHeader(row) {
  return String(
    row?.Header?.ColData?.[0]?.value || ''
  ).trim();
}

function getSummaryLabel(row) {
  return String(
    row?.Summary?.ColData?.[0]?.value || ''
  ).trim();
}

function getColumnLabel(cols = []) {
  return String(
    cols?.[0]?.value || ''
  ).trim();
}

function getColumnAmount(cols = []) {
  /*
   * QuickBooks can return more than two columns.
   * The final populated numeric column is normally the total.
   */
  for (
    let index = cols.length - 1;
    index >= 1;
    index -= 1
  ) {
    const value = cols[index]?.value;

    if (
      value !== null &&
      value !== undefined &&
      value !== '' &&
      Number.isFinite(Number.parseFloat(
        String(value).replace(/[£$€,\s()]/g, '')
      ))
    ) {
      return toNum(value);
    }
  }

  return 0;
}

function findSummaryValue(row) {
  if (row?.Summary?.ColData) {
    return getColumnAmount(
      row.Summary.ColData
    );
  }

  if (row?.ColData) {
    return getColumnAmount(
      row.ColData
    );
  }

  return 0;
}

function preferSectionValue(summary, rows = []) {
  /*
   * Prefer the official QuickBooks section summary.
   * A valid total may be negative, so do not test summary > 0.
   */
  if (
    Number.isFinite(summary) &&
    Math.abs(summary) > 0.000001
  ) {
    return summary;
  }

  return rows.reduce(
    (sum, row) =>
      sum + toNum(row.amount),
    0
  );
}

function extractRows(section) {
  const rows = [];

  function walk(childRows = []) {
    for (const row of childRows) {
      if (
        row.type === 'Data' &&
        row.ColData
      ) {
        const name = getColumnLabel(
          row.ColData
        );

        const amount = getColumnAmount(
          row.ColData
        );

        if (name) {
          rows.push({
            name,
            amount,
          });
        }
      }

      if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(section?.Rows?.Row || []);

  return rows;
}

function extractAllDataRows(rows = []) {
  const accounts = [];

  for (const row of rows) {
    if (
      row.type === 'Data' &&
      row.ColData
    ) {
      const name = getColumnLabel(
        row.ColData
      );

      const amount = getColumnAmount(
        row.ColData
      );

      if (name) {
        accounts.push({
          name,
          amount,
        });
      }
    }

    if (row.Rows?.Row) {
      accounts.push(
        ...extractAllDataRows(
          row.Rows.Row
        )
      );
    }
  }

  return accounts;
}

function sumMatchingAccounts(rows = [], pattern) {
  return rows
    .filter(row =>
      pattern.test(
        String(row.name || '')
      )
    )
    .reduce(
      (sum, row) =>
        sum + toNum(row.amount),
      0
    );
}

function addSection(
  result,
  name,
  amount,
  rows
) {
  const alreadyAdded =
    result.sections.some(
      section =>
        section.name === name &&
        section.amount === amount
    );

  if (!alreadyAdded) {
    result.sections.push({
      name,
      amount,
      rows,
    });
  }
}

function normaliseLabel(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNum(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return 0;
  }

  const text = String(value)
    .trim()
    .replace(/[£$€,]/g, '');

  const isBracketNegative =
    /^\(.*\)$/.test(text);

  const cleaned =
    text.replace(/[()]/g, '');

  const number =
    Number.parseFloat(cleaned);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return isBracketNegative
    ? -Math.abs(number)
    : number;
}

function round(number, decimalPlaces) {
  return (
    Math.round(
      number * 10 ** decimalPlaces
    ) /
    10 ** decimalPlaces
  );
}
