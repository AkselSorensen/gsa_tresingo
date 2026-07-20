const form = document.getElementById("product-form-element");
const loginForm = document.getElementById("admin-login-form");
const formMessage = document.getElementById("form-message");
const authMessage = document.getElementById("auth-message");
const productsContainer = document.getElementById("products-list-container");
const apiStatus = document.getElementById("api-status");
const authPanel = document.getElementById("auth-panel");
const dashboard = document.getElementById("dashboard");
const userName = document.getElementById("user-name");
const userEmail = document.getElementById("user-email");
const userAvatar = document.getElementById("user-avatar");
const logoutButton = document.getElementById("logout-btn");

function setMessage(message, type = "default") {
  formMessage.textContent = message;
  formMessage.style.color =
    type === "error" ? "#ff9a9a" : type === "success" ? "#74e39a" : "#b5b5b5";
}

function setAuthMessage(message, type = "default") {
  authMessage.textContent = message;
  authMessage.style.color =
    type === "error" ? "#ff9a9a" : type === "success" ? "#74e39a" : "#b5b5b5";
}

function formatPrice(value) {
  return `$${Number(value).toFixed(2)}`;
}

function createTagMarkup(tags = []) {
  if (!tags.length) {
    return '<span class="product-tag">No tags</span>';
  }

  return tags.map((tag) => `<span class="product-tag">${tag}</span>`).join("");
}

function renderProducts(products) {
  if (!products.length) {
    productsContainer.innerHTML = '<div class="empty-state">No products saved yet.</div>';
    return;
  }

  productsContainer.innerHTML = products
    .map(
      (product) => `
        <article class="product-item">
          <div class="product-item-head">
            <h3>${product.name}</h3>
            <span class="product-price">${formatPrice(product.price)}</span>
          </div>

          <span class="product-category">${product.category}</span>
          <p class="product-description">${product.description}</p>

          <div class="product-item-meta">
            <div class="product-tags">
              ${createTagMarkup(product.tags)}
            </div>

            <button class="delete-btn" data-id="${product.id}">Delete</button>
          </div>
        </article>
      `
    )
    .join("");

  document.querySelectorAll(".delete-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;

      try {
        button.disabled = true;
        const response = await fetch(`/api/products/${id}`, { method: "DELETE" });

        if (!response.ok) {
          throw new Error("Unable to delete product");
        }

        await loadProducts();
      } catch (error) {
        console.error(error);
        setMessage("Unable to delete product.", "error");
      } finally {
        button.disabled = false;
      }
    });
  });
}

function showDashboard(user) {
  authPanel.hidden = true;
  dashboard.hidden = false;
  userName.textContent = user.email || "Admin User";
  userEmail.textContent = "Connected as admin";
  userAvatar.textContent = (user.email || "A").slice(0, 1).toUpperCase();
}

function showLogin() {
  authPanel.hidden = false;
  dashboard.hidden = true;
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      throw new Error("Health check failed");
    }

    apiStatus.textContent = "API connected";
    apiStatus.style.color = "#74e39a";
  } catch (error) {
    console.error(error);
    apiStatus.textContent = "API offline";
    apiStatus.style.color = "#ff9a9a";
  }
}

async function loadProducts() {
  try {
    const response = await fetch("/api/products");

    if (response.status === 401) {
      showLogin();
      return;
    }

    if (!response.ok) {
      throw new Error("Unable to load products");
    }

    const products = await response.json();
    renderProducts(products);
  } catch (error) {
    console.error(error);
    productsContainer.innerHTML =
      '<div class="empty-state">Unable to load products from API.</div>';
  }
}

async function checkAuth() {
  try {
    const response = await fetch("/api/me");
    const data = await response.json();

    if (!data.authenticated || !data.user) {
      showLogin();
      return false;
    }

    showDashboard(data.user);
    await loadHealth();
    await loadProducts();
    return true;
  } catch (error) {
    console.error(error);
    showLogin();
    return false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthMessage("Connexion admin en cours...");

  const formData = new FormData(loginForm);
  const payload = {
    email: formData.get("email")?.toString().trim(),
    password: formData.get("password")?.toString(),
  };

  try {
    const response = await fetch("/auth/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Unable to login");
    }

    loginForm.reset();
    setAuthMessage("Connexion admin réussie.", "success");
    showDashboard(data.admin);
    await loadHealth();
    await loadProducts();
  } catch (error) {
    console.error(error);
    setAuthMessage(error.message, "error");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("Creating product...");

  const formData = new FormData(form);
  const payload = {
    name: formData.get("name")?.toString().trim(),
    price: formData.get("price"),
    description: formData.get("description")?.toString().trim(),
    category: formData.get("category")?.toString().trim(),
    tags: formData
      .get("tags")
      ?.toString()
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };

  try {
    const response = await fetch("/api/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Unable to create product");
    }

    form.reset();
    setMessage(`Product "${data.name}" created successfully.`, "success");
    await loadProducts();
  } catch (error) {
    console.error(error);
    setMessage(error.message, "error");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await fetch("/auth/logout", { method: "POST" });
    showLogin();
    setAuthMessage("Logged out successfully.", "success");
  } catch (error) {
    console.error(error);
    setAuthMessage("Unable to logout.", "error");
  }
});

