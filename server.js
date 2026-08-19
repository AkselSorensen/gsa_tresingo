require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const crypto = require("crypto");
const Stripe = require("stripe");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT) || 3000;
const discordInvite = "https://discord.gg/ZbCrwE73uK";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@gstore.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin1234!";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const STEAM_API_KEY = process.env.STEAM_API_KEY || "";
const VERCEL_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const APP_BASE_URL = process.env.APP_BASE_URL || (VERCEL_URL ? `https://${VERCEL_URL}` : (process.env.NODE_ENV === "production" ? "https://gsa-tresingo.vercel.app" : `http://localhost:${port}`));
const BASE_URL_COMPUTED = APP_BASE_URL;

const STEAM_REALM = process.env.STEAM_REALM || BASE_URL_COMPUTED;
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL || `${BASE_URL_COMPUTED}/auth/steam/callback`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || "";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Identifier le compte Stripe propriétaire des clés (mode + ID) pour vérifier
// que le dashboard regardé est le bon. Ne log jamais la clé elle-même.
if (stripe) {
  const mode = STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "TEST";
  stripe.account.retrieve()
    .then((acc) => console.log(`[startup] Stripe: mode=${mode} account=${acc.id} email=${acc.email || "?"}`))
    .catch((e) => console.log(`[startup] Stripe: mode=${mode} account retrieval failed: ${e.message}`));
}
const PLATFORM_COMMISSION_PERCENT = Math.min(
  100,
  Math.max(0, Number(process.env.PLATFORM_COMMISSION_PERCENT || 15))
);
console.log('[startup] PLATFORM_COMMISSION_PERCENT =', PLATFORM_COMMISSION_PERCENT, '(env:', process.env.PLATFORM_COMMISSION_PERCENT, ')');

// R2 (Cloudflare) pour les téléchargements
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const R2_ENDPOINT = process.env.R2_ENDPOINT || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "gca-files";

const r2Client = (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow any origin (reflected) - nécessaire pour credentials: include
    callback(null, origin);
  },
  credentials: true,
}));
// Stripe webhook needs the RAW body — parse it BEFORE the global JSON parser
// (otherwise express.json() consumes the stream and the signature check always 400s)
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
// Trust proxy is required if you are behind a reverse proxy like Vercel
// so that the secure cookies (if enabled) are properly sent.
app.set("trust proxy", 1);

app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);
app.use(express.static(path.join(__dirname)));

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    slug: row.slug,
    role: row.role,
    avatarUrl: row.avatar_url,
    preferredLanguage: row.preferred_language,
    discordId: row.discord_id || null,
    steamId: row.steam_id || null,
    stripeAccountId: row.stripe_account_id || null,
    createdAt: row.created_at,
  };
}

function buildWhereClause(query = {}) {
  const clauses = [];
  const values = [];
  let index = 1;

  if (query.search) {
    clauses.push(
      `(p.title ILIKE $${index} OR p.short_description ILIKE $${index} OR p.description ILIKE $${index} OR array_to_string(p.tags, ' ') ILIKE $${index})`
    );
    values.push(`%${query.search}%`);
    index += 1;
  }

  if (query.category) {
    clauses.push(`c.slug = $${index}`);
    values.push(String(query.category));
    index += 1;
  }

  if (query.tag) {
    clauses.push(`$${index} = ANY(p.tags)`);
    values.push(String(query.tag));
    index += 1;
  }

  if (query.discount === "true") {
    clauses.push(`p.discount_percent > 0`);
  }

  if (query.price_min) {
    clauses.push(`p.price >= $${index}`);
    values.push(Number(query.price_min));
    index += 1;
  }
  if (query.price_max) {
    clauses.push(`p.price <= $${index}`);
    values.push(Number(query.price_max));
    index += 1;
  }

  if (query.rating) {
    clauses.push(`p.rating >= $${index}`);
    values.push(Number(query.rating));
    index += 1;
  }

  clauses.push(`p.is_hidden = FALSE`);

  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function mapProduct(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    shortDescription: row.short_description,
    description: row.description,
    installation: row.installation,
    price: Number(row.price),
    oldPrice: Number(row.old_price || row.price),
    discountPercent: row.discount_percent,
    rating: Number(row.rating),
    reviewCount: row.review_count,
    views: row.views,
    isTrending: row.is_trending,
    isFeatured: row.is_featured,
    isNew: row.is_new,
    popularityScore: row.popularity_score,
    sellerName: row.seller_name,
    sellerSlug: row.seller_slug,
    sellerAvatar: row.seller_avatar,
    category: row.category_name,
    categorySlug: row.category_slug,
    tags: row.tags || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    media: row.media || [],
  };
}

async function getProductBySlug(slug, userId = null) {
  const result = await pool.query(
    `
      SELECT
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        s.display_name AS seller_name,
        s.slug AS seller_slug,
        s.avatar_url AS seller_avatar,
        COALESCE(
          json_agg(
            json_build_object(
              'id', pm.id,
              'type', pm.media_type,
              'url', pm.url,
              'thumbnail', pm.thumbnail_url,
              'sortOrder', pm.sort_order
            )
            ORDER BY pm.sort_order ASC, pm.id ASC
          ) FILTER (WHERE pm.id IS NOT NULL),
          '[]'::json
        ) AS media
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN users s ON s.id = p.seller_id
      LEFT JOIN product_media pm ON pm.product_id = p.id
      WHERE p.slug = $1
      GROUP BY p.id, c.name, c.slug, s.display_name, s.slug, s.avatar_url
      LIMIT 1
    `,
    [slug]
  );

  if (!result.rowCount) {
    return null;
  }

  const product = mapProduct(result.rows[0]);

  const reviewsResult = await pool.query(
    `
      SELECT
        r.id,
        r.rating,
        r.comment,
        r.created_at,
        r.user_id,
        u.display_name,
        u.avatar_url
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      WHERE r.product_id = $1
      ORDER BY r.created_at DESC
    `,
    [product.id]
  );

  product.reviews = reviewsResult.rows.map((review) => ({
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    displayName: review.display_name,
    avatarUrl: review.avatar_url,
    createdAt: review.created_at,
    mine: userId ? review.user_id === userId : false,
  }));

  return product;
}

