
import QuickBooks from 'node-quickbooks';
import { getQboTokens, saveQboTokens, isQboTokenExpiredSoon } from '../lib/db.js';
import { refreshAccessToken } from '../lib/qbo.js';

export async function tokenRefresher(req, res, next) {
  try {
    const expiredSoon = await isQboTokenExpiredSoon();

    if (!expiredSoon) {
      const t = await getQboTokens();

      req.qbo = new QuickBooks(
        process.env.QBO_CLIENT_ID,
        process.env.QBO_CLIENT_SECRET,
        t.access_token,
        false,
        t.realm_id,
        true,
        true,
        null,
        '2.0'
      );

      return next();
    }

    const current   = await getQboTokens();
    const tokens    = await refreshAccessToken(current.refresh_token);
    const expiresAt = Date.now() + (tokens.expires_in - 300) * 1000;

    await saveQboTokens({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token || current.refresh_token,
      realmId:      current.realm_id,
      expiresAt,
    });

    req.qbo = new QuickBooks(
      process.env.QBO_CLIENT_ID,
      process.env.QBO_CLIENT_SECRET,
      tokens.access_token,
      false,
      current.realm_id,
      true,
      true,
      null,
      '2.0'
    );

    next();

  } catch (err) {
    console.error('Token refresh failed:', err.message);

    res.status(503).json({
      error: 'QuickBooks token expired — please reconnect',
      connectUrl: '/auth/connect'
    });
  }
}
