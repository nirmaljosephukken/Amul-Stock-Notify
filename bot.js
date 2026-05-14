/**
 * Amul Protein Stock Tracker Bot
 *
 * Dependencies:
 *   npm install node-telegram-bot-api axios node-cron better-sqlite3 razorpay express
 *
 * Environment variables:
 *   BOT_TOKEN               – Telegram bot token from @BotFather
 *   RAZORPAY_KEY_ID         – Razorpay API key ID
 *   RAZORPAY_KEY_SECRET     – Razorpay API key secret
 *   RAZORPAY_WEBHOOK_SECRET – Webhook secret set in Razorpay dashboard
 *   WEBHOOK_PORT            – Port for the HTTP server (default: 3000)
 *   PUBLIC_URL              – Your public HTTPS URL, e.g. https://yourapp.railway.app
 *                             (used as the Razorpay callback URL after payment)
 */

"use strict";

const TelegramBot = require("node-telegram-bot-api");
const axios       = require("axios");
const cron        = require("node-cron");
const Database    = require("better-sqlite3");
const Razorpay    = require("razorpay");
const express     = require("express");
const crypto      = require("crypto");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN               = process.env.BOT_TOKEN               || "YOUR_BOT_TOKEN";
const RAZORPAY_KEY_ID         = process.env.RAZORPAY_KEY_ID         || "YOUR_KEY_ID";
const RAZORPAY_KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET     || "YOUR_KEY_SECRET";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "YOUR_WEBHOOK_SECRET";
const WEBHOOK_PORT            = parseInt(process.env.WEBHOOK_PORT   || "3000", 10);
const PUBLIC_URL              = (process.env.PUBLIC_URL             || "").replace(/\/$/, "");

// Subscription plans – amount in paise (INR × 100)
const PLANS = {
  "3day":  { label: "3 Days",  days: 3,  amount: 500,  display: "₹5"  },
  "week":  { label: "1 Week",  days: 7,  amount: 1000, display: "₹10" },
  "month": { label: "1 Month", days: 30, amount: 3000, display: "₹30" },
};

const AMUL_BASE    = "https://shop.amul.com";
const AMUL_HEADERS = { "x-store-domain": "shop.amul.com" };

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database("amul_bot.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    username      TEXT    DEFAULT '',
    pincode       TEXT,
    substore      TEXT,
    phone         TEXT,
    amul_token    TEXT,
    amul_user_id  TEXT,
    address       TEXT,
    sub_plan      TEXT,
    sub_expires   INTEGER DEFAULT 0,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS tracked (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    sku        TEXT,
    product    TEXT,
    last_seen  INTEGER DEFAULT 0,
    UNIQUE(user_id, sku)
  );

  CREATE TABLE IF NOT EXISTS auto_orders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER,
    sku       TEXT,
    product   TEXT,
    UNIQUE(user_id, sku)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER,
    payment_link_id TEXT UNIQUE,
    plan            TEXT,
    amount          INTEGER,
    status          TEXT    DEFAULT 'pending',
    created_at      INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
const getUser = (userId) =>
  db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);

