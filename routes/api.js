import { Router } from 'express';
import { qboReport, qboQuery } from '../lib/qbo.js';
import { parsePL, parseBalanceSheet, parseCashFlow } from '../lib/parsers.js';

export const apiRouter = Router();

apiRouter.get('/pl', async (req, res) => {
  try {
    const params = {
      start_date: req.query.start || currentYearStart(),
      end_date:   req.query.end   || today(),
      accounting_method: 'Accrual',
    };
    if (req.query.summarize_column_by) params.summarize_column_by = req.query.summarize_column_by;
    const raw = await qboReport(req.qbo, 'ProfitAndLoss', params);
    res.json(parsePL(raw));
  } catch (err) { handleError(res, err); }
});

apiRouter.get('/balance-sheet', async (req, res) => {
  try {
    const raw = await qboReport(req.qbo, 'BalanceSheet', {
      date: req.query.date || today(),
      accounting_method: 'Accrual',
    });
    res.json(parseBalanceSheet(raw));
  } catch (err) { handleError(res, err); }
});

apiRouter.get('/cash-flow', async (req, res) => {
  try {
    const raw = await qboReport(req.qbo, 'CashFlow', {
      start_date: req.query.start || currentYearStart(),
      end_date:   req.query.end   || today(),
    });
    res.json(parseCashFlow(raw));
  } catch (err) { handleError(res, err); }
});

apiRouter.get('/invoices/outstanding', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const data  = await qboQuery(
      req.qbo,
      `SELECT Id, DocNumber, CustomerRef, Balance, DueDate, TotalAmt
       FROM Invoice WHERE Balance > '0'
       ORDERBY DueDate ASC MAXRESULTS ${limit}`
    );
    const invoices = (data.QueryResponse?.Invoice || []).map(inv => ({
      id:          inv.Id,
      number:      inv.DocNumber,
      customer:    inv.CustomerRef?.name,
      balance:     parseFloat(inv.Balance),
      total:       parseFloat(inv.TotalAmt),
      dueDate:     inv.DueDate,
      daysOverdue: daysOverdue(inv.DueDate),
    }));
    res.json({
      invoices,
      totalOutstanding: invoices.reduce((s, i) => s + i.balance, 0),
      count:            invoices.length,
      overdueCount:     invoices.filter(i => i.daysOverdue > 0).length,
    });
  } catch (err) { handleError(res, err); }
});

apiRouter.get('/customers/top', async (req, res) => {
  try {
    const raw = await qboReport(req.qbo, 'CustomerSales', {
      start_date:          req.query.start || currentYearStart(),
      end_date:            req.query.end   || today(),
      summarize_column_by: 'Total',
    });
    const rows = [];
    for (const section of raw.Rows?.Row || []) {
      if (section.type === 'Section') {
        for (const row of section.Rows?.Row || []) {
          if (row.type === 'Data') {
            const cols = row.ColData || [];
            const name = cols[0]?.value;
            const revenue = parseFloat(cols[1]?.value || '0');
            if (name && revenue > 0) rows.push({ name, revenue });
          }
        }
      }
    }
    rows.sort((a, b) => b.revenue - a.revenue);
    const limit    = parseInt(req.query.limit || '10');
    const topN     = rows.slice(0, limit);
    const total    = rows.reduce((s, r) => s + r.revenue, 0);
    const topTotal = topN.reduce((s, r) => s + r.revenue, 0);
    res.json({
      customers:    topN.map(r => ({ ...r, pct: total > 0 ? r.revenue / total : 0 })),
      totalRevenue: total,
      otherRevenue: total - topTotal,
    });
  } catch (err) { handleError(res, err); }
});

apiRouter.get('/expenses', async (req, res) => {
  try {
    const raw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date:        req.query.start || currentYearStart(),
      end_date:          req.query.end   || today(),
      accounting_method: 'Accrual',
    });
    const expenses = [];
    for (const section of raw.Rows?.Row || []) {
      const header = section.Header?.ColData?.[0]?.value || '';
      if (/expenses?/i.test(header)) {
        for (const row of section.Rows?.Row || []) {
          if (row.type === 'Data') {
            const cols   = row.ColData || [];
            const name   = cols[0]?.value;
            const amount = parseFloat(cols[1]?.value || '0');
            if (name && amount !== 0) expenses.push({ name, amount });
          }
        }
      }
    }
    expenses.sort((a, b) => b.amount - a.amount);
    res.json({ expenses, total: expenses.reduce((s, e) => s + e.amount, 0) });
  } catch (err) { handleError(res, err); }
});

function today() { return new Date().toISOString().slice(0, 10); }
function currentYearStart() { return `${new Date().getFullYear()}-01-01`; }
function daysOverdue(d) {
  if (!d) return 0;
  const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}
function handleError(res, err) {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
}
