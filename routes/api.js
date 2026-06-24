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
 * ✅ Top Customers (FIXED % ISSUE)
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
      accounting_method: 'Accrual',
    });

    const pl = parsePL(plRaw);
    const plRevenue = pl.revenue;

    const otherRevenue = plRevenue - topTotal;

    res.json({
      customers: topN.map(r => ({
        ...r,
        pct: plRevenue > 0 ? r.revenue / plRevenue : 0
      })),
      totalRevenue: plRevenue,
      topTotal,
      otherRevenue
    });

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Revenue vs Expenses (CORRECT + RELIABLE)
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

    const months = raw.Columns?.Column?.slice(1).map(c => c.ColTitle) || [];

    let revenue = [];
    let expenses = [];

    for (const section of raw.Rows?.Row || []) {
      const header = section.Header?.ColData?.[0]?.value || '';

      if (/income/i.test(header)) {
        const summary = section.Summary?.ColData || [];
        revenue = summary.slice(1).map(c => safeNum(c?.value));
      }

      if (/expenses?/i.test(header)) {
        const summary = section.Summary?.ColData || [];
        expenses = summary.slice(1).map(c => safeNum(c?.value));
      }
    }

    res.json({
      months,
      revenue,
      expenses
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
