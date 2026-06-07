const state = {
  locale: localStorage.getItem("gsa-locale") || "fr",
  user: null,
  cart: null,
  bootstrap: null,
  categories: [],
};

const translations = {
  fr: {
    languageLabel: "EN",
    loginCta: "Log in / Register",
    cart: "Panier",
    searchPlaceholder: "Rechercher un produit, un tag...",
    footerText:
      "GSA embellit, structure et professionnalise le travail des prestataires Garry's Mod. Fondé et géré uniquement par Tresingo.",
    addToCart: "Ajouter au panier",
    description: "Description",
    install: "Installation",
    reviews: "Avis",
    category: "Catégorie",
    seller: "Vendeur",
    cartTitle: "Votre panier",
    total: "Total",
    quantity: "Quantité",
    emptyCart: "Votre panier est vide pour le moment.",
    noResults: "Aucun résultat trouvé.",
    loginTitle: "Connexion / création de compte",
    welcome: "Bienvenue",
    checkout: "Payer avec Stripe",
    checkoutLoading: "Redirection vers Stripe...",
    stripeUnavailable: "Stripe n'est pas configuré pour le moment.",
    checkoutSuccess: "Paiement validé. Merci pour votre commande.",
    checkoutCancel: "Paiement annulé. Vous pouvez reprendre votre panier.",
  },
  en: {
    languageLabel: "FR",
    loginCta: "Log in / Register",
    cart: "Cart",
    searchPlaceholder: "Search product, tag, category...",
    footerText:
      "GSA elevates, structures and professionalizes the work of Garry's Mod creators. Founded and managed only by Tresingo.",
    addToCart: "Add to cart",
    description: "Description",
    install: "Installation",
    reviews: "Reviews",
    category: "Category",
    seller: "Seller",
    cartTitle: "Your cart",
    total: "Total",
    quantity: "Quantity",
    emptyCart: "Your cart is currently empty.",
    noResults: "No results found.",
    loginTitle: "Login / register",
    welcome: "Welcome",
    checkout: "Pay with Stripe",
    checkoutLoading: "Redirecting to Stripe...",
    stripeUnavailable: "Stripe is not configured right now.",
    checkoutSuccess: "Payment confirmed. Thank you for your order.",
    checkoutCancel: "Payment cancelled. You can continue with your cart.",
  },
};

function t(key) {
  return translations[state.locale]?.[key] || translations.fr[key] || key;
}

function currency(value) {
  return new Intl.NumberFormat(state.locale === "fr" ? "fr-FR" : "en-US", {
    style: "currency",
    currency: "EUR",
  }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, "");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let message = "Erreur inconnue";
    try {
      const payload = await response.json();
      message = payload.message || message;
      if (payload.maintenance) {
        window.location.href = "/maintenance.html";
      }
    } catch (_error) {
      message = response.statusText || message;
    }
    throw new Error(message);
  }

  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function productCard(product, detailed = false) {
  const thumb =
    product.thumbnail ||
    product.media?.[0]?.thumbnail ||
    product.media?.[0]?.url ||
    "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=900&q=80";
  const oldPrice =
    Number(product.discountPercent) > 0
      ? `<span class="old-price">${currency(product.oldPrice)}</span>`
      : "";
  const title = escapeHtml(product.title);
  const category = escapeHtml(product.category || product.categoryName || "");
  const description = escapeHtml(product.shortDescription || "");
  const seller = escapeHtml(product.sellerName || "");
  const sellerSlug = escapeHtml(product.sellerSlug || "");
  const compactTags = (product.tags || [])
    .slice(0, detailed ? 3 : 2)
    .map((tag) => `<span class="mini-tag">${escapeHtml(tag)}</span>`)
    .join("");

  return `
    <article class="product-card ${detailed ? "detailed featured" : ""}">
      <a class="product-card-media" href="product.html?slug=${encodeURIComponent(product.slug)}">
        <img src="${escapeHtml(thumb)}" alt="${title}" loading="lazy" />
      </a>
      <div class="product-card-body">
        <div class="product-card-topline">
          <span class="product-tag">${category}</span>
          ${Number(product.discountPercent) > 0 ? `<span class="chip chip-discount">-${product.discountPercent}%</span>` : ""}
        </div>
        <h3><a href="product.html?slug=${encodeURIComponent(product.slug)}">${title}</a></h3>
        <p>${description}</p>
        <div class="product-tags-row">${compactTags}</div>
        <div class="product-meta">
          <span>★ ${Number(product.rating || 0).toFixed(1)} <small>(${product.reviewCount || 0})</small></span>
          <div class="price-cluster">${oldPrice}<strong>${currency(product.price)}</strong></div>
        </div>
        ${seller ? `<div class="product-seller-line"><a href="seller.html?id=${encodeURIComponent(sellerSlug)}" style="color:inherit; text-decoration:none;">${seller}</a></div>` : ""}
      </div>
    </article>
  `;
}

function trendingCard(product, featured = false) {
  const thumb =
    product.thumbnail ||
    product.media?.[0]?.thumbnail ||
    product.media?.[0]?.url ||
    "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=900&q=80";

  const title = escapeHtml(product.title);
  const meta = escapeHtml(product.shortDescription || product.category || product.categoryName || "");
  const rating = Number(product.rating || 0).toFixed(1);
  const reviews = product.reviewCount || 0;
  const price = currency(product.price);

  return featured
    ? `
      <article class="trending-featured-card">
        <a class="trending-featured-media" href="product.html?slug=${encodeURIComponent(product.slug)}">
          <img src="${escapeHtml(thumb)}" alt="${title}" loading="lazy" />
        </a>
        <div class="trending-featured-body">
          <h3 class="trending-featured-title"><a href="product.html?slug=${encodeURIComponent(product.slug)}">${title}</a></h3>
          <div class="trending-featured-meta">${meta}</div>
          <div class="trending-featured-footer">
            <span>${rating} ★ (${reviews})</span>
            <span class="trending-price">${price}</span>
          </div>
        </div>
      </article>
    `
    : `
      <article class="trending-mini-card">
        <a class="trending-mini-media" href="product.html?slug=${encodeURIComponent(product.slug)}">
          <img src="${escapeHtml(thumb)}" alt="${title}" loading="lazy" />
        </a>
        <div class="trending-mini-body">
          <h3 class="trending-mini-title"><a href="product.html?slug=${encodeURIComponent(product.slug)}">${title}</a></h3>
          <div class="trending-mini-footer">
            <span>${rating} ★ (${reviews})</span>
            <span class="trending-price">${price}</span>
          </div>
        </div>
      </article>
    `;
}

function salesCard(product) {
  const thumb =
    product.thumbnail ||
    product.media?.[0]?.thumbnail ||
    product.media?.[0]?.url ||
    "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=900&q=80";

  const title = escapeHtml(product.title);
  const rating = Number(product.rating || 0).toFixed(1);
  const reviews = product.reviewCount || 0;
  const discount = Number(product.discountPercent || 0);

  return `
    <article class="sales-card">
      <a class="sales-card-media" href="product.html?slug=${encodeURIComponent(product.slug)}">
        <img src="${escapeHtml(thumb)}" alt="${title}" loading="lazy" />
      </a>
      <div class="sales-card-body">
        <h3 class="sales-card-title"><a href="product.html?slug=${encodeURIComponent(product.slug)}">${title}</a></h3>
        <div class="sales-card-footer">
          <span>${rating} ★ (${reviews})</span>
          <div class="sales-pricing">
            ${discount > 0 ? `<span class="sales-discount">-${discount}%</span>` : ""}
            ${product.oldPrice ? `<span class="old">${currency(product.oldPrice)}</span>` : ""}
            <span class="new">${currency(product.price)}</span>
          </div>
        </div>
      </div>
    </article>
  `;
}

function scriptLibraryCard(product, categoryName = "") {
  const thumb =
    product.thumbnail ||
    product.media?.[0]?.thumbnail ||
    product.media?.[0]?.url ||
    "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=900&q=80";

  const title = escapeHtml(product.title);
  const meta = escapeHtml(product.shortDescription || categoryName || product.category || "");
  const rating = Number(product.rating || 0).toFixed(1);
  const reviews = product.reviewCount || 0;

  return `
    <article class="script-card-v2">
      <a class="script-card-media" href="product.html?slug=${encodeURIComponent(product.slug)}">
        <img src="${escapeHtml(thumb)}" alt="${title}" loading="lazy" />
      </a>
      <div class="script-card-body">
        <h3 class="script-card-title"><a href="product.html?slug=${encodeURIComponent(product.slug)}">${title}</a></h3>
        <div class="script-card-meta">${meta}</div>
        <div class="script-card-footer">
          <span>${rating} ★ (${reviews})</span>
          <span class="script-card-price">${currency(product.price)}</span>
        </div>
      </div>
    </article>
  `;
}

