/* Full cart page: line items, steppers, remove, subtotal, checkout. */
(function () {
  "use strict";
  var root = document.querySelector("[data-cart-root]");
  if (!root) return;

  function money(c) { return NB.money(c); }

  function render() {
    var items = NB.cart.items();
    if (!items.length) {
      root.innerHTML =
        '<div class="empty"><p>Your cart is empty.</p>' +
        '<a class="btn btn-primary" href="/shop" style="margin-top:12px">Browse the shop</a></div>';
      return;
    }
    root.innerHTML =
      '<div class="cart-lines">' + items.map(lineHtml).join("") + "</div>" +
      '<aside class="cart-summary">' +
        '<div class="subtotal-row"><span class="muted">Subtotal</span><span class="price">' + money(NB.cart.subtotal()) + "</span></div>" +
        '<p class="ship-microcopy">Shipped while you slept. Taxes &amp; shipping calculated at checkout.</p>' +
        '<button class="btn btn-primary btn-block" data-checkout>Checkout</button>' +
        '<a class="btn btn-ghost btn-block" href="/shop" style="margin-top:10px">Keep browsing</a>' +
      "</aside>";
    wire();
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

  function wire() {
    root.querySelectorAll(".line").forEach(function (row) {
      var vid = Number(row.getAttribute("data-vid"));
      var q = NB.cart.items().find(function (i) { return i.variantId === vid; });
      row.querySelector("[data-inc]").addEventListener("click", function () { NB.cart.setQty(vid, q.qty + 1); });
      row.querySelector("[data-dec]").addEventListener("click", function () { NB.cart.setQty(vid, q.qty - 1); });
      row.querySelector("[data-remove]").addEventListener("click", function () { NB.cart.remove(vid); });
    });
    var co = root.querySelector("[data-checkout]");
    if (co) co.addEventListener("click", function () { NB.cart.checkout(this); });
  }

  NB.cart.onChange(render);
  render();
})();
