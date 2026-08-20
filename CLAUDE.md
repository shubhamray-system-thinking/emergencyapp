# EmergencyApp

## What this is
A free, non-commercial, offline-first app that holds a family's emergency
information so it's instantly reachable during a medical emergency — when
someone is panicking, possibly on the road, possibly with no network.

It is for personal and family use. It is NOT a business, has no users to
monetize, and must never require an account.

## Hard constraints (do not violate without asking me first)
- **Offline-first.** Every core feature must work with zero network. Assume
  the phone has no signal at the moment it's needed most.
- **No backend.** No server, no API we host, no database service. Everything
  runs on the device.
- **No login, no cloud sync, no analytics, no third-party trackers.** Do not
  add authentication flows, sign-in, or "sync across devices" features.
- **Local storage only.** Use IndexedDB for structured data and document
  files. Do not reach for a remote store.
- **PWA.** It must be installable to the phone home screen and run standalone.
- **Privacy is the whole point.** This holds government IDs and medical
  records. Treat all stored data as sensitive.

## Tech stack
- Plain HTML, CSS, and vanilla JavaScript. No build step unless I ask for one.
- Service worker for offline caching (app shell + assets).
- IndexedDB for all data: family members, documents (as encrypted blobs),
  contacts, insurer details, saved hospitals.
- Web Crypto API for encrypting document blobs before writing them.
- No frameworks, no npm dependencies, unless I explicitly approve one.

## App structure — four tabs
1. **Family** — a folder per family member. Inside each: their documents
   (ID, insurance, medical reports, medication list), stored as PDFs/images.
2. **Contacts** — emergency numbers. Ambulance pinned at the top and visually
   flagged. Then family doctor, family members, and any others. Tapping a
   contact should dial it.
3. **Insurer** — reference details entered by the user: insurer name, policy
   number, helpline, and a free-text "cashless notes" field. This is a
   reference card, NOT a live lookup — we do not query any insurer system.
4. **Hospitals** — a user-curated list of saved hospitals, each with a saved
   Google Maps link that opens in Maps. NOT a live "nearest hospital" search.
   We store links the user adds; we do not maintain a hospital database.

## India-specific defaults (pre-fill where sensible)
- 112 — unified emergency (police, fire, ambulance); works without SIM/network
- 108 — government ambulance
- 1091 — women in distress
- 1098 — child helpline

## Security requirements
- App-lock on open: PIN or biometric.
- Encrypt document blobs with Web Crypto before writing to IndexedDB.
- Provide an optional manual export (a single encrypted file the user can save
  themselves). Do NOT auto-upload or auto-sync anything.

## How I want you to work
- Build ONE tab fully before starting the next. Order: Family, Contacts,
  Insurer, Hospitals.
- After each phase, stop and let me test before moving on.
- Prefer the simplest thing that works. This is a solo, unpaid build.
- If a request seems to need a backend, login, or network, stop and flag it
  instead of adding it.
