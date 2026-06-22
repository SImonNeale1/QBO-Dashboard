/**
 * routes/budget.js — QBO Budget vs Actual (FINAL WORKING VERSION)
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
      accounting_method: 'Accrual'
    });

    const actual = parsePL(plRaw);

    // ✅ 2. GET ALL BUDGETS
    const budgetData = await qboQuery(
      req.qbo,
      `SELECT * FROM Budget MAXRESULTS 20`
    );

    const allBudgets = (budgetData.QueryResponse?.Budget || []);

    // ✅ Only budgets with data
    const validBudgets = allBudgets.filter(b =>
      Array.isArray(b.BudgetDetail) && b.BudgetDetail.length > 0
    );

    // ✅ Debug
    console.log('ALL BUDGETS:', validBudgets.map(b => b.Name));

    // ✅ Pick current FY budget (e.g. "2026-27")
    const fyLabel = `${year}-${(year+1).toString().slice(-2)}`;

    let budget = validBudgets.find(b =>
      (b.Name || '').includes(fyLabel)
    );

    // ✅ fallback if no FY match
    if (!budget) {
      budget = validBudgets[0];
    }

    console.log('USING BUDGET:', budget?.Name);
    console.log('SAMPLE LINE:', budget?.BudgetDetail?.[0]);

    // ✅ 3. CALCULATE TOTALS
    const budgetTotals = extractBudgetTotals(budget);

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


// ── Helper ─────────────────────────────────────────────────────────────────
function buildLine(actual, budget) {
  return {
    actual,
    budget,
    variance: actual - budget
  };
}


// ── Budget Helper ✅ FIXED FOR YOUR STRUCTURE ───────────────────────────────
function extractBudgetTotals(budget) {
  let revenue = 0;
  let costOfSales = 0;
  let expenses = 0;

  for (const line of budget?.BudgetDetail || []) {

    const name = (line.AccountRef?.name || '').toLowerCase();

    // ✅ THIS IS THE CRITICAL FIX
    const amount = parseFloat(line.Amount || 0);

    if (/revenue|sales|turnover|income/i.test(name)) {
      revenue += amount;

    } else if (/cost|cogs|direct/i.test(name)) {
      costOfSales += amount;

    } else {
      expenses += amount;
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
