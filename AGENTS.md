# Project Guidelines

## Overview

This is a Chrome MV3 browser extension that provides Inn-Reach tools for FOLIO (open-source library services platform). It injects a modal overlay into the active FOLIO tab with a tabbed interface for:

1. **Paging Slips** — Generate and print Inn-Reach paging slips for items awaiting retrieval.
2. **Fix Broken Holds** — Scan for and repair Inn-Reach ITEM_HOLD/TRANSFER transactions that have lost sync with FOLIO requests/loans.

Based on Python scripts ([print_paging_slips.py](../print_paging_slips.py) and [fix_broken_item_hold_loans.py](../fix_broken_item_hold_loans.py)), ported to a browser extension with GitHub Copilot (Claude Opus 4.6).

## Architecture

- **`modal.js`** — Content script injected into the active FOLIO tab. Creates a Shadow DOM modal overlay with all UI and logic. Handles session detection (via localStorage/cookies), FOLIO API calls, paging slip generation, and broken transaction repair.
- **`modal.css`** — Styles loaded into the Shadow DOM. Isolated from the host page.
- **`background.js`** — Service worker. Handles extension icon click (injects modal.js), cookie-based session detection (for Keycloak environments), and tab opening.
- **`manifest.json`** — Chrome MV3 manifest. No `default_popup` — the extension icon click triggers content script injection.

## Code Style

- Plain ES5-compatible JavaScript with `var` declarations (no ES modules, no build step, no transpiler).
- IIFEs for scope isolation — `modal.js` and `background.js` both use this pattern.
- No external dependencies — Mustache rendering is implemented inline.
- Use `chrome.*` APIs directly (not `browser.*`). This is a Chrome/Edge MV3 extension.
- Shadow DOM is used for complete style isolation from the FOLIO host page.

## Conventions

- **Session detection** in `modal.js` injects a MAIN-world script to read `localStorage.okapiSess` from the FOLIO page. Falls back to cookie detection via `chrome.cookies` in the background worker.
- **API calls** go through `folioGet()`, `folioGetAll()`, `folioGetCQL()`, `folioPost()`, `folioPut()` — local helpers in `modal.js`. These handle token-based and cookie-based auth.
- **Per-tenant settings** are stored via `chrome.storage.local`, keyed by tenant ID.
- **Write operations** (check-in, check-out, request updates) require explicit user confirmation via `confirm()` dialogs before executing.
- **Permissions**: `activeTab`, `storage`, `scripting`, `cookies` with `*://*/*` host permissions.

## FOLIO Domain Context

- **Inn-Reach** is an interlibrary loan system. Transactions have types (ITEM, PATRON) and states (ITEM_HOLD, TRANSFER, FINAL_CHECKIN, etc.).
- **Paging slips** are printed documents staff use to locate and retrieve physical items from shelves.
- **Service points** are physical library locations. Slips can be filtered by service point code prefix.
- **Central server** manages Inn-Reach connections between libraries.
- **Broken transactions** occur when ITEM_HOLD or TRANSFER transactions lose their associated open request, causing items to be handled improperly. The fix involves closing/reopening loans and requests to re-sync state.
- Key FOLIO API endpoints: `/service-points`, `/locations`, `/inn-reach/transactions`, `/inn-reach/central-servers`, `/inventory/items`, `/request-storage/requests`, `/loan-storage/loans`, `/circulation/check-in-by-barcode`, `/bl-users/_self`, `/service-points-users`.

## Build and Test

No build step. To install:
1. Go to `chrome://extensions/`, enable Developer mode.
2. Click "Load unpacked" and select this folder.

To test changes, reload the extension from `chrome://extensions/` after editing files. Click the extension icon on any FOLIO page to open the modal.

## Files

- `modal.js` — Main content script (injected on icon click). All UI, API logic, and business logic.
- `modal.css` — Shadow DOM styles. Must be listed in `web_accessible_resources`.
- `background.js` — Service worker for icon click handling and cookie detection.
- `manifest.json` — Chrome MV3 manifest.
- `icons/` — Extension icons (16, 48, 128px PNGs + SVG source).
- `generate_icons.py` — Standalone icon generator. Not part of the runtime extension.
