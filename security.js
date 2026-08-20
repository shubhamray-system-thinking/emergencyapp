// Emergency — security layer.
//
// Root of trust is the PIN. We NEVER store the PIN. Instead:
//   1. A random Data Encryption Key (DEK, AES-GCM-256) encrypts every document.
//   2. A Key Encryption Key (KEK) is derived from the PIN via PBKDF2-SHA256.
//   3. Only the DEK *wrapped by the KEK* is persisted (plus salt + IV, which
//      are not secret). The PIN never touches disk.
//
// Unlocking = derive KEK from the entered PIN and try to unwrap the DEK. With
// the wrong PIN the AES-GCM unwrap fails its authentication tag, so:
//   - the app cannot unlock, and
//   - the document ciphertext (also AES-GCM under the DEK) stays unreadable.
//
// Biometric unlock (where the browser supports it) uses WebAuthn's PRF
// extension to derive a second KEK from the platform authenticator and wraps
// the SAME DEK, so Face ID / fingerprint unlock and PIN unlock reach the same
// key. The DEK lives only in memory for the session and is cleared on lock.

(function (global) {
  'use strict';

  var subtle = global.crypto && global.crypto.subtle;
  var enc = new TextEncoder();
  var VAULT = global.EmergencyDB.vault;

  var PBKDF2_ITERATIONS = 250000;

  var sessionDEK = null; // in-memory only; never persisted, cleared on lock()

  function randomBytes(n) { return global.crypto.getRandomValues(new Uint8Array(n)); }

  // Derive the PIN-based KEK (used to wrap/unwrap the DEK).
  function deriveKekFromPin(pin, salt, iterations) {
    return subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['wrapKey', 'unwrapKey']
        );
      });
  }

  // Derive a KEK from a WebAuthn PRF secret (high-entropy) via HKDF.
  function deriveKekFromPrf(prfSecret) {
    return subtle.importKey('raw', prfSecret, 'HKDF', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('emergency-bio-kek') },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['wrapKey', 'unwrapKey']
        );
      });
  }

  // ---- Setup / unlock ----

  function isSetup() {
    return VAULT.get('pin').then(function (rec) { return !!rec; });
  }

  function isUnlocked() { return !!sessionDEK; }

  function lock() { sessionDEK = null; }

  // First-run: create the DEK, wrap it with a KEK derived from `pin`, persist.
  function setupPin(pin) {
    var salt = randomBytes(16);
    var iv = randomBytes(12);
    var dek;
    // DEK is extractable so it can be wrapped (for PIN and, later, biometric).
    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      .then(function (key) {
        dek = key;
        return deriveKekFromPin(pin, salt, PBKDF2_ITERATIONS);
      })
      .then(function (kek) {
        return subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv: iv });
      })
      .then(function (wrapped) {
        return VAULT.put({
          id: 'pin',
          kdf: 'PBKDF2-SHA256',
          iterations: PBKDF2_ITERATIONS,
          salt: salt,
          iv: iv,
          wrapped: wrapped,
          createdAt: Date.now()
        });
      })
      .then(function () { sessionDEK = dek; return true; });
  }

  // Unlock with a PIN. Rejects with 'wrong-pin' when the PIN is incorrect.
  function unlockWithPin(pin) {
    return VAULT.get('pin').then(function (rec) {
      if (!rec) throw new Error('not-setup');
      return deriveKekFromPin(pin, rec.salt, rec.iterations).then(function (kek) {
        return subtle.unwrapKey(
          'raw', rec.wrapped, kek,
          { name: 'AES-GCM', iv: rec.iv },
          { name: 'AES-GCM', length: 256 },
          true, // extractable so it can be re-wrapped for biometric enrolment
          ['encrypt', 'decrypt']
        ).catch(function () {
          // AES-GCM auth failure == wrong PIN.
          throw new Error('wrong-pin');
        });
      });
    }).then(function (dek) { sessionDEK = dek; return true; });
  }

  // ---- Document encryption (used by db.js) ----

  function encryptBlob(blob) {
    if (!sessionDEK) return Promise.reject(new Error('locked'));
    var iv = randomBytes(12);
    return blob.arrayBuffer().then(function (data) {
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, sessionDEK, data);
    }).then(function (cipher) {
      return { v: 1, alg: 'AES-GCM', iv: iv, cipher: cipher };
    });
  }

  function decryptToBlob(record) {
    if (!sessionDEK) return Promise.reject(new Error('locked'));
    var payload = record.blob; // { iv, cipher }
    return subtle.decrypt({ name: 'AES-GCM', iv: payload.iv }, sessionDEK, payload.cipher)
      .then(function (plain) {
        return new Blob([plain], { type: record.mime || 'application/octet-stream' });
      });
  }

  // ---- Biometric (WebAuthn PRF), only where supported ----

  function platformAuthAvailable() {
    if (!global.PublicKeyCredential ||
        typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
      return Promise.resolve(false);
    }
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .catch(function () { return false; });
  }

  function isBiometricEnabled() {
    return VAULT.get('bio').then(function (rec) { return !!rec; });
  }

  // Enrol biometric: requires an unlocked session (needs the DEK to re-wrap).
  function enableBiometric() {
    if (!sessionDEK) return Promise.reject(new Error('unlock-first'));
    var prfSalt = randomBytes(32);

    return navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'Emergency' },
        user: { id: randomBytes(16), name: 'emergency', displayName: 'Emergency' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred'
        },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } }
      }
    }).then(function (cred) {
      var ext = cred.getClientExtensionResults();
      if (!ext.prf || !ext.prf.enabled) {
        throw new Error('prf-unsupported');
      }
      // PRF output usually isn't returned at create() time; fetch via get().
      var atCreate = ext.prf.results && ext.prf.results.first;
      if (atCreate) return { rawId: cred.rawId, secret: atCreate };
      return getPrfSecret(cred.rawId, prfSalt).then(function (secret) {
        return { rawId: cred.rawId, secret: secret };
      });
    }).then(function (out) {
      var iv = randomBytes(12);
      return deriveKekFromPrf(out.secret).then(function (kek) {
        return subtle.wrapKey('raw', sessionDEK, kek, { name: 'AES-GCM', iv: iv }).then(function (wrapped) {
          return VAULT.put({
            id: 'bio', credentialId: out.rawId, prfSalt: prfSalt,
            iv: iv, wrapped: wrapped, createdAt: Date.now()
          });
        });
      });
    }).then(function () { return true; });
  }

  function getPrfSecret(credentialId, prfSalt) {
    return navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ id: credentialId, type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } }
      }
    }).then(function (assertion) {
      var ext = assertion.getClientExtensionResults();
      var secret = ext.prf && ext.prf.results && ext.prf.results.first;
      if (!secret) throw new Error('prf-unsupported');
      return secret;
    });
  }

  function unlockWithBiometric() {
    return VAULT.get('bio').then(function (rec) {
      if (!rec) throw new Error('no-bio');
      return getPrfSecret(rec.credentialId, rec.prfSalt).then(function (secret) {
        return deriveKekFromPrf(secret).then(function (kek) {
          return subtle.unwrapKey(
            'raw', rec.wrapped, kek,
            { name: 'AES-GCM', iv: rec.iv },
            { name: 'AES-GCM', length: 256 },
            true, ['encrypt', 'decrypt']
          );
        });
      });
    }).then(function (dek) { sessionDEK = dek; return true; });
  }

  function disableBiometric() { return VAULT.remove('bio'); }

  global.EmergencySecurity = {
    isSetup: isSetup,
    isUnlocked: isUnlocked,
    lock: lock,
    setupPin: setupPin,
    unlockWithPin: unlockWithPin,
    encryptBlob: encryptBlob,
    decryptToBlob: decryptToBlob,
    platformAuthAvailable: platformAuthAvailable,
    isBiometricEnabled: isBiometricEnabled,
    enableBiometric: enableBiometric,
    unlockWithBiometric: unlockWithBiometric,
    disableBiometric: disableBiometric
  };
})(window);
