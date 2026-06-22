/**
 * routes/budget.js — QBO Budget vs Actual
 *
 * GET /api/budget/list          — list available budgets
 * GET /api/budget/vs-actual     — budget vs actual for current year
 */

import { Router } from 'express';
import { qboQuery, qboReport, qboGet } from '../lib/qbo.js';

export const budgetRouter = Router();

// ── List budgets ───────────────────────────────────────────────────────────
budgetRouter.get('/list', async (req, res) => {
  try {
    const data = await qboQuery(req.qbo,
      `SELECT * FROM Budget MAXRESULTS 20`
    );
    const budgets = (data.QueryResponse?.Budget || []).map(b => ({
      id:     b.Id,
      name:   b.Name,
      year:   b.BudgetDetail?.[0]?.BudgetPeriod || '',
      type:   b.BudgetType,
    }));
    res.json({ budgets });
  } catch (err) { handleError(res, err); }
});

// ── Budget vs Actual ───────────────────────────────────────────────────────
// GET /api/budget/vs-actual?budgetId=xxxx
budgetRouter.get('/vs-actual', async (req, res) => {
  try {
    // ✅ ADDED: get selected budget
    const budgetId = req.query.budgetId;

    // ✅ FIXED: financial year (April start)
    const now  = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const start = `${year}-04-01`;

    const end   = new Date().toISOString().slice(0, 10); // YTD
    const month = new Date().getMonth() + 1; // current month number

    // Pull Budget vs Actual report from QBO
    const [bvaRaw, plRaw] = await Promise.all([
      qboReport(req.qbo, 'BudgetvsActual', {
        // ✅ ADDED: budget_id (THIS WAS MISSING)
        budget_id:        budgetId,
        start_date:       start,
        end_date:         end,
        accounting_method:'Accrual',
      }),
      qboReport(req.qbo, 'ProfitAndLoss', {
        start_date:             start,
        end_date:               end,
        accounting_method:      'Accrual',
        summarize_column_by:    'Month',
      }),
    ]);

    // ✅ OPTIONAL SAFETY (prevents 500 if QBO behaves oddly)
    if (!bvaRaw || !bvaRaw.Rows) {
      return res.json({ year, currentMonth: month, bva: {}, monthly: [] });
    }

    // Parse Budget vs Actual report
    const bva = parseBudgetVsActual(bvaRaw, year, month);

    // Parse monthly P&L for the chart
    const monthly = parseMonthlyPL(plRaw, year);

    res.json({ year, currentMonth: month, bva, monthly });
  } catch (err) { handleError(res, err); }
});

// ── Parsers ────────────────────────────────────────────────────────────────

function parseBudgetVsActual(raw, year, currentMonth) {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: new Date(year, i, 1).toLocaleString('en-GB', { month: 'short' }),
  }));

  const lines = [
    { key: 'sales',      labels: ['income', 'revenue', 'sales'] },
    { key: 'cos',        labels: ['cost of goods', 'cost of sales', 'cost of revenue'] },
    { key: 'grossProfit',labels: ['gross profit'] },
    { key: 'overheads',  labels: ['expenses', 'overheads', 'operating'] },
    { key: 'netProfit',  labels: ['net income', 'net profit', 'net earnings'] },
  ];

  const result = {};
  lines.forEach(l => {
    result[l.key] = {
      label:        friendlyLabel(l.key),
      monthly:      months.slice(0, currentMonth).map(m => ({
        month: m.month, label: m.label,
        actual: 0, budget: 0, variance: 0, variancePct: 0,
      })),
      ytd: { actual: 0, budget: 0, variance: 0, variancePct: 0 },
    };
  });

  for (const row of raw.Rows?.Row || []) {
    const header = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
    const matched = lines.find(l => l.labels.some(lb => header.includes(lb)));
    if (!matched) continue;

    const bucket = result[matched.key];

    const summaryRow = findSummaryRow(row);
    if (!summaryRow) continue;

    const cols = summaryRow.ColData || [];

    let colIdx = 1;
    for (let m = 0; m < currentMonth; m++) {
      if (colIdx + 2 >= cols.length) break;

      const actual  = toNum(cols[colIdx]?.value);
      const budget  = toNum(cols[colIdx + 1]?.value);
      const variance = budget !== 0 ? actual - budget : 0;
      const variancePct = budget !== 0
        ? round((variance / Math.abs(budget)) * 100, 1)
        : 0;

      bucket.monthly[m] = {
        ...bucket.monthly[m],
        actual, budget, variance, variancePct,
      };

      colIdx += 3;
    }

    const ytdActual  = toNum(cols[cols.length - 3]?.value);
    const ytdBudget  = toNum(cols[cols.length - 2]?.value);
    const ytdVar     = ytdBudget !== 0 ? ytdActual - ytdBudget : 0;
    const ytdVarPct  = ytdBudget !== 0
      ? round((ytdVar / Math.abs(ytdBudget)) * 100, 1)
      : 0;

    bucket.ytd = {
      actual: ytdActual,
      budget: ytdBudget,
      variance: ytdVar,
      variancePct: ytdVarPct
    };
  }

  return result;
}

function parseMonthlyPL(raw, year) {
  const months = [];
  const headerRow = raw.Columns?.Column || [];
  const monthCols = headerRow.slice(1).filter(c => c.ColType === 'Money');

  for (const row of raw.Rows?.Row || []) {
    const header = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
    if (!header.includes('income') && !header.includes('revenue') && !header.includes('sales')) continue;

    const summaryRow = findSummaryRow(row);
    if (!summaryRow) continue;

    const cols = summaryRow.ColData || [];

    monthCols.forEach((col, i) => {
      months.push({
        label: col.ColTitle || `Month ${i+1}`,
        revenue: toNum(cols[i + 1]?.value),
      });
    });

    break;
  }

  return months;
}

function findSummaryRow(section) {
  if (section.Summary) return section.Summary;
  if (section.ColData)  return section;

  for (const row of section.Rows?.Row || []) {
    const found = findSummaryRow(row);
    if (found) return found;
  }

  return null;
}

function friendlyLabel(key) {
  return {
    sales:'Sales',
    cos:'Cost of Sales',
    grossProfit:'Gross Profit',
    overheads:'Overheads',
    netProfit:'Net Profit'
  }[key] || key;
}

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round(n, dp = 2) {
  return Math.round(n * 10**dp) / 10**dp;
}

function handleError(res, err) {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
}
``