async function getCart(userId) {
  const cartResult = await pool.query(
    `
      SELECT id
      FROM carts
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  let cartId;

  if (!cartResult.rowCount) {
    const inserted = await pool.query(
      `
        INSERT INTO carts (user_id)
        VALUES ($1)
        RETURNING id
      `,
      [userId]
    );
    cartId = inserted.rows[0].id;
  } else {
    cartId = cartResult.rows[0].id;
  }

  const itemsResult = await pool.query(
    `
      SELECT
        ci.id,
        ci.quantity,
        p.id AS product_id,
        p.slug,
        p.title,
        p.price,
        p.old_price,
        p.discount_percent,
        COALESCE(
          (
            SELECT json_build_object(
              'type', pm.media_type,
              'url', pm.url,
              'thumbnail', pm.thumbnail_url
            )
            FROM product_media pm
            WHERE pm.product_id = p.id
            ORDER BY pm.sort_order ASC, pm.id ASC
            LIMIT 1
          ),
          '{}'::json
        ) AS preview
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.id DESC
    `,
    [cartId]
  );

  const items = itemsResult.rows.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    product: {
      id: item.product_id,
      slug: item.slug,
      title: item.title,
      price: Number(item.price),
      oldPrice: Number(item.old_price),
      discountPercent: item.discount_percent,
      preview: item.preview,
    },
    subtotal: Number(item.price) * item.quantity,
  }));

  return {
    id: cartId,
    items,
    total: items.reduce((sum, item) => sum + item.subtotal, 0),
  };
}

async function syncClientCart(userId, clientItems) {
  if (!Array.isArray(clientItems) || !clientItems.length) return;
  const cart = await getCart(userId);
  await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.id]);
  for (const item of clientItems) {
    const slug = (typeof item === "string" ? item : String(item?.slug || "")).trim();
    if (!slug) continue;
    const prodResult = await pool.query(
      `SELECT id FROM products WHERE slug = $1 AND is_hidden = FALSE LIMIT 1`,
      [slug]
    );
    if (prodResult.rowCount) {
      const qty = Math.max(1, Number(item?.quantity || 1));
      await pool.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
        [cart.id, prodResult.rows[0].id, qty]
      );
    }
  }
}

function normalizePromoCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 40);
}

// Stripe rejette les data: URLs dans product_data.images → ne passer que des URLs http(s)
function stripeSafeImage(url) {
  return url && typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function generatePromoCode(prefix = "AMB") {
  const safePrefix = normalizePromoCode(prefix).slice(0, 12) || "AMB";
  return `${safePrefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function calculatePromoDiscount(cartTotal, promo) {
  const total = Math.max(0, Number(cartTotal || 0));
  if (!promo || total <= 0) {
    return 0;
  }

  const value = Math.max(0, Number(promo.discount_value || 0));
  const rawDiscount = promo.discount_type === "fixed" ? value : total * (Math.min(100, value) / 100);
  return Math.min(total, Math.round(rawDiscount * 100) / 100);
}

async function getValidPromoForCart(code, cartTotal) {
  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) {
    return { promo: null, discountAmount: 0, finalTotal: Number(cartTotal || 0) };
  }

  const promoResult = await pool.query(
    `
      SELECT *
      FROM promo_codes
      WHERE code = $1
        AND is_active = TRUE
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at >= NOW())
        AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
      LIMIT 1
    `,
    [normalizedCode]
  );

  if (!promoResult.rowCount) {
    return null;
  }

  const promo = promoResult.rows[0];
  const discountAmount = calculatePromoDiscount(cartTotal, promo);
  const finalTotal = Math.max(0, Number(cartTotal || 0) - discountAmount);

  return {
    promo,
    discountAmount,
    finalTotal: Math.round(finalTotal * 100) / 100,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user?.id) {
    return res.status(401).json({ message: "Authentication required" });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(401).json({ message: "Admin access required" });
  }

  next();
}

async function maintenanceMiddleware(req, res, next) {
  // Always allow API routes for login, bootstrap (to check session), and admin bypass
  const bypassRoutes = [
    "/api/auth/login",
    "/api/auth/logout",
    "/auth/admin/login",
    "/auth/discord",
    "/auth/discord/callback",
    "/auth/steam",
    "/auth/steam/callback",
    "/api/me",
    "/login.html",
    "/maintenance.html",
    "/style.css",
    "/script.js",
    "/admin"
  ];

  if (bypassRoutes.some(route => req.path === route || req.path.startsWith(route))) {
    return next();
  }

  // Allow static assets
  if (req.path.startsWith("/asset/") || req.path.startsWith("/components/")) {
    return next();
  }

  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'maintenance_mode'`);
    const isMaintenance = result.rows[0]?.value === "true";

    if (isMaintenance) {
      const user = req.session.user;
      
      // Allow admins to bypass maintenance
      // Note: we can't always bypass just based on session if the page is requested directly 
      // without session loaded yet by express, but express-session runs before this middleware,
      // so req.session.user should be available.
      if (user && user.role === "admin") {
        return next();
      }

      // If it's an API request, return 503
      if (req.path.startsWith("/api/")) {
        return res.status(503).json({ message: "Service en maintenance", maintenance: true });
      }

      // Otherwise redirect to maintenance page
      return res.redirect("/maintenance.html");
    }

    next();
  } catch (error) {
    console.error("Maintenance check error:", error);
    next(); // Fail open if DB is down? Or fail closed? Usually fail open is safer to avoid full lockout.
  }
}

app.use(maintenanceMiddleware);

async function initializeDatabase() {
  // Migrations récentes isolées : s'exécutent même si le gros bloc historique ci-dessous échoue
  await pool.query(`
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_id TEXT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_error TEXT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_fee_amount NUMERIC NOT NULL DEFAULT 0;
  `);

  // Réparation des seller_net_amount (division entière historique)
  await pool.query(`
    UPDATE order_items
    SET seller_net_amount = ROUND((price * quantity * (1 - platform_fee_percent::numeric / 100))::numeric, 2)
    WHERE seller_net_amount = price * quantity
      AND platform_fee_percent > 0;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'customer',
      avatar_url TEXT,
      discord_id TEXT UNIQUE,
      steam_id TEXT UNIQUE,
      stripe_account_id TEXT,
      preferred_language TEXT NOT NULL DEFAULT 'fr',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      short_description TEXT NOT NULL,
      description TEXT NOT NULL,
      installation TEXT NOT NULL,
      price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
      old_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
      discount_percent INTEGER NOT NULL DEFAULT 0,
      rating NUMERIC(3, 2) NOT NULL DEFAULT 5,
      review_count INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      tags TEXT[] NOT NULL DEFAULT '{}',
      is_trending BOOLEAN NOT NULL DEFAULT FALSE,
      is_featured BOOLEAN NOT NULL DEFAULT FALSE,
      is_new BOOLEAN NOT NULL DEFAULT FALSE,
      is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
      popularity_score INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT NOT NULL DEFAULT '';

    UPDATE products p
    SET category = COALESCE(NULLIF(category, ''), c.name)
    FROM categories c
    WHERE c.id = p.category_id
      AND COALESCE(p.category, '') = '';

    UPDATE products
    SET
      title = COALESCE(NULLIF(title, ''), name),
      name = COALESCE(NULLIF(name, ''), title)
    WHERE COALESCE(title, '') = '' OR COALESCE(name, '') = '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS installation TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS price NUMERIC(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS old_price NUMERIC(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(3, 2) NOT NULL DEFAULT 5;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS views INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_trending BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_new BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS popularity_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_description TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_tag TEXT NOT NULL DEFAULT '';

    -- Suivi des transfers Stripe Connect vers les vendeurs (pattern separate charges and transfers)
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_id TEXT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_error TEXT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_fee_amount NUMERIC NOT NULL DEFAULT 0;

    -- Réparation : la division entière SQL (1 - pct / 100 = 1) avait stocké seller_net_amount = prix plein
    UPDATE order_items
    SET seller_net_amount = ROUND((price * quantity * (1 - platform_fee_percent::numeric / 100))::numeric, 2)
    WHERE seller_net_amount = price * quantity
      AND platform_fee_percent > 0;

    CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_unique_idx ON users(discord_id) WHERE discord_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_steam_id_unique_idx ON users(steam_id) WHERE steam_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS products_slug_unique_idx ON products(slug);

    CREATE TABLE IF NOT EXISTS product_media (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
      url TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    -- Un seul avis par utilisateur et par produit : on supprime les doublons éventuels
    -- avant de créer l'index unique.
    DELETE FROM reviews a
    USING reviews b
    WHERE a.id > b.id AND a.user_id = b.user_id AND a.product_id = b.product_id;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user_product ON reviews(user_id, product_id);

    CREATE TABLE IF NOT EXISTS carts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      UNIQUE(cart_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_landing_config (
      id SERIAL PRIMARY KEY,
      section_key TEXT NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      metadata JSONB DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid varchar NOT NULL COLLATE "default",
      sess json NOT NULL,
      expire timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON user_sessions ("expire");

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      stripe_session_id TEXT UNIQUE,
      total_amount NUMERIC(10, 2) NOT NULL,
      subtotal_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      promo_code_id INTEGER,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code_id INTEGER;

    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      ambassador_name TEXT NOT NULL DEFAULT '',
      ambassador_contact TEXT NOT NULL DEFAULT '',
      discount_type TEXT NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent', 'fixed')),
      discount_value NUMERIC(10, 2) NOT NULL CHECK (discount_value >= 0),
      points_per_redemption INTEGER NOT NULL DEFAULT 1,
      points_balance INTEGER NOT NULL DEFAULT 0,
      points_redeemed INTEGER NOT NULL DEFAULT 0,
      reward_note TEXT NOT NULL DEFAULT '',
      max_redemptions INTEGER,
      redeemed_count INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id SERIAL PRIMARY KEY,
      promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      order_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS ambassador_contact TEXT NOT NULL DEFAULT '';
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS points_per_redemption INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS points_balance INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS points_redeemed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS reward_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS order_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS points_awarded INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
    CREATE INDEX IF NOT EXISTS promo_redemptions_promo_code_id_idx ON promo_redemptions(promo_code_id);

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      seller_id INTEGER NOT NULL REFERENCES users(id),
      price NUMERIC(10, 2) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      customer_email TEXT,
      platform_fee_percent NUMERIC(5, 2) NOT NULL DEFAULT 15,
      platform_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      seller_net_amount NUMERIC(10, 2) NOT NULL DEFAULT 0
    );

    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5, 2) NOT NULL DEFAULT 15;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS seller_net_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;

    UPDATE order_items
    SET
      platform_fee_percent = COALESCE(NULLIF(platform_fee_percent, 0), 15),
      platform_fee_amount = CASE
        WHEN platform_fee_amount = 0 THEN ROUND((price * quantity * COALESCE(NULLIF(platform_fee_percent, 0), 15) / 100)::numeric, 2)
        ELSE platform_fee_amount
      END,
      seller_net_amount = CASE
        WHEN seller_net_amount = 0 THEN ROUND((price * quantity * (1 - COALESCE(NULLIF(platform_fee_percent, 0), 15)::numeric / 100))::numeric, 2)
        ELSE seller_net_amount
      END;
  `);

  // Table pour les fichiers produits (liés au R2)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_files (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,
      is_main BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Colonne download_count sur order_items
  try {
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS download_count INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {}

  await pool.query(
    `
      INSERT INTO settings (key, value)
      VALUES ('maintenance_mode', 'false')
      ON CONFLICT (key) DO NOTHING
    `
  );

  const adminSlug = slugify(ADMIN_EMAIL.split("@")[0] || "admin");
  await pool.query(
    `
      INSERT INTO users (email, password_hash, display_name, slug, role, preferred_language)
      VALUES ($1, $2, $3, $4, 'admin', 'fr')
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          display_name = EXCLUDED.display_name,
          slug = EXCLUDED.slug,
          role = 'admin'
    `,
    [ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), "GSA Admin", adminSlug]
  );

  const categories = [
    ["3D Model", "3d-model", "Bâtiments, armes, props, playermodels et ambiance.", 1],
    ["3D Import", "3d-import", "Intégration et optimisation d’assets pour GMod.", 2],
    ["Particle", "particle", "Effets visuels, atmosphères, impacts et feedback.", 3],
    ["Animation", "animation", "Animations personnage, armes, cinématiques et interactions.", 4],
    ["UI", "ui", "Interfaces premium, HUD, menus et panels administratifs.", 5],
    ["Map", "map", "Zones jouables, intérieurs, hubs et maps complètes.", 6],
  ];

  for (const [name, slug, description, sortOrder] of categories) {
    await pool.query(
      `
        INSERT INTO categories (name, slug, description, sort_order)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            sort_order = EXCLUDED.sort_order
      `,
      [name, slug, description, sortOrder]
    );
  }

  const sellers = [
    {
      email: "tresingo@gsa.local",
      password: "Tresingo123!",
      displayName: "Tresingo",
      slug: "tresingo",
      avatar: "https://images.unsplash.com/photo-1527980965255-d3b416303d12?auto=format&fit=crop&w=120&q=80",
    },
    {
      email: "atelier@gsa.local",
      password: "Atelier123!",
      displayName: "Atelier Nova",
      slug: "atelier-nova",
      avatar: "https://images.unsplash.com/photo-1544723795-3fb6469f5b39?auto=format&fit=crop&w=120&q=80",
    },
    {
      email: "hexa@gsa.local",
      password: "Hexa123!",
      displayName: "Hexa Studio",
      slug: "hexa-studio",
      avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=120&q=80",
    },
  ];

  for (const seller of sellers) {
    await pool.query(
      `
        INSERT INTO users (email, password_hash, display_name, slug, role, avatar_url, preferred_language)
        VALUES ($1, $2, $3, $4, 'seller', $5, 'fr')
        ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            display_name = EXCLUDED.display_name,
            slug = EXCLUDED.slug,
            role = 'seller',
            avatar_url = EXCLUDED.avatar_url
      `,
      [seller.email, hashPassword(seller.password), seller.displayName, seller.slug, seller.avatar]
    );
  }

  const productCount = await pool.query(`SELECT COUNT(*)::int AS count FROM products`);
  if (productCount.rows[0].count > 0) {
    return;
  }

  const categoryMap = Object.fromEntries(
    (await pool.query(`SELECT id, slug FROM categories`)).rows.map((row) => [row.slug, row.id])
  );

  const sellerMap = Object.fromEntries(
    (await pool.query(`SELECT id, slug FROM users WHERE role IN ('seller', 'admin')`)).rows.map((row) => [row.slug, row.id])
  );

  const products = [
    {
      sellerSlug: "tresingo",
      categorySlug: "3d-model",
      title: "Pack Bâtiments Industriels",
      shortDescription: "Pack de structures industrielles optimisées pour univers RP et semi-réalistes.",
      description:
        "Un ensemble complet de bâtiments industriels pour Garry's Mod avec variantes jour/nuit, collisions propres et matériaux optimisés. Pensé pour les serveurs cherchant un rendu crédible sans sacrifier les performances.",
      installation:
        "1. Glisser le dossier dans votre addon server.\n2. Monter les ressources requises.\n3. Vérifier le workshop collection.\n4. Relancer la map ou le serveur.",
      price: 89,
      oldPrice: 119,
      discountPercent: 25,
      rating: 4.9,
      reviewCount: 48,
      views: 1382,
      tags: ["reduction", "batiment", "industriel", "rp"],
      isTrending: true,
      isFeatured: true,
      isNew: false,
      popularityScore: 98,
      media: [
        {
          type: "video",
          url: "https://www.w3schools.com/html/mov_bbb.mp4",
          thumbnail: "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=900&q=80",
        },
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=400&q=80",
        },
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "atelier-nova",
      categorySlug: "animation",
      title: "Animation Pack Tactical",
      shortDescription: "Animations FPS premium pour armes, déplacements et interactions contextuelles.",
      description:
        "Ce pack apporte des animations fluides et cohérentes pour armes longues, pistolets, entrées en véhicule, interactions contextuelles et états blessés. Idéal pour moderniser la sensation de gameplay.",
      installation:
        "1. Déployer les fichiers d'animation.\n2. Associer les séquences dans votre base.\n3. Recompiler si nécessaire.\n4. Tester les conflits avec vos sweps.",
      price: 64,
      oldPrice: 64,
      discountPercent: 0,
      rating: 4.8,
      reviewCount: 71,
      views: 1844,
      tags: ["tendance", "animation", "fps", "premium"],
      isTrending: true,
      isFeatured: true,
      isNew: true,
      popularityScore: 95,
      media: [
        {
          type: "video",
          url: "https://www.w3schools.com/html/movie.mp4",
          thumbnail: "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=900&q=80",
        },
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "hexa-studio",
      categorySlug: "particle",
      title: "Pack Particules Combat",
      shortDescription: "Effets d’impact, fumées, traces et feedback visuels pour gunfight nerveux.",
      description:
        "Des particules calibrées pour rendre les affrontements plus lisibles et plus satisfaisants : impacts de balles, fumées d'armes, traces, poussière et effets environnementaux.",
      installation:
        "1. Copier les fichiers particle.\n2. Enregistrer les manifestes.\n3. Tester sur map de staging.\n4. Ajuster les CVars si besoin.",
      price: 34,
      oldPrice: 44,
      discountPercent: 22,
      rating: 4.7,
      reviewCount: 39,
      views: 1120,
      tags: ["reduction", "particle", "combat", "fx"],
      isTrending: false,
      isFeatured: false,
      isNew: true,
      popularityScore: 77,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1518709268805-4e9042af2176?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1518709268805-4e9042af2176?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "tresingo",
      categorySlug: "ui",
      title: "HUD Opérationnel GSA",
      shortDescription: "HUD moderne avec notifications, état du joueur et zones contextuelles.",
      description:
        "Une interface utilisateur complète inspirée des standards premium : lisibilité, retours visuels nets, support RP et personnalisation poussée pour serveurs sérieux.",
      installation:
        "1. Importer le module UI.\n2. Configurer les couleurs et logos.\n3. Brancher vos hooks gameplay.\n4. Tester en résolution 1080p et ultrawide.",
      price: 49,
      oldPrice: 69,
      discountPercent: 28,
      rating: 4.9,
      reviewCount: 86,
      views: 2041,
      tags: ["ui", "reduction", "hud", "interface"],
      isTrending: true,
      isFeatured: false,
      isNew: false,
      popularityScore: 99,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "atelier-nova",
      categorySlug: "map",
      title: "Hub Commercial Urbain",
      shortDescription: "Zone centrale multi-usage pour serveurs RP avec optimisation serveur.",
      description:
        "Map compacte mais dense, pensée pour concentrer l'activité des joueurs et fluidifier les interactions sociales, les commerces et les services publics.",
      installation:
        "1. Déposer le BSP.\n2. Monter les contenus requis.\n3. Configurer les points de spawn.\n4. Vérifier la navigation NPC.",
      price: 74,
      oldPrice: 74,
      discountPercent: 0,
      rating: 4.6,
      reviewCount: 22,
      views: 964,
      tags: ["map", "urbain", "rp"],
      isTrending: false,
      isFeatured: false,
      isNew: true,
      popularityScore: 69,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "hexa-studio",
      categorySlug: "3d-import",
      title: "Import Véhicules Civils",
      shortDescription: "Lot de véhicules optimisés avec LOD, collisions propres et variantes.",
      description:
        "Import complet de véhicules civils utilisables dans des contextes RP modernes. Optimisés pour la fluidité, compatibles avec les principaux systèmes de conduite.",
      installation:
        "1. Importer les modèles.\n2. Relier aux scripts véhicules.\n3. Vérifier les collisions.\n4. Ajuster les lights et skins.",
      price: 58,
      oldPrice: 79,
      discountPercent: 27,
      rating: 4.5,
      reviewCount: 31,
      views: 880,
      tags: ["3d-import", "vehicule", "reduction"],
      isTrending: false,
      isFeatured: false,
      isNew: false,
      popularityScore: 73,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "tresingo",
      categorySlug: "3d-model",
      title: "Pack Armes SWEP Premium",
      shortDescription: "Set cohérent d’armes stylisées avec vues monde et première personne.",
      description:
        "Une collection d'armes prêtes à l'emploi avec skins, meshes retravaillés et intégration facile dans vos bases SWEP existantes.",
      installation:
        "1. Copier les modèles.\n2. Associer aux SWEPs.\n3. Vérifier les attaches.\n4. Tester les vues monde et first person.",
      price: 69,
      oldPrice: 89,
      discountPercent: 22,
      rating: 4.8,
      reviewCount: 54,
      views: 1430,
      tags: ["tendance", "arme", "model", "reduction"],
      isTrending: true,
      isFeatured: false,
      isNew: false,
      popularityScore: 88,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1511882150382-421056c89033?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1511882150382-421056c89033?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "atelier-nova",
      categorySlug: "ui",
      title: "Menu Administration Serveur",
      shortDescription: "Panel de gestion lisible pour équipes staff et modération avancée.",
      description:
        "Un menu d'administration pensé pour la rapidité d'exécution, avec une hiérarchie visuelle claire et une expérience confortable pour les équipes staff.",
      installation:
        "1. Déployer le panel.\n2. Mapper les permissions.\n3. Relier les actions serveur.\n4. Vérifier les logs.",
      price: 42,
      oldPrice: 55,
      discountPercent: 24,
      rating: 4.4,
      reviewCount: 19,
      views: 610,
      tags: ["ui", "staff", "admin", "reduction"],
      isTrending: false,
      isFeatured: false,
      isNew: true,
      popularityScore: 61,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1555949963-aa79dcee981c?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1555949963-aa79dcee981c?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "hexa-studio",
      categorySlug: "animation",
      title: "Pack Gestuelles RP",
      shortDescription: "Animations sociales et interactions pour enrichir la présence en jeu.",
      description:
        "Gestuelles simples, professionnelles et immersives pour améliorer les interactions RP, cérémonies, discussions et mises en scène serveur.",
      installation:
        "1. Importer les animations.\n2. Mapper les raccourcis.\n3. Vérifier les conflits de skeleton.\n4. Tester en jeu.",
      price: 29,
      oldPrice: 29,
      discountPercent: 0,
      rating: 4.3,
      reviewCount: 14,
      views: 402,
      tags: ["animation", "rp", "social"],
      isTrending: false,
      isFeatured: false,
      isNew: false,
      popularityScore: 53,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
    {
      sellerSlug: "tresingo",
      categorySlug: "map",
      title: "Intérieurs Commissariat",
      shortDescription: "Pack d’intérieurs modulaires pour postes de police et zones d’enquête.",
      description:
        "Une solution modulaire pour créer rapidement un commissariat cohérent avec salles d'interrogatoire, bureaux, armurerie et zones de rétention.",
      installation:
        "1. Importer les modules.\n2. Positionner selon votre layout.\n3. Générer les navmeshes.\n4. Tester la circulation.",
      price: 55,
      oldPrice: 72,
      discountPercent: 24,
      rating: 4.7,
      reviewCount: 27,
      views: 1008,
      tags: ["map", "interieur", "police", "reduction"],
      isTrending: true,
      isFeatured: false,
      isNew: true,
      popularityScore: 84,
      media: [
        {
          type: "image",
          url: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1400&q=80",
          thumbnail: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=400&q=80",
        },
      ],
    },
  ];

  for (const product of products) {
    const slug = slugify(product.title);

    const insertedProduct = await pool.query(
      `
        INSERT INTO products (
          seller_id,
          category_id,
          category,
          name,
          title,
          slug,
          short_description,
          description,
          installation,
          price,
          old_price,
          discount_percent,
          rating,
          review_count,
          views,
          tags,
          is_trending,
          is_featured,
          is_new,
          popularity_score
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING id
      `,
      [
        sellerMap[product.sellerSlug],
        categoryMap[product.categorySlug],
        categories.find((entry) => entry[1] === product.categorySlug)?.[0] || product.categorySlug,
        product.title,
        product.title,
        slug,
        product.shortDescription,
        product.description,
        product.installation,
        product.price,
        product.oldPrice,
        product.discountPercent,
        product.rating,
        product.reviewCount,
        product.views,
        product.tags,
        product.isTrending,
        product.isFeatured,
        product.isNew,
        product.popularityScore,
      ]
    );

    for (let index = 0; index < product.media.length; index += 1) {
      const media = product.media[index];
      await pool.query(
        `
          INSERT INTO product_media (product_id, media_type, url, thumbnail_url, sort_order)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [insertedProduct.rows[0].id, media.type, media.url, media.thumbnail, index]
      );
    }
  }

  const customer = await pool.query(
    `
      INSERT INTO users (email, password_hash, display_name, slug, role, preferred_language)
      VALUES ($1, $2, $3, $4, 'customer', 'fr')
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          display_name = EXCLUDED.display_name
      RETURNING id
    `,
    ["client@gsa.local", hashPassword("Client123!"), "Client Démo", "client-demo"]
  );

  const productRows = await pool.query(`SELECT id FROM products ORDER BY id ASC LIMIT 3`);
  for (const product of productRows.rows) {
    await pool.query(
      `
        INSERT INTO reviews (product_id, user_id, rating, comment)
        VALUES ($1, $2, $3, $4)
      `,
      [
        product.id,
        customer.rows[0].id,
        5,
        "Très bonne qualité, documentation claire et intégration propre sur notre serveur.",
      ]
    );
  }
}

app.get("/api/health", async (_req, res) => {
  try {
    const dbResult = await pool.query("SELECT NOW() AS now");
    res.json({
      ok: true,
      database: "connected",
      time: dbResult.rows[0].now,
    });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      ok: false,
      message: "Database connection failed",
    });
  }
});

