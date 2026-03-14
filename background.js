// background.js — Service worker for FOLIO Inn-Reach Tools extension.
// Imports the reusable folio-session library and adds icon-click + API proxy handlers.

/* global chrome, FolioSession, importScripts */

importScripts("lib/folio-session.js", "lib/folio-session-background.js");

FolioSession.setLogPrefix("[InnReachTools]");

// ======================== ICON CLICK → DETECT + INJECT ========================

chrome.action.onClicked.addListener(async function (tab) {
  // 1. Ensure host permission for the active tab's origin (and its wildcard
  //    siblings, e.g. *.folio.ebsco.com) so that cookie detection and API
  //    calls work.  action.onClicked counts as a user gesture in MV3.
  var tabUrl = (tab && tab.url) || "";
  if (tabUrl) {
    var pattern = FolioSession.getWildcardPattern(tabUrl);
    if (pattern) {
      try {
        await new Promise(function (resolve) {
          chrome.permissions.request({ origins: [pattern] }, resolve);
        });
      } catch (e) {
        console.warn("[InnReachTools] Permission request failed:", e.message);
      }
    }
  }

  // 2. Detect session using the full FolioSession library (MAIN world + cookies)
  try {
    await FolioSession.detect();
  } catch (e) {
    console.warn("[InnReachTools] Session detection error:", e.message);
  }

  // 3. Store detected session for the content script, plus the tab origin as fallback
  var origin = null;
  try { origin = new URL(tabUrl).origin; } catch (_) { /* ignore */ }
  await chrome.storage.session.set({
    _irtools_session: {
      url: FolioSession.getUrl(),
      tenant: FolioSession.getTenant(),
      token: FolioSession.getToken(),
      origin: origin,
    },
  });

  // 3. Inject CSS + content script
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["modal.css"],
    });
  } catch (_) {
    // CSS may already be injected
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["modal.js"],
  });
});

// ======================== MESSAGE HANDLERS ========================

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === "irtools_getSession") {
    chrome.storage.session.get("_irtools_session", function (data) {
      sendResponse(data._irtools_session || null);
    });
    return true;
  }

  if (msg.type === "irtools_apiFetch") {
    // Proxy API calls through the background using FolioSession's auth context.
    // This avoids CORS issues since the background service worker has host permissions
    // and can use credentials: "include" for cookie-based auth.
    handleApiFetch(msg)
      .then(function (result) { sendResponse(result); })
      .catch(function (err) { sendResponse({ _error: true, message: err.message }); });
    return true;
  }

  if (msg.type === "irtools_loadProfile") {
    FolioSession.loadTenantProfile(msg.tenantId).then(sendResponse);
    return true;
  }

  if (msg.type === "irtools_saveProfile") {
    FolioSession.saveTenantProfile(msg.tenantId, msg.profile);
    sendResponse(true);
    return false;
  }

  // folioDetectCookies is handled by folio-session-background.js
});

// ======================== API PROXY ========================

async function handleApiFetch(msg) {
  // Ensure FolioSession has correct URL/tenant from the content script's session
  if (msg.sessionUrl) FolioSession.setUrl(msg.sessionUrl);
  if (msg.sessionTenant) FolioSession.setTenant(msg.sessionTenant);

  var method = (msg.method || "GET").toUpperCase();
  var path = msg.path;
  var params = msg.params || null;
  var body = msg.body || null;

  if (method === "GET") {
    var data = await FolioSession.folioGet(path, params);
    return { ok: true, data: data };
  }

  // POST / PUT — FolioSession only has GET helpers, so we build the request
  // using its headers and auth context
  var url = new URL(path, FolioSession.getUrl());
  if (params) {
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (Array.isArray(value)) {
        value.forEach(function (v) { url.searchParams.append(key, v); });
      } else if (value != null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  var headers = FolioSession.buildHeaders();
  var token = FolioSession.getToken();
  if (token) {
    headers["x-okapi-token"] = token;
  }

  var opts = {
    method: method,
    headers: headers,
    credentials: "include",
  };
  if (body != null) {
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  var resp = await fetch(url.toString(), opts);
  var respText = "";
  try {
    respText = await resp.text();
  } catch (_) {
    // ignore
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      statusText: resp.statusText,
      body: respText,
    };
  }

  // Parse JSON if applicable
  var ct = resp.headers.get("content-type") || "";
  if (ct.indexOf("json") !== -1 && respText) {
    return { ok: true, data: JSON.parse(respText) };
  }
  return { ok: true, data: respText || null };
}