function upsertUser(userId, data = {}) {
  if (!getUser(userId)) {
    db.prepare("INSERT INTO users (user_id) VALUES (?)").run(userId);
  }
  if (!Object.keys(data).length) return;
  const sets = Object.keys(data).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE users SET ${sets} WHERE user_id = ?`).run(...Object.values(data), userId);
}

const isSubscribed = (user) =>
  !!user?.sub_expires && user.sub_expires > Math.floor(Date.now() / 1000);

// ─── AMUL API ─────────────────────────────────────────────────────────────────
async function getSubstore(pincode) {
  try {
    const url =
      `${AMUL_BASE}/api/1/entity/ms.settings` +
      `?filters=%5B%7B%22field%22%3A%22substore_zipcodes%22%2C%22value%22%3A%22${pincode}%22%2C%22operator%22%3A%22regex%22%7D%5D`;
    const { data } = await axios.get(url, { headers: AMUL_HEADERS });
    const s = data?.data?.[0];
    return s ? { name: s.name } : null;
  } catch { return null; }
}

async function fetchProducts(substore) {
  try {
    const filters = JSON.stringify([{ field: "categories", value: "protein", operator: "in" }]);
    const params  = new URLSearchParams({
      "fields[name]": 1, "fields[alias]": 1, "fields[price]": 1,
      "fields[sku]": 1, "fields[available]": 1,
      "fields[inventory_quantity]": 1, "fields[metafields]": 1,
      filters, limit: 32, page: 1, lang: "en",
    });
    const { data } = await axios.get(
      `${AMUL_BASE}/api/1/entity/ms.products?${params}`,
      { headers: { ...AMUL_HEADERS, "x-substore": substore || "default" } }
    );
    return data?.data || [];
  } catch (e) {
    console.error("[Amul] fetchProducts:", e.message);
    return [];
  }
}

async function amulSendOtp(phone) {
  try {
    const { data } = await axios.post(
      `${AMUL_BASE}/api/1/entity/ms.users?cmd=login_otp`,
      { phone: `+91${phone}`, country_code: "+91" },
      { headers: { ...AMUL_HEADERS, "Content-Type": "application/json" } }
    );
    return data;
  } catch { return null; }
}

async function amulVerifyOtp(phone, otp) {
  try {
    const { data } = await axios.post(
      `${AMUL_BASE}/api/1/entity/ms.users?cmd=login_verify_otp`,
      { phone: `+91${phone}`, otp, country_code: "+91" },
      { headers: { ...AMUL_HEADERS, "Content-Type": "application/json" } }
    );
    return data;
  } catch { return null; }
}

async function fetchAmulAddress(token, substore) {
  try {
    const { data } = await axios.get(
      `${AMUL_BASE}/api/1/entity/ms.carts?cmd=getUserCart`,
      { headers: { ...AMUL_HEADERS, "x-substore": substore, Authorization: `Bearer ${token}` } }
    );
    return data?.cart?.shipping_address?.address || null;
  } catch { return null; }
}

async function addToCart(token, substore, alias) {
  try {
    const { data } = await axios.post(
      `${AMUL_BASE}/api/1/entity/ms.carts?cmd=addItem`,
      { alias, quantity: 1 },
      {
        headers: {
          ...AMUL_HEADERS, "x-substore": substore,
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        },
      }
    );
    return data;
  } catch { return null; }
}

// ─── RAZORPAY ─────────────────────────────────────────────────────────────────
const rzp = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

/**
 * Creates a Razorpay Payment Link.
 * user_id and plan are embedded in `notes` — the webhook uses them to
 * identify which user paid and which plan to activate.
 */
async function createPaymentLink(userId, plan) {
  const p = PLANS[plan];
  const link = await rzp.paymentLink.create({
    amount: p.amount,
    currency: "INR",
    accept_partial: false,
    description: `Amul Stock Bot — ${p.label} Plan`,
    notes: { user_id: String(userId), plan },
    notify: { sms: false, email: false },
    reminder_enable: false,
    // Redirect user back to a confirmation page after payment
    ...(PUBLIC_URL
      ? { callback_url: `${PUBLIC_URL}/payment/success`, callback_method: "get" }
      : {}),
  });

  db.prepare(
    "INSERT OR REPLACE INTO payments (user_id, payment_link_id, plan, amount) VALUES (?, ?, ?, ?)"
  ).run(userId, link.id, plan, p.amount);

  return link; // link.short_url is the hosted Razorpay checkout page
}

/**
 * Activates a user's subscription after Razorpay confirms payment via webhook.
 * Called automatically — no user action needed.
 */
async function activateSubscription(paymentLinkId) {
  const row = db
    .prepare("SELECT * FROM payments WHERE payment_link_id = ? AND status = 'pending'")
    .get(paymentLinkId);

  if (!row) {
    console.warn("[Webhook] No pending payment for link:", paymentLinkId);
    return;
  }

  const p       = PLANS[row.plan];
  const expires = Math.floor(Date.now() / 1000) + p.days * 86400;

  upsertUser(row.user_id, { sub_plan: row.plan, sub_expires: expires });
  db.prepare("UPDATE payments SET status = 'paid' WHERE payment_link_id = ?").run(paymentLinkId);

  const expiryDate = new Date(expires * 1000).toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });

  console.log(`[Webhook] Subscription activated for user ${row.user_id} — plan: ${row.plan}`);

  try {
    await bot.sendMessage(
      row.user_id,
      `🎉 *Payment confirmed — Subscription activated\\!*\n\n` +
        `Plan: ${esc(p.label)}\n` +
        `Expires: ${esc(expiryDate)}\n\n` +
        `Next: use /login to link your Amul account so the bot can auto\\-order for you\\.`,
      { parse_mode: "MarkdownV2" }
    );
  } catch (e) {
    console.error("[Webhook] Failed to notify user:", e.message);
  }
}

// ─── EXPRESS WEBHOOK SERVER ───────────────────────────────────────────────────
const app = express();

// Raw body required for HMAC signature verification — must come before express.json()
app.use("/razorpay/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/**
 * Razorpay Webhook receiver.
 *
 * Setup in Razorpay Dashboard → Settings → Webhooks:
 *   URL:    https://your-public-url.com/razorpay/webhook
 *   Events: ✅ payment_link.paid
 *   Secret: same value as RAZORPAY_WEBHOOK_SECRET env var
 */
app.post("/razorpay/webhook", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody   = req.body; // Buffer (raw body preserved above)

  // 1. Verify HMAC-SHA256 signature
  const expectedSig = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  if (!signature || signature !== expectedSig) {
    console.warn("[Webhook] Signature mismatch — rejecting request");
    return res.status(400).json({ error: "Invalid signature" });
  }

  // 2. Parse event
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: "Malformed JSON" });
  }

  console.log("[Webhook] Received event:", event.event);

  // 3. Handle payment_link.paid
  if (event.event === "payment_link.paid") {
    const linkId = event.payload?.payment_link?.entity?.id;
    if (linkId) {
      await activateSubscription(linkId);
    }
  }

  // Always respond 200 so Razorpay doesn't retry
  res.json({ ok: true });
});

// Confirmation page Razorpay redirects to after payment
app.get("/payment/success", (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Payment Successful</title>
      <style>
        body { font-family: -apple-system, sans-serif; text-align: center;
               padding: 60px 20px; background: #f6f4e9; color: #210803; }
        h1 { font-size: 2rem; margin-bottom: 12px; }
        p  { color: #555; max-width: 420px; margin: 0 auto 24px; }
        .badge { font-size: 3rem; display: block; margin-bottom: 16px; }
      </style>
    </head>
    <body>
      <span class="badge">✅</span>
      <h1>Payment Successful!</h1>
      <p>Your subscription is being activated. Return to Telegram — you'll receive a confirmation message in a few seconds.</p>
      <p><strong>You can close this tab.</strong></p>
    </body>
    </html>
  `);
});

