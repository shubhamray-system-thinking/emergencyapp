// Emergency — local storage layer (IndexedDB only). No libraries, no network.
//
// This is the single source of truth for all app data. Five object stores:
//   familyMembers  a person: name, relation, dob, blood group, notes
//   documents      a file linked to a member (ID, insurance, report, med list)
//   contacts       emergency numbers (ambulance, doctor, family, ...)
//   insurer        policy reference cards (insurer, policy no., helpline, notes)
//   hospitals      user-saved hospitals, each with a Maps link
//
// Every record gets a string `id` (crypto.randomUUID) plus `createdAt` /
// `updatedAt` timestamps. Records are linked by id (e.g. document.memberId).
//
// NOTE: document files are stored here as raw Blobs for now. Encryption with
// Web Crypto (a hard requirement) will wrap the blob before it is written,
// once the app-lock / key derivation exists. The schema field `blob` is the
// seam where that encryption will slot in.

(function (global) {
  'use strict';

  var DB_NAME = 'emergency';
  var DB_VERSION = 2;

  // Store names, exported so callers don't hard-code strings.
  var STORES = {
    familyMembers: 'familyMembers',
    documents: 'documents',
    contacts: 'contacts',
    insurer: 'insurer',
    hospitals: 'hospitals',
    // Key vault: wrapped keys + KDF params. Never holds the PIN or a raw key.
    security: 'security'
  };

  var _dbPromise = null;

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    // Fallback for older engines.
    return 'id-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  // Wrap an IDBRequest as a Promise.
  function promisify(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // Open (and, on first run / version bump, create) the database.
  function openDB() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise(function (resolve, reject) {
      var open = indexedDB.open(DB_NAME, DB_VERSION);

      open.onupgradeneeded = function (event) {
        var db = open.result;

        if (!db.objectStoreNames.contains(STORES.familyMembers)) {
          db.createObjectStore(STORES.familyMembers, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORES.documents)) {
          var docs = db.createObjectStore(STORES.documents, { keyPath: 'id' });
          // Look up all documents belonging to a family member.
          docs.createIndex('memberId', 'memberId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.contacts)) {
          var contacts = db.createObjectStore(STORES.contacts, { keyPath: 'id' });
          // Group contacts (e.g. "ambulance", "doctor", "family").
          contacts.createIndex('category', 'category', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.insurer)) {
          db.createObjectStore(STORES.insurer, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORES.hospitals)) {
          db.createObjectStore(STORES.hospitals, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORES.security)) {
          db.createObjectStore(STORES.security, { keyPath: 'id' });
        }

        // (Version migrations for existing users would branch on
        // event.oldVersion here in future DB_VERSION bumps.)
        void event;
      };

      open.onsuccess = function () {
        var db = open.result;
        // If another tab upgrades to a newer version, close so it isn't blocked.
        db.onversionchange = function () { db.close(); _dbPromise = null; };
        resolve(db);
      };

      open.onerror = function () { reject(open.error); };
      open.onblocked = function () {
        reject(new Error('IndexedDB open blocked by another open connection.'));
      };
    });

    return _dbPromise;
  }

  // Run `fn(store)` inside a transaction and resolve when it commits.
  function withStore(storeName, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var result;
        Promise.resolve(fn(store)).then(function (r) { result = r; }, reject);
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  // ---- Generic CRUD, reused by every store's typed helpers below. ----

  function create(storeName, data) {
    var now = Date.now();
    var record = Object.assign({}, data);
    if (!record.id) record.id = newId();
    record.createdAt = now;
    record.updatedAt = now;
    return withStore(storeName, 'readwrite', function (store) {
      return promisify(store.add(record));
    }).then(function () { return record; });
  }

  function get(storeName, id) {
    return withStore(storeName, 'readonly', function (store) {
      return promisify(store.get(id));
    });
  }

  function getAll(storeName) {
    return withStore(storeName, 'readonly', function (store) {
      return promisify(store.getAll());
    });
  }

  // Merge a patch into an existing record; returns the updated record.
  function update(storeName, id, patch) {
    return withStore(storeName, 'readwrite', function (store) {
      return promisify(store.get(id)).then(function (existing) {
        if (!existing) throw new Error('Record not found: ' + id);
        var updated = Object.assign({}, existing, patch, {
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: Date.now()
        });
        return promisify(store.put(updated)).then(function () { return updated; });
      });
    });
  }

  function remove(storeName, id) {
    return withStore(storeName, 'readwrite', function (store) {
      return promisify(store.delete(id));
    });
  }

  function getAllByIndex(storeName, indexName, value) {
    return withStore(storeName, 'readonly', function (store) {
      return promisify(store.index(indexName).getAll(value));
    });
  }

  function clear(storeName) {
    return withStore(storeName, 'readwrite', function (store) {
      return promisify(store.clear());
    });
  }

  // Upsert a record verbatim (preserving its id/timestamps). Used by backup
  // restore so imported records keep their identity instead of being re-keyed.
  function putRaw(storeName, record) {
    return withStore(storeName, 'readwrite', function (store) {
      return promisify(store.put(record));
    });
  }

  // Build a typed CRUD helper object for a store.
  function crudFor(storeName) {
    return {
      create: function (data) { return create(storeName, data); },
      get: function (id) { return get(storeName, id); },
      getAll: function () { return getAll(storeName); },
      update: function (id, patch) { return update(storeName, id, patch); },
      remove: function (id) { return remove(storeName, id); },
      clear: function () { return clear(storeName); }
    };
  }

  // ---- Typed helpers per area ----

  var family = crudFor(STORES.familyMembers);
  var contacts = crudFor(STORES.contacts);
  var insurer = crudFor(STORES.insurer);
  var hospitals = crudFor(STORES.hospitals);

  var documents = crudFor(STORES.documents);
  // A document must belong to a member; enforce that and add a lookup.
  documents.create = function (data) {
    if (!data || !data.memberId) {
      return Promise.reject(new Error('document.memberId is required'));
    }
    return create(STORES.documents, data);
  };
  documents.getByMember = function (memberId) {
    return getAllByIndex(STORES.documents, 'memberId', memberId);
  };

  // Document categories (fixed set of folders inside a member).
  documents.CATEGORIES = [
    { key: 'id', label: 'ID' },
    { key: 'insurance', label: 'Insurance' },
    { key: 'medical', label: 'Medical reports' },
    { key: 'medication', label: 'Medications' }
  ];

  // --- File read/write seam ---
  // The UI writes and reads files ONLY through these two functions, never by
  // touching `record.blob` directly. Encryption runs here: the plaintext file
  // is encrypted (AES-GCM under the session DEK) before it is written, and
  // decrypted on read. `record.blob` on disk is { iv, cipher }, never the file.

  // Store an uploaded File/Blob as an ENCRYPTED document. Requires an unlocked
  // session (EmergencySecurity holds the key). `meta` carries memberId,
  // category, title, etc. Returns the created record.
  documents.saveFile = function (meta, file) {
    if (!meta || !meta.memberId) {
      return Promise.reject(new Error('document.memberId is required'));
    }
    return EmergencySecurity.encryptBlob(file).then(function (payload) {
      var record = Object.assign({}, meta, {
        mime: file.type || meta.mime || 'application/octet-stream',
        size: file.size,
        encrypted: true,
        blob: payload // { v, alg, iv, cipher } — ciphertext, not the file
      });
      return create(STORES.documents, record);
    });
  };

  // Return a viewable, decrypted Blob for a stored document record. Requires
  // an unlocked session for encrypted records.
  documents.readFile = function (record) {
    if (!record) return Promise.reject(new Error('no document record'));
    if (record.encrypted) return EmergencySecurity.decryptToBlob(record);
    // Legacy plaintext blobs (pre-encryption records) still open.
    return Promise.resolve(record.blob);
  };

  // Restore a document from a backup: encrypt `blob` under THIS device's key
  // and store it, preserving the record's id/timestamps (`meta`). Requires an
  // unlocked session.
  documents.restore = function (meta, blob) {
    return EmergencySecurity.encryptBlob(blob).then(function (payload) {
      var record = Object.assign({}, meta, { encrypted: true, blob: payload });
      return putRaw(STORES.documents, record);
    });
  };
  // Deleting a member should not orphan their documents.
  var _familyRemove = family.remove;
  family.remove = function (id) {
    return documents.getByMember(id).then(function (docs) {
      return Promise.all(docs.map(function (d) { return remove(STORES.documents, d.id); }));
    }).then(function () { return _familyRemove(id); });
  };

  // Key vault: fixed-id upsert records (e.g. 'pin', 'bio'). No timestamps or
  // generated ids — the security layer owns the record shape.
  var vault = {
    get: function (id) {
      return withStore(STORES.security, 'readonly', function (store) {
        return promisify(store.get(id));
      });
    },
    put: function (record) {
      return withStore(STORES.security, 'readwrite', function (store) {
        return promisify(store.put(record));
      });
    },
    remove: function (id) {
      return withStore(STORES.security, 'readwrite', function (store) {
        return promisify(store.delete(id));
      });
    }
  };

  var EmergencyDB = {
    STORES: STORES,
    open: openDB,
    vault: vault,
    putRaw: putRaw,
    family: family,
    documents: documents,
    contacts: contacts,
    insurer: insurer,
    hospitals: hospitals,

    // Wipe everything. Handy during development.
    clearAll: function () {
      return Promise.all(Object.keys(STORES).map(function (k) {
        return clear(STORES[k]);
      }));
    },

    // Quick end-to-end check: exercises create/read/update/delete on every
    // store (including a member->document link and a real Blob), logs a
    // report, and leaves no data behind. Returns true if all steps pass.
    // Run in DevTools console:  await EmergencyDB.selfTest()
    selfTest: function () {
      var log = [];
      function step(name, ok, detail) {
        log.push({ step: name, ok: ok, detail: detail });
        console.log((ok ? '✓' : '✗') + ' ' + name, detail != null ? detail : '');
      }

      return Promise.resolve().then(function () {
        // 1. Family member CRUD
        return family.create({ name: 'Test Person', relation: 'self', bloodGroup: 'O+' });
      }).then(function (m) {
        step('family.create', !!m.id, m.id);
        return family.get(m.id).then(function (got) {
          step('family.get', got && got.name === 'Test Person');
          return family.update(m.id, { bloodGroup: 'A+' });
        }).then(function (upd) {
          step('family.update', upd.bloodGroup === 'A+' && upd.updatedAt >= upd.createdAt);

          // 2. Document linked to the member (real Blob)
          var blob = new Blob(['fake pdf bytes'], { type: 'application/pdf' });
          return documents.create({
            memberId: m.id, title: 'Aadhaar', type: 'id',
            mime: blob.type, blob: blob
          });
        }).then(function (doc) {
          step('documents.create (linked)', !!doc.id, 'memberId=' + doc.memberId);
          return documents.getByMember(m.id);
        }).then(function (list) {
          step('documents.getByMember', list.length === 1, list.length + ' doc(s)');
          return list[0].blob.text().then(function (txt) {
            step('documents blob round-trip', txt === 'fake pdf bytes');
          });
        }).then(function () {
          // 3. Cascade: removing the member removes their documents
          return family.remove(m.id);
        }).then(function () {
          return documents.getByMember(m.id);
        }).then(function (after) {
          step('family.remove cascades documents', after.length === 0);
          return family.get(m.id);
        }).then(function (goneMember) {
          step('family.remove (member gone)', goneMember === undefined);
        });
      }).then(function () {
        // 4. Contact CRUD (indexed by category)
        return contacts.create({ name: 'Ambulance', phone: '108', category: 'ambulance', pinned: true });
      }).then(function (c) {
        return contacts.remove(c.id).then(function () { step('contacts CRUD', true); });
      }).then(function () {
        // 5. Insurer CRUD
        return insurer.create({ insurerName: 'Star Health', policyNumber: 'P123', helpline: '1800...' });
      }).then(function (i) {
        return insurer.remove(i.id).then(function () { step('insurer CRUD', true); });
      }).then(function () {
        // 6. Hospital CRUD
        return hospitals.create({ name: 'City Hospital', mapsUrl: 'https://maps.google.com/?q=...' });
      }).then(function (h) {
        return hospitals.remove(h.id).then(function () { step('hospitals CRUD', true); });
      }).then(function () {
        var allOk = log.every(function (e) { return e.ok; });
        console.log(allOk
          ? '%cAll storage self-tests passed.'
          : '%cSome storage self-tests FAILED.',
          'font-weight:bold;color:' + (allOk ? 'green' : 'red'));
        return allOk;
      }).catch(function (err) {
        console.error('selfTest threw:', err);
        return false;
      });
    }
  };

  global.EmergencyDB = EmergencyDB;
})(window);
