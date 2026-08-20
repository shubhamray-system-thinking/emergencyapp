// Emergency — Contacts tab.
// India emergency numbers are pre-seeded and non-deletable (they must always
// be reachable). The user adds their own contacts (name, role, number). Every
// contact dials via a tel: link. All data lives in IndexedDB; works offline.

(function (global) {
  'use strict';

  var DB = global.EmergencyDB;
  var root = document.getElementById('contacts-root');

  // India defaults from CLAUDE.md. Fixed ids so we seed exactly once and never
  // duplicate. `pinned` ones show in the red emergency block at the very top.
  var BUILTINS = [
    { id: 'builtin-108', name: 'Ambulance', role: 'Government ambulance',
      phone: '108', category: 'ambulance', pinned: true, order: 0, builtin: true },
    { id: 'builtin-112', name: 'Emergency', role: 'Police · Fire · Ambulance · works without SIM',
      phone: '112', category: 'unified', pinned: true, order: 1, builtin: true },
    { id: 'builtin-1091', name: 'Women in distress', role: 'National helpline',
      phone: '1091', category: 'helpline', pinned: false, order: 2, builtin: true },
    { id: 'builtin-1098', name: 'Child helpline', role: 'CHILDLINE',
      phone: '1098', category: 'helpline', pinned: false, order: 3, builtin: true }
  ];

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

  // Strip a phone number down to a dial-safe string (leading + then digits).
  function telHref(phone) {
    var s = String(phone).trim();
    var plus = s.charAt(0) === '+' ? '+' : '';
    return 'tel:' + plus + s.replace(/[^\d]/g, '');
  }

  // Ensure the India defaults exist (create only if missing — self-healing,
  // and since builtins aren't deletable in the UI they persist).
  function ensureBuiltins() {
    return Promise.all(BUILTINS.map(function (b) {
      return DB.contacts.get(b.id).then(function (existing) {
        if (existing) return existing;
        return DB.contacts.create(b);
      });
    }));
  }

  // ---- render ----
  function render() {
    ensureBuiltins().then(function () {
      return DB.contacts.getAll();
    }).then(function (all) {
      clear(root);

      var pinned = all.filter(function (c) { return c.builtin && c.pinned; });
      var helplines = all.filter(function (c) { return c.builtin && !c.pinned; });
      var mine = all.filter(function (c) { return !c.builtin; });

      pinned.sort(byOrder);
      helplines.sort(byOrder);
      mine.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

      // Emergency block (red, pinned).
      root.appendChild(section('Emergency', pinned.map(function (c) {
        return contactRow(c, true);
      })));

      // Helplines block.
      if (helplines.length) {
        root.appendChild(section('Helplines', helplines.map(function (c) {
          return contactRow(c, false);
        })));
      }

      // My contacts + add/edit form.
      var myChildren = [];
      myChildren.push(el('div', { class: 'sec__head' }, [
        el('h2', { class: 'sec__title', text: 'My contacts' }),
        state.formOpen ? null : el('button', {
          class: 'btn btn--small', type: 'button', text: '+ Add',
          on: { click: openAddForm }
        })
      ]));

      if (state.formOpen) myChildren.push(renderForm(all));

      if (mine.length) {
        mine.forEach(function (c) { myChildren.push(contactRow(c, false)); });
      } else if (!state.formOpen) {
        myChildren.push(el('p', { class: 'empty empty--small',
          text: 'Add your family doctor, family members, and anyone else you may need.' }));
      }

      root.appendChild(el('section', { class: 'sec' }, myChildren));
    });
  }

  function byOrder(a, b) { return (a.order || 0) - (b.order || 0); }

  function section(title, rows) {
    return el('section', { class: 'sec' }, [
      el('div', { class: 'sec__head' }, [el('h2', { class: 'sec__title', text: title })])
    ].concat(rows));
  }

  function contactRow(c, emergency) {
    var dial = el('a', {
      class: 'contact__dial', href: telHref(c.phone),
      'aria-label': 'Call ' + c.name + ' on ' + c.phone
    }, [
      el('span', { class: 'contact__icon', 'aria-hidden': 'true', text: iconFor(c) }),
      el('span', { class: 'contact__main' }, [
        el('span', { class: 'contact__name', text: c.name || 'Unnamed' }),
        el('span', { class: 'contact__role', text: [c.role, c.phone].filter(Boolean).join(' · ') })
      ]),
      el('span', { class: 'contact__call', 'aria-hidden': 'true', text: '📞' })
    ]);

    var kids = [dial];
    if (!c.builtin) {
      kids.push(el('button', {
        class: 'contact__act', type: 'button', 'aria-label': 'Edit ' + c.name, text: '✎',
        on: { click: function () { openEditForm(c.id); } }
      }));
      kids.push(el('button', {
        class: 'contact__act', type: 'button', 'aria-label': 'Delete ' + c.name, text: '🗑',
        on: { click: function () { confirmDelete(c); } }
      }));
    }

    return el('div', {
      class: 'contact' + (emergency ? ' contact--emergency' : '')
    }, kids);
  }

  function iconFor(c) {
    if (c.category === 'ambulance') return '🚑';
    if (c.category === 'unified') return '🆘';
    if (c.category === 'helpline') return '☎️';
    if (c.category === 'doctor') return '🩺';
    if (c.category === 'family') return '👤';
    return '📇';
  }

  // ---- add / edit form ----
  function openAddForm() { state.formOpen = true; state.editingId = null; render(); }
  function openEditForm(id) { state.formOpen = true; state.editingId = id; render(); }
  function closeForm() { state.formOpen = false; state.editingId = null; render(); }

  function renderForm(all) {
    var editing = state.editingId
      ? all.filter(function (c) { return c.id === state.editingId; })[0]
      : null;

    var nameEl = el('input', { class: 'input', type: 'text', placeholder: 'Name',
      value: editing ? editing.name || '' : '', maxLength: 60, autocomplete: 'off' });
    var roleEl = el('input', { class: 'input', type: 'text',
      placeholder: 'Role (e.g. Family doctor, Mother)',
      value: editing ? editing.role || '' : '', maxLength: 60, autocomplete: 'off' });
    var phoneEl = el('input', { class: 'input', type: 'tel', placeholder: 'Phone number',
      value: editing ? editing.phone || '' : '', maxLength: 24, autocomplete: 'off' });
    var errEl = el('p', { class: 'form__err' });

    function save() {
      var name = nameEl.value.trim();
      var role = roleEl.value.trim();
      var phone = phoneEl.value.trim();
      if (!name) { errEl.textContent = 'Enter a name.'; nameEl.focus(); return; }
      if (!/\d/.test(phone)) { errEl.textContent = 'Enter a phone number.'; phoneEl.focus(); return; }

      var data = { name: name, role: role, phone: phone,
        category: guessCategory(role), builtin: false };
      var op = editing
        ? DB.contacts.update(editing.id, data)
        : DB.contacts.create(data);
      op.then(closeForm);
    }

    return el('form', { class: 'contact-form',
      on: { submit: function (e) { e.preventDefault(); save(); } } }, [
      nameEl, roleEl, phoneEl, errEl,
      el('div', { class: 'form__actions' }, [
        el('button', { class: 'btn btn--primary', type: 'submit',
          text: editing ? 'Save' : 'Add contact' }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel',
          on: { click: closeForm } })
      ])
    ]);
  }

  function guessCategory(role) {
    var r = (role || '').toLowerCase();
    if (/doctor|dr\.|physician|clinic|hospital/.test(r)) return 'doctor';
    if (/mother|father|amma|appa|wife|husband|son|daughter|brother|sister|family|spouse|parent/.test(r)) return 'family';
    return 'other';
  }

  function confirmDelete(c) {
    if (!confirm('Delete ' + (c.name || 'this contact') + '?')) return;
    DB.contacts.remove(c.id).then(render);
  }

  // Initial render.
  render();

  // Re-render when returning to this tab (in case data changed elsewhere).
  global.addEventListener('emergency:tab', function (e) {
    if (e.detail === 'contacts') render();
  });
})(window);
