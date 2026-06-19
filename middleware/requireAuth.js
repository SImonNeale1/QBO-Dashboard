/**
 * requireAuth — two checks in one:
 *   1. Is the user logged in? (session has userId)
 *   2. Are QBO tokens available in the database?
 *
 * Returns 401 with a helpful message for each failure case.
 */
import { getQboTokens } from '../lib/db.js';

export function requireAuth(req, res, next) {
  // Check user login
  if (!req.session?.userId) {
    return res.status(401).json({
      error: 'Not logged in',
      loginUrl: '/login',
    });
  }

  // Check QBO is connected (admin task — done once by CEO)
  const tokens = getQboTokens();
  if (!tokens?.access_token) {
    return res.status(503).json({
      error: 'QuickBooks not connected yet',
      connectUrl: '/auth/connect',
    });
  }

  next();
}