app.get("/api/bootstrap", async (req, res) => {
  try {
    const [categories, trending, discounts, featured, stats] = await Promise.all([
      pool.query(`SELECT c.name, c.slug, c.description, COALESCE(COUNT(p.id), 0)::int AS "productCount" FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.is_hidden = FALSE GROUP BY c.name, c.slug, c.description, c.sort_order ORDER BY c.sort_order ASC, c.name ASC`),
      pool.query(
        `
          SELECT
            p.id,
            p.slug,
            p.title,
            p.short_description,
            p.price,
            p.old_price AS "oldPrice",
            p.discount_percent AS "discountPercent",
            p.rating,
            p.review_count AS "reviewCount",
            p.tags,
            p.is_featured,
            p.is_trending AS "isTrending",
            p.popularity_score AS "popularityScore",
            p.created_at AS "createdAt",
            p.updated_at AS "updatedAt",
            COALESCE(
              (
                SELECT pm.thumbnail_url
                FROM product_media pm
                WHERE pm.product_id = p.id
                ORDER BY pm.sort_order ASC, pm.id ASC
                LIMIT 1
              ),
              ''
            ) AS thumbnail
          FROM products p
          WHERE p.is_trending = TRUE
          ORDER BY p.popularity_score DESC, p.views DESC
          LIMIT 8
        `
      ),
      pool.query(
        `
          SELECT
            p.id,
            p.slug,
            p.title,
            p.short_description,
            p.price,
            p.old_price AS "oldPrice",
            p.discount_percent AS "discountPercent",
            p.rating,
            p.review_count AS "reviewCount",
            p.tags,
            p.popularity_score AS "popularityScore",
            p.created_at AS "createdAt",
            p.updated_at AS "updatedAt",
            COALESCE(
              (
                SELECT pm.thumbnail_url
                FROM product_media pm
                WHERE pm.product_id = p.id
                ORDER BY pm.sort_order ASC, pm.id ASC
                LIMIT 1
              ),
              ''
            ) AS thumbnail
          FROM products p
          WHERE p.discount_percent > 0
          ORDER BY p.discount_percent DESC, p.views DESC
          LIMIT 6
        `
      ),
      pool.query(
        `
          SELECT
            c.slug AS category_slug,
            c.name AS category_name,
            json_agg(
              json_build_object(
                'id', p.id,
                'slug', p.slug,
                'title', p.title,
                'shortDescription', p.short_description,
                'price', p.price,
                'oldPrice', p.old_price,
                'discountPercent', p.discount_percent,
                'rating', p.rating,
                'reviewCount', p.review_count,
                'thumbnail', COALESCE(
                  (
                    SELECT pm.thumbnail_url
                    FROM product_media pm
                    WHERE pm.product_id = p.id
                    ORDER BY pm.sort_order ASC, pm.id ASC
                    LIMIT 1
                  ),
                  ''
                )
              )
              ORDER BY p.popularity_score DESC, p.created_at DESC
            ) AS products
          FROM categories c
          JOIN LATERAL (
            SELECT *
            FROM products p
            WHERE p.category_id = c.id
            ORDER BY p.popularity_score DESC, p.created_at DESC
            LIMIT 5
          ) p ON TRUE
          GROUP BY c.slug, c.name, c.sort_order
          ORDER BY MIN(c.sort_order) ASC
        `
      ),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM products WHERE is_hidden = FALSE)::int AS "totalProducts",
          (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'completed')::int AS "totalSales",
          (SELECT COALESCE(AVG(rating), 0) FROM products WHERE is_hidden = FALSE)::float AS "avgRating",
          (SELECT COUNT(DISTINCT seller_id) FROM products WHERE is_hidden = FALSE)::int AS "totalCreators"
      `),
    ]);

    res.json({
      locale: req.session.locale || "fr",
      user: req.session.user || null,
      categories: categories.rows,
      trending: trending.rows,
      discounts: discounts.rows,
      ...(stats.rows[0] || {}),
      featuredByCategory: featured.rows.map((row) => ({
        categorySlug: row.category_slug,
        categoryName: row.category_name,
        products: row.products || [],
      })),
      landingConfig: (await pool.query(`SELECT * FROM admin_landing_config ORDER BY id ASC`)).rows,
      collaborators: ["Tresingo", "Atelier Nova", "Hexa Studio", "Forge 27", "Northline"],
      // Vrais comptes vendeurs en DB (pour l'assignation de produits dans l'admin)
      sellers: (await pool.query(
        `SELECT slug, display_name AS username FROM users WHERE role IN ('seller', 'admin') ORDER BY display_name ASC`
      )).rows,
      communities: ["Nexus RP", "Helios City", "Sector 12", "NovaLife", "Blackridge RP"],
      discordInvite,
    });
  } catch (error) {
    console.error("Bootstrap error:", error);
    res.status(500).json({ message: "Unable to load homepage data" });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const sortMode = req.query.sort || "popular";
    const allowedSorts = {
      popular: "p.popularity_score DESC, p.views DESC",
      new: "p.created_at DESC",
      discount: "p.discount_percent DESC, p.views DESC",
      rating: "p.rating DESC, p.review_count DESC",
      price_asc: "p.price ASC",
      price_desc: "p.price DESC",
    };

    const orderBy = allowedSorts[sortMode] || allowedSorts.popular;
    const where = buildWhereClause(req.query);

    const result = await pool.query(
      `
        SELECT
          p.id,
          p.slug,
          p.title,
          p.short_description,
          p.description,
          p.installation,
          p.price,
          p.old_price,
          p.discount_percent,
          p.rating,
          p.review_count,
          p.views,
          p.tags,
          p.is_trending,
          p.is_featured,
          p.is_new,
          p.is_hidden,
          p.popularity_score,
          p.created_at,
          p.updated_at,
          c.name AS category_name,
          c.slug AS category_slug,
          u.display_name AS seller_name,
          u.slug AS seller_slug,
          u.avatar_url AS seller_avatar,
          COALESCE(
            json_agg(
              json_build_object(
                'id', pm.id,
                'type', pm.media_type,
                'url', pm.url,
                'thumbnail', pm.thumbnail_url,
                'sortOrder', pm.sort_order
              )
              ORDER BY pm.sort_order ASC, pm.id ASC
            ) FILTER (WHERE pm.id IS NOT NULL),
            '[]'::json
          ) AS media
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN users u ON u.id = p.seller_id
        LEFT JOIN product_media pm ON pm.product_id = p.id
        ${where.sql}
        GROUP BY p.id, c.name, c.slug, u.display_name, u.slug, u.avatar_url
        ORDER BY ${orderBy}
      `,
      where.values
    );

    res.json({
      items: result.rows.map(mapProduct),
      total: result.rowCount,
    });
  } catch (error) {
    console.error("Products list error:", error);
    res.status(500).json({ message: "Unable to fetch products" });
  }
});

app.get("/api/seller/dashboard", requireAuth, async (req, res) => {
  if (req.session.user.role !== "seller" && req.session.user.role !== "admin") {
    return res.status(403).json({ message: "Seller access required" });
  }

  try {
    const sellerId = req.session.user.id;

    // 1. Seller Info (Discord, Stripe, Date d'arrivée)
    const sellerInfo = await pool.query(
      `SELECT discord_id, stripe_account_id, created_at FROM users WHERE id = $1`,
      [sellerId]
    );

    // 2. Stats
    const statsResult = await pool.query(
      `
      SELECT 
        COALESCE(SUM(oi.quantity), 0) as units_sold,
        COALESCE(SUM(oi.price * oi.quantity), 0) as total_revenue,
        COALESCE(SUM(ROUND((oi.price * oi.quantity * $2 / 100)::numeric, 2)), 0) as platform_fees,
        COALESCE(SUM(ROUND((oi.price * oi.quantity * (1 - $2::numeric / 100))::numeric, 2)), 0) as seller_net_revenue,
        (SELECT COUNT(*) FROM products WHERE seller_id = $1 AND is_hidden = FALSE) as active_products
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.seller_id = $1 AND o.status = 'completed'
      `,
      [sellerId, PLATFORM_COMMISSION_PERCENT]
    );

    // 3. Units per article
    const unitsPerArticleResult = await pool.query(
      `
      SELECT 
        p.title,
        COALESCE(SUM(oi.quantity), 0) as units
      FROM products p
      LEFT JOIN order_items oi ON p.id = oi.product_id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'completed'
      WHERE p.seller_id = $1 AND p.is_hidden = FALSE
      GROUP BY p.id, p.title
      ORDER BY units DESC
      `,
      [sellerId]
    );

    // 4. Sales History
    const salesResult = await pool.query(
      `
      SELECT 
        o.created_at as date,
        p.title as product_title,
        oi.customer_email as client,
        oi.price as price,
        oi.quantity as quantity,
        $2::numeric as platform_fee_percent,
        ROUND((oi.price * oi.quantity * $2 / 100)::numeric, 2) as platform_fee_amount,
        ROUND((oi.price * oi.quantity * (1 - $2::numeric / 100))::numeric, 2) as seller_net_amount
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE oi.seller_id = $1 AND o.status = 'completed'
      ORDER BY o.created_at DESC
      LIMIT 50
      `,
      [sellerId, PLATFORM_COMMISSION_PERCENT]
    );

    res.json({
      discordLinked: !!sellerInfo.rows[0].discord_id,
      discordId: sellerInfo.rows[0].discord_id,
      stripeLinked: !!sellerInfo.rows[0].stripe_account_id,
      stripeAccountId: sellerInfo.rows[0].stripe_account_id,
      joinedAt: sellerInfo.rows[0].created_at,
      stats: {
        unitsSold: parseInt(statsResult.rows[0].units_sold || 0),
        totalRevenue: parseFloat(statsResult.rows[0].total_revenue || 0),
        platformFees: parseFloat(statsResult.rows[0].platform_fees || 0),
        sellerNetRevenue: parseFloat(statsResult.rows[0].seller_net_revenue || 0),
        platformCommissionPercent: PLATFORM_COMMISSION_PERCENT,
        activeProducts: parseInt(statsResult.rows[0].active_products || 0),
        unitsPerArticle: unitsPerArticleResult.rows
      },
      sales: salesResult.rows
    });
  } catch (error) {
    console.error("Seller dashboard error:", error);
    res.status(500).json({ message: "Unable to fetch dashboard data" });
  }
});

app.get("/api/sellers/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug);
    
    // 1. Check if user is a seller
    const sellerResult = await pool.query(
      `SELECT id, display_name, slug, avatar_url, role, discord_id, created_at FROM users WHERE slug = $1 AND role IN ('seller', 'admin') LIMIT 1`,
      [slug]
    );

    if (!sellerResult.rowCount) {
      return res.status(404).json({ message: "Seller not found" });
    }
    
    const seller = sellerResult.rows[0];

    // 2. Fetch seller's products
    const productsResult = await pool.query(
      `
        SELECT
          p.id,
          p.slug,
          p.title,
          p.short_description,
          p.price,
          p.old_price,
          p.discount_percent,
          p.rating,
          p.review_count,
          p.tags,
          c.name AS category_name,
          COALESCE(
            (
              SELECT pm.thumbnail_url
              FROM product_media pm
              WHERE pm.product_id = p.id
              ORDER BY pm.sort_order ASC, pm.id ASC
              LIMIT 1
            ),
            ''
          ) AS thumbnail
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.seller_id = $1 AND p.is_hidden = FALSE
        ORDER BY p.popularity_score DESC, p.created_at DESC
      `,
      [seller.id]
    );

    const publicStatsResult = await pool.query(
      `
      SELECT 
        COALESCE(SUM(oi.quantity), 0) as units_sold,
        COALESCE(SUM(oi.price * oi.quantity), 0) as total_revenue,
        COALESCE(SUM(ROUND((oi.price * oi.quantity * (1 - $2::numeric / 100))::numeric, 2)), 0) as seller_net_revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.seller_id = $1 AND o.status = 'completed'
      `,
      [seller.id, PLATFORM_COMMISSION_PERCENT]
    );

    res.json({
      seller: {
        displayName: seller.display_name,
        slug: seller.slug,
        avatarUrl: seller.avatar_url,
        bio: '',
        discordId: seller.discord_id,
        discordLinked: !!seller.discord_id,
        joinedAt: seller.created_at,
        totalUnitsSold: parseInt(publicStatsResult.rows[0].units_sold || 0),
        totalRevenue: parseFloat(publicStatsResult.rows[0].total_revenue || 0),
        sellerNetRevenue: parseFloat(publicStatsResult.rows[0].seller_net_revenue || 0)
      },
      products: productsResult.rows.map(row => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        shortDescription: row.short_description,
        price: Number(row.price),
        oldPrice: Number(row.old_price),
        discountPercent: row.discount_percent,
        rating: Number(row.rating),
        reviewCount: row.review_count,
        tags: row.tags || [],
        categoryName: row.category_name,
        thumbnail: row.thumbnail,
        sellerName: seller.display_name
      }))
    });
  } catch (error) {
    console.error("Seller products error:", error);
    res.status(500).json({ message: "Unable to fetch seller details" });
  }
});

app.get("/api/products/:slug", async (req, res) => {
  try {
    const product = await getProductBySlug(req.params.slug, req.session?.user?.id || null);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await pool.query(`UPDATE products SET views = views + 1, updated_at = NOW() WHERE id = $1`, [product.id]);
    product.views += 1;

    // Indique si l'utilisateur connecté possède déjà ce produit (pour éviter le rachat)
    let owned = false;
    if (req.session?.user?.id) {
      const ownedResult = await pool.query(
        `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'completed' LIMIT 1`,
        [product.id, req.session.user.id]
      );
      owned = ownedResult.rowCount > 0;
    }

    res.json({ ...product, owned });
  } catch (error) {
    console.error("Product detail error:", error);
    res.status(500).json({ message: "Unable to fetch product" });
  }
});

app.get("/api/categories", async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          c.id,
          c.name,
          c.slug,
          c.description,
          COUNT(p.id)::int AS product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id
        GROUP BY c.id
        ORDER BY c.sort_order ASC, c.name ASC
      `
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Categories error:", error);
    res.status(500).json({ message: "Unable to fetch categories" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const search = String(req.query.q || "").trim();
    if (!search) {
      return res.json({ items: [] });
    }

    const result = await pool.query(
      `
        SELECT
          p.slug,
          p.title,
          p.price,
          p.rating,
          p.review_count,
          c.name AS category_name,
          COALESCE(
            (
              SELECT pm.thumbnail_url
              FROM product_media pm
              WHERE pm.product_id = p.id
              ORDER BY pm.sort_order ASC, pm.id ASC
              LIMIT 1
            ),
            ''
          ) AS thumbnail
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.title ILIKE $1
           OR p.short_description ILIKE $1
           OR p.description ILIKE $1
           OR array_to_string(p.tags, ' ') ILIKE $1
        ORDER BY p.popularity_score DESC, p.views DESC
        LIMIT 8
      `,
      [`%${search}%`]
    );

    res.json({ items: result.rows });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ message: "Unable to search products" });
  }
});

app.get("/api/stripe/config", (_req, res) => {
  res.json({
    enabled: Boolean(stripe && STRIPE_PUBLIC_KEY),
    publishableKey: STRIPE_PUBLIC_KEY || null,
  });
});

app.get("/api/me", async (req, res) => {
  if (!req.session.user?.id) {
    return res.json({
      authenticated: false,
      user: null,
      cart: null,
    });
  }

  try {
    // Refresh user data from DB to ensure we have the latest fields (like slug)
    const userResult = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [req.session.user.id]);
    if (userResult.rowCount) {
      req.session.user = sanitizeUser(userResult.rows[0]);
    }

    const cart = await getCart(req.session.user.id);
    res.json({
      authenticated: true,
      user: req.session.user,
      cart,
    });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ message: "Unable to load session" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, displayName, preferredLanguage, role, sellerDescription, shopName, discordTag } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ message: "email, password and displayName are required" });
  }

  try {
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [String(email).trim().toLowerCase()]);
    if (existing.rowCount) {
      return res.status(409).json({ message: "Email already in use" });
    }

    // Si inscription vendeur -> pending, sinon customer
    const isSeller = role === 'seller';
    const userRole = isSeller ? 'customer' : 'customer';
    const sellerStatus = isSeller ? 'pending' : 'none';

    const inserted = await pool.query(
      `
        INSERT INTO users (email, password_hash, display_name, slug, role, preferred_language, seller_status, seller_description, shop_name, discord_tag)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `,
      [
        String(email).trim().toLowerCase(),
        hashPassword(password),
        String(displayName).trim(),
        `${slugify(displayName)}-${Date.now()}`,
        userRole,
        preferredLanguage === "en" ? "en" : "fr",
        sellerStatus,
        String(sellerDescription || "").trim(),
        String(shopName || "").trim(),
        String(discordTag || "").trim(),
      ]
    );

    req.session.user = sanitizeUser(inserted.rows[0]);

    res.status(201).json({
      ok: true,
      user: req.session.user,
      sellerPending: isSeller,
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Unable to register user" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  try {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [
      String(email).trim().toLowerCase(),
    ]);

    if (!result.rowCount || result.rows[0].password_hash !== hashPassword(password)) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    req.session.user = sanitizeUser(result.rows[0]);

    res.json({
      ok: true,
      user: req.session.user,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Unable to login" });
  }
});