function updateHeaderLabels() {
  const searchInput = document.getElementById("global-search-input");
  if (searchInput) searchInput.placeholder = t("searchPlaceholder");

  const langButton = document.getElementById("language-toggle");
  if (langButton) langButton.textContent = t("languageLabel");

  let userMenuWrap = document.getElementById("user-menu-wrap");

  if (state.user) {
    // Si on a un bouton "Log in" orphelin (ex: ghost-button au lieu de primary-button), on le supprime pour éviter les doublons
    const allLoginLinks = document.querySelectorAll('a[href="login.html"]');
    
    if (!userMenuWrap) {
      // On cherche d'abord le lien login (celui qui a la classe .primary-button OU .ghost-button)
      const targetLoginLink = 
        document.querySelector('.primary-button[href="login.html"]') ||
        document.querySelector('.ghost-button[href="login.html"]') ||
        document.querySelector('.primary-button[href="profile.html"]');
        
      if (targetLoginLink) {
        userMenuWrap = document.createElement("div");
        userMenuWrap.id = "user-menu-wrap";
        userMenuWrap.innerHTML = `
          <button class="primary-button" id="user-menu-trigger" type="button">${escapeHtml(t("welcome"))}, ${escapeHtml(state.user.displayName)}</button>
          <div id="user-menu-dropdown" class="user-menu-dropdown hidden">
            ${state.user.role === 'admin' ? '<a href="admin.html">Dashboard Admin</a>' : ''}
            <a href="profile.html">Mon profil</a>
            <button type="button" id="user-logout-btn">Se déconnecter</button>
          </div>
        `;
        targetLoginLink.replaceWith(userMenuWrap);

        // Nettoyer les autres liens de login potentiels qui traînent
        document.querySelectorAll('a[href="login.html"]').forEach(link => link.remove());

        document.getElementById("user-menu-trigger").addEventListener("click", (e) => {
          e.stopPropagation();
          document.getElementById("user-menu-dropdown").classList.toggle("hidden");
        });

        document.addEventListener("click", () => {
          document.getElementById("user-menu-dropdown")?.classList.add("hidden");
        });

        document.getElementById("user-logout-btn").addEventListener("click", async () => {
          try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
          state.user = null;
          state.cart = null;
          window.location.href = "index.html";
        });
      }
    } else {
      const trigger = document.getElementById("user-menu-trigger");
      if (trigger) trigger.textContent = `${t("welcome")}, ${state.user.displayName}`;
      // Nettoyer les autres liens de login potentiels qui traînent
      document.querySelectorAll('a[href="login.html"]').forEach(link => {
        if(!link.closest('#user-menu-wrap')) link.remove()
      });
    }
  } else {
    if (userMenuWrap) {
      const loginLink = document.createElement("a");
      loginLink.className = "primary-button";
      loginLink.href = "login.html";
      loginLink.textContent = t("loginCta");
      userMenuWrap.replaceWith(loginLink);
    } else {
      const link =
        document.querySelector('.primary-button[href="login.html"]') ||
        document.querySelector('.primary-button[href="profile.html"]');
      if (link) {
        link.textContent = t("loginCta");
        link.setAttribute("href", "login.html");
      }
    }
  }

  const cartLink = document.querySelector('.ghost-button[href="cart.html"]');
  if (cartLink) {
    const count = state.cart?.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
    cartLink.innerHTML = `${t("cart")} <span id="cart-count-badge">${count}</span>`;
  }


  const footerCopy = document.querySelector(".footer-copy");
  if (footerCopy) footerCopy.textContent = t("footerText");
}

function attachLanguageToggle() {
  const button = document.getElementById("language-toggle");
  if (!button) return;

  button.addEventListener("click", async () => {
    state.locale = state.locale === "fr" ? "en" : "fr";
    localStorage.setItem("gsa-locale", state.locale);

    try {
      await api("/api/locale", {
        method: "POST",
        body: JSON.stringify({ locale: state.locale }),
      });
    } catch (_error) {}

    location.reload();
  });
}

function attachSearchHandler() {
  const input = document.getElementById("global-search-input");
  if (!input) return;

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && input.value.trim()) {
      window.location.href = `catalogue.html?search=${encodeURIComponent(input.value.trim())}`;
    }
  });
}

async function hydrateSession() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    state.cart = me.cart;
  } catch (_error) {
    state.user = null;
    state.cart = null;
  }
}

async function loadBootstrap() {
  state.bootstrap = await api("/api/bootstrap");
  state.categories = state.bootstrap.categories || [];
}

function renderHomePage() {
  if (!state.bootstrap) return;

  const featured = document.getElementById("trending-featured");
  const carousel = document.getElementById("trending-carousel");
  const discounts = document.getElementById("discount-carousel");
  const collaborators = document.getElementById("collaborators-list");
  const communities = document.getElementById("communities-list");
  const categoryShowcase = document.getElementById("category-showcase");
  const heroCount = document.getElementById("hero-products-count");

  if (heroCount) heroCount.textContent = String(state.bootstrap.trending?.length || 0);

  const [first, second, ...rest] = state.bootstrap.trending || [];
  if (featured) featured.innerHTML = [first, second].filter(Boolean).map((p) => trendingCard(p, true)).join("");
  if (carousel) carousel.innerHTML = rest.map((p) => trendingCard(p)).join("");
  if (discounts) discounts.innerHTML = (state.bootstrap.discounts || []).slice(0, 3).map((p) => salesCard(p)).join("");

  const landingConfig = state.bootstrap.landingConfig || [];

  const getBannerTitle = (config) => {
    const title = String(config?.title || "").trim();
    return title || "SOCIAL PROOF";
  };
  
  const banners = document.querySelectorAll(".showcase-banner-section");
  if (banners.length >= 2) {
    const config1 = landingConfig.find(c => c.section_key === "social_proof_1") || { is_active: true, title: "SOCIAL PROOF" };
    const config2 = landingConfig.find(c => c.section_key === "social_proof_2") || { is_active: true, title: "SOCIAL PROOF" };

    if (!config1.is_active) {
      banners[0].style.display = "none";
    } else {
      banners[0].style.display = "";
      const textSpan = banners[0].querySelector("span");
      if (textSpan) textSpan.textContent = getBannerTitle(config1);
    }

    if (!config2.is_active) {
      banners[1].style.display = "none";
    } else {
      banners[1].style.display = "";
      const textSpan = banners[1].querySelector("span");
      if (textSpan) textSpan.textContent = getBannerTitle(config2);
    }
  }

  if (categoryShowcase) {
    const scriptPool = [
      ...(state.bootstrap.trending || []),
      ...(state.bootstrap.discounts || []),
      ...((state.bootstrap.featuredByCategory || []).flatMap((group) =>
        (group.products || []).map((product) => ({ ...product, category: group.categoryName }))
      ) || []),
    ].filter(Boolean);

    const uniqueScripts = Array.from(new Map(scriptPool.map((product) => [product.slug, product])).values());
    const rows = [];

    for (let index = 0; index < Math.min(uniqueScripts.length, 15); index += 5) {
      rows.push(uniqueScripts.slice(index, index + 5));
    }

    categoryShowcase.innerHTML = rows
      .filter((row) => row.length)
      .map(
        (row) => `
        <section class="scripts-row">
          ${row.map((product) => scriptLibraryCard(product, product.category || "Scripts")).join("")}
        </section>
      `
      )
      .join("");
  }

  document.querySelectorAll("[data-carousel-prev]").forEach((button) => {
    button.addEventListener("click", () => {
      document
        .getElementById(button.dataset.carouselPrev)
        ?.scrollBy({ left: -320, behavior: "smooth" });
    });
  });

  document.querySelectorAll("[data-carousel-next]").forEach((button) => {
    button.addEventListener("click", () => {
      document
        .getElementById(button.dataset.carouselNext)
        ?.scrollBy({ left: 320, behavior: "smooth" });
    });
  });
}

