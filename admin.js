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
};

async function loadPageContent(page) {
  try {
    const data = await apiFetch(`/api/page-content/${page}`);
    if (!data || typeof data !== 'object') return;

    // Prestation fields
    if (page === "prestation") {
      for (const field of pageContentFields.prestation) {
        const el = document.getElementById(`prest-${field}`);
        if (el) {
          const val = data[field];
          if (val !== undefined && val !== null) {
            // Bullets are arrays, join with newlines for textarea
            if (Array.isArray(val)) {
              el.value = val.join("\n");
            } else {
              el.value = String(val);
            }
          }
        }
      }
    }

    // About fields
    if (page === "about") {
      const titleEl = document.getElementById("about-heroTitle");
      const subEl = document.getElementById("about-heroSubtitle");
      const sectionsEl = document.getElementById("about-sections");
      if (titleEl && data.heroTitle) titleEl.value = data.heroTitle;
      if (subEl && data.heroSubtitle) subEl.value = data.heroSubtitle;
      if (sectionsEl && data.sections) sectionsEl.value = JSON.stringify(data.sections, null, 2);
    }
  } catch (err) {
    console.error(`Load ${page} content error:`, err);
  }
}

async function savePageContent(page) {
  const msgEl = document.getElementById(`page-msg-${page}`);
  if (!msgEl) return;

  try {
    const content = {};

    if (page === "prestation") {
      for (const field of pageContentFields.prestation) {
        const el = document.getElementById(`prest-${field}`);
        if (el) {
          const val = el.value.trim();
          // Bullets fields: split by newlines into array
          if (field.endsWith("Bullets") && val) {
            content[field] = val.split("\n").map(s => s.trim()).filter(Boolean);
          } else if (val) {
            content[field] = val;
          }
        }
      }
    }

    if (page === "about") {
      const titleEl = document.getElementById("about-heroTitle");
      const subEl = document.getElementById("about-heroSubtitle");
      const sectionsEl = document.getElementById("about-sections");
      if (titleEl?.value.trim()) content.heroTitle = titleEl.value.trim();
      if (subEl?.value.trim()) content.heroSubtitle = subEl.value.trim();
      if (sectionsEl?.value.trim()) {
        try {
          content.sections = JSON.parse(sectionsEl.value.trim());
        } catch (_) {
          msgEl.textContent = "✕ Erreur JSON dans les sections";
          msgEl.className = "admin-msg err";
          return;
        }
      }
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
};
