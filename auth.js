// Emergency — lock screen controller.
// Gates the whole app behind a PIN (with optional biometric unlock). Drives
// the #lock overlay and delegates all crypto to EmergencySecurity.

(function (global) {
  'use strict';

  var SEC = global.EmergencySecurity;

  var lockEl = document.getElementById('lock');
  var appEl = document.getElementById('app');
  var form = document.getElementById('lock-form');
  var titleEl = document.getElementById('lock-title');
  var subEl = document.getElementById('lock-sub');
  var pinEl = document.getElementById('lock-pin');
  var pin2El = document.getElementById('lock-pin2');
  var errEl = document.getElementById('lock-error');
  var submitEl = document.getElementById('lock-submit');
  var bioEl = document.getElementById('lock-bio');
  var enrollRow = document.getElementById('lock-enroll-row');
  var enrollCb = document.getElementById('lock-enroll');
  var lockNowBtn = document.getElementById('lock-now');

  var mode = 'unlock';       // 'setup' | 'unlock' | 'enroll'
  var bioAvailable = false;  // platform authenticator present?
  var MIN_PIN = 4;

  function setError(msg) { errEl.textContent = msg || ''; }
  function busy(on) { submitEl.disabled = on; bioEl.disabled = on; }

  function show(el, on) { el.hidden = !on; }

  // ---- reveal / hide the app ----
  function reveal() {
    lockEl.hidden = true;
    if ('inert' in appEl) appEl.inert = false;
    pinEl.value = ''; pin2El.value = ''; setError('');
    show(lockNowBtn, true);
  }

  function showLock() {
    lockEl.hidden = false;
    if ('inert' in appEl) appEl.inert = true;
  }

  // ---- screen configs ----
  function toSetup() {
    mode = 'setup';
    titleEl.textContent = 'Create a PIN';
    subEl.textContent = 'This PIN protects your family’s documents. There is no way to recover it — remember it.';
    pinEl.placeholder = 'New PIN';
    show(pin2El, true);
    submitEl.textContent = 'Create PIN';
    show(bioEl, false);
    show(enrollRow, false);
    setError('');
    pinEl.focus();
  }

  function toUnlock() {
    mode = 'unlock';
    titleEl.textContent = 'Enter PIN';
    subEl.textContent = '';
    pinEl.placeholder = 'PIN';
    show(pin2El, false);
    submitEl.textContent = 'Unlock';
    setError('');

    SEC.isBiometricEnabled().then(function (enabled) {
      if (enabled) {
        bioEl.textContent = 'Unlock with biometrics';
        show(bioEl, true);
        show(enrollRow, false);
      } else {
        show(bioEl, false);
        // Offer to turn biometric on after this PIN unlock.
        show(enrollRow, bioAvailable);
      }
    });
    pinEl.focus();
  }

  function toEnroll() {
    mode = 'enroll';
    titleEl.textContent = 'Enable biometric unlock?';
    subEl.textContent = 'Next time you can unlock with Face ID or your fingerprint.';
    show(pinEl, false);
    show(pin2El, false);
    submitEl.textContent = 'Enable';
    bioEl.textContent = 'Skip';
    show(bioEl, true);
    show(enrollRow, false);
    setError('');
  }

  function validPin(p) { return /^\d{4,}$/.test(p); }

  // ---- submit handling ----
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setError('');

    if (mode === 'setup') {
      var p1 = pinEl.value, p2 = pin2El.value;
      if (!validPin(p1)) { setError('Use a PIN of at least ' + MIN_PIN + ' digits.'); return; }
      if (p1 !== p2) { setError('The two PINs don’t match.'); return; }
      busy(true);
      SEC.setupPin(p1).then(function () {
        busy(false);
        if (bioAvailable) toEnroll(); else reveal();
      }).catch(function (err) {
        busy(false); setError('Could not set up the PIN.'); console.error(err);
      });
      return;
    }

    if (mode === 'unlock') {
      var pin = pinEl.value;
      if (!pin) { pinEl.focus(); return; }
      busy(true);
      SEC.unlockWithPin(pin).then(function () {
        busy(false);
        if (enrollRow.hidden === false && enrollCb.checked) { toEnroll(); return; }
        reveal();
      }).catch(function (err) {
        busy(false);
        pinEl.value = ''; pinEl.focus();
        setError(err.message === 'wrong-pin' ? 'Incorrect PIN.' : 'Could not unlock.');
      });
      return;
    }

    if (mode === 'enroll') {
      busy(true);
      SEC.enableBiometric().then(function () {
        busy(false); reveal();
      }).catch(function (err) {
        busy(false);
        console.warn('biometric enrol failed', err);
        // Biometric is optional; proceed unlocked either way.
        setError('Biometric setup was not completed. You can still use your PIN.');
        setTimeout(reveal, 1200);
      });
      return;
    }
  });

  // Secondary button: biometric unlock (unlock mode) or Skip (enroll mode).
  bioEl.addEventListener('click', function () {
    if (mode === 'enroll') { reveal(); return; }
    setError('');
    busy(true);
    SEC.unlockWithBiometric().then(function () {
      busy(false); reveal();
    }).catch(function (err) {
      busy(false);
      console.warn('biometric unlock failed', err);
      setError('Biometric unlock failed. Enter your PIN.');
      pinEl.focus();
    });
  });

  // Re-lock from the top bar.
  lockNowBtn.addEventListener('click', function () {
    SEC.lock();
    show(pinEl, true);
    showLock();
    toUnlock();
  });

  // ---- init ----
  show(lockNowBtn, false);
  showLock(); // locked by default
  SEC.platformAuthAvailable().then(function (avail) {
    bioAvailable = avail;
    return SEC.isSetup();
  }).then(function (setup) {
    if (setup) {
      toUnlock();
      // If biometric is enrolled, offer it immediately.
      SEC.isBiometricEnabled().then(function (en) { if (en) bioEl.focus(); });
    } else {
      toSetup();
    }
  });
})(window);