function renderCatalogueFilters(categories, activeCategory, search, tag, discount, sort) {
  const categoryLinks = [
    `<a class="market-filter-link ${!activeCategory ? "active" : ""}" href="catalogue.html">Overview <span>(All)</span></a>`,
    ...categories.map(
      (item) =>
        `<a class="market-filter-link ${item.slug === activeCategory ? "active" : ""}" href="catalogue.html?search=${encodeURIComponent(
          search
        )}&category=${encodeURIComponent(item.slug)}&tag=${encodeURIComponent(tag)}&discount=${encodeURIComponent(
          discount
        )}&sort=${encodeURIComponent(sort)}">${escapeHtml(item.name)} <span>(${item.productCount || 0})</span></a>`
    ),
  ].join("");

  return `
    <div class="market-sidebar-group">
      <div class="market-sidebar-title">Categories</div>
      <div class="market-filter-stack">${categoryLinks}</div>
    </div>

    <div class="market-sidebar-group">
      <div class="market-sidebar-title">Tags</div>
      <div class="market-select-wrap">
        <select onchange="if(this.value) window.location.href=this.value">
          <option value="">Sélectionner</option>
          <option value="catalogue.html?tag=darkrp">DarkRP</option>
          <option value="catalogue.html?tag=ui">UI</option>
          <option value="catalogue.html?tag=job">Job</option>
          <option value="catalogue.html?tag=economy">Economy</option>
        </select>
      </div>
    </div>

    <div class="market-sidebar-group">
      <div class="market-sidebar-title">Price</div>
      <div class="market-range-lines">
        <div class="market-range-bar"></div>
        <div class="market-range-values"><span>$1</span><span>$0</span></div>
      </div>
    </div>

    <div class="market-sidebar-group">
      <div class="market-sidebar-title">Rating</div>
      <label class="market-check"><input type="checkbox" /> ★★★★★ <span>(194)</span></label>
      <label class="market-check"><input type="checkbox" /> ★★★★☆ <span>(85)</span></label>
      <label class="market-check"><input type="checkbox" /> ★★★☆☆ <span>(22)</span></label>
    </div>

    <div class="market-sidebar-group">
      <div class="market-sidebar-title">Sale</div>
      <label class="market-check"><input type="checkbox" ${discount === "true" ? "checked" : ""} onclick="window.location.href='catalogue.html?search=${encodeURIComponent(
        search
      )}&category=${encodeURIComponent(activeCategory)}&tag=${encodeURIComponent(tag)}&discount=true&sort=${encodeURIComponent(
        sort
      )}'" /> On sale</label>
      <label class="market-check"><input type="checkbox" /> Only show sales</label>
    </div>
  `;
}

async function renderCataloguePage() {
  const app = document.getElementById("catalogue-page");
  if (!app) return;

  const params = getQueryParams();
  const search = params.get("search") || "";
  const category = params.get("category") || "";
  const tag = params.get("tag") || "";
  const discount = params.get("discount") || "";
  const sort = params.get("sort") || "popular";

  let titleText = "Catalogue";
  if (search) titleText = `Recherche: ${search} — Catalogue`;
  else if (category) titleText = `Catégorie: ${category} — Catalogue`;
  else if (tag) titleText = `Tag: ${tag} — Catalogue`;
  
  document.title = `${titleText} — GSA Marketplace`;
  let metaDesc = document.querySelector('meta[name="description"]');
  if (!metaDesc) {
    metaDesc = document.createElement('meta');
    metaDesc.name = "description";
    document.head.appendChild(metaDesc);
  }
  metaDesc.content = `Découvrez tous les scripts et ressources pour Garry's Mod. ${search ? `Résultats pour "${search}".` : ''}`;

  const data = await api(
    `/api/products?search=${encodeURIComponent(search)}&category=${encodeURIComponent(
      category
    )}&tag=${encodeURIComponent(tag)}&discount=${encodeURIComponent(discount)}&sort=${encodeURIComponent(sort)}`
  );

  app.innerHTML = `
    <section class="market-hero-strip">
      <div class="container market-hero-shell">
        <div class="market-breadcrumb">Home <span>›</span> Scripts</div>
        <div class="market-hero-content">
          <div>
            <h1>Stand out your server among all.</h1>
          </div>
          <div class="market-hero-art"></div>
        </div>
      </div>
    </section>

    <section class="market-page-section">
      <div class="container market-layout">
        <aside class="market-sidebar">
          ${renderCatalogueFilters(state.categories, category, search, tag, discount, sort)}
        </aside>

        <div class="market-main">
          <div class="market-toolbar">
            <div class="market-toolbar-left">
              <span class="market-chip active">Hide Filters</span>
            </div>
            <div class="market-toolbar-right">
              <span class="market-sort ${sort === "popular" ? "active" : ""}">All Time</span>
              <span class="market-sort ${sort === "new" ? "active" : ""}">Date Published</span>
              <span class="market-sort">Updated</span>
              <span class="market-sort ${sort === "discount" ? "active" : ""}">Trending</span>
            </div>
          </div>

          <div class="market-products-grid ${data.items.length ? "" : "is-empty"}">
            ${
              data.items.length
                ? data.items.map((product) => productCard(product)).join("")
                : `<div class="empty-state"><h3>${t("noResults")}</h3></div>`
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderMainMedia(media) {
  if (!media) return `<div class="media-fallback">Aucun média</div>`;

  return media.type === "video"
    ? `<video controls poster="${escapeHtml(media.thumbnail || "")}" src="${escapeHtml(media.url)}"></video>`
    : `<img src="${escapeHtml(media.url)}" alt="Aperçu produit" />`;
}

function ensureAuthModal() {
  let modal = document.getElementById("auth-required-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "auth-required-modal";
  modal.className = "auth-modal hidden";
  modal.innerHTML = `
    <div class="auth-modal-backdrop" data-auth-close="true"></div>
    <div class="auth-modal-panel" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
      <button class="auth-modal-close" type="button" data-auth-close="true" aria-label="Fermer">×</button>
      <span class="eyebrow">Connexion requise</span>
      <h2 id="auth-modal-title">Connectez-vous pour continuer</h2>
      <p>Vous devez être connecté pour ajouter ce produit au panier ou poursuivre vos achats.</p>
      <div class="auth-modal-actions">
        <a class="primary-button full" id="auth-modal-steam" href="/auth/steam">Se connecter avec Steam</a>
        <a class="ghost-button full center" id="auth-modal-login" href="login.html">Se connecter avec email / mot de passe</a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-auth-close]").forEach((element) => {
    element.addEventListener("click", () => {
      modal.classList.add("hidden");
      document.body.classList.remove("modal-open");
    });
  });

  return modal;
}

