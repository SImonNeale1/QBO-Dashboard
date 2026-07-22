import { Router } from 'express';
import { qboReport, qboQuery } from '../lib/qbo.js';
import {
  parsePL,
  parseBalanceSheet,
  parseCashFlow
} from '../lib/parsers.js';

export const apiRouter = Router();

function ensureQBO(req, res) {
  if (!req.qbo) {
    res.status(401).json({
      error: 'QuickBooks not connected',
      details: 'req.qbo is undefined'
    });

    return false;
  }

  return true;
}

/**
 * Profit & Loss
 */
apiRouter.get('/pl', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual'
    });

    res.json(parsePL(raw));
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Balance Sheet
 *
 * Normal:
 *   /api/balance-sheet
 *
 * Raw QuickBooks JSON:
 *   /api/balance-sheet?raw=1
 */
apiRouter.get('/balance-sheet', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'BalanceSheet', {
      date: req.query.date || today(),
      accounting_method: 'Accrual'
    });

    if (req.query.raw === '1') {
      return res.json(raw);
    }

    return res.json(parseBalanceSheet(raw));
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Cash Flow
 */
apiRouter.get('/cash-flow', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'CashFlow', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today()
    });

    res.json(parseCashFlow(raw));
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Outstanding Invoices
 */
apiRouter.get('/invoices/outstanding', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const data = await qboQuery(
      req.qbo,
      `SELECT Id, DocNumber, CustomerRef, Balance, DueDate, TotalAmt
       FROM Invoice
       MAXRESULTS 1000`
    );

    const invoices = (data.QueryResponse?.Invoice || [])
      .map(invoice => ({
        id: invoice.Id,
        number: invoice.DocNumber,
        customer: invoice.CustomerRef?.name || 'Unknown',
        balance: safeNum(invoice.Balance),
        total: safeNum(invoice.TotalAmt),
        dueDate: invoice.DueDate,
        daysOverdue: daysOverdue(invoice.DueDate)
      }))
      .filter(invoice => invoice.balance > 0);

    const overdueInvoices = invoices
      .filter(invoice => invoice.daysOverdue > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({
      invoices: overdueInvoices,

      totalOutstanding: invoices.reduce(
        (sum, invoice) => sum + invoice.balance,
        0
      ),

      count: invoices.length,
      overdueCount: overdueInvoices.length,

      overdueTotal: overdueInvoices.reduce(
        (sum, invoice) => sum + invoice.balance,
        0
      )
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Top Customers YTD — Total Sales Revenue
 */
apiRouter.get('/customers/top', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const startDate =
      req.query.start || currentYearStart();

    const endDate =
      req.query.end || today();

    /*
     * CustomerSales returns sales revenue by customer,
     * rather than profit/net income after customer costs.
     */
    const raw = await qboReport(
      req.qbo,
      'CustomerSales',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual',
        summarize_column_by: 'Total'
      }
    );

    const customerTotals = new Map();

    function addCustomer(name, revenue) {
      const cleanName = String(name || '').trim();
      const amount = safeNum(revenue);

      if (!cleanName) return;
      if (amount <= 0) return;
      if (isReportTotalRow(cleanName)) return;

      const existing =
        customerTotals.get(cleanName) || 0;

      customerTotals.set(
        cleanName,
        existing + amount
      );
    }

    function getCustomerNameFromHeader(row) {
      const headerColumns =
        row.Header?.ColData || [];

      for (const column of headerColumns) {
        const value =
          String(column?.value || '').trim();

        if (
          value &&
          !isNumericValue(value) &&
          !isReportTotalRow(value)
        ) {
          return value;
        }
      }

      return '';
    }

    function getTotalFromSummary(row) {
      const summaryColumns =
        row.Summary?.ColData || [];

      for (
        let index = summaryColumns.length - 1;
        index >= 0;
        index -= 1
      ) {
        const value =
          summaryColumns[index]?.value;

        if (isNumericValue(value)) {
          return safeNum(value);
        }
      }

      return 0;
    }

    function walkReportRows(rows = []) {
      for (const row of rows) {
        /*
         * QuickBooks may return each customer as a grouped
         * section where:
         *
         * Header  = customer name
         * Summary = total customer sales
         */
        const groupedCustomerName =
          getCustomerNameFromHeader(row);

        const groupedCustomerTotal =
          getTotalFromSummary(row);

        if (
          groupedCustomerName &&
          groupedCustomerTotal > 0
        ) {
          addCustomer(
            groupedCustomerName,
            groupedCustomerTotal
          );

          /*
           * The summary already contains the customer's total.
           * Do not also include its child rows.
           */
          continue;
        }

        /*
         * Fallback for reports returned as flat Data rows.
         */
        const columns =
          Array.isArray(row.ColData)
            ? row.ColData
            : [];

        const isDataRow =
          row.type === 'Data' ||
          (!row.type && columns.length > 0);

        if (isDataRow && columns.length >= 2) {
          const customerName =
            String(columns[0]?.value || '').trim();

          const revenue =
            getLastNumericColumn(columns);

          addCustomer(
            customerName,
            revenue
          );
        }

        if (Array.isArray(row.Rows?.Row)) {
          walkReportRows(row.Rows.Row);
        }
      }
    }

    walkReportRows(raw.Rows?.Row || []);

    const customers = Array
      .from(customerTotals.entries())
      .map(([name, revenue]) => ({
        name,
        revenue
      }))
      .filter(customer => customer.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const topCustomers =
      customers.slice(0, 10);

    const topTotal =
      topCustomers.reduce(
        (sum, customer) =>
          sum + customer.revenue,
        0
      );

    const plRaw = await qboReport(
      req.qbo,
      'ProfitAndLoss',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual'
      }
    );

    const pl = parsePL(plRaw);

    const totalRevenue =
      safeNum(pl.revenue);

    res.json({
      customers: topCustomers.map(customer => ({
        ...customer,

        pct:
          totalRevenue > 0
            ? customer.revenue / totalRevenue
            : 0
      })),

      totalRevenue,
      topTotal,

      otherRevenue: Math.max(
        0,
        totalRevenue - topTotal
      ),

      startDate,
      endDate
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Revenue vs Expenses - monthly
 */
apiRouter.get('/expenses', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const startDate =
      req.query.start || currentYearStart();

    const endDate =
      req.query.end || today();

    const raw = await qboReport(
      req.qbo,
      'ProfitAndLoss',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual',
        summarize_column_by: 'Month'
      }
    );

    const reportColumns =
      Array.isArray(raw?.Columns?.Column)
        ? raw.Columns.Column
        : [];

    /*
     * QuickBooks monthly P&L reports normally return:
     *
     * Column 0 = account or section name
     * Column 1 onwards = individual months
     */
    const monthColumns = reportColumns
      .map((column, index) => {
        if (index === 0) {
          return null;
        }

        const metadata =
          Array.isArray(column?.MetaData)
            ? column.MetaData
            : [];

        const columnKey = metadata.find(
          item => item?.Name === 'ColKey'
        )?.Value;

        const title = String(
          column?.ColTitle ||
          columnKey ||
          ''
        ).trim();

        return {
          index,
          title,
          key: normaliseMonthKey(
            columnKey || title
          )
        };
      })
      .filter(
        column =>
          column &&
          column.title
      );

    function normaliseLabel(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/\s+/g, ' ');
    }

    function normaliseMonthKey(value) {
      const text =
        String(value || '').trim();

      const directMatch = text.match(
        /^(\d{4})[-/](\d{1,2})/
      );

      if (directMatch) {
        return (
          `${directMatch[1]}-` +
          String(directMatch[2]).padStart(
            2,
            '0'
          )
        );
      }

      const parsedDate =
        new Date(text);

      if (
        Number.isNaN(
          parsedDate.getTime()
        )
      ) {
        return '';
      }

      return (
        `${parsedDate.getFullYear()}-` +
        String(
          parsedDate.getMonth() + 1
        ).padStart(2, '0')
      );
    }

    function sectionLabels(row) {
      return [
        row?.Header?.ColData?.[0]?.value,
        row?.ColData?.[0]?.value,
        row?.Summary?.ColData?.[0]?.value
      ]
        .map(normaliseLabel)
        .filter(Boolean);
    }

    function findSection(
      rows,
      wantedLabels
    ) {
      const wanted =
        wantedLabels.map(
          normaliseLabel
        );

      for (const row of rows || []) {
        const labels =
          sectionLabels(row);

        if (
          labels.some(label =>
            wanted.includes(label)
          )
        ) {
          return row;
        }

        const nested =
          findSection(
            row?.Rows?.Row || [],
            wantedLabels
          );

        if (nested) {
          return nested;
        }
      }

      return null;
    }

    function valuesFromColumns(
      columns = []
    ) {
      return monthColumns.map(
        ({ index }) =>
          safeNum(
            columns[index]?.value
          )
      );
    }

    function rowValues(row) {
      if (!row) {
        return monthColumns.map(
          () => 0
        );
      }

      const summaryColumns =
        Array.isArray(
          row?.Summary?.ColData
        )
          ? row.Summary.ColData
          : [];

      if (summaryColumns.length) {
        return valuesFromColumns(
          summaryColumns
        );
      }

      const dataColumns =
        Array.isArray(row?.ColData)
          ? row.ColData
          : [];

      if (dataColumns.length) {
        return valuesFromColumns(
          dataColumns
        );
      }

      return monthColumns.map(
        () => 0
      );
    }

    function addArrays(
      ...arrays
    ) {
      return monthColumns.map(
        (_, index) =>
          arrays.reduce(
            (total, values) =>
              total +
              safeNum(
                values?.[index]
              ),
            0
          )
      );
    }

    const reportRows =
      Array.isArray(raw?.Rows?.Row)
        ? raw.Rows.Row
        : [];

    const revenueRow =
      findSection(
        reportRows,
        [
          'Total Income',
          'Total Revenue',
          'Income',
          'Revenue'
        ]
      );

    const costOfSalesRow =
      findSection(
        reportRows,
        [
          'Total Cost of Sales',
          'Total Cost of Goods Sold',
          'Cost of Sales',
          'Cost of Goods Sold'
        ]
      );

    const operatingExpensesRow =
      findSection(
        reportRows,
        [
          'Total Expenses',
          'Expenses',
          'Operating Expenses'
        ]
      );

    const otherExpensesRow =
      findSection(
        reportRows,
        [
          'Total Other Expenses',
          'Other Expenses'
        ]
      );

    const revenue =
      rowValues(revenueRow);

    const costOfSales =
      rowValues(costOfSalesRow);

    const operatingExpenses =
      rowValues(
        operatingExpensesRow
      );

    const otherExpenses =
      rowValues(
        otherExpensesRow
      );

    /*
     * Total chart expenses:
     *
     * Cost of Sales
     * + Operating Expenses
     * + Other Expenses
     */
    const expenses =
      addArrays(
        costOfSales,
        operatingExpenses,
        otherExpenses
      );

    const months =
      monthColumns.map(column => {
        const parsedDate =
          new Date(column.title);

        if (
          !Number.isNaN(
            parsedDate.getTime()
          )
        ) {
          return parsedDate
            .toLocaleDateString(
              'en-GB',
              {
                month: 'short',
                year: '2-digit'
              }
            );
        }

        return column.title;
      });

    res.json({
      months,

      monthKeys:
        monthColumns.map(
          column => column.key
        ),

      revenue,
      expenses,
      costOfSales,
      operatingExpenses,

      startDate,
      endDate
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Helpers
 */
function today() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

/**
 * Financial year starts on 1 April.
 */
function currentYearStart() {
  const now = new Date();

  const financialYear =
    now.getMonth() >= 3
      ? now.getFullYear()
      : now.getFullYear() - 1;

  return `${financialYear}-04-01`;
}

function daysOverdue(dateValue) {
  if (!dateValue) return 0;

  const dueDate = new Date(
    `${dateValue}T00:00:00`
  );

  if (Number.isNaN(dueDate.getTime())) {
    return 0;
  }

  const currentDate = new Date();

  currentDate.setHours(0, 0, 0, 0);
  dueDate.setHours(0, 0, 0, 0);

  const difference = Math.floor(
    (
      currentDate.getTime() -
      dueDate.getTime()
    ) / 86400000
  );

  return difference > 0
    ? difference
    : 0;
}

function safeNum(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return 0;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/[£$€]/g, '')
    .replace(/\((.*)\)/, '-$1')
    .trim();

  const number =
    Number.parseFloat(cleaned);

  return Number.isFinite(number)
    ? number
    : 0;
}

function isNumericValue(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return false;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/[£$€]/g, '')
    .replace(/\((.*)\)/, '-$1')
    .trim();

  return Number.isFinite(
    Number.parseFloat(cleaned)
  );
}

function getLastNumericColumn(columns = []) {
  for (
    let index = columns.length - 1;
    index >= 1;
    index -= 1
  ) {
    const value =
      columns[index]?.value;

    if (isNumericValue(value)) {
      return safeNum(value);
    }
  }

  return 0;
}

function isReportTotalRow(name) {
  const normalised =
    String(name || '')
      .trim()
      .toLowerCase();

  return (
    normalised === 'total' ||
    normalised === 'grand total' ||
    normalised === 'net income' ||
    normalised === 'gross profit' ||
    normalised === 'income' ||
    normalised === 'sales' ||
    normalised.startsWith('total ')
  );
}

function handleError(res, err) {
  const details =
    err.response?.data ||
    err.message ||
    'Unknown error';

  console.error(
    'API ERROR:',
    details
  );

  res
    .status(err.status || 500)
    .json({
      error: 'API failed',
      details
    });
}