app.post("/auth/admin/login", async (req, res) => {
  const { email, password } = req.body;

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid admin credentials" });
  }

  // Si on se connecte en admin avec les credentials hardcodés, on s'assure
  // de créer ou mettre à jour le compte dans la BDD pour qu'il ait bien le rôle 'admin'.
  const adminSlug = slugify(ADMIN_EMAIL.split("@")[0] || "admin");
  await pool.query(
    `
      INSERT INTO users (email, password_hash, display_name, slug, role, preferred_language)
      VALUES ($1, $2, $3, $4, 'admin', 'fr')
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          display_name = EXCLUDED.display_name,
          slug = EXCLUDED.slug,
          role = 'admin'
    `,
    [ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), "GSA Admin", adminSlug]
  );

  const result = await pool.query(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [ADMIN_EMAIL]);
  req.session.user = sanitizeUser(result.rows[0]);

  res.json({
    ok: true,
    user: req.session.user,
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    // Effacer explicitement le cookie côté navigateur — requis en cross-origin
    // (sameSite none + secure), sinon le cookie connect.sid reste et le
    // navigateur continue de l'envoyer => il faut cliquer 2 fois.
    res.clearCookie("connect.sid", {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    });
    if (err) {
      console.error("Logout destroy error:", err);
      return res.status(500).json({ ok: false, message: "Logout failed" });
    }
    res.json({ ok: true });
  });
});

app.post("/api/locale", (req, res) => {
  req.session.locale = req.body.locale === "en" ? "en" : "fr";
  res.json({ ok: true, locale: req.session.locale });
});

app.patch("/api/profile", requireAuth, async (req, res) => {
  const { displayName, email, avatarUrl } = req.body;
  try {
    const updates = [];
    const values = [];
    let idx = 1;
    if (displayName && String(displayName).trim()) { updates.push(`display_name = $${idx++}`); values.push(String(displayName).trim()); }
    if (email && String(email).trim()) { updates.push(`email = $${idx++}`); values.push(String(email).trim().toLowerCase()); }
    if (avatarUrl !== undefined) { updates.push(`avatar_url = $${idx++}`); values.push(avatarUrl ? String(avatarUrl).trim() : null); }
    if (!updates.length) return res.status(400).json({ message: "No fields to update" });
    values.push(req.session.user.id);
    const result = await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`, values);
    req.session.user = sanitizeUser(result.rows[0]);
    res.json({ ok: true, user: req.session.user });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ message: "Unable to update profile" });
  }
});

app.get("/auth/steam", (req, res) => {
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": STEAM_RETURN_URL,
    "openid.realm": STEAM_REALM,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  res.redirect(`https://steamcommunity.com/openid/login?${params.toString()}`);
});

app.get("/auth/steam/callback", async (req, res) => {
  try {
    const claimedId = req.query["openid.claimed_id"] || req.query["openid.identity"];
    const steamIdMatch = String(claimedId || "").match(/(\d{17})/);

    if (!claimedId || !steamIdMatch) {
      throw new Error(`Steam claimed_id missing or invalid: ${claimedId || "undefined"}`);
    }

    const steamId = steamIdMatch[1];

    let profile = null;
    if (STEAM_API_KEY) {
      const steamProfileResponse = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`
      );
      if (steamProfileResponse.ok) {
        const steamProfilePayload = await steamProfileResponse.json();
        profile = steamProfilePayload.response?.players?.[0] || null;
      }
    }

    const email = `${steamId}@steam.gsa.local`;
    const displayName = profile?.personaname || `Steam ${steamId}`;
    const avatarUrl = profile?.avatarfull || profile?.avatar || null;

    // If user already logged in → linking mode (Steam)
    if (req.session.user?.id) {
      await pool.query(
        `UPDATE users SET steam_id = $1, avatar_url = COALESCE(NULLIF(avatar_url, ''), $2) WHERE id = $3`,
        [steamId, avatarUrl, req.session.user.id]
      );
      const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [req.session.user.id]);
      req.session.user = sanitizeUser(updated.rows[0]);
      return res.redirect(`${APP_BASE_URL}/seller/account?steam_id=${steamId}`);
    }

    const existing = await pool.query(`SELECT * FROM users WHERE steam_id = $1 OR email = $2 LIMIT 1`, [
      steamId,
      email,
    ]);
    let userRow;

    if (existing.rowCount) {
      userRow = existing.rows[0];
      await pool.query(
        `
          UPDATE users
          SET display_name = $2,
              avatar_url = $3,
              steam_id = $4
          WHERE id = $1
        `,
        [userRow.id, displayName, avatarUrl, steamId]
      );
      const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [userRow.id]);
      userRow = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `
          INSERT INTO users (email, password_hash, display_name, slug, role, avatar_url, steam_id, preferred_language)
          VALUES ($1, $2, $3, $4, 'customer', $5, $6, 'fr')
          RETURNING *
        `,
        [email, hashPassword(`steam-${steamId}`), displayName, `${slugify(displayName)}-${steamId}`, avatarUrl, steamId]
      );
      userRow = inserted.rows[0];
    }

    req.session.user = sanitizeUser(userRow);
    res.redirect(`${APP_BASE_URL}/`);
  } catch (error) {
    console.error("Steam auth error:", error);
    res.redirect(`${APP_BASE_URL}/login.html?error=steam_auth_failed`);
  }
});

app.get("/auth/discord", (req, res) => {
  const scope = encodeURIComponent("identify email");
  const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URI);
  const returnUrl = req.query.return_url || "";
  const state = returnUrl ? Buffer.from(returnUrl).toString("base64") : "";
  const discordUrl =
    `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}` +
    `&response_type=code&redirect_uri=${redirectUri}&scope=${scope}` +
    (state ? `&state=${encodeURIComponent(state)}` : "");

  res.redirect(discordUrl);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect("/login.html?error=missing_code");
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Unable to retrieve Discord token");
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      throw new Error("Unable to retrieve Discord profile");
    }

    const discordUser = await userResponse.json();
    const email = discordUser.email || `${discordUser.id}@discord.gsa.local`;
    const displayName = discordUser.global_name || discordUser.username;
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

    // If user already logged in → linking mode
    if (req.session.user?.id) {
      await pool.query(
        `UPDATE users SET discord_id = $1, avatar_url = COALESCE(NULLIF(avatar_url, ''), $2) WHERE id = $3`,
        [String(discordUser.id), avatarUrl, req.session.user.id]
      );
      const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [req.session.user.id]);
      req.session.user = sanitizeUser(updated.rows[0]);
      let redirectAfterLink = `${APP_BASE_URL}/profile.html`;
      try {
        const s = String(req.query.state || "");
        if (s) {
          const decoded = Buffer.from(s, "base64").toString("utf8");
          if (decoded.startsWith("http") || decoded.startsWith("/")) redirectAfterLink = decoded;
        }
      } catch (_) {}
      const sep = redirectAfterLink.includes("?") ? "&" : "?";
      redirectAfterLink += `${sep}discord_id=${discordUser.id}&discord_username=${discordUser.username}`;
      return res.redirect(redirectAfterLink);
    }

    const existing = await pool.query(`SELECT * FROM users WHERE discord_id = $1 OR email = $2 LIMIT 1`, [
      String(discordUser.id),
      email,
    ]);
    let userRow;

    if (existing.rowCount) {
      userRow = existing.rows[0];
      await pool.query(
        `
          UPDATE users
          SET display_name = $2,
              avatar_url = $3,
              discord_id = $4
          WHERE id = $1
        `,
        [userRow.id, displayName, avatarUrl, String(discordUser.id)]
      );
      const updated = await pool.query(`SELECT * FROM users WHERE id = $1`, [userRow.id]);
      userRow = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `
          INSERT INTO users (email, password_hash, display_name, slug, role, avatar_url, discord_id, preferred_language)
          VALUES ($1, $2, $3, $4, 'customer', $5, $6, 'fr')
          RETURNING *
        `,
        [email, hashPassword(`discord-${discordUser.id}`), displayName, `${slugify(displayName)}-${discordUser.id}`, avatarUrl, String(discordUser.id)]
      );
      userRow = inserted.rows[0];
    }

    req.session.user = sanitizeUser(userRow);
    res.redirect(`${APP_BASE_URL}/`);
  } catch (error) {
    console.error("Discord auth error:", error);
    res.redirect(`${APP_BASE_URL}/login.html?error=discord_auth_failed`);
  }
});

app.get("/api/cart", requireAuth, async (req, res) => {
  try {
    const cart = await getCart(req.session.user.id);
    res.json(cart);
  } catch (error) {
    console.error("Cart fetch error:", error);
    res.status(500).json({ message: "Unable to fetch cart" });
  }
});

app.post("/api/cart/items", requireAuth, async (req, res) => {
  const { productId, quantity } = req.body;
  const normalizedProductId = Number(productId);
  const normalizedQuantity = Math.max(1, Number(quantity || 1));

  if (Number.isNaN(normalizedProductId)) {
    return res.status(400).json({ message: "Invalid productId" });
  }

  try {
    const cart = await getCart(req.session.user.id);

    await pool.query(
      `
        INSERT INTO cart_items (cart_id, product_id, quantity)
        VALUES ($1, $2, $3)
        ON CONFLICT (cart_id, product_id)
        DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
      `,
      [cart.id, normalizedProductId, normalizedQuantity]
    );

    const updatedCart = await getCart(req.session.user.id);
    res.status(201).json(updatedCart);
  } catch (error) {
    console.error("Add to cart error:", error);
    res.status(500).json({ message: "Unable to add item to cart" });
  }
});

app.patch("/api/cart/items/:id", requireAuth, async (req, res) => {
  const cartItemId = Number(req.params.id);
  const quantity = Number(req.body.quantity);

  if (Number.isNaN(cartItemId) || Number.isNaN(quantity) || quantity < 1) {
    return res.status(400).json({ message: "Invalid cart item update" });
  }

  try {
    const cart = await getCart(req.session.user.id);

    await pool.query(
      `
        UPDATE cart_items
        SET quantity = $1
        WHERE id = $2 AND cart_id = $3
      `,
      [quantity, cartItemId, cart.id]
    );

    const updatedCart = await getCart(req.session.user.id);
    res.json(updatedCart);
  } catch (error) {
    console.error("Update cart item error:", error);
    res.status(500).json({ message: "Unable to update cart item" });
  }
});

app.delete("/api/cart/items/:id", requireAuth, async (req, res) => {
  const cartItemId = Number(req.params.id);

  if (Number.isNaN(cartItemId)) {
    return res.status(400).json({ message: "Invalid cart item id" });
  }

  try {
    const cart = await getCart(req.session.user.id);

    await pool.query(`DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`, [cartItemId, cart.id]);

    const updatedCart = await getCart(req.session.user.id);
    res.json(updatedCart);
  } catch (error) {
    console.error("Delete cart item error:", error);
    res.status(500).json({ message: "Unable to delete cart item" });
  }
});

app.post("/api/promo/validate", requireAuth, async (req, res) => {
  try {
    await syncClientCart(req.session.user.id, req.body?.items);
    const cart = await getCart(req.session.user.id);
    const promoState = await getValidPromoForCart(req.body.code, cart.total);

    if (!promoState?.promo) {
      return res.status(404).json({ message: "Code promotionnel invalide, expiré ou déjà utilisé au maximum." });
    }

    res.json({
      ok: true,
      code: promoState.promo.code,
      label: promoState.promo.label,
      ambassadorName: promoState.promo.ambassador_name,
      discountType: promoState.promo.discount_type,
      discountValue: Number(promoState.promo.discount_value),
      subtotal: cart.total,
      discountAmount: promoState.discountAmount,
      finalTotal: promoState.finalTotal,
    });
  } catch (error) {
    console.error("Promo validate error:", error);
    res.status(500).json({ message: "Impossible de vérifier le code promo." });
  }
});

// ─── Payouts vendeurs (separate charges and transfers) ────
// Tous les paiements vont à la plateforme, puis on transfère la part vendeur
// (seller_net_amount) vers chaque compte Stripe Connect après la commande.
async function createSellerTransfers(orderId, transferGroup) {
  if (!stripe) return;
  try {
    const result = await pool.query(
      `SELECT oi.id, oi.transfer_id, oi.seller_net_amount, u.stripe_account_id
       FROM order_items oi
       JOIN users u ON u.id = oi.seller_id
       WHERE oi.order_id = $1`,
      [orderId]
    );

    for (const item of result.rows) {
      if (item.transfer_id) continue; // déjà transféré
      if (!item.stripe_account_id) {
        console.log(`[payout] order_item ${item.id}: vendeur sans compte Stripe Connect, pas de transfer`);
        continue;
      }
      // Diagnostic : état du compte destination avant transfert
      try {
        const destAccount = await stripe.accounts.retrieve(item.stripe_account_id);
        console.log(
          `[payout] order_item ${item.id} → compte ${item.stripe_account_id} | charges=${destAccount.charges_enabled} payouts=${destAccount.payouts_enabled} details=${destAccount.details_submitted}`
        );
      } catch (e) {
        console.log(`[payout] order_item ${item.id}: impossible de lire le compte ${item.stripe_account_id}`, e.message || e);
      }
      const amount = Math.round(Number(item.seller_net_amount || 0) * 100);
      if (amount <= 0) continue;
      try {
        const transfer = await stripe.transfers.create({
          amount,
          currency: "eur",
          destination: item.stripe_account_id,
          transfer_group: transferGroup || `order-${orderId}`,
        });
        await pool.query(
          `UPDATE order_items SET transfer_id = $1, transfer_status = 'succeeded', transferred_at = NOW() WHERE id = $2`,
          [transfer.id, item.id]
        );
        console.log(`[payout] transfer ${transfer.id} : ${amount / 100} € → ${item.stripe_account_id} (order_item ${item.id})`);
      } catch (err) {
        await pool.query(
          `UPDATE order_items SET transfer_status = 'failed', transfer_error = $1 WHERE id = $2`,
          [String(err.message || err).slice(0, 500), item.id]
        );
        console.error(`[payout] transfer failed order_item ${item.id}:`, err.message || err);
      }
    }
  } catch (error) {
    console.error("[payout] createSellerTransfers error:", error.message || error);
  }
}

// Migration lazy des colonnes récentes (garantie même si le boot Vercel a été interrompu)
let recentMigrationsApplied = false;
async function ensureRecentMigrations() {
  if (recentMigrationsApplied) return;
  try {
    await pool.query(`
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_id TEXT;
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transfer_error TEXT;
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_fee_amount NUMERIC NOT NULL DEFAULT 0;
    `);
    recentMigrationsApplied = true;
  } catch (e) {
    console.error("[migrate] lazy migration failed:", e.message || e);
  }
}

// Enregistre les frais de traitement Stripe réels d'une commande (balance_transaction)
async function recordStripeFee(orderId, session) {
  if (!stripe) return;
  try {
    const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!piId) return;
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] });
    const fee = Number(pi.latest_charge?.balance_transaction?.fee || 0) / 100;
    if (fee > 0) {
      await pool.query(`UPDATE orders SET stripe_fee_amount = $1 WHERE id = $2`, [fee, orderId]);
      console.log(`[fees] order ${orderId} : frais Stripe = ${fee} €`);
    }
  } catch (error) {
    console.error("[fees] recordStripeFee error:", error.message || error);
  }
}

// ─── Buy Now (achat direct d'un produit) ─────────────────
app.post("/api/checkout/buy-now", requireAuth, async (req, res) => {
  if (!stripe || !STRIPE_PUBLIC_KEY) {
    return res.status(503).json({ message: "Stripe n'est pas configuré." });
  }
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ message: "Slug du produit requis" });

    const prodResult = await pool.query("SELECT p.*, u.stripe_account_id AS seller_stripe_id FROM products p JOIN users u ON u.id = p.seller_id WHERE p.slug = $1", [slug]);
    if (!prodResult.rowCount) return res.status(404).json({ message: "Produit introuvable" });
    const product = prodResult.rows[0];

    // Empêche le rachat d'un produit déjà possédé
    const ownedCheck = await pool.query(
      `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'completed' LIMIT 1`,
      [product.id, req.session.user.id]
    );
    if (ownedCheck.rowCount) {
      return res.status(400).json({ message: "Vous possédez déjà ce produit." });
    }

    const unitAmount = Math.round(Number(product.price) * 100);

    // Paiement à 100% sur la plateforme ; la part vendeur (75%) sera transférée
    // séparément après la commande via createSellerTransfers (webhook / confirm-session).
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.session.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: unitAmount,
          product_data: {
            name: product.title,
            images: (() => { const img = stripeSafeImage(product.thumbnail); return img ? [img] : []; })(),
            metadata: { productSlug: product.slug, productId: String(product.id) },
          },
        },
      }],
      success_url: `https://gca-nuxt.vercel.app/downloads?confirmed=1&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://gca-nuxt.vercel.app/product/${slug}`,
      metadata: { userId: String(req.session.user.id), productSlug: product.slug },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Buy-now error:", error);
    res.status(500).json({ message: "Erreur lors de la création du paiement" });
  }
});

app.post("/api/checkout/create-session", requireAuth, async (req, res) => {
  if (!stripe || !STRIPE_PUBLIC_KEY) {
    return res.status(503).json({
      message: "Stripe n'est pas configuré. Ajoutez STRIPE_SECRET_KEY et STRIPE_PUBLIC_KEY dans l'environnement.",
    });
  }

  try {
    await syncClientCart(req.session.user.id, req.body?.items);
    const cart = await getCart(req.session.user.id);

    if (!cart.items.length) {
      return res.status(400).json({ message: "Votre panier est vide." });
    }

    // Empêche le rachat d'articles déjà possédés
    const ownedRows = await pool.query(
      `SELECT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = $1 AND o.status = 'completed'`,
      [req.session.user.id]
    );
    const ownedIds = new Set(ownedRows.rows.map((r) => r.product_id));
    if (cart.items.some((it) => ownedIds.has(it.product.id))) {
      return res.status(400).json({ message: "Vous possédez déjà l'un de ces articles." });
    }

    const promoCode = normalizePromoCode(req.body?.promoCode);
    const promoState = promoCode ? await getValidPromoForCart(promoCode, cart.total) : null;
    if (promoCode && !promoState?.promo) {
      return res.status(400).json({ message: "Code promotionnel invalide, expiré ou déjà utilisé au maximum." });
    }

    let stripeDiscounts = undefined;
    if (promoState?.promo && promoState.discountAmount > 0) {
      const couponPayload =
        promoState.promo.discount_type === "percent"
          ? {
              percent_off: Math.min(100, Number(promoState.promo.discount_value)),
              duration: "once",
              name: promoState.promo.code,
            }
          : {
              amount_off: Math.round(promoState.discountAmount * 100),
              currency: "eur",
              duration: "once",
              name: promoState.promo.code,
            };
      const coupon = await stripe.coupons.create(couponPayload);
      stripeDiscounts = [{ coupon: coupon.id }];
    }

    const lineItems = cart.items.map((item) => {
      const previewUrl = item.product.preview?.thumbnail || item.product.preview?.url || "";
      const safeImg = stripeSafeImage(previewUrl);
      return {
        quantity: item.quantity,
        price_data: {
          currency: "eur",
          unit_amount: Math.round(Number(item.product.price) * 100),
          product_data: {
            name: item.product.title,
            images: safeImg ? [previewUrl] : [],
            metadata: {
              productSlug: item.product.slug,
              productId: String(item.product.id),
            },
          },
        },
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.session.user.email,
      line_items: lineItems,
      discounts: stripeDiscounts,
      success_url: `https://gca-nuxt.vercel.app/downloads?confirmed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://gca-nuxt.vercel.app/cart?checkout=cancel`,
      metadata: {
        userId: String(req.session.user.id),
        cartId: String(cart.id),
        promoCodeId: promoState?.promo ? String(promoState.promo.id) : "",
        promoCode: promoState?.promo?.code || "",
        subtotalAmount: String(Math.round(Number(cart.total || 0) * 100) / 100),
        discountAmount: String(promoState?.discountAmount || 0),
      },
    });

    res.status(201).json({
      ok: true,
      sessionId: session.id,
      url: session.url,
      publishableKey: STRIPE_PUBLIC_KEY,
    });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    res.status(500).json({ message: "Impossible de créer la session Stripe." });
  }
});

app.post("/api/checkout/confirm-session", requireAuth, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ message: "Stripe n'est pas configuré." });
  }

  const sessionId = String(req.body.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ message: "Session Stripe manquante." });
  }

  const client = await pool.connect();
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (String(session.metadata?.userId || "") !== String(req.session.user.id)) {
      return res.status(403).json({ message: "Cette session Stripe ne correspond pas à votre compte." });
    }

    if (session.payment_status !== "paid") {
      return res.status(400).json({ message: "Paiement Stripe non validé." });
    }

    const existingOrder = await pool.query(`SELECT id FROM orders WHERE stripe_session_id = $1 LIMIT 1`, [session.id]);
    if (existingOrder.rowCount) {
      return res.json({ ok: true, orderId: existingOrder.rows[0].id, alreadyConfirmed: true });
    }

    const cartId = Number(session.metadata?.cartId || 0);
    if (!cartId && session.metadata?.productSlug) {
      const p = await client.query("SELECT * FROM products WHERE slug = $1", [session.metadata.productSlug]);
      if (!p.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Produit introuvable." }); }
      const product = p.rows[0];
      const price = Number(product.price);
      const cp = PLATFORM_COMMISSION_PERCENT;
      const fee = Math.round(price * cp) / 100;
      console.log('[confirm-session buy-now] cp=%s price=%s fee=%s sellerNet=%s', cp, price, fee, price - fee);
      const ord = await client.query(
        `INSERT INTO orders (user_id, stripe_session_id, total_amount, subtotal_amount, status) VALUES ($1,$2,$3,$4,'completed') RETURNING id`,
        [req.session.user.id, session.id, price, price]
      );
      await client.query(
        `INSERT INTO order_items (order_id, product_id, seller_id, price, quantity, customer_email, platform_fee_percent, platform_fee_amount, seller_net_amount) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [ord.rows[0].id, product.id, product.seller_id, price, req.session.user.email, cp, fee, price - fee]
      );
      await client.query("COMMIT");
      // Part vendeur → transfert Stripe Connect (75% du prix)
      await createSellerTransfers(ord.rows[0].id, session.id);
      await recordStripeFee(ord.rows[0].id, session);
      return res.json({ ok: true, orderId: ord.rows[0].id });
    }
    if (!cartId) {
      return res.status(400).json({ message: "Panier Stripe introuvable." });
    }

    await client.query("BEGIN");

    const subtotalAmount = Number(session.metadata?.subtotalAmount || 0) || Number(session.amount_subtotal || 0) / 100;
    const discountAmount = Number(session.metadata?.discountAmount || 0) || Number(session.total_details?.amount_discount || 0) / 100;
    const promoCodeId = Number(session.metadata?.promoCodeId || 0) || null;

    const orderInsert = await client.query(
      `
        INSERT INTO orders (user_id, stripe_session_id, total_amount, subtotal_amount, discount_amount, promo_code_id, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'completed')
        RETURNING id
      `,
      [req.session.user.id, session.id, Number(session.amount_total || 0) / 100, subtotalAmount, discountAmount, promoCodeId]
    );

    const orderId = orderInsert.rows[0].id;

    const itemsInsert = await client.query(
      `
        INSERT INTO order_items (
          order_id,
          product_id,
          seller_id,
          price,
          quantity,
          customer_email,
          platform_fee_percent,
          platform_fee_amount,
          seller_net_amount
        )
        SELECT
          $1,
          p.id,
          p.seller_id,
          p.price,
          ci.quantity,
          $2,
          $4,
          ROUND((p.price * ci.quantity * $4 / 100)::numeric, 2),
          ROUND((p.price * ci.quantity * (1 - $4::numeric / 100))::numeric, 2)
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $3
        RETURNING id
      `,
      [orderId, req.session.user.email || session.customer_email || null, cartId, PLATFORM_COMMISSION_PERCENT]
    );

    if (!itemsInsert.rowCount) {
      throw new Error("Aucun article à enregistrer pour cette commande.");
    }

    if (promoCodeId) {
      const promoUpdate = await client.query(
        `
          UPDATE promo_codes
          SET
            redeemed_count = redeemed_count + 1,
            points_balance = points_balance + GREATEST(points_per_redemption, 0)
          WHERE id = $1
          RETURNING points_per_redemption
        `,
        [promoCodeId]
      );
      const pointsAwarded = Math.max(0, Number(promoUpdate.rows[0]?.points_per_redemption || 0));
      await client.query(
        `
          INSERT INTO promo_redemptions (promo_code_id, user_id, order_id, discount_amount, order_amount, points_awarded)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [promoCodeId, req.session.user.id, orderId, discountAmount, Number(session.amount_total || 0) / 100, pointsAwarded]
      );
    }

    await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
    await client.query("COMMIT");

    // Part vendeur(s) → transferts Stripe Connect (75% du prix de chaque article)
    await createSellerTransfers(orderId, session.id);
    await recordStripeFee(orderId, session);

    res.status(201).json({ ok: true, orderId, alreadyConfirmed: false });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Ignore rollback failures.
    }
    console.error("Stripe confirm session error:", error.message || error);
    res.status(500).json({ message: "Impossible de confirmer la commande Stripe." });
  } finally {
    client.release();
  }
});

