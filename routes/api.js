import { Router } from 'express';
import { qboReport, qboQuery } from '../lib/qbo.js';
import { parsePL, parseBalanceSheet, parseCashFlow } from '../lib/parsers.js';

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
 * ✅ Profit & Loss
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
 * ✅ Balance Sheet
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
 * ✅ Cash Flow
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
 * ✅ Top Customers (unchanged working)
 */
apiRouter.get('/customers/top', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'CustomerIncome', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      summarize_column_by: 'Total',
    });

    const rows = [];

    function extract(rowsInput = []) {
      for (const r of rowsInput) {
        if (r.type === 'Data' || (!r.type && r.ColData)) {
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

    const topN = rows.slice(0, 10);
    const topTotal = topN.reduce((s, r) => s + r.revenue, 0);

    const plRaw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual'
    });

    const pl = parsePL(plRaw);
    const plRevenue = pl.revenue;

    res.json({
      customers: topN.map(r => ({
        ...r,
        pct: plRevenue > 0 ? r.revenue / plRevenue : 0
      })),
      totalRevenue: plRevenue,
      topTotal,
      otherRevenue: plRevenue - topTotal
    });

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ ✅ ✅ Revenue vs Expenses (PERIOD FIX ONLY)
 */
apiRouter.get('/expenses', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual',
      summarize_column_by: 'Month'
    });

    const allMonths = raw.Columns?.Column?.slice(1).map(c => c.ColTitle) || [];

    let revenue = Array(allMonths.length).fill(0);
    let expenses = Array(allMonths.length).fill(0);

    function findTotals(rows = []) {
      for (const r of rows) {
        const header = r.Header?.ColData?.[0]?.value || '';

        if (/total income/i.test(header)) {
          revenue = (r.Summary?.ColData || []).slice(1).map(c => safeNum(c?.value));
        }

        if (/total expenses/i.test(header)) {
          expenses = (r.Summary?.ColData || []).slice(1).map(c => safeNum(c?.value));
        }

        if (r.Rows?.Row) findTotals(r.Rows.Row);
      }
    }

    findTotals(raw.Rows?.Row || []);

    // ✅ ✅ CRITICAL FIX — slice from April only
    const startIndex = allMonths.findIndex(m => m.startsWith('Apr'));

    const months = startIndex >= 0 ? allMonths.slice(startIndex) : allMonths;
    const revenueFiltered = startIndex >= 0 ? revenue.slice(startIndex) : revenue;
    const expensesFiltered = startIndex >= 0 ? expenses.slice(startIndex) : expenses;

    res.json({
      months,
      revenue: revenueFiltered,
      expenses: expensesFiltered
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
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
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