function openAuthModal() {
  const modal = ensureAuthModal();
  const redirectUrl = window.location.href;
  const loginLink = modal.querySelector("#auth-modal-login");
  const steamLink = modal.querySelector("#auth-modal-steam");

  if (loginLink) {
    loginLink.href = `login.html?redirect=${encodeURIComponent(redirectUrl)}`;
  }

  if (steamLink) {
    steamLink.href = "/auth/steam";
  }

  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

async function renderProductPage() {
  const app = document.getElementById("product-page");
  if (!app) return;

  const slug = getQueryParams().get("slug");
  if (!slug) {
    app.innerHTML = `<div class="container empty-state"><h2>Produit introuvable</h2></div>`;
    return;
  }

  const product = await api(`/api/products/${encodeURIComponent(slug)}`);
  const media = product.media || [];

  document.title = `${escapeHtml(product.title)} — GSA Marketplace`;
  let metaDesc = document.querySelector('meta[name="description"]');
  if (!metaDesc) {
    metaDesc = document.createElement('meta');
    metaDesc.name = "description";
    document.head.appendChild(metaDesc);
  }
  metaDesc.content = escapeHtml(product.shortDescription || product.title);

  app.innerHTML = `
    <section class="market-product-page">
      <div class="container market-product-shell">
        <div class="market-product-breadcrumb">GSA <span>›</span> Scripts <span>›</span> ${escapeHtml(product.title)}</div>
        <div class="market-product-titlebar">
          <div>
            <h1>${escapeHtml(product.title)}</h1>
          </div>
          <div class="market-product-stats">
            <span>👁 ${product.views || 268}</span>
            <span>★ ${Number(product.rating || 0).toFixed(1)} (${product.reviewCount || 0})</span>
          </div>
        </div>

        <div class="market-product-layout">
          <section class="market-product-main">
            <div class="market-product-media" id="main-media-slot">${renderMainMedia(media[0])}</div>
            <div class="market-product-thumbs media-thumbs">
            ${media
              .map(
                (item, index) => `
                <button class="media-thumb ${index === 0 ? "active" : ""}" type="button" data-media-index="${index}">
                  <img src="${escapeHtml(item.thumbnail || item.url)}" alt="Media ${index + 1}" />
                </button>
              `
              )
              .join("")}
            </div>
            <div class="market-product-tabs tabbed-panel">
              <div class="tab-buttons market-product-tab-buttons">
              <button class="tab-button active" type="button" data-tab="description">${t("description")}</button>
              <button class="tab-button" type="button" data-tab="installation">${t("install")}</button>
              <button class="tab-button" type="button" data-tab="reviews">${t("reviews")} (${product.reviewCount || 0})</button>
              </div>
              <div class="tab-content active" data-tab-panel="description"><p>${escapeHtml(product.description).replace(/\n/g, "<br />")}</p></div>
              <div class="tab-content" data-tab-panel="installation"><p>${escapeHtml(product.installation).replace(/\n/g, "<br />")}</p></div>
              <div class="tab-content" data-tab-panel="reviews">
              ${
                (product.reviews || [])
                  .map(
                    (review) =>
                      `<article class="review-card"><div class="review-card-head"><strong>${escapeHtml(review.displayName)}</strong><span>★ ${review.rating}/5</span></div><p>${escapeHtml(review.comment)}</p></article>`
                  )
                  .join("") || "<p>Aucun avis pour le moment.</p>"
              }
              </div>
            </div>
          </section>

          <aside class="market-product-sidebar">
            <div class="market-side-card">
              <div class="market-side-price-row">
                ${product.discountPercent > 0 ? `<span class="old-price">${currency(product.oldPrice)}</span>` : ""}
                <strong>${currency(product.price)}</strong>
              </div>
              <button class="primary-button full market-buy-button" type="button" id="add-to-cart-button" data-product-id="${product.id}">${t("addToCart")}</button>
            </div>

            <div class="market-side-card market-side-meta">
              <div class="market-side-block">
                <span class="market-side-label">Author Info</span>
                <div class="market-author-row">
                  <a href="seller.html?id=${encodeURIComponent(product.sellerSlug || "")}" style="display:block;">
                    <img src="${escapeHtml(product.sellerAvatar || "https://via.placeholder.com/64")}" alt="${escapeHtml(product.sellerName)}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" />
                  </a>
                  <div>
                    <strong><a href="seller.html?id=${encodeURIComponent(product.sellerSlug || "")}" style="color:inherit; text-decoration:none;">${escapeHtml(product.sellerName)}</a></strong>
                    <small>Verified Creator</small>
                  </div>
                </div>
              </div>

              <div class="market-side-block">
                <span class="market-side-label">Version Information</span>
                <ul class="market-side-list">
                  <li><span>Current Version</span><strong>v${escapeHtml(product.version || "4.4")}</strong></li>
                  <li><span>Last Updated</span><strong>${new Date(product.updatedAt).toLocaleDateString()}</strong></li>
                </ul>
              </div>

              <div class="market-side-block">
                <span class="market-side-label">Changelog</span>
                <ul class="market-side-list">
                  <li><span>Version</span><strong>${escapeHtml(product.version || "4.4")}</strong></li>
                  <li><span>Released</span><strong>${new Date(product.createdAt).toLocaleDateString()}</strong></li>
                </ul>
              </div>

              <div class="market-side-block">
                <span class="market-side-label">Requirements</span>
                <div class="market-side-note">${escapeHtml(product.installation || "Default framework requirements.")}</div>
              </div>

              <div class="market-side-block">
                <span class="market-side-label">Tags</span>
                <div class="tag-list market-side-tags">
                  ${(product.tags || []).map((tag) => `<a class="filter-chip" href="catalogue.html?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join("")}
                </div>
              </div>

              <div class="market-side-block">
                <span class="market-side-label">Category</span>
                <div class="tag-list market-side-tags">
                  <a class="filter-chip active" href="catalogue.html?category=${encodeURIComponent(product.categorySlug)}">${escapeHtml(product.category)}</a>
                </div>
              </div>

              <div class="market-side-block">
                <span class="market-side-label">Need updates & Discord?</span>
                <div class="market-side-note">Join our Discord to receive updates and support for this resource.</div>
                <a class="ghost-button full center" href="https://discord.gg/ZbCrwE73uK" target="_blank" rel="noreferrer">Join our Discord</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  document.querySelectorAll("[data-media-index]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("main-media-slot").innerHTML = renderMainMedia(
        media[Number(button.dataset.mediaIndex)]
      );
      document.querySelectorAll("[data-media-index]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll("[data-tab-panel]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      document.querySelector(`[data-tab-panel="${button.dataset.tab}"]`)?.classList.add("active");
    });
  });

  document.getElementById("add-to-cart-button")?.addEventListener("click", async (event) => {
    if (!state.user) {
      openAuthModal();
      return;
    }

    try {
      state.cart = await api("/api/cart/items", {
        method: "POST",
        body: JSON.stringify({
          productId: Number(event.currentTarget.dataset.productId),
          quantity: 1,
        }),
      });
      updateHeaderLabels();
      event.currentTarget.textContent = "Ajouté au panier";
    } catch (error) {
      if (error.message === "Authentication required") {
        openAuthModal();
        return;
      }
      alert(error.message);
    }
  });
}

async function renderLoginPage() {
  const app = document.getElementById("login-page");
  if (!app) return;

  app.innerHTML = `
    <section class="page-hero small">
      <div class="container">
        <span class="eyebrow">${t("loginTitle")}</span>
        <h1>Accédez à votre espace GSA</h1>
        <p>Connexion locale, inscription persistée en base et option Discord.</p>
      </div>
    </section>
    <section class="page-section">
      <div class="container auth-grid">
        <form class="panel form-panel" id="login-form">
          <h2>Connexion</h2>
          <label>Email<input name="email" type="email" required placeholder="client@gsa.local" /></label>
          <label>Mot de passe<input name="password" type="password" required placeholder="••••••••" /></label>
          <button class="primary-button full" type="submit">Se connecter</button>
          <div class="social-auth-buttons">
            <a class="ghost-button center" href="/auth/discord">Connexion Discord</a>
            <a class="ghost-button center" href="/auth/steam">Connexion Steam</a>
          </div>
          <p class="helper-text">Compte démo client : client@gsa.local / Client123!</p>
          <p class="helper-text">Compte admin : admin@gstore.local / Admin1234!</p>
        </form>
        <form class="panel form-panel" id="register-form">
          <h2>Créer un compte</h2>
          <label>Nom affiché<input name="displayName" type="text" required placeholder="Votre pseudo" /></label>
          <label>Email<input name="email" type="email" required placeholder="vous@email.com" /></label>
          <label>Mot de passe<input name="password" type="password" required placeholder="Minimum recommandé 8 caractères" /></label>
          <button class="primary-button full" type="submit">Créer mon compte</button>
        </form>
      </div>
    </section>
  `;

  document.getElementById("login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const response = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });

      state.user = response.user;
      window.location.href = getQueryParams().get("redirect") || "index.html";
    } catch (error) {
      alert(error.message);
    }
  });

  document.getElementById("register-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const response = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          displayName: formData.get("displayName"),
          email: formData.get("email"),
          password: formData.get("password"),
          preferredLanguage: state.locale,
        }),
      });

      state.user = response.user;
      window.location.href = "index.html";
    } catch (error) {
      alert(error.message);
    }
  });
}

async function getStripeConfig() {
  try {
    return await api("/api/stripe/config");
  } catch (_error) {
    return { enabled: false, publishableKey: null };
  }
}

