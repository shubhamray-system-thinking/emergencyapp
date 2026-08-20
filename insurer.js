// Emergency — Insurer tab.
// A user-entered REFERENCE CARD, not a live lookup. Each record is one policy:
// insurer name, policy number, helpline, and free-text cashless notes. Supports
// multiple policies. Tapping the helpline dials it. Stored in IndexedDB; offline.

(function (global) {
  'use strict';

  var DB = global.EmergencyDB;
  var root = document.getElementById('insurer-root');

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

  function telHref(phone) {
    var s = String(phone).trim();
    var plus = s.charAt(0) === '+' ? '+' : '';
    return 'tel:' + plus + s.replace(/[^\d]/g, '');
  }

  // ---- render ----
  function render() {
    DB.insurer.getAll().then(function (policies) {
      clear(root);

      policies.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

      root.appendChild(el('div', { class: 'toolbar toolbar--between' }, [
        el('p', { class: 'lede', text: 'Your policy reference cards. This is your own saved info — not a live lookup.' }),
        state.formOpen ? null : el('button', {
          class: 'btn btn--small', type: 'button', text: '+ Add policy',
          on: { click: openAddForm }
        })
      ]));

      if (state.formOpen && !state.editingId) root.appendChild(renderForm(null));

      if (!policies.length && !state.formOpen) {
        root.appendChild(el('p', { class: 'empty',
          text: 'No policies saved yet. Add your health-insurance details so they’re handy in an emergency.' }));
        return;
      }

      policies.forEach(function (p) {
        if (state.formOpen && state.editingId === p.id) root.appendChild(renderForm(p));
        else root.appendChild(renderCard(p));
      });
    });
  }

  function renderCard(p) {
    var fields = [];

    if (p.policyNumber) {
      fields.push(el('div', { class: 'field' }, [
        el('span', { class: 'field__label', text: 'Policy number' }),
        el('span', { class: 'field__value field__value--mono', text: p.policyNumber })
      ]));
    }

    if (p.helpline) {
      fields.push(el('div', { class: 'field' }, [
        el('span', { class: 'field__label', text: 'Helpline' }),
        el('a', {
          class: 'field__value field__link', href: telHref(p.helpline),
          'aria-label': 'Call helpline ' + p.helpline
        }, [
          el('span', { text: p.helpline }),
          el('span', { class: 'field__dial', 'aria-hidden': 'true', text: ' 📞' })
        ])
      ]));
    }

    if (p.cashlessNotes) {
      fields.push(el('div', { class: 'field field--notes' }, [
        el('span', { class: 'field__label', text: 'Cashless notes' }),
        el('div', { class: 'notes', text: p.cashlessNotes }) // pre-wrap preserves lines
      ]));
    }

    return el('section', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('h2', { class: 'card__title', text: p.insurerName || 'Untitled policy' }),
        el('div', { class: 'card__acts' }, [
          el('button', { class: 'contact__act', type: 'button', 'aria-label': 'Edit policy', text: '✎',
            on: { click: function () { openEditForm(p.id); } } }),
          el('button', { class: 'contact__act', type: 'button', 'aria-label': 'Delete policy', text: '🗑',
            on: { click: function () { confirmDelete(p); } } })
        ])
      ])
    ].concat(fields));
  }

  // ---- add / edit form ----
  function openAddForm() { state.formOpen = true; state.editingId = null; render(); }
  function openEditForm(id) { state.formOpen = true; state.editingId = id; render(); }
  function closeForm() { state.formOpen = false; state.editingId = null; render(); }

  function renderForm(editing) {
    var nameEl = el('input', { class: 'input', type: 'text', placeholder: 'Insurer name',
      value: editing ? editing.insurerName || '' : '', maxLength: 80, autocomplete: 'off' });
    var polEl = el('input', { class: 'input', type: 'text', placeholder: 'Policy number',
      value: editing ? editing.policyNumber || '' : '', maxLength: 60, autocomplete: 'off' });
    var helpEl = el('input', { class: 'input', type: 'tel', placeholder: 'Helpline number',
      value: editing ? editing.helpline || '' : '', maxLength: 24, autocomplete: 'off' });
    var notesEl = el('textarea', { class: 'input textarea', rows: 4,
      placeholder: 'Cashless notes — e.g. hospitals you’ve confirmed accept cashless, pre-auth steps, contact person',
      maxLength: 2000 });
    notesEl.value = editing ? editing.cashlessNotes || '' : '';
    var errEl = el('p', { class: 'form__err' });

    function save() {
      var name = nameEl.value.trim();
      if (!name) { errEl.textContent = 'Enter the insurer name.'; nameEl.focus(); return; }
      var data = {
        insurerName: name,
        policyNumber: polEl.value.trim(),
        helpline: helpEl.value.trim(),
        cashlessNotes: notesEl.value.trim()
      };
      var op = editing ? DB.insurer.update(editing.id, data) : DB.insurer.create(data);
      op.then(closeForm);
    }

    return el('form', { class: 'contact-form',
      on: { submit: function (e) { e.preventDefault(); save(); } } }, [
      el('label', { class: 'form__lbl', text: 'Insurer name' }), nameEl,
      el('label', { class: 'form__lbl', text: 'Policy number' }), polEl,
      el('label', { class: 'form__lbl', text: 'Helpline' }), helpEl,
      el('label', { class: 'form__lbl', text: 'Cashless notes' }), notesEl,
      errEl,
      el('div', { class: 'form__actions' }, [
        el('button', { class: 'btn btn--primary', type: 'submit', text: editing ? 'Save' : 'Add policy' }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', on: { click: closeForm } })
      ])
    ]);
  }

  function confirmDelete(p) {
    if (!confirm('Delete the ' + (p.insurerName || 'this') + ' policy?')) return;
    DB.insurer.remove(p.id).then(render);
  }

  // Initial render.
  render();

  global.addEventListener('emergency:tab', function (e) {
    if (e.detail === 'insurer') render();
  });
})(window);
