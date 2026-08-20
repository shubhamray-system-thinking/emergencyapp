// Emergency — Family tab.
// List family members, open a member's folder, upload/open/delete documents
// sorted into fixed categories. All storage goes through EmergencyDB; files
// are read/written only via documents.saveFile / documents.readFile so
// encryption can be added later without touching this file.

(function (global) {
  'use strict';

  var DB = global.EmergencyDB;
  var CATEGORIES = DB.documents.CATEGORIES;

  var root = document.getElementById('family-root');

  // Viewer overlay elements.
  var viewer = document.getElementById('viewer');
  var viewerTitle = document.getElementById('viewer-title');
  var viewerBody = document.getElementById('viewer-body');
  var viewerClose = document.getElementById('viewer-close');
  var openObjectUrl = null; // current blob URL, revoked on close

  var state = { memberId: null };

  // ---- tiny DOM helper ----
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'on') {
          Object.keys(props.on).forEach(function (ev) {
            node.addEventListener(ev, props.on[ev]);
          });
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

  function categoryLabel(key) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === key) return CATEGORIES[i].label;
    }
    return key;
  }

  // ---- render: root switches between member list and member folder ----
  function render() {
    if (state.memberId) renderMember(state.memberId);
    else renderList();
  }

  // ---- member list ----
  function renderList() {
    clear(root);

    var addBtn = el('button', {
      class: 'btn btn--primary', type: 'button', text: '+ Add family member',
      on: { click: showAddMemberForm }
    });

    root.appendChild(el('div', { class: 'toolbar' }, [addBtn]));

    var listWrap = el('div', { class: 'list', id: 'member-list' });
    root.appendChild(listWrap);

    DB.family.getAll().then(function (members) {
      members.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      clear(listWrap);

      if (!members.length) {
        listWrap.appendChild(el('p', {
          class: 'empty',
          text: 'No family members yet. Add one to start a folder for their documents.'
        }));
        return;
      }

      members.forEach(function (m) {
        var row = el('button', {
          class: 'list__row', type: 'button',
          on: { click: function () { openMember(m.id); } }
        }, [
          el('span', { class: 'list__avatar', text: initials(m.name) }),
          el('span', { class: 'list__main' }, [
            el('span', { class: 'list__title', text: m.name || 'Unnamed' })
          ]),
          el('span', { class: 'list__chev', text: '›' })
        ]);
        listWrap.appendChild(row);
      });
    });
  }

  function initials(name) {
    if (!name) return '?';
    var parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function showAddMemberForm() {
    var toolbar = root.querySelector('.toolbar');
    if (!toolbar || toolbar.querySelector('.inline-form')) return;

    var input = el('input', {
      class: 'input', type: 'text', placeholder: "Family member's name",
      maxLength: 60, autocomplete: 'off'
    });

    function save() {
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      DB.family.create({ name: name }).then(function (m) { openMember(m.id); });
    }

    var form = el('form', {
      class: 'inline-form',
      on: { submit: function (e) { e.preventDefault(); save(); } }
    }, [
      input,
      el('button', { class: 'btn btn--primary', type: 'submit', text: 'Save' }),
      el('button', {
        class: 'btn btn--ghost', type: 'button', text: 'Cancel',
        on: { click: renderList }
      })
    ]);

    clear(toolbar);
    toolbar.appendChild(form);
    input.focus();
  }

  // ---- member folder ----
  function openMember(id) { state.memberId = id; render(); }
  function backToList() { state.memberId = null; render(); }

  function renderMember(id) {
    clear(root);

    DB.family.get(id).then(function (member) {
      if (!member) { backToList(); return; }

      root.appendChild(el('div', { class: 'toolbar toolbar--member' }, [
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: '‹ Family',
          on: { click: backToList }
        }),
        el('button', {
          class: 'btn btn--danger-ghost', type: 'button', text: 'Delete',
          on: { click: function () { confirmDeleteMember(member); } }
        })
      ]));

      root.appendChild(el('h2', { class: 'member-name', text: member.name || 'Unnamed' }));

      var catsWrap = el('div', { class: 'cats' });
      root.appendChild(catsWrap);

      DB.documents.getByMember(id).then(function (docs) {
        CATEGORIES.forEach(function (cat) {
          catsWrap.appendChild(renderCategory(id, cat, docs.filter(function (d) {
            return d.category === cat.key;
          })));
        });
      });
    });
  }

  function renderCategory(memberId, cat, docs) {
    var fileInput = el('input', {
      class: 'visually-hidden', type: 'file',
      accept: 'application/pdf,image/*', multiple: true,
      on: {
        change: function () {
          var files = Array.prototype.slice.call(this.files);
          this.value = '';
          uploadFiles(memberId, cat.key, files);
        }
      }
    });

    var addBtn = el('button', {
      class: 'btn btn--small', type: 'button', text: '+ Add file',
      on: { click: function () { fileInput.click(); } }
    });

    var docList = el('div', { class: 'doc-list' });
    if (!docs.length) {
      docList.appendChild(el('p', { class: 'empty empty--small', text: 'No files yet.' }));
    } else {
      docs.sort(function (a, b) { return b.createdAt - a.createdAt; });
      docs.forEach(function (d) { docList.appendChild(renderDoc(memberId, d)); });
    }

    return el('section', { class: 'cat' }, [
      el('div', { class: 'cat__head' }, [
        el('h3', { class: 'cat__title', text: cat.label }),
        addBtn
      ]),
      fileInput,
      docList
    ]);
  }

  function renderDoc(memberId, doc) {
    var isImage = (doc.mime || '').indexOf('image/') === 0;
    return el('div', { class: 'doc' }, [
      el('button', {
        class: 'doc__open', type: 'button',
        on: { click: function () { openDocument(doc); } }
      }, [
        el('span', { class: 'doc__icon', text: isImage ? '🖼️' : '📄' }),
        el('span', { class: 'doc__name', text: doc.title || 'Untitled' })
      ]),
      el('button', {
        class: 'doc__del', type: 'button', 'aria-label': 'Delete document', text: '🗑',
        on: { click: function () { confirmDeleteDoc(memberId, doc); } }
      })
    ]);
  }

  function uploadFiles(memberId, category, files) {
    if (!files.length) return;
    var jobs = files.map(function (file) {
      return DB.documents.saveFile({
        memberId: memberId, category: category, title: file.name
      }, file);
    });
    Promise.all(jobs).then(function () { renderMember(memberId); }).catch(function (err) {
      console.error('upload failed', err);
      alert('Could not save the file: ' + err.message);
    });
  }

  function confirmDeleteDoc(memberId, doc) {
    if (!confirm('Delete "' + (doc.title || 'this document') + '"?')) return;
    DB.documents.remove(doc.id).then(function () { renderMember(memberId); });
  }

  function confirmDeleteMember(member) {
    if (!confirm('Delete ' + (member.name || 'this member') +
      ' and all their documents? This cannot be undone.')) return;
    DB.family.remove(member.id).then(backToList);
  }

  // ---- document viewer ----
  function openDocument(doc) {
    DB.documents.readFile(doc).then(function (blob) {
      if (openObjectUrl) URL.revokeObjectURL(openObjectUrl);
      openObjectUrl = URL.createObjectURL(blob);

      clear(viewerBody);
      viewerTitle.textContent = doc.title || 'Document';

      var isImage = (doc.mime || '').indexOf('image/') === 0;
      if (isImage) {
        viewerBody.appendChild(el('img', {
          class: 'viewer__img', src: openObjectUrl, alt: doc.title || 'Document'
        }));
      } else {
        // PDFs (and anything else) render in an iframe; works fully offline
        // since the URL points at a local blob.
        viewerBody.appendChild(el('iframe', {
          class: 'viewer__frame', src: openObjectUrl, title: doc.title || 'Document'
        }));
      }

      viewer.hidden = false;
      document.body.classList.add('viewer-open');
    }).catch(function (err) {
      console.error('open failed', err);
      alert('Could not open the file: ' + err.message);
    });
  }

  function closeViewer() {
    viewer.hidden = true;
    document.body.classList.remove('viewer-open');
    clear(viewerBody);
    if (openObjectUrl) { URL.revokeObjectURL(openObjectUrl); openObjectUrl = null; }
  }

  viewerClose.addEventListener('click', closeViewer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !viewer.hidden) closeViewer();
  });

  // Initial render.
  render();
})(window);