async function renderCartPage() {
  const app = document.getElementById("cart-page");
  if (!app) return;

  if (!state.user) {
    app.innerHTML = `<section class="page-section"><div class="container"><div class="empty-state"><h2>Connexion requise</h2><p>Connectez-vous pour accéder à votre panier.</p><a class="primary-button" href="login.html?redirect=cart.html">Se connecter</a></div></div></section>`;
    return;
  }

  const checkoutState = getQueryParams().get("checkout");
  const checkoutSessionId = getQueryParams().get("session_id");
  let checkoutConfirmationError = "";

  if (checkoutState === "success" && checkoutSessionId) {
    try {
      await api("/api/checkout/confirm-session", {
        method: "POST",
        body: JSON.stringify({ sessionId: checkoutSessionId }),
      });
    } catch (error) {
      checkoutConfirmationError = error.message;
    }
  }

  const cart = await api("/api/cart");
  const stripeConfig = await getStripeConfig();
  const savedPromoCode = sessionStorage.getItem("gsaPromoCode") || "";
  let appliedPromo = null;

  if (savedPromoCode && cart.items.length) {
    try {
      appliedPromo = await api("/api/promo/validate", {
        method: "POST",
        body: JSON.stringify({ code: savedPromoCode }),
      });
    } catch (_error) {
      sessionStorage.removeItem("gsaPromoCode");
    }
  }

  state.cart = cart;
  updateHeaderLabels();

  app.innerHTML = `
    <section class="page-hero small">
      <div class="container">
        <span class="eyebrow">${t("cartTitle")}</span>
        <h1>Panier</h1>
        <p>Retrouvez vos assets sélectionnés, ajustez les quantités et finalisez votre commande en quelques secondes.</p>
      </div>
    </section>
    <section class="page-section cart-page-section">
      <div class="container cart-layout-modern">
        ${
          checkoutConfirmationError
            ? `<div class="panel checkout-banner cancel-banner">Paiement validé côté Stripe, mais l'enregistrement de la commande a échoué : ${escapeHtml(checkoutConfirmationError)}</div>`
            : checkoutState === "success"
              ? `<div class="panel checkout-banner success-banner">${t("checkoutSuccess")}</div>`
            : checkoutState === "cancel"
              ? `<div class="panel checkout-banner cancel-banner">${t("checkoutCancel")}</div>`
              : ""
        }
        ${
          cart.items.length
            ? `
              <div class="cart-items-column">
                <div class="panel cart-list-shell">
                  <div class="cart-list-head">
                    <div>
                      <span class="eyebrow">Votre sélection</span>
                      <h2>${cart.items.length} article${cart.items.length > 1 ? "s" : ""}</h2>
                    </div>
                    <a class="ghost-button" href="catalogue.html">Continuer mes achats</a>
                  </div>
                  <div class="cart-list">
                    ${cart.items
                      .map(
                        (item) => `
                          <article class="cart-item card-cart-row">
                            <a class="cart-item-media" href="product.html?slug=${encodeURIComponent(item.product.slug)}">
                              <img src="${escapeHtml(item.product.preview.thumbnail || item.product.preview.url || "https://via.placeholder.com/180")}" alt="${escapeHtml(item.product.title)}" />
                            </a>
                            <div class="cart-item-body">
                              <div class="cart-item-main">
                                <div>
                                  <span class="product-tag">${escapeHtml(item.product.category || "Produit")}</span>
                                  <h3><a href="product.html?slug=${encodeURIComponent(item.product.slug)}">${escapeHtml(item.product.title)}</a></h3>
                                  <p>${escapeHtml(item.product.shortDescription || "Asset prêt à l'emploi pour votre serveur Garry's Mod.")}</p>
                                </div>
                                <div class="cart-item-pricing">
                                  <span>Prix unitaire</span>
                                  <strong>${currency(item.product.price)}</strong>
                                </div>
                              </div>
                              <div class="cart-item-footer">
                                <label class="cart-qty-control">
                                  <span>${t("quantity")}</span>
                                  <input type="number" min="1" value="${item.quantity}" data-cart-qty="${item.id}" />
                                </label>
                                <div class="cart-item-actions">
                                  <button class="ghost-button" type="button" data-cart-remove="${item.id}">Supprimer</button>
                                  <div class="cart-line-total">
                                    <span>Sous-total</span>
                                    <strong>${currency(item.subtotal)}</strong>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </article>
                        `
                      )
                      .join("")}
                  </div>
                </div>
              </div>
              <aside class="panel order-summary order-summary-modern">
                <span class="eyebrow">Checkout</span>
                <h2>Résumé</h2>
                <div class="order-summary-lines">
                  <div class="summary-line"><span>Articles</span><strong>${cart.items.length}</strong></div>
                  <div class="summary-line"><span>Sous-total</span><strong>${currency(cart.total)}</strong></div>
                  ${appliedPromo ? `<div class="summary-line"><span>Code ${escapeHtml(appliedPromo.code)}</span><strong>- ${currency(appliedPromo.discountAmount)}</strong></div>` : ""}
                  <div class="summary-line"><span>${t("total")}</span><strong>${currency(appliedPromo ? appliedPromo.finalTotal : cart.total)}</strong></div>
                </div>
                <form class="promo-form" id="promo-form" style="display:flex; gap:8px; margin:16px 0;">
                  <input id="promo-code-input" type="text" placeholder="Code ambassadeur" value="${escapeHtml(appliedPromo?.code || savedPromoCode)}" style="flex:1;" />
                  <button class="ghost-button" type="submit">Appliquer</button>
                </form>
                <p class="helper-text" id="promo-message">${appliedPromo ? `Code ${escapeHtml(appliedPromo.code)} appliqué.` : ""}</p>
                ${appliedPromo ? `<button class="ghost-button full" type="button" id="promo-remove-button" style="margin-bottom:12px;">Retirer le code</button>` : ""}
                <button class="primary-button full" type="button" id="stripe-checkout-button" ${!cart.items.length || !stripeConfig.enabled ? "disabled" : ""}>${t("checkout")}</button>
                ${
                  stripeConfig.enabled
                    ? `<p class="helper-text">Checkout Stripe prêt en mode hébergé.</p>`
                    : `<p class="helper-text">${t("stripeUnavailable")}</p>`
                }
                <div class="order-summary-note">
                  <span class="chip chip-accent">Paiement sécurisé</span>
                  <p>Vos achats sont liés à votre compte pour simplifier le suivi, la livraison et le support.</p>
                </div>
              </aside>
            `
            : `<div class="empty-state cart-empty-state"><h3>${t("emptyCart")}</h3><p>Explorez le catalogue pour découvrir les dernières sorties GSA.</p><a class="primary-button" href="catalogue.html">Voir le catalogue</a></div>`
        }
      </div>
    </section>
  `;

  document.querySelectorAll("[data-cart-qty]").forEach((input) => {
    input.addEventListener("change", async () => {
      try {
        await api(`/api/cart/items/${input.dataset.cartQty}`, {
          method: "PATCH",
          body: JSON.stringify({ quantity: Number(input.value) }),
        });
        location.reload();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-cart-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/cart/items/${button.dataset.cartRemove}`, { method: "DELETE" });
        location.reload();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  document.getElementById("promo-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("promo-code-input");
    const message = document.getElementById("promo-message");
    const code = input?.value?.trim() || "";
    if (!code) return;

    try {
      const promo = await api("/api/promo/validate", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      sessionStorage.setItem("gsaPromoCode", promo.code);
      location.reload();
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  });

  document.getElementById("promo-remove-button")?.addEventListener("click", () => {
    sessionStorage.removeItem("gsaPromoCode");
    location.reload();
  });

  document.getElementById("stripe-checkout-button")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = t("checkoutLoading");

    try {
      const response = await api("/api/checkout/create-session", {
        method: "POST",
        body: JSON.stringify({ promoCode: sessionStorage.getItem("gsaPromoCode") || "" }),
      });

      if (response.url) {
        window.location.href = response.url;
        return;
      }

      throw new Error("Stripe session URL missing");
    } catch (error) {
      alert(error.message);
      event.currentTarget.disabled = false;
      event.currentTarget.textContent = t("checkout");
    }
  });
}

function renderPrestationPage() {
  const app = document.getElementById("prestation-page");
  if (!app) return;

  app.innerHTML = `
    <section class="page-hero small"><div class="container"><span class="eyebrow">Prestation</span><h1>Accompagnement de projet et Game Design</h1><p>Une offre pensée pour les petits et moyens serveurs, les projets en préparation de sortie et les refontes complètes.</p></div></section>
    <section class="page-section"><div class="container editorial-grid">
      <article class="editorial-card"><h2>Accompagnement de projet</h2><p>GSA aide à éviter les erreurs classiques, optimiser le temps de production et augmenter drastiquement la qualité finale du serveur.</p><ul><li>Analyse du plateau de jeu</li><li>Analyse du système économique</li><li>Analyse de la durabilité du concept</li><li>Analyse de la cohérence globale</li></ul></article>
      <article class="editorial-card"><h2>Game Design</h2><p>Un serveur qui fonctionne n'est pas juste une somme de scripts : c'est une expérience pensée, lisible et équilibrée.</p><ul><li>Rétention des joueurs</li><li>Équilibrage PVP / grind</li><li>Lisibilité du gameplay</li><li>Réflexion map, systèmes, mécaniques</li></ul></article>
      <article class="editorial-card"><h2>Mise en relation</h2><p>Quand le concept est clair, GSA relie votre projet aux prestataires fiables et adaptés à votre ambition.</p><a class="primary-button" href="https://discord.gg/ZbCrwE73uK" target="_blank" rel="noreferrer">Ouvrir un ticket Discord</a></article>
    </div></section>
  `;
}

function renderAboutPage() {
  const app = document.getElementById("about-page");
  if (!app) return;

  app.innerHTML = `
    <section class="page-hero small"><div class="container"><span class="eyebrow">À propos</span><h1>GSA — Pas une boutique, un standard</h1><p>Distribution sérieuse, structuration commerciale et professionnalisation des assets Garry's Mod.</p></div></section>
    <section class="page-section"><div class="container prose-panel panel">
      <p>Des créateurs talentueux perdent du temps en communication, de l'énergie en support, des opportunités à cause d'une mauvaise mise en avant et de l'argent faute de distribution sérieuse.</p>
      <p>Chez GSA, les prestataires se concentrent uniquement sur leur domaine et nous confient la distribution complète de leurs créations.</p>
      <h2>Ce que GSA prend en charge</h2>
      <ul><li>La mise en valeur : graphisme, visuels, montages internes à GSA</li><li>Les explications claires, démonstrations et présentations</li><li>La relation client</li><li>La vente et le suivi</li><li>La diffusion à un large public francophone et international</li></ul>
      <h2>Pourquoi la non exclusivité n'est pas un frein</h2>
      <p>Sur GMod, l'exclusivité signifie souvent des mois d'attente, des coûts énormes et un risque de vol très élevé.</p>
      <ul><li>La non exclusivité permet des retours d'autres utilisateurs</li><li>Une qualité maximale</li><li>Un prix archi compétitif</li><li>Un déploiement rapide</li></ul>
    </div></section>
  `;
}

