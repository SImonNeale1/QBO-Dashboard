import { getQboTokens, saveQboTokens, isQboTokenExpiredSoon } from '../lib/db.js';
import { refreshAccessToken } from '../lib/qbo.js';

export async function tokenRefresher(req, res, next) {
  try {
    const expiredSoon = await isQboTokenExpiredSoon();

    if (!expiredSoon) {
      const t = await getQboTokens();

      req.qbo = {
        accessToken: t.access_token,
        realmId: t.realm_id
      };

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

    req.qbo = {
      accessToken: tokens.access_token,
      realmId: current.realm_id
    };

    next();

  } catch (err) {
    console.error('Token refresh failed:', err.message);

    res.status(503).json({
      error: 'QuickBooks token expired — please reconnect',
      connectUrl: '/auth/connect'
    });
  }
}
