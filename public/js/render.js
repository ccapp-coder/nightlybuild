/* Shared render helpers for product cards + suggestion rows. Depends on app.js (NB). */
(function () {
  "use strict";
  var esc = NB.esc, money = NB.money, priceRange = NB.priceRange;

  function dotsHtml(colors) {
    if (!colors || !colors.length) return "";
    var shown = colors.slice(0, 4).map(function (c) {
      return '<span class="dot" title="' + esc(c.name) + '" style="background:' + esc(c.hex || "#2a2f36") + '"></span>';
    }).join("");
    var extra = colors.length > 4 ? '<span class="more">+' + (colors.length - 4) + "</span>" : "";
    return '<span class="dots">' + shown + extra + "</span>";
  }

  function cardHtml(p) {
    var img = p.image
      ? '<img src="' + esc(p.image) + '" alt="' + esc(p.title) + '" loading="lazy" decoding="async" width="540" height="540">'
      : "";
    var chip = p.drop ? '<span class="tag-chip">' + esc(p.drop) + "</span>" : '<span class="tag-chip">' + esc(p.productType) + "</span>";
    return (
      '<a class="card" href="/p/' + esc(p.handle) + '">' +
        '<span class="card-media">' + img + "</span>" +
        '<span class="card-body">' +
          '<span class="card-title">' + esc(p.title) + "</span>" +
          '<span class="card-meta">' +
            '<span class="price">' + priceRange(p) + "</span>" +
            dotsHtml(p.colors) +
          "</span>" +
          chip +
        "</span>" +
      "</a>"
    );
  }

  function skeletonCards(n) {
    var one =
      '<div class="card skeleton-card"><span class="card-media skeleton"></span>' +
      '<span class="card-body"><span class="skeleton" style="height:14px;width:70%"></span>' +
      '<span class="skeleton" style="height:14px;width:30%"></span></span></div>';
    return new Array(n).fill(one).join("");
  }

  NB.cardHtml = cardHtml;
  NB.dotsHtml = dotsHtml;
  NB.skeletonCards = skeletonCards;
})();