// ─── Stripe Webhook ─────────────────────────────────────────
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      // Vérifier si la commande existe déjà
      const existing = await pool.query(`SELECT id FROM orders WHERE stripe_session_id = $1 LIMIT 1`, [session.id]);
      if (existing.rowCount) {
        return res.json({ received: true, alreadyProcessed: true });
      }

      const userId = Number(session.metadata?.userId || 0);
      const cartId = Number(session.metadata?.cartId || 0);
      const productSlug = session.metadata?.productSlug || "";

      if (!userId) {
        console.error("Webhook: missing userId in session metadata");
        return res.status(400).json({ error: "Missing userId metadata" });
      }

      // Buy-now : pas de cartId, on crée la commande directement depuis le productSlug
      if (!cartId && productSlug) {
        const productResult = await pool.query("SELECT * FROM products WHERE slug = $1", [productSlug]);
        if (!productResult.rowCount) {
          console.error("Webhook buy-now: product not found for slug", productSlug);
          return res.status(404).json({ error: "Product not found" });
        }
        const product = productResult.rows[0];
        const price = Number(product.price);
        const cp = PLATFORM_COMMISSION_PERCENT;
        const fee = Math.round(price * cp) / 100;

        const orderInsert = await pool.query(
          `INSERT INTO orders (user_id, stripe_session_id, total_amount, subtotal_amount, status) VALUES ($1,$2,$3,$4,'completed') RETURNING id`,
          [userId, session.id, price, price]
        );
        await pool.query(
          `INSERT INTO order_items (order_id, product_id, seller_id, price, quantity, customer_email, platform_fee_percent, platform_fee_amount, seller_net_amount) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
          [orderInsert.rows[0].id, product.id, product.seller_id, price, session.customer_details?.email || "", cp, fee, price - fee]
        );
        console.log(`Webhook buy-now: order ${orderInsert.rows[0].id} created for user ${userId}`);
        // Part vendeur → transfert Stripe Connect
        await createSellerTransfers(orderInsert.rows[0].id, session.id);
        await recordStripeFee(orderInsert.rows[0].id, session);
        return res.json({ received: true, orderId: orderInsert.rows[0].id });
      }

      if (!cartId) {
        console.error("Webhook: missing cartId in session metadata (and no productSlug)");
        return res.status(400).json({ error: "Missing cartId/productSlug metadata" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const subtotalAmount = Number(session.metadata?.subtotalAmount || 0) || Number(session.amount_subtotal || 0) / 100;
        const discountAmount = Number(session.metadata?.discountAmount || 0) || Number(session.total_details?.amount_discount || 0) / 100;
        const promoCodeId = Number(session.metadata?.promoCodeId || 0) || null;

        const orderInsert = await client.query(`
          INSERT INTO orders (user_id, stripe_session_id, total_amount, subtotal_amount, discount_amount, promo_code_id, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'completed')
          RETURNING id
        `, [userId, session.id, Number(session.amount_total || 0) / 100, subtotalAmount, discountAmount, promoCodeId]);

        const orderId = orderInsert.rows[0].id;

        const itemsInsert = await client.query(`
          INSERT INTO order_items (order_id, product_id, seller_id, price, quantity, customer_email, platform_fee_percent, platform_fee_amount, seller_net_amount)
          SELECT $1, p.id, p.seller_id, p.price, ci.quantity, $2, $4,
            ROUND((p.price * ci.quantity * $4 / 100)::numeric, 2),
            ROUND((p.price * ci.quantity * (1 - $4::numeric / 100))::numeric, 2)
          FROM cart_items ci
          JOIN products p ON p.id = ci.product_id
          WHERE ci.cart_id = $3
          RETURNING id
        `, [orderId, session.customer_details?.email || "", cartId, PLATFORM_COMMISSION_PERCENT]);

        if (!itemsInsert.rowCount) {
          throw new Error("No items to insert for this order");
        }

        // Gérer le promo code
        if (promoCodeId) {
          const promoUpdate = await client.query(`
            UPDATE promo_codes SET redeemed_count = redeemed_count + 1,
              points_balance = points_balance + GREATEST(points_per_redemption, 0)
            WHERE id = $1 RETURNING points_per_redemption
          `, [promoCodeId]);
          const pointsAwarded = Math.max(0, Number(promoUpdate.rows[0]?.points_per_redemption || 0));
          await client.query(`
            INSERT INTO promo_redemptions (promo_code_id, user_id, order_id, discount_amount, order_amount, points_awarded)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [promoCodeId, userId, orderId, discountAmount, Number(session.amount_total || 0) / 100, pointsAwarded]);
        }

        await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
        await client.query("COMMIT");
        console.log(`Webhook: order ${orderId} created for user ${userId}`);
        // Part vendeur(s) → transferts Stripe Connect
        await createSellerTransfers(orderId, session.id);
        await recordStripeFee(orderId, session);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Webhook order creation error:", err);
      } finally {
        client.release();
      }
      break;
    }

    case "account.updated": {
      const account = event.data.object;
      // Mettre à jour le stripe_account_id si le compte devient complété
      if (account.charges_enabled) {
        await pool.query(
          `UPDATE users SET stripe_account_id = $1 WHERE email = $2 AND (stripe_account_id IS NULL OR stripe_account_id <> $1)`,
          [account.id, account.email || ""]
        );
      }
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// ─── Stripe Connect (onboarding vendeur) ──────────────────
// Créer un lien d'onboarding Stripe Connect pour le vendeur
app.post("/api/stripe/connect", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Stripe non configuré" });

  try {
    const user = req.session.user;
    let accountId = user.stripeAccountId;

    // Fallback DB : si la session est fraîche (expirée/re-créée), retrouver
    // le compte déjà créé au lieu d'en créer un nouveau à chaque clic.
    if (!accountId) {
      const userRow = await pool.query(`SELECT stripe_account_id FROM users WHERE id = $1`, [user.id]);
      accountId = userRow.rows[0]?.stripe_account_id || null;
      if (accountId) req.session.user.stripeAccountId = accountId;
    }

    // Créer un compte Connect si pas encore fait
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "FR",
        email: user.email,
        business_type: "individual",
        metadata: { gsa_user_id: String(user.id) },
      });
      accountId = account.id;

      await pool.query(`UPDATE users SET stripe_account_id = $1 WHERE id = $2`, [accountId, user.id]);
      req.session.user.stripeAccountId = accountId;
    }

    // Créer un lien d'onboarding — le return_url porte l'ID du compte pour
    // l'associer à l'utilisateur au retour SANS dépendre de l'email.
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `https://gca-nuxt.vercel.app/seller/account?refresh=true&account=${accountId}`,
      return_url: `https://gca-nuxt.vercel.app/seller/account?success=true&account=${accountId}`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url, accountId });
  } catch (error) {
    console.error("Stripe Connect error:", error);
        res.status(500).json({ message: "Stripe Connect: " + (error?.message || error) });
  }
});