// Health-check endpoint (useful for Railway / Render uptime checks)
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(WEBHOOK_PORT, () => {
  console.log(`[Server] Listening on port ${WEBHOOK_PORT}`);
  if (PUBLIC_URL) {
    console.log(`[Server] Razorpay webhook URL → ${PUBLIC_URL}/razorpay/webhook`);
  } else {
    console.warn("[Server] PUBLIC_URL not set — Razorpay callbacks won't redirect correctly");
  }
});

// ─── TELEGRAM BOT ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// In-memory sessions for multi-step flows (phone entry, OTP)
const sessions  = {};
const getSession  = (id) => { if (!sessions[id]) sessions[id] = { state: null, data: {} }; return sessions[id]; };
const clearSession = (id) => { sessions[id] = { state: null, data: {} }; };

// Markdown v2 escaper
const esc = (s) => String(s ?? "").replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from.id;
  upsertUser(userId, { username: msg.from.username || "" });

  const param = match?.[1] || "";
  if (param.startsWith("track_"))    return doTrack(userId, param.slice(6));
  if (param.startsWith("untrack_"))  return doUntrack(userId, param.slice(8));
  if (param.startsWith("addao_"))    return doAddAutoOrder(userId, param.slice(6));
  if (param.startsWith("removeao_")) return doRemoveAutoOrder(userId, param.slice(9));

  const user    = getUser(userId);
  const pinLine = user?.pincode
    ? `📍 Pincode: *${esc(user.pincode)}* \\(${esc(user.substore || "")}\\)`
    : "📍 No pincode set yet\\.";

  await bot.sendMessage(userId,
    `👋 *Welcome to Amul Protein Stock Bot\\!*\n\n${pinLine}\n\n` +
    `*Free*\n` +
    `• /setpincode – Set your delivery pincode\n` +
    `• /products – Browse protein products\n` +
    `• /tracked – Your tracked products\n` +
    `• /favourites – Your favourites\n\n` +
    `*Premium* 🌟\n` +
    `• /subscribe – View plans \\(₹5 / ₹10 / ₹30\\)\n` +
    `• /autoorder – Auto\\-order on restock\n` +
    `• /login – Link your Amul account\n\n` +
    `/help – All commands`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) =>
  bot.sendMessage(msg.from.id,
    `*Commands*\n\n` +
    `*Free*\n` +
    `/setpincode 680027 – Set your pincode\n` +
    `/products – All protein products\n` +
    `/products lassi – Search by name\n` +
    `/tracked – Tracked products\n` +
    `/favourites – Favourites\n` +
    `/settings – Your settings\n\n` +
    `*Premium*\n` +
    `/subscribe – Plans \\(₹5/3d · ₹10/wk · ₹30/mo\\)\n` +
    `/autoorder – Manage auto\\-orders\n` +
    `/login – Link Amul account\n` +
    `/cancel – Cancel current action`,
    { parse_mode: "MarkdownV2" }
  )
);

