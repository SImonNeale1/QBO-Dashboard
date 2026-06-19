# QBO CEO Dashboard — Backend

Node.js proxy server that connects your CEO dashboard to QuickBooks Online.
Handles OAuth2 authentication, automatic token refresh, and exposes clean
API endpoints for your dashboard to consume.

---

## Quick start

### 1. Install Node.js
Download the LTS version from https://nodejs.org if you don't have it.

### 2. Install dependencies
```bash
npm install
```

### 3. Configure credentials
```bash
cp .env.example .env
```
Then open `.env` and fill in:
- `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` — from developer.intuit.com
- `SESSION_SECRET` — any long random string (e.g. type 40 random characters)

### 4. Start the server
```bash
npm start
```

### 5. Connect to QuickBooks
Open your browser and go to:
```
http://localhost:3000/auth/connect
```
You'll be redirected to Intuit to log in and approve access.
After approving, you'll land back on your dashboard — fully connected.

---

## API endpoints

All endpoints require authentication (step 5 above).

| Endpoint | Description |
|---|---|
| `GET /api/pl` | Profit & Loss (YTD by default) |
| `GET /api/balance-sheet` | Balance sheet as of today |
| `GET /api/cash-flow` | Cash flow statement |
| `GET /api/invoices/outstanding` | All unpaid invoices |
| `GET /api/customers/top` | Top customers by revenue |
| `GET /api/expenses` | Expense breakdown |
| `GET /auth/status` | Check if authenticated |
| `GET /health` | Server health check |

### Query parameters

**Date ranges** — most endpoints accept `?start=YYYY-MM-DD&end=YYYY-MM-DD`

**P&L monthly columns** — add `?summarize_column_by=Month` to get month-by-month breakdown

---

## How tokens work

- QBO access tokens expire every **60 minutes**
- This server automatically refreshes them **5 minutes before expiry**
- You never need to log in again — the refresh token lasts **100 days**
- After 100 days, visit `http://localhost:3000/auth/connect` to re-authenticate

---

## File structure

```
qbo-backend/
├── server.js                  ← entry point
├── .env                       ← your credentials (never commit this)
├── .env.example               ← template
├── package.json
├── routes/
│   ├── auth.js                ← OAuth flow (/auth/*)
│   └── api.js                 ← data endpoints (/api/*)
├── middleware/
│   ├── requireAuth.js         ← blocks unauthenticated requests
│   └── tokenRefresher.js      ← silent token refresh
└── lib/
    ├── qbo.js                 ← QBO API wrapper + OAuth helpers
    └── parsers.js             ← converts QBO report format to clean JSON
```

---

## Running in production

If you want to run this on a server (so the dashboard works from anywhere):

1. Set `NODE_ENV=production` in your `.env`
2. Update `QBO_REDIRECT_URI` to your server's public URL
3. Update `DASHBOARD_ORIGIN` to your dashboard's public URL
4. Add the new redirect URI in your app at developer.intuit.com
5. Use a process manager like PM2: `npm install -g pm2 && pm2 start server.js`
