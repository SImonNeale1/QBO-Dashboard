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
    asOf:
      raw.Header?.EndPeriod ||
      raw.Header?.ReportBasis ||
      null,

    currentAssets: 0,
    fixedAssets: 0,
    depreciation: 0,
    totalAssets: 0,

    currentLiabilities: 0,
    longTermLiabilities: 0,
    totalLiabilities: 0,

    equity: 0,
    netAssets: 0,

    cash: 0,
    accountsReceivable: 0,
    accountsPayable: 0,

    sections: [],
  };

  /*
   * QuickBooks normally nests:
   *
   * Assets
   *   Current Assets
   *   Fixed Assets
   *
   * Liabilities and Equity
   *   Current Liabilities
   *   Long Term Liabilities
   *   Equity
   *
   * Therefore every section must be inspected recursively.
   */
  function walk(rows = [], parents = []) {
    for (const row of rows) {
      const header = getRowHeader(row);
      const summaryLabel = getSummaryLabel(row);
      const label = header || summaryLabel;

      const summary = findSummaryValue(row);
      const sectionRows = extractRows(row);

      const hierarchy = [...parents, label]
        .filter(Boolean)
        .join(' > ');

      if (label) {
        classifyBalanceSheetSection({
          row,
          label,
          hierarchy,
          summary,
          sectionRows,
          result,
        });
      }

      if (row.Rows?.Row) {
        walk(
          row.Rows.Row,
          label ? [...parents, label] : parents
        );
      }
    }
  }

  walk(raw.Rows?.Row || []);

  /*
   * Account-level fallback.
   *
   * This handles unusual QuickBooks layouts where recognised accounts
   * exist but the expected section headings are absent.
   */
  const allAccounts = extractAllDataRows(raw.Rows?.Row || []);

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

  /*
   * Use recognised account groups only as a final fallback.
   * Section totals remain preferable because they reconcile to QBO.
   */
  if (!result.currentLiabilities) {
    result.currentLiabilities = sumMatchingAccounts(
      allAccounts,
      /accounts payable|trade creditors|creditors|a\/p|vat|sales tax|payroll tax|paye|national insurance|accrual|accrued|short.?term loan|credit card|current portion|director loan/i
    );
  }

  if (!result.longTermLiabilities) {
    result.longTermLiabilities = sumMatchingAccounts(
      allAccounts,
      /long.?term loan|long.?term debt|non.?current liabilit|finance lease|hire purchase|mortgage|debenture|loan payable after|director loan long/i
    );
  }

  if (!result.totalAssets) {
    result.totalAssets =
      result.currentAssets +
      result.fixedAssets;
  }

  if (!result.totalLiabilities) {
    result.totalLiabilities =
      result.currentLiabilities +
      result.longTermLiabilities;
  }

  /*
   * If QBO supplied total liabilities but one category is missing,
   * derive the missing category from the total.
   */
  if (
    !result.currentLiabilities &&
    result.totalLiabilities &&
    result.longTermLiabilities
  ) {
    result.currentLiabilities =
      result.totalLiabilities -
      result.longTermLiabilities;
  }

  if (
    !result.longTermLiabilities &&
    result.totalLiabilities &&
    result.currentLiabilities
  ) {
    const difference =
      result.totalLiabilities -
      result.currentLiabilities;

    if (Math.abs(difference) > 0.005) {
      result.longTermLiabilities = difference;
    }
  }

  result.netAssets =
    result.totalAssets -
    result.totalLiabilities;

  return result;
}