// ─── /setpincode ─────────────────────────────────────────────────────────────
bot.onText(/\/setpincode(?:\s+(\d{6}))?/, async (msg, match) => {
  const userId  = msg.from.id;
  const pincode = match?.[1];

  if (!pincode) return bot.sendMessage(userId, "⚠️ Usage: /setpincode 680027");

  const m    = await bot.sendMessage(userId, "🔍 Checking pincode…");
  const info = await getSubstore(pincode);
  await bot.deleteMessage(userId, m.message_id).catch(() => {});

  if (!info) {
    return bot.sendMessage(userId,
      "❌ Pincode not found or not yet serviceable by Amul\\.\nDouble\\-check and try again\\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  upsertUser(userId, { pincode, substore: info.name.toLowerCase() });
  bot.sendMessage(userId,
    `✅ Pincode set to *${esc(pincode)}* — ${esc(info.name)}\n\nUse /products to browse products in your area\\.`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /products ────────────────────────────────────────────────────────────────
bot.onText(/\/products(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from.id;
  const query  = match?.[1]?.toLowerCase().trim();
  const user   = getUser(userId);

  if (!user?.pincode) return bot.sendMessage(userId, "❗ Set your pincode first: /setpincode 680027");

  const m        = await bot.sendMessage(userId, "🔄 Fetching products…");
  const products = await fetchProducts(user.substore);
  await bot.deleteMessage(userId, m.message_id).catch(() => {});

  const list = query ? products.filter((p) => p.name.toLowerCase().includes(query)) : products;
  if (!list.length) return bot.sendMessage(userId, "No products found for that search.");

  const trackedSkus = db.prepare("SELECT sku FROM tracked     WHERE user_id = ?").all(userId).map((r) => r.sku);
  const aoSkus      = db.prepare("SELECT sku FROM auto_orders WHERE user_id = ?").all(userId).map((r) => r.sku);
  const subActive   = isSubscribed(user);

  await bot.sendMessage(userId,
    `*Amul Protein Products*\n` +
    `${esc(user.pincode)} \\(${esc(user.substore || "")}\\) · ${list.length} item${list.length !== 1 ? "s" : ""}`,
    { parse_mode: "MarkdownV2" }
  );

  for (const p of list.slice(0, 20)) {
    const inStock   = p.available && p.inventory_quantity > 0;
    const isTracked = trackedSkus.includes(p.sku);
    const isAO      = aoSkus.includes(p.sku);

    const protein = (p.metafields?.benefits || "")
      .replace(/<[^>]+>/g, " ")
      .match(/\d+\s*g[\w\s]*protein[^,\n<]*/i)?.[0]?.trim() || "—";

    const text =
      `${inStock ? "🟢" : "🔴"} *${esc(p.name)}*\n` +
      `Protein: ${esc(protein)} · ₹${p.price} · Qty: ${p.inventory_quantity ?? 0}` +
      (isTracked ? " 🔔" : "") + (isAO ? " 🤖" : "");

    const keyboard = [[
      isTracked
        ? { text: "🔕 Untrack", callback_data: `untrack:${p.sku}` }
        : { text: "🔔 Track",   callback_data: `track:${p.sku}` },
    ]];

    if (subActive) {
      keyboard.push([
        isAO
          ? { text: "🤖 Remove Auto-Order", callback_data: `removeao:${p.sku}` }
          : { text: "🤖 Add Auto-Order",    callback_data: `addao:${p.sku}` },
      ]);
    }

    keyboard.push([{ text: "🛒 Buy on Amul", url: `${AMUL_BASE}/en/product/${p.alias}` }]);

    await bot.sendMessage(userId, text, {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: keyboard },
    });
  }
});

// ─── /tracked ─────────────────────────────────────────────────────────────────
bot.onText(/\/tracked/, async (msg) => {
  const userId = msg.from.id;
  const user   = getUser(userId);
  const rows   = db.prepare("SELECT * FROM tracked WHERE user_id = ?").all(userId);

  if (!rows.length) {
    return bot.sendMessage(userId,
      "You're not tracking any products yet\\.\n\nUse /products to browse and hit 🔔 Track\\.",
      { parse_mode: "MarkdownV2" }
    );
  }

  const products  = user?.pincode ? await fetchProducts(user.substore) : [];
  const aoSkus    = db.prepare("SELECT sku FROM auto_orders WHERE user_id = ?").all(userId).map((r) => r.sku);
  const subActive = isSubscribed(user);

  await bot.sendMessage(userId, `*📋 Tracked Products \\(${rows.length}\\)*`, { parse_mode: "MarkdownV2" });

  for (const row of rows) {
    const live    = products.find((p) => p.sku === row.sku);
    const inStock = live ? live.available && live.inventory_quantity > 0 : false;
    const isAO    = aoSkus.includes(row.sku);

    const text =
      `${inStock ? "🟢" : "🔴"} *${esc(row.product)}*\n` +
      (live ? `Qty: ${live.inventory_quantity}` : "_Live data unavailable_") +
      (isAO ? " 🤖" : "");

    const keyboard = [[{ text: "🔕 Untrack", callback_data: `untrack:${row.sku}` }]];
    if (subActive) {
      keyboard.push([
        isAO
          ? { text: "🤖 Remove Auto-Order", callback_data: `removeao:${row.sku}` }
          : { text: "🤖 Add Auto-Order",    callback_data: `addao:${row.sku}` },
      ]);
    }
    if (live) keyboard.push([{ text: "🛒 Buy on Amul", url: `${AMUL_BASE}/en/product/${live.alias}` }]);

    await bot.sendMessage(userId, text, {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: keyboard },
    });
  }
});

// ─── /favourites ──────────────────────────────────────────────────────────────
bot.onText(/\/favourites/, (msg) => {
  const rows = db.prepare("SELECT product FROM tracked WHERE user_id = ?").all(msg.from.id);
  if (!rows.length) {
    return bot.sendMessage(msg.from.id, "No favourites yet\\. Track products via /products\\.", { parse_mode: "MarkdownV2" });
  }
  let text = `*⭐ Favourites*\n\n`;
  rows.forEach((r) => { text += `• ${esc(r.product)}\n`; });
  bot.sendMessage(msg.from.id, text, { parse_mode: "MarkdownV2" });
});

// ─── /settings ────────────────────────────────────────────────────────────────
bot.onText(/\/settings/, (msg) => {
  const user = getUser(msg.from.id);
  if (!user) return bot.sendMessage(msg.from.id, "No settings yet\\. Start with /start", { parse_mode: "MarkdownV2" });

  const sub = isSubscribed(user)
    ? `Active until ${new Date(user.sub_expires * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`
    : "Not subscribed — /subscribe";

  bot.sendMessage(msg.from.id,
    `*⚙️ Settings*\n\n` +
    `Pincode: ${esc(user.pincode || "Not set")}\n` +
    `Region:  ${esc(user.substore || "—")}\n` +
    `Phone:   ${esc(user.phone || "Not linked")}\n` +
    `Address: ${esc(user.address || "Not set")}\n` +
    `Plan:    ${esc(sub)}`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /subscribe ───────────────────────────────────────────────────────────────
bot.onText(/\/subscribe/, async (msg) => {
  const userId = msg.from.id;
  const user   = getUser(userId);

  if (isSubscribed(user)) {
    const expiry = new Date(user.sub_expires * 1000)
      .toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    return bot.sendMessage(userId,
      `✅ You already have an active subscription until *${esc(expiry)}*\\!\n\nUse /autoorder to manage auto\\-orders\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  bot.sendMessage(userId,
    `*🌟 Premium Plans*\n\n` +
    `Unlock auto\\-ordering — the bot places the order for you the moment a tracked product restocks\\.\n\n` +
    `Choose a plan and pay securely via Razorpay\\. Your subscription activates *automatically* right after payment — no extra steps\\.`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "3 Days — ₹5",   callback_data: "plan:3day"  }],
          [{ text: "1 Week — ₹10",  callback_data: "plan:week"  }],
          [{ text: "1 Month — ₹30", callback_data: "plan:month" }],
        ],
      },
    }
  );
});

// ─── /autoorder ───────────────────────────────────────────────────────────────
bot.onText(/\/autoorder/, async (msg) => {
  const userId = msg.from.id;
  const user   = getUser(userId);

  if (!isSubscribed(user)) {
    return bot.sendMessage(userId,
      `⭐ *Auto\\-Order* is a premium feature\\.\n\nPlans start at ₹5 for 3 days\\.`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: [[{ text: "View Plans", callback_data: "cmd:subscribe" }]] },
      }
    );
  }

  if (!user.phone) {
    return bot.sendMessage(userId,
      "📱 Link your Amul account first so the bot can add items to your cart\\.\n\nUse /login",
      {
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: [[{ text: "🔗 Link Account", callback_data: "cmd:login" }]] },
      }
    );
  }

  const rows   = db.prepare("SELECT * FROM auto_orders WHERE user_id = ?").all(userId);
  const expiry = new Date(user.sub_expires * 1000)
    .toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  let text =
    `🤖 *Auto\\-Order Settings*\n\n` +
    `Subscription: active until ${esc(expiry)}\n` +
    `Phone: ${esc(user.phone)}\n` +
    `Address: ${esc(user.address || "Not set")}\n\n`;

  if (!rows.length) {
    text += "No auto\\-orders set\\.\nUse /products or /tracked to add items\\.";
  } else {
    text += `*Active \\(${rows.length}\\):*\n`;
    rows.forEach((r) => { text += `• ${esc(r.product)}\n`; });
  }

  bot.sendMessage(userId, text, { parse_mode: "MarkdownV2" });
});

// ─── /login ───────────────────────────────────────────────────────────────────
bot.onText(/\/login/, (msg) => {
  const userId = msg.from.id;
  if (!isSubscribed(getUser(userId))) {
    return bot.sendMessage(userId, "⭐ Account linking is a premium feature\\. Use /subscribe first\\.", { parse_mode: "MarkdownV2" });
  }
  getSession(userId).state = "awaiting_phone";
  bot.sendMessage(userId,
    "📱 Enter your *10\\-digit mobile number* registered with Amul:\n\n_Send /cancel to abort_",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /cancel ─────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, (msg) => {
  clearSession(msg.from.id);
  bot.sendMessage(msg.from.id, "❌ Cancelled.");
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data   = query.data;
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data.startsWith("plan:"))     return handlePlanSelect(userId, data.slice(5));
  if (data.startsWith("track:"))    return doTrack(userId, data.slice(6));
  if (data.startsWith("untrack:"))  return doUntrack(userId, data.slice(8));
  if (data.startsWith("addao:"))    return doAddAutoOrder(userId, data.slice(6));
  if (data.startsWith("removeao:")) return doRemoveAutoOrder(userId, data.slice(9));
  if (data === "cmd:subscribe")     return bot.sendMessage(userId, "Use /subscribe to see plans.");
  if (data === "cmd:login")         return bot.sendMessage(userId, "Use /login to link your account.");
});

// ─── PLAN SELECT → Razorpay Payment Link ─────────────────────────────────────
async function handlePlanSelect(userId, plan) {
  if (!PLANS[plan]) return;
  const p = PLANS[plan];

  // Re-use an existing pending payment link if one exists
  const existing = db
    .prepare("SELECT * FROM payments WHERE user_id = ? AND plan = ? AND status = 'pending'")
    .get(userId);

  let link;
  if (existing) {
    try {
      link = await rzp.paymentLink.fetch(existing.payment_link_id);
      // If the link has already been paid or cancelled, create a new one
      if (link.status !== "created") link = null;
    } catch { link = null; }
  }

  if (!link) {
    try {
      link = await createPaymentLink(userId, plan);
    } catch (e) {
      console.error("[Razorpay] createPaymentLink:", e);
      return bot.sendMessage(userId, "❌ Could not create payment link. Please try again in a moment.");
    }
  }

  bot.sendMessage(userId,
    `💳 *${esc(p.label)} Plan — ${esc(p.display)}*\n\n` +
    `Tap the button to pay securely via Razorpay\\.\n\n` +
    `Your subscription activates *automatically* the moment payment goes through — no extra steps\\.`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[
          { text: `💳 Pay ${p.display} securely`, url: link.short_url },
        ]],
      },
    }
  );
}

// ─── TEXT HANDLER — multi-step state machine ──────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId  = msg.from.id;
  const session = getSession(userId);
  const text    = msg.text.trim();

  // ── Step 1: Phone number ───────────────────────────────────────────────────
  if (session.state === "awaiting_phone") {
    if (!/^\d{10}$/.test(text)) {
      return bot.sendMessage(userId, "⚠️ Please enter a valid 10-digit mobile number.");
    }
    const m    = await bot.sendMessage(userId, "📨 Sending OTP…");
    const resp = await amulSendOtp(text);
    await bot.deleteMessage(userId, m.message_id).catch(() => {});

    if (!resp) {
      return bot.sendMessage(userId, "❌ Failed to send OTP. Check the number and try again, or use /cancel.");
    }
    session.state      = "awaiting_otp";
    session.data.phone = text;
    return bot.sendMessage(userId, `📨 OTP sent to *+91 ${esc(text)}*\\. Enter it here:`, { parse_mode: "MarkdownV2" });
  }

  // ── Step 2: OTP ───────────────────────────────────────────────────────────
  if (session.state === "awaiting_otp") {
    const m    = await bot.sendMessage(userId, "🔐 Verifying OTP…");
    const resp = await amulVerifyOtp(session.data.phone, text);
    await bot.deleteMessage(userId, m.message_id).catch(() => {});

    if (!resp?.token) {
      return bot.sendMessage(userId, "❌ Incorrect OTP\\. Try again or use /login to restart\\.", { parse_mode: "MarkdownV2" });
    }

    upsertUser(userId, {
      phone: session.data.phone,
      amul_token: resp.token,
      amul_user_id: resp.user?._id || "",
    });

    const user    = getUser(userId);
    const address = await fetchAmulAddress(resp.token, user?.substore || "default");
    if (address) upsertUser(userId, { address });

    clearSession(userId);

    const updated = getUser(userId);
    return bot.sendMessage(userId,
      `✅ *Amul account linked\\!*\n\n` +
      `Phone: ${esc(updated.phone)}\n` +
      `Address: ${esc(updated.address || "Not set — update at shop\\.amul\\.com")}\n\n` +
      `Use /autoorder to configure auto\\-ordering\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ─── TRACK / UNTRACK / AUTO-ORDER helpers ────────────────────────────────────
async function doTrack(userId, sku) {
  const user = getUser(userId);
  if (!user?.pincode) return bot.sendMessage(userId, "Set your pincode first: /setpincode");
  const products = await fetchProducts(user.substore);
  const p        = products.find((x) => x.sku === sku);
  if (!p) return bot.sendMessage(userId, "Product not found.");
  db.prepare("INSERT OR IGNORE INTO tracked (user_id, sku, product) VALUES (?, ?, ?)").run(userId, sku, p.name);
  bot.sendMessage(userId,
    `🔔 *Tracking:* ${esc(p.name)}\n\nYou'll get a notification when it restocks\\.`,
    { parse_mode: "MarkdownV2" }
  );
}

async function doUntrack(userId, sku) {
  const row = db.prepare("SELECT product FROM tracked WHERE user_id = ? AND sku = ?").get(userId, sku);
  db.prepare("DELETE FROM tracked     WHERE user_id = ? AND sku = ?").run(userId, sku);
  db.prepare("DELETE FROM auto_orders WHERE user_id = ? AND sku = ?").run(userId, sku);
  bot.sendMessage(userId, `🔕 Stopped tracking: ${row?.product || sku}`);
}

async function doAddAutoOrder(userId, sku) {
  const user = getUser(userId);
  if (!isSubscribed(user)) return bot.sendMessage(userId, "⭐ Auto-Order is premium. Use /subscribe.");
  if (!user.phone)          return bot.sendMessage(userId, "📱 Link your Amul account first: /login");
  const products = await fetchProducts(user.substore);
  const p        = products.find((x) => x.sku === sku);
  if (!p) return bot.sendMessage(userId, "Product not found.");
  db.prepare("INSERT OR IGNORE INTO auto_orders (user_id, sku, product) VALUES (?, ?, ?)").run(userId, sku, p.name);
  db.prepare("INSERT OR IGNORE INTO tracked    (user_id, sku, product) VALUES (?, ?, ?)").run(userId, sku, p.name);
  bot.sendMessage(userId, `🤖 Auto-Order enabled for: *${esc(p.name)}*`, { parse_mode: "MarkdownV2" });
}

async function doRemoveAutoOrder(userId, sku) {
  const row = db.prepare("SELECT product FROM auto_orders WHERE user_id = ? AND sku = ?").get(userId, sku);
  db.prepare("DELETE FROM auto_orders WHERE user_id = ? AND sku = ?").run(userId, sku);
  bot.sendMessage(userId, `🤖 Auto-Order removed for: ${row?.product || sku}`);
}

// ─── STOCK CHECKER — every 5 minutes ─────────────────────────────────────────
cron.schedule("*/5 * * * *", async () => {
  console.log("[Cron] Stock check started");

  // Fetch each unique substore's product list just once per run
  const substoreProducts = {};

  const allTracked = db.prepare(`
    SELECT t.user_id, t.sku, t.product, t.last_seen,
           u.substore, u.amul_token, u.sub_expires
    FROM   tracked t
    JOIN   users   u ON t.user_id = u.user_id
    WHERE  u.pincode IS NOT NULL
  `).all();

  for (const row of allTracked) {
    const key = row.substore || "default";
    if (!substoreProducts[key]) {
      substoreProducts[key] = await fetchProducts(row.substore);
    }
  }

  for (const row of allTracked) {
    const products = substoreProducts[row.substore || "default"] || [];
    const p        = products.find((x) => x.sku === row.sku);
    if (!p) continue;

    const inStock = p.available && p.inventory_quantity > 0;
    const nowSec  = Math.floor(Date.now() / 1000);
    // last_seen = 0 means OOS; a recent timestamp means it was in stock last check
    const wasOOS  = !row.last_seen;

    if (inStock) {
      if (wasOOS) {
        // ── Send restock notification ───────────────────────────────────
        try {
          await bot.sendMessage(row.user_id,
            `🟢 *Back in Stock\\!*\n\n` +
            `*${esc(p.name)}*\n` +
            `Qty: ${p.inventory_quantity} · Price: ₹${p.price}`,
            {
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: [[
                  { text: "🛒 Buy Now", url: `${AMUL_BASE}/en/product/${p.alias}` },
                ]],
              },
            }
          );
        } catch (e) {
          console.error("[Cron] Notify error:", row.user_id, e.message);
        }

        // ── Auto-order if eligible ──────────────────────────────────────
        const ao        = db.prepare("SELECT 1 FROM auto_orders WHERE user_id = ? AND sku = ?").get(row.user_id, row.sku);
        const subActive = row.sub_expires && row.sub_expires > nowSec;

        if (ao && subActive && row.amul_token) {
          const result = await addToCart(row.amul_token, row.substore, p.alias);
          if (result) {
            try {
              await bot.sendMessage(row.user_id,
                `🤖 *Auto\\-Order:* Added *${esc(p.name)}* to your Amul cart\\!\n\n` +
                `[Complete your order →](${AMUL_BASE}/en/checkout)`,
                { parse_mode: "MarkdownV2" }
              );
            } catch { /* ignore */ }
          }
        }
      }

      // Mark as in-stock
      db.prepare("UPDATE tracked SET last_seen = ? WHERE user_id = ? AND sku = ?")
        .run(nowSec, row.user_id, row.sku);

    } else if (row.last_seen) {
      // Just went out of stock — clear last_seen so next restock triggers notification
      db.prepare("UPDATE tracked SET last_seen = 0 WHERE user_id = ? AND sku = ?")
        .run(row.user_id, row.sku);
    }
  }

  console.log("[Cron] Done");
});

console.log("🚀 Amul Stock Bot running");
