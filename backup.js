// Emergency — manual encrypted backup (export / import).
//
// The user taps Export → we gather ALL app data (family, documents, contacts,
// insurer, hospitals), decrypt the document files with the current session key,
// and re-encrypt the WHOLE bundle under a user-chosen backup password (PBKDF2 →
// AES-GCM). The result is one file the user saves themselves. Nothing is ever
// uploaded or synced — export only runs on tap.
//
// Import reverses it: decrypt the file with the password, then restore records
// (re-encrypting document files under THIS device's key). Because the bundle
// carries decrypted files sealed under the backup password, a backup is
// portable across devices and independent of the app PIN.

(function (global) {
  'use strict';

  var DB = global.EmergencyDB;
  var SEC = global.EmergencySecurity;
  var subtle = global.crypto.subtle;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  var FORMAT = 'emergency-backup';
  var VERSION = 1;
  var ITER = 250000;

  // ---- base64 <-> bytes (chunked to avoid call-stack limits) ----
  function bytesToB64(buf) {
    var bytes = new Uint8Array(buf), bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function randomBytes(n) { return global.crypto.getRandomValues(new Uint8Array(n)); }

  function deriveBackupKey(password, salt, iterations) {
    return subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  // ---- gather everything into a plain, portable payload ----
  function gatherPayload() {
    return Promise.all([
      DB.family.getAll(),
      DB.documents.getAll(),
      DB.contacts.getAll(),
      DB.insurer.getAll(),
      DB.hospitals.getAll()
    ]).then(function (r) {
      var members = r[0], docs = r[1], contacts = r[2], insurer = r[3], hospitals = r[4];

      // Decrypt each document file to plaintext (sealed later under the backup
      // password), keeping its metadata.
      return Promise.all(docs.map(function (d) {
        return DB.documents.readFile(d).then(function (blob) {
          return blob.arrayBuffer();
        }).then(function (ab) {
          return {
            id: d.id, memberId: d.memberId, category: d.category, title: d.title,
            mime: d.mime, size: d.size, createdAt: d.createdAt, updatedAt: d.updatedAt,
            data: bytesToB64(ab)
          };
        });
      })).then(function (docsOut) {
        return {
          familyMembers: members,
          documents: docsOut,
          contacts: contacts,
          insurer: insurer,
          hospitals: hospitals,
          counts: {
            familyMembers: members.length, documents: docsOut.length,
            contacts: contacts.length, insurer: insurer.length, hospitals: hospitals.length
          }
        };
      });
    });
  }

  // ---- export: gather -> encrypt -> return envelope text ----
  function exportEncrypted(password) {
    if (!SEC.isUnlocked()) return Promise.reject(new Error('locked'));
    var salt = randomBytes(16), iv = randomBytes(12);
    return gatherPayload().then(function (payload) {
      var counts = payload.counts;
      return deriveBackupKey(password, salt, ITER).then(function (key) {
        return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(payload)));
      }).then(function (cipher) {
        var envelope = {
          format: FORMAT, version: VERSION, createdAt: Date.now(),
          kdf: 'PBKDF2-SHA256', iterations: ITER,
          salt: bytesToB64(salt), iv: bytesToB64(iv), cipher: bytesToB64(cipher)
        };
        return { text: JSON.stringify(envelope), counts: counts };
      });
    });
  }

  // ---- import: parse -> decrypt -> restore ----
  function importEncrypted(fileText, password) {
    var envelope;
    try { envelope = JSON.parse(fileText); }
    catch (e) { return Promise.reject(new Error('not-a-backup')); }
    if (!envelope || envelope.format !== FORMAT) return Promise.reject(new Error('not-a-backup'));
    if (!SEC.isUnlocked()) return Promise.reject(new Error('locked'));

    var salt = b64ToBytes(envelope.salt), iv = b64ToBytes(envelope.iv);
    var cipher = b64ToBytes(envelope.cipher);

    return deriveBackupKey(password, salt, envelope.iterations || ITER).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, cipher)
        .catch(function () { throw new Error('wrong-password'); });
    }).then(function (plain) {
      var payload = JSON.parse(dec.decode(plain));
      return restorePayload(payload);
    });
  }

  function restorePayload(payload) {
    var jobs = [];
    (payload.familyMembers || []).forEach(function (m) { jobs.push(DB.putRaw('familyMembers', m)); });
    (payload.contacts || []).forEach(function (c) { jobs.push(DB.putRaw('contacts', c)); });
    (payload.insurer || []).forEach(function (i) { jobs.push(DB.putRaw('insurer', i)); });
    (payload.hospitals || []).forEach(function (h) { jobs.push(DB.putRaw('hospitals', h)); });

    (payload.documents || []).forEach(function (d) {
      var bytes = b64ToBytes(d.data);
      var blob = new Blob([bytes], { type: d.mime || 'application/octet-stream' });
      var meta = {
        id: d.id, memberId: d.memberId, category: d.category, title: d.title,
        mime: d.mime, size: d.size, createdAt: d.createdAt, updatedAt: d.updatedAt
      };
      jobs.push(DB.documents.restore(meta, blob));
    });

    return Promise.all(jobs).then(function () { return payload.counts || {}; });
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function dateStamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  global.EmergencyBackup = {
    exportEncrypted: exportEncrypted,
    importEncrypted: importEncrypted,
    downloadText: downloadText,
    dateStamp: dateStamp
  };

  // ===================== Settings sheet UI =====================

  var sheet = document.getElementById('settings');
  var body = document.getElementById('settings-body');
  var openBtn = document.getElementById('settings-open');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else if (k === 'on') Object.keys(props.on).forEach(function (ev) { node.addEventListener(ev, props.on[ev]); });
      else if (k in node) node[k] = props[k];
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function openSheet() { sheet.hidden = false; document.body.classList.add('viewer-open'); renderMenu(); }
  function closeSheet() { sheet.hidden = true; document.body.classList.remove('viewer-open'); }

  function header(title, onBack) {
    return el('div', { class: 'sheet__head' }, [
      onBack
        ? el('button', { class: 'btn btn--ghost', type: 'button', text: '‹ Back', on: { click: onBack } })
        : el('span'),
      el('h2', { class: 'sheet__title', text: title }),
      el('button', { class: 'sheet__close', type: 'button', 'aria-label': 'Close', text: '✕', on: { click: closeSheet } })
    ]);
  }

  function renderMenu() {
    clear(body);
    body.appendChild(header('Settings', null));
    body.appendChild(el('div', { class: 'sheet__card' }, [
      el('h3', { class: 'sheet__ch', text: 'Encrypted backup' }),
      el('p', { class: 'sheet__note',
        text: 'Save an encrypted copy of everything on this phone as one file. It is protected by a password you choose, and nothing is ever uploaded — it stays wherever you save it.' }),
      el('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Export encrypted backup',
        on: { click: renderExport } }),
      el('button', { class: 'btn btn--block', type: 'button', text: 'Import a backup…',
        on: { click: renderImport } })
    ]));
  }

  function renderExport() {
    clear(body);
    body.appendChild(header('Export backup', renderMenu));

    var p1 = el('input', { class: 'input', type: 'password', placeholder: 'Backup password', autocomplete: 'new-password' });
    var p2 = el('input', { class: 'input', type: 'password', placeholder: 'Confirm password', autocomplete: 'new-password' });
    var status = el('p', { class: 'sheet__status' });
    var btn = el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: 'Create backup file' });

    function submit(e) {
      e.preventDefault();
      status.className = 'sheet__status';
      var a = p1.value, b = p2.value;
      if (a.length < 6) { status.textContent = 'Use a password of at least 6 characters.'; return; }
      if (a !== b) { status.textContent = 'The two passwords don’t match.'; return; }
      btn.disabled = true; status.textContent = 'Encrypting…';
      exportEncrypted(a).then(function (out) {
        downloadText('emergency-backup-' + dateStamp() + '.json', out.text);
        btn.disabled = false;
        var c = out.counts;
        status.className = 'sheet__status sheet__status--ok';
        status.textContent = 'Backup saved to your downloads — ' +
          c.familyMembers + ' members, ' + c.documents + ' documents, ' +
          c.contacts + ' contacts, ' + c.insurer + ' policies, ' + c.hospitals + ' hospitals.';
      }).catch(function (err) {
        btn.disabled = false;
        status.textContent = 'Could not create the backup: ' + err.message;
      });
    }

    body.appendChild(el('form', { class: 'sheet__card', on: { submit: submit } }, [
      el('p', { class: 'sheet__note', text: 'Choose a password for this backup file. You will need it to restore — it is not recoverable.' }),
      p1, p2, status, btn
    ]));
    p1.focus();
  }

  function renderImport() {
    clear(body);
    body.appendChild(header('Import backup', renderMenu));

    var fileInput = el('input', { class: 'visually-hidden', type: 'file', accept: 'application/json,.json' });
    var pickBtn = el('button', { class: 'btn btn--block', type: 'button', text: 'Choose backup file…',
      on: { click: function () { fileInput.click(); } } });
    var fileName = el('p', { class: 'sheet__note', text: 'No file chosen.' });
    var pass = el('input', { class: 'input', type: 'password', placeholder: 'Backup password', autocomplete: 'off' });
    var status = el('p', { class: 'sheet__status' });
    var btn = el('button', { class: 'btn btn--primary btn--block', type: 'submit', text: 'Restore', disabled: true });

    var chosen = null;
    fileInput.addEventListener('change', function () {
      chosen = this.files[0] || null;
      fileName.textContent = chosen ? chosen.name : 'No file chosen.';
      btn.disabled = !chosen;
    });

    function submit(e) {
      e.preventDefault();
      status.className = 'sheet__status';
      if (!chosen) { status.textContent = 'Choose a backup file first.'; return; }
      if (!pass.value) { status.textContent = 'Enter the backup password.'; return; }
      btn.disabled = true; status.textContent = 'Restoring…';
      chosen.text().then(function (text) {
        return importEncrypted(text, pass.value);
      }).then(function (c) {
        status.className = 'sheet__status sheet__status--ok';
        status.textContent = 'Restored ' + (c.documents || 0) + ' documents and your contacts, policies and hospitals. Refreshing…';
        setTimeout(function () { global.location.reload(); }, 1200);
      }).catch(function (err) {
        btn.disabled = false;
        status.textContent = err.message === 'wrong-password' ? 'Wrong password for this file.'
          : err.message === 'not-a-backup' ? 'That file isn’t an Emergency backup.'
          : 'Could not restore: ' + err.message;
      });
    }

    body.appendChild(el('form', { class: 'sheet__card', on: { submit: submit } }, [
      el('p', { class: 'sheet__note', text: 'Pick a backup file and enter its password. Existing items with the same id are replaced.' }),
      fileInput, pickBtn, fileName, pass, status, btn
    ]));
  }

  if (openBtn) openBtn.addEventListener('click', openSheet);
  sheet.addEventListener('click', function (e) {
    if (e.target.hasAttribute('data-close')) closeSheet();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });
})(window);
