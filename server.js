require("dotenv").config();

const path = require("path");
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
const BASE_URL_COMPUTED = VERCEL_URL ? `https://${VERCEL_URL}` : `http://localhost:${port}`;

const STEAM_REALM = process.env.STEAM_REALM || BASE_URL_COMPUTED;
const STEAM_RETURN_URL =
  process.env.STEAM_RETURN_URL || `${BASE_URL_COMPUTED}/auth/steam/callback`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY || "";
const APP_BASE_URL = process.env.APP_BASE_URL || BASE_URL_COMPUTED;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

app.use(cors());
app.use(express.json());
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
      sameSite: "lax",
      // Force à false pour tester si c'est bien la source du problème (souvent le cas sur les domaines sans SSL explicite en dev)
      secure: false, 
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 jours
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
    role: row.role,
    avatarUrl: row.avatar_url,
    preferredLanguage: row.preferred_language,
    discordId: row.discord_id || null,
    steamId: row.steam_id || null,
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

async function getProductBySlug(slug) {
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
        u.display_name
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
    createdAt: review.created_at,
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
    ALTER TABLE products ADD COLUMN IF NOT EXISTS popularity_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT UNIQUE;

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid varchar NOT NULL COLLATE "default",
      sess json NOT NULL,
      expire timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON user_sessions ("expire");
  `);

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
    const [categories, trending, discounts, featured] = await Promise.all([
      pool.query(`SELECT name, slug, description FROM categories ORDER BY sort_order ASC, name ASC`),
      pool.query(
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
            p.is_featured,
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
            p.old_price,
            p.discount_percent,
            p.rating,
            p.review_count,
            p.tags,
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
    ]);

    res.json({
      locale: req.session.locale || "fr",
      user: req.session.user || null,
      categories: categories.rows,
      trending: trending.rows,
      discounts: discounts.rows,
      featuredByCategory: featured.rows.map((row) => ({
        categorySlug: row.category_slug,
        categoryName: row.category_name,
        products: row.products || [],
      })),
      collaborators: ["Tresingo", "Atelier Nova", "Hexa Studio", "Forge 27", "Northline"],
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

app.get("/api/products/:slug", async (req, res) => {
  try {
    const product = await getProductBySlug(req.params.slug);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await pool.query(`UPDATE products SET views = views + 1, updated_at = NOW() WHERE id = $1`, [product.id]);
    product.views += 1;

    res.json(product);
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
  const { email, password, displayName, preferredLanguage } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ message: "email, password and displayName are required" });
  }

  try {
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [String(email).trim().toLowerCase()]);
    if (existing.rowCount) {
      return res.status(409).json({ message: "Email already in use" });
    }

    const inserted = await pool.query(
      `
        INSERT INTO users (email, password_hash, display_name, slug, role, preferred_language)
        VALUES ($1, $2, $3, $4, 'customer', $5)
        RETURNING *
      `,
      [
        String(email).trim().toLowerCase(),
        hashPassword(password),
        String(displayName).trim(),
        `${slugify(displayName)}-${Date.now()}`,
        preferredLanguage === "en" ? "en" : "fr",
      ]
    );

    req.session.user = sanitizeUser(inserted.rows[0]);

    res.status(201).json({
      ok: true,
      user: req.session.user,
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
  req.session.destroy(() => {
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
      return res.redirect("/profile.html");
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
    res.redirect("/");
  } catch (error) {
    console.error("Steam auth error:", error);
    res.redirect("/login.html?error=steam_auth_failed");
  }
});

app.get("/auth/discord", (req, res) => {
  const scope = encodeURIComponent("identify email");
  const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URI);
  const discordUrl =
    `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}` +
    `&response_type=code&redirect_uri=${redirectUri}&scope=${scope}`;

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
      return res.redirect("/profile.html");
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
    res.redirect("/");
  } catch (error) {
    console.error("Discord auth error:", error);
    res.redirect("/login.html?error=discord_auth_failed");
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

app.post("/api/checkout/create-session", requireAuth, async (req, res) => {
  if (!stripe || !STRIPE_PUBLIC_KEY) {
    return res.status(503).json({
      message: "Stripe n'est pas configuré. Ajoutez STRIPE_SECRET_KEY et STRIPE_PUBLIC_KEY dans l'environnement.",
    });
  }

  try {
    const cart = await getCart(req.session.user.id);

    if (!cart.items.length) {
      return res.status(400).json({ message: "Votre panier est vide." });
    }

    const lineItems = cart.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: "eur",
        unit_amount: Math.round(Number(item.product.price) * 100),
        product_data: {
          name: item.product.title,
          images:
            item.product.preview?.thumbnail || item.product.preview?.url
              ? [item.product.preview.thumbnail || item.product.preview.url]
              : [],
          metadata: {
            productSlug: item.product.slug,
            productId: String(item.product.id),
          },
        },
      },
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.session.user.email,
      line_items: lineItems,
      success_url: `${APP_BASE_URL}/cart.html?checkout=success`,
      cancel_url: `${APP_BASE_URL}/cart.html?checkout=cancel`,
      metadata: {
        userId: String(req.session.user.id),
        cartId: String(cart.id),
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

app.post("/api/reviews", requireAuth, async (req, res) => {
  const { productId, rating, comment } = req.body;
  const normalizedProductId = Number(productId);
  const normalizedRating = Number(rating);

  if (Number.isNaN(normalizedProductId) || Number.isNaN(normalizedRating) || !comment) {
    return res.status(400).json({ message: "Invalid review payload" });
  }

  try {
    await pool.query(
      `
        INSERT INTO reviews (product_id, user_id, rating, comment)
        VALUES ($1, $2, $3, $4)
      `,
      [normalizedProductId, req.session.user.id, normalizedRating, String(comment).trim()]
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

    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("Review error:", error);
    res.status(500).json({ message: "Unable to submit review" });
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
          p.price,
          p.discount_percent,
          c.name AS category,
          p.created_at
        FROM products p
        JOIN categories c ON c.id = p.category_id
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
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TRUE, NOW(), NOW())
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
        Number(price || 0),
        Number(oldPrice || price || 0),
        Number(discountPercent || 0),
        Array.isArray(tags) ? tags : [],
      ]
    );

    if (thumbnail) {
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

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// GET /api/admin/users — list all users
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

// GET /api/admin/settings — get maintenance mode
app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'maintenance_mode'`);
    res.json({ maintenanceMode: result.rows[0]?.value === "true" });
  } catch (error) {
    console.error("Settings fetch error:", error);
    res.status(500).json({ message: "Unable to fetch settings" });
  }
});

