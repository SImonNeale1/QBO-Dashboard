/**
 * routes/sales.js — Sales analysis endpoints
 *
 * Endpoints:
 *   GET /api/sales/monthly          — monthly Advantage vs Other sales + discounts
 *   GET /api/sales/salesperson      — discount by salesperson (contractor sales only)
 *   GET /api/sales/discount-summary — overall avg discount by product group
 */

import { Router } from 'express';
import { qboQuery } from '../lib/qbo.js';

export const salesRouter = Router();

// ── Config ─────────────────────────────────────────────────────────────────

const RESELLER_NAMES = ['alltimes products', 'cgl', 'garland'];

const REGION_MAP = {
  'north':      { person: 'Derek', weight: 1 },
  'scotland':   { person: 'Derek', weight: 1 },
  'south west': { person: 'Andy',  weight: 1 },
  'south east': { person: 'Andy',  weight: 1 },
  'midlands':   { person: 'Sean',  weight: 1 },
  // Wales split 50/50
  'wales':      [
    { person: 'Andy', weight: 0.5 },
    { person: 'Sean', weight: 0.5 },
  ],
};

const SALESPEOPLE = ['Andy', 'Sean', 'Derek'];

// ── Monthly sales — Advantage vs Other ────────────────────────────────────

salesRouter.get('/monthly', async (req, res) => {
  try {
    const year  = parseInt(req.query.year || new Date().getFullYear());
    const start = `${year}-01-01`;
    const end   = `${year}-12-31`;

    // Pull all invoice line items for the year
    const data = await qboQuery(req.qbo,
      `SELECT Id, TxnDate, CustomerRef, Line, TotalAmt
       FROM Invoice
       WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'
       AND DocNumber IS NOT NULL
       MAXRESULTS 1000`
    );

    const invoices = data.QueryResponse?.Invoice || [];

    // Build monthly buckets
    const months = Array.from({ length: 12 }, (_, i) => ({
      month:          i + 1,
      label:          new Date(year, i, 1).toLocaleString('en-GB', { month: 'short' }),
      advantageSales: 0,
      otherSales:     0,
      advantageDiscount: { total: 0, gross: 0 },
      otherDiscount:     { total: 0, gross: 0 },
    }));

    for (const inv of invoices) {
      const month   = new Date(inv.TxnDate).getMonth(); // 0-indexed
      const bucket  = months[month];
      const custName = inv.CustomerRef?.name?.toLowerCase() || '';
      const isReseller = RESELLER_NAMES.some(r => custName.includes(r));

      for (const line of inv.Line || []) {
        if (line.DetailType !== 'SalesItemLineDetail') continue;
        const desc        = (line.Description || line.SalesItemLineDetail?.ItemRef?.name || '').toLowerCase();
        const isAdvantage = desc.includes('advantage');
        const amount      = parseFloat(line.Amount || 0);
        const discount    = parseFloat(line.SalesItemLineDetail?.DiscountAmt || 0);
        const gross       = amount + discount; // amount before discount

        if (isAdvantage) {
          bucket.advantageSales += amount;
          if (!isReseller && gross > 0) {
            bucket.advantageDiscount.total += discount;
            bucket.advantageDiscount.gross += gross;
          }
        } else {
          bucket.otherSales += amount;
          if (!isReseller && gross > 0) {
            bucket.otherDiscount.total += discount;
            bucket.otherDiscount.gross += gross;
          }
        }
      }
    }

    // Add cumulative YTD totals and format discount %
    let ytdAdvantage = 0, ytdOther = 0;
    let ytdAdvDisc = { total: 0, gross: 0 };
    let ytdOthDisc = { total: 0, gross: 0 };
    const now = new Date().getMonth(); // only show up to current month

    const result = months.slice(0, now + 1).map(m => {
      ytdAdvantage += m.advantageSales;
      ytdOther     += m.otherSales;
      ytdAdvDisc.total += m.advantageDiscount.total;
      ytdAdvDisc.gross += m.advantageDiscount.gross;
      ytdOthDisc.total += m.otherDiscount.total;
      ytdOthDisc.gross += m.otherDiscount.gross;

      return {
        month:           m.month,
        label:           m.label,
        advantageSales:  round(m.advantageSales),
        otherSales:      round(m.otherSales),
        totalSales:      round(m.advantageSales + m.otherSales),
        ytdAdvantage:    round(ytdAdvantage),
        ytdOther:        round(ytdOther),
        ytdTotal:        round(ytdAdvantage + ytdOther),
        advDiscountPct:  discPct(m.advantageDiscount),
        otherDiscountPct:discPct(m.otherDiscount),
        ytdAdvDiscountPct:  discPct(ytdAdvDisc),
        ytdOtherDiscountPct: discPct(ytdOthDisc),
      };
    });

    res.json({ year, months: result });
  } catch (err) { handleError(res, err); }
});

// ── Salesperson discount analysis ──────────────────────────────────────────

