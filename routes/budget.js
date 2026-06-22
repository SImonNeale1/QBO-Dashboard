/**
 * routes/budget.js — QBO Budget vs Actual (ROBUST FIX)
 */

import { Router } from 'express';
import { qboQuery, qboReport } from '../lib/qbo.js';
import { parsePL } from '../lib/parsers.js';

export const budgetRouter = Router();


// ── List budgets ───────────────────────────────────────────────────────────
budgetRouter.get('/list', async (req, res) => {
  try {
    const data = await qboQuery(req.qbo,
      `SELECT * FROM Budget MAXRESULTS 20`
    );

    const budgets = (data.QueryResponse?.Budget || []).map(b => ({
      id:   b.Id,
      name: b.Name,
      year: b.BudgetDetail?.[0]?.BudgetPeriod || '',
      type: b.BudgetType,
    }));

    res.json({ budgets });

  } catch (err) {
    handleError(res, err);
  }
});


// ── Budget vs Actual ───────────────────────────────────────────────────────
budgetRouter.get('/vs-actual', async (req, res) => {
  try {
    const budgetId = req.query.budgetId;

    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;

    const start = `${year}-04-01`;
    const end   = new Date().toISOString().slice(0, 10);

    // ✅ 1. ACTUALS
    const plRaw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: start,
      end_date: end,
      accounting_method: 'Accrual',
      summarize_column_by: 'Month'
    });

    const actual = parsePL(plRaw);

    // ✅ 2. BUDGET
    const budgetData = await qboQuery(
      req.qbo,
      `SELECT * FROM Budget WHERE Id='${budgetId}'`
    );

    const budget = budgetData.QueryResponse?.Budget?.[0];

    // ✅ DEBUG (leave this in for now)
    console.log('RAW BUDGET SAMPLE:', JSON.stringify(budget?.BudgetDetail?.[0], null, 2));
    console.log('LINES COUNT:', budget?.BudgetDetail?.length);

    // ✅ 3. CALCULATE BUDGET
    const budgetTotals = extractBudgetTotalsYTD(budget, start, end);

    // ✅ 4. BUILD RESPONSE
    const bva = {
      revenue: buildLine(actual.revenue, budgetTotals.revenue),
      costOfSales: buildLine(actual.costOfSales, budgetTotals.costOfSales),
      grossProfit: buildLine(actual.grossProfit, budgetTotals.grossProfit),
      expenses: buildLine(actual.expenses, budgetTotals.expenses),
      netIncome: buildLine(actual.netIncome, budgetTotals.netIncome)
    };

    res.json({ year, bva });

  } catch (err) {
    console.error('BVA ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── Helper: build consistent line ──────────────────────────────────────────
function buildLine(actual, budget) {
  return {
    actual,
    budget,
    variance: actual - budget
  };
}


// ── Budget Extraction (ROBUST FIX) ─────────────────────────────────────────
function extractBudgetTotalsYTD(budget, start, end) {
  let revenue = 0;
  let costOfSales = 0;
  let expenses = 0;

  // ✅ Determine how many months from April to now
  const monthsIntoYear = (new Date(end).getMonth() - 3 + 12) % 12 + 1;

  for (const line of budget?.BudgetDetail || []) {

    const name = (line.AccountRef?.name || '').toLowerCase();

    // ✅ DEBUG
    console.log('ACCOUNT:', name);
    console.log('DETAIL:', line);

    let total = 0;

    // ✅ CASE 1: Monthly structure (standard QBO)
    if (Array.isArray(line.BudgetDetailLine)) {

      const relevantMonths = line.BudgetDetailLine.slice(3, 3 + monthsIntoYear);

      total = relevantMonths.reduce((sum, m) => {
        return sum + parseFloat(m.Amount || 0);
      }, 0);

    }

    // ✅ CASE 2: Fallback (flat budget structure)
    if (!total && line.Amount) {
      total = parseFloat(line.Amount || 0);
    }

    // ✅ Categorisation
    if (/revenue|sales|turnover|income/i.test(name)) {
      revenue += total;

    } else if (/cost|cogs|direct/i.test(name)) {
      costOfSales += total;

    } else {
      expenses += total;
    }
  }

  return {
    revenue,
    costOfSales,
    expenses,
    grossProfit: revenue - costOfSales,
    netIncome: revenue - costOfSales - expenses
  };
}


// ── Error Handler ──────────────────────────────────────────────────────────
function handleError(res, err) {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
}