checkAuth();

// ── Page Content Editor ──────────────────────────────────────────

const pageContentFields = {
  prestation: [
    "heroTitle", "heroSubtitle",
    "card1Title", "card1Text", "card1Bullets", "card1BtnText", "card1BtnUrl",
    "card2Title", "card2Text", "card2Bullets", "card2BtnText", "card2BtnUrl",
    "card3Title", "card3Text", "card3Bullets", "card3BtnText", "card3BtnUrl",
  ],
  about: [
    "heroTitle", "heroSubtitle",
    "sec1Title", "sec1Text", "sec1Bullets",
    "sec2Title", "sec2Text", "sec2Bullets",
    "sec3Title", "sec3Text", "sec3Bullets",
  ]
};

async function saveFooter() {
  const el = document.getElementById("footer-copy");
  const msg = document.getElementById("page-msg-footer");
  if (!el || !msg) return;
  try {
    await apiFetch("/api/admin/page-content/footer", {
      method: "PATCH",
      body: JSON.stringify({ footerText: el.value.trim() }),
    });
    msg.textContent = "✓ OK";
  } catch (e) {
    msg.textContent = "✕ Erreur";
  }
}

async function loadFooter() {
  try {
    const data = await apiFetch("/api/page-content/footer");
    const el = document.getElementById("footer-copy");
    if (el && data?.footerText) { el.value = data.footerText; updatePreviewAll(); }
  } catch (e) {}
}

// ── Preview functions ─────────────────────────────────────────────
function previewFooter() {
  const val = document.getElementById("footer-copy")?.value || "";
  const el = document.querySelector(".footer-copy-preview");
  if (el) el.textContent = val;
}

function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function previewPrestation() {
  const title = document.getElementById("prest-heroTitle")?.value || "Titre";
  const sub = document.getElementById("prest-heroSubtitle")?.value || "Sous-titre";
  document.getElementById("pv-prest-title").textContent = title;
  document.getElementById("pv-prest-sub").textContent = sub;

  const cards = [1,2,3].map(i => ({
    t: document.getElementById(`prest-card${i}Title`)?.value || "",
    x: document.getElementById(`prest-card${i}Text`)?.value || "",
    b: (document.getElementById(`prest-card${i}Bullets`)?.value || "").split("\n").map(s=>s.trim()).filter(Boolean),
    btn: document.getElementById(`prest-card${i}BtnText`)?.value || "",
    url: document.getElementById(`prest-card${i}BtnUrl`)?.value || ""
  }));

  const container = document.getElementById("pv-prest-cards");
  if (!container) return;
  container.innerHTML = cards.map(c => `
    <div class="panel" style="padding:10px;display:grid;gap:4px;">
      ${c.t ? `<strong style="font-size:0.82rem;color:#2bb8ff;">${escHtml(c.t)}</strong>` : ""}
      ${c.x ? `<p style="margin:0;font-size:0.7rem;color:var(--muted);">${escHtml(c.x)}</p>` : ""}
      ${c.b.length ? `<ul style="margin:0;padding:0 0 0 14px;font-size:0.65rem;color:var(--muted-2);">${c.b.map(b => `<li>${escHtml(b)}</li>`).join("")}</ul>` : ""}
      ${c.btn ? `<button class="ghost-button" style="margin-top:4px;font-size:0.68rem;min-height:24px;padding:0 8px;justify-self:start;">${escHtml(c.btn)}</button>` : ""}
    </div>
  `).join("");
}

function previewAbout() {
  const title = document.getElementById("about-heroTitle")?.value || "Titre";
  const sub = document.getElementById("about-heroSubtitle")?.value || "Sous-titre";
  document.getElementById("pv-about-title").textContent = title;
  document.getElementById("pv-about-sub").textContent = sub;

  const sections = [1,2,3].map(i => ({
    t: document.getElementById(`about-sec${i}-title`)?.value || "",
    x: document.getElementById(`about-sec${i}-text`)?.value || "",
    b: (document.getElementById(`about-sec${i}-bullets`)?.value || "").split("\n").map(s=>s.trim()).filter(Boolean)
  })).filter(s => s.t || s.x || s.b.length);

  const container = document.getElementById("pv-about-sections");
  if (!container) return;
  if (!sections.length) { container.innerHTML = '<p style="font-size:0.78rem;color:var(--muted);">Contenu de la section...</p>'; return; }
  container.innerHTML = sections.map(s => `
    ${s.t ? `<h3 style="margin:0 0 4px;font-size:0.95rem;color:#fff;">${escHtml(s.t)}</h3>` : ""}
    ${s.x ? `<p style="margin:0 0 6px;font-size:0.78rem;color:var(--muted);">${escHtml(s.x)}</p>` : ""}
    ${s.b.length ? `<ul style="margin:0 0 10px;padding:0 0 0 16px;font-size:0.78rem;color:var(--muted-2);">${s.b.map(b => `<li>${escHtml(b)}</li>`).join("")}</ul>` : ""}
  `).join("");
}