salesRouter.get('/salesperson', async (req, res) => {
  try {
    const year  = parseInt(req.query.year || new Date().getFullYear());
    const start = `${year}-01-01`;
    const end   = new Date().toISOString().slice(0, 10); // YTD

    const data = await qboQuery(req.qbo,
      `SELECT Id, TxnDate, CustomerRef, Line
       FROM Invoice
       WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'
       MAXRESULTS 1000`
    );

    const invoices = data.QueryResponse?.Invoice || [];

    // Buckets per salesperson, per product group
    const stats = {};
    SALESPEOPLE.forEach(p => {
      stats[p] = {
        advantage: { sales: 0, discountTotal: 0, gross: 0 },
        other:     { sales: 0, discountTotal: 0, gross: 0 },
      };
    });

    for (const inv of invoices) {
      const custName   = inv.CustomerRef?.name?.toLowerCase() || '';
      const isReseller = RESELLER_NAMES.some(r => custName.includes(r));
      if (isReseller) continue; // contractors only

      // Get customer details to find region
      // Region comes from custom field — we'll use what's available on the invoice
      // QBO returns custom fields in CustomField array
      const customFields = inv.CustomField || [];
      const regionField  = customFields.find(f =>
        /sales.?person|region/i.test(f.Name)
      );
      const region = (regionField?.StringValue || '').toLowerCase().trim();

      // Resolve region to salesperson(s) with weights
      const assignments = resolveRegion(region);
      if (assignments.length === 0) continue;

      for (const line of inv.Line || []) {
        if (line.DetailType !== 'SalesItemLineDetail') continue;
        const desc        = (line.Description || line.SalesItemLineDetail?.ItemRef?.name || '').toLowerCase();
        const isAdvantage = desc.includes('advantage');
        const amount      = parseFloat(line.Amount || 0);
        const discount    = parseFloat(line.SalesItemLineDetail?.DiscountAmt || 0);
        const gross       = amount + discount;
        const group       = isAdvantage ? 'advantage' : 'other';

        for (const { person, weight } of assignments) {
          stats[person][group].sales         += amount   * weight;
          stats[person][group].discountTotal += discount * weight;
          stats[person][group].gross         += gross    * weight;
        }
      }
    }

    const result = SALESPEOPLE.map(person => ({
      person,
      advantage: {
        sales:       round(stats[person].advantage.sales),
        discountPct: discPct(stats[person].advantage),
      },
      other: {
        sales:       round(stats[person].other.sales),
        discountPct: discPct(stats[person].other),
      },
      overall: {
        sales: round(stats[person].advantage.sales + stats[person].other.sales),
        discountPct: discPct({
          total: stats[person].advantage.discountTotal + stats[person].other.discountTotal,
          gross: stats[person].advantage.gross         + stats[person].other.gross,
        }),
      },
    }));

    res.json({ year, salespeople: result });
  } catch (err) { handleError(res, err); }
});

// ── Overall discount summary ───────────────────────────────────────────────

salesRouter.get('/discount-summary', async (req, res) => {
  try {
    const year  = parseInt(req.query.year || new Date().getFullYear());
    const start = `${year}-01-01`;
    const end   = new Date().toISOString().slice(0, 10);

    const data = await qboQuery(req.qbo,
      `SELECT Id, TxnDate, CustomerRef, Line
       FROM Invoice
       WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'
       MAXRESULTS 1000`
    );

    const invoices = data.QueryResponse?.Invoice || [];
    const adv  = { sales: 0, disc: 0, gross: 0 };
    const other = { sales: 0, disc: 0, gross: 0 };

    for (const inv of invoices) {
      const custName   = inv.CustomerRef?.name?.toLowerCase() || '';
      const isReseller = RESELLER_NAMES.some(r => custName.includes(r));
      if (isReseller) continue;

      for (const line of inv.Line || []) {
        if (line.DetailType !== 'SalesItemLineDetail') continue;
        const desc        = (line.Description || line.SalesItemLineDetail?.ItemRef?.name || '').toLowerCase();
        const isAdvantage = desc.includes('advantage');
        const amount      = parseFloat(line.Amount || 0);
        const discount    = parseFloat(line.SalesItemLineDetail?.DiscountAmt || 0);
        const gross       = amount + discount;
        const bucket      = isAdvantage ? adv : other;
        bucket.sales += amount;
        bucket.disc  += discount;
        bucket.gross += gross;
      }
    }

    res.json({
      year,
      advantage: { sales: round(adv.sales),  discountPct: discPct({ total: adv.disc,  gross: adv.gross  }) },
      other:     { sales: round(other.sales), discountPct: discPct({ total: other.disc, gross: other.gross }) },
      combined:  {
        sales: round(adv.sales + other.sales),
        discountPct: discPct({ total: adv.disc + other.disc, gross: adv.gross + other.gross }),
      },
    });
  } catch (err) { handleError(res, err); }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveRegion(region) {
  if (!region) return [];
  const entry = REGION_MAP[region];
  if (!entry) return [];
  return Array.isArray(entry) ? entry : [entry];
}

function discPct({ total, gross }) {
  if (!gross || gross === 0) return 0;
  return round((total / gross) * 100, 1);
}

function round(n, dp = 2) {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

function handleError(res, err) {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
}
