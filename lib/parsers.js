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
