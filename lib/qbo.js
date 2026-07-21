/**
 * qbo.js — QuickBooks Online OAuth2 + API helper
 */

const QBO_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const TOKEN_URL =
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

/**
 * Read and validate the QuickBooks environment variables.
 */
function getConfig() {
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.QBO_REDIRECT_URI?.trim();

  if (!clientId) {
    throw new Error('QBO_CLIENT_ID is missing from this deployment');
  }

  if (!clientSecret) {
    throw new Error('QBO_CLIENT_SECRET is missing from this deployment');
  }

  if (!redirectUri) {
    throw new Error('QBO_REDIRECT_URI is missing from this deployment');
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

/**
 * Build the QuickBooks OAuth URL.
 */
export function buildAuthUrl(state) {
  const { clientId, redirectUri } = getConfig();

  if (!state) {
    throw new Error('OAuth state is missing');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state,
  });

  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code for QuickBooks tokens.
 */
export async function exchangeCodeForTokens(code) {
  const { redirectUri } = getConfig();

  if (!code) {
    throw new Error('QuickBooks authorization code is missing');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();

    throw new Error(
      `Token exchange failed with status ${res.status}: ${text}`
    );
  }

  return res.json();
}

/**
 * Refresh an expired QuickBooks access token.
 */
export async function refreshAccessToken(refreshToken) {
  getConfig();

  if (!refreshToken) {
    throw new Error('QuickBooks refresh token is missing');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();

    throw new Error(
      `Token refresh failed with status ${res.status}: ${text}`
    );
  }

  return res.json();
}

/**
 * Generic GET request to QuickBooks.
 */
export async function qboGet(qbo, path) {
  if (!qbo?.realmId) {
    throw new Error('QuickBooks realmId is missing');
  }

  if (!qbo?.accessToken) {
    throw new Error('QuickBooks access token is missing');
  }

  const url = `${QBO_BASE}/${qbo.realmId}/${path}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${qbo.accessToken}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 401) {
    throw Object.assign(
      new Error('QuickBooks access token is unauthorised or expired'),
      { status: 401 }
    );
  }

  if (!res.ok) {
    const text = await res.text();

    throw new Error(
      `QuickBooks API error ${res.status}: ${text}`
    );
  }

  return res.json();
}

/**
 * QuickBooks reports endpoint.
 */
export async function qboReport(qbo, reportName, params = {}) {
  const qs = new URLSearchParams({
    minorversion: '73',
    ...params,
  }).toString();

  return qboGet(qbo, `reports/${reportName}?${qs}`);
}

/**
 * QuickBooks SQL query endpoint.
 */
export async function qboQuery(qbo, sql) {
  const qs = new URLSearchParams({
    query: sql,
    minorversion: '73',
  }).toString();

  return qboGet(qbo, `query?${qs}`);
}

/**
 * Create the Basic Authentication header for Intuit.
 */
function basicAuth() {
  const { clientId, clientSecret } = getConfig();

  console.log('QBO credentials loaded:', {
    clientIdLength: clientId.length,
    clientSecretLength: clientSecret.length,
  });

  const credentials = `${clientId}:${clientSecret}`;

  return (
    'Basic ' +
    Buffer.from(credentials).toString('base64')
  );

}
