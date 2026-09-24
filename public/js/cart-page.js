/* Full cart page: line items, steppers, remove, ship-to country, live shipping quote, checkout. */
(function () {
  "use strict";
  var root = document.querySelector("[data-cart-root]");
  if (!root) return;

  var COUNTRIES = [["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"], ["NZ", "New Zealand"], ["IE", "Ireland"]];
  var quoteSeq = 0;

  function money(c) { return NB.money(c); }

  function render() {
    var items = NB.cart.items();
    if (!items.length) {
      root.innerHTML =
        '<div class="empty"><p>Your cart is empty.</p>' +
        '<a class="btn btn-primary" href="/shop" style="margin-top:12px">Browse the shop</a></div>';
      return;
    }
    var country = NB.cart.shipCountry() || "US";
    root.innerHTML =
      '<div class="cart-lines">' + items.map(lineHtml).join("") + "</div>" +
      '<aside class="cart-summary">' +
        '<label class="muted mono" for="ship-to" style="display:block;margin-bottom:6px">Ship to</label>' +
        '<select class="select" id="ship-to" data-ship style="width:100%;margin-bottom:14px">' +
          COUNTRIES.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === country ? " selected" : "") + ">" + c[1] + "</option>"; }).join("") +
        "</select>" +
        '<div class="subtotal-row"><span class="muted">Subtotal</span><span class="price">' + money(NB.cart.subtotal()) + "</span></div>" +
        '<div class="subtotal-row"><span class="muted">Shipping</span><span class="price" data-shipping>…</span></div>' +
        '<div class="subtotal-row"><span class="muted">Tax</span><span class="muted">At checkout</span></div>' +
        '<div class="subtotal-row"><span>Total</span><span class="price" data-total>…</span></div>' +
        '<button class="btn btn-primary btn-block" data-checkout style="margin-top:12px">Checkout</button>' +
        '<a class="btn btn-ghost btn-block" href="/shop" style="margin-top:10px">Keep browsing</a>' +
      "</aside>";
    wire();
    quote();
  }

  function lineHtml(i) {
    var variant = [i.color, i.size].filter(Boolean).join(" · ");
    return (
      '<div class="line" data-vid="' + i.variantId + '">' +
        '<a class="line-thumb" href="/p/' + NB.esc(i.handle || "") + '">' + (i.thumb ? '<img src="' + NB.esc(i.thumb) + '" alt="" loading="lazy">' : "") + "</a>" +
        '<div><div class="line-title">' + NB.esc(i.title) + "</div>" +
          (variant ? '<div class="line-variant">' + NB.esc(variant) + "</div>" : "") +
          '<button class="line-remove" data-remove>Remove</button></div>' +
        '<div class="line-right"><div class="qty">' +
          '<button data-dec aria-label="Decrease quantity">−</button><span>' + i.qty + "</span>" +
          '<button data-inc aria-label="Increase quantity">+</button></div>' +
          '<div class="price">' + money(i.price * i.qty) + "</div></div>" +
      "</div>"
    );
  }

  function quote() {
    var seq = ++quoteSeq;
    var shipEl = root.querySelector("[data-shipping]");
    var totalEl = root.querySelector("[data-total]");
    var btn = root.querySelector("[data-checkout]");
    btn.disabled = true;
    NB.api("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: NB.cart.shipCountry() || "US",
        items: NB.cart.items().map(function (i) { return { productId: i.productId, variantId: i.variantId, quantity: i.qty }; }),
      }),
    })
      .then(function (q) {
        if (seq !== quoteSeq) return;
        shipEl.textContent = money(q.shipping);
        totalEl.textContent = money(q.total) + " + tax";
        btn.disabled = false;
      })
      .catch(function (err) {
        if (seq !== quoteSeq) return;
        shipEl.textContent = "n/a";
        totalEl.textContent = "n/a";
        NB.toast(err && err.body && err.body.error === "no_shipping" ? "We can't ship that cart to that country yet." : "Couldn't price shipping. Refresh to retry.", true);
      });
  }

  function wire() {
    root.querySelectorAll(".line").forEach(function (row) {
      var vid = Number(row.getAttribute("data-vid"));
      var q = NB.cart.items().find(function (i) { return i.variantId === vid; });
      row.querySelector("[data-inc]").addEventListener("click", function () { NB.cart.setQty(vid, q.qty + 1); });
      row.querySelector("[data-dec]").addEventListener("click", function () { NB.cart.setQty(vid, q.qty - 1); });
      row.querySelector("[data-remove]").addEventListener("click", function () { NB.cart.remove(vid); });
    });
    root.querySelector("[data-ship]").addEventListener("change", function () {
      NB.cart.setShipCountry(this.value);
      quote();
    });
    var co = root.querySelector("[data-checkout]");
    if (co) co.addEventListener("click", function () { NB.cart.checkout(this); });
  }

  if (!NB.cart.shipCountry()) {
    var lang = (navigator.language || "").toUpperCase();
    var guess = COUNTRIES.map(function (c) { return c[0]; }).find(function (c) { return lang.endsWith("-" + c); });
    NB.cart.setShipCountry(guess || "US");
  }
  NB.cart.onChange(render);
  render();
})();
