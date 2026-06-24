import { Router } from 'express';
import { qboReport, qboQuery } from '../lib/qbo.js';
import { parsePL, parseBalanceSheet, parseCashFlow } from '../lib/parsers.js';

export const apiRouter = Router();

/**
 * ✅ Ensure QuickBooks is connected before running any route
 */
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
 * ✅ Profit & Loss
 */
apiRouter.get('/pl', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const params = {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual',
    };

    const raw = await qboReport(req.qbo, 'ProfitAndLoss', params);
    const parsed = parsePL(raw);

    res.json(parsed);

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Balance Sheet
 */
apiRouter.get('/balance-sheet', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'BalanceSheet', {
      date: req.query.date || today(),
      accounting_method: 'Accrual',
    });

    const parsed = parseBalanceSheet(raw);
    res.json(parsed);

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Cash Flow
 */
apiRouter.get('/cash-flow', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'CashFlow', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
    });

    const parsed = parseCashFlow(raw);
    res.json(parsed);

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Outstanding Invoices
 */
apiRouter.get('/invoices/outstanding', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const data = await qboQuery(
      req.qbo,
      `SELECT Id, DocNumber, CustomerRef, Balance, DueDate, TotalAmt
       FROM Invoice MAXRESULTS 1000`
    );

    const invoices = (data.QueryResponse?.Invoice || [])
      .map(inv => ({
        id: inv.Id,
        number: inv.DocNumber,
        customer: inv.CustomerRef?.name,
        balance: parseFloat(inv.Balance),
        total: parseFloat(inv.TotalAmt),
        dueDate: inv.DueDate,
        daysOverdue: daysOverdue(inv.DueDate),
      }))
      .filter(inv => inv.balance > 0);

    const overdueInvoices = invoices.filter(i => i.daysOverdue > 0);

    overdueInvoices.sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({
      invoices: overdueInvoices,
      totalOutstanding: invoices.reduce((s, i) => s + i.balance, 0),
      count: invoices.length,
      overdueCount: overdueInvoices.length,
      overdueTotal: overdueInvoices.reduce((s, i) => s + i.balance, 0)
    });

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Top Customers (RECONCILED TO P&L)
 */
apiRouter.get('/customers/top', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    // ✅ 1. Get Customer Income
    const raw = await qboReport(req.qbo, 'CustomerIncome', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      summarize_column_by: 'Total',
    });

    const rows = [];

    function extract(rowsInput = []) {
      for (const r of rowsInput) {

        if (r.type === 'Data') {
          const cols = r.ColData || [];
          const name = cols[0]?.value;
          const revenue = safeNum(cols[1]?.value);

          if (name && revenue > 0) {
            rows.push({ name, revenue });
          }
        }

        if (!r.type && r.ColData) {
          const cols = r.ColData || [];
          const name = cols[0]?.value;
          const revenue = safeNum(cols[1]?.value);

          if (name && revenue > 0) {
            rows.push({ name, revenue });
          }
        }

        if (r.Rows?.Row) {
          extract(r.Rows.Row);
        }
      }
    }

    extract(raw.Rows?.Row || []);

    rows.sort((a, b) => b.revenue - a.revenue);

    const limit = parseInt(req.query.limit || '10');
    const topN = rows.slice(0, limit);

    const topTotal = topN.reduce((s, r) => s + r.revenue, 0);

    // ✅ 2. Get P&L Revenue (FOR RECONCILIATION)
    const plRaw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual',
    });

    const pl = parsePL(plRaw);
    const plRevenue = pl.revenue;

    // ✅ 3. Calculate "Other"
    const otherRevenue = plRevenue - topTotal;

    res.json({
      customers: topN.map(r => ({
        ...r,
        pct: plRevenue > 0 ? r.revenue / plRevenue : 0
      })),
      totalRevenue: plRevenue,   // ✅ now tied to P&L
      topTotal,
      otherRevenue               // ✅ balancing figure
    });

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Expenses
 */
apiRouter.get('/expenses', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual',
    });

    const expenses = [];

    for (const section of raw.Rows?.Row || []) {
      const header = section.Header?.ColData?.[0]?.value || '';

      if (/expenses?/i.test(header)) {
        for (const row of section.Rows?.Row || []) {
          if (row.type === 'Data') {
            const cols = row.ColData || [];
            const name = cols[0]?.value;
            const amount = safeNum(cols[1]?.value);

            if (name && amount !== 0) {
              expenses.push({ name, amount });
            }
          }
        }
      }
    }

    expenses.sort((a, b) => b.amount - a.amount);

    res.json({
      expenses,
      total: expenses.reduce((s, e) => s + e.amount, 0)
    });

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Helpers
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentYearStart() {
  const now = new Date();
  const year = now.getMonth() >= 3
    ? now.getFullYear()
    : now.getFullYear() - 1;

  return `${year}-04-01`;
}

function daysOverdue(d) {
  if (!d) return 0;
  const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function handleError(res, err) {
  console.error('API ERROR:', err.response?.data || err.message);
  res.status(err.status || 500).json({
    error: 'API failed',
    details: err.response?.data || err.message
  });
}
