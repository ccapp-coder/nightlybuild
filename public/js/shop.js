/* Shop page: grouped Drop sections + filters (type, color, drop) + sort. */
(function () {
  "use strict";
  var grid = document.querySelector("[data-grid]");
  var filtersHost = document.getElementById("filters");
  var countEl = document.querySelector("[data-count]");
  var loadMoreBtn = document.querySelector("[data-loadmore]");

  var DROP_ORDER = ["Drop 03", "Drop 02", "Drop 01", "Originals"];

  var all = [];
  var view = [];
  var state = { type: "", color: "", drop: "", sort: "newest" };

  grid.innerHTML = NB.skeletonCards(8);

  NB.getCatalog()
    .then(function (products) {
      all = products.map(function (p, idx) { return Object.assign({ _i: idx }, p); });
      buildFilters(all);
      applyURL();
      apply();
    })
    .catch(function () {
      grid.innerHTML = '<p class="muted">Could not load the catalog. Refresh to retry.</p>';
    });

  function uniq(list) { return list.filter(function (v, i) { return v && list.indexOf(v) === i; }); }

  function dropRank(d) {
    var i = DROP_ORDER.indexOf(d);
    return i < 0 ? DROP_ORDER.length + (d ? 0 : 1) : i;
  }

  function buildFilters(products) {
    var types = uniq(products.map(function (p) { return p.productType; }));
    var colors = uniq([].concat.apply([], products.map(function (p) { return p.colors.map(function (c) { return c.name; }); })));
    var drops = uniq(products.map(function (p) { return p.drop; }).filter(Boolean))
      .sort(function (a, b) { return dropRank(a) - dropRank(b); });

    filtersHost.innerHTML =
      (drops.length ? selectHtml("drop", "All drops", drops) : "") +
      selectHtml("type", "All products", types) +
      selectHtml("color", "All colors", colors) +
      '<select class="select" data-f="sort" aria-label="Sort">' +
        '<option value="newest">Newest</option>' +
        '<option value="price-asc">Price: low to high</option>' +
        '<option value="price-desc">Price: high to low</option>' +
      "</select>";

    filtersHost.querySelectorAll("[data-f]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        state[sel.getAttribute("data-f")] = sel.value;
        syncURL();
        apply();
      });
    });
  }

  function selectHtml(key, allLabel, values) {
    return (
      '<select class="select" data-f="' + key + '" aria-label="Filter by ' + key + '">' +
        '<option value="">' + allLabel + "</option>" +
        values.map(function (v) { return '<option value="' + NB.esc(v) + '">' + NB.esc(v) + "</option>"; }).join("") +
      "</select>"
    );
  }

  function apply() {
    view = all.filter(function (p) {
      if (state.type && p.productType !== state.type) return false;
      if (state.drop && p.drop !== state.drop) return false;
      if (state.color && !p.colors.some(function (c) { return c.name === state.color; })) return false;
      return true;
    });
    if (state.sort === "price-asc") view.sort(function (a, b) { return a.priceMin - b.priceMin; });
    else if (state.sort === "price-desc") view.sort(function (a, b) { return b.priceMin - a.priceMin; });
    else view.sort(function (a, b) { return a._i - b._i; });

    filtersHost.querySelectorAll("[data-f]").forEach(function (sel) { sel.value = state[sel.getAttribute("data-f")]; });
    render();
  }

  function render() {
    var groups = {};
    view.forEach(function (p) { var d = p.drop || "More"; (groups[d] = groups[d] || []).push(p); });
    var keys = Object.keys(groups).sort(function (a, b) { return dropRank(a) - dropRank(b); });

    grid.className = "shop-groups";
    grid.style.display = "block";
    grid.innerHTML = keys.map(function (k) {
      var items = groups[k];
      var head = '<div class="drop-head"><h2 class="mono">' + NB.esc(k) + "</h2>" +
        '<span class="muted mono">' + items.length + " item" + (items.length === 1 ? "" : "s") + "</span></div>";
      return '<section class="drop-section">' + head +
        '<div class="grid">' + items.map(NB.cardHtml).join("") + "</div></section>";
    }).join("") || '<p class="muted">Nothing matches those filters.</p>';

    if (countEl) countEl.textContent = view.length + " item" + (view.length === 1 ? "" : "s");
    if (loadMoreBtn) loadMoreBtn.style.display = "none";
  }

  function syncURL() {
    var q = new URLSearchParams();
    Object.keys(state).forEach(function (k) { if (state[k] && state[k] !== "newest") q.set(k, state[k]); });
    var s = q.toString();
    history.replaceState(null, "", s ? "?" + s : location.pathname);
  }
  function applyURL() {
    var q = new URLSearchParams(location.search);
    ["type", "color", "drop", "sort"].forEach(function (k) { if (q.get(k)) state[k] = q.get(k); });
  }

  var openBtn = document.querySelector("[data-open-filters]");
  var sheet = document.querySelector("[data-sheet]");
  var sheetBackdrop = document.querySelector("[data-sheet-backdrop]");
  var sheetBody = sheet && sheet.querySelector("[data-sheet-body]");
  var home = filtersHost.parentNode;

  function openSheet() { sheetBody.appendChild(filtersHost); sheetBackdrop.classList.add("open"); sheet.classList.add("open"); }
  function closeSheet() {
    sheet.classList.remove("open"); sheetBackdrop.classList.remove("open");
    setTimeout(function () { home.insertBefore(filtersHost, home.firstChild); }, 240);
  }
  if (openBtn) openBtn.addEventListener("click", openSheet);
  if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeSheet);
  if (sheet) { var done = sheet.querySelector("[data-sheet-done]"); if (done) done.addEventListener("click", closeSheet); }
})();
