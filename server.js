require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT) || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@gstore.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin1234!";

app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);
app.use(express.static(path.join(__dirname)));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  next();
}

app.post("/auth/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid admin credentials" });
  }

  req.session.admin = {
    email: ADMIN_EMAIL,
    role: "admin",
  };

  res.json({
    ok: true,
    admin: req.session.admin,
  });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({
    authenticated: Boolean(req.session.admin),
    user: req.session.admin || null,
  });
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
    return res.redirect("/?error=missing_code");
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
    req.session.discordUser = {
      id: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name,
      avatar: discordUser.avatar,
      email: discordUser.email || null,
    };

    res.redirect("/");
  } catch (error) {
    console.error("Discord auth error:", error);
    res.redirect("/?error=discord_auth_failed");
  }
});

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

app.get("/api/products", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, price, description, category, tags, created_at
      FROM products
      ORDER BY created_at DESC, id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ message: "Unable to fetch products" });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  const { name, price, description, category, tags } = req.body;

  if (!name || !description || !category) {
    return res.status(400).json({
      message: "name, description and category are required",
    });
  }

  const normalizedPrice = Number(price);
  if (Number.isNaN(normalizedPrice) || normalizedPrice < 0) {
    return res.status(400).json({
      message: "price must be a valid positive number",
    });
  }

  const normalizedTags = Array.isArray(tags)
    ? tags
        .map((tag) => String(tag).trim())
        .filter(Boolean)
    : [];

  try {
    const result = await pool.query(
      `
        INSERT INTO products (name, price, description, category, tags)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, price, description, category, tags, created_at
      `,
      [String(name).trim(), normalizedPrice, String(description).trim(), String(category).trim(), normalizedTags]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ message: "Unable to create product" });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);

  if (Number.isNaN(productId)) {
    return res.status(400).json({ message: "Invalid product id" });
  }

  try {
    const result = await pool.query(
      `
        DELETE FROM products
        WHERE id = $1
        RETURNING id
      `,
      [productId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json({ message: "Product deleted" });
  } catch (error) {
    console.error("Delete product error:", error);
    res.status(500).json({ message: "Unable to delete product" });
  }
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
