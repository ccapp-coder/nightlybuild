/* Success page: confirm order, show summary, clear the cart. */
(function () {
  "use strict";
  var box = document.querySelector("[data-order]");
  var sid = new URLSearchParams(location.search).get("session_id");

  // Payment came back — the cart has done its job.
  try { NB.cart.clear(); } catch (e) {}

  if (!box) return;
  if (!sid) {
    box.innerHTML = '<p class="muted">No order reference found. If you just paid, check your email for a receipt.</p>';
    return;
  }

  NB.api("/api/session?id=" + encodeURIComponent(sid))
    .then(function (res) {
      var o = res.order || {};
      var rows = [];
      if (o.total != null) rows.push(row("Total", NB.money(o.total)));
      if (o.email) rows.push(row("Receipt sent to", NB.esc(o.email)));
      if (o.shippingName) rows.push(row("Shipping to", NB.esc(o.shippingName)));
      box.innerHTML =
        '<div class="order-card">' + rows.join("") +
        '<p class="ship-microcopy" style="margin-top:14px">We are on it. Your build enters the queue and ships while you sleep.</p></div>';
    })
    .catch(function () {
      box.innerHTML = '<p class="muted">Payment confirmed. Your receipt is on its way by email.</p>';
    });

  function row(label, value) {
    return '<div class="subtotal-row"><span class="muted">' + label + '</span><span class="mono">' + value + "</span></div>";
  }
})();