async function renderProfilePage() {
  const app = document.getElementById("profile-page");
  if (!app) return;

  if (!state.user) {
    app.innerHTML = `<section class="page-section"><div class="container"><div class="empty-state"><h2>Connexion requise</h2><p>Connectez-vous pour accéder à votre profil.</p><a class="primary-button" href="login.html?redirect=profile.html">Se connecter</a></div></div></section>`;
    return;
  }

  const cartCount = state.cart?.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
  const initials = escapeHtml((state.user.displayName || state.user.email || "G").slice(0, 2).toUpperCase());

  app.innerHTML = `
    <section class="page-hero small">
      <div class="container">
        <span class="eyebrow">Profil</span>
        <h1>Mon espace</h1>
        <p>Retrouvez vos informations de compte, votre activité récente et vos raccourcis utiles.</p>
      </div>
    </section>
    <section class="page-section">
      <div class="container profile-layout">
        <aside class="profile-sidebar">
          <div class="panel" style="display:grid;gap:18px;padding:24px;">
            <div class="profile-identity">
              ${state.user.avatarUrl
                ? `<img src="${escapeHtml(state.user.avatarUrl)}" class="profile-avatar" style="object-fit:cover;border-radius:50%;" alt="" />`
                : `<div class="profile-avatar">${initials}</div>`}
              <div>
                <span class="eyebrow">Compte GSA</span>
                <h2 style="margin:4px 0 2px;">${escapeHtml(state.user.displayName || "Utilisateur GSA")}</h2>
                <p style="margin:0;color:var(--muted);font-size:0.85rem;word-break:break-all;">${escapeHtml(state.user.email || "Adresse email non renseignée")}</p>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <span class="chip chip-accent">${escapeHtml(state.user.role || "client")}</span>
              ${state.user.discordId ? `<span class="chip" style="background:rgba(255,255,255,0.06);color:var(--muted);">Discord lié</span>` : ""}
              ${state.user.steamId ? `<span class="chip" style="background:rgba(255,255,255,0.06);color:var(--muted);">Steam lié</span>` : ""}
            </div>
            <div style="display:grid;gap:8px;">
              <a class="ghost-button full" href="cart.html">Voir mon panier</a>
              <a class="ghost-button full" href="catalogue.html">Explorer le catalogue</a>
              <a class="ghost-button full" href="https://discord.gg/ZbCrwE73uK" target="_blank" rel="noreferrer">Support Discord</a>
              ${['seller', 'admin'].includes(state.user.role) ? `<a class="ghost-button full" href="seller.html?id=${encodeURIComponent(state.user.slug || '')}" style="margin-top:4px; border-color:var(--accent); color:var(--accent);">Ma vitrine Vendeur</a>` : ''}
              ${state.user.role === 'admin' ? `<a class="primary-button full" href="/admin" style="margin-top:4px;">⚙️ Dashboard Admin</a>` : ''}
            </div>
          </div>
        <div class="panel" style="display:grid;gap:14px;padding:24px;">
          <span class="eyebrow">Modifier le profil</span>
          <label style="display:grid;gap:6px;font-size:0.88rem;color:var(--muted);">
            Nom affiché
            <div style="display:flex;gap:8px;">
              <input id="profile-input-name" type="text" value="${escapeHtml(state.user.displayName || '')}" style="flex:1;border-radius:8px;border:1px solid var(--panel-border);background:#0e131b;padding:8px 12px;color:var(--text);" />
              <button id="profile-save-name" class="primary-button" style="min-height:36px;padding:0 14px;">✓</button>
            </div>
          </label>
          <label style="display:grid;gap:6px;font-size:0.88rem;color:var(--muted);">
            Email
            <div style="display:flex;gap:8px;">
              <input id="profile-input-email" type="email" value="${escapeHtml(state.user.email || '')}" style="flex:1;border-radius:8px;border:1px solid var(--panel-border);background:#0e131b;padding:8px 12px;color:var(--text);" />
              <button id="profile-save-email" class="primary-button" style="min-height:36px;padding:0 14px;">✓</button>
            </div>
          </label>
          <label style="display:grid;gap:6px;font-size:0.88rem;color:var(--muted);">
            Photo de profil (URL)
            <div style="display:flex;gap:8px;">
              <input id="profile-input-avatar" type="url" value="${escapeHtml(state.user.avatarUrl || '')}" placeholder="https://..." style="flex:1;border-radius:8px;border:1px solid var(--panel-border);background:#0e131b;padding:8px 12px;color:var(--text);" />
              <button id="profile-save-avatar" class="primary-button" style="min-height:36px;padding:0 14px;">✓</button>
            </div>
          </label>
          ${!state.user.discordId ? `<a class="ghost-button full" href="/auth/discord" style="margin-top:4px;text-align:center;">Lier mon compte Discord</a>` : ''}
        </div>
        </aside>

        <div class="profile-main">
          <section class="panel profile-stats-grid">
            <article class="profile-stat-card">
              <span>Articles dans le panier</span>
              <strong>${cartCount}</strong>
            </article>
            <article class="profile-stat-card">
              <span>Langue active</span>
              <strong>${state.locale.toUpperCase()}</strong>
            </article>
            <article class="profile-stat-card">
              <span>Type de compte</span>
              <strong>${escapeHtml(state.user.role || "client")}</strong>
            </article>
          </section>

          <section class="panel profile-section-card">
            <div class="profile-section-head">
              <div>
                <span class="eyebrow">Informations</span>
                <h3>Détails du compte</h3>
              </div>
            </div>
            <div class="profile-info-grid">
              <div class="profile-info-item">
                <span>Nom affiché</span>
                <strong>${escapeHtml(state.user.displayName || "Non défini")}</strong>
              </div>
              <div class="profile-info-item">
                <span>Email</span>
                <strong>${escapeHtml(state.user.email || "Non défini")}</strong>
              </div>
              <div class="profile-info-item">
                <span>Discord ID</span>
                <strong>${escapeHtml(state.user.discordId || "Non lié")}</strong>
              </div>
              <div class="profile-info-item">
                <span>Steam ID</span>
                <strong>${escapeHtml(state.user.steamId || "Non lié")}</strong>
              </div>
            </div>
          </section>

          <section class="panel profile-section-card">
            <div class="profile-section-head">
              <div>
                <span class="eyebrow">Activité</span>
                <h3>Raccourcis utiles</h3>
              </div>
            </div>
            <div class="profile-actions-grid">
              <a class="profile-action-card" href="cart.html">
                <span class="product-tag">Panier</span>
                <strong>Gérer mes achats en cours</strong>
                <p>Consultez vos produits sélectionnés et finalisez votre commande.</p>
              </a>
              <a class="profile-action-card" href="catalogue.html?sort=new">
                <span class="product-tag">Catalogue</span>
                <strong>Voir les nouveautés</strong>
                <p>Accédez rapidement aux derniers assets ajoutés sur la marketplace.</p>
              </a>
              <a class="profile-action-card" href="prestation.html">
                <span class="product-tag">Prestation</span>
                <strong>Découvrir l'accompagnement GSA</strong>
                <p>Explorez les services de game design et de structuration de projet.</p>
              </a>
            </div>
          </section>
        </div>
      </div>
    </section>
  `;

  document.getElementById("profile-save-name")?.addEventListener("click", async () => {
    const input = document.getElementById("profile-input-name");
    try {
      const res = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ displayName: input.value }) });
      state.user = res.user;
      updateHeaderLabels();
      input.style.outline = "2px solid var(--accent)";
      setTimeout(() => { input.style.outline = ""; }, 1200);
    } catch (err) { alert(err.message); }
  });

  document.getElementById("profile-save-email")?.addEventListener("click", async () => {
    const input = document.getElementById("profile-input-email");
    try {
      const res = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ email: input.value }) });
      state.user = res.user;
      updateHeaderLabels();
      input.style.outline = "2px solid var(--accent)";
      setTimeout(() => { input.style.outline = ""; }, 1200);
    } catch (err) { alert(err.message); }
  });

  document.getElementById("profile-save-avatar")?.addEventListener("click", async () => {
    const input = document.getElementById("profile-input-avatar");
    try {
      const res = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ avatarUrl: input.value }) });
      state.user = res.user;
      updateHeaderLabels();
      input.style.outline = "2px solid var(--accent)";
      setTimeout(() => { input.style.outline = ""; }, 1200);
    } catch (err) { alert(err.message); }
  });
}

