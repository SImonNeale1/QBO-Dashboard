/**
 * routes/budget.js
 * QBO Budget vs Actual
 *
 * Returns:
 * - YTD Budget vs Actual
 * - Monthly Budget vs Actual
 *
 * Financial year: 1 April to 31 March
 */

import { Router } from 'express';
import { qboQuery, qboReport } from '../lib/qbo.js';
import { parsePL } from '../lib/parsers.js';

export const budgetRouter = Router();

const FY_START_MONTH = 3; // April, zero-indexed

// ── List budgets ───────────────────────────────────────────────────────────
budgetRouter.get('/list', async (req, res) => {
  try {
    const data = await qboQuery(
      req.qbo,
      'SELECT * FROM Budget MAXRESULTS 20'
    );

    const budgets = (data.QueryResponse?.Budget || [])
      .filter(
        budget =>
          Array.isArray(budget.BudgetDetail) &&
          budget.BudgetDetail.length > 0
      )
      .map(budget => ({
        id: budget.Id,
        name: budget.Name,
        year: getBudgetYearLabel(budget),
        type: budget.BudgetType
      }));

    res.json({ budgets });
  } catch (err) {
    handleError(res, err);
  }
});

// ── Budget vs Actual ───────────────────────────────────────────────────────
budgetRouter.get('/vs-actual', async (req, res) => {
  try {
    const requestedBudgetId = String(req.query.budgetId || '');

    const now = new Date();
    const financialYearStart = getFinancialYearStart(now);
    const ytdEnd = toIsoDate(now);

    const budgetQueryResult = await qboQuery(
      req.qbo,
      'SELECT * FROM Budget MAXRESULTS 20'
    );

    const allBudgets = budgetQueryResult.QueryResponse?.Budget || [];

    const validBudgets = allBudgets.filter(
      budget =>
        Array.isArray(budget.BudgetDetail) &&
        budget.BudgetDetail.length > 0
    );

    if (!validBudgets.length) {
      return res.status(404).json({
        error: 'No QuickBooks budgets containing budget detail were found'
      });
    }

    const budget = selectBudget({
      budgets: validBudgets,
      requestedBudgetId,
      financialYearStart
    });

    if (!budget) {
      return res.status(404).json({
        error: requestedBudgetId
          ? `Budget ${requestedBudgetId} was not found`
          : 'No suitable budget was found'
      });
    }

    console.log('USING BUDGET:', {
      id: budget.Id,
      name: budget.Name
    });

    // Get YTD actual P&L.
    const ytdActualRaw = await qboReport(
      req.qbo,
      'ProfitAndLoss',
      {
        start_date: toIsoDate(financialYearStart),
        end_date: ytdEnd,
        accounting_method: 'Accrual'
      }
    );

    const ytdActual = normaliseActualPL(parsePL(ytdActualRaw));

    // Get YTD budget totals.
    const ytdBudget = extractBudgetTotals(
      budget,
      financialYearStart,
      now
    );

    const bva = buildBva(ytdActual, ytdBudget);

    // Build each completed/current financial-year month.
    const monthRanges = buildFinancialYearMonthRanges(
      financialYearStart,
      now
    );

    const months = [];

    // Process sequentially to avoid sending too many simultaneous requests
    // to QuickBooks.
    for (const range of monthRanges) {
      const monthActualRaw = await qboReport(
        req.qbo,
        'ProfitAndLoss',
        {
          start_date: toIsoDate(range.start),
          end_date: toIsoDate(range.end),
          accounting_method: 'Accrual'
        }
      );

      const monthActual = normaliseActualPL(parsePL(monthActualRaw));

      const monthBudget = extractBudgetTotals(
        budget,
        range.start,
        range.end
      );

      months.push({
        key: formatMonthKey(range.start),
        label: formatMonthLabel(range.start),
        startDate: toIsoDate(range.start),
        endDate: toIsoDate(range.end),
        bva: buildBva(monthActual, monthBudget)
      });
    }

    res.json({
      year: financialYearStart.getFullYear(),
      financialYear: formatFinancialYearLabel(financialYearStart),
      startDate: toIsoDate(financialYearStart),
      endDate: ytdEnd,
      budget: {
        id: budget.Id,
        name: budget.Name,
        type: budget.BudgetType
      },
      bva,
      months
    });
  } catch (err) {
    console.error('BVA ERROR:', err);

    res.status(err.status || 500).json({
      error: err.message || 'Unable to load Budget vs Actual'
    });
  }
});