function updatePreviewAll() {
  previewFooter();
  previewPrestation();
  previewAbout();
}

async function loadPageContent(page) {
  try {
    const data = await apiFetch(`/api/page-content/${page}`);
    if (!data || typeof data !== 'object') return;

    if (page === "prestation") {
      document.getElementById("prest-heroTitle").value = data.heroTitle || "";
      document.getElementById("prest-heroSubtitle").value = data.heroSubtitle || "";
      (data.cards || []).forEach((card, i) => {
        const idx = i + 1;
        setVal(`prest-card${idx}Title`, card.title);
        setVal(`prest-card${idx}Text`, card.text);
        setVal(`prest-card${idx}Bullets`, (card.bullets || []).join("\n"));
        setVal(`prest-card${idx}BtnText`, card.btn);
        setVal(`prest-card${idx}BtnUrl`, card.url);
      });
    }

    if (page === "about") {
      document.getElementById("about-heroTitle").value = data.heroTitle || "";
      document.getElementById("about-heroSubtitle").value = data.heroSubtitle || "";
      (data.sections || []).forEach((sec, i) => {
        const idx = i + 1;
        setVal(`about-sec${idx}-title`, sec.title || "");
        setVal(`about-sec${idx}-text`, sec.text || "");
        setVal(`about-sec${idx}-bullets`, (sec.bullets || []).join("\n"));
      });
    }
    updatePreviewAll();
  } catch (err) {
    console.error(`Load ${page} error:`, err);
  }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val || "";
}

async function savePageContent(page) {
  const msgEl = document.getElementById(`page-msg-${page}`);
  if (!msgEl) return;

  try {
    const content = {};

    if (page === "prestation") {
      content.heroTitle = document.getElementById("prest-heroTitle")?.value?.trim() || "";
      content.heroSubtitle = document.getElementById("prest-heroSubtitle")?.value?.trim() || "";
      content.cards = [1,2,3].map(i => ({
        title: document.getElementById(`prest-card${i}Title`)?.value?.trim() || "",
        text: document.getElementById(`prest-card${i}Text`)?.value?.trim() || "",
        bullets: (document.getElementById(`prest-card${i}Bullets`)?.value?.trim() || "").split("\n").map(s=>s.trim()).filter(Boolean),
        btn: document.getElementById(`prest-card${i}BtnText`)?.value?.trim() || "",
        url: document.getElementById(`prest-card${i}BtnUrl`)?.value?.trim() || "",
      }));
    }

    if (page === "about") {
      content.heroTitle = document.getElementById("about-heroTitle")?.value?.trim() || "";
      content.heroSubtitle = document.getElementById("about-heroSubtitle")?.value?.trim() || "";
      content.sections = [1,2,3].map(i => {
        const sec = {};
        const t = document.getElementById(`about-sec${i}-title`)?.value?.trim();
        const x = document.getElementById(`about-sec${i}-text`)?.value?.trim();
        const b = (document.getElementById(`about-sec${i}-bullets`)?.value?.trim() || "").split("\n").map(s=>s.trim()).filter(Boolean);
        if (t) sec.title = t;
        if (x) sec.text = x;
        if (b.length) sec.bullets = b;
        return Object.keys(sec).length ? sec : null;
      }).filter(Boolean);
    }

    await apiFetch(`/api/admin/page-content/${page}`, {
      method: "PATCH",
      body: JSON.stringify(content),
    });

    msgEl.textContent = "✓ Contenu sauvegardé !";
    msgEl.className = "admin-msg ok";
    setTimeout(() => { msgEl.textContent = ""; msgEl.className = "admin-msg"; }, 3000);
  } catch (err) {
    msgEl.textContent = "✕ " + err.message;
    msgEl.className = "admin-msg err";
  }
}

// Load page content when admin dashboard is shown
const origShowDashboard = showDashboard;
showDashboard = function(user) {
  origShowDashboard(user);
  loadPageContent("prestation");
  loadPageContent("about");
  loadFeaturedBanner();
  loadFooter();
};