// Associer un compte Stripe Connect précis à l'utilisateur (appelé au retour
// d'onboarding avec ?account=acct_xxx — indépendant de l'email).
app.post("/api/stripe/connect/link", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Stripe non configuré" });
  const accountId = req.body?.accountId;
  if (!accountId || typeof accountId !== "string" || !accountId.startsWith("acct_")) {
    return res.status(400).json({ message: "Compte Stripe invalide" });
  }
  try {
    const account = await stripe.accounts.retrieve(accountId);
    const userId = req.session.user.id;
    await pool.query(`UPDATE users SET stripe_account_id = $1 WHERE id = $2`, [accountId, userId]);
    req.session.user.stripeAccountId = accountId;
    console.log(
      `[stripe-link] user=${userId} -> account=${accountId} charges=${account.charges_enabled}`
    );
    res.json({
      ok: true,
      connected: !!account.charges_enabled,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  } catch (error) {
    console.error("Stripe link error:", error);
    res.status(500).json({ message: "Stripe link: " + (error?.message || error) });
  }
});

// Vérifier le statut du compte Stripe Connect
app.get("/api/stripe/connect/status", requireAuth, async (req, res) => {
  if (!stripe) return res.json({ connected: false });

  try {
    const userId = req.session.user.id;

    // Récupérer le stripe_account_id depuis la session ou la base
    let accountId = req.session.user.stripeAccountId;
    if (!accountId) {
      const userRow = await pool.query("SELECT stripe_account_id FROM users WHERE id = $1", [userId]);
      accountId = userRow.rows[0]?.stripe_account_id || null;
      if (accountId) {
        req.session.user.stripeAccountId = accountId; // resync session
      }
    }

    if (!accountId) {
      return res.json({ connected: false, onboardingLink: `${APP_BASE_URL}/api/stripe/connect` });
    }

    const account = await stripe.accounts.retrieve(accountId);
    let connected = account.charges_enabled; // charges_enabled suffit pour recevoir des paiements

    // Si le compte stocké n'est pas activé, l'utilisateur a peut-être complété
    // l'onboarding sur un AUTRE compte (clics répétés => comptes multiples).
    // On cherche un compte activé avec le même email et on resynchronise.
    if (!connected) {
      const myEmail = (req.session.user.email || "").toLowerCase();
      const myUserId = String(userId);
      if (myEmail || myUserId) {
        const listRes = await stripe.accounts.list({ limit: 100 });
        const mine = listRes.data.filter((a) => {
          const byEmail = !!(a.email && a.email.toLowerCase() === myEmail);
          const byMeta = !!(a.metadata && a.metadata.gsa_user_id === myUserId);
          return byEmail || byMeta;
        });
        console.log(
          `[stripe-status] user=${myUserId} email=${myEmail}: ${mine.length} compte(s) match (activé: ${mine.filter(a => a.charges_enabled).length})`
        );
        const enabled = mine.find((a) => a.charges_enabled);
        if (enabled && enabled.id !== accountId) {
          await pool.query(`UPDATE users SET stripe_account_id = $1 WHERE id = $2`, [enabled.id, userId]);
          req.session.user.stripeAccountId = enabled.id;
          console.log(`[stripe-status] resync: ${accountId} -> ${enabled.id} (email match)`);
          account = enabled;
          accountId = enabled.id;
          connected = true;
        }
      }
    }

    console.log(
      `[stripe-status] account=${accountId} charges=${account.charges_enabled} payouts=${account.payouts_enabled} details=${account.details_submitted} type=${account.type} country=${account.country}`
    );

    res.json({
      connected,
      hasAccount: true,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      onboardingLink: connected ? undefined : `${APP_BASE_URL}/api/stripe/connect`,
    });
  } catch (error) {
    console.error("Stripe Connect status error:", error);
    res.status(500).json({ connected: false, error: error.message });
  }
});

// Lien vers le dashboard Stripe Express du vendeur
app.post("/api/stripe/dashboard", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Stripe non configuré" });
  try {
    const accountId = req.session.user.stripeAccountId;
    if (!accountId) return res.status(400).json({ message: "Aucun compte Stripe lié" });
    const loginLink = await stripe.accounts.createLoginLink(accountId);
    res.json({ url: loginLink.url });
  } catch (error) {
    console.error("Stripe dashboard link error:", error);
    res.status(500).json({ message: "Impossible de générer le lien dashboard" });
  }
});

// ─── Téléchargements (R2) ─────────────────────────────────────

// Liste des produits achetés par l'utilisateur connecté
app.get("/api/user/purchases", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        oi.id AS order_item_id,
        oi.product_id,
        oi.price,
        oi.download_count,
        o.created_at AS purchase_date,
        p.slug,
        p.title,
        p.rating,
        p.review_count,
        c.name AS category_name,
        (
          SELECT json_agg(json_build_object(
            'id', pf.id,
            'filename', pf.filename,
            'file_size', pf.file_size,
            'is_main', pf.is_main
          ) ORDER BY pf.sort_order ASC)
          FROM product_files pf
          WHERE pf.product_id = p.id
        ) AS files,
        COALESCE(
          (SELECT m.thumbnail_url FROM product_media m WHERE m.product_id = p.id ORDER BY m.sort_order ASC LIMIT 1),
          '/placeholder.svg'
        ) AS thumbnail
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [req.session.user.id]);

    res.json({ items: result.rows });
  } catch (error) {
    console.error("User purchases error:", error);
    res.status(500).json({ message: "Unable to fetch purchases" });
  }
});

// Générer une signed URL pour télécharger un fichier
app.get("/api/download/:orderItemId", requireAuth, async (req, res) => {
  try {
    if (!r2Client) {
      return res.status(503).json({ message: "R2 storage non configuré (manque R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)" });
    }

    const orderItemId = Number(req.params.orderItemId);
    if (!orderItemId) return res.status(400).json({ message: "orderItemId invalide" });

    // Vérifier que l'utilisateur possède bien ce produit
    const item = await pool.query(`
      SELECT oi.id, oi.product_id, oi.download_count, o.user_id
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = $1 AND o.user_id = $2
    `, [orderItemId, req.session.user.id]);

    if (!item.rowCount) {
      return res.status(403).json({ message: "Vous ne possédez pas ce produit" });
    }

    // Vérifier qu'il y a un fichier associé
    const files = await pool.query(`
      SELECT id, filename, file_size, storage_path
      FROM product_files
      WHERE product_id = $1
      ORDER BY sort_order ASC, is_main DESC
    `, [item.rows[0].product_id]);

    if (!files.rowCount) {
      return res.status(404).json({ message: "Aucun fichier disponible pour ce produit" });
    }

    // Incrémenter le compteur de downloads
    await pool.query(`UPDATE order_items SET download_count = download_count + 1 WHERE id = $1`, [orderItemId]);

    // Générer une signed URL pour chaque fichier
    const signedUrls = await Promise.all(files.rows.map(async (f) => {
      const url = await getSignedUrl(r2Client, new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: f.storage_path,
      }), { expiresIn: 3600 }); // 1h

      return { filename: f.filename, file_size: f.file_size, url };
    }));

    res.json({ files: signedUrls });
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ message: "Erreur lors de la génération du lien de téléchargement" });
  }
});

// ─── Facture PDF ─────────────────────────────────────────
const PDFDocument = require("pdfkit");

function invoiceNumber(orderId) {
  return `INV-${String(orderId).padStart(5, "0")}`;
}

function formatInvoiceDate(value) {
  return new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function formatEuro(value) {
  // Format français : "1 200,97 €" (virgule décimale + espace milliers)
  const n = Number(value || 0);
  const parts = n.toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return parts.join(",") + " €";
}

function formatPercent(value) {
  return Number(value || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " %";
}

app.get("/api/invoice/:orderItemId", requireAuth, async (req, res) => {
  try {
    // Garantit que les colonnes récentes existent AVANT le premier SELECT (qui les référence)
    await ensureRecentMigrations();

    const orderItemId = Number(req.params.orderItemId);
    if (!orderItemId) return res.status(400).json({ message: "orderItemId invalide" });

    // La facture couvre la commande entière ; l'utilisateur doit posséder l'item demandé
    const result = await pool.query(
      `
        SELECT
          o.id AS order_id,
          o.created_at,
          o.total_amount,
          o.subtotal_amount,
          o.discount_amount,
          o.stripe_fee_amount,
          o.stripe_session_id,
          u.display_name AS buyer_name,
          u.email AS buyer_email,
          json_agg(
            json_build_object(
              'order_item_id', oi.id,
              'title', p.title,
              'quantity', oi.quantity,
              'price', oi.price,
              'seller_name', s.display_name,
              'platform_fee_percent', oi.platform_fee_percent,
              'platform_fee_amount', oi.platform_fee_amount,
              'seller_net_amount', oi.seller_net_amount
            ) ORDER BY oi.id
          ) AS items
        FROM orders o
        JOIN users u ON u.id = o.user_id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        JOIN users s ON s.id = oi.seller_id
        WHERE o.id = (
          SELECT o2.id
          FROM order_items oi2
          JOIN orders o2 ON o2.id = oi2.order_id
          WHERE oi2.id = $1
        )
        AND o.user_id = $2
        GROUP BY o.id, u.display_name, u.email
        LIMIT 1
      `,
      [orderItemId, req.session.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Commande introuvable" });
    }

    const order = result.rows[0];
    const items = order.items || [];
    const discount = Number(order.discount_amount || 0);
    const subtotal = Number(order.subtotal_amount || 0);
    const total = Number(order.total_amount || 0);
    const sellers = [...new Set(items.map((i) => i.seller_name).filter(Boolean))];

    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="facture-${invoiceNumber(order.order_id)}.pdf"`);
      res.send(Buffer.concat(chunks));
    });

    const primary = "#2f7df6";
    const dark = "#11171f";
    const muted = "#5a6478";
    const light = "#e2e8f0";
    const W = doc.page.width - 96; // largeur utile
    const usableBottom = doc.page.height - 60; // zone sûre (évite les pages fantômes du footer)

    // Header sombre avec logo sur carte blanche
    doc.rect(0, 0, doc.page.width, 84).fill(dark);
    const logoPath = path.join(__dirname, "asset/logo/gsa_logo.png");
    doc.roundedRect(48, 16, 84, 52, 10).fill("#ffffff");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 48 + 6, 16 + 6, { fit: [72, 40] });
    }
    doc.font("Helvetica").fontSize(9).fillColor("#8892a8")
      .text("GSA Tresingo · Marketplace Garry's Mod", 146, 56);
    doc.fillColor(primary).font("Helvetica-Bold").fontSize(20).text("FACTURE", 0, 26, { align: "right", width: W });

    // N° + date
    doc.fillColor(muted).font("Helvetica").fontSize(8.5)
      .text(`N° ${invoiceNumber(order.order_id)}  ·  Date : ${formatInvoiceDate(order.created_at)}`, 0, 100, { align: "right", width: W });

    // Blocs client / vendeur
    doc.font("Helvetica-Bold").fontSize(8).fillColor(muted).text("FACTURÉ À", 48, 132);
    doc.font("Helvetica").fontSize(10).fillColor(dark).text(order.buyer_name || "Client", 48, 145);
    doc.fontSize(8.5).fillColor(muted).text(order.buyer_email || "", 48, 160);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(muted).text("VENDU PAR", 0, 132, { align: "right", width: W });
    doc.font("Helvetica").fontSize(10).fillColor(dark).text(sellers.join(", ") || "Vendeur GSA", 0, 145, { align: "right", width: W });

    // Tableau des articles
    const tableTop = 190;
    doc.rect(48, tableTop, W, 22).fill("#f1f5f9");
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(8);
    doc.text("PRODUIT", 48, tableTop + 6);
    doc.text("QTÉ", 0, tableTop + 6, { align: "right", width: 340 });
    doc.text("PRIX UNITAIRE", 0, tableTop + 6, { align: "right", width: 440 });
    doc.text("TOTAL", 0, tableTop + 6, { align: "right", width: W });

    let rowY = tableTop + 26;
    doc.font("Helvetica").fontSize(9).fillColor(dark);
    items.forEach((item, i) => {
      if (rowY > usableBottom - 120) {
        doc.addPage();
        rowY = 48;
      }
      const titleHeight = doc.heightOfString(item.title, { width: 280 });
      const feePct = formatPercent(item.platform_fee_percent);
      const detailLine = `Dont frais GSA (${feePct}) : ${formatEuro(item.platform_fee_amount)} · Net vendeur : ${formatEuro(item.seller_net_amount)}`;
      const rowHeight = Math.max(20, titleHeight + 14);
      doc.text(item.title, 48, rowY, { width: 280 });
      doc.fontSize(7.5).fillColor(muted)
        .text(detailLine, 48, rowY + titleHeight + 1, { width: 280 });
      doc.fontSize(9).fillColor(dark);
      doc.text(String(item.quantity), 0, rowY, { align: "right", width: 340 });
      doc.text(formatEuro(item.price), 0, rowY, { align: "right", width: 440 });
      doc.text(formatEuro(Number(item.price) * Number(item.quantity)), 0, rowY, { align: "right", width: W });
      if (i < items.length - 1) {
        doc.moveTo(48, rowY + rowHeight + 2).lineTo(48 + W, rowY + rowHeight + 2).strokeColor(light).lineWidth(0.5).stroke();
      }
      rowY += rowHeight + 8;
    });

    // Totaux (labels alignés à droite jusqu'à x=440, montants jusqu'à x=48+W → marge anti-chevauchement)
    if (rowY > usableBottom - 130) {
      doc.addPage();
      rowY = 48;
    }
    rowY += 6;
    doc.fontSize(9);
    doc.fillColor(muted).text("Sous-total", 0, rowY, { align: "right", width: 440 });
    doc.fillColor(dark).text(formatEuro(subtotal), 0, rowY, { align: "right", width: W });
    rowY += 15;

    // Détail frais plateforme / net vendeur (basé sur les montants réels stockés dans order_items)
    const totalFees = items.reduce((acc, it) => acc + Number(it.platform_fee_amount || 0), 0);
    const totalNet = items.reduce((acc, it) => acc + Number(it.seller_net_amount || 0), 0);
    const feePercent = items.find((it) => it.platform_fee_percent)?.platform_fee_percent || 0;
    if (totalFees > 0) {
      doc.fillColor(muted).text(`Dont frais GSA (${formatPercent(feePercent)})`, 0, rowY, { align: "right", width: 440 });
      doc.fillColor(dark).text(`-${formatEuro(totalFees)}`, 0, rowY, { align: "right", width: W });
      rowY += 15;
    }
    if (totalNet > 0) {
      doc.fillColor(muted).text("Net vendeur", 0, rowY, { align: "right", width: 440 });
      doc.fillColor(dark).text(formatEuro(totalNet), 0, rowY, { align: "right", width: W });
      rowY += 15;
    }
    // Frais de traitement Stripe (montant réel depuis balance_transaction)
    const stripeFee = Number(order.stripe_fee_amount || 0);
    if (stripeFee > 0) {
      const feeRate = total > 0 ? formatPercent((stripeFee / total) * 100) : "";
      doc.fillColor(muted).text(`Frais de traitement Stripe (${feeRate})`, 0, rowY, { align: "right", width: 440 });
      doc.fillColor(dark).text(`-${formatEuro(stripeFee)}`, 0, rowY, { align: "right", width: W });
      rowY += 15;
    }
    if (discount > 0) {
      doc.fillColor(muted).text("Remise (code promo)", 0, rowY, { align: "right", width: 440 });
      doc.fillColor("#dc2626").text(`-${formatEuro(discount)}`, 0, rowY, { align: "right", width: W });
      rowY += 15;
    }
    doc.rect(48, rowY - 4, W, 24).fill(dark);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10.5).text("TOTAL TTC", 0, rowY + 4, { align: "right", width: W - 70 });
    doc.text(formatEuro(total), 0, rowY + 4, { align: "right", width: W });

    // Mentions
    doc.fillColor(muted).font("Helvetica").fontSize(7.5);
    doc.text("Paiement sécurisé via Stripe.", 48, rowY + 40);
    doc.text("TVA non applicable, art. 293 B du CGI.", 48, rowY + 52);
    doc.text(`Commande n° ${order.order_id} · Transaction Stripe ${String(order.stripe_session_id || "").slice(0, 18)}`, 48, rowY + 64);

    // Footer (dans la zone sûre pour éviter les pages fantômes)
    const footerY = usableBottom - 4;
    doc.moveTo(48, footerY - 8).lineTo(48 + W, footerY - 8).strokeColor(light).lineWidth(0.5).stroke();
    doc.fillColor(muted).fontSize(7.5).text("GSA Tresingo · GSA, un standard à venir.", 48, footerY);
    doc.text(`Facture générée le ${formatInvoiceDate(new Date())}`, 0, footerY, { align: "right", width: W });

    doc.end();
  } catch (error) {
    console.error("Invoice error:", error);
    res.status(500).json({ message: "Erreur lors de la génération de la facture" });
  }
});

app.post("/api/reviews", requireAuth, async (req, res) => {
  const { productId, rating, comment } = req.body;
  const normalizedProductId = Number(productId);
  const normalizedRating = Number(rating);

  if (
    Number.isNaN(normalizedProductId) ||
    !Number.isInteger(normalizedRating) ||
    normalizedRating < 1 ||
    normalizedRating > 5 ||
    typeof comment !== "string" ||
    !comment.trim()
  ) {
    return res.status(400).json({ message: "Invalid review payload" });
  }

  try {
    const productResult = await pool.query(`SELECT id FROM products WHERE id = $1`, [normalizedProductId]);
    if (!productResult.rowCount) {
      return res.status(404).json({ message: "Produit introuvable" });
    }

    // Seuls les acheteurs (commande completed) peuvent laisser un avis
    const ownedResult = await pool.query(
      `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'completed' LIMIT 1`,
      [normalizedProductId, req.session.user.id]
    );
    if (!ownedResult.rowCount) {
      return res.status(403).json({ message: "Vous devez posséder ce produit pour laisser un avis" });
    }

    // Upsert : un seul avis par utilisateur et par produit (mise à jour si déjà noté)
    const inserted = await pool.query(
      `
        INSERT INTO reviews (product_id, user_id, rating, comment, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id, product_id)
        DO UPDATE SET
          rating = EXCLUDED.rating,
          comment = EXCLUDED.comment,
          updated_at = NOW()
        RETURNING id, rating, comment, created_at, updated_at
      `,
      [normalizedProductId, req.session.user.id, normalizedRating, comment.trim()]
    );

    await pool.query(
      `
        UPDATE products
        SET
          rating = (
            SELECT COALESCE(AVG(rating), 5)
            FROM reviews
            WHERE product_id = $1
          ),
          review_count = (
            SELECT COUNT(*)
            FROM reviews
            WHERE product_id = $1
          ),
          updated_at = NOW()
        WHERE id = $1
      `,
      [normalizedProductId]
    );

    const review = inserted.rows[0];
    res.status(201).json({
      ok: true,
      review: {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.created_at,
      },
    });
  } catch (error) {
    console.error("Review error:", error);
    res.status(500).json({ message: "Unable to submit review" });
  }
});

app.delete("/api/reviews/:id", requireAuth, async (req, res) => {
  const reviewId = Number(req.params.id);
  if (Number.isNaN(reviewId)) {
    return res.status(400).json({ message: "Invalid review id" });
  }

  try {
    // Un utilisateur ne peut supprimer que son propre avis
    const deleted = await pool.query(
      `DELETE FROM reviews WHERE id = $1 AND user_id = $2 RETURNING product_id`,
      [reviewId, req.session.user.id]
    );
    if (!deleted.rowCount) {
      return res.status(404).json({ message: "Avis introuvable" });
    }

    const productId = deleted.rows[0].product_id;
    await pool.query(
      `
        UPDATE products
        SET
          rating = COALESCE((SELECT AVG(rating) FROM reviews WHERE product_id = $1), 5),
          review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1),
          updated_at = NOW()
        WHERE id = $1
      `,
      [productId]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Review delete error:", error);
    res.status(500).json({ message: "Unable to delete review" });
  }
});

app.get("/api/admin/products", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          p.id,
          p.title,
          p.slug,
          p.short_description,
          p.description,
          p.installation,
          p.price,
          p.old_price,
          p.discount_percent,
          p.category_id,
          c.slug AS category_slug,
          c.name AS category,
          p.seller_id,
          u.slug AS seller_slug,
          u.display_name AS seller_name,
          p.tags,
          p.is_featured,
          p.is_trending,
          p.is_new,
          p.is_hidden,
          p.created_at,
          COALESCE((SELECT pm2.thumbnail_url FROM product_media pm2 WHERE pm2.product_id = p.id ORDER BY pm2.sort_order ASC, pm2.id ASC LIMIT 1), '') AS thumbnail,
          COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status = 'completed'), 0)::int AS sales,
          COALESCE(
            json_agg(
              json_build_object(
                'id', pm.id,
                'type', pm.media_type,
                'url', pm.url,
                'thumbnail', pm.thumbnail_url,
                'sortOrder', pm.sort_order
              )
              ORDER BY pm.sort_order ASC, pm.id ASC
            ) FILTER (WHERE pm.id IS NOT NULL),
            '[]'::json
          ) AS media
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN users u ON u.id = p.seller_id
        LEFT JOIN product_media pm ON pm.product_id = p.id
        GROUP BY p.id, c.slug, c.name, u.slug, u.display_name
        ORDER BY p.created_at DESC, p.id DESC
      `
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Admin products error:", error);
    res.status(500).json({ message: "Unable to fetch admin products" });
  }
});

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  const {
    title,
    shortDescription,
    description,
    installation,
    categorySlug,
    sellerSlug,
    price,
    oldPrice,
    discountPercent,
    isHidden,
    tags,
    thumbnail,
  } = req.body;

  if (!title || !shortDescription || !description || !installation || !categorySlug || !sellerSlug) {
    return res.status(400).json({ message: "Missing required product fields" });
  }

  try {
    const category = await pool.query(`SELECT id FROM categories WHERE slug = $1 LIMIT 1`, [categorySlug]);
    const seller = await pool.query(`SELECT id FROM users WHERE slug = $1 OR email = $1 LIMIT 1`, [sellerSlug]);

    if (!category.rowCount || !seller.rowCount) {
      return res.status(400).json({ message: "Invalid category or seller" });
    }

    const inserted = await pool.query(
      `
        INSERT INTO products (
          seller_id,
          category_id,
          category,
          name,
          title,
          slug,
          short_description,
          description,
          installation,
          price,
          old_price,
          discount_percent,
          tags,
          is_new,
          is_hidden,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TRUE, $14, NOW(), NOW())
        RETURNING id, slug
      `,
      [
        seller.rows[0].id,
        category.rows[0].id,
        categorySlug,
        String(title).trim(),
        String(title).trim(),
        `${slugify(title)}-${Date.now()}`,
        String(shortDescription).trim(),
        String(description).trim(),
        String(installation).trim(),
        (Number(discountPercent || 0) > 0 ? Number(price || 0) * (1 - Number(discountPercent || 0) / 100) : Number(price || 0)),
        Number(price || 0),
        Number(discountPercent || 0),
        Array.isArray(tags) ? tags : [],
        !!isHidden,
      ]
    );

    if (thumbnail) {
      // thumbnail est maintenant une chaîne Base64
      await pool.query(
        `
          INSERT INTO product_media (product_id, media_type, url, thumbnail_url, sort_order)
          VALUES ($1, 'image', $2, $2, 0)
        `,
        [inserted.rows[0].id, String(thumbnail)]
      );
    }

    res.status(201).json(inserted.rows[0]);
  } catch (error) {
    console.error("Admin create product error:", error);
    res.status(500).json({ message: "Unable to create admin product" });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);

  if (Number.isNaN(productId)) {
    return res.status(400).json({ message: "Invalid product id" });
  }

  try {
    const result = await pool.query(`DELETE FROM products WHERE id = $1 RETURNING id`, [productId]);

    if (!result.rowCount) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Admin delete product error:", error);
    res.status(500).json({ message: "Unable to delete admin product" });
  }
});

