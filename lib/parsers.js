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
        const label = cols[0]?.value || '';
        const value = getColumnAmount(cols);

        if (/^total income$/i.test(label)) result.revenue = value;
        if (/total.*cost.*(goods|sales|revenue)/i.test(label)) {
          result.costOfSales = value;
        }
        if (/^total expenses$/i.test(label)) result.expenses = value;
        if (/^net income$/i.test(label)) result.netIncome = value;
      }

      if (row.Header?.ColData?.[0]?.value) {
        const header = row.Header.ColData[0].value;
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

      if (row.Rows?.Row) walk(row.Rows.Row);
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
    totalCurrentAssets: 0,
    totalAssets: 0,

    accountsPayable: 0,
    creditCards: 0,
    currentLiabilities: 0,
    totalCurrentLiabilities: 0,

    netCurrentAssets: 0,
    totalAssetsLessCurrentLiabilities: 0,

    provisionForLiabilities: 0,
    longTermLiabilities: 0,
    totalLiabilities: 0,

    equity: 0,
    netAssets: 0,
    depreciation: 0,
    sections: [],
  };

  function walk(rows = []) {
    for (const row of rows) {
      const label = normaliseLabel(
        getRowHeader(row) ||
          getSummaryLabel(row) ||
          row?.ColData?.[0]?.value
      );

      const summary = findSummaryValue(row);
      const sectionRows = extractRows(row);

      if (label) {
        if (isFixedAssetsLabel(label)) {
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

        if (
          /cash and cash equivalents|cash at bank and in hand|^cash$|^bank$|bank accounts?/i.test(
            label
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

        if (
          /accounts receivable|trade debtors|^debtors$|^a\/r$/i.test(
            label
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

        if (/^other current assets?$/i.test(label)) {
          result.currentAssets = preferSectionValue(
            summary,
            sectionRows
          );
        }

        if (
          /^current assets?$/i.test(label) ||
          /^total current assets?$/i.test(label)
        ) {
          result.totalCurrentAssets = preferSectionValue(
            summary,
            sectionRows
          );

          addSection(
            result,
            label,
            result.totalCurrentAssets,
            sectionRows
          );
        }

        if (
          /accounts payable|trade creditors|^creditors$|^a\/p$/i.test(
            label
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

        if (/credit cards?|credit card accounts?/i.test(label)) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.creditCards = value;
          }
        }

        if (/^other current liabilities?$/i.test(label)) {
          result.currentLiabilities = preferSectionValue(
            summary,
            sectionRows
          );
        }

        if (
          /^current liabilities?$/i.test(label) ||
          /^total current liabilities?$/i.test(label) ||
          /creditors.*within one year/i.test(label) ||
          /amounts falling due within one year/i.test(label)
        ) {
          result.totalCurrentLiabilities =
            preferSectionValue(summary, sectionRows);

          addSection(
            result,
            label,
            result.totalCurrentLiabilities,
            sectionRows
          );
        }

        if (
          /^net current assets? \(liabilities\)$/i.test(
            label
          ) ||
          /^net current assets?\/?\(liabilities\)$/i.test(
            label
          ) ||
          /^net current assets? liabilities$/i.test(label) ||
          /^net current assets?$/i.test(label)
        ) {
          result.netCurrentAssets = preferSectionValue(
            summary,
            sectionRows
          );
        }

        if (
          /^total assets less current liabilities$/i.test(
            label
          )
        ) {
          result.totalAssetsLessCurrentLiabilities =
            preferSectionValue(summary, sectionRows);
        }

        if (
          /provision for liabilities|provisions for liabilities|provision for tax|deferred tax/i.test(
            label
          )
        ) {
          result.provisionForLiabilities =
            preferSectionValue(summary, sectionRows);
        }

        if (isLongTermLiabilitiesLabel(label)) {
          result.longTermLiabilities =
            preferSectionValue(summary, sectionRows);

          addSection(
            result,
            label,
            result.longTermLiabilities,
            sectionRows
          );
        }

        if (
          /^total liabilities$|^liabilities total$/i.test(
            label
          )
        ) {
          result.totalLiabilities = summary;
        }

        if (
          /^equity$|^total equity$/i.test(label) ||
          /shareholders.? equity|stockholders.? equity|capital and reserves/i.test(
            label
          )
        ) {
          result.equity = preferSectionValue(
            summary,
            sectionRows
          );
        }

        if (/^net assets?$/i.test(label)) {
          result.netAssets = summary;
        }
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

  if (!result.cash) {
    result.cash = sumMatchingAccounts(
      allAccounts,
      /cash at bank and in hand|cash|bank|current account|deposit/i
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

  if (!result.creditCards) {
    result.creditCards = sumMatchingAccounts(
      allAccounts,
      /credit cards?|credit card accounts?/i
    );
  }

  if (!result.fixedAssets) {
    result.fixedAssets = sumMatchingAccounts(
      allAccounts,
      /fixed asset|plant|machinery|equipment|vehicle|motor vehicle|fixture|fitting|property|building|land/i
    );
  }

  if (!result.currentAssets) {
    result.currentAssets = sumMatchingAccounts(
      allAccounts,
      /inventory|stock|prepayment|prepaid|other current asset/i
    );
  }

  if (!result.currentLiabilities) {
    result.currentLiabilities = sumMatchingAccounts(
      allAccounts,
      /vat|sales tax|paye|payroll tax|national insurance|accrual|accrued|other current liabilit/i
    );
  }

  if (!result.provisionForLiabilities) {
    result.provisionForLiabilities =
      sumMatchingAccounts(
        allAccounts,
        /provision for liabilities|provisions for liabilities|provision for tax|deferred tax/i
      );
  }

  if (!result.totalCurrentAssets) {
    result.totalCurrentAssets =
      result.cash +
      result.accountsReceivable +
      result.currentAssets;
  }

  result.totalCurrentLiabilities =
    result.accountsPayable +
    result.creditCards +
    result.currentLiabilities;

  result.netCurrentAssets =
    result.totalCurrentAssets -
    result.totalCurrentLiabilities;

  result.totalAssets =
    result.fixedAssets +
    result.totalCurrentAssets;

  result.totalAssetsLessCurrentLiabilities =
    result.totalAssets -
    result.totalCurrentLiabilities;

  if (!result.longTermLiabilities) {
    result.longTermLiabilities =
      result.provisionForLiabilities;
  }

  result.totalLiabilities =
    result.totalCurrentLiabilities +
    result.longTermLiabilities;

  result.netAssets =
    result.totalAssetsLessCurrentLiabilities -
    result.longTermLiabilities;

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
      } else if (/net (change|increase|decrease)/i.test(header)) {
        result.netChange = summary;
      } else if (/opening|beginning/i.test(header)) {
        result.openingBalance = summary;
      } else if (/closing|ending/i.test(header)) {
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

// ── Helpers ───────────────────────────────────────────────────────────────

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

function getColumnAmount(cols = []) {
  for (
    let index = cols.length - 1;
    index >= 1;
    index -= 1
  ) {
    const value = cols[index]?.value;

    if (
      value !== null &&
      value !== undefined &&
      value !== ''
    ) {
      const number = toNum(value);

      if (Number.isFinite(number)) {
        return number;
      }
    }
  }

  return 0;
}

function findSummaryValue(row) {
  if (row?.Summary?.ColData) {
    return getColumnAmount(row.Summary.ColData);
  }

  if (row?.ColData) {
    return getColumnAmount(row.ColData);
  }

  return 0;
}

function preferSectionValue(summary, rows = []) {
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
      if (
        row.type === 'Data' &&
        row.ColData
      ) {
        const name = String(
          row.ColData?.[0]?.value || ''
        ).trim();

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
      const name = String(
        row.ColData?.[0]?.value || ''
      ).trim();

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
    .filter((row) =>
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

function addSection(result, name, amount, rows) {
  const exists = result.sections.some(
    (section) =>
      section.name === name &&
      section.amount === amount
  );

  if (!exists) {
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

  const bracketNegative =
    /^\(.*\)$/.test(text);

  const cleaned = text.replace(
    /[()]/g,
    ''
  );

  const number =
    Number.parseFloat(cleaned);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return bracketNegative
    ? -Math.abs(number)
    : number;
}

function round(number, decimalPlaces) {
  return (
    Math.round(
      number *
        10 ** decimalPlaces
    ) /
    10 ** decimalPlaces
  );
}
