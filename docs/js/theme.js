/* Tema chiaro/scuro: segue il dispositivo finché l'utente non sceglie con il pulsante (scelta salvata).
 * Caricato nell'<head> senza "defer", così la pagina non lampeggia col tema sbagliato. */
(function () {
  'use strict';
  var KEY = 'theme';
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() { return saved() || (dark && dark.matches ? 'dark' : 'light'); }

  function apply() {
    var s = saved();
    if (s) document.documentElement.setAttribute('data-theme', s);
    else document.documentElement.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', current() === 'dark' ? '#141014' : '#8c1d2f');
  }

  apply();
  if (dark && dark.addEventListener) dark.addEventListener('change', function () { apply(); if (window.Theme.onChange) window.Theme.onChange(); });
  document.addEventListener('DOMContentLoaded', apply);

  window.Theme = {
    current: current,
    toggle: function () {
      try { localStorage.setItem(KEY, current() === 'dark' ? 'light' : 'dark'); } catch (e) { /* ignora */ }
      apply();
      return current();
    },
    onChange: null,
  };
})();
