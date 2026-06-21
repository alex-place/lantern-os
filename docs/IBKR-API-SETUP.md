---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# IBKR API Integration — Direct REST API Setup

**No Gateway needed.** Connect directly with API credentials.

---

## Setup (5 minutes)

### 1. Get Your IBKR API Credentials

Go to https://www.interactivebrokers.com/en/accounts/ibkr-account.php

- **Account ID:** Your 8-digit IBKR account number (e.g., `U12345678`)
- **API Key:** Generate in Account Settings → API → Create Key
- **API Secret:** Provided when API Key is created

### 2. Add to `.env` File

Create or edit `.env` in the repo root:

```bash
# IBKR Direct REST API (no Gateway required)
IBKR_ACCOUNT_ID=U12345678
IBKR_API_KEY=your_api_key_here
IBKR_API_SECRET=your_api_secret_here
IBKR_BASE_URL=https://api.ibkr.com/v1
```

### 3. Restart the Server

```bash
npm start --prefix apps/lantern-garage
```

### 4. Verify Connection

Open http://127.0.0.1:4177/trading.html

- Dashboard should show: **✓ IBKR • Connected** (green dot)
- Portfolio displays real equity, cash, P&L
- Positions show live holdings

---

## What You Get

| Feature | Status |
|---------|--------|
| Real Portfolio Value | ✅ Live |
| Cash Balance | ✅ Live |
| Open Positions | ✅ Live |
| P&L (Today) | ✅ Live |
| Stock Prices (watchlist) | Use Alpaca API separately |
| Trading Signals | Enable Claude MCP |

---

## Troubleshooting

### "Still showing offline"
1. Check `.env` has correct credentials
2. Verify `IBKR_ACCOUNT_ID` is 8 digits (e.g., `U12345678`)
3. Restart: `npm start --prefix apps/lantern-garage`
4. Refresh browser: Ctrl+R

### "Authorization failed"
- API Key or Secret is incorrect
- Check IBKR Account Settings → API
- Regenerate keys if needed

### "Can't connect to IBKR API"
- Check internet connection
- IBKR might be down (rare)
- Try different `IBKR_BASE_URL`:
  ```bash
  IBKR_BASE_URL=https://api-live.ibkr.com/v1  # Alternative endpoint
  ```

---

## How It Works

```
Browser Dashboard
       ↓
Trading Service (port 5050)
       ↓
Trading API Bridge
       ↓
IBKR REST API ← API Key Auth (no Gateway!)
       ↓
Real Account Data
```

No local Gateway app needed. Direct HTTPS connection to IBKR.

---

## API Integration Pattern

The dashboard now uses the **same pattern as Alpaca**:

✅ REST API with credentials  
✅ Direct HTTPS calls (no Gateway)  
✅ Automatic fallback to zeros if disconnected  
✅ Data refreshes every 30 seconds  
✅ Portfolio, positions, real P&L  

---

## Security Notes

- API credentials stored in `.env` (not in code)
- `.env` should be in `.gitignore` (don't commit)
- API calls use HTTPS (encrypted)
- Credentials never logged or exposed

---

## Next Steps

1. ✅ Add `IBKR_ACCOUNT_ID`, `IBKR_API_KEY`, `IBKR_API_SECRET` to `.env`
2. ✅ Restart server
3. ✅ Open dashboard, check for green "Connected" dot
4. ✅ See real portfolio data

**Optional:** Add Alpaca API keys for stock prices (same `.env` setup)

---

**Dashboard:** http://127.0.0.1:4177/trading.html  
**Status:** Ready to connect IBKR API directly
