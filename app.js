// Emergency — app shell logic.
// For now: tab switching only. No storage, no data. Placeholders per tab.

(function () {
  'use strict';

  var TITLES = {
    family: 'Family',
    contacts: 'Contacts',
    insurer: 'Insurer',
    hospitals: 'Hospitals'
  };

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var views = Array.prototype.slice.call(document.querySelectorAll('.view'));
  var titleEl = document.getElementById('view-title');

  function showTab(name) {
    if (!TITLES[name]) return;

    tabs.forEach(function (tab) {
      var active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    views.forEach(function (view) {
      var active = view.dataset.view === name;
      view.hidden = !active;
      view.setAttribute('aria-hidden', active ? 'false' : 'true');
    });

    titleEl.textContent = TITLES[name];

    // Let tab modules refresh their data when re-entered.
    window.dispatchEvent(new CustomEvent('emergency:tab', { detail: name }));
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      showTab(tab.dataset.tab);
    });
  });

  // Register the service worker for offline support.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker registration failed:', err);
      });
    });
  }
})();
