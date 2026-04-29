/**
 * folio-session.js — Reusable FOLIO session detection, per-tenant configuration,
 * and API client for Chrome MV3 extensions.
 *
 * This library detects the active FOLIO session from the current browser tab
 * (localStorage, cookies, DOM, Stripes globals, JWT tokens) and provides:
 *
 *   - Session detection (page-context injection + background cookie scanning)
 *   - Multi-tenant profile storage in chrome.storage.local
 *   - A lightweight FOLIO API client using cookie-based auth
 *   - A tenant switcher helper for building multi-tenant UIs
 *
 * Usage: include this file before your extension's popup script, and use the
 * global `FolioSession` object.  Pair with `folio-session-background.js` in
 * your service worker.
 *
 * @license MIT
 */

/* global chrome */

var FolioSession = (function () {
  "use strict";

  // ================================================================
  //  INTERNAL STATE
  // ================================================================

  var _gatewayUrl = null;
  var _folioTenant = null;
  var _accessToken = null;
  var _currentTenantId = null;
  var _allDetectedSessions = [];
  var _logPrefix = "[FolioSession]";
  var _grantedOrigins = {};

  // ================================================================
  //  HOST PERMISSION HELPERS
  // ================================================================

  /**
   * Extract the origin from a URL string (e.g. "https://folio.example.edu").
   * @param {string} urlStr
   * @returns {string|null}
   */
  function _originOf(urlStr) {
    try { return new URL(urlStr).origin; } catch (_) { return null; }
  }

  /**
   * Compute a wildcard host-permission pattern from a URL.
   * For hosts with 3+ labels (e.g. foo.folio.ebsco.com) returns
   * "https://*.folio.ebsco.com/*" so sibling subdomains (API, etc.) are covered.
   * For shorter hostnames returns the exact origin pattern.
   * @param {string} urlStr
   * @returns {string|null}  A match pattern suitable for chrome.permissions.
   */
  function getWildcardPattern(urlStr) {
    try {
      var u = new URL(urlStr);
      var parts = u.hostname.split(".");
      if (parts.length >= 3) {
        return u.protocol + "//*." + parts.slice(1).join(".") + "/*";
      }
      return u.origin + "/*";
    } catch (_) { return null; }
  }

  /**
   * Check (without prompting) whether the extension already has host permission.
   * @param {string} origin
   * @returns {Promise<boolean>}
   */
  function hasHostPermission(origin) {
    if (!origin) return Promise.resolve(false);
    if (_grantedOrigins[origin]) return Promise.resolve(true);
    var pattern = origin + "/*";
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: [pattern] }, function (has) {
        if (has) _grantedOrigins[origin] = true;
        resolve(has);
      });
    });
  }

  /**
   * Request host permission for the given origin.  MUST be called from a
   * direct user-gesture handler (e.g. a button click).
   * @param {string} origin  An origin like "https://folio.example.edu".
   * @returns {Promise<boolean>}  True if the permission is (now) granted.
   */
  function ensureHostPermission(origin) {
    if (!origin) return Promise.resolve(false);
    if (_grantedOrigins[origin]) return Promise.resolve(true);
    var pattern = origin + "/*";
    return new Promise(function (resolve) {
      chrome.permissions.request({ origins: [pattern] }, function (granted) {
        if (granted) _grantedOrigins[origin] = true;
        resolve(granted);
      });
    });
  }

  /**
   * Return the origin of the active tab, or null.
   * @returns {Promise<string|null>}
   */
  async function getActiveTabOrigin() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var url = (tabs && tabs[0] && tabs[0].url) || "";
    return _originOf(url);
  }

  /**
   * Return the full URL of the active tab, or "".
   * @returns {Promise<string>}
   */
  async function getActiveTabUrl() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0] && tabs[0].url) || "";
  }

  // ================================================================
  //  PER-TENANT PROFILE STORAGE
  // ================================================================

  function _tenantProfileKey(tenantId) {
    return "folio_tenant_" + tenantId;
  }

  /**
   * Load a saved profile for a specific tenant.
   * @param {string} tenantId
   * @returns {Promise<Object|null>} The saved profile, or null.
   */
  function loadTenantProfile(tenantId) {
    return new Promise(function (resolve) {
      chrome.storage.local.get([_tenantProfileKey(tenantId)], function (data) {
        resolve(data[_tenantProfileKey(tenantId)] || null);
      });
    });
  }

  /**
   * Save a profile for a specific tenant and register it in the known-tenants list.
   * @param {string} tenantId
   * @param {Object} profile  Arbitrary key/value pairs to persist.
   */
  function saveTenantProfile(tenantId, profile) {
    if (!tenantId) return;
    var obj = {};
    obj[_tenantProfileKey(tenantId)] = profile;
    chrome.storage.local.get(["folio_knownTenants"], function (data) {
      var known = data.folio_knownTenants || [];
      if (known.indexOf(tenantId) === -1) {
        known.push(tenantId);
        obj.folio_knownTenants = known;
      }
      chrome.storage.local.set(obj);
    });
  }

  /**
   * Retrieve the list of all tenant IDs that have been seen/saved.
   * @returns {Promise<string[]>}
   */
  function getKnownTenants() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(["folio_knownTenants"], function (data) {
        resolve(data.folio_knownTenants || []);
      });
    });
  }

  /**
   * One-time migration from flat chrome.storage keys to per-tenant profiles.
   * Call this at startup.  Safe to call multiple times — it no-ops after the
   * first successful migration.
   *
   * @param {string[]} oldKeys  The flat key names your extension formerly used
   *                            (e.g. ["okapiUrl","okapiTenant","centralServerId"]).
   * @param {string}   tenantKey  Which old key held the tenant ID (default: "okapiTenant").
   * @returns {Promise<void>}
   */
  function migrateOldSettings(oldKeys, tenantKey) {
    tenantKey = tenantKey || "okapiTenant";
    return new Promise(function (resolve) {
      var allKeys = oldKeys.concat(["folio_knownTenants"]);
      chrome.storage.local.get(allKeys, function (data) {
        if (data.folio_knownTenants) { resolve(); return; }
        if (data[tenantKey]) {
          var tenantId = data[tenantKey];
          var profile = {};
          oldKeys.forEach(function (k) { if (k !== tenantKey && data[k] != null) profile[k] = data[k]; });
          profile.okapiUrl = data.okapiUrl || "";
          var obj = {};
          obj[_tenantProfileKey(tenantId)] = profile;
          obj.folio_knownTenants = [tenantId];
          chrome.storage.local.set(obj, function () {
            chrome.storage.local.remove(oldKeys, resolve);
          });
        } else {
          chrome.storage.local.set({ folio_knownTenants: [] }, resolve);
        }
      });
    });
  }

  // ================================================================
  //  SESSION DETECTION — INJECTED INTO PAGE CONTEXT
  // ================================================================

  /**
   * This function is serialised and injected into the page's MAIN world via
   * chrome.scripting.executeScript.  It reads localStorage, sessionStorage,
   * cookies, DOM meta tags, Stripes globals, Redux store, and inline scripts
   * to find the Okapi/Eureka URL and tenant ID.
   *
   * It MUST be a pure, self-contained function (no closures over external
   * variables) because it runs in the page's JS context, not the extension's.
   */
  function _extractFolioSession() {
    var result = { url: null, tenant: null, token: null, debug: [] };

    // 1. localStorage: okapiSess
    try {
      var stored = localStorage.getItem("okapiSess");
      if (stored && stored !== "true") {
        var sess = JSON.parse(stored);
        result.url = sess.url || sess.okapiUrl || null;
        result.tenant = sess.tenant || null;
        result.token = sess.token || null;
        result.debug.push("Found okapiSess in localStorage (JSON)");
      } else if (stored) {
        result.debug.push("okapiSess is '" + stored + "' (not a JSON object)");
      }
    } catch (e) {
      result.debug.push("okapiSess parse error: " + e.message);
    }

    // 1b. localStorage: direct 'tenant' key
    try {
      var directTenant = localStorage.getItem("tenant");
      if (directTenant) {
        try {
          var parsed = JSON.parse(directTenant);
          if (parsed && typeof parsed === "object" && (parsed.tenantId || parsed.id || parsed.tenantName)) {
            directTenant = parsed.tenantId || parsed.id || parsed.tenantName;
          } else if (typeof parsed === "string") {
            directTenant = parsed;
          }
        } catch (_) { /* already a plain string */ }
        result.tenant = result.tenant || directTenant;
        result.debug.push("Found 'tenant' in localStorage: " + directTenant);
      }
    } catch (_) { /* ignore */ }

    // 2. localStorage: scan for okapi/stripes keys
    if (!result.tenant || !result.url) {
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var key = localStorage.key(i);
          if (key && (key.indexOf("okapi") !== -1 || key.indexOf("stripes") !== -1)) {
            result.debug.push("LS key: " + key + " = " + localStorage.getItem(key).substring(0, 200));
            try {
              var val = JSON.parse(localStorage.getItem(key));
              if (val && typeof val === "object") {
                if (!result.url && (val.url || val.okapiUrl)) result.url = val.url || val.okapiUrl;
                if (!result.tenant && val.tenant) result.tenant = val.tenant;
                if (!result.token && val.token) result.token = val.token;
              }
            } catch (_) { /* not JSON */ }
          }
        }
      } catch (e) {
        result.debug.push("LS scan error: " + e.message);
      }
    }

    // 3. sessionStorage
    if (!result.tenant || !result.url) {
      try {
        for (var j = 0; j < sessionStorage.length; j++) {
          var skey = sessionStorage.key(j);
          if (skey && (skey.indexOf("okapi") !== -1 || skey.indexOf("stripes") !== -1 || skey.indexOf("folio") !== -1)) {
            result.debug.push("SS key: " + skey + " = " + sessionStorage.getItem(skey).substring(0, 200));
            try {
              var sval = JSON.parse(sessionStorage.getItem(skey));
              if (sval && typeof sval === "object") {
                if (!result.url && (sval.url || sval.okapiUrl)) result.url = sval.url || sval.okapiUrl;
                if (!result.tenant && sval.tenant) result.tenant = sval.tenant;
                if (!result.token && sval.token) result.token = sval.token;
              }
            } catch (_) { /* not JSON */ }
          }
        }
      } catch (e) {
        result.debug.push("SS scan error: " + e.message);
      }
    }

    // 4. <meta> tags
    try {
      var metaTenant = document.querySelector('meta[name="okapi-tenant"]');
      if (metaTenant) {
        result.tenant = result.tenant || metaTenant.content;
        result.debug.push("Meta okapi-tenant: " + metaTenant.content);
      }
      var metaUrl = document.querySelector('meta[name="okapi-url"]');
      if (metaUrl) {
        result.url = result.url || metaUrl.content;
        result.debug.push("Meta okapi-url: " + metaUrl.content);
      }
    } catch (_) { /* ignore */ }

    // 5. Stripes global config objects
    try {
      var configSources = [
        window.__STRIPES_CONFIG__,
        window.stripesConfig,
        window.__config,
        window.config,
      ];
      for (var ci = 0; ci < configSources.length; ci++) {
        var sc = configSources[ci];
        if (sc && typeof sc === "object") {
          result.debug.push("Found global config object at index " + ci);
          if (sc.okapi && sc.okapi.url) {
            result.url = result.url || sc.okapi.url;
            result.tenant = result.tenant || sc.okapi.tenant;
            result.debug.push("Config okapi.url: " + sc.okapi.url + ", tenant: " + sc.okapi.tenant);
          }
          if (sc.okapiUrl) {
            result.url = result.url || sc.okapiUrl;
            result.debug.push("Config okapiUrl: " + sc.okapiUrl);
          }
        }
      }
    } catch (_) { /* ignore */ }

    // 6. Redux store
    try {
      var rootEl = document.getElementById("root") || document.querySelector("[data-reactroot]");
      if (rootEl && rootEl._reactRootContainer) {
        result.debug.push("Found React root container");
      }
      if (window.__REDUX_STORE__ && window.__REDUX_STORE__.getState) {
        var state = window.__REDUX_STORE__.getState();
        if (state && state.okapi) {
          result.url = result.url || state.okapi.url;
          result.tenant = result.tenant || state.okapi.tenant;
          result.token = result.token || state.okapi.token;
          result.debug.push("Redux store okapi.url: " + state.okapi.url);
        }
      }
    } catch (e) {
      result.debug.push("Redux scan: " + e.message);
    }

    // 7. Inline <script> tags
    if (!result.tenant || !result.url) {
      try {
        var inlineScripts = document.querySelectorAll("script:not([src])");
        for (var si = 0; si < inlineScripts.length; si++) {
          var text = inlineScripts[si].textContent || "";
          if (text.indexOf("okapi") !== -1 || text.indexOf("tenant") !== -1) {
            var urlMatch = text.match(/["']?(okapiUrl|okapi\.url|url)["']?\s*[:=]\s*["']([^"']+)["']/);
            var tenantMatch = text.match(/["']?(tenant|okapi\.tenant)["']?\s*[:=]\s*["']([^"']+)["']/);
            if (urlMatch) {
              result.url = result.url || urlMatch[2];
              result.debug.push("Inline script okapi URL: " + urlMatch[2]);
            }
            if (tenantMatch) {
              result.tenant = result.tenant || tenantMatch[2];
              result.debug.push("Inline script tenant: " + tenantMatch[2]);
            }
          }
        }
      } catch (e) {
        result.debug.push("Script scan error: " + e.message);
      }
    }

    // 8. <script src> attributes
    try {
      var allScripts = document.querySelectorAll("script[src]");
      for (var ss = 0; ss < allScripts.length; ss++) {
        var src = allScripts[ss].src || "";
        if (src.indexOf("okapi") !== -1) {
          try {
            var pUrl = new URL(src);
            result.url = result.url || pUrl.origin;
            result.debug.push("Script src with okapi: " + pUrl.origin);
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }

    // 9. Cookies (accessible, non-HttpOnly ones)
    try {
      var cookies = document.cookie.split(";").map(function (c) { return c.trim(); });
      var tokenCookie = cookies.find(function (c) {
        return c.startsWith("folioAccessToken=") || c.startsWith("okapiToken=");
      });
      if (tokenCookie) {
        result.token = result.token || tokenCookie.split("=").slice(1).join("=");
        result.debug.push("Found token cookie");
      }
      var tenantCookie = cookies.find(function (c) {
        return c.startsWith("okapiTenant=") || c.startsWith("folioTenant=");
      });
      if (tenantCookie) {
        result.tenant = result.tenant || tenantCookie.split("=").slice(1).join("=");
        result.debug.push("Found tenant cookie: " + tenantCookie.split("=")[0]);
      }
      if (!result.url && result.token) {
        try {
          var parts = result.token.split(".");
          if (parts.length >= 2) {
            var payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
            result.debug.push("JWT claims: " + Object.keys(payload).join(", "));
            if (!result.tenant && payload.tenant) result.tenant = payload.tenant;
            if (!result.tenant && payload.tenant_id) result.tenant = payload.tenant_id;
            if (payload.iss) {
              try {
                var issUrl = new URL(payload.iss);
                result.url = result.url || issUrl.origin;
                result.debug.push("JWT issuer origin: " + issUrl.origin);
              } catch (_) {
                try {
                  var issUrl2 = new URL("https://" + payload.iss);
                  result.url = result.url || issUrl2.origin;
                  result.debug.push("JWT issuer (as hostname): " + issUrl2.origin);
                } catch (_) { /* not a URL */ }
              }
            }
          }
        } catch (e) {
          result.debug.push("JWT decode error: " + e.message);
        }
      }
      result.debug.push("All cookies: " + cookies.map(function (c) { return c.split("=")[0]; }).join(", "));
    } catch (_) { /* ignore */ }

    // 10. Data attributes on body/root
    try {
      var bodyData = document.body.dataset;
      if (bodyData.okapiUrl) {
        result.url = result.url || bodyData.okapiUrl;
        result.debug.push("body data-okapi-url: " + bodyData.okapiUrl);
      }
      var rootData = (document.getElementById("root") || {}).dataset || {};
      if (rootData.okapiUrl) {
        result.url = result.url || rootData.okapiUrl;
        result.debug.push("root data-okapi-url: " + rootData.okapiUrl);
      }
    } catch (_) { /* ignore */ }

    // Log all localStorage keys for debugging
    try {
      var allKeys = [];
      for (var k = 0; k < localStorage.length; k++) {
        allKeys.push(localStorage.key(k));
      }
      result.debug.push("All LS keys: " + allKeys.join(", "));
    } catch (_) { /* ignore */ }

    return result;
  }

  /**
   * Run page-context session detection via chrome.scripting.executeScript.
   * Tries MAIN world first (access to page globals), falls back to ISOLATED.
   * @returns {Promise<{url:string|null, tenant:string|null, token:string|null, debug:string[]}>}
   */
  async function _detectFromPage() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      throw new Error("No active tab found");
    }
    var tabId = tabs[0].id;

    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: _extractFolioSession,
        world: "MAIN",
      });
      if (results && results[0] && results[0].result) {
        return results[0].result;
      }
    } catch (err) {
      console.warn(_logPrefix, "executeScript MAIN world failed:", err.message);
      try {
        var results2 = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: _extractFolioSession,
        });
        if (results2 && results2[0] && results2[0].result) {
          return results2[0].result;
        }
      } catch (err2) {
        console.warn(_logPrefix, "executeScript ISOLATED failed:", err2.message);
      }
    }

    return { url: null, tenant: null, token: null, debug: ["executeScript failed entirely"] };
  }

  // ================================================================
  //  FULL SESSION DETECTION (page + cookies + merging)
  // ================================================================

  /**
   * Detect the current FOLIO session by combining page-context detection with
   * background-worker cookie scanning.  Returns the merged result and populates
   * the internal state (gatewayUrl, folioTenant, etc).
   *
   * @returns {Promise<{url:string|null, tenant:string|null, token:string|null, sessions:Object[], debug:string[]}>}
   */
  async function detect() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tabUrl = (tabs && tabs[0] && tabs[0].url) || "";

    var pageSess;
    try {
      pageSess = await _detectFromPage();
    } catch (err) {
      console.warn(_logPrefix, "Page detection error:", err);
      pageSess = { url: null, tenant: null, token: null, debug: [err.message] };
    }

    if (pageSess.debug && pageSess.debug.length) {
      console.log(_logPrefix, "Page-context debug:");
      pageSess.debug.forEach(function (d) { console.log("  ", d); });
    }

    // Ask the background worker for cookie-based sessions.
    // If _folioDetectFromCookies is available (both files loaded in the same
    // service-worker context) call it directly — chrome.runtime.sendMessage
    // from a service worker does not reach its own onMessage listeners.
    var cookieSess = null;
    if (tabUrl) {
      try {
        if (typeof self !== "undefined" && typeof self._folioDetectFromCookies === "function") {
          cookieSess = await self._folioDetectFromCookies(tabUrl);
        } else {
          cookieSess = await chrome.runtime.sendMessage({
            type: "folioDetectCookies",
            tabUrl: tabUrl,
          });
        }
        if (cookieSess && cookieSess.debug && cookieSess.debug.length) {
          console.log(_logPrefix, "Cookie detection debug:");
          cookieSess.debug.forEach(function (d) { console.log("  ", d); });
        }
      } catch (e) {
        console.warn(_logPrefix, "Cookie detection message failed:", e.message);
      }
    }

    // Merge — page detection wins for the current tab
    _gatewayUrl = pageSess.url || (cookieSess && cookieSess.url) || null;
    _folioTenant = pageSess.tenant || (cookieSess && cookieSess.tenant) || null;
    _accessToken = pageSess.token || (cookieSess && cookieSess.token) || null;

    // The gateway URL derived from cookies may be a bare parent domain
    // (e.g. "https://folio.ebsco.com") because the token cookie is scoped
    // to ".folio.ebsco.com" — not a usable API endpoint.  Discard it so the
    // saved per-tenant profile or manual entry can provide the real URL.
    if (_gatewayUrl && tabUrl) {
      try {
        var gwHost = new URL(_gatewayUrl).hostname;
        var tabHost = new URL(tabUrl).hostname;
        if (gwHost !== tabHost && tabHost.endsWith("." + gwHost)) {
          console.log(_logPrefix, "Discarding parent-domain URL:", _gatewayUrl);
          _gatewayUrl = null;
        }
      } catch (_) { /* ignore */ }
    }

    // If we have a tenant but no URL, search cookie sessions by tenant
    if (_folioTenant && !_gatewayUrl && cookieSess && cookieSess.sessions) {
      for (var si = 0; si < cookieSess.sessions.length; si++) {
        if (cookieSess.sessions[si].tenant === _folioTenant && cookieSess.sessions[si].url) {
          _gatewayUrl = cookieSess.sessions[si].url;
          console.log(_logPrefix, "Resolved URL via tenant match:", _gatewayUrl);
          break;
        }
      }
    }

    // If still no URL, try subdomain matching against the tab URL
    if (_folioTenant && !_gatewayUrl && tabUrl) {
      try {
        var tabHostForApi = new URL(tabUrl).hostname;
        if (cookieSess && cookieSess.sessions) {
          for (var di = 0; di < cookieSess.sessions.length; di++) {
            var sUrl = cookieSess.sessions[di].url;
            if (sUrl && sUrl.indexOf(tabHostForApi.split(".")[0]) !== -1) {
              _gatewayUrl = sUrl;
              console.log(_logPrefix, "Resolved URL via subdomain match:", _gatewayUrl);
              break;
            }
          }
        }
      } catch (_) { /* ignore */ }
    }

    // Build the all-sessions list, excluding entries with no tenant ID
    if (cookieSess && cookieSess.sessions && cookieSess.sessions.length > 0) {
      _allDetectedSessions = cookieSess.sessions.filter(function (s) { return !!s.tenant; });
    }
    if (_allDetectedSessions.length === 0 && _gatewayUrl && _folioTenant) {
      _allDetectedSessions = [{ url: _gatewayUrl, tenant: _folioTenant, token: _accessToken }];
    } else if (_folioTenant) {
      var found = _allDetectedSessions.some(function (s) { return s.tenant === _folioTenant; });
      if (!found) {
        _allDetectedSessions.unshift({ url: _gatewayUrl, tenant: _folioTenant, token: _accessToken });
      }
    }

    _currentTenantId = _folioTenant || null;

    return {
      url: _gatewayUrl,
      tenant: _folioTenant,
      token: _accessToken,
      sessions: _allDetectedSessions,
      debug: (pageSess.debug || []).concat(
        (cookieSess && cookieSess.debug) || []
      ),
    };
  }

  // ================================================================
  //  TENANT SWITCHING HELPERS
  // ================================================================

  /**
   * Get the ID of the tenant that was active last time the popup was opened.
   * @returns {Promise<string|null>}
   */
  function getLastActiveTenant() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(["folio_lastActiveTenant"], function (data) {
        resolve(data.folio_lastActiveTenant || null);
      });
    });
  }

  /**
   * Record which tenant is currently active (persisted across popup opens).
   * @param {string} tenantId
   */
  function setLastActiveTenant(tenantId) {
    chrome.storage.local.set({ folio_lastActiveTenant: tenantId });
  }

  /**
   * Switch the active session to a different tenant/URL pair.
   * Updates internal state; does NOT touch the DOM.
   * @param {string} tenantId
   * @param {string} [url]  Optional API URL override.
   */
  function switchTenant(tenantId, url) {
    _currentTenantId = tenantId;
    _folioTenant = tenantId;
    if (url) _gatewayUrl = url;
  }

  // ================================================================
  //  FOLIO API CLIENT
  // ================================================================

  /**
   * Build standard FOLIO request headers.
   * Uses cookie-based auth (credentials:"include"), so NO x-okapi-token is sent.
   * @returns {Object}
   */
  function buildHeaders() {
    return {
      "Content-Type": "application/json",
      "x-okapi-tenant": _folioTenant,
    };
  }

  /**
   * Make a single FOLIO API GET request.
   * @param {string} path  API path (e.g. "/inventory/items").
   * @param {Object} [queryParams]  Key-value query parameters.  Arrays become
   *                                 repeated params (e.g. state=A&state=B).
   * @returns {Promise<Object>}  Parsed JSON response body.
   */
  async function folioGet(path, queryParams) {
    // Check (don't request — that requires a user gesture) host permission
    var apiOrigin = _originOf(_gatewayUrl);
    if (apiOrigin) {
      var has = await hasHostPermission(apiOrigin);
      if (!has) {
        throw new Error(
          "Host permission for " + apiOrigin + " is not granted. " +
          "Please grant site access from the extension popup."
        );
      }
    }
    var url = new URL(path, _gatewayUrl);
    if (queryParams) {
      Object.keys(queryParams).forEach(function (key) {
        var value = queryParams[key];
        if (Array.isArray(value)) {
          value.forEach(function (v) { url.searchParams.append(key, v); });
        } else if (value != null) {
          url.searchParams.set(key, String(value));
        }
      });
    }
    var resp = await fetch(url.toString(), {
      headers: buildHeaders(),
      credentials: "include",
    });
    if (!resp.ok) {
      var body = await resp.text().catch(function () { return ""; });
      throw new Error(
        "FOLIO API " + resp.status + " " + resp.statusText + " \u2014 " + path + "\n" + body.slice(0, 500)
      );
    }
    return resp.json();
  }

  /**
   * Paginated fetch — keeps requesting until all records are returned.
   * @param {string} path
   * @param {string} key        The JSON key containing the array of records.
   * @param {Object} [queryParams]
   * @param {number} [limit=1000]
   * @returns {Promise<Object[]>}
   */
  async function folioGetAll(path, key, queryParams, limit) {
    limit = limit || 1000;
    var offset = 0;
    var all = [];
    for (;;) {
      var params = Object.assign({}, queryParams, {
        limit: String(limit),
        offset: String(offset),
      });
      var data = await folioGet(path, params);
      var records = data[key] || [];
      all = all.concat(records);
      if (records.length < limit) break;
      offset += limit;
    }
    return all;
  }

  /**
   * Convenience wrapper: fetch records using a CQL query string.
   * @param {string} path
   * @param {string} key
   * @param {string} query CQL query string.
   * @returns {Promise<Object[]>}
   */
  async function folioGetCQL(path, key, query) {
    var data = await folioGet(path, { query: query });
    return data[key] || [];
  }

  // ================================================================
  //  ACCESSORS
  // ================================================================

  /** @returns {string|null} The detected/configured API gateway URL. */
  function getUrl() { return _gatewayUrl; }

  /** Set the API gateway URL manually. */
  function setUrl(url) { _gatewayUrl = url; }

  /** @returns {string|null} The detected/configured tenant ID. */
  function getTenant() { return _folioTenant; }

  /** Set the tenant ID manually. */
  function setTenant(t) { _folioTenant = t; _currentTenantId = t; }

  /** @returns {string|null} The access token (if detected; may be null when using cookie auth). */
  function getToken() { return _accessToken; }

  /** @returns {string|null} The current tenant profile ID. */
  function getCurrentTenantId() { return _currentTenantId; }

  /** @returns {Object[]} All sessions detected via cookies. */
  function getAllSessions() { return _allDetectedSessions; }

  /**
   * Set the log prefix used for console messages.
   * @param {string} prefix  e.g. "[MyExtension]"
   */
  function setLogPrefix(prefix) { _logPrefix = prefix; }

  // ================================================================
  //  PUBLIC API
  // ================================================================

  return {
    // Detection
    detect: detect,

    // Tenant profile storage
    loadTenantProfile: loadTenantProfile,
    saveTenantProfile: saveTenantProfile,
    getKnownTenants: getKnownTenants,
    migrateOldSettings: migrateOldSettings,

    // Tenant switching
    getLastActiveTenant: getLastActiveTenant,
    setLastActiveTenant: setLastActiveTenant,
    switchTenant: switchTenant,

    // FOLIO API client
    buildHeaders: buildHeaders,
    folioGet: folioGet,
    folioGetAll: folioGetAll,
    folioGetCQL: folioGetCQL,

    // Host permissions
    hasHostPermission: hasHostPermission,
    ensureHostPermission: ensureHostPermission,
    getActiveTabOrigin: getActiveTabOrigin,
    getActiveTabUrl: getActiveTabUrl,
    getWildcardPattern: getWildcardPattern,

    // Accessors
    getUrl: getUrl,
    setUrl: setUrl,
    getTenant: getTenant,
    setTenant: setTenant,
    getToken: getToken,
    getCurrentTenantId: getCurrentTenantId,
    getAllSessions: getAllSessions,
    setLogPrefix: setLogPrefix,
  };
})();
