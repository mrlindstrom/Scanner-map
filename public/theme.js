// theme.js - Theme selection for Scanner Map.
//
// Loaded in <head> (before styles paint) so the saved theme applies without a
// flash. Themes are defined in themes.css as [data-theme="..."] blocks of CSS
// variables plus per-theme component rules.
//
// The choice is saved per browser (localStorage). For visitors who haven't
// picked one, config.js `ui.defaultTheme` sets the site default.

(function () {
  const THEMES = [
    { id: 'original', name: 'Original (Green Terminal)' },
    { id: 'amber', name: 'Amber Terminal' },
    { id: 'win95', name: 'Windows 95' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'daylight', name: 'Daylight' },
  ];
  const STORAGE_KEY = 'scannerMap.theme';
  const FALLBACK = 'original';

  const isKnown = (id) => THEMES.some((t) => t.id === id);

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null; // storage blocked (private mode, etc.)
    }
  }

  // Site default from config.js. Pages without config.js (Settings) use the
  // copy the map page last remembered.
  const DEFAULT_KEY = 'scannerMap.themeDefault';
  function configDefault() {
    const id = window.appConfig && window.appConfig.ui && window.appConfig.ui.defaultTheme;
    if (isKnown(id)) {
      try { localStorage.setItem(DEFAULT_KEY, id); } catch (e) { /* ignore */ }
      return id;
    }
    return rememberedDefault() || FALLBACK;
  }
  function rememberedDefault() {
    try {
      const id = localStorage.getItem(DEFAULT_KEY);
      return isKnown(id) ? id : null;
    } catch (e) {
      return null;
    }
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') || FALLBACK;
  }

  function apply(id) {
    const theme = isKnown(id) ? id : FALLBACK;
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('select[data-theme-picker]').forEach((sel) => { sel.value = theme; });
    document.dispatchEvent(new CustomEvent('scannermap:themechange', { detail: { theme } }));
    return theme;
  }

  function set(id) {
    const theme = apply(id);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) { /* not persisted; still applied for this page */ }
  }

  /** Resolved value of a theme CSS variable (for canvas/JS consumers). */
  function color(varName, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || fallback || '#00ff00';
  }

  /** Fill any <select data-theme-picker> with the theme list and wire it up. */
  function bindPickers() {
    document.querySelectorAll('select[data-theme-picker]').forEach((sel) => {
      if (sel.dataset.themeBound) return;
      sel.dataset.themeBound = '1';
      sel.innerHTML = THEMES.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
      sel.value = current();
      sel.addEventListener('change', () => set(sel.value));
      // Keep clicks inside the picker from closing the menu it lives in
      sel.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  // 1. Before first paint: saved choice, else the remembered site default
  apply(readStored() || rememberedDefault() || FALLBACK);

  // 2. Once the page (and config.js) are loaded: site default for new visitors, pickers
  window.addEventListener('DOMContentLoaded', () => {
    if (!readStored()) apply(configDefault());
    bindPickers();
  });

  window.ScannerTheme = { THEMES, set, apply, current, color, bindPickers };
})();
