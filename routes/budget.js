/**
 * routes/budget.js — QBO Budget vs Actual (CUSTOM BUILT)
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
  } catch (err) { handleError(res, err); }
});

// ── Budget vs Actual (NEW WORKING VERSION) ─────────────────────────────────
budgetRouter.get('/vs-actual', async (req, res) => {
  try {
    const budgetId = req.query.budgetId;

    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const start = `${year}-04-01`;
    const end   = new Date().toISOString().slice(0, 10);

    // ✅ 1. GET ACTUALS (P&L)
    const plRaw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: start,
      end_date: end,
      accounting_method: 'Accrual',
      summarize_column_by: 'Month'
    });

    const actual = parsePL(plRaw);

    // ✅ 2. GET BUDGET
    const budgetData = await qboQuery(
      req.qbo,
      `SELECT * FROM Budget WHERE Id='${budgetId}'`
    );

    const budget = budgetData.QueryResponse?.Budget?.[0];

    // ✅ 3. EXTRACT BUDGET TOTALS
    const budgetTotals = extractBudgetTotals(budget);

    // ✅ 4. BUILD BUDGET VS ACTUAL
    const bva = {
      revenue: {
        actual: actual.revenue,
        budget: budgetTotals.revenue,
        variance: actual.revenue - budgetTotals.revenue
      },
      costOfSales: {
        actual: actual.costOfSales,
        budget: budgetTotals.costOfSales,
        variance: actual.costOfSales - budgetTotals.costOfSales
      },
      grossProfit: {
        actual: actual.grossProfit,
        budget: budgetTotals.grossProfit,
        variance: actual.grossProfit - budgetTotals.grossProfit
      },
      expenses: {
        actual: actual.expenses,
        budget: budgetTotals.expenses,
        variance: actual.expenses - budgetTotals.expenses
      },
      netIncome: {
        actual: actual.netIncome,
        budget: budgetTotals.netIncome,
        variance: actual.netIncome - budgetTotals.netIncome
      }
    };

    res.json({ year, bva });

  } catch (err) {
    console.error('BVA ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Budget Helper ──────────────────────────────────────────────────────────

function extractBudgetTotals(budget) {
  let revenue = 0;
  let costOfSales = 0;
  let expenses = 0;

  for (const line of budget?.BudgetDetail || []) {
    const amt = parseFloat(line.Amount || 0);
    const name = (line.AccountRef?.name || '').toLowerCase();

    // ✅ Much broader matching
    if (
      /revenue|sales|turnover|income/i.test(name)
    ) {
      revenue += amt;

    } else if (
      /cost|cogs|direct/i.test(name)
    ) {
      costOfSales += amt;

    } else {
      expenses += amt;
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
