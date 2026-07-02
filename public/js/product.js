/* Product page: gallery, color/size pickers, price, add-to-cart, suggestions. */
(function () {
  "use strict";
  var root = document.querySelector("[data-product]");
  var suggestRow = document.querySelector("[data-suggest]");
  if (!root) return;

  var handle = (location.pathname.match(/^\/p\/([^\/?#]+)/) || [])[1] ||
    new URLSearchParams(location.search).get("handle") || "";

  var P = null;
  var state = { color: null, size: null, qty: 1, img: null };

  NB.api("/api/product?handle=" + encodeURIComponent(handle))
    .then(function (res) { P = res.product; init(); })
    .catch(function () {
      root.innerHTML = '<div class="container section"><h1>Not found</h1><p class="muted">That drop slipped away. <a href="/shop" style="color:var(--green)">Back to the shop</a>.</p></div>';
    });

  function hasColors() { return P.colors.length && P.colors.some(function (c) { return c.name; }); }
  function hasSizes() { return P.sizes.length && P.sizes.some(Boolean); }

  function variantFor(color, size) {
    return P.variants.find(function (v) {
      return (!hasColors() || v.color === color) && (!hasSizes() || v.size === size);
    });
  }
  function sizesForColor(color) {
    return P.sizes.filter(function (s) { return !!variantFor(color, s); });
  }
  function active() { return variantFor(state.color, state.size); }

  function init() {
    document.title = P.title + " · nightly build";
    if (hasColors()) state.color = P.colors[0].name;
    if (hasSizes()) {
      var avail = sizesForColor(state.color);
      state.size = avail[0] || P.sizes[0];
    }
    var av = active();
    state.img = (av && av.image) || P.images[0] || null;
    root.innerHTML = template();
    wire();
    render();
    loadSuggestions();
  }

  function template() {
    return (
      '<div class="container section"><div class="product">' +
        '<div class="gallery">' +
          '<div class="gallery-main"><img data-main alt="' + NB.esc(P.title) + '" width="720" height="720"></div>' +
          '<div class="gallery-thumbs" data-thumbs></div>' +
        "</div>" +
        '<div class="buybox">' +
          '<p class="eyebrow">' + NB.esc(P.drop || P.productType) + "</p>" +
          "<h1>" + NB.esc(P.title) + "</h1>" +
          '<div class="price price-lg" data-price></div>' +
          (hasColors() ? '<div class="opt-group"><h3>Color · <span data-color-name class="muted"></span></h3><div class="swatches" data-swatches></div></div>' : "") +
          (hasSizes() ? '<div class="opt-group"><h3>Size</h3><div class="sizes" data-sizes></div></div>' : "") +
          '<div class="opt-group"><h3>Quantity</h3><div class="qty"><button data-dec aria-label="Decrease">−</button><span data-qty>1</span><button data-inc aria-label="Increase">+</button></div></div>' +
          '<button class="btn btn-primary btn-block" data-add style="margin-top:8px">Add to cart</button>' +
          '<p class="note" style="margin-top:22px">Printed on demand the moment you order. Most builds ship in 2–5 business days. No warehouse, no waste.</p>' +
          (P.description ? '<div class="opt-group"><h3>Details</h3><p class="desc">' + NB.esc(P.description) + "</p></div>" : "") +
        "</div>" +
      "</div></div>"
    );
  }

  function wire() {
    if (hasColors()) {
      root.querySelector("[data-swatches]").innerHTML = P.colors.map(function (c) {
        return '<button class="swatch" data-color="' + NB.esc(c.name) + '" title="' + NB.esc(c.name) +
          '" aria-label="' + NB.esc(c.name) + '" style="background:' + NB.esc(c.hex || "#2a2f36") + '"></button>';
      }).join("");
      root.querySelectorAll("[data-color]").forEach(function (b) {
        b.addEventListener("click", function () {
          state.color = b.getAttribute("data-color");
          var avail = sizesForColor(state.color);
          if (hasSizes() && avail.indexOf(state.size) === -1) state.size = avail[0] || state.size;
          var av = active();
          if (av && av.image) state.img = av.image;
          render();
        });
      });
    }
    root.querySelector("[data-inc]").addEventListener("click", function () { state.qty = Math.min(20, state.qty + 1); render(); });
    root.querySelector("[data-dec]").addEventListener("click", function () { state.qty = Math.max(1, state.qty - 1); render(); });
    root.querySelector("[data-add]").addEventListener("click", addToCart);
  }

  function render() {
    // gallery
    var imgs = P.images.slice();
    if (state.img && imgs.indexOf(state.img) === -1) imgs.unshift(state.img);
    var main = root.querySelector("[data-main]");
    if (state.img) main.src = state.img;
    var thumbs = root.querySelector("[data-thumbs]");
    thumbs.innerHTML = imgs.map(function (src) {
      return '<button data-thumb="' + NB.esc(src) + '" aria-current="' + (src === state.img) + '"><img src="' + NB.esc(src) + '" alt="" loading="lazy"></button>';
    }).join("");
    thumbs.querySelectorAll("[data-thumb]").forEach(function (b) {
      b.addEventListener("click", function () { state.img = b.getAttribute("data-thumb"); render(); });
    });

    // color name
    var cn = root.querySelector("[data-color-name]");
    if (cn) cn.textContent = state.color || "";
    root.querySelectorAll("[data-color]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-color") === state.color);
    });

    // sizes (disable those not available in current color)
    if (hasSizes()) {
      var avail = sizesForColor(state.color);
      root.querySelector("[data-sizes]").innerHTML = P.sizes.map(function (s) {
        var ok = avail.indexOf(s) !== -1;
        return '<button class="size-btn" data-size="' + NB.esc(s) + '" ' + (ok ? "" : "disabled") +
          ' aria-pressed="' + (s === state.size) + '">' + NB.esc(s) + "</button>";
      }).join("");
      root.querySelectorAll("[data-size]").forEach(function (b) {
        if (b.disabled) return;
        b.addEventListener("click", function () { state.size = b.getAttribute("data-size"); render(); });
      });
    }

    // price + qty + add state
    var av = active();
    root.querySelector("[data-price]").textContent = av ? NB.money(av.price) : NB.priceRange(P);
    root.querySelector("[data-qty]").textContent = state.qty;
    var add = root.querySelector("[data-add]");
    add.disabled = !av;
    add.textContent = av ? "Add to cart · " + NB.money(av.price * state.qty) : "Unavailable";
  }

  function addToCart() {
    var av = active();
    if (!av) return;
    NB.cart.add({
      variantId: av.id,
      productId: P.id,
      handle: P.handle,
      title: P.title,
      color: av.color,
      size: av.size,
      price: av.price,
      thumb: av.image || P.images[0] || null,
      qty: state.qty,
    });
  }

  function loadSuggestions() {
    if (!suggestRow) return;
    NB.api("/api/suggest?product=" + encodeURIComponent(P.id))
      .then(function (res) {
        var inCart = NB.cart.items().map(function (i) { return i.productId; });
        var picks = res.products.filter(function (p) { return inCart.indexOf(p.id) === -1; }).slice(0, 6);
        if (!picks.length) { suggestRow.closest("[data-suggest-section]").style.display = "none"; return; }
        suggestRow.innerHTML = picks.map(NB.cardHtml).join("");
      })
      .catch(function () { suggestRow.closest("[data-suggest-section]").style.display = "none"; });
  }
})();