// PATCH /api/admin/settings — update maintenance mode
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

// PATCH /api/admin/users/:id/role — update user role
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

// PATCH /api/admin/products/:id — update product fields
app.patch("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  if (Number.isNaN(productId)) return res.status(400).json({ message: "Invalid product id" });
  const { title, price, discountPercent, isFeatured, isTrending, isNew } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(String(title).trim()); }
    if (price !== undefined) { updates.push(`price = $${idx++}`); values.push(Number(price)); }
    if (discountPercent !== undefined) { updates.push(`discount_percent = $${idx++}`); values.push(Number(discountPercent)); }
    if (isFeatured !== undefined) { updates.push(`is_featured = $${idx++}`); values.push(Boolean(isFeatured)); }
    if (isTrending !== undefined) { updates.push(`is_trending = $${idx++}`); values.push(Boolean(isTrending)); }
    if (isNew !== undefined) { updates.push(`is_new = $${idx++}`); values.push(Boolean(isNew)); }
    if (!updates.length) return res.status(400).json({ message: "Nothing to update" });
    values.push(productId);
    const result = await pool.query(
      `UPDATE products SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${idx} RETURNING id, title, slug, price, discount_percent`,
      values
    );
    if (!result.rowCount) return res.status(404).json({ message: "Product not found" });
    res.json({ ok: true, product: result.rows[0] });
  } catch (error) {
    console.error("Admin product update error:", error);
    res.status(500).json({ message: "Unable to update product" });
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
