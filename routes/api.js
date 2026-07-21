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
 */
apiRouter.get('/balance-sheet', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'BalanceSheet', {
      date: req.query.date || today(),
      accounting_method: 'Accrual'
    });

    res.json(parseBalanceSheet(raw));
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
      .map(inv => ({
        id: inv.Id,
        number: inv.DocNumber,
        customer: inv.CustomerRef?.name || 'Unknown',
        balance: safeNum(inv.Balance),
        total: safeNum(inv.TotalAmt),
        dueDate: inv.DueDate,
        daysOverdue: daysOverdue(inv.DueDate)
      }))
      .filter(inv => inv.balance > 0);

    const overdueInvoices = invoices
      .filter(inv => inv.daysOverdue > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({
      invoices: overdueInvoices,
      totalOutstanding: invoices.reduce(
        (sum, inv) => sum + inv.balance,
        0
      ),
      count: invoices.length,
      overdueCount: overdueInvoices.length,
      overdueTotal: overdueInvoices.reduce(
        (sum, inv) => sum + inv.balance,
        0
      )
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Top Customers YTD
 */
apiRouter.get('/customers/top', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const startDate =
      req.query.start || currentYearStart();

    const endDate =
      req.query.end || today();

    const raw = await qboReport(
      req.qbo,
      'CustomerIncome',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual',
        summarize_column_by: 'Total'
      }
    );

    /*
     * QuickBooks reports can return more than two columns.
     * The customer total is therefore taken from the final
     * valid numeric column rather than always using column 2.
     *
     * Duplicate customer rows are combined before ranking.
     */
    const customerTotals = new Map();

    function extractCustomerRows(rows = []) {
      for (const row of rows) {
        const columns = Array.isArray(row.ColData)
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

          if (
            customerName &&
            !isReportTotalRow(customerName) &&
            revenue !== 0
          ) {
            const existing =
              customerTotals.get(customerName) || 0;

            customerTotals.set(
              customerName,
              existing + revenue
            );
          }
        }

        if (Array.isArray(row.Rows?.Row)) {
          extractCustomerRows(row.Rows.Row);
        }
      }
    }

    extractCustomerRows(raw.Rows?.Row || []);

    const customers = Array
      .from(customerTotals.entries())
      .map(([name, revenue]) => ({
        name,
        revenue
      }))
      .filter(customer => customer.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const topN = customers.slice(0, 10);

    const topTotal = topN.reduce(
      (sum, customer) => sum + customer.revenue,
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
    const plRevenue = safeNum(pl.revenue);

    res.json({
      customers: topN.map(customer => ({
        ...customer,
        pct:
          plRevenue > 0
            ? customer.revenue / plRevenue
            : 0
      })),
      totalRevenue: plRevenue,
      topTotal,
      otherRevenue: Math.max(
        0,
        plRevenue - topTotal
      ),
      startDate,
      endDate
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Revenue vs Expenses
 */
apiRouter.get('/expenses', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(
      req.qbo,
      'ProfitAndLoss',
      {
        start_date:
          req.query.start || currentYearStart(),
        end_date:
          req.query.end || today(),
        accounting_method: 'Accrual',
        summarize_column_by: 'Month'
      }
    );

    const monthMap = {};

    function walk(rows = []) {
      for (const row of rows) {
        if (row.type === 'Data') {
          const dateValue =
            row.ColData?.[0]?.id ||
            row.ColData?.[0]?.value;

          const amount =
            safeNum(row.ColData?.[1]?.value);

          if (dateValue) {
            const date = new Date(dateValue);

            if (!Number.isNaN(date.getTime())) {
              const key =
                `${date.getFullYear()}-${date.getMonth()}`;

              if (!monthMap[key]) {
                monthMap[key] = {
                  month: date.toLocaleString(
                    'en-GB',
                    { month: 'short' }
                  ),
                  revenue: 0,
                  expenses: 0,
                  order: new Date(
                    date.getFullYear(),
                    date.getMonth(),
                    1
                  )
                };
              }

              if (amount >= 0) {
                monthMap[key].revenue += amount;
              } else {
                monthMap[key].expenses +=
                  Math.abs(amount);
              }
            }
          }
        }

        if (Array.isArray(row.Rows?.Row)) {
          walk(row.Rows.Row);
        }
      }
    }

    walk(raw.Rows?.Row || []);

    const sorted = Object
      .values(monthMap)
      .sort((a, b) => a.order - b.order);

    res.json({
      months: sorted.map(item => item.month),
      revenue: sorted.map(item => item.revenue),
      expenses: sorted.map(item => item.expenses)
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

function currentYearStart() {
  const now = new Date();

  const year =
    now.getMonth() >= 3
      ? now.getFullYear()
      : now.getFullYear() - 1;

  return `${year}-04-01`;
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
    (currentDate.getTime() -
      dueDate.getTime()) /
      86400000
  );

  return difference > 0
    ? difference
    : 0;
}

function safeNum(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return 0;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/[£$€]/g, '')
    .replace(/\((.*)\)/, '-$1')
    .trim();

  const number = Number.parseFloat(cleaned);

  return Number.isFinite(number)
    ? number
    : 0;
}

function getLastNumericColumn(columns = []) {
  for (
    let index = columns.length - 1;
    index >= 1;
    index -= 1
  ) {
    const rawValue =
      columns[index]?.value;

    if (
      rawValue === null ||
      rawValue === undefined ||
      rawValue === ''
    ) {
      continue;
    }

    const cleaned = String(rawValue)
      .replace(/,/g, '')
      .replace(/[£$€]/g, '')
      .replace(/\((.*)\)/, '-$1')
      .trim();

    const value =
      Number.parseFloat(cleaned);

    if (Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

function isReportTotalRow(name) {
  const normalised =
    String(name)
      .trim()
      .toLowerCase();

  return (
    normalised === 'total' ||
    normalised === 'grand total' ||
    normalised.startsWith('total ')
  );
}

function handleError(res, err) {
  console.error(
    'API ERROR:',
    err.response?.data || err.message
  );

  res
    .status(err.status || 500)
    .json({
      error: 'API failed',
      details:
        err.response?.data ||
        err.message
    });
}