// ── BVA helpers ────────────────────────────────────────────────────────────
function buildBva(actual, budget) {
  return {
    revenue: buildLine(actual.revenue, budget.revenue),

    costOfSales: buildLine(
      actual.costOfSales,
      budget.costOfSales
    ),

    grossProfit: buildLine(
      actual.grossProfit,
      budget.grossProfit
    ),

    expenses: buildLine(
      actual.expenses,
      budget.expenses
    ),

    netIncome: buildLine(
      actual.netIncome,
      budget.netIncome
    )
  };
}

function buildLine(actualValue, budgetValue) {
  const actual = safeNumber(actualValue);
  const budget = safeNumber(budgetValue);

  return {
    actual,
    budget,
    variance: actual - budget
  };
}

function normaliseActualPL(pl = {}) {
  const revenue = safeNumber(pl.revenue);
  const costOfSales = safeNumber(pl.costOfSales);
  const expenses = safeNumber(pl.expenses);

  /*
   * Prefer values provided by parsePL, but derive them when absent.
   * This keeps the calculations consistent with the existing dashboard.
   */
  const grossProfit = hasNumericValue(pl.grossProfit)
    ? safeNumber(pl.grossProfit)
    : revenue - costOfSales;

  const netIncome = hasNumericValue(pl.netIncome)
    ? safeNumber(pl.netIncome)
    : grossProfit - expenses;

  return {
    revenue,
    costOfSales,
    grossProfit,
    expenses,
    netIncome
  };
}

// ── Budget extraction ──────────────────────────────────────────────────────
function extractBudgetTotals(budget, periodStart, periodEnd) {
  let revenue = 0;
  let costOfSales = 0;
  let expenses = 0;

  const revenueLines = [];
  const costOfSalesLines = [];
  const expenseLines = [];

  const start = startOfDay(periodStart);
  const end = endOfDay(periodEnd);

  for (const line of budget?.BudgetDetail || []) {
    const budgetDate = parseBudgetDate(line.BudgetDate);

    if (!budgetDate) {
      continue;
    }

    if (budgetDate < start || budgetDate > end) {
      continue;
    }

    const accountName = String(
      line.AccountRef?.name || ''
    ).trim();

    const amount = safeNumber(line.Amount);
    const category = classifyBudgetAccount(accountName);

    if (category === 'costOfSales') {
      costOfSales += amount;

      costOfSalesLines.push({
        account: accountName,
        date: line.BudgetDate,
        amount
      });

      continue;
    }

    if (category === 'revenue') {
      revenue += amount;

      revenueLines.push({
        account: accountName,
        date: line.BudgetDate,
        amount
      });

      continue;
    }

    if (category === 'discount') {
      /*
       * QuickBooks may store discounts as negative budget values.
       * Adding the signed amount reduces revenue correctly.
       */
      revenue += amount;

      revenueLines.push({
        account: accountName,
        date: line.BudgetDate,
        amount
      });

      continue;
    }

    expenses += amount;

    expenseLines.push({
      account: accountName,
      date: line.BudgetDate,
      amount
    });
  }

  console.log('BUDGET PERIOD:', {
    budget: budget?.Name,
    start: toIsoDate(periodStart),
    end: toIsoDate(periodEnd),
    totals: {
      revenue,
      costOfSales,
      expenses,
      grossProfit: revenue - costOfSales,
      netIncome: revenue - costOfSales - expenses
    }
  });

  console.log('REVENUE BREAKDOWN:', revenueLines);
  console.log('COS BREAKDOWN:', costOfSalesLines);
  console.log('EXPENSE BREAKDOWN:', expenseLines);

  return {
    revenue,
    costOfSales,
    expenses,
    grossProfit: revenue - costOfSales,
    netIncome: revenue - costOfSales - expenses
  };
}

