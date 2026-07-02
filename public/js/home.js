/* Home page: featured strip + collection grid. */
(function () {
  "use strict";
  var featured = document.querySelector("[data-featured]");
  var grid = document.querySelector("[data-grid]");
  if (featured) featured.innerHTML = NB.skeletonCards(4);
  if (grid) grid.innerHTML = NB.skeletonCards(8);

  NB.getCatalog()
    .then(function (products) {
      if (!products.length) {
        if (featured) featured.innerHTML = "";
        if (grid) grid.innerHTML = '<p class="muted">The shelves are being stocked. Check back soon.</p>';
        return;
      }
      if (featured) featured.innerHTML = products.slice(0, 6).map(NB.cardHtml).join("");
      if (grid) grid.innerHTML = products.map(NB.cardHtml).join("");
    })
    .catch(function () {
      if (grid) grid.innerHTML = '<p class="muted">Could not load the catalog. Refresh to retry.</p>';
    });
})();
