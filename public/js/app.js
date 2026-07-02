/* Nightly Build — shared client core: catalog fetch, cart, drawer, toast.
   Vanilla JS, no deps. Loaded on every page. */
(function () {
  "use strict";

  var CART_KEY = "nb_cart_v1";
  var CATALOG_KEY = "nb_catalog_v1";
  var CATALOG_TTL = 5 * 60 * 1000;

  // ---------- utilities ----------
  function money(cents) {
    if (cents == null || isNaN(cents)) return "$0";
    var d = cents / 100;
    return "$" + (d % 1 === 0 ? d.toFixed(0) : d.toFixed(2));
  }
  function priceRange(p) {
    return p.priceMin === p.priceMax
      ? money(p.priceMin)
      : money(p.priceMin) + "–" + money(p.priceMax);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw Object.assign(new Error(body.error || "request_failed"), { body: body });
        return body;
      });
    });
  }

  // ---------- catalog (sessionStorage cache) ----------
  function getCatalog(force) {
    if (!force) {
      try {
        var raw = sessionStorage.getItem(CATALOG_KEY);
        if (raw) {
          var c = JSON.parse(raw);
          if (Date.now() - c.t < CATALOG_TTL) return Promise.resolve(c.products);
        }
      } catch (e) {}
    }
    return api("/api/catalog").then(function (res) {
      try {
        sessionStorage.setItem(CATALOG_KEY, JSON.stringify({ t: Date.now(), products: res.products }));
      } catch (e) {}
      return res.products;
    });
  }

  // ---------- cart ----------
  function loadCart() {
    try {
      var raw = localStorage.getItem(CART_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }
  var items = loadCart();
  var listeners = [];

  function save() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch (e) {}
    listeners.forEach(function (fn) { fn(items); });
    renderChrome();
  }
  function onChange(fn) { listeners.push(fn); }

  function count() { return items.reduce(function (n, i) { return n + i.qty; }, 0); }
  function subtotal() { return items.reduce(function (n, i) { return n + i.price * i.qty; }, 0); }

  function add(item) {
    // item: {variantId, productId, title, color, size, price, thumb, handle}
    var found = items.find(function (i) { return i.variantId === item.variantId; });
    if (found) found.qty = Math.min(20, found.qty + (item.qty || 1));
    else items.push(Object.assign({}, item, { qty: item.qty || 1 }));
    save();
    toast("Added · " + item.title);
    openDrawer();
  }
  function setQty(variantId, qty) {
    var it = items.find(function (i) { return i.variantId === variantId; });
    if (!it) return;
    it.qty = Math.max(1, Math.min(20, qty));
    save();
  }
  function remove(variantId) {
    items = items.filter(function (i) { return i.variantId !== variantId; });
    save();
  }
  function clear() { items = []; save(); }

  function checkout(btn) {
    if (!items.length) return;
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Building your checkout…"; }
    api("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items.map(function (i) { return { variantId: i.variantId, quantity: i.qty }; }) }),
    })
      .then(function (res) {
        if (res.url) window.location.href = res.url;
        else throw new Error("no_url");
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || "Checkout"; }
        toast("Checkout hiccup. Try again.", true);
        console.error(err);
      });
  }

  // ---------- chrome: header count, drawer, mobile bar, toast ----------
  var drawerEl, backdropEl, mobileBar, toastWrap;

  function ensureChrome() {
    if (toastWrap) return;
    toastWrap = el('<div class="toast-wrap" aria-live="polite" aria-atomic="true"></div>');
    document.body.appendChild(toastWrap);

    backdropEl = el('<div class="drawer-backdrop" hidden></div>');
    drawerEl = el(
      '<aside class="drawer" role="dialog" aria-label="Cart" aria-modal="true">' +
        '<div class="drawer-head"><span class="wordmark">cart<span class="cursor"></span></span>' +
        '<button class="drawer-close" aria-label="Close cart">×</button></div>' +
        '<div class="drawer-body"></div>' +
        '<div class="drawer-foot"></div>' +
      "</aside>"
    );
    document.body.appendChild(backdropEl);
    document.body.appendChild(drawerEl);
    backdropEl.addEventListener("click", closeDrawer);
    drawerEl.querySelector(".drawer-close").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });

    mobileBar = el(
      '<div class="mobile-cartbar" aria-hidden="true">' +
        '<span class="mono" data-mb-label>Cart</span>' +
        '<a class="btn btn-primary" href="/cart">View cart</a>' +
      "</div>"
    );
    document.body.appendChild(mobileBar);
  }

  function renderChrome() {
    ensureChrome();
    var n = count();
    // header counts
    document.querySelectorAll("[data-cart-count]").forEach(function (node) {
      node.textContent = n;
      node.setAttribute("data-empty", n === 0 ? "true" : "false");
    });
    // mobile bar
    if (n > 0) {
      mobileBar.classList.add("show");
      document.body.classList.add("has-cart");
      mobileBar.querySelector("[data-mb-label]").textContent = n + " item" + (n > 1 ? "s" : "") + " · " + money(subtotal());
      var mbBtn = mobileBar.querySelector(".btn");
      mbBtn.textContent = "View cart · " + money(subtotal());
    } else {
      mobileBar.classList.remove("show");
      document.body.classList.remove("has-cart");
    }
    if (drawerEl && drawerEl.classList.contains("open")) renderDrawer();
  }

  function renderDrawer() {
    var body = drawerEl.querySelector(".drawer-body");
    var foot = drawerEl.querySelector(".drawer-foot");
    if (!items.length) {
      body.innerHTML = '<div class="empty">Nothing here yet.<br>Go grab something built while you slept.</div>';
      foot.innerHTML = '<a class="btn btn-block" href="/shop">Browse the shop</a>';
      return;
    }
    body.innerHTML = items.map(lineHtml).join("");
    foot.innerHTML =
      '<div class="subtotal-row"><span class="muted">Subtotal</span><span class="price">' + money(subtotal()) + "</span></div>" +
      '<p class="ship-microcopy">Shipped while you slept. Taxes &amp; shipping shown at checkout.</p>' +
      '<button class="btn btn-primary btn-block" data-checkout>Checkout</button>' +
      '<a class="btn btn-ghost btn-block" href="/cart" style="margin-top:8px">View full cart</a>';
    wireLineControls(body);
    foot.querySelector("[data-checkout]").addEventListener("click", function () { checkout(this); });
  }

  function lineHtml(i) {
    var variant = [i.color, i.size].filter(Boolean).join(" · ");
    return (
      '<div class="line" data-vid="' + i.variantId + '">' +
        '<div class="line-thumb">' + (i.thumb ? '<img src="' + esc(i.thumb) + '" alt="" loading="lazy">' : "") + "</div>" +
        '<div><div class="line-title">' + esc(i.title) + "</div>" +
          (variant ? '<div class="line-variant">' + esc(variant) + "</div>" : "") +
          '<button class="line-remove" data-remove>Remove</button></div>' +
        '<div class="line-right"><div class="qty">' +
          '<button data-dec aria-label="Decrease quantity">−</button>' +
          "<span>" + i.qty + "</span>" +
          '<button data-inc aria-label="Increase quantity">+</button></div>' +
          '<div class="price">' + money(i.price * i.qty) + "</div></div>" +
      "</div>"
    );
  }

  function wireLineControls(root) {
    root.querySelectorAll(".line").forEach(function (row) {
      var vid = Number(row.getAttribute("data-vid"));
      row.querySelector("[data-inc]").addEventListener("click", function () {
        setQty(vid, qtyOf(vid) + 1);
      });
      row.querySelector("[data-dec]").addEventListener("click", function () {
        setQty(vid, qtyOf(vid) - 1);
      });
      row.querySelector("[data-remove]").addEventListener("click", function () { remove(vid); });
    });
  }
  function qtyOf(vid) {
    var it = items.find(function (i) { return i.variantId === vid; });
    return it ? it.qty : 1;
  }

  function openDrawer() {
    ensureChrome();
    renderDrawer();
    backdropEl.hidden = false;
    requestAnimationFrame(function () {
      backdropEl.classList.add("open");
      drawerEl.classList.add("open");
    });
  }
  function closeDrawer() {
    if (!drawerEl) return;
    backdropEl.classList.remove("open");
    drawerEl.classList.remove("open");
    setTimeout(function () { if (backdropEl) backdropEl.hidden = true; }, 240);
  }

  var toastTimer;
  function toast(msg, isError) {
    ensureChrome();
    var t = el('<div class="toast">' + esc(msg) + "</div>");
    if (isError) t.style.borderColor = "var(--danger)";
    toastWrap.appendChild(t);
    // haptic-style micro feedback where supported
    if (!isError && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
    requestAnimationFrame(function () { t.classList.add("show"); });
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { t.remove(); }, 220);
    }, 2200);
  }

  // ---------- expose ----------
  window.NB = {
    money: money,
    priceRange: priceRange,
    esc: esc,
    el: el,
    api: api,
    getCatalog: getCatalog,
    cart: {
      items: function () { return items.slice(); },
      count: count,
      subtotal: subtotal,
      add: add,
      remove: remove,
      setQty: setQty,
      clear: clear,
      checkout: checkout,
      onChange: onChange,
      openDrawer: openDrawer,
    },
    toast: toast,
  };

  // Header cart button opens the drawer (progressive enhancement over the /cart link).
  document.addEventListener("DOMContentLoaded", function () {
    renderChrome();
    document.querySelectorAll("[data-open-cart]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        // Only intercept on non-cart pages; keep it a real link for no-JS.
        if (location.pathname !== "/cart") { e.preventDefault(); openDrawer(); }
      });
    });
  });
})();
