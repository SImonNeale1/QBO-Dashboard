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
        const columns = row.Summary.ColData;
        const label = columns[0]?.value || '';
        const value = getColumnAmount(columns);

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

      if (Array.isArray(row.Rows?.Row)) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  result.grossProfit =
    result.revenue -
    result.costOfSales;

  result.grossMarginPct =
    result.revenue !== 0
      ? round(
          (result.grossProfit / result.revenue) * 100,
          1
        )
      : 0;

  result.netMarginPct =
    result.revenue !== 0
      ? round(
          (result.netIncome / result.revenue) * 100,
          1
        )
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
    otherCurrentLiabilities: 0,
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
      const headerLabel = normaliseLabel(
        getRowHeader(row)
      );

      const summaryLabel = normaliseLabel(
        getSummaryLabel(row)
      );

      const dataLabel = normaliseLabel(
        row?.ColData?.[0]?.value
      );

      /*
       * Header must take priority.
       *
       * For grouped QuickBooks rows:
       * Header  = Current Assets
       * Summary = Total Current Assets
       */
      const label =
        headerLabel ||
        summaryLabel ||
        dataLabel;

      const summary = findSummaryValue(row);
      const sectionRows = extractRows(row);

      if (label) {
        // Fixed assets
        if (isFixedAssetsLabel(headerLabel || label)) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.fixedAssets = value;
          }

          const depreciation =
            sumMatchingAccounts(
              sectionRows,
              /accum(?:ulated)?\.?\s*dep|depreciation/i
            );

          if (depreciation !== 0) {
            result.depreciation = depreciation;
          }

          addSection(
            result,
            headerLabel || label,
            result.fixedAssets,
            sectionRows
          );
        }

        // Cash
        if (
          isCashLabel(headerLabel) ||
          isCashLabel(summaryLabel) ||
          isCashLabel(dataLabel)
        ) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.cash = value;
          }
        }

        // Accounts receivable
        if (
          isReceivablesLabel(headerLabel) ||
          isReceivablesLabel(summaryLabel) ||
          isReceivablesLabel(dataLabel)
        ) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.accountsReceivable = value;
          }
        }

        /*
         * Current Assets component
         *
         * Your QuickBooks report contains:
         *
         * Header  = Current Assets
         * Amount  = 253487.77
         */
        if (/^current assets?$/i.test(headerLabel)) {
          result.currentAssets =
            preferSectionValue(
              summary,
              sectionRows
            );

          addSection(
            result,
            headerLabel,
            result.currentAssets,
            sectionRows
          );
        } else if (
          /^other current assets?$/i.test(headerLabel) ||
          /^other current assets?$/i.test(summaryLabel) ||
          /^other current assets?$/i.test(dataLabel)
        ) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.currentAssets = value;
          }
        }

        // Explicit Total Current Assets row
        if (
          /^total current assets?$/i.test(
            summaryLabel
          ) &&
          !/^current assets?$/i.test(headerLabel)
        ) {
          const value = getColumnAmount(
            row.Summary?.ColData || []
          );

          if (value !== 0) {
            result.totalCurrentAssets = value;
          }
        }

        // Accounts payable
        if (
          isPayablesLabel(headerLabel) ||
          isPayablesLabel(summaryLabel) ||
          isPayablesLabel(dataLabel)
        ) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.accountsPayable = value;
          }
        }

        // Credit cards
        if (
          /credit cards?|credit card accounts?/i.test(
            label
          )
        ) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.creditCards = value;
          }
        }

        // Other current liabilities
        if (
          /^other current liabilities?$/i.test(
            label
          )
        ) {
          const value = preferSectionValue(
            summary,
            sectionRows
          );

          if (value !== 0) {
            result.otherCurrentLiabilities =
              value;
          }
        }

        // Current-liability grouped section
        if (
          /creditors.*within one year/i.test(
            headerLabel
          ) ||
          /amounts falling due within one year/i.test(
            headerLabel
          ) ||
          /^total current liabilities?$/i.test(
            label
          )
        ) {
          const sectionTotal =
            preferSectionValue(
              summary,
              sectionRows
            );

          if (sectionTotal !== 0) {
            result.totalCurrentLiabilities =
              sectionTotal;
          }

          addSection(
            result,
            headerLabel || label,
            sectionTotal,
            sectionRows
          );

          const payable = sumMatchingAccounts(
            sectionRows,
            /^creditors$|^trade creditors$|^accounts payable$/i
          );

          const creditCards =
            sumMatchingAccounts(
              sectionRows,
              /credit card/i
            );

          if (payable !== 0) {
            result.accountsPayable = payable;
          }

          if (creditCards !== 0) {
            result.creditCards = creditCards;
          }

          if (sectionTotal !== 0) {
            result.otherCurrentLiabilities =
              sectionTotal -
              result.accountsPayable -
              result.creditCards;
          }
        }

        if (
          /^net current assets?/i.test(label)
        ) {
          result.netCurrentAssets =
            preferSectionValue(
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
            preferSectionValue(
              summary,
              sectionRows
            );
        }

        if (
          /provisions? for liabilities|provision for tax|deferred tax/i.test(
            label
          )
        ) {
          result.provisionForLiabilities =
            preferSectionValue(
              summary,
              sectionRows
            );
        }

        if (isLongTermLiabilitiesLabel(label)) {
          result.longTermLiabilities =
            preferSectionValue(
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

        if (
          /^equity$|^total equity$/i.test(label) ||
          /shareholders.? equity|stockholders.? equity|capital and reserves/i.test(
            label
          )
        ) {
          result.equity =
            preferSectionValue(
              summary,
              sectionRows
            );
        }

        if (/^net assets?$/i.test(label)) {
          result.netAssets = summary;
        }
      }

      if (Array.isArray(row.Rows?.Row)) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  /*
   * This is the critical recovery.
   *
   * The parser output previously contained a Current Assets section
   * with amount 253487.77 even though result.currentAssets was zero.
   */
  const currentAssetsSection =
    result.sections.find(
      (section) =>
        /^current assets?$/i.test(
          normaliseLabel(section.name)
        )
    );

  if (currentAssetsSection) {
    const sectionAmount =
      toNum(currentAssetsSection.amount);

    if (sectionAmount !== 0) {
      result.currentAssets = sectionAmount;
    } else {
      result.currentAssets =
        currentAssetsSection.rows.reduce(
          (total, account) =>
            total + toNum(account.amount),
          0
        );
    }
  }

  const allAccounts = extractAllDataRows(
    raw.Rows?.Row || []
  );

  // Cash fallback — only exact cash/bank control rows.
  if (!result.cash) {
    result.cash = sumMatchingAccounts(
      allAccounts,
      /^cash at bank and in hand$|^cash and cash equivalents$|^cash at bank$|^bank accounts?$|^total bank accounts?$/i
    );
  }

  // Receivables fallback
  if (!result.accountsReceivable) {
    result.accountsReceivable =
      sumMatchingAccounts(
        allAccounts,
        /^accounts receivable$|^trade debtors$|^debtors$|^a\/r$/i
      );
  }

  // Payables fallback
  if (!result.accountsPayable) {
    result.accountsPayable =
      sumMatchingAccounts(
        allAccounts,
        /^accounts payable$|^trade creditors$|^creditors$|^a\/p$/i
      );
  }

  // Credit-card fallback
  if (!result.creditCards) {
    result.creditCards =
      sumMatchingAccounts(
        allAccounts,
        /credit card/i
      );
  }

  // Fixed-assets fallback
  if (!result.fixedAssets) {
    result.fixedAssets =
      sumMatchingAccounts(
        allAccounts,
        /fixed asset|plant|machinery|equipment|vehicle|fixture|fitting|property|building|website|computer/i
      );
  }

  /*
   * Last-resort Current Assets calculation.
   *
   * These are the exact accounts shown in your Current Assets section.
   */
  if (!result.currentAssets) {
    result.currentAssets =
      sumMatchingAccounts(
        allAccounts,
        /^bad debt provision$|^employee loan$|^intercompany loan.*$|^paypal$|^prepayments?$|^stock asset$|^stock provision$|^sundry debtors$/i
      );
  }

  if (!result.otherCurrentLiabilities) {
    result.otherCurrentLiabilities =
      sumMatchingAccounts(
        allAccounts,
        /vat|sales tax|paye|payroll tax|national insurance|accrual|accrued|corporation tax|director.*loan|other current liabilit/i
      );
  }

  if (!result.provisionForLiabilities) {
    result.provisionForLiabilities =
      sumMatchingAccounts(
        allAccounts,
        /provisions? for liabilities|provision for tax|deferred tax/i
      );
  }

  /*
   * Always recalculate the dashboard totals from the components.
   */

  result.totalCurrentAssets =
    result.cash +
    result.accountsReceivable +
    result.currentAssets;

  result.currentLiabilities =
    result.creditCards +
    result.otherCurrentLiabilities;

  result.totalCurrentLiabilities =
    result.accountsPayable +
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
        /net (change|increase|decrease)/i.test(
          header
        )
      ) {
        result.netChange = summary;
      } else if (/opening|beginning/i.test(header)) {
        result.openingBalance = summary;
      } else if (/closing|ending/i.test(header)) {
        result.closingBalance = summary;
      }

      if (Array.isArray(row.Rows?.Row)) {
        walk(row.Rows.Row);
      }
    }
  }

  walk(raw.Rows?.Row || []);

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isFixedAssetsLabel(label) {
  return (
    /^fixed assets?$/i.test(label) ||
    /^fixed asset$/i.test(label) ||
    /^non.?current assets?$/i.test(label) ||
    /property.*plant.*equipment/i.test(label) ||
    /property and equipment/i.test(label) ||
    /tangible assets?/i.test(label) ||
    /capital assets?/i.test(label)
  );
}