// ─── Admin : Revenus (dashboard Stripe) ─────────────────────
// Copie lisible du dashboard Stripe : solde, paiements, transferts, commission.
app.get("/api/admin/revenue", requireAdmin, async (_req, res) => {
  try {
    const out = {
      stripeMode: "inconnu",
      accountId: null,
      accountEmail: null,
      balance: { available: [], pending: [] },
      stats: { chargesTotal: 0, transfersTotal: 0, feesTotal: 0, netTotal: 0 },
      charges: [],
      transfers: [],
      orders: [],
    };

    if (stripe) {
      out.stripeMode = STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "TEST";
      const account = await stripe.account.retrieve();
      out.accountId = account.id;
      out.accountEmail = account.email || null;

      const [balance, charges, transfers] = await Promise.all([
        stripe.balance.retrieve(),
        stripe.charges.list({ limit: 50 }),
        stripe.transfers.list({ limit: 50 }),
      ]);

      out.balance = {
        available: (balance.available || []).map((b) => ({ currency: b.currency, amount: b.amount / 100 })),
        pending: (balance.pending || []).map((b) => ({ currency: b.currency, amount: b.amount / 100 })),
      };

      out.charges = (charges.data || []).map((c) => ({
        id: c.id,
        amount: c.amount / 100,
        currency: c.currency,
        status: c.status,
        email: c.receipt_email || c.billing_details?.email || null,
        created: c.created * 1000,
        description: c.description || null,
      }));

      out.transfers = (transfers.data || []).map((t) => ({
        id: t.id,
        amount: t.amount / 100,
        currency: t.currency,
        status: t.status,
        destination: t.destination,
        created: t.created * 1000,
        description: t.description || null,
      }));

      out.stats.chargesTotal = out.charges.reduce((s, c) => s + (c.status === "succeeded" ? c.amount : 0), 0);
      out.stats.transfersTotal = out.transfers.reduce((s, t) => s + (t.status === "paid" ? t.amount : 0), 0);

      // Frais Stripe réels : balance_transactions de type "charge"
      try {
        const bts = await stripe.balanceTransactions.list({ limit: 100, type: "charge" });
        out.stats.feesTotal = (bts.data || []).reduce((s, bt) => s + bt.fee / 100, 0);
      } catch { /* non bloquant */ }

      out.stats.netTotal = out.stats.chargesTotal - out.stats.transfersTotal - out.stats.feesTotal;
    }

    // Stats commandes depuis la DB (commission plateforme réelle)
    const orders = await pool.query(`
      SELECT
        o.id, o.total_amount, o.created_at,
        COALESCE(o.stripe_fee_amount, 0) AS stripe_fee_amount,
        COALESCE(SUM(oi.platform_fee_amount), 0) AS platform_fee,
        COALESCE(SUM(oi.seller_net_amount), 0) AS seller_net,
        COUNT(DISTINCT oi.id) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status = 'completed'
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 50
    `);
    out.orders = orders.rows.map((r) => ({
      id: r.id,
      total: Number(r.total_amount),
      fee: Number(r.stripe_fee_amount),
      platformFee: Number(r.platform_fee),
      sellerNet: Number(r.seller_net),
      items: Number(r.items),
      createdAt: r.created_at,
    }));

    res.json(out);
  } catch (error) {
    console.error("Admin revenue error:", error);
    res.status(500).json({ message: "Unable to fetch revenue data" });
  }
});

// ─── Admin : Gestion des fichiers produits ─────────────────────

app.get("/api/admin/products/:id/files", requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!productId) return res.status(400).json({ message: "Invalid product id" });
    const files = await pool.query(`
      SELECT id, filename, file_size, storage_path, is_main, sort_order, created_at
      FROM product_files WHERE product_id = $1
      ORDER BY sort_order ASC, is_main DESC
    `, [productId]);
    res.json({ items: files.rows });
  } catch (error) {
    console.error("Admin list files error:", error);
    res.status(500).json({ message: "Unable to fetch files" });
  }
});

app.post("/api/admin/products/:id/files", requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const { filename, file_size, storage_path, is_main, sort_order } = req.body;
    if (!filename || !storage_path) {
      return res.status(400).json({ message: "filename et storage_path requis" });
    }
    const result = await pool.query(`
      INSERT INTO product_files (product_id, filename, file_size, storage_path, is_main, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [productId, filename, file_size || 0, storage_path, !!is_main, sort_order || 0]);
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    console.error("Admin register file error:", error);
    res.status(500).json({ message: "Unable to register file" });
  }
});

app.post("/api/admin/products/:id/upload", requireAdmin, async (req, res) => {
  try {
    if (!r2Client) return res.status(503).json({ message: "R2 non configuré" });
    const productId = Number(req.params.id);
    const { filename, data_base64 } = req.body;
    if (!filename || !data_base64) return res.status(400).json({ message: "filename et data_base64 requis" });
    const buffer = Buffer.from(data_base64, "base64");
    const key = `products/${productId}/${filename}`;
    await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer }));
    const result = await pool.query(`
      INSERT INTO product_files (product_id, filename, file_size, storage_path, is_main, sort_order)
      VALUES ($1, $2, $3, $4, FALSE, $5) RETURNING id
    `, [productId, filename, buffer.length, key, 0]);
    res.status(201).json({ ok: true, id: result.rows[0].id, key, size: buffer.length });
  } catch (error) {
    console.error("Admin upload file error:", error);
    res.status(500).json({ message: "Unable to upload file" });
  }
});

app.delete("/api/admin/products/:productId/files/:fileId", requireAdmin, async (req, res) => {
  try {
    const fileId = Number(req.params.fileId);
    const file = await pool.query(`SELECT storage_path FROM product_files WHERE id = $1`, [fileId]);
    if (!file.rowCount) return res.status(404).json({ message: "File not found" });
    if (r2Client) {
      try {
        await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: file.rows[0].storage_path }));
      } catch (r2Err) { console.error("R2 delete error:", r2Err); }
    }
    await pool.query(`DELETE FROM product_files WHERE id = $1`, [fileId]);
    res.json({ ok: true });
  } catch (error) {
    console.error("Admin delete file error:", error);
    res.status(500).json({ message: "Unable to delete file" });
  }
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// GET /api/admin/users -list all users
app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, role, avatar_url, discord_id, steam_id, created_at FROM users ORDER BY created_at DESC`
    );
    res.json(result.rows.map(r => ({
      id: r.id, email: r.email, displayName: r.display_name,
      role: r.role, avatarUrl: r.avatar_url,
      discordId: r.discord_id, steamId: r.steam_id, createdAt: r.created_at
    })));
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({ message: "Unable to fetch users" });
  }
});

app.get("/api/admin/promo-codes", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          pc.*,
          COALESCE(SUM(pr.discount_amount), 0) AS total_discount_amount,
          COALESCE(SUM(pr.order_amount), 0) AS total_order_amount,
          COALESCE(SUM(pr.points_awarded), 0) AS total_points_awarded,
          COUNT(pr.id)::int AS referral_count
        FROM promo_codes pc
        LEFT JOIN promo_redemptions pr ON pr.promo_code_id = pc.id
        GROUP BY pc.id
        ORDER BY pc.created_at DESC, pc.id DESC
      `
    );

    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        label: row.label,
        ambassadorName: row.ambassador_name,
        ambassadorContact: row.ambassador_contact,
        discountType: row.discount_type,
        discountValue: Number(row.discount_value),
        pointsPerRedemption: Number(row.points_per_redemption || 0),
        pointsBalance: Number(row.points_balance || 0),
        pointsRedeemed: Number(row.points_redeemed || 0),
        rewardNote: row.reward_note || "",
        maxRedemptions: row.max_redemptions,
        redeemedCount: row.redeemed_count,
        referralCount: Number(row.referral_count || 0),
        isActive: row.is_active,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        totalDiscountAmount: Number(row.total_discount_amount || 0),
        totalOrderAmount: Number(row.total_order_amount || 0),
        totalPointsAwarded: Number(row.total_points_awarded || 0),
      })),
    });
  } catch (error) {
    console.error("Admin promo codes error:", error);
    res.status(500).json({ message: "Unable to fetch promo codes" });
  }
});

app.post("/api/admin/promo-codes", requireAdmin, async (req, res) => {
  const ambassadorName = String(req.body.ambassadorName || "").trim();
  const ambassadorContact = String(req.body.ambassadorContact || "").trim();
  const discountType = req.body.discountType === "fixed" ? "fixed" : "percent";
  const discountValue = Number(req.body.discountValue || 0);
  const pointsPerRedemption = Math.max(0, Number(req.body.pointsPerRedemption || 1));
  const rewardNote = String(req.body.rewardNote || "").trim();
  const maxRedemptions = req.body.maxRedemptions ? Number(req.body.maxRedemptions) : null;
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  const requestedCode = normalizePromoCode(req.body.code);
  const code = requestedCode || generatePromoCode(ambassadorName || "AMB");

  if (!ambassadorName || !discountValue || discountValue <= 0 || (discountType === "percent" && discountValue > 100)) {
    return res.status(400).json({ message: "Ambassadeur et réduction valide requis." });
  }

  try {
    const result = await pool.query(
      `
        INSERT INTO promo_codes (
          code,
          label,
          ambassador_name,
          ambassador_contact,
          discount_type,
          discount_value,
          points_per_redemption,
          reward_note,
          max_redemptions,
          expires_at,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
      [
        code,
        String(req.body.label || `Code ambassadeur ${ambassadorName}`).trim(),
        ambassadorName,
        ambassadorContact,
        discountType,
        discountValue,
        pointsPerRedemption,
        rewardNote,
        maxRedemptions,
        expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
        req.session.user.id,
      ]
    );

    res.status(201).json({ ok: true, code: result.rows[0].code, promoCode: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "Ce code promo existe déjà." });
    }
    console.error("Admin create promo code error:", error);
    res.status(500).json({ message: "Unable to create promo code" });
  }
});

