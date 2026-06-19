/**
 * tokenRefresher — reads tokens from DB, refreshes if near expiry,
 * then attaches them to req so API routes can use them.
 */
import { getQboTokens, saveQboTokens, isQboTokenExpiredSoon } from '../lib/db.js';
import { refreshAccessToken } from '../lib/qbo.js';

export async function tokenRefresher(req, res, next) {
  if (!isQboTokenExpiredSoon()) {
    // Attach current tokens to request
    const t = getQboTokens();
    req.qbo = { accessToken: t.access_token, realmId: t.realm_id };
    return next();
  }

  try {
    const current = getQboTokens();
    const tokens  = await refreshAccessToken(current.refresh_token);
    const expiresAt = Date.now() + (tokens.expires_in - 300) * 1000;

    saveQboTokens({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token || current.refresh_token,
      realmId:      current.realm_id,
      expiresAt,
    });

    req.qbo = { accessToken: tokens.access_token, realmId: current.realm_id };
    next();
  } catch (err) {
    console.error('Token refresh failed:', err.message);
    res.status(503).json({
      error: 'QuickBooks token expired — CEO needs to reconnect',
      connectUrl: '/auth/connect',
    });
  }
}