function classifyBalanceSheetSection({
  label,
  hierarchy,
  summary,
  sectionRows,
  result,
}) {
  const normalLabel = normaliseLabel(label);
  const normalHierarchy = normaliseLabel(hierarchy);

  // ── Current assets ───────────────────────────────────────────────────────

  if (
    isCurrentAssetsLabel(normalLabel)
  ) {
    result.currentAssets = preferSectionValue(
      summary,
      sectionRows
    );

    const cashFromRows = sumMatchingAccounts(
      sectionRows,
      /cash|bank|current account|deposit/i
    );

    if (cashFromRows !== 0) {
      result.cash = cashFromRows;
    }

    const receivablesFromRows = sumMatchingAccounts(
      sectionRows,
      /accounts receivable|trade debtors|debtors|a\/r/i
    );

    if (receivablesFromRows !== 0) {
      result.accountsReceivable =
        receivablesFromRows;
    }

    addSection(
      result,
      label,
      result.currentAssets,
      sectionRows
    );

    return;
  }

  // ── Cash and bank ────────────────────────────────────────────────────────

  if (
    /cash|bank accounts?|cash and cash equivalents/i.test(
      normalLabel
    )
  ) {
    const value = preferSectionValue(
      summary,
      sectionRows
    );

    if (value !== 0) {
      result.cash = value;
    }
  }

  // ── Accounts receivable ──────────────────────────────────────────────────

  if (
    /accounts receivable|trade debtors|debtors|a\/r/i.test(
      normalLabel
    )
  ) {
    const value = preferSectionValue(
      summary,
      sectionRows
    );

    if (value !== 0) {
      result.accountsReceivable = value;
    }
  }

  // ── Fixed/non-current assets ─────────────────────────────────────────────

  if (
    isFixedAssetsLabel(normalLabel)
  ) {
    const fixedAssetValue = preferSectionValue(
      summary,
      sectionRows
    );

    result.fixedAssets = fixedAssetValue;

    const depreciationFromRows = sumMatchingAccounts(
      sectionRows,
      /accumulated depreciation|depreciation/i
    );

    if (depreciationFromRows !== 0) {
      result.depreciation =
        depreciationFromRows;
    }

    addSection(
      result,
      label,
      result.fixedAssets,
      sectionRows
    );

    return;
  }

  if (
    /accumulated depreciation|depreciation/i.test(
      normalLabel
    )
  ) {
    const value = preferSectionValue(
      summary,
      sectionRows
    );

    if (value !== 0) {
      result.depreciation = value;
    }
  }

  // ── Total assets ─────────────────────────────────────────────────────────

  if (
    /^total assets?$/i.test(normalLabel)
  ) {
    result.totalAssets = summary;
    return;
  }

  // ── Current liabilities ──────────────────────────────────────────────────

  if (
    isCurrentLiabilitiesLabel(normalLabel)
  ) {
    /*
     * The old parser discarded the QuickBooks summary and only used
     * selected account names. This caused zero values when accounts had
     * different names.
     */
    result.currentLiabilities =
      preferSectionValue(summary, sectionRows);

    const payablesFromRows = sumMatchingAccounts(
      sectionRows,
      /accounts payable|trade creditors|creditors|a\/p/i
    );

    if (payablesFromRows !== 0) {
      result.accountsPayable =
        payablesFromRows;
    }

    addSection(
      result,
      label,
      result.currentLiabilities,
      sectionRows
    );

    return;
  }

  // ── Accounts payable ─────────────────────────────────────────────────────

  if (
    /accounts payable|trade creditors|creditors|a\/p/i.test(
      normalLabel
    )
  ) {
    const value = preferSectionValue(
      summary,
      sectionRows
    );

    if (value !== 0) {
      result.accountsPayable = value;
    }
  }

  // ── Long-term/non-current liabilities ────────────────────────────────────

  if (
    isLongTermLiabilitiesLabel(normalLabel)
  ) {
    result.longTermLiabilities =
      preferSectionValue(summary, sectionRows);

    addSection(
      result,
      label,
      result.longTermLiabilities,
      sectionRows
    );

    return;
  }

  // ── Total liabilities ────────────────────────────────────────────────────

  if (
    /^total liabilities$/i.test(normalLabel) ||
    /^liabilities total$/i.test(normalLabel)
  ) {
    result.totalLiabilities = summary;
    return;
  }

  /*
   * Do not use "Total Liabilities and Equity" as total liabilities.
   * That value normally equals total assets.
   */
  if (
    /total liabilities and equity|total liabilities & equity/i.test(
      normalLabel
    )
  ) {
    return;
  }

  // ── Equity ───────────────────────────────────────────────────────────────

  if (
    /^equity$/i.test(normalLabel) ||
    /^total equity$/i.test(normalLabel) ||
    /shareholders.? equity|stockholders.? equity|capital and reserves/i.test(
      normalLabel
    )
  ) {
    result.equity = preferSectionValue(
      summary,
      sectionRows
    );

    addSection(
      result,
      label,
      result.equity,
      sectionRows
    );

    return;
  }

  /*
   * Some reports use broad parent headings, such as "Liabilities
   * and Equity". These parent totals must not overwrite the specific
   * liability categories.
   */
  if (
    /liabilities and equity|liabilities & equity/i.test(
      normalHierarchy
    )
  ) {
    const payablesFromRows = sumMatchingAccounts(
      sectionRows,
      /accounts payable|trade creditors|creditors|a\/p/i
    );

    if (
      !result.accountsPayable &&
      payablesFromRows !== 0
    ) {
      result.accountsPayable =
        payablesFromRows;
    }
  }
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
    /^total current assets?$/i.test(label) ||
    /other current assets/i.test(label)
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
  return String(cols?.[0]?.value || '').trim();
}

function getColumnAmount(cols = []) {
  /*
   * QuickBooks can return more than two columns.
   * The final populated numeric column is normally the total.
   */
  for (let index = cols.length - 1; index >= 1; index -= 1) {
    const value = cols[index]?.value;

    if (
      value !== null &&
      value !== undefined &&
      value !== '' &&
      Number.isFinite(Number.parseFloat(value))
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
   *
   * A valid summary may be negative, so do not test summary > 0.
   */
  if (
    Number.isFinite(summary) &&
    Math.abs(summary) > 0.000001
  ) {
    return summary;
  }

  return rows.reduce(
    (sum, row) => sum + toNum(row.amount),
    0
  );
}

function extractRows(section) {
  const rows = [];

  function walk(childRows = []) {
    for (const row of childRows) {
      if (row.type === 'Data' && row.ColData) {
        const name = getColumnLabel(row.ColData);
        const amount = getColumnAmount(row.ColData);

        if (name) {
          rows.push({
            name,
            amount,
          });
        }
      }

      /*
       * Some QBO rows marked as Section also carry meaningful
       * summaries. Include the nested data rows recursively.
       */
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
    if (row.type === 'Data' && row.ColData) {
      const name = getColumnLabel(row.ColData);
      const amount = getColumnAmount(row.ColData);

      if (name) {
        accounts.push({
          name,
          amount,
        });
      }
    }

    if (row.Rows?.Row) {
      accounts.push(
        ...extractAllDataRows(row.Rows.Row)
      );
    }
  }

  return accounts;
}

function sumMatchingAccounts(rows = [], pattern) {
  return rows
    .filter(row =>
      pattern.test(String(row.name || ''))
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

  /*
   * Handle values such as:
   * 12,345.67
   * £12,345.67
   * (12,345.67)
   */
  const text = String(value)
    .trim()
    .replace(/[£$€,]/g, '');

  const isBracketNegative =
    /^\(.*\)$/.test(text);

  const cleaned = text.replace(/[()]/g, '');
  const number = Number.parseFloat(cleaned);

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