async function renderAdminPage() {
  const app = document.getElementById("admin-page");
  if (!app) return;

  if (!state.user || state.user.role !== "admin") {
    app.innerHTML = `<section class="page-section"><div class="container empty-state"><h2>Accès administrateur requis</h2><p>Connectez-vous avec le compte admin pour gérer les produits.</p><a class="primary-button" href="login.html?redirect=admin.html">Connexion</a></div></section>`;
    return;
  }

  const products = await api("/api/admin/products");

  app.innerHTML = `
    <section class="page-hero small"><div class="container"><span class="eyebrow">Backoffice</span><h1>Gestion des produits</h1><p>Ajout rapide de produits en base et suppression depuis l'interface.</p></div></section>
    <section class="page-section"><div class="container split-layout">
      <form class="panel form-panel" id="admin-product-form">
        <h2>Nouveau produit</h2>
        <label>Titre<input name="title" required /></label>
        <label>Résumé<input name="shortDescription" required /></label>
        <label>Description<textarea name="description" rows="4" required></textarea></label>
        <label>Installation<textarea name="installation" rows="4" required></textarea></label>
        <label>Catégorie<select name="categorySlug">${state.categories.map((category) => `<option value="${category.slug}">${escapeHtml(category.name)}</option>`).join("")}</select></label>
        <label>Seller slug<input name="sellerSlug" value="tresingo" required /></label>
        <label>Prix<input name="price" type="number" step="0.01" required /></label>
        <label>Ancien prix<input name="oldPrice" type="number" step="0.01" /></label>
        <label>Réduction %<input name="discountPercent" type="number" step="1" /></label>
        <label>Tags (virgules)<input name="tags" /></label>
        <label>Image miniature URL<input name="thumbnail" type="url" /></label>
        <button class="primary-button full" type="submit">Créer le produit</button>
      </form>
      <div class="panel">
        <h2>Produits existants</h2>
        <div class="admin-products-list">
          ${products.map((product) => `<article class="admin-product-row"><div><strong>${escapeHtml(product.title)}</strong><p>${escapeHtml(product.category)} • ${currency(product.price)} • -${product.discount_percent}%</p></div><button class="ghost-button" type="button" data-admin-delete="${product.id}">Supprimer</button></article>`).join("")}
        </div>
      </div>
    </div>
    
    <div class="container" style="margin-top:40px;">
      <div class="panel">
        <h2>Configuration Landing Page</h2>
        <p class="helper-text" style="margin-bottom:20px;">Gérez l'affichage des sections "Social Proof" sur la page d'accueil.</p>
        <div id="admin-landing-configs">
          <div class="spinner"></div> Chargement...
        </div>
      </div>
    </div>
    <div class="container" style="margin-top:40px;">
      <div class="panel">
        <h2>Codes ambassadeur</h2>
        <p class="helper-text" style="margin-bottom:20px;">Générez des codes promotionnels utilisables dans le panier.</p>
        <form id="admin-promo-form" class="form-panel" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px;">
          <label>Ambassadeur<input name="ambassadorName" required placeholder="Nom ambassadeur" /></label>
          <label>Code personnalisé<input name="code" placeholder="Optionnel" /></label>
          <label>Type<select name="discountType"><option value="percent">Pourcentage</option><option value="fixed">Montant fixe</option></select></label>
          <label>Réduction<input name="discountValue" type="number" min="0" step="0.01" value="10" required /></label>
          <label>Utilisations max<input name="maxRedemptions" type="number" min="1" placeholder="Illimité" /></label>
          <label>Expiration<input name="expiresAt" type="date" /></label>
          <button class="primary-button full" type="submit" style="align-self:end;">Générer</button>
        </form>
        <div id="admin-promo-message" class="helper-text" style="margin-bottom:14px;"></div>
        <div id="admin-promo-codes"><div class="spinner"></div> Chargement...</div>
      </div>
    </div>
    </section>
  `;

  const loadPromoCodes = async () => {
    const container = document.getElementById("admin-promo-codes");
    if (!container) return;

    try {
      const data = await api("/api/admin/promo-codes");
      const items = data.items || [];
      container.innerHTML = items.length
        ? `
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="text-align:left;border-bottom:1px solid var(--panel-border);">
                  <th style="padding:12px;">Code</th>
                  <th style="padding:12px;">Ambassadeur</th>
                  <th style="padding:12px;">Réduction</th>
                  <th style="padding:12px;">Utilisations</th>
                  <th style="padding:12px;">Expiration</th>
                  <th style="padding:12px;">Remises totales</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((promo) => `
                  <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
                    <td style="padding:12px;"><strong>${escapeHtml(promo.code)}</strong></td>
                    <td style="padding:12px;">${escapeHtml(promo.ambassadorName || "-")}</td>
                    <td style="padding:12px;">${promo.discountType === "percent" ? `${Number(promo.discountValue)}%` : currency(promo.discountValue)}</td>
                    <td style="padding:12px;">${promo.redeemedCount}${promo.maxRedemptions ? ` / ${promo.maxRedemptions}` : " / ∞"}</td>
                    <td style="padding:12px;">${promo.expiresAt ? new Date(promo.expiresAt).toLocaleDateString("fr-FR") : "Aucune"}</td>
                    <td style="padding:12px;">${currency(promo.totalDiscountAmount)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
        : `<div class="empty-state"><h3>Aucun code ambassadeur</h3><p>Créez un premier code avec le formulaire ci-dessus.</p></div>`;
    } catch (error) {
      container.innerHTML = `<p class="helper-text">${escapeHtml(error.message)}</p>`;
    }
  };

  const loadLandingConfig = async () => {
    try {
      const res = await api("/api/admin/settings");
      const configs = res.landingConfig || [];
      const defaultSections = [
        { key: "social_proof_1", title: "SOCIAL PROOF", desc: "Premier bandeau" },
        { key: "social_proof_2", title: "SOCIAL PROOF", desc: "Deuxième bandeau" }
      ];

      const container = document.getElementById("admin-landing-configs");
      if (!container) return;

      container.innerHTML = defaultSections.map(def => {
        const conf = configs.find(c => c.section_key === def.key) || { is_active: true, title: def.title, description: def.desc };
        return `
          <div style="padding:16px; border:1px solid rgba(255,255,255,0.1); border-radius:8px; margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
              <strong>${escapeHtml(def.desc)} (${def.key})</strong>
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" data-landing-toggle="${def.key}" ${conf.is_active ? "checked" : ""} /> Visible
              </label>
            </div>
            <div style="display:flex; gap:12px;">
              <input type="text" data-landing-title="${def.key}" value="${escapeHtml(conf.title)}" placeholder="Texte du bandeau" style="flex:1;" />
              <button type="button" class="ghost-button" data-landing-save="${def.key}">Enregistrer</button>
            </div>
          </div>
        `;
      }).join("");

      document.querySelectorAll("[data-landing-save]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const key = btn.dataset.landingSave;
          const title = document.querySelector(`[data-landing-title="${key}"]`).value;
          const isActive = document.querySelector(`[data-landing-toggle="${key}"]`).checked;
          try {
            await api(`/api/admin/landing-config/${key}`, {
              method: "PATCH",
              body: JSON.stringify({ title, isActive })
            });
            btn.textContent = "✓ Sauvegardé";
            setTimeout(() => { btn.textContent = "Enregistrer"; }, 2000);
          } catch(e) { alert(e.message); }
        });
      });
    } catch (e) {
      console.error(e);
    }
  };

  loadLandingConfig();
  loadPromoCodes();

  document.getElementById("admin-promo-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const message = document.getElementById("admin-promo-message");

    try {
      const response = await api("/api/admin/promo-codes", {
        method: "POST",
        body: JSON.stringify({
          ambassadorName: formData.get("ambassadorName"),
          code: formData.get("code"),
          discountType: formData.get("discountType"),
          discountValue: Number(formData.get("discountValue") || 0),
          maxRedemptions: formData.get("maxRedemptions") ? Number(formData.get("maxRedemptions")) : null,
          expiresAt: formData.get("expiresAt") || null,
        }),
      });
      if (message) message.textContent = `Code généré : ${response.code}`;
      event.currentTarget.reset();
      await loadPromoCodes();
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  });

  document.getElementById("admin-product-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      await api("/api/admin/products", {
        method: "POST",
        body: JSON.stringify({
          title: formData.get("title"),
          shortDescription: formData.get("shortDescription"),
          description: formData.get("description"),
          installation: formData.get("installation"),
          categorySlug: formData.get("categorySlug"),
          sellerSlug: formData.get("sellerSlug"),
          price: Number(formData.get("price")),
          oldPrice: Number(formData.get("oldPrice") || 0),
          discountPercent: Number(formData.get("discountPercent") || 0),
          tags: String(formData.get("tags") || "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          thumbnail: formData.get("thumbnail"),
        }),
      });
      location.reload();
    } catch (error) {
      alert(error.message);
    }
  });

  document.querySelectorAll("[data-admin-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/admin/products/${button.dataset.adminDelete}`, { method: "DELETE" });
        location.reload();
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function boot() {
  await hydrateSession();
  attachSearchHandler();
  attachLanguageToggle();

  if (
    document.body.dataset.page === "home" ||
    document.getElementById("catalogue-page") ||
    document.getElementById("admin-page")
  ) {
    await loadBootstrap();
  }

  updateHeaderLabels();

  if (document.body.dataset.page === "home") renderHomePage();
  await renderCataloguePage();
  await renderProductPage();
  await renderLoginPage();
  await renderCartPage();
  renderPrestationPage();
  renderAboutPage();
  await renderProfilePage();
  await renderAdminPage();
  await renderSellerPage();
}

async function renderSellerPage() {
  const app = document.getElementById("seller-page");
  if (!app) return;

  const slug = getQueryParams().get("id");
  if (!slug) {
    app.innerHTML = `<div class="container empty-state"><h2>Vendeur introuvable</h2></div>`;
    return;
  }

  try {
    const data = await api(`/api/sellers/${encodeURIComponent(slug)}`);
    const { seller, products } = data;

    // Déterminer si l'utilisateur connecté regarde son propre profil vendeur
    const isOwner = state.user && state.user.slug === seller.slug;

    let dashboardHtml = "";
    if (isOwner) {
      try {
        const dashboardData = await api("/api/seller/dashboard");
        const linkedBadge = (linked, label = "Lié") => linked
          ? `<span class="chip chip-accent" style="color:#4ade80;border-color:rgba(74,222,128,0.35);background:rgba(74,222,128,0.08);">${label}</span>`
          : `<span class="chip" style="color:#f87171;border-color:rgba(248,113,113,0.35);background:rgba(248,113,113,0.08);">Non lié</span>`;
        dashboardHtml = `
          <div class="seller-dashboard-wrap" style="margin-top: 40px;">
            <div class="section-head">
              <div>
                <span class="eyebrow">Tableau de bord</span>
                <h2>Statistiques Vendeur</h2>
              </div>
            </div>
            
            <div class="profile-stats-grid" style="margin-bottom: 30px;">
              <article class="profile-stat-card">
                <span>CA brut encaissé</span>
                <strong>${currency(dashboardData.stats.totalRevenue)}</strong>
              </article>
              <article class="profile-stat-card">
                <span>Commission Tresingo / GSA</span>
                <strong>${currency(dashboardData.stats.platformFees)}</strong>
                <small style="color:var(--muted);">${Number(dashboardData.stats.platformCommissionPercent || 0)}% appliqué</small>
              </article>
              <article class="profile-stat-card">
                <span>Revenu net vendeur</span>
                <strong>${currency(dashboardData.stats.sellerNetRevenue)}</strong>
              </article>
              <article class="profile-stat-card">
                <span>Produits vendus</span>
                <strong>${dashboardData.stats.unitsSold}</strong>
              </article>
              <article class="profile-stat-card">
                <span>Produits en vente</span>
                <strong>${dashboardData.stats.activeProducts}</strong>
              </article>
            </div>

            <div class="panel" style="margin-bottom: 30px;">
              <div class="profile-section-head">
                <div>
                  <span class="eyebrow">Profil vendeur</span>
                  <h3>Informations de compte</h3>
                </div>
              </div>
              <div class="profile-info-grid">
                <div class="profile-info-item">
                  <span>Date d'arrivée vendeur</span>
                  <strong>${new Date(dashboardData.joinedAt).toLocaleDateString("fr-FR")}</strong>
                </div>
                <div class="profile-info-item">
                  <span>Compte Discord lié</span>
                  <strong>${linkedBadge(dashboardData.discordLinked, dashboardData.discordId ? `Lié (${escapeHtml(dashboardData.discordId)})` : "Lié")}</strong>
                </div>
                <div class="profile-info-item">
                  <span>Compte Stripe lié</span>
                  <strong>${linkedBadge(dashboardData.stripeLinked)}</strong>
                </div>
              </div>
            </div>

            <div class="panel" style="margin-bottom: 30px;">
              <div class="profile-section-head">
                <div>
                  <span class="eyebrow">Performance</span>
                  <h3>Unités par article</h3>
                </div>
              </div>
              <div style="overflow-x: auto;">
                <table class="admin-table" style="width:100%; border-collapse:collapse; margin-top:15px;">
                  <thead>
                    <tr style="text-align:left; border-bottom:1px solid var(--panel-border);">
                      <th style="padding:12px;">Produit</th>
                      <th style="padding:12px; text-align:right;">Unités vendues</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${dashboardData.stats.unitsPerArticle.length > 0 
                      ? dashboardData.stats.unitsPerArticle.map(item => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                          <td style="padding:12px; font-weight:500;">${escapeHtml(item.title)}</td>
                          <td style="padding:12px; text-align:right; font-weight:600; color:var(--accent);">${item.units}</td>
                        </tr>
                      `).join("")
                      : '<tr><td colspan="2" style="padding:30px; text-align:center; color:var(--muted);">Aucune vente enregistrée pour le moment.</td></tr>'
                    }
                  </tbody>
                </table>
              </div>
            </div>

            <div class="panel">
              <div class="profile-section-head">
                <div>
                  <span class="eyebrow">Historique</span>
                  <h3>Suivis des ventes</h3>
                </div>
              </div>
              <div style="overflow-x: auto;">
                <table class="admin-table" style="width:100%; border-collapse:collapse; margin-top:15px;">
                  <thead>
                    <tr style="text-align:left; border-bottom:1px solid var(--panel-border);">
                      <th style="padding:12px;">Date</th>
                      <th style="padding:12px;">Produit</th>
                      <th style="padding:12px;">Client</th>
                      <th style="padding:12px;">Prix brut</th>
                      <th style="padding:12px;">Commission</th>
                      <th style="padding:12px;">Net vendeur</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${dashboardData.sales.length > 0 
                      ? dashboardData.sales.map(sale => `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                          <td style="padding:12px; font-size:0.9rem;">${new Date(sale.date).toLocaleDateString("fr-FR")}</td>
                          <td style="padding:12px; font-weight:500;">${escapeHtml(sale.product_title)}</td>
                          <td style="padding:12px; color:var(--muted); font-size:0.85rem;">${escapeHtml(sale.client)}</td>
                          <td style="padding:12px; font-weight:600; color:var(--accent);">${currency(sale.price)}</td>
                          <td style="padding:12px; font-weight:600; color:#fbbf24;">${currency(sale.platform_fee_amount)}</td>
                          <td style="padding:12px; font-weight:600; color:#4ade80;">${currency(sale.seller_net_amount)}</td>
                        </tr>
                      `).join("")
                      : '<tr><td colspan="6" style="padding:30px; text-align:center; color:var(--muted);">Aucune vente enregistrée pour le moment.</td></tr>'
                    }
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `;
      } catch (dashError) {
        console.error("Dashboard load error:", dashError);
      }
    }

    document.title = `${escapeHtml(seller.displayName)} — Boutique GSA`;
    let metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.content = `Découvrez tous les scripts et ressources Garry's Mod de ${escapeHtml(seller.displayName)}.`;
    }

    app.innerHTML = `
      <section class="page-hero small">
        <div class="container" style="display:flex; align-items:center; gap:24px;">
          <img src="${escapeHtml(seller.avatarUrl || 'https://via.placeholder.com/120')}" style="width:100px; height:100px; border-radius:50%; object-fit:cover; border:2px solid var(--accent);" alt="${escapeHtml(seller.displayName)}" />
          <div>
            <span class="eyebrow">${isOwner ? "Mon Espace" : "Créateur Vérifié"}</span>
            <h1>${escapeHtml(seller.displayName)}</h1>
            <p>Membre de la communauté GSA depuis le ${new Date(seller.joinedAt || Date.now()).toLocaleDateString("fr-FR")}.</p>
            <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;">
              <span class="chip chip-accent">${products.length} produit${products.length > 1 ? "s" : ""} en vente</span>
              <span class="chip">${Number(seller.totalUnitsSold || 0)} unité${Number(seller.totalUnitsSold || 0) > 1 ? "s" : ""} vendue${Number(seller.totalUnitsSold || 0) > 1 ? "s" : ""}</span>
              <span class="chip">Discord ${seller.discordLinked ? "lié" : "non lié"}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="page-section">
        <div class="container">
          ${dashboardHtml}

          <div class="section-head" style="${isOwner ? 'margin-top: 60px;' : ''}">
            <div>
              <span class="eyebrow">Catalogue</span>
              <h2>${isOwner ? "Mes Réalisations" : `Réalisations de ${escapeHtml(seller.displayName)}`}</h2>
            </div>
            <span class="badge">${products.length} produits</span>
          </div>

          <div class="market-products-grid ${products.length ? "" : "is-empty"}">
            ${
              products.length
                ? products.map((product) => productCard(product)).join("")
                : `<div class="empty-state"><h3>Aucun produit publié</h3><p>Ce créateur n'a pas encore mis de ressources en ligne.</p></div>`
            }
          </div>
        </div>
      </section>
    `;
  } catch (error) {
    app.innerHTML = `<div class="container empty-state"><h2>Erreur</h2><p>${escapeHtml(error.message)}</p><a class="primary-button" href="catalogue.html">Retour au catalogue</a></div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((error) => {
    console.error(error);
    const container = document.getElementById("page-content") || document.querySelector("main");
    if (container) {
      container.innerHTML = `<section class="page-section"><div class="container empty-state"><h2>Erreur de chargement</h2><p>${escapeHtml(error.message)}</p></div></section>`;
    }
  });
});
