/**
 * folio-session-background.js — Background service worker companion for folio-session.js.
 *
 * Include this in your extension's service worker (via importScripts or as the
 * service_worker entry point) to handle cookie-based FOLIO session detection.
 *
 * Listens for messages of type "folioDetectCookies" from the popup and returns
 * the detected sessions.
 *
 * @license MIT
 */

/* global chrome */

(function () {
  "use strict";

  // Strip common FOLIO API URL prefixes/suffixes to get the "instance" hostname.
  // Prefix form: "api-michstate-lm.folio.ebsco.com" → "michstate-lm.folio.ebsco.com"
  //              "okapi-other.folio.ebsco.com"      → "other.folio.ebsco.com"
  // Suffix form: "michstate-lm-okapi.folio.ebsco.com" → "michstate-lm.folio.ebsco.com"
  //              "michstate-lm-api.folio.ebsco.com"   → "michstate-lm.folio.ebsco.com"
  function normalizeHost(hostname) {
    return hostname
      .replace(/^(api-|okapi-|api\.|okapi\.)/, "")
      .replace(/^([^.]+)-(okapi|api)\./, "$1.");
  }

  function extractTenantFromJWT(tokenValue) {
    try {
      var parts = tokenValue.split(".");
      if (parts.length >= 2) {
        var payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        // Direct tenant claim (Eureka / newer FOLIO SSO)
        if (payload.tenant) return payload.tenant;
        if (payload.tenant_id) return payload.tenant_id;
        // Keycloak realm-based extraction
        if (payload.iss) {
          try {
            var issPath = new URL(payload.iss).pathname;
            var segments = issPath.split("/").filter(Boolean);
            if (segments.length >= 2 && segments[segments.length - 2] === "realms") {
              return segments[segments.length - 1];
            }
          } catch (_) { /* not a URL */ }
        }
      }
    } catch (_) { /* decode error */ }
    return null;
  }

  async function detectFromCookies(tabUrl) {
    var debug = [];
    var sessions = [];
    try {
      var tokenCookies = await chrome.cookies.getAll({ name: "folioAccessToken" });
      if (!tokenCookies.length) {
        tokenCookies = await chrome.cookies.getAll({ name: "okapiToken" });
      }
      debug.push("folioAccessToken cookies found: " + tokenCookies.length);
      tokenCookies.forEach(function (c) {
        debug.push("  domain=" + c.domain + " secure=" + c.secure + " httpOnly=" + c.httpOnly);
      });

      var seenDomains = {};
      for (var i = 0; i < tokenCookies.length; i++) {
        var c = tokenCookies[i];
        var cookieDomain = c.domain;
        if (cookieDomain.startsWith(".")) cookieDomain = cookieDomain.substring(1);
        if (seenDomains[cookieDomain]) continue;
        seenDomains[cookieDomain] = true;

        var protocol = c.secure ? "https" : "http";
        var url = protocol + "://" + cookieDomain;
        var tenant = extractTenantFromJWT(c.value);
        debug.push("Session: url=" + url + " tenant=" + (tenant || "?"));
        sessions.push({ url: url, tenant: tenant, token: c.value });
      }

      // Supplement with tenant cookies
      var tenantCookies = await chrome.cookies.getAll({ name: "okapiTenant" });
      if (!tenantCookies.length) {
        tenantCookies = await chrome.cookies.getAll({ name: "folioTenant" });
      }
      for (var ti = 0; ti < tenantCookies.length; ti++) {
        var tc = tenantCookies[ti];
        var tcDomain = tc.domain;
        if (tcDomain.startsWith(".")) tcDomain = tcDomain.substring(1);
        for (var si = 0; si < sessions.length; si++) {
          try {
            var sessDomain = new URL(sessions[si].url).hostname;
            if (sessDomain === tcDomain || sessDomain.endsWith("." + tcDomain) || tcDomain.endsWith("." + sessDomain)) {
              sessions[si].tenant = sessions[si].tenant || tc.value;
              debug.push("Tenant cookie for " + tcDomain + ": " + tc.value);
            }
          } catch (_) { /* ignore */ }
        }
      }
    } catch (e) {
      debug.push("Cookie detection error: " + e.message);
    }

    // Determine primary session
    var primary = sessions[0] || { url: null, tenant: null, token: null };
    if (tabUrl && sessions.length > 1) {
      try {
        var tabHost = new URL(tabUrl).hostname;
        var tabNorm = normalizeHost(tabHost);
        for (var pi = 0; pi < sessions.length; pi++) {
          var sessHost = new URL(sessions[pi].url).hostname;
          var sessNorm = normalizeHost(sessHost);
          if (tabNorm === sessNorm) {
            primary = sessions[pi];
            debug.push("Primary session matched to tab (normalized): " + sessHost);
            break;
          }
        }
        // Fallback: subdomain match
        if (primary === (sessions[0] || { url: null, tenant: null, token: null })) {
          for (var fi = 0; fi < sessions.length; fi++) {
            var fHost = new URL(sessions[fi].url).hostname;
            var tabParts = tabHost.split(".");
            var fParts = fHost.split(".");
            var tabBase = tabParts.slice(-3).join(".");
            var fBase = fParts.slice(-3).join(".");
            if (tabBase === fBase) {
              var tabSubdomain = tabParts[0];
              if (fHost.indexOf(tabSubdomain) !== -1) {
                primary = sessions[fi];
                debug.push("Primary session matched to tab (subdomain fallback): " + fHost);
                break;
              }
            }
          }
        }
      } catch (_) { /* ignore */ }
    }

    return {
      url: primary.url,
      tenant: primary.tenant,
      token: primary.token,
      sessions: sessions,
      debug: debug,
    };
  }

  // Expose detectFromCookies on the global scope so that when both
  // folio-session.js and folio-session-background.js are loaded in the same
  // service-worker context, detect() can call it directly instead of sending
  // a chrome.runtime message (which does not reach the sender's own listeners).
  self._folioDetectFromCookies = detectFromCookies;

  // Listen for messages from the popup (or any extension page).
  // Supports both the new "folioDetectCookies" message type and the legacy
  // "detectCookies" type for backward compatibility.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if ((message.type === "folioDetectCookies" || message.type === "detectCookies") && message.tabUrl) {
      detectFromCookies(message.tabUrl).then(sendResponse);
      return true; // keep channel open for async response
    }
  });
})();
