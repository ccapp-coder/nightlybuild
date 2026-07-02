/* Shop page: filters (type, color, drop), sort, and load-more. */
(function () {
  "use strict";
  var grid = document.querySelector("[data-grid]");
  var filtersHost = document.getElementById("filters");
  var countEl = document.querySelector("[data-count]");
  var loadMoreBtn = document.querySelector("[data-loadmore]");
  var PAGE = 12;

  var all = [];
  var view = [];
  var shown = 0;
  var state = { type: "", color: "", drop: "", sort: "newest" };

  grid.innerHTML = NB.skeletonCards(8);

  NB.getCatalog()
    .then(function (products) {
      all = products.map(function (p, idx) { return Object.assign({ _i: idx }, p); }); // _i = catalog order (newest-ish)
      buildFilters(all);
      applyURL();
      apply();
    })
    .catch(function () {
      grid.innerHTML = '<p class="muted">Could not load the catalog. Refresh to retry.</p>';
    });

  function uniq(list) { return list.filter(function (v, i) { return v && list.indexOf(v) === i; }); }

  function buildFilters(products) {
    var types = uniq(products.map(function (p) { return p.productType; }));
    var colors = uniq([].concat.apply([], products.map(function (p) { return p.colors.map(function (c) { return c.name; }); })));
    var drops = uniq(products.map(function (p) { return p.drop; }).filter(Boolean));

    filtersHost.innerHTML =
      selectHtml("type", "All products", types) +
      selectHtml("color", "All colors", colors) +
      (drops.length ? selectHtml("drop", "All drops", drops) : "") +
      '<select class="select" data-f="sort" aria-label="Sort">' +
        '<option value="newest">Newest</option>' +
        '<option value="price-asc">Price: low to high</option>' +
        '<option value="price-desc">Price: high to low</option>' +
      "</select>";

    filtersHost.querySelectorAll("[data-f]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        state[sel.getAttribute("data-f")] = sel.value;
        shown = 0;
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

    // reflect selects
    filtersHost.querySelectorAll("[data-f]").forEach(function (sel) { sel.value = state[sel.getAttribute("data-f")]; });

    shown = 0;
    grid.innerHTML = "";
    render();
  }

  function render() {
    var next = view.slice(shown, shown + PAGE);
    grid.insertAdjacentHTML("beforeend", next.map(NB.cardHtml).join("") || (shown === 0 ? '<p class="muted">Nothing matches those filters.</p>' : ""));
    shown += next.length;
    if (countEl) countEl.textContent = view.length + " item" + (view.length === 1 ? "" : "s");
    if (loadMoreBtn) loadMoreBtn.style.display = shown < view.length ? "" : "none";
  }

  if (loadMoreBtn) loadMoreBtn.addEventListener("click", render);

  // --- URL sync (shareable filtered views) ---
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

  // --- Mobile bottom-sheet ---
  var openBtn = document.querySelector("[data-open-filters]");
  var sheet = document.querySelector("[data-sheet]");
  var sheetBackdrop = document.querySelector("[data-sheet-backdrop]");
  var sheetBody = sheet && sheet.querySelector("[data-sheet-body]");
  var home = filtersHost.parentNode;

  function openSheet() {
    sheetBody.appendChild(filtersHost);
    sheetBackdrop.classList.add("open");
    sheet.classList.add("open");
  }
  function closeSheet() {
    sheet.classList.remove("open");
    sheetBackdrop.classList.remove("open");
    setTimeout(function () { home.insertBefore(filtersHost, home.firstChild); }, 240);
  }
  if (openBtn) openBtn.addEventListener("click", openSheet);
  if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeSheet);
  if (sheet) { var done = sheet.querySelector("[data-sheet-done]"); if (done) done.addEventListener("click", closeSheet); }
})();
