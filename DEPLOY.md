# Deploying to Azure — Step by Step

**What you need:**
- Microsoft business account (you already have this)
- VS Code — download free from code.visualstudio.com
- Your QBO Client ID and Client Secret from developer.intuit.com

Total time: about 25 minutes first time.

---

## Part 1 — Install VS Code + Azure extension (5 mins)

1. Download and install **VS Code** from https://code.visualstudio.com
2. Open VS Code, click the **Extensions** icon in the left sidebar (looks like 4 squares)
3. Search for **Azure App Service** and click Install (published by Microsoft)
4. Once installed, click the new **Azure icon** in the left sidebar
5. Click **Sign in to Azure** and use your Microsoft business account

You'll see your Azure subscriptions appear in the sidebar.

---

## Part 2 — Open your backend folder in VS Code (1 min)

1. Go to **File → Open Folder**
2. Select the `qbo-backend-v2` folder (from the zip you downloaded)

---

## Part 3 — Deploy to Azure App Service (5 mins)

1. In the Azure sidebar, expand your subscription
2. Right-click **App Services** → **Create New Web App (Advanced)**
3. When prompted, enter:
   - **Name**: `qbo-dashboard` + your initials (must be unique, e.g. `qbo-dashboard-abc`)
   - **Resource group**: Create new → call it `qbo-dashboard-rg`
   - **Runtime**: Node.js 20 LTS
   - **OS**: **Linux** (cheaper, no Windows licensing cost)
   - **Region**: UK South
   - **Pricing tier**: **F1 Free**
   - **Application Insights**: Skip for now

4. Once Azure finishes creating the app (takes ~1 min), right-click your new app in the sidebar
5. Click **Deploy to Web App** → select your `qbo-backend-v2` folder → click **Deploy**

VS Code will upload your files. When it says "Deployment successful" your app is live at:
`https://qbo-dashboard-abc.azurewebsites.net`

---

## Part 4 — Set up persistent storage for the database (5 mins)

The SQLite database needs somewhere permanent to live. Do this in the Azure Portal (portal.azure.com):

### 4a — Create a Storage Account
1. In the Azure Portal, search for **Storage accounts** → **Create**
2. Settings:
   - Resource group: `qbo-dashboard-rg` (same one you created above)
   - Storage account name: `qbodashboardstorage` (no hyphens)
   - Region: UK South
   - Performance: Standard
   - Redundancy: LRS (cheapest)
3. Click **Review → Create**

### 4b — Create a file share
1. Open your new storage account → **File shares** → **+ File share**
2. Name: `dbdata`, Tier: Transaction optimised → **Create**

### 4c — Mount it to your App Service
1. Go to your App Service → **Configuration** → **Path mappings** tab
2. Click **+ New Azure Storage Mount**:
   - Name: `data`
   - Storage account: select `qbodashboardstorage`
   - Storage container: select `dbdata`
   - Mount path: `/home/data`
3. Click **OK → Save**

---

## Part 5 — Set environment variables (3 mins)

Still in the Azure Portal, go to your App Service → **Configuration → Application settings** → **+ New application setting** for each of these:

| Name | Value |
|---|---|
| `QBO_CLIENT_ID` | From developer.intuit.com |
| `QBO_CLIENT_SECRET` | From developer.intuit.com |
| `QBO_REDIRECT_URI` | `https://qbo-dashboard-abc.azurewebsites.net/auth/callback` |
| `SESSION_SECRET` | Any 40+ random characters e.g. `xK9mP2qR7vN4wL8jT3bY6cF1dH5eG0` |
| `DASHBOARD_ORIGIN` | `https://qbo-dashboard-abc.azurewebsites.net` |
| `NODE_ENV` | `production` |
| `DB_PATH` | `/home/data/dashboard.db` |

Click **Save** at the top. Azure will restart your app automatically.

---

## Part 6 — Update QuickBooks redirect URI (2 mins)

1. Go to https://developer.intuit.com → your app → **Keys & OAuth**
2. Under **Redirect URIs** click **Add URI** and add:
   `https://qbo-dashboard-abc.azurewebsites.net/auth/callback`
3. Save

---

## Part 7 — Create your user accounts (3 mins)

In the Azure Portal, go to your App Service → **SSH** (under Development Tools in the left menu):

```bash
node seed.js
```

Follow the prompts to create accounts. Example:
- You: username `ceo`, role `ceo`
- Finance team member: username `sarah.jones`, role `finance`

Run it as many times as you need to add everyone.

---

## Part 8 — Connect QuickBooks (1 min)

1. Open your app URL in a browser: `https://qbo-dashboard-abc.azurewebsites.net`
2. Log in with your CEO username and password
3. Go to `/auth/connect` — you'll be redirected to QuickBooks to approve access
4. Done — your backend is fully live

---

## Sharing the dashboard with your team

The dashboard is a single HTML file — `index.html`. Once your backend is deployed:

**Your team just needs the HTML file.** They can:
- Open it directly from their computer (double-click the file)
- Or you host it so they don't need to download anything (see below)

**The HTML file works because** it calls your Azure backend URL for all the data.
No server needed for the HTML itself — it's just a file.

### How to share it

**Option A — Email or Teams (simplest)**
Attach `index.html` to an email or Teams message. Team opens it, logs in, done.
Downside: if you update the dashboard they need the new file.

**Option B — SharePoint (recommended for a team)**
Upload `index.html` to a SharePoint folder your team has access to.
They bookmark the SharePoint link. When you update the dashboard,
replace the file in SharePoint — everyone gets the update automatically.

**Option C — Azure Static Web Apps (free, always the latest version)**
1. In Azure Portal → **Create a resource** → search **Static Web Apps**
2. Free tier, connect to your GitHub repo or upload the HTML file
3. Azure gives you a permanent URL like `https://happy-pebble-abc.azurestaticapps.net`
4. Share that URL — works in any browser, on any device, anywhere in the world
5. Update the file in GitHub and it redeploys in seconds

Option C is the most professional and still completely free.

---

## What your team's experience looks like

1. They open the HTML file (or URL if you use Option C)
2. They see a login screen — enter their username and password
3. They land on the dashboard with live QuickBooks data
4. Data refreshes automatically every 60 seconds

That's it. No installs, no accounts to create themselves, no app to download.

---

## Free tier limitations

The F1 free tier sleeps after 20 minutes of inactivity.
The first person to open the dashboard in the morning may wait ~30 seconds for it to wake up.
Everyone after that is instant.

**To remove the sleep delay**: upgrade to B1 Basic (~£10/month) in
App Service → **Scale up (App Service plan)** → select B1.
At that point also turn on **Always On** under Configuration → General Settings.

---

## Troubleshooting

**App won't start**
Azure Portal → your App Service → **Log stream** — shows live errors.

**"QuickBooks not connected"**
Log in as your CEO account and visit `/auth/connect` again.
QBO refresh tokens last 100 days — after that you reconnect once.

**Need to reset a user's password**
Azure Portal → your App Service → SSH → `node seed.js` → delete user → re-add them.

**Check your logs**
Azure Portal → App Service → **Log stream** or **Diagnose and solve problems**.