function isCashLabel(label) {
  return (
    /^cash at bank and in hand$/i.test(label) ||
    /^cash and cash equivalents$/i.test(label) ||
    /^cash at bank$/i.test(label) ||
    /^cash$/i.test(label) ||
    /^bank accounts?$/i.test(label) ||
    /^total bank accounts?$/i.test(label)
  );
}

function isReceivablesLabel(label) {
  return (
    /^accounts receivable$/i.test(label) ||
    /^total accounts receivable$/i.test(label) ||
    /^trade debtors$/i.test(label) ||
    /^trade receivables$/i.test(label) ||
    /^debtors$/i.test(label) ||
    /^a\/r$/i.test(label)
  );
}

function isPayablesLabel(label) {
  return (
    /^accounts payable$/i.test(label) ||
    /^total accounts payable$/i.test(label) ||
    /^trade creditors$/i.test(label) ||
    /^trade payables$/i.test(label) ||
    /^creditors$/i.test(label) ||
    /^a\/p$/i.test(label)
  );
}

function isLongTermLiabilitiesLabel(label) {
  return (
    /long.?term liabilities/i.test(label) ||
    /long.?term debt/i.test(label) ||
    /non.?current liabilities/i.test(label) ||
    /creditors.*after more than one year/i.test(
      label
    ) ||
    /amounts falling due after more than one year/i.test(
      label
    )
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

function getColumnAmount(columns = []) {
  for (
    let index = columns.length - 1;
    index >= 1;
    index -= 1
  ) {
    const value = columns[index]?.value;

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

function preferSectionValue(
  summary,
  rows = []
) {
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
        row.ColData &&
        (
          row.type === 'Data' ||
          !row.type
        )
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

      if (Array.isArray(row.Rows?.Row)) {
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
      row.ColData &&
      (
        row.type === 'Data' ||
        !row.type
      )
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

    if (Array.isArray(row.Rows?.Row)) {
      accounts.push(
        ...extractAllDataRows(
          row.Rows.Row
        )
      );
    }
  }

  return accounts;
}

function sumMatchingAccounts(
  rows = [],
  pattern
) {
  return rows.reduce(
    (total, row) => {
      pattern.lastIndex = 0;

      const matches = pattern.test(
        normaliseLabel(row.name)
      );

      return matches
        ? total + toNum(row.amount)
        : total;
    },
    0
  );
}

function addSection(
  result,
  name,
  amount,
  rows
) {
  const cleanName = normaliseLabel(name);

  const exists = result.sections.some(
    (section) =>
      normaliseLabel(section.name) === cleanName &&
      toNum(section.amount) === toNum(amount)
  );

  if (!exists) {
    result.sections.push({
      name: cleanName,
      amount: toNum(amount),
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
    .replace(/[£$€,\s]/g, '');

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

function round(
  number,
  decimalPlaces
) {
  return (
    Math.round(
      number *
        10 ** decimalPlaces
    ) /
    10 ** decimalPlaces
  );
}
