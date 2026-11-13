/* ==========================================================================
   ALHAMDULILLAHI ACADEMY — "HERITAGE 2027" THEME CONTROLLER
   --------------------------------------------------------------------------
   · Follows the operating system theme by default (prefers-color-scheme)
   · Remembers an explicit user choice in localStorage ("aa-theme")
   · Drives the template's existing #light-style / #dark-style sheets
   · Injects the animated switch into the topbar (or a floating switch on
     pages that have no topbar, such as receipts and print views)
   · Adds the "Powered by QuDex Technologies" footer credit when missing
   · Never touches application data, routes or server code.
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'aa-theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var currentTheme = 'light';

  function readPreference() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function systemTheme() {
    return media && media.matches ? 'dark' : 'light';
  }

  function resolvedTheme() {
    return readPreference() || systemTheme();
  }

  function setStyleSheets(theme) {
    var light = document.getElementById('light-style');
    var dark = document.getElementById('dark-style');
    if (!dark) {
      /* Pages that never shipped a dark sheet stay on the light base; the
         academy theme paints dark mode on its own. */
      if (light) light.disabled = false;
      return;
    }
    if (theme === 'dark') {
      if (light) light.disabled = true;
      dark.disabled = false;
    } else {
      if (light) light.disabled = false;
      dark.disabled = true;
    }
  }

  function syncLayoutConfig(theme) {
    var body = document.body;
    if (!body) return;
    var raw = body.getAttribute('data-layout-config');
    if (!raw) return;
    try {
      var config = JSON.parse(raw);
      config.darkMode = theme === 'dark';
      body.setAttribute('data-layout-config', JSON.stringify(config));
    } catch (err) {
      /* A malformed config must never break the page. */
    }
  }

  /* Inline SVGs keep the switch readable even on pages that do not load an
     icon font (receipts, print views, standalone reports). */
  var ICON_SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var ICON_MOON =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function syncToggles(theme) {
    var buttons = document.querySelectorAll('.aa-theme-toggle');
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      btn.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
      var label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label + ' — Shift+click to follow your system');
      var knob = btn.querySelector('.aa-theme-toggle__knob');
      if (knob) knob.innerHTML = theme === 'dark' ? ICON_MOON : ICON_SUN;
    }
  }

  function applyTheme(theme, animate) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', currentTheme);
    root.style.colorScheme = currentTheme;
    setStyleSheets(currentTheme);
    syncLayoutConfig(currentTheme);
    syncToggles(currentTheme);

    if (animate) {
      root.classList.add('aa-theme-transition');
      window.setTimeout(function () {
        root.classList.remove('aa-theme-transition');
      }, 480);
    }
  }

  function commitTheme(theme, animate) {
    if (!animate || !document.startViewTransition || (reduceMotion && reduceMotion.matches)) {
      applyTheme(theme, animate);
      return;
    }
    try {
      document.startViewTransition(function () {
        applyTheme(theme, false);
      });
    } catch (err) {
      applyTheme(theme, true);
    }
  }

  function toggleTheme() {
    var next = currentTheme === 'dark' ? 'light' : 'dark';
    try {
      /* Persist the explicit choice before the (possibly asynchronous)
         view-transition callback runs, so a reload keeps the chosen mode. */
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch (err) {
      /* private mode - the switch still works for this page */
    }
    commitTheme(next, true);
  }

  function followSystem() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* ignore */
    }
    commitTheme(systemTheme(), true);
    showToast('Theme now follows your system setting');
  }

  /* ---------------- topbar / floating switch ---------------- */
  function buildToggle() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aa-theme-toggle';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', 'false');
    btn.setAttribute('aria-label', 'Switch to dark mode');
    btn.innerHTML =
      '<span class="aa-theme-toggle__track" aria-hidden="true">' +
      '<span class="aa-icon-sun">' + ICON_SUN + '</span>' +
      '<span class="aa-icon-moon">' + ICON_MOON + '</span>' +
      '</span>' +
      '<span class="aa-theme-toggle__knob" aria-hidden="true">' + ICON_SUN + '</span>';

    btn.addEventListener('click', function (event) {
      if (event.shiftKey) {
        followSystem();
      } else {
        toggleTheme();
      }
    });
    return btn;
  }

  function mountToggle() {
    if (document.querySelector('.aa-theme-toggle')) return;

    var topbar = document.querySelector('.navbar-custom .topbar-menu');
    if (topbar) {
      var li = document.createElement('li');
      li.className = 'aa-theme-toggle-item';
      li.appendChild(buildToggle());
      topbar.insertBefore(li, topbar.firstChild);
      return;
    }

    /* Auth pages: keep it floating above the artwork */
    var toggle = buildToggle();
    toggle.classList.add('aa-theme-toggle--auth');
    document.body.appendChild(toggle);
  }

  /* ---------------- tiny toast ---------------- */
  var toastTimer = null;
  function showToast(message) {
    var toast = document.querySelector('.aa-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'aa-toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.innerHTML = '<span class="aa-toast__dot" aria-hidden="true"></span><span></span>';
    toast.querySelector('span').textContent = message;
    window.requestAnimationFrame(function () {
      toast.classList.add('is-visible');
    });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 2400);
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

  /* ---------------- bootstrap ---------------- */
  applyTheme(resolvedTheme(), false);

  document.addEventListener('DOMContentLoaded', function () {
    /* Set the layout config before the template's own app.min.js reads it,
       so it does not fight the choice we already applied. */
    syncLayoutConfig(currentTheme);
    setStyleSheets(currentTheme);
    mountToggle();
    syncToggles(currentTheme);
    addCredit();
  });

  window.addEventListener('load', function () {
    /* app.min.js applies its layout config on ready; reassert afterwards. */
    applyTheme(currentTheme, false);
    mountToggle();
    addCredit();
  });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted) applyTheme(resolvedTheme(), false);
  });

  if (media) {
    var onSystemChange = function () {
      if (!readPreference()) applyTheme(systemTheme(), true);
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }
})();
