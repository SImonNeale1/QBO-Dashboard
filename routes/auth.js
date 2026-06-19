/**
 * routes/auth.js — QBO OAuth flow
 * v2: tokens saved to DB instead of session
 */
import { Router } from 'express';
import crypto from 'crypto';
import { buildAuthUrl, exchangeCodeForTokens } from '../lib/qbo.js';
import { saveQboTokens, getQboTokens } from '../lib/db.js';

export const authRouter = Router();

// Only the CEO (role: ceo) can initiate the QBO connection
authRouter.get('/connect', (req, res) => {
  if (req.session?.role !== 'ceo') {
    return res.status(403).send('Only the CEO account can connect QuickBooks.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(buildAuthUrl(state));
});

// Intuit redirects here after login
authRouter.get('/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;

  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (state !== req.session.oauthState) return res.status(400).send('State mismatch');

  try {
    const tokens    = await exchangeCodeForTokens(code);
    const expiresAt = Date.now() + (tokens.expires_in - 300) * 1000;

    saveQboTokens({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      realmId,
      expiresAt,
    });

    delete req.session.oauthState;
    res.redirect(process.env.DASHBOARD_ORIGIN || 'http://localhost:5173');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed — check server logs');
  }
});

// Check QBO connection status
authRouter.get('/status', (req, res) => {
  const tokens = getQboTokens();
  res.json({
    connected: !!tokens?.access_token,
    realmId:   tokens?.realm_id || null,
  });
});