function classifyBudgetAccount(accountName) {
  const name = String(accountName || '').toLowerCase();

  // Cost of sales, including customer reparations.
  if (
    /cost of sales/i.test(name) ||
    (/delivery/i.test(name) && /goods out/i.test(name)) ||
    /technical consultancy/i.test(name) ||
    /shrinkage/i.test(name) ||
    /stock shrinkage/i.test(name) ||
    /customer reparations/i.test(name)
  ) {
    return 'costOfSales';
  }

  // Revenue.
  if (
    /sales of product income|shipping income|cgl sales/i.test(name)
  ) {
    return 'revenue';
  }

  // Discounts reduce revenue.
  if (/discount/i.test(name)) {
    return 'discount';
  }

  return 'expenses';
}

// ── Budget selection ───────────────────────────────────────────────────────
function selectBudget({
  budgets,
  requestedBudgetId,
  financialYearStart
}) {
  if (requestedBudgetId) {
    return budgets.find(
      budget => String(budget.Id) === requestedBudgetId
    );
  }

  const yearLabel = formatFinancialYearLabel(
    financialYearStart
  );

  const matchingBudget = budgets.find(budget =>
    String(budget.Name || '').includes(yearLabel)
  );

  return matchingBudget || budgets[0];
}

function getBudgetYearLabel(budget) {
  const budgetDates = (budget.BudgetDetail || [])
    .map(line => parseBudgetDate(line.BudgetDate))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!budgetDates.length) {
    return '';
  }

  const financialYearStart = getFinancialYearStart(
    budgetDates[0]
  );

  return formatFinancialYearLabel(financialYearStart);
}

// ── Date helpers ───────────────────────────────────────────────────────────
function getFinancialYearStart(date) {
  const year =
    date.getMonth() >= FY_START_MONTH
      ? date.getFullYear()
      : date.getFullYear() - 1;

  return new Date(year, FY_START_MONTH, 1);
}

function buildFinancialYearMonthRanges(
  financialYearStart,
  currentDate
) {
  const ranges = [];

  let cursor = new Date(
    financialYearStart.getFullYear(),
    financialYearStart.getMonth(),
    1
  );

  const currentMonthStart = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth(),
    1
  );

  while (cursor <= currentMonthStart) {
    const monthStart = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      1
    );

    const normalMonthEnd = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      0
    );

    const monthEnd =
      cursor.getFullYear() === currentDate.getFullYear() &&
      cursor.getMonth() === currentDate.getMonth()
        ? currentDate
        : normalMonthEnd;

    ranges.push({
      start: monthStart,
      end: monthEnd
    });

    cursor = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      1
    );
  }

  return ranges;
}

function parseBudgetDate(value) {
  if (!value) {
    return null;
  }

  const parts = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})/
  );

  if (parts) {
    const date = new Date(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3])
    );

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function formatFinancialYearLabel(financialYearStart) {
  const startYear = financialYearStart.getFullYear();
  const endYear = String(startYear + 1).slice(-2);

  return `${startYear}-${endYear}`;
}

function formatMonthKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0')
  ].join('-');
}

function formatMonthLabel(date) {
  return date.toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric'
  });
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  );
}

function endOfDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
}

// ── General helpers ────────────────────────────────────────────────────────
function safeNumber(value) {
  const number = Number.parseFloat(value);

  return Number.isFinite(number) ? number : 0;
}

function hasNumericValue(value) {
  if (value === null || value === undefined || value === '') {
    return false;
  }

  return Number.isFinite(Number.parseFloat(value));
}

// ── Error handler ──────────────────────────────────────────────────────────
function handleError(res, err) {
  console.error(err);

  res.status(err.status || 500).json({
    error: err.message || 'Unexpected server error'
  });
}
