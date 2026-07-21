/**
 * routes/budget.js
 * QBO Budget vs Actual — YTD and monthly
 * Financial year: 1 April to 31 March
 */

import { Router } from 'express';
import { qboQuery, qboReport } from '../lib/qbo.js';
import { parsePL } from '../lib/parsers.js';

export const budgetRouter = Router();

const FY_START_MONTH = 3; // April, zero indexed

// ── List budgets ───────────────────────────────────────────────────────────
budgetRouter.get('/list', async (req, res) => {
  try {
    const data = await qboQuery(
      req.qbo,
      'SELECT * FROM Budget MAXRESULTS 20'
    );

    const now = new Date();
    const currentFinancialYearStart = getFinancialYearStart(now);
    const currentFinancialYearLabel = formatFinancialYearLabel(
      currentFinancialYearStart
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
      }))
      .sort((a, b) => {
        const aCurrent =
          a.year === currentFinancialYearLabel ||
          String(a.name || '').includes(currentFinancialYearLabel);

        const bCurrent =
          b.year === currentFinancialYearLabel ||
          String(b.name || '').includes(currentFinancialYearLabel);

        return Number(bCurrent) - Number(aCurrent);
      });

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
    const ytdEnd = now;

    const budgetQueryResult = await qboQuery(
      req.qbo,
      'SELECT * FROM Budget MAXRESULTS 20'
    );

    const validBudgets = (
      budgetQueryResult.QueryResponse?.Budget || []
    ).filter(
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
        error: 'No suitable budget was found for the current financial year'
      });
    }

    console.log('USING BUDGET:', {
      id: budget.Id,
      name: budget.Name
    });

    const ytdActualRaw = await qboReport(req.qbo, 'ProfitAndLoss', {
      start_date: toIsoDate(financialYearStart),
      end_date: toIsoDate(ytdEnd),
      accounting_method: 'Accrual'
    });

    const ytdActual = normaliseActualPL(parsePL(ytdActualRaw));

    const ytdBudget = extractBudgetTotals(
      budget,
      financialYearStart,
      ytdEnd
    );

    const bva = buildBva(ytdActual, ytdBudget);
    const months = [];

    for (const range of buildFinancialYearMonthRanges(
      financialYearStart,
      now
    )) {
      const monthActualRaw = await qboReport(
        req.qbo,
        'ProfitAndLoss',
        {
          start_date: toIsoDate(range.start),
          end_date: toIsoDate(range.end),
          accounting_method: 'Accrual'
        }
      );

      const monthActual = normaliseActualPL(
        parsePL(monthActualRaw)
      );

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
      endDate: toIsoDate(ytdEnd),
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

  return {
    revenue,
    costOfSales,

    grossProfit: hasNumericValue(pl.grossProfit)
      ? safeNumber(pl.grossProfit)
      : revenue - costOfSales,

    expenses,

    netIncome: hasNumericValue(pl.netIncome)
      ? safeNumber(pl.netIncome)
      : revenue - costOfSales - expenses
  };
}

// ── Budget extraction ──────────────────────────────────────────────────────
function extractBudgetTotals(budget, periodStart, periodEnd) {
  let revenue = 0;
  let costOfSales = 0;
  let expenses = 0;

  const start = startOfDay(periodStart);
  const end = endOfDay(periodEnd);

  for (const line of budget?.BudgetDetail || []) {
    const budgetDate = parseBudgetDate(line.BudgetDate);

    if (!budgetDate || budgetDate < start || budgetDate > end) {
      continue;
    }

    const accountName = String(
      line.AccountRef?.name || ''
    ).trim();

    const amount = safeNumber(line.Amount);
    const category = classifyBudgetAccount(accountName);

    if (category === 'costOfSales') {
      costOfSales += amount;
    } else if (category === 'revenue') {
      revenue += amount;
    } else if (category === 'discount') {
      revenue += amount;
    } else {
      expenses += amount;
    }
  }

  const totals = {
    revenue,
    costOfSales,
    expenses,
    grossProfit: revenue - costOfSales,
    netIncome: revenue - costOfSales - expenses
  };

  console.log('BUDGET PERIOD:', {
    budget: budget?.Name,
    start: toIsoDate(periodStart),
    end: toIsoDate(periodEnd),
    totals
  });

  return totals;
}

function classifyBudgetAccount(accountName) {
  const name = String(accountName || '').toLowerCase();

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

  if (
    /sales of product income|shipping income|cgl sales/i.test(name)
  ) {
    return 'revenue';
  }

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
  const financialYearEnd = new Date(
    financialYearStart.getFullYear() + 1,
    FY_START_MONTH,
    0
  );

  const overlapsFinancialYear = budget =>
    (budget.BudgetDetail || []).some(line => {
      const date = parseBudgetDate(line.BudgetDate);

      return (
        date &&
        date >= startOfDay(financialYearStart) &&
        date <= endOfDay(financialYearEnd)
      );
    });

  if (requestedBudgetId) {
    const requestedBudget = budgets.find(
      budget => String(budget.Id) === requestedBudgetId
    );

    if (
      requestedBudget &&
      overlapsFinancialYear(requestedBudget)
    ) {
      return requestedBudget;
    }
  }

  const yearLabel = formatFinancialYearLabel(
    financialYearStart
  );

  const nameMatch = budgets.find(
    budget =>
      String(budget.Name || '').includes(yearLabel) &&
      overlapsFinancialYear(budget)
  );

  if (nameMatch) {
    return nameMatch;
  }

  return budgets.find(overlapsFinancialYear) || null;
}

function getBudgetYearLabel(budget) {
  const budgetDates = (budget.BudgetDetail || [])
    .map(line => parseBudgetDate(line.BudgetDate))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!budgetDates.length) {
    return '';
  }

  return formatFinancialYearLabel(
    getFinancialYearStart(budgetDates[0])
  );
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

  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

function formatMonthKey(date) {
  return `${date.getFullYear()}-${String(
    date.getMonth() + 1
  ).padStart(2, '0')}`;
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
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return false;
  }

  return Number.isFinite(Number.parseFloat(value));
}

function handleError(res, err) {
  console.error(err);

  res.status(err.status || 500).json({
    error: err.message || 'Unexpected server error'
  });
}
