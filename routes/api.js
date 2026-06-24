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
      accounting_method: 'Accrual',
    });

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
      end_date: req.query.end || today(),
    });

    res.json(parseCashFlow(raw));

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Revenue vs Expenses (FIXED)
 */
apiRouter.get('/expenses', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual',
      summarize_column_by: 'Month' // ✅ CRITICAL FIX
    });

    const months = raw.Columns?.Column?.slice(1).map(c => c.ColTitle) || [];

    const revenue = Array(months.length).fill(0);
    const expenses = Array(months.length).fill(0);

    function walk(rows = []) {
      for (const row of rows) {
        const header = row.Header?.ColData?.[0]?.value || '';

        if (/income|revenue/i.test(header)) {
          for (const r of row.Rows?.Row || []) {
            if (r.type === 'Data') {
              r.ColData.slice(1).forEach((c, i) => {
                revenue[i] += safeNum(c.value);
              });
            }
          }
        }

        if (/expenses?/i.test(header)) {
          for (const r of row.Rows?.Row || []) {
            if (r.type === 'Data') {
              r.ColData.slice(1).forEach((c, i) => {
                expenses[i] += safeNum(c.value);
              });
            }
          }
        }

        if (row.Rows?.Row) {
          walk(row.Rows.Row);
        }
      }
    }

    walk(raw.Rows?.Row || []);

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
        dueDate: inv.DueDate,
        daysOverdue: daysOverdue(inv.DueDate),
      }))
      .filter(inv => inv.balance > 0);

    const overdue = invoices.filter(i => i.daysOverdue > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({
      invoices: overdue,
      totalOutstanding: invoices.reduce((s, i) => s + i.balance, 0)
    });

  } catch (err) {
    handleError(res, err);
  }
});

/**
 * ✅ Top Customers (unchanged working version)
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

    const pl = parsePL(await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: req.query.start || currentYearStart(),
      end_date: req.query.end || today(),
      accounting_method: 'Accrual',
    }));

    res.json({
      customers: topN,
      totalRevenue: pl.revenue,
      otherRevenue: pl.revenue - topTotal
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
  const diff = Math.floor((Date.now() - new Date(d)) / 86400000);
  return diff > 0 ? diff : 0;
}

function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function handleError(res, err) {
  console.error(err);
  res.status(500).json({ error: err.message });
}
