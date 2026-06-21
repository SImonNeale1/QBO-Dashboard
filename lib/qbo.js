/**
 * qbo.js — QuickBooks Online OAuth2 + API helper
 * ✅ Fixed redirect URI (no env mismatch issues)
 */

// ✅ ALWAYS use your correct live domain
const REDIRECT_URI = 'https://qbo-dashboard-fdtq.onrender.com/auth/callback';

const QBO_BASE  = 'https://quickbooks.api.intuit.com/v3/company';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';

/**
 * ✅ Build OAuth URL
 */
export function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     process.env.QBO_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'com.intuit.quickbooks.accounting',
    state,
  });

  return `${AUTH_URL}?${params}`;
}

/**
 * ✅ Exchange auth code for tokens
 */
export async function exchangeCodeForTokens(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': basicAuth(),
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  return res.json();
}

/**
 * ✅ Refresh access token
 */
export async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': basicAuth(),
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  return res.json();
}

/**
 * ✅ Generic GET request to QuickBooks
 */
export async function qboGet(qbo, path) {
  const url = `${QBO_BASE}/${qbo.realmId}/${path}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${qbo.accessToken}`,
      'Accept':        'application/json',
    },
  });

  if (res.status === 401) {
    throw Object.assign(new Error('Unauthorised'), { status: 401 });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * ✅ Reports
 */
export async function qboReport(qbo, reportName, params = {}) {
  const qs = new URLSearchParams({
    minorversion: 73,
    ...params
  }).toString();

  return qboGet(qbo, `reports/${reportName}?${qs}`);
}

/**
 * ✅ SQL Query endpoint
 */
export async function qboQuery(qbo, sql) {
  const qs = new URLSearchParams({
    query: sql,
    minorversion: 73
  }).toString();

  return qboGet(qbo, `query?${qs}`);
}

/**
 * ✅ Basic Auth helper
 */
function basicAuth() {
  return 'Basic ' + Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');
}
