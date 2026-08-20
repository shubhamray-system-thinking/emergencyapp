// Emergency — Hospitals tab.
// A user-curated list, NOT a live "nearest hospital" search. Each entry has a
// name, a short label (e.g. "nearest to home"), and a Google Maps link that
// the user pastes OR that we build from an address they type. Tapping opens
// the link in Google Maps. The list + links are stored in IndexedDB and cached
// offline; opening the map itself needs network, which is expected.

(function (global) {
  'use strict';

  var DB = global.EmergencyDB;
  var root = document.getElementById('hospitals-root');

  var state = { formOpen: false, editingId: null };

  // ---- tiny DOM helper ----
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'on') {
          Object.keys(props.on).forEach(function (ev) { node.addEventListener(ev, props.on[ev]); });
        } else if (k in node) node[k] = props[k];
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Add a scheme if the user pasted a bare link (e.g. "maps.app.goo.gl/...").
  function normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  function isValidUrl(u) {
    try { var p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; }
    catch (e) { return false; }
  }

  // Official Google Maps URL scheme — opens the app on mobile, web otherwise.
  function mapsUrlFromAddress(addr) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr);
  }

  // ---- render ----
  function render() {
    DB.hospitals.getAll().then(function (list) {
      clear(root);

      list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

      root.appendChild(el('div', { class: 'toolbar toolbar--between' }, [
        el('p', { class: 'lede', text: 'Hospitals you’ve saved. Tap one to open it in Google Maps. This is your own list — not a live search.' }),
        state.formOpen ? null : el('button', {
          class: 'btn btn--small', type: 'button', text: '+ Add hospital',
          on: { click: openAddForm }
        })
      ]));

      if (state.formOpen && !state.editingId) root.appendChild(renderForm(null));

      if (!list.length && !state.formOpen) {
        root.appendChild(el('p', { class: 'empty',
          text: 'No hospitals saved yet. Add the ones you’d head to — paste a Google Maps link or type an address.' }));
        return;
      }

      list.forEach(function (h) {
        if (state.formOpen && state.editingId === h.id) root.appendChild(renderForm(h));
        else root.appendChild(renderRow(h));
      });
    });
  }

  function renderRow(h) {
    var open = el('a', {
      class: 'contact__dial', href: h.mapsUrl, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': 'Open ' + h.name + ' in Google Maps'
    }, [
      el('span', { class: 'contact__icon', 'aria-hidden': 'true', text: '🏥' }),
      el('span', { class: 'contact__main' }, [
        el('span', { class: 'contact__name', text: h.name || 'Unnamed hospital' }),
        el('span', { class: 'contact__role', text: h.label || h.address || 'Open in Maps' })
      ]),
      el('span', { class: 'contact__call', 'aria-hidden': 'true', text: '🗺️' })
    ]);

    return el('div', { class: 'contact' }, [
      open,
      el('button', { class: 'contact__act', type: 'button', 'aria-label': 'Edit ' + h.name, text: '✎',
        on: { click: function () { openEditForm(h.id); } } }),
      el('button', { class: 'contact__act', type: 'button', 'aria-label': 'Delete ' + h.name, text: '🗑',
        on: { click: function () { confirmDelete(h); } } })
    ]);
  }

  // ---- add / edit form ----
  function openAddForm() { state.formOpen = true; state.editingId = null; render(); }
  function openEditForm(id) { state.formOpen = true; state.editingId = id; render(); }
  function closeForm() { state.formOpen = false; state.editingId = null; render(); }

  function renderForm(editing) {
    var nameEl = el('input', { class: 'input', type: 'text', placeholder: 'Hospital name',
      value: editing ? editing.name || '' : '', maxLength: 80, autocomplete: 'off' });
    var labelEl = el('input', { class: 'input', type: 'text', placeholder: 'Short label (e.g. nearest to home)',
      value: editing ? editing.label || '' : '', maxLength: 40, autocomplete: 'off' });
    // type="text" (not "url") so bare pastes like "maps.app.goo.gl/…" aren't
    // rejected by native validation before normalizeUrl() adds the scheme.
    var linkEl = el('input', { class: 'input', type: 'text', inputmode: 'url',
      placeholder: 'Paste Google Maps link', autocomplete: 'off', spellcheck: false });
    var addrEl = el('input', { class: 'input', type: 'text', placeholder: 'Address', autocomplete: 'off' });
    var errEl = el('p', { class: 'form__err' });

    // Prefill link/address depending on how the saved URL was created, so
    // editing the address actually rebuilds the link.
    if (editing) {
      if (editing.source === 'address') { addrEl.value = editing.address || ''; }
      else { linkEl.value = editing.mapsUrl || ''; addrEl.value = editing.address || ''; }
    }

    function save() {
      var name = nameEl.value.trim();
      if (!name) { errEl.textContent = 'Enter the hospital name.'; nameEl.focus(); return; }

      var link = normalizeUrl(linkEl.value);
      var addr = addrEl.value.trim();
      var url, source, address;

      if (link) {
        if (!isValidUrl(link)) { errEl.textContent = 'That doesn’t look like a valid link.'; linkEl.focus(); return; }
        url = link; source = 'link'; address = addr;
      } else if (addr) {
        url = mapsUrlFromAddress(addr); source = 'address'; address = addr;
      } else {
        errEl.textContent = 'Paste a Google Maps link or enter an address.'; linkEl.focus(); return;
      }

      var data = { name: name, label: labelEl.value.trim(), mapsUrl: url, source: source, address: address };
      var op = editing ? DB.hospitals.update(editing.id, data) : DB.hospitals.create(data);
      op.then(closeForm);
    }

    return el('form', { class: 'contact-form',
      on: { submit: function (e) { e.preventDefault(); save(); } } }, [
      el('label', { class: 'form__lbl', text: 'Name' }), nameEl,
      el('label', { class: 'form__lbl', text: 'Label' }), labelEl,
      el('label', { class: 'form__lbl', text: 'Google Maps link' }), linkEl,
      el('p', { class: 'form__hint', text: 'In Google Maps: find the place → Share → Copy link, then paste it here.' }),
      el('label', { class: 'form__lbl', text: '…or address' }), addrEl,
      el('p', { class: 'form__hint', text: 'No link? Type an address and we’ll build the Maps link for you.' }),
      errEl,
      el('div', { class: 'form__actions' }, [
        el('button', { class: 'btn btn--primary', type: 'submit', text: editing ? 'Save' : 'Add hospital' }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', on: { click: closeForm } })
      ])
    ]);
  }

  function confirmDelete(h) {
    if (!confirm('Delete ' + (h.name || 'this hospital') + '?')) return;
    DB.hospitals.remove(h.id).then(render);
  }

  // Initial render.
  render();

  global.addEventListener('emergency:tab', function (e) {
    if (e.detail === 'hospitals') render();
  });
})(window);
