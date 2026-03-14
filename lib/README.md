# folio-session — FOLIO Session Detection & Multi-Tenant Config Library

A reusable JavaScript library for Chrome MV3 extensions that need to interact
with FOLIO (the open-source library services platform). It provides:

- **Automatic session detection** — discovers the FOLIO API URL and tenant ID
  from the active browser tab using localStorage, cookies, DOM, Stripes globals,
  JWT tokens, and more.
- **Multi-tenant configuration storage** — stores per-tenant settings in
  `chrome.storage.local` with migration support for legacy flat-key layouts.
- **Lightweight FOLIO API client** — cookie-based auth (`credentials: "include"`),
  paginated fetching, and CQL query helpers.
- **Tenant switching** — helpers for building multi-tenant UIs with dropdowns.

Works with both **EBSCO-hosted Eureka** (Keycloak JWT) and **Okapi**
environments.

---

## Files

| File | Purpose |
|------|---------|
| `folio-session.js` | Main library — include in your popup/options page |
| `folio-session-background.js` | Background service worker — handles cookie detection |

---

## Quick Start

### 1. Copy the library files

Copy **`lib/folio-session.js`** and **`lib/folio-session-background.js`** into
your extension's directory (e.g. under a `lib/` folder).

### 2. Configure `manifest.json`

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "storage", "scripting", "cookies"],
  "host_permissions": ["*://*/*"],
  "background": {
    "service_worker": "lib/folio-session-background.js"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

**Required permissions:**

| Permission | Why |
|------------|-----|
| `activeTab` | Inject session-detection script into the active tab |
| `storage` | Persist per-tenant settings in `chrome.storage.local` |
| `scripting` | `chrome.scripting.executeScript` to read page-context data |
| `cookies` | `chrome.cookies.getAll` for HttpOnly token cookies |
| `*://*/*` (host) | Access any FOLIO instance's API and cookies |

### 3. Include in your popup HTML

```html
<!-- Load the library BEFORE your extension script -->
<script src="lib/folio-session.js"></script>
<script src="popup.js"></script>
```

### 4. Use in your popup script

```js
// Optional: set a custom log prefix for console output
FolioSession.setLogPrefix("[MyExtension]");

async function init() {
  // Migrate any old flat settings (one-time, safe to call every time)
  await FolioSession.migrateOldSettings(
    ["okapiUrl", "okapiTenant", "mySetting1", "mySetting2"],
    "okapiTenant"  // which old key held the tenant ID
  );

  // Detect the FOLIO session from the active tab + cookies
  var result = await FolioSession.detect();
  // result = { url, tenant, token, sessions, debug }

  if (!result.url || !result.tenant) {
    console.log("Could not detect FOLIO session — prompt user for manual entry");
    return;
  }

  console.log("Connected to", result.url, "tenant", result.tenant);

  // Make API calls
  var servicePoints = await FolioSession.folioGetAll(
    "/service-points", "servicepoints"
  );
  console.log("Found", servicePoints.length, "service points");

  // Load saved settings for this tenant
  var profile = await FolioSession.loadTenantProfile(result.tenant);
  if (profile) {
    // Apply saved settings to your UI...
  }
}

init();
```

---

## API Reference

### Session Detection

#### `FolioSession.detect()`

Detects the current FOLIO session by combining:
1. **Page-context injection** — injects a script into the active tab's MAIN
   world to read localStorage (`okapiSess`, `tenant`), sessionStorage, meta
   tags, Stripes globals (`__STRIPES_CONFIG__`, `stripesConfig`), Redux store,
   inline scripts, script `src` attributes, accessible cookies, JWT `iss`
   claims, and data attributes.
2. **Background cookie scanning** — sends a message to the background service
   worker to read HttpOnly `folioAccessToken`/`okapiToken` cookies and extract
   tenant IDs from JWT payloads.

Returns a Promise resolving to:

```js
{
  url: "https://api-example.folio.ebsco.com",   // API gateway URL
  tenant: "fs00001234",                          // tenant ID
  token: "eyJ...",                               // access token (may be null)
  sessions: [                                    // all detected sessions
    { url: "...", tenant: "...", token: "..." },
    // ...
  ],
  debug: ["..."]                                 // diagnostic messages
}
```

After calling `detect()`, the library's internal state is populated — you can use
`FolioSession.getUrl()`, `getTenant()`, etc.

---

### Per-Tenant Profile Storage

#### `FolioSession.loadTenantProfile(tenantId)`

Load a saved profile for a specific tenant.

```js
var profile = await FolioSession.loadTenantProfile("fs00001234");
// profile = { okapiUrl: "...", mySetting: "..." } or null
```

#### `FolioSession.saveTenantProfile(tenantId, profile)`

Save arbitrary key-value data for a tenant. Also registers the tenant in the
known-tenants list.

```js
FolioSession.saveTenantProfile("fs00001234", {
  okapiUrl: "https://api-example.folio.ebsco.com",
  mySetting: "value",
  anotherSetting: true,
});
```

**Storage format:** Profiles are stored under the key `folio_tenant_<tenantId>`
in `chrome.storage.local`. The known-tenants list is stored under
`folio_knownTenants`.

#### `FolioSession.getKnownTenants()`

Returns a Promise resolving to an array of all tenant IDs that have been saved.

```js
var tenants = await FolioSession.getKnownTenants();
// ["fs00001234", "fs00001567"]
```

#### `FolioSession.migrateOldSettings(oldKeys, tenantKey)`

One-time migration from flat `chrome.storage.local` keys to per-tenant profiles.
Safe to call on every startup — no-ops after the first migration.

Parameters:
- `oldKeys` — array of the old flat key names your extension used
- `tenantKey` — which old key held the tenant ID (default: `"okapiTenant"`)

```js
await FolioSession.migrateOldSettings(
  ["okapiUrl", "okapiTenant", "centralServerId", "agencyMap"],
  "okapiTenant"
);
```

---

### Tenant Switching

#### `FolioSession.getLastActiveTenant()`

Returns a Promise resolving to the tenant ID that was most recently marked
active (persisted across popup opens).

#### `FolioSession.setLastActiveTenant(tenantId)`

Record which tenant is currently active.

#### `FolioSession.switchTenant(tenantId, url?)`

Update the library's internal state to a different tenant/URL pair. Does NOT
touch the DOM — your extension is responsible for updating its own UI.

```js
FolioSession.switchTenant("fs00001567", "https://api-other.folio.ebsco.com");
// Now all folioGet() calls target the new tenant
```

---

### FOLIO API Client

All API methods use **cookie-based authentication** (`credentials: "include"`).
The library sends `Content-Type: application/json` and `x-okapi-tenant` headers
but **does NOT send `x-okapi-token`** — FOLIO's HttpOnly cookie handles auth
automatically.

#### `FolioSession.folioGet(path, queryParams?)`

Make a single GET request. Returns parsed JSON.

```js
var data = await FolioSession.folioGet("/inn-reach/central-servers", {
  limit: "100",
});
```

Query parameter values can be arrays (sent as repeated params):

```js
var data = await FolioSession.folioGet("/inn-reach/transactions", {
  type: "ITEM",
  state: ["ITEM_HOLD", "TRANSFER"],  // → state=ITEM_HOLD&state=TRANSFER
});
```

#### `FolioSession.folioGetAll(path, key, queryParams?, limit?)`

Paginated fetch — automatically sends multiple requests with `offset`/`limit`
until all records are returned.

```js
var allLocations = await FolioSession.folioGetAll(
  "/locations",
  "locations",       // JSON key containing the array
  {},                // extra query params
  1000               // page size (default: 1000)
);
```

#### `FolioSession.folioGetCQL(path, key, query)`

Convenience wrapper that passes a CQL query string as the `query` parameter.

```js
var items = await FolioSession.folioGetCQL(
  "/inventory/items",
  "items",
  "id==(abc123 or def456)"
);
```

#### `FolioSession.buildHeaders()`

Returns the standard FOLIO request headers object. Useful if you need to make
custom fetch calls:

```js
var headers = FolioSession.buildHeaders();
// { "Content-Type": "application/json", "x-okapi-tenant": "fs00001234" }
```

---

### Accessors

| Method | Returns | Description |
|--------|---------|-------------|
| `getUrl()` | `string\|null` | Current API gateway URL |
| `setUrl(url)` | — | Override the API URL |
| `getTenant()` | `string\|null` | Current tenant ID |
| `setTenant(id)` | — | Override the tenant ID |
| `getToken()` | `string\|null` | Access token (may be null with cookie auth) |
| `getCurrentTenantId()` | `string\|null` | Alias for the active tenant profile ID |
| `getAllSessions()` | `Object[]` | All sessions from cookie detection |
| `setLogPrefix(prefix)` | — | Set console log prefix (e.g. `"[MyExt]"`) |

---

## Background Service Worker

The **`folio-session-background.js`** file must be registered as your
extension's service worker. It handles:

- Reading HttpOnly cookies (`folioAccessToken`, `okapiToken`)
- Extracting tenant IDs from JWT tokens (Keycloak `iss` claim with `/realms/` path)
- Matching cookie sessions to the active tab using normalized hostnames
  (strips `api-`/`okapi-` prefixes)
- Responding to `folioDetectCookies` messages from the popup

**If your extension already has a background service worker**, you can
`importScripts("lib/folio-session-background.js")` within it instead (note: MV3
service workers support `importScripts` only at the top level).

---

## Multi-Tenant UI Example

```js
// After detect(), show a tenant switcher if multiple sessions exist
var sessions = FolioSession.getAllSessions();
if (sessions.length > 1) {
  var select = document.getElementById("tenant-select");
  sessions.forEach(function (s) {
    var opt = document.createElement("option");
    opt.value = s.tenant;
    opt.textContent = s.tenant + " — " + s.url;
    opt.dataset.url = s.url;
    select.appendChild(opt);
  });

  // Also add saved-but-not-logged-in tenants
  var knownTenants = await FolioSession.getKnownTenants();
  var activeTenants = sessions.map(function (s) { return s.tenant; });
  knownTenants.forEach(function (t) {
    if (activeTenants.indexOf(t) === -1) {
      var opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t + " (saved)";
      select.appendChild(opt);
    }
  });

  select.addEventListener("change", async function () {
    var sel = select.options[select.selectedIndex];
    FolioSession.switchTenant(sel.value, sel.dataset.url || null);
    var profile = await FolioSession.loadTenantProfile(sel.value);
    // Apply profile to your UI...
  });
}
```

---

## Storage Keys

The library uses the following `chrome.storage.local` keys (all prefixed with
`folio_` to avoid collisions with your extension's own keys):

| Key | Type | Description |
|-----|------|-------------|
| `folio_tenant_<tenantId>` | Object | Per-tenant profile data |
| `folio_knownTenants` | string[] | List of all seen tenant IDs |
| `folio_lastActiveTenant` | string | Last-active tenant ID |

---

## Supported FOLIO Environments

| Environment | How Detected |
|-------------|-------------|
| EBSCO Eureka (Keycloak) | JWT `iss` claim with `/realms/<tenantId>` path |
| EBSCO Okapi | `okapiTenant`/`folioTenant` cookies, localStorage `okapiSess` |
| Self-hosted Okapi | localStorage, meta tags, Stripes config globals |
| Any Stripes UI | `__STRIPES_CONFIG__`, Redux store, inline script scanning |

---

## License

MIT
