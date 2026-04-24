# FOLIO Inn-Reach Tools

A Chrome extension for FOLIO library staff that generates Inn-Reach paging slips and repairs broken Inn-Reach transactions — directly from the FOLIO browser interface.

## Features

- **Paging Slip Generation** — Bulk-generate and print paging slips for Inn-Reach ITEM_HOLD and TRANSFER transactions, filtered by service point. Also supports printing a single slip by tracking ID or item barcode.
- **Broken Transaction Repair** — Scan for Inn-Reach transactions that have lost sync with FOLIO (missing open request), then repair them by closing/reopening loans and requests.
- **Per-Tenant Settings** — Automatically detects your FOLIO session and stores configuration per tenant, including central server selection and agency code mappings.

## Installation

1. Open `chrome://extensions/` in Chrome (or `edge://extensions/` in Edge).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `folio_innreach_tools/` folder.
4. The extension icon appears in your browser toolbar.
5. Navigate to any FOLIO page and log in. Click the extension icon to open the tool.
6. On first use, the browser will prompt you to grant the extension access to the FOLIO site.

To apply changes after editing files, click the reload icon on the extension card at `chrome://extensions/`.

## Usage

Click the extension icon while on any FOLIO page. An in-page modal overlay opens with three tabs.

### Paging Slips

Generate paging slips for items awaiting retrieval at your service points.

- **Generate for all service points** — Check this box to include every service point.
- **Filter by prefix** — Enter a prefix (e.g. `m`) to limit slip generation to service points whose code starts with that string.
- **Generate All Slips** — Fetches ITEM_HOLD and TRANSFER transactions, matches items to the selected service points, renders slips using the paging slip template from the central server, and opens them in a new tab with the print dialog. Items that are checked out or have no open request are excluded.
- **Single Slip Lookup** — Enter an item barcode or tracking ID to print one specific slip.

Slips are sorted by effective location, then call number. If no slips match, a message is shown in the modal instead of opening a blank page.

### Fix Broken Item Holds

Repair Inn-Reach transactions whose FOLIO request has fallen out of sync.

#### Scanning

Click **Scan for Broken Transactions** to fetch all ITEM_HOLD and TRANSFER transactions and identify ones whose linked FOLIO item has no open request. Results appear in a table showing tracking ID, state, item status, barcode, and title.

#### Syncing

Select one or more rows in the table (or enter tracking IDs manually) and click **Sync** or **Sync Selected**. The sync logic for each transaction:

1. Looks up the transaction and verifies it is in ITEM_HOLD or TRANSFER state.
2. Checks for other active transactions on the same item and warns if found.
3. If the item **is loaned out**:
   - If the loan patron matches the hold patron: closes the loan (check-in), reopens the request if closed, reopens the loan via Inn-Reach checkout, and restores the original loan and due dates.
   - If there is a patron mismatch: reopens and re-cancels the request to trigger FOLIO's internal sync.
4. If the item **is not loaned out**:
   - If the request is closed: reopens and re-cancels it.
   - If the request is still open: no action needed.

A confirmation dialog appears before any sync operation. Each row's status updates to show success (✓), skipped (—), or failed (✗).

#### Final Check-in Sync

Below the broken-hold scanner is a second section for detecting transactions that completed in FOLIO (loan closed) but never reached the FINAL_CHECKIN state in Inn-Reach.

**Scanning** — Click **Scan for Missing Final Check-ins** to fetch all ITEM transactions in `ITEM_SHIPPED`, `ITEM_IN_TRANSIT`, `RETURN_UNCIRCULATED`, `RECALL`, `ITEM_RECEIVED`, or `RECEIVE_UNANNOUNCED` state and check whether the associated FOLIO loan is closed. Results appear in a table showing tracking ID, state, item ID, loan ID, and sync status.

**Syncing** — Select rows in the table (or enter tracking IDs manually in the text field below) and click **Sync Selected** or **Sync**. The sync logic for each transaction:

1. Verifies the transaction is in one of the valid states listed above and has a closed loan.
2. If the transaction is in `RECALL` state, updates it to `ITEM_IN_TRANSIT` first (required workaround so the final check-in trigger fires).
3. "Touches" the loan record — sets `userId` to the hold patron, PUTs the loan, then removes `userId` and PUTs again. This write triggers FOLIO's internal event pipeline, which advances the Inn-Reach transaction to FINAL_CHECKIN.

A confirmation dialog appears before any sync operation. Each row's status updates to show success (✓ Synced), skipped (— Skipped), or failed (✗ Failed).

### Settings

- **FOLIO API Gateway** — Auto-detected from the page. Override manually if needed.
- **Tenant** — Auto-detected. Override if needed.
- **Central Server** — Dropdown populated from `/inn-reach/central-servers`. Select the central server used for your Inn-Reach transactions.
- **Agency Code Mappings** — A JSON object mapping agency codes to display names (e.g. `{"abc": "Main Library"}`). Auto-populated with a skeleton of detected codes from the central server configuration. Fill in the display names to label slips correctly.

Settings are saved per tenant and restored automatically on subsequent uses.

## How It Works

The extension is an in-page modal overlay injected into the FOLIO interface via a Shadow DOM (for style isolation). All FOLIO API calls are proxied through the background service worker to avoid CORS issues with cookie-based authentication.

### Session Detection

On icon click, the background service worker:

1. Requests host permissions for the current site (one-time prompt per domain).
2. Injects a detection function into the page's main JavaScript context, probing localStorage, sessionStorage, meta tags, Stripes globals, Redux store, inline scripts, cookies, data attributes, and JWT tokens.
3. Supplements with background cookie scanning (folioAccessToken / okapiToken).
4. Stores the merged session (URL, tenant, token) for the content script.

### API Proxy

The content script cannot make credentialed cross-origin requests directly. All FOLIO API calls are sent as messages to the background worker, which executes them with `credentials: "include"` and the correct auth headers.

## File Structure

| File | Purpose |
|---|---|
| `manifest.json` | Chrome MV3 extension manifest |
| `background.js` | Service worker — session detection, API proxy, settings |
| `modal.js` | Content script — all UI and business logic |
| `modal.css` | Shadow DOM styles for the modal overlay |
| `lib/folio-session.js` | Reusable FOLIO session detection library |
| `lib/folio-session-background.js` | Cookie-based session detection for the service worker |
| `icons/` | Extension icons (16, 48, 128px) |
| `LICENSE` | MIT license |

## Technical Notes

- Plain ES5-compatible JavaScript — no build step, no transpiler, no external dependencies.
- The Mustache template renderer is implemented inline (no library import).
- The session detection library (`lib/`) is derived from the [FOLIO Inn-Reach Paging Slips](../print_ir_paging_slips/) extension's library, with modifications to support running `detect()` from the background service worker. In the popup-based extension, `detect()` sends a message to the background for cookie scanning; here, both files are loaded in the same service worker context, so `folio-session-background.js` exposes `detectFromCookies` directly and `folio-session.js` calls it without messaging.

## License

MIT
