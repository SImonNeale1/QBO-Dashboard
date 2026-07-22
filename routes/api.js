import { Router } from 'express';
import { qboReport, qboQuery } from '../lib/qbo.js';
import {
  parsePL,
  parseBalanceSheet,
  parseCashFlow
} from '../lib/parsers.js';

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
 * Profit & Loss
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
 * Balance Sheet
 *
 * Normal:
 *   /api/balance-sheet
 *
 * Raw QuickBooks JSON:
 *   /api/balance-sheet?raw=1
 */
apiRouter.get('/balance-sheet', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const raw = await qboReport(req.qbo, 'BalanceSheet', {
      date: req.query.date || today(),
      accounting_method: 'Accrual'
    });

    if (req.query.raw === '1') {
      return res.json(raw);
    }

    return res.json(parseBalanceSheet(raw));
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Cash Flow
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
 * Outstanding Invoices
 */
apiRouter.get('/invoices/outstanding', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const invoiceRecords =
      await qboQueryAllSalesRecords(
        req.qbo,
        'Invoice'
      );

    const invoices = invoiceRecords
      .map(invoice => ({
        id: invoice.Id,
        number: invoice.DocNumber,
        customer: invoice.CustomerRef?.name || 'Unknown',
        balance: safeNum(invoice.Balance),
        total: safeNum(invoice.TotalAmt),
        dueDate: invoice.DueDate,
        daysOverdue: daysOverdue(invoice.DueDate)
      }))
      .filter(invoice => invoice.balance > 0);

    const overdueInvoices = invoices
      .filter(invoice => invoice.daysOverdue > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({
      invoices: overdueInvoices,

      totalOutstanding: invoices.reduce(
        (sum, invoice) => sum + invoice.balance,
        0
      ),

      count: invoices.length,
      overdueCount: overdueInvoices.length,

      overdueTotal: overdueInvoices.reduce(
        (sum, invoice) => sum + invoice.balance,
        0
      )
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Top Customers YTD — Total Sales Revenue
 */
apiRouter.get('/customers/top', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const startDate =
      req.query.start || currentYearStart();

    const endDate =
      req.query.end || today();

    /*
     * CustomerSales returns sales revenue by customer,
     * rather than profit/net income after customer costs.
     */
    const raw = await qboReport(
      req.qbo,
      'CustomerSales',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual',
        summarize_column_by: 'Total'
      }
    );

    const customerTotals = new Map();

    function addCustomer(name, revenue) {
      const cleanName = String(name || '').trim();
      const amount = safeNum(revenue);

      if (!cleanName) return;
      if (amount <= 0) return;
      if (isReportTotalRow(cleanName)) return;

      const existing =
        customerTotals.get(cleanName) || 0;

      customerTotals.set(
        cleanName,
        existing + amount
      );
    }

    function getCustomerNameFromHeader(row) {
      const headerColumns =
        row.Header?.ColData || [];

      for (const column of headerColumns) {
        const value =
          String(column?.value || '').trim();

        if (
          value &&
          !isNumericValue(value) &&
          !isReportTotalRow(value)
        ) {
          return value;
        }
      }

      return '';
    }

    function getTotalFromSummary(row) {
      const summaryColumns =
        row.Summary?.ColData || [];

      for (
        let index = summaryColumns.length - 1;
        index >= 0;
        index -= 1
      ) {
        const value =
          summaryColumns[index]?.value;

        if (isNumericValue(value)) {
          return safeNum(value);
        }
      }

      return 0;
    }

    function walkReportRows(rows = []) {
      for (const row of rows) {
        /*
         * QuickBooks may return each customer as a grouped
         * section where:
         *
         * Header  = customer name
         * Summary = total customer sales
         */
        const groupedCustomerName =
          getCustomerNameFromHeader(row);

        const groupedCustomerTotal =
          getTotalFromSummary(row);

        if (
          groupedCustomerName &&
          groupedCustomerTotal > 0
        ) {
          addCustomer(
            groupedCustomerName,
            groupedCustomerTotal
          );

          /*
           * The summary already contains the customer's total.
           * Do not also include its child rows.
           */
          continue;
        }

        /*
         * Fallback for reports returned as flat Data rows.
         */
        const columns =
          Array.isArray(row.ColData)
            ? row.ColData
            : [];

        const isDataRow =
          row.type === 'Data' ||
          (!row.type && columns.length > 0);

        if (isDataRow && columns.length >= 2) {
          const customerName =
            String(columns[0]?.value || '').trim();

          const revenue =
            getLastNumericColumn(columns);

          addCustomer(
            customerName,
            revenue
          );
        }

        if (Array.isArray(row.Rows?.Row)) {
          walkReportRows(row.Rows.Row);
        }
      }
    }

    walkReportRows(raw.Rows?.Row || []);

    const customers = Array
      .from(customerTotals.entries())
      .map(([name, revenue]) => ({
        name,
        revenue
      }))
      .filter(customer => customer.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const topCustomers =
      customers.slice(0, 10);

    const topTotal =
      topCustomers.reduce(
        (sum, customer) =>
          sum + customer.revenue,
        0
      );

    const plRaw = await qboReport(
      req.qbo,
      'ProfitAndLoss',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual'
      }
    );

    const pl = parsePL(plRaw);

    const totalRevenue =
      safeNum(pl.revenue);

    res.json({
      customers: topCustomers.map(customer => ({
        ...customer,

        pct:
          totalRevenue > 0
            ? customer.revenue / totalRevenue
            : 0
      })),

      totalRevenue,
      topTotal,

      otherRevenue: Math.max(
        0,
        totalRevenue - topTotal
      ),

      startDate,
      endDate
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Revenue vs Expenses - monthly
 */
apiRouter.get('/expenses', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const startDate =
      req.query.start || currentYearStart();

    const endDate =
      req.query.end || today();

    const raw = await qboReport(
      req.qbo,
      'ProfitAndLoss',
      {
        start_date: startDate,
        end_date: endDate,
        accounting_method: 'Accrual',
        summarize_column_by: 'Month'
      }
    );

    const reportColumns =
      Array.isArray(raw?.Columns?.Column)
        ? raw.Columns.Column
        : [];

    /*
     * QuickBooks monthly P&L reports normally return:
     *
     * Column 0 = account or section name
     * Column 1 onwards = individual months
     */
    const monthColumns = reportColumns
      .map((column, index) => {
        if (index === 0) {
          return null;
        }

        const metadata =
          Array.isArray(column?.MetaData)
            ? column.MetaData
            : [];

        const columnKey = metadata.find(
          item => item?.Name === 'ColKey'
        )?.Value;

        const title = String(
          column?.ColTitle ||
          columnKey ||
          ''
        ).trim();

        return {
          index,
          title,
          key: normaliseMonthKey(
            columnKey || title
          )
        };
      })
      .filter(
        column =>
          column &&
          column.title
      );

    function normaliseLabel(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/\s+/g, ' ');
    }

    function normaliseMonthKey(value) {
      const text =
        String(value || '').trim();

      const directMatch = text.match(
        /^(\d{4})[-/](\d{1,2})/
      );

      if (directMatch) {
        return (
          `${directMatch[1]}-` +
          String(directMatch[2]).padStart(
            2,
            '0'
          )
        );
      }

      const parsedDate =
        new Date(text);

      if (
        Number.isNaN(
          parsedDate.getTime()
        )
      ) {
        return '';
      }

      return (
        `${parsedDate.getFullYear()}-` +
        String(
          parsedDate.getMonth() + 1
        ).padStart(2, '0')
      );
    }

    function sectionLabels(row) {
      return [
        row?.Header?.ColData?.[0]?.value,
        row?.ColData?.[0]?.value,
        row?.Summary?.ColData?.[0]?.value
      ]
        .map(normaliseLabel)
        .filter(Boolean);
    }

    function findSection(
      rows,
      wantedLabels
    ) {
      const wanted =
        wantedLabels.map(
          normaliseLabel
        );

      for (const row of rows || []) {
        const labels =
          sectionLabels(row);

        if (
          labels.some(label =>
            wanted.includes(label)
          )
        ) {
          return row;
        }

        const nested =
          findSection(
            row?.Rows?.Row || [],
            wantedLabels
          );

        if (nested) {
          return nested;
        }
      }

      return null;
    }

    function valuesFromColumns(
      columns = []
    ) {
      return monthColumns.map(
        ({ index }) =>
          safeNum(
            columns[index]?.value
          )
      );
    }

    function rowValues(row) {
      if (!row) {
        return monthColumns.map(
          () => 0
        );
      }

      const summaryColumns =
        Array.isArray(
          row?.Summary?.ColData
        )
          ? row.Summary.ColData
          : [];

      if (summaryColumns.length) {
        return valuesFromColumns(
          summaryColumns
        );
      }

      const dataColumns =
        Array.isArray(row?.ColData)
          ? row.ColData
          : [];

      if (dataColumns.length) {
        return valuesFromColumns(
          dataColumns
        );
      }

      return monthColumns.map(
        () => 0
      );
    }

    function addArrays(
      ...arrays
    ) {
      return monthColumns.map(
        (_, index) =>
          arrays.reduce(
            (total, values) =>
              total +
              safeNum(
                values?.[index]
              ),
            0
          )
      );
    }

    const reportRows =
      Array.isArray(raw?.Rows?.Row)
        ? raw.Rows.Row
        : [];

    const revenueRow =
      findSection(
        reportRows,
        [
          'Total Income',
          'Total Revenue',
          'Income',
          'Revenue'
        ]
      );

    const costOfSalesRow =
      findSection(
        reportRows,
        [
          'Total Cost of Sales',
          'Total Cost of Goods Sold',
          'Cost of Sales',
          'Cost of Goods Sold'
        ]
      );

    const operatingExpensesRow =
      findSection(
        reportRows,
        [
          'Total Expenses',
          'Expenses',
          'Operating Expenses'
        ]
      );

    const otherExpensesRow =
      findSection(
        reportRows,
        [
          'Total Other Expenses',
          'Other Expenses'
        ]
      );

    const revenue =
      rowValues(revenueRow);

    const costOfSales =
      rowValues(costOfSalesRow);

    const operatingExpenses =
      rowValues(
        operatingExpensesRow
      );

    const otherExpenses =
      rowValues(
        otherExpensesRow
      );

    /*
     * Total chart expenses:
     *
     * Cost of Sales
     * + Operating Expenses
     * + Other Expenses
     */
    const expenses =
      addArrays(
        costOfSales,
        operatingExpenses,
        otherExpenses
      );

    const months =
      monthColumns.map(column => {
        const parsedDate =
          new Date(column.title);

        if (
          !Number.isNaN(
            parsedDate.getTime()
          )
        ) {
          return parsedDate
            .toLocaleDateString(
              'en-GB',
              {
                month: 'short',
                year: '2-digit'
              }
            );
        }

        return column.title;
      });

    res.json({
      months,

      monthKeys:
        monthColumns.map(
          column => column.key
        ),

      revenue,
      expenses,
      costOfSales,
      operatingExpenses,

      startDate,
      endDate
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Sales dashboard
 *
 * Classification priority for each invoice line:
 * 1. Invoice class: CGL = Reseller; Advantage Products = Advantage
 * 2. Line class, when the invoice class is blank
 * 3. Stock-item category fallback: RYCOTE Products = Reseller; Advantage = Advantage
 * 4. Everything else = Other
 *
 * Reseller sales are excluded from discount calculations.
 */

/**
 * Monthly sales
 *
 * GET /api/sales/monthly?year=2026
 */
apiRouter.get('/sales/monthly', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const year =
      normaliseSalesYear(
        req.query.year
      );

    const analysis =
      await buildSalesAnalysis(
        req.qbo,
        year
      );

    const debugInvoiceNumber =
      String(req.query.debugInvoice || '').trim();

    const debugInvoice =
      debugInvoiceNumber
        ? await traceInvoiceForSalesClassification(
            req.qbo,
            year,
            debugInvoiceNumber
          )
        : null;

    res.json({
      year,

      startDate:
        `${year}-04-01`,

      endDate:
        `${year + 1}-03-31`,

      months:
        analysis.months,

      ...(debugInvoiceNumber
        ? { debugInvoice }
        : {}),

      classificationRules: {
        basis: 'Invoice class, then line class, then stock-item category fallback',

        reseller: {
          invoiceClass: 'CGL',
          lineClass: 'CGL',
          fallbackCategory: 'RYCOTE Products'
        },

        advantage: {
          invoiceClass: 'Advantage Products',
          lineClass: 'Advantage Products',
          fallbackCategory: 'Advantage'
        }
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Overall discount summary
 *
 * GET /api/sales/discount-summary?year=2026
 */
apiRouter.get(
  '/sales/discount-summary',
  async (req, res) => {
    try {
      if (!ensureQBO(req, res)) {
        return;
      }

      const year =
        normaliseSalesYear(
          req.query.year
        );

      const analysis =
        await buildSalesAnalysis(
          req.qbo,
          year
        );

      const advantage =
        makeSalesDiscountSummary(
          analysis
            .totals
            .advantageGross,

          analysis
            .totals
            .advantageDiscount
        );

      const other =
        makeSalesDiscountSummary(
          analysis
            .totals
            .otherGross +
            analysis
              .totals
              .resellerGross,

          analysis
            .totals
            .otherDiscount +
            analysis
              .totals
              .resellerDiscount
        );

      const combined =
        makeSalesDiscountSummary(
          analysis
            .totals
            .advantageGross +
            analysis
              .totals
              .otherGross +
            analysis
              .totals
              .resellerGross,

          analysis
            .totals
            .advantageDiscount +
            analysis
              .totals
              .otherDiscount +
            analysis
              .totals
              .resellerDiscount
        );

      res.json({
        year,
        advantage,
        other,
        combined,

        resellerIncludedIn: 'other'
      });
    } catch (err) {
      handleError(res, err);
    }
  }
);

/**
 * Temporary salesperson response.
 *
 * GET /api/sales/salesperson?year=2026
 */
apiRouter.get(
  '/sales/salesperson',
  async (req, res) => {
    try {
      if (!ensureQBO(req, res)) {
        return;
      }

      res.json({
        year:
          normaliseSalesYear(
            req.query.year
          ),

        salespeople: [],

        status:
          'Salesperson mapping not configured'
      });
    } catch (err) {
      handleError(res, err);
    }
  }
);

/**
 * Category classification diagnostics.
 *
 * GET /api/sales/category-debug?year=2026
 * GET /api/sales/category-debug?year=2026&invoice=INV-1234
 *
 * This deliberately omits customer details. It returns the raw ItemRef from
 * each invoice sales line, the referenced Item, every available parent Item,
 * and the class-first classification decision with category fallback.
 */
apiRouter.get('/sales/category-debug', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const year = normaliseSalesYear(req.query.year);
    const startDate = `${year}-04-01`;
    const endDate = `${year + 1}-03-31`;
    const invoiceFilter = String(req.query.invoice || '').trim();
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 2000))
      : 500;

    const [invoices, items] = await Promise.all([
      qboQueryAllSalesRecords(
        req.qbo,
        'Invoice',
        `WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`
      ),
      qboQueryAllItems(req.qbo)
    ]);

    const itemIndex = new Map();
    for (const item of items) {
      itemIndex.set(String(item.Id), item);
    }

    const selectedInvoices = invoiceFilter
      ? invoices.filter(invoice =>
          String(invoice.Id || '') === invoiceFilter ||
          String(invoice.DocNumber || '').toLowerCase() ===
            invoiceFilter.toLowerCase()
        )
      : invoices;

    const lines = [];

    for (const invoice of selectedInvoices) {
      const invoiceLines =
        flattenInvoiceSalesLines(
          invoice.Line
        );

      for (const line of invoiceLines) {

        const itemRef = line.SalesItemLineDetail?.ItemRef || null;
        const itemId = String(itemRef?.value || '');
        const rawItem = itemId ? itemIndex.get(itemId) || null : null;
        const parentChain = buildItemParentChain(rawItem, itemIndex);
        const classification = classifySalesLine(invoice, line, itemIndex);

        lines.push({
          invoice: {
            id: invoice.Id || null,
            docNumber: invoice.DocNumber || null,
            txnDate: invoice.TxnDate || null,
            classRef: invoice.ClassRef || null
          },
          line: {
            id: line.Id || null,
            amount: safeNum(line.Amount),
            description: line.Description || null,
            itemRef,
            classRef:
              line.SalesItemLineDetail?.ClassRef ||
              line.ClassRef ||
              null
          },
          resolution: {
            itemFound: Boolean(rawItem),
            classification,
            detectedCategoryPath: getItemCategoryPath(rawItem, itemIndex),
            resellerMatch: itemHasCategory(
              itemRef,
              itemIndex,
              'RYCOTE Products'
            ),
            advantageMatch: itemHasCategory(
              itemRef,
              itemIndex,
              'Advantage'
            )
          },
          rawItem,
          rawParentChain: parentChain
        });

        if (!invoiceFilter && lines.length >= limit) break;
      }

      if (!invoiceFilter && lines.length >= limit) break;
    }

    const counts = lines.reduce(
      (result, entry) => {
        result.total += 1;
        result[entry.resolution.classification] += 1;
        if (!entry.resolution.itemFound) result.unresolvedItems += 1;
        return result;
      },
      {
        total: 0,
        reseller: 0,
        advantage: 0,
        other: 0,
        unresolvedItems: 0
      }
    );

    res.json({
      generatedAt: new Date().toISOString(),
      instructions: {
        endpoint: '/api/sales/category-debug',
        selectedFinancialYear: year,
        dateRange: { startDate, endDate },
        invoiceFilter: invoiceFilter || null,
        note:
          'Upload this JSON result. It excludes customer details but includes raw QuickBooks Item and parent-category records.'
      },
      sourceCounts: {
        invoicesInFinancialYear: invoices.length,
        selectedInvoices: selectedInvoices.length,
        itemsLoaded: items.length
      },
      diagnosticCounts: counts,
      truncated: !invoiceFilter && lines.length >= limit,
      limit: invoiceFilter ? null : limit,
      lines
    });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * Full downloadable sales-classification audit.
 *
 * JSON:
 *   GET /api/sales/audit?year=2026
 * CSV for Excel:
 *   GET /api/sales/audit.csv?year=2026
 *
 * Optional single-invoice filter:
 *   ?invoice=2937
 */
apiRouter.get('/sales/audit', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const audit = await buildFullSalesAudit(
      req.qbo,
      normaliseSalesYear(req.query.year),
      String(req.query.invoice || '').trim()
    );

    const filename = audit.invoiceFilter
      ? `sales-audit-${audit.year}-invoice-${safeFilename(audit.invoiceFilter)}.json`
      : `sales-audit-${audit.year}.json`;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );
    res.send(JSON.stringify(audit, null, 2));
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.get('/sales/audit.csv', async (req, res) => {
  try {
    if (!ensureQBO(req, res)) return;

    const audit = await buildFullSalesAudit(
      req.qbo,
      normaliseSalesYear(req.query.year),
      String(req.query.invoice || '').trim()
    );

    const columns = [
      'invoiceNumber',
      'invoiceId',
      'invoiceDate',
      'customer',
      'invoiceClass',
      'lineId',
      'lineClass',
      'itemId',
      'itemName',
      'description',
      'grossAmount',
      'itemClass',
      'itemCategory',
      'categoryPath',
      'classification',
      'classificationReason',
      'insideGroup',
      'parentGroup',
      'itemFound'
    ];

    const csvRows = [
      columns.join(','),
      ...audit.lines.map(row =>
        columns.map(column => csvValue(row[column])).join(',')
      )
    ];

    const filename = audit.invoiceFilter
      ? `sales-audit-${audit.year}-invoice-${safeFilename(audit.invoiceFilter)}.csv`
      : `sales-audit-${audit.year}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    // UTF-8 BOM helps Excel open names and descriptions correctly.
    res.send(`\uFEFF${csvRows.join('\r\n')}`);
  } catch (err) {
    handleError(res, err);
  }
});

async function buildFullSalesAudit(qbo, year, invoiceFilter = '') {
  const startDate = `${year}-04-01`;
  const endDate = `${year + 1}-03-31`;

  const [invoices, items] = await Promise.all([
    qboQueryAllSalesRecords(
      qbo,
      'Invoice',
      `WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`
    ),
    qboQueryAllItems(qbo)
  ]);

  const itemIndex = new Map();
  for (const item of items) {
    itemIndex.set(String(item.Id), item);
  }

  const selectedInvoices = invoiceFilter
    ? invoices.filter(invoice =>
        String(invoice.Id || '') === invoiceFilter ||
        String(invoice.DocNumber || '').toLowerCase() ===
          invoiceFilter.toLowerCase()
      )
    : invoices;

  const lines = [];

  for (const invoice of selectedInvoices) {
    const invoiceClass = getRefName(invoice.ClassRef);
    const customer = getRefName(invoice.CustomerRef);
    const invoiceLines = flattenInvoiceSalesLinesWithContext(invoice.Line);

    for (const entry of invoiceLines) {
      const line = entry.line;
      const detail = line.SalesItemLineDetail || {};
      const itemRef = detail.ItemRef || null;
      const itemId = String(itemRef?.value || '');
      const item = itemId ? itemIndex.get(itemId) || null : null;
      const lineClass = getRefName(detail.ClassRef || line.ClassRef);
      const itemClass = getRefName(item?.ClassRef);
      const categoryPath = getItemCategoryPath(item, itemIndex);
      const classification = classifySalesLine(invoice, line, itemIndex);
      const classificationReason = getSalesClassificationReason(
        invoice,
        line,
        itemIndex
      );

      lines.push({
        invoiceNumber: invoice.DocNumber || '',
        invoiceId: invoice.Id || '',
        invoiceDate: invoice.TxnDate || '',
        customer,
        invoiceClass,
        lineId: line.Id || '',
        lineClass,
        itemId,
        itemName:
          getRefName(itemRef) ||
          item?.FullyQualifiedName ||
          item?.Name ||
          '',
        description: line.Description || '',
        grossAmount: safeNum(line.Amount),
        itemClass,
        itemCategory: categoryPath[0] || '',
        categoryPath: categoryPath.join(' > '),
        classification,
        classificationReason,
        insideGroup: entry.insideGroup ? 'Yes' : 'No',
        parentGroup: entry.parentGroup || '',
        itemFound: item ? 'Yes' : 'No'
      });
    }
  }

  const summary = lines.reduce(
    (result, line) => {
      result.salesLines += 1;
      result.grossValue += line.grossAmount;
      result[line.classification].count += 1;
      result[line.classification].grossValue += line.grossAmount;
      if (line.itemFound === 'No') result.unresolvedItems += 1;
      if (line.insideGroup === 'Yes') result.groupedLines += 1;
      return result;
    },
    {
      invoices: selectedInvoices.length,
      salesLines: 0,
      grossValue: 0,
      groupedLines: 0,
      unresolvedItems: 0,
      reseller: { count: 0, grossValue: 0 },
      advantage: { count: 0, grossValue: 0 },
      other: { count: 0, grossValue: 0 }
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    year,
    financialYear: { startDate, endDate },
    invoiceFilter: invoiceFilter || null,
    classificationPriority: [
      'Invoice class CGL = reseller',
      'Invoice class Advantage Products = advantage',
      'Line class CGL = reseller when invoice class is blank',
      'Line class Advantage Products = advantage when invoice class is blank',
      'Stock-item category RYCOTE Products = reseller fallback',
      'Stock-item category Advantage = advantage fallback',
      'Otherwise = other'
    ],
    sourceCounts: {
      invoicesInFinancialYear: invoices.length,
      selectedInvoices: selectedInvoices.length,
      itemsLoaded: items.length
    },
    summary,
    lines
  };
}

function flattenInvoiceSalesLinesWithContext(
  lines = [],
  insideGroup = false,
  parentGroup = ''
) {
  const result = [];

  for (const line of Array.isArray(lines) ? lines : []) {
    if (line?.DetailType === 'SalesItemLineDetail') {
      result.push({ line, insideGroup, parentGroup });
    }

    const nestedLines = line?.GroupLineDetail?.Line;
    if (Array.isArray(nestedLines)) {
      const groupName =
        getRefName(line.GroupLineDetail?.GroupItemRef) ||
        line.Description ||
        line.Id ||
        'QuickBooks group';

      result.push(
        ...flattenInvoiceSalesLinesWithContext(
          nestedLines,
          true,
          groupName
        )
      );
    }
  }

  return result;
}

function getSalesClassificationReason(invoice, line, itemIndex) {
  const detail = line?.SalesItemLineDetail || {};
  const invoiceClass = normaliseClassificationName(
    getRefName(invoice?.ClassRef)
  );
  const lineClass = normaliseClassificationName(
    getRefName(detail.ClassRef || line?.ClassRef)
  );

  if (invoiceClass === normaliseClassificationName('CGL')) {
    return 'Invoice class = CGL';
  }
  if (
    invoiceClass === normaliseClassificationName('Advantage Products')
  ) {
    return 'Invoice class = Advantage Products';
  }
  if (!invoiceClass && lineClass === normaliseClassificationName('CGL')) {
    return 'Line class = CGL';
  }
  if (
    !invoiceClass &&
    lineClass === normaliseClassificationName('Advantage Products')
  ) {
    return 'Line class = Advantage Products';
  }

  const itemRef = detail.ItemRef;
  if (
    itemHasCategory(itemRef, itemIndex, 'RYCOTE Products')
  ) {
    return 'Stock-item category = RYCOTE Products fallback';
  }
  if (itemHasCategory(itemRef, itemIndex, 'Advantage')) {
    return 'Stock-item category = Advantage fallback';
  }

  if (invoiceClass) {
    return `Unmapped invoice class = ${getRefName(invoice?.ClassRef)}`;
  }
  if (lineClass) {
    return `Unmapped line class = ${getRefName(detail.ClassRef || line?.ClassRef)}`;
  }
  return 'No matching class or stock-item category';
}

function getRefName(ref) {
  if (!ref) return '';
  if (typeof ref === 'string') return ref.trim();
  return String(ref.name || ref.Name || '').trim();
}

function csvValue(value) {
  const text = value === null || value === undefined
    ? ''
    : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function safeFilename(value) {
  return String(value || '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'invoice';
}

/**
 * Trace one real QuickBooks invoice through the same item-category
 * classification used by the monthly sales dashboard.
 *
 * Usage:
 *   /api/sales/monthly?year=2026&debugInvoice=2937
 */
async function traceInvoiceForSalesClassification(
  qbo,
  year,
  invoiceNumber
) {
  const startDate = `${year}-04-01`;
  const endDate = `${year + 1}-03-31`;

  const [invoices, items] = await Promise.all([
    qboQueryAllSalesRecords(
      qbo,
      'Invoice',
      `WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`
    ),
    qboQueryAllItems(qbo)
  ]);

  const invoice = invoices.find(record =>
    String(record.DocNumber || '').trim() === invoiceNumber ||
    String(record.Id || '').trim() === invoiceNumber
  );

  if (!invoice) {
    return {
      requested: invoiceNumber,
      found: false,
      dateRange: { startDate, endDate },
      invoicesChecked: invoices.length
    };
  }

  const itemIndex = new Map();
  for (const item of items) {
    itemIndex.set(String(item.Id), item);
  }

  const tracedLines = [];

  function walkLines(lines = [], location = 'invoice.Line') {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineLocation = `${location}[${index}]`;

      if (line?.DetailType === 'SalesItemLineDetail') {
        const itemRef = line.SalesItemLineDetail?.ItemRef || null;
        const itemId = String(itemRef?.value || '');
        const item = itemId ? itemIndex.get(itemId) || null : null;

        tracedLines.push({
          location: lineLocation,
          lineId: line.Id || null,
          amount: safeNum(line.Amount),
          description: line.Description || null,
          itemRef,
          invoiceClassRef: invoice.ClassRef || null,
          lineClassRef:
            line.SalesItemLineDetail?.ClassRef ||
            line.ClassRef ||
            null,
          classification: classifySalesLine(invoice, line, itemIndex),
          resellerMatch: itemHasCategory(
            itemRef,
            itemIndex,
            'RYCOTE Products'
          ),
          advantageMatch: itemHasCategory(
            itemRef,
            itemIndex,
            'Advantage'
          ),
          itemFound: Boolean(item),
          item: item
            ? {
                Id: item.Id,
                Name: item.Name,
                FullyQualifiedName: item.FullyQualifiedName,
                Type: item.Type,
                SubItem: item.SubItem,
                ParentRef: item.ParentRef,
                Active: item.Active
              }
            : null,
          categoryPath: getItemCategoryPath(item, itemIndex),
          parentChain: buildItemParentChain(item, itemIndex).map(entry => ({
            parentRef: entry.parentRef,
            parentItem: entry.parentItem
              ? {
                  Id: entry.parentItem.Id,
                  Name: entry.parentItem.Name,
                  FullyQualifiedName: entry.parentItem.FullyQualifiedName,
                  Type: entry.parentItem.Type,
                  SubItem: entry.parentItem.SubItem,
                  ParentRef: entry.parentItem.ParentRef,
                  Active: entry.parentItem.Active
                }
              : null
          }))
        });
      }

      const nestedLines = line?.GroupLineDetail?.Line;
      if (Array.isArray(nestedLines)) {
        walkLines(nestedLines, `${lineLocation}.GroupLineDetail.Line`);
      }
    }
  }

  walkLines(Array.isArray(invoice.Line) ? invoice.Line : []);

  return {
    requested: invoiceNumber,
    found: true,
    invoice: {
      Id: invoice.Id,
      DocNumber: invoice.DocNumber,
      TxnDate: invoice.TxnDate,
      TotalAmt: invoice.TotalAmt,
      ClassRef: invoice.ClassRef || null
    },
    itemsLoaded: items.length,
    tracedLineCount: tracedLines.length,
    lines: tracedLines
  };
}

/**
 * Return every SalesItemLineDetail, including lines nested inside QBO groups.
 */
function flattenInvoiceSalesLines(lines = []) {
  const result = [];

  for (const line of Array.isArray(lines) ? lines : []) {
    if (line?.DetailType === 'SalesItemLineDetail') {
      result.push(line);
    }

    const nestedLines =
      line?.GroupLineDetail?.Line;

    if (Array.isArray(nestedLines)) {
      result.push(
        ...flattenInvoiceSalesLines(nestedLines)
      );
    }
  }

  return result;
}

/**
 * Build the live sales analysis from QuickBooks invoices and items.
 */
async function buildSalesAnalysis(
  qbo,
  year
) {
  /*
   * The selected year is the financial-year
   * starting year.
   *
   * Example:
   * 2026 = 1 April 2026 to 31 March 2027
   */
  const startDate =
    `${year}-04-01`;

  const endDate =
    `${year + 1}-03-31`;

  const [invoices, items] =
    await Promise.all([
      qboQueryAllSalesRecords(
        qbo,
        'Invoice',
        `WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`
      ),

      /*
       * QuickBooks returns only active list entities unless Active is
       * explicitly filtered. Historical invoices may reference inactive
       * products or categories, so both states are required for reliable
       * category classification.
       */
      qboQueryAllItems(qbo)
    ]);

  const itemIndex =
    new Map();

  for (const item of items) {
    itemIndex.set(
      String(item.Id),
      item
    );
  }

  const currentDate =
    new Date();

  const financialYearStart =
    new Date(
      year,
      3,
      1
    );

  const financialYearEnd =
    new Date(
      year + 1,
      2,
      31
    );

  let monthCount = 12;

  /*
   * For the current financial year,
   * only display months reached so far.
   */
  if (
    currentDate >=
      financialYearStart &&
    currentDate <=
      financialYearEnd
  ) {
    monthCount =
      (
        currentDate.getFullYear() -
        financialYearStart.getFullYear()
      ) * 12 +
      (
        currentDate.getMonth() -
        financialYearStart.getMonth()
      ) +
      1;
  } else if (
    currentDate <
    financialYearStart
  ) {
    monthCount = 0;
  }

  monthCount =
    Math.max(
      0,
      Math.min(
        monthCount,
        12
      )
    );

  const months =
    Array.from(
      {
        length: monthCount
      },

      (
        _,
        financialMonthIndex
      ) => {
        const monthDate =
          new Date(
            year,
            3 +
              financialMonthIndex,
            1
          );

        return {
          month:
            monthDate.getMonth() +
            1,

          year:
            monthDate.getFullYear(),

          label:
            monthDate
              .toLocaleDateString(
                'en-GB',
                {
                  month: 'short'
                }
              ),

          advantageSales: 0,
          resellerSales: 0,
          otherSales: 0,
          totalSales: 0,

          ytdAdvantage: 0,
          ytdReseller: 0,
          ytdOther: 0,
          ytdTotal: 0,

          advDiscountPct: 0,
          otherDiscountPct: 0,

          _advantageGross: 0,
          _advantageDiscount: 0,
          _resellerGross: 0,
          _resellerDiscount: 0,
          _otherGross: 0,
          _otherDiscount: 0
        };
      }
    );

  for (
    const invoice of invoices
  ) {
    const invoiceDate =
      parseQuickBooksDate(
        invoice.TxnDate
      );

    if (!invoiceDate) {
      continue;
    }

    if (
      invoiceDate <
        financialYearStart ||
      invoiceDate >
        financialYearEnd
    ) {
      continue;
    }

    /*
     * April = 0
     * May = 1
     * ...
     * March = 11
     */
    const financialMonthIndex =
      (
        invoiceDate.getFullYear() -
        year
      ) * 12 +
      invoiceDate.getMonth() -
      3;

    const month =
      months[
        financialMonthIndex
      ];

    if (!month) {
      continue;
    }

    const salesLines =
      flattenInvoiceSalesLines(
        invoice.Line
      )
        .map(line => {
          const grossAmount =
            Math.max(
              0,
              safeNum(
                line.Amount
              )
            );

          return {
            grossAmount,

            productGroup:
              classifySalesLine(
                invoice,
                line,
                itemIndex
              )
          };
        })
        .filter(
          line =>
            line.grossAmount >
            0
        );

    const invoiceGross =
      salesLines.reduce(
        (
          total,
          line
        ) =>
          total +
          line.grossAmount,
        0
      );

    if (
      invoiceGross <= 0
    ) {
      continue;
    }

    const invoiceDiscount =
      Math.min(
        getQuickBooksInvoiceDiscount(
          invoice
        ),
        invoiceGross
      );

    for (
      const line of
        salesLines
    ) {
      const allocatedDiscount =
        invoiceDiscount *
        (
          line.grossAmount /
          invoiceGross
        );

      const netSales =
        Math.max(
          0,
          line.grossAmount -
            allocatedDiscount
        );

      /*
       * Reseller remains a separate category in the
       * monthly sales table, but is included within
       * Other products in the discount summary.
       */
      if (
        line.productGroup ===
        'reseller'
      ) {
        month.resellerSales +=
          netSales;

        month._resellerGross +=
          line.grossAmount;

        month._resellerDiscount +=
          allocatedDiscount;

        continue;
      }

      if (
        line.productGroup ===
        'advantage'
      ) {
        month.advantageSales +=
          netSales;

        month._advantageGross +=
          line.grossAmount;

        month._advantageDiscount +=
          allocatedDiscount;
      } else {
        month.otherSales +=
          netSales;

        month._otherGross +=
          line.grossAmount;

        month._otherDiscount +=
          allocatedDiscount;
      }
    }
  }

  let ytdAdvantage = 0;
  let ytdReseller = 0;
  let ytdOther = 0;

  const totals = {
    advantageGross: 0,
    advantageDiscount: 0,
    resellerGross: 0,
    resellerDiscount: 0,
    otherGross: 0,
    otherDiscount: 0
  };

  for (
    const month of months
  ) {
    month.totalSales =
      month.advantageSales +
      month.resellerSales +
      month.otherSales;

    ytdAdvantage +=
      month.advantageSales;

    ytdReseller +=
      month.resellerSales;

    ytdOther +=
      month.otherSales;

    month.ytdAdvantage =
      ytdAdvantage;

    month.ytdReseller =
      ytdReseller;

    month.ytdOther =
      ytdOther;

    month.ytdTotal =
      ytdAdvantage +
      ytdReseller +
      ytdOther;

    month.advDiscountPct =
      calculateSalesPercentage(
        month._advantageDiscount,
        month._advantageGross
      );

    month.otherDiscountPct =
      calculateSalesPercentage(
        month._otherDiscount,
        month._otherGross
      );

    totals.advantageGross +=
      month._advantageGross;

    totals.advantageDiscount +=
      month._advantageDiscount;

    totals.resellerGross +=
      month._resellerGross;

    totals.resellerDiscount +=
      month._resellerDiscount;

    totals.otherGross +=
      month._otherGross;

    totals.otherDiscount +=
      month._otherDiscount;

    delete month
      ._advantageGross;

    delete month
      ._advantageDiscount;

    delete month
      ._resellerGross;

    delete month
      ._resellerDiscount;

    delete month
      ._otherGross;

    delete month
      ._otherDiscount;
  }

  return {
    months,
    totals,
    startDate,
    endDate
  };
}

/**
 * Read every available QuickBooks page.
 */
async function qboQueryAllSalesRecords(
  qbo,
  entityName,
  whereClause = ''
) {
  const results = [];

  const pageSize = 1000;
  let startPosition = 1;

  while (true) {
    const query = [
      `SELECT * FROM ${entityName}`,
      whereClause,
      `STARTPOSITION ${startPosition}`,
      `MAXRESULTS ${pageSize}`
    ]
      .filter(Boolean)
      .join(' ');

    const response =
      await qboQuery(
        qbo,
        query
      );

    const page =
      response.QueryResponse?.[
        entityName
      ] || [];

    results.push(...page);

    if (
      page.length <
      pageSize
    ) {
      break;
    }

    startPosition +=
      pageSize;
  }

  return results;
}

/**
 * Load active and inactive QuickBooks Items explicitly.
 *
 * QBO list queries can omit inactive records unless Active is filtered. Two
 * separate queries are used because this is accepted more consistently than
 * an IN expression across QBO query implementations.
 */
async function qboQueryAllItems(qbo) {
  const [activeItems, inactiveItems] = await Promise.all([
    qboQueryAllSalesRecords(qbo, 'Item', 'WHERE Active = true'),
    qboQueryAllSalesRecords(qbo, 'Item', 'WHERE Active = false')
  ]);

  const uniqueItems = new Map();
  for (const item of [...activeItems, ...inactiveItems]) {
    uniqueItems.set(String(item.Id), item);
  }

  return Array.from(uniqueItems.values());
}

/**
 * Return every available parent Item/category record for diagnostics.
 */
function buildItemParentChain(item, itemIndex) {
  const chain = [];
  const visited = new Set();
  let current = item;

  while (current?.ParentRef) {
    const parentId = String(
      current.ParentRef?.value || current.ParentRef || ''
    );

    if (!parentId || visited.has(parentId)) break;
    visited.add(parentId);

    const parentItem = itemIndex.get(parentId) || null;
    chain.push({
      parentRef: current.ParentRef,
      parentItem
    });

    if (!parentItem) break;
    current = parentItem;
  }

  return chain;
}

/**
 * Build the category path available from an Item and its parent hierarchy.
 */
function getItemCategoryPath(item, itemIndex) {
  if (!item) return [];

  const path = [];
  const visited = new Set();
  let current = item;

  while (current?.ParentRef) {
    const parentId = String(
      current.ParentRef?.value || current.ParentRef || ''
    );
    const parentName = String(current.ParentRef?.name || '').trim();

    if (!parentId || visited.has(parentId)) break;
    visited.add(parentId);

    const parentItem = itemIndex.get(parentId) || null;
    const resolvedName = String(
      parentItem?.Name || parentItem?.FullyQualifiedName || parentName
    ).trim();

    if (resolvedName) path.unshift(resolvedName);
    if (!parentItem) break;
    current = parentItem;
  }

  return path;
}

/**
 * Normalise QuickBooks item and category names.
 */
function normaliseClassificationName(
  value
) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determine whether an item belongs to a specified QuickBooks item category.
 *
 * QuickBooks represents categories as Item records and products point to their
 * category through ParentRef. This walks the full parent chain so products in
 * nested subcategories are classified by their top-level category as well.
 */
function itemHasCategory(
  itemRef,
  itemIndex,
  requiredCategory
) {
  const wanted =
    normaliseClassificationName(
      requiredCategory
    );

  const itemId =
    typeof itemRef === 'object'
      ? itemRef?.value
      : itemRef;

  const itemRefName =
    typeof itemRef === 'object'
      ? itemRef?.name
      : '';

  const pathContainsCategory = value => {
    const raw = String(value || '').trim();

    if (!raw) {
      return false;
    }

    const parts = raw
      .split(':')
      .map(normaliseClassificationName)
      .filter(Boolean);

    /*
     * A fully qualified product name is normally:
     * Category:Subcategory:Product.
     * Only the path before the final product name is treated as category data.
     */
    if (parts.length > 1) {
      return parts
        .slice(0, -1)
        .includes(wanted);
    }

    return false;
  };

  /*
   * Some QBO responses return the fully qualified item path directly on the
   * invoice line even when the category Item record is absent from the query.
   */
  if (pathContainsCategory(itemRefName)) {
    return true;
  }

  let item =
    itemIndex.get(
      String(itemId || '')
    );

  if (!item) {
    return false;
  }

  if (
    pathContainsCategory(
      item.FullyQualifiedName
    )
  ) {
    return true;
  }

  const visited = new Set();

  while (item) {
    const currentId =
      String(item.Id || '');

    if (
      !currentId ||
      visited.has(currentId)
    ) {
      break;
    }

    visited.add(currentId);

    const parentRef = item.ParentRef;

    /*
     * ParentRef.name is often available even when the parent category itself
     * was not returned by the Item query (for example, inactive categories).
     */
    if (
      normaliseClassificationName(
        parentRef?.name
      ) === wanted
    ) {
      return true;
    }

    const parentId =
      parentRef?.value ||
      parentRef;

    if (!parentId) {
      break;
    }

    const parentItem =
      itemIndex.get(
        String(parentId)
      );

    if (!parentItem) {
      break;
    }

    if (
      normaliseClassificationName(
        parentItem.Name
      ) === wanted ||
      normaliseClassificationName(
        parentItem.FullyQualifiedName
      ) === wanted ||
      pathContainsCategory(
        parentItem.FullyQualifiedName
      )
    ) {
      return true;
    }

    item = parentItem;
  }

  return false;
}

/**
 * Classify one invoice sales line.
 *
 * Business rule priority:
 * 1. Class recorded on the invoice or invoice line.
 * 2. Stock-item category only as a fallback for older/incomplete records.
 */
function classifySalesLine(
  invoice,
  line,
  itemIndex
) {
  const detail =
    line?.SalesItemLineDetail || {};

  const itemRef =
    detail.ItemRef;

  const invoiceClassName =
    normaliseClassificationName(
      invoice?.ClassRef?.name ||
      invoice?.ClassRef?.Name ||
      ''
    );

  const lineClassName =
    normaliseClassificationName(
      detail.ClassRef?.name ||
      detail.ClassRef?.Name ||
      line?.ClassRef?.name ||
      line?.ClassRef?.Name ||
      ''
    );

  // Prefer the class explicitly applied to the invoice.
  const className =
    invoiceClassName || lineClassName;

  if (
    className ===
      normaliseClassificationName('CGL')
  ) {
    return 'reseller';
  }

  if (
    className ===
      normaliseClassificationName(
        'Advantage Products'
      )
  ) {
    return 'advantage';
  }

  // Fallback for historical transactions where QBO does not return ClassRef.
  if (
    itemHasCategory(
      itemRef,
      itemIndex,
      'RYCOTE Products'
    )
  ) {
    return 'reseller';
  }

  if (
    itemHasCategory(
      itemRef,
      itemIndex,
      'Advantage'
    )
  ) {
    return 'advantage';
  }

  return 'other';
}


/**
 * Read the discount recorded on the invoice.
 */
function getQuickBooksInvoiceDiscount(
  invoice
) {
  const lines = Array.isArray(
    invoice.Line
  )
    ? invoice.Line
    : [];

  return lines
    .filter(
      line =>
        line.DetailType ===
        'DiscountLineDetail'
    )
    .reduce((total, line) => {
      const amount = Math.abs(
        safeNum(line.Amount)
      );

      if (amount > 0) {
        return total + amount;
      }

      const discountPercent =
        safeNum(
          line
            .DiscountLineDetail
            ?.DiscountPercent
        );

      if (discountPercent <= 0) {
        return total;
      }

      /*
       * Fallback for a percentage discount line where QBO
       * does not return a line Amount.
       */
      const netInvoiceTotal = Math.max(
        0,
        safeNum(invoice.TotalAmt)
      );

      const preDiscountValue =
        netInvoiceTotal /
        Math.max(
          0.0001,
          1 -
            discountPercent / 100
        );

      return (
        total +
        (
          preDiscountValue -
          netInvoiceTotal
        )
      );
    }, 0);
}

function makeSalesDiscountSummary(
  grossSales,
  discountAmount
) {
  return {
    sales: Math.max(
      0,
      grossSales - discountAmount
    ),

    grossSales,
    discountAmount,

    discountPct:
      calculateSalesPercentage(
        discountAmount,
        grossSales
      )
  };
}

function calculateSalesPercentage(
  numerator,
  denominator
) {
  if (denominator <= 0) {
    return 0;
  }

  return (
    numerator /
    denominator
  ) * 100;
}

function parseQuickBooksDate(value) {
  if (!value) return null;

  const date = new Date(
    `${value}T00:00:00`
  );

  return Number.isNaN(
    date.getTime()
  )
    ? null
    : date;
}

function normaliseSalesYear(value) {
  const now = new Date();

  const currentFinancialYear =
    now.getMonth() >= 3
      ? now.getFullYear()
      : now.getFullYear() - 1;

  const requestedYear =
    Number.parseInt(value, 10);

  if (
    Number.isInteger(requestedYear) &&
    requestedYear >= 2000 &&
    requestedYear <= currentFinancialYear + 1
  ) {
    return requestedYear;
  }

  return currentFinancialYear;
}

/**
 * Helpers
 */
function today() {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

/**
 * Financial year starts on 1 April.
 */
function currentYearStart() {
  const now = new Date();

  const financialYear =
    now.getMonth() >= 3
      ? now.getFullYear()
      : now.getFullYear() - 1;

  return `${financialYear}-04-01`;
}

function daysOverdue(dateValue) {
  if (!dateValue) return 0;

  const dueDate = new Date(
    `${dateValue}T00:00:00`
  );

  if (Number.isNaN(dueDate.getTime())) {
    return 0;
  }

  const currentDate = new Date();

  currentDate.setHours(0, 0, 0, 0);
  dueDate.setHours(0, 0, 0, 0);

  const difference = Math.floor(
    (
      currentDate.getTime() -
      dueDate.getTime()
    ) / 86400000
  );

  return difference > 0
    ? difference
    : 0;
}

function safeNum(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return 0;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/[£$€]/g, '')
    .replace(/\((.*)\)/, '-$1')
    .trim();

  const number =
    Number.parseFloat(cleaned);

  return Number.isFinite(number)
    ? number
    : 0;
}

function isNumericValue(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return false;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/[£$€]/g, '')
    .replace(/\((.*)\)/, '-$1')
    .trim();

  return Number.isFinite(
    Number.parseFloat(cleaned)
  );
}

function getLastNumericColumn(columns = []) {
  for (
    let index = columns.length - 1;
    index >= 1;
    index -= 1
  ) {
    const value =
      columns[index]?.value;

    if (isNumericValue(value)) {
      return safeNum(value);
    }
  }

  return 0;
}

function isReportTotalRow(name) {
  const normalised =
    String(name || '')
      .trim()
      .toLowerCase();

  return (
    normalised === 'total' ||
    normalised === 'grand total' ||
    normalised === 'net income' ||
    normalised === 'gross profit' ||
    normalised === 'income' ||
    normalised === 'sales' ||
    normalised.startsWith('total ')
  );
}

function handleError(res, err) {
  const details =
    err.response?.data ||
    err.message ||
    'Unknown error';

  console.error(
    'API ERROR:',
    details
  );

  res
    .status(err.status || 500)
    .json({
      error: 'API failed',
      details
    });
}