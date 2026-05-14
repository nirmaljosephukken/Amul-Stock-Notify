# 🥛 Amul Protein Stock Bot

A Telegram bot to track Amul protein product availability, get instant restock alerts, and auto-order when products come back in stock.

---

## ✨ Features

| Feature | Free | Premium |
|---|---|---|
| Set delivery pincode | ✅ | ✅ |
| Browse all 17 protein products | ✅ | ✅ |
| Track products (restock alerts) | ✅ | ✅ |
| Favourites list | ✅ | ✅ |
| Auto-order on restock | ❌ | ✅ |
| Link Amul account (OTP login) | ❌ | ✅ |

### Premium Plans
| Plan | Price | Duration |
|---|---|---|
| Starter | ₹5 | 3 days |
| Weekly | ₹10 | 1 week |
| Monthly | ₹30 | 1 month |

---

## 🚀 Quick Setup

### 1. Prerequisites
- Node.js 18+
- A server with a **public HTTPS URL** (Railway, Render, VPS with nginx, etc.)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Razorpay account with API keys + Webhook configured

### 2. Install

```bash
git clone <your-repo>
cd amul-bot
npm install
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

| Variable | Where to get it |
|---|---|
| `BOT_TOKEN` | @BotFather on Telegram |
| `RAZORPAY_KEY_ID` | Razorpay Dashboard → Settings → API Keys |
| `RAZORPAY_KEY_SECRET` | Same as above |
| `RAZORPAY_WEBHOOK_SECRET` | You choose — set it in Razorpay webhook settings (step 4) |
| `PUBLIC_URL` | Your server's public HTTPS URL, e.g. `https://yourapp.railway.app` |

### 4. Configure Razorpay Webhook

This is what makes payment detection fully automatic — no manual payment ID entry needed.

1. Go to **Razorpay Dashboard → Settings → Webhooks → Add New Webhook**
2. Set **Webhook URL**: `https://your-public-url.com/razorpay/webhook`
3. Set **Secret**: any strong random string — paste the same value into `RAZORPAY_WEBHOOK_SECRET`
4. Enable event: ✅ `payment_link.paid`
5. Save

Once set up, Razorpay will POST to your server the moment a payment succeeds. The bot detects it and activates the subscription instantly — the user gets a Telegram message automatically.

### 5. Run

```bash
npm start
```

---

## 🤖 Bot Commands

| Command | Description | Plan |
|---|---|---|
| `/start` | Welcome message | Free |
| `/setpincode 680027` | Set your delivery pincode | Free |
| `/products` | List all protein products | Free |
| `/products lassi` | Search products by name | Free |
| `/tracked` | View tracked products | Free |
| `/favourites` | View favourites | Free |
| `/settings` | View your settings | Free |
| `/help` | Show all commands | Free |
| `/subscribe` | View and buy premium plans | — |
| `/autoorder` | Manage auto-orders | Premium |
| `/login` | Link Amul account via OTP | Premium |
| `/cancel` | Cancel current action | — |

---

## 💳 Payment Flow (fully automatic)

```
User: /subscribe → picks plan
  → Bot creates a Razorpay Payment Link
  → Bot sends the payment page URL (one tap to pay)
  → User pays on Razorpay (UPI, card, netbanking, etc.)
  → Razorpay fires webhook → POST /razorpay/webhook
  → Bot verifies HMAC signature
  → Bot activates subscription in DB
  → User receives Telegram confirmation message ✅
```

No manual step. No copy-pasting payment IDs. It just works.

---

## 📦 How Auto-Order Works

1. User subscribes and uses `/login` to link their Amul account (OTP)
2. User enables auto-order on a product via `/products` or `/tracked`
3. Bot checks stock every **5 minutes**
4. When stock restocks:
   - All tracking users get a **restock alert** in Telegram
   - Premium users with auto-order get the item **added to their Amul cart** via the API
   - User gets a message with a direct link to checkout

> Auto-order adds to cart — the user completes checkout on Amul's website. This avoids storing payment card details.

---

## 🏗️ Architecture

```
amul-bot/
├── bot.js          # All bot logic + webhook server
├── package.json
├── .env.example
├── README.md
└── amul_bot.db     # SQLite database (auto-created on first run)
```

The bot runs two things in the same process:
- **Telegram polling** — handles user messages and commands
- **Express HTTP server** — receives Razorpay webhooks on `/razorpay/webhook`

### Database Tables

| Table | Purpose |
|---|---|
| `users` | Pincode, Amul token, subscription expiry |
| `tracked` | Products each user is tracking |
| `auto_orders` | Products set for auto-ordering (premium only) |
| `payments` | Razorpay payment link records |

---

## 🌐 Amul API Endpoints Used

| Purpose | Endpoint |
|---|---|
| Pincode → substore lookup | `GET /api/1/entity/ms.settings` |
| List protein products | `GET /api/1/entity/ms.products` |
| Send OTP | `POST /api/1/entity/ms.users?cmd=login_otp` |
| Verify OTP | `POST /api/1/entity/ms.users?cmd=login_verify_otp` |
| Fetch cart/address | `GET /api/1/entity/ms.carts?cmd=getUserCart` |
| Add to cart | `POST /api/1/entity/ms.carts?cmd=addItem` |

---

## ☁️ Deployment

### Railway (Recommended)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Set env vars in Railway dashboard. Railway gives you a public HTTPS URL automatically — use it as `PUBLIC_URL`.

### Render

1. New **Web Service** → connect GitHub repo
2. Start command: `node bot.js`
3. Add all env vars in the dashboard
4. Use the Render URL as `PUBLIC_URL`

### VPS with PM2

```bash
npm install -g pm2
pm2 start bot.js --name amul-bot
pm2 save && pm2 startup
```

Make sure nginx proxies `https://yourdomain.com/razorpay/webhook` → `localhost:3000`.

---

## ⚠️ Notes

- **Razorpay Test vs Live**: Use `rzp_test_` keys + test webhook during development.
- **Stock check interval**: 5 minutes. Don't set lower to avoid rate-limiting by Amul.
- **Amul API**: Unofficial storefront API — same as what the website uses.
- **Sessions**: Stored in-memory. A bot restart clears mid-flow sessions (rare edge case).
- **SQLite**: Works for thousands of users. Migrate to Postgres if you need horizontal scaling.

---

## 📄 License

MIT