app.patch("/api/admin/promo-codes/:id", requireAdmin, async (req, res) => {
  const promoCodeId = Number(req.params.id);
  if (Number.isNaN(promoCodeId)) return res.status(400).json({ message: "Invalid promo code id" });

  const updates = [];
  const values = [];
  let idx = 1;

  if (req.body.isActive !== undefined) { updates.push(`is_active = $${idx++}`); values.push(Boolean(req.body.isActive)); }
  if (req.body.rewardNote !== undefined) { updates.push(`reward_note = $${idx++}`); values.push(String(req.body.rewardNote || "").trim()); }
  if (req.body.ambassadorContact !== undefined) { updates.push(`ambassador_contact = $${idx++}`); values.push(String(req.body.ambassadorContact || "").trim()); }
  if (req.body.pointsPerRedemption !== undefined) { updates.push(`points_per_redemption = $${idx++}`); values.push(Math.max(0, Number(req.body.pointsPerRedemption || 0))); }
  if (req.body.redeemPoints !== undefined) {
    const redeemPoints = Math.max(0, Number(req.body.redeemPoints || 0));
    updates.push(`points_balance = GREATEST(points_balance - $${idx}, 0)`); values.push(redeemPoints); idx += 1;
    updates.push(`points_redeemed = points_redeemed + $${idx}`); values.push(redeemPoints); idx += 1;
  }

  if (!updates.length) return res.status(400).json({ message: "Nothing to update" });

  try {
    values.push(promoCodeId);
    const result = await pool.query(`UPDATE promo_codes SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`, values);
    if (!result.rowCount) return res.status(404).json({ message: "Code ambassadeur introuvable." });
    res.json({ ok: true, promoCode: result.rows[0] });
  } catch (error) {
    console.error("Admin update promo code error:", error);
    res.status(500).json({ message: "Unable to update promo code" });
  }
});

// GET /api/admin/settings -get maintenance mode
app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'maintenance_mode'`);
    const landingConfig = await pool.query(`SELECT * FROM admin_landing_config ORDER BY id ASC`);
    res.json({ 
      maintenanceMode: result.rows[0]?.value === "true",
      landingConfig: landingConfig.rows
    });
  } catch (error) {
    console.error("Settings fetch error:", error);
    res.status(500).json({ message: "Unable to fetch settings" });
  }
});

// PATCH /api/admin/landing-config/:key -update landing configuration
app.patch("/api/admin/landing-config/:key", requireAdmin, async (req, res) => {
  const sectionKey = String(req.params.key);
  const { isActive, title, description, metadata } = req.body;
  
  try {
    const updates = [];
    const values = [];
    let idx = 1;

    if (isActive !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(Boolean(isActive));
    }
    if (title !== undefined) {
      updates.push(`title = $${idx++}`);
      values.push(String(title));
    }
    if (description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(String(description));
    }
    if (metadata !== undefined) {
      updates.push(`metadata = $${idx++}`);
      values.push(metadata && typeof metadata === "object" ? metadata : {});
    }

    if (!updates.length) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    values.push(sectionKey);
    
    // Insert if it doesn't exist, otherwise update
    const existing = await pool.query(`SELECT id FROM admin_landing_config WHERE section_key = $1`, [sectionKey]);
    
    if (!existing.rowCount) {
       await pool.query(
         `INSERT INTO admin_landing_config (section_key, is_active, title, description) VALUES ($1, $2, $3, $4)`,
         [sectionKey, isActive !== undefined ? Boolean(isActive) : true, title || sectionKey, description || '']
       );
       if (metadata !== undefined) {
         await pool.query(
           `UPDATE admin_landing_config SET metadata = $1 WHERE section_key = $2`,
           [metadata && typeof metadata === "object" ? metadata : {}, sectionKey]
         );
       }
    } else {
       await pool.query(
         `UPDATE admin_landing_config SET ${updates.join(", ")} WHERE section_key = $${idx}`,
         values
       );
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error("Landing config update error:", error);
    res.status(500).json({ message: "Unable to update landing config" });
  }
});

// DELETE /api/admin/landing-config/:key - remove landing configuration
app.delete("/api/admin/landing-config/:key", requireAdmin, async (req, res) => {
  const sectionKey = String(req.params.key);
  try {
    await pool.query(`DELETE FROM admin_landing_config WHERE section_key = $1`, [sectionKey]);
    res.json({ ok: true, deleted: true });
  } catch (error) {
    console.error("Landing config delete error:", error);
    res.status(500).json({ message: "Unable to delete landing config" });
  }
});

// ─── Admin : Demandes vendeurs ─────────────────────────────
// Lister les demandes en attente
app.get("/api/admin/seller-requests", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, email, display_name AS "displayName", slug, seller_description AS "sellerDescription",
             shop_name AS "shopName", discord_tag AS "discordTag", created_at AS "createdAt"
      FROM users
      WHERE seller_status = 'pending'
      ORDER BY created_at ASC
    `);
    res.json({ items: result.rows });
  } catch (error) {
    console.error("Seller requests error:", error);
    res.status(500).json({ message: "Unable to fetch seller requests" });
  }
});

// Approuver un vendeur
app.post("/api/admin/seller-requests/:id/approve", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!userId) return res.status(400).json({ message: "Invalid user id" });

    const result = await pool.query(`
      UPDATE users SET seller_status = 'approved', role = 'seller'
      WHERE id = $1 AND seller_status = 'pending'
      RETURNING id, email, display_name, slug, role, seller_status
    `, [userId]);

    if (!result.rowCount) {
      return res.status(404).json({ message: "Demande introuvable ou déjà traitée" });
    }

    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("Approve seller error:", error);
    res.status(500).json({ message: "Unable to approve seller" });
  }
});

// Refuser un vendeur
app.get("/api/admin/tags", async (_req, res) => { try { const r = await pool.query("SELECT DISTINCT unnest(tags) AS tag FROM products ORDER BY tag"); res.json({ tags: r.rows.map(t => t.tag) }); } catch { res.json({ tags: [] }); } });

app.post("/api/admin/seller-requests/:id/reject", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!userId) return res.status(400).json({ message: "Invalid user id" });

    const result = await pool.query(`
      UPDATE users SET seller_status = 'rejected'
      WHERE id = $1 AND seller_status = 'pending'
      RETURNING id, email, display_name, slug, role, seller_status
    `, [userId]);

    if (!result.rowCount) {
      return res.status(404).json({ message: "Demande introuvable ou déjà traitée" });
    }

    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("Reject seller error:", error);
    res.status(500).json({ message: "Unable to reject seller" });
  }
});

// PATCH /api/admin/settings -update maintenance mode
app.patch("/api/admin/settings", requireAdmin, async (req, res) => {
  const { maintenanceMode } = req.body;
  if (maintenanceMode === undefined) return res.status(400).json({ message: "maintenanceMode is required" });

  try {
    await pool.query(
      `UPDATE settings SET value = $1 WHERE key = 'maintenance_mode'`,
      [maintenanceMode ? "true" : "false"]
    );
    res.json({ ok: true, maintenanceMode: Boolean(maintenanceMode) });
  } catch (error) {
    console.error("Settings update error:", error);
    res.status(500).json({ message: "Unable to update settings" });
  }
});

// PATCH /api/admin/users/:id/role -update user role
app.patch("/api/admin/users/:id/role", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body;
  const allowedRoles = ["customer", "seller", "admin"];
  if (Number.isNaN(userId) || !allowedRoles.includes(role)) {
    return res.status(400).json({ message: "Invalid user id or role" });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, display_name, role`,
      [role, userId]
    );
    if (!result.rowCount) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("Admin role update error:", error);
    res.status(500).json({ message: "Unable to update role" });
  }
});

// PATCH /api/admin/products/:id -update product fields
app.patch("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  if (Number.isNaN(productId)) return res.status(400).json({ message: "Invalid product id" });
  const { 
    title, price, discountPercent, isFeatured, isTrending, isNew,
    shortDescription, description, installation, categorySlug, sellerSlug, tags, isHidden,
    thumbnail
  } = req.body;
  
  try {
    let categoryId = null;
    let categoryName = null;
    if (categorySlug) {
      const catResult = await pool.query(`SELECT id, name FROM categories WHERE slug = $1 LIMIT 1`, [categorySlug]);
      if (catResult.rowCount) {
        categoryId = catResult.rows[0].id;
        categoryName = catResult.rows[0].name;
      }
    }

    // Résoudre le vendeur si un sellerSlug est fourni (comme le POST)
    let sellerId = null;
    if (sellerSlug) {
      const sellerResult = await pool.query(`SELECT id FROM users WHERE slug = $1 OR email = $1 LIMIT 1`, [sellerSlug]);
      if (!sellerResult.rowCount) return res.status(400).json({ message: "Invalid seller" });
      sellerId = sellerResult.rows[0].id;
    }

      const updates = []; const values = []; let idx = 1;
      if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(String(title).trim()); }
      if (shortDescription !== undefined) { updates.push(`short_description = $${idx++}`); values.push(String(shortDescription).trim()); }
      if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(String(description).trim()); }
      if (installation !== undefined) { updates.push(`installation = $${idx++}`); values.push(String(installation).trim()); }
      if (categoryId !== null) {
        updates.push(`category_id = $${idx++}`); values.push(categoryId);
        updates.push(`category = $${idx++}`); values.push(categoryName);
      }
      if (price !== undefined && discountPercent !== undefined) {
        const basePrice = Number(price);
        const discount = Number(discountPercent);
        const newPrice = discount > 0 ? basePrice * (1 - discount / 100) : basePrice;

        updates.push(`old_price = $${idx++}`); values.push(basePrice);
        updates.push(`price = $${idx++}`); values.push(newPrice);
        updates.push(`discount_percent = $${idx++}`); values.push(discount);
      } else if (price !== undefined) {
        updates.push(`old_price = $${idx++}`); values.push(Number(price));
        updates.push(`price = $${idx++}`); values.push(Number(price));
      } else if (discountPercent !== undefined) {
        // If only discountPercent is provided, we need to fetch the old_price to calculate the new price
        const currentProductResult = await pool.query(`SELECT old_price, price FROM products WHERE id = $1`, [productId]);
        if (currentProductResult.rowCount > 0) {
            const currentProduct = currentProductResult.rows[0];
            const basePrice = Number(currentProduct.old_price) > 0 ? Number(currentProduct.old_price) : Number(currentProduct.price);
            const discount = Number(discountPercent);
            const newPrice = discount > 0 ? basePrice * (1 - discount / 100) : basePrice;

            updates.push(`old_price = $${idx++}`); values.push(basePrice);
            updates.push(`price = $${idx++}`); values.push(newPrice);
            updates.push(`discount_percent = $${idx++}`); values.push(discount);
        }
      }
      if (tags !== undefined) { updates.push(`tags = $${idx++}`); values.push(Array.isArray(tags) ? tags : []); }
      if (isFeatured !== undefined) { updates.push(`is_featured = $${idx++}`); values.push(Boolean(isFeatured)); }
      if (isTrending !== undefined) { updates.push(`is_trending = $${idx++}`); values.push(Boolean(isTrending)); }
      if (isNew !== undefined) { updates.push(`is_new = $${idx++}`); values.push(Boolean(isNew)); }
      if (isHidden !== undefined) { updates.push(`is_hidden = $${idx++}`); values.push(Boolean(isHidden)); }
      if (sellerId !== null) { updates.push(`seller_id = $${idx++}`); values.push(sellerId); }
    
    if (!updates.length) return res.status(400).json({ message: "Nothing to update" });
    
    values.push(productId);
    const result = await pool.query(
      `UPDATE products SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${idx} RETURNING id, title, slug, price, discount_percent`,
      values
    );
    if (!result.rowCount) return res.status(404).json({ message: "Product not found" });

    if (thumbnail) {
      // Update or insert the main thumbnail (sort_order = 0)
      await pool.query(`DELETE FROM product_media WHERE product_id = $1 AND sort_order = 0`, [productId]);
      await pool.query(
        `INSERT INTO product_media (product_id, media_type, url, thumbnail_url, sort_order)
         VALUES ($1, 'image', $2, $2, 0)`,
        [productId, String(thumbnail)]
      );
    }

    res.json({ ok: true, product: result.rows[0] });
  } catch (error) {
    console.error("Admin product update error:", error);
    res.status(500).json({ message: "Unable to update product" });
  }
});

app.post("/api/admin/products/:id/media", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const url = String(req.body?.url || "").trim();
  if (Number.isNaN(productId) || !url) {
    return res.status(400).json({ message: "url required" });
  }
  try {
    const sortRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM product_media WHERE product_id = $1`,
      [productId]
    );
    const next = Number(sortRes.rows[0].next);
    const r = await pool.query(
      `INSERT INTO product_media (product_id, media_type, url, thumbnail_url, sort_order) VALUES ($1, 'image', $2, $2, $3) RETURNING id`,
      [productId, url, next]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (error) {
    console.error("Add media error:", error);
    res.status(500).json({ message: "Unable to add media" });
  }
});

app.delete("/api/admin/products/:id/media/:mediaId", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const mediaId = Number(req.params.mediaId);
  if (Number.isNaN(productId) || Number.isNaN(mediaId)) {
    return res.status(400).json({ message: "Invalid ids" });
  }
  try {
    await pool.query(`DELETE FROM product_media WHERE id = $1 AND product_id = $2`, [mediaId, productId]);
    res.json({ ok: true });
  } catch (error) {
    console.error("Delete media error:", error);
    res.status(500).json({ message: "Unable to delete media" });
  }
});

// ── Page Content API ──────────────────────────────────────────────────────

// GET /api/page-content/:page -public, returns stored content (or defaults)
app.get("/api/page-content/:page", async (req, res) => {
  try {
    const page = String(req.params.page).slice(0, 40);
    const allowedPages = ["prestation", "about", "footer"];
    if (!allowedPages.includes(page)) {
      return res.status(404).json({ message: "Unknown page" });
    }
    const result = await pool.query(`SELECT value FROM settings WHERE key = $1`, [`page_content_${page}`]);
    if (result.rowCount) {
      try {
        return res.json(JSON.parse(result.rows[0].value));
      } catch (_) {
        return res.json({});
      }
    }
    return res.json({});
  } catch (error) {
    console.error("Page content get error:", error);
    res.status(500).json({ message: "Unable to load page content" });
  }
});

// PATCH /api/admin/page-content/:page -admin only, saves page content
app.patch("/api/admin/page-content/:page", requireAdmin, async (req, res) => {
  try {
    const page = String(req.params.page).slice(0, 40);
    const allowedPages = ["prestation", "about", "footer"];
    if (!allowedPages.includes(page)) {
      return res.status(404).json({ message: "Unknown page" });
    }

    const content = req.body;
    if (!content || typeof content !== "object") {
      return res.status(400).json({ message: "Content object is required" });
    }

    // Upsert into settings table
    const key = `page_content_${page}`;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(content)]
    );

    res.json({ ok: true, page, saved: true });
  } catch (error) {
    console.error("Page content save error:", error);
    res.status(500).json({ message: "Unable to save page content" });
  }
});

initializeDatabase()
  .then(() => {
    // Ne démarrer app.listen que si on n'est PAS sur Vercel
    if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
      app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
      });
    }
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    if (process.env.NODE_ENV !== "production") {
      process.exit(1);
    }
  });

// Export pour Vercel Serverless
module.exports = app;
