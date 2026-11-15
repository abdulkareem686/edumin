/* ==========================================================================
   ALHAMDULILLAHI ACADEMY - "HERITAGE 2027" THEME CONTROLLER (LIGHT ONLY)
   --------------------------------------------------------------------------
   The application is intentionally light mode only:
   - forces the light stylesheet and disables the dark one
   - keeps body[data-layout-config].darkMode at false
   - never creates a theme switch
   - hides the template's colour-scheme drawer (its Dark Mode switch)
   - adds the "Powered by QuDex Technologies" footer credit when missing
   - removes duplicate DataTables search / pager controls
   Front-end only; no application data or server code is touched.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;

  function forceLight() {
    root.setAttribute('data-theme', 'light');
    root.setAttribute('data-bs-theme', 'light');
    root.style.colorScheme = 'light';

    var light = document.getElementById('light-style');
    var dark = document.getElementById('dark-style');
    if (light) light.disabled = false;
    if (dark) dark.disabled = true;

    var body = document.body;
    if (!body) return;
    var raw = body.getAttribute('data-layout-config');
    if (!raw) return;
    try {
      var config = JSON.parse(raw);
      config.darkMode = false;
      body.setAttribute('data-layout-config', JSON.stringify(config));
    } catch (err) {
      /* a malformed config must never break the page */
    }

    /* The template opens its customiser once per session; keep it closed. */
    body.classList.remove('end-bar-enabled');
    try {
      window.sessionStorage.setItem('_HYPER_VISITED_', '1');
      /* remove any preference stored by the previous dual-mode build */
      window.localStorage.removeItem('aa-theme');
    } catch (err) {
      /* private mode */
    }
  }

  /* ---------------- footer credit ---------------- */
  function addCredit() {
    var footers = document.querySelectorAll('.footer, footer');
    for (var i = 0; i < footers.length; i += 1) {
      var footer = footers[i];
      if (!footer || footer.closest('.auth-fluid-right')) continue;
      if (/qudex/i.test(footer.textContent || '')) continue;
      if (footer.querySelector('.aa-credit')) continue;
      if (!(footer.textContent || '').trim()) {
        footer.innerHTML = '&copy; ' + new Date().getFullYear() + ' Alhamdulillahi Academy';
      }
      var credit = document.createElement('span');
      credit.className = 'aa-credit';
      credit.innerHTML = 'Powered by <strong>QuDex Technologies</strong>';
      footer.appendChild(credit);
    }
  }

  /* ---------------- table configuration ---------------- */
  /* Builds the reference-style footer (Previous / Next, page size, page
     number) around the existing DataTables instance. This runs after init,
     so it works no matter where the page starts its table. */
  function setupTableFooter(wrapper) {
    if (wrapper.getAttribute('data-aa-footer') === '1') return;
    var table = wrapper.querySelector('table.dataTable');
    var jq = window.jQuery;
    if (!table || !jq || !jq.fn || !jq.fn.dataTable) return;

    var api;
    try {
      api = jq(table).DataTable();
    } catch (err) {
      return;
    }
    if (!api) return;

    var footer = document.createElement('div');
    footer.className = 'dt-footer';
    footer.innerHTML =
      '<div class="dt-pager">' +
      '<button type="button" class="dt-page-btn" data-dir="prev">Previous</button>' +
      '<button type="button" class="dt-page-btn" data-dir="next">Next</button>' +
      '</div>' +
      '<div class="dt-meta">' +
      '<label class="dt-length">Show <select class="dt-page-size">' +
      '<option value="10">10</option><option value="25">25</option><option value="50">50</option>' +
      '</select> per page</label>' +
      '<span class="dt-page-info"></span>' +
      '</div>';
    /* Place the footer under the table container, not inside its scroll box. */
    var scrollBox = wrapper.closest('.table-responsive');
    var mount = (scrollBox && scrollBox.parentElement) ? scrollBox.parentElement : wrapper.parentElement;
    mount.appendChild(footer);
    wrapper.setAttribute('data-aa-footer', '1');

    /* hide the native controls and the rows that contained them (never the
       row that holds the table itself) */
    var native = wrapper.querySelectorAll('.dataTables_length, .dataTables_info, .dataTables_paginate');
    for (var n = 0; n < native.length; n += 1) native[n].style.display = 'none';
    var rows = wrapper.querySelectorAll(':scope > .row');
    for (var r = 0; r < rows.length; r += 1) {
      if (rows[r].querySelector('.dataTables_length, .dataTables_filter, .dataTables_info, .dataTables_paginate')) {
        rows[r].style.display = 'none';
      }
    }

    var prev = footer.querySelector('[data-dir="prev"]');
    var next = footer.querySelector('[data-dir="next"]');
    var size = footer.querySelector('.dt-page-size');
    var info = footer.querySelector('.dt-page-info');
    size.value = String(api.page.len());

    function sync() {
      var p = api.page.info();
      info.textContent = 'Page ' + (p.pages ? p.page + 1 : 0) + ' of ' + p.pages;
      prev.disabled = p.page <= 0;
      next.disabled = p.page >= p.pages - 1;
    }

    prev.addEventListener('click', function () { api.page('previous').draw(false); });
    next.addEventListener('click', function () { api.page('next').draw(false); });
    size.addEventListener('change', function () { api.page.len(Number(size.value)).draw(); });
    api.on('draw', sync);
    sync();
  }

  /* ---------------- table cleanup ---------------- */
  function tidyTables() {
    var wrappers = document.querySelectorAll('.dataTables_wrapper');
    for (var i = 0; i < wrappers.length; i += 1) {
      var wrapper = wrappers[i];
      var card = wrapper.closest('.card') || wrapper.parentElement;
      if (!card) continue;

      /* The page already has its own search form above the grid. */
      var customSearch = card.querySelector(
        'form input[type="search"], form input[name="q"], form#studentSearchForm, form#teacherSearchForm'
      );
      if (customSearch) {
        var filter = wrapper.querySelector('.dataTables_filter');
        if (filter) {
          var top = filter.closest('.dt-top');
          if (top) top.style.display = 'none';
          filter.style.display = 'none';
        }
      }

      /* A one-page server pager duplicates DataTables' own count. Keep it
         only when it really paginates (more than one page). */
      var blocks = card.querySelectorAll('div');
      for (var j = 0; j < blocks.length; j += 1) {
        var block = blocks[j];
        if (block.closest('.dataTables_wrapper')) continue;
        var match = /^\s*Showing page\s+(\d+)\s+of\s+(\d+)/i.exec(block.textContent || '');
        if (match && Number(match[2]) <= 1) {
          /* Bootstrap's .d-flex uses display:flex!important */
          block.style.setProperty('display', 'none', 'important');
        }
      }

      setupTableFooter(wrapper);
    }
  }

  /* ---------------- bootstrap ---------------- */
  forceLight();

  document.addEventListener('DOMContentLoaded', function () {
    forceLight();
    addCredit();
    tidyTables();
  });

  window.addEventListener('load', function () {
    forceLight();
    addCredit();
    tidyTables();
    window.setTimeout(tidyTables, 600);
  });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted) forceLight();
  });
})();
