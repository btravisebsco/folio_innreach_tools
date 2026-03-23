// modal.js — Content script for FOLIO Inn-Reach Tools.
// Injected into the active FOLIO tab. Creates a Shadow DOM modal overlay
// with tabbed UI for paging slips and broken transaction management.

/* global chrome */

(function () {
  "use strict";

  var MODAL_ID = "folio-ir-tools-modal-root";

  // ======================== TOGGLE: close if already open ========================

  var existing = document.getElementById(MODAL_ID);
  if (existing) {
    existing.remove();
    return;
  }

  // ======================== SHADOW DOM SETUP ========================

  var root = document.createElement("div");
  root.id = MODAL_ID;
  root.style.cssText =
    "all:initial;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:auto;";
  document.body.appendChild(root);
  var shadow = root.attachShadow({ mode: "closed" });

  // Load CSS into shadow DOM
  var cssLink = document.createElement("link");
  cssLink.rel = "stylesheet";
  cssLink.href = chrome.runtime.getURL("modal.css");
  shadow.appendChild(cssLink);

  // ======================== SESSION STATE ========================

  var session = { url: "", tenant: "", token: "" };
  var cachedUserId = null;
  var cachedServicePointId = null;
  var cachedAgencyCodeMap = {};   // { centralServerId: { centralServerCode, agencies: {code: description} } }
  var cachedPatronCodeMap = {};   // { centralServerCode: { centralPatronType: description } }
  var cachedLocalServerCode = "";

  // ======================== HTML MARKUP ========================

  var container = document.createElement("div");
  container.innerHTML =
    '<div class="overlay" id="overlay">' +
    '  <div class="modal">' +
    '    <div class="modal-header">' +
    '      <h1><span aria-hidden="true">📄</span> Inn-Reach Tools</h1>' +
    '      <div class="tenant-info" id="tenant-info"></div>' +
    '      <button class="close-btn" id="close-btn" title="Close">&times;</button>' +
    "    </div>" +
    '    <div class="tab-bar">' +
    '      <button class="tab-btn active" data-tab="slips">Paging Slips</button>' +
    '      <button class="tab-btn" data-tab="fix">Fix Broken Item Holds</button>' +
    '      <button class="tab-btn" data-tab="settings">Settings</button>' +
    "    </div>" +
    '    <div class="modal-body">' +
    // ---- Paging Slips Tab ----
    '      <div class="tab-content active" id="tab-slips">' +
    '        <div class="section">' +
    "          <label>" +
    '            <input type="checkbox" id="all-sps">' +
    "            Generate for <strong>all</strong> service points" +
    "          </label>" +
    '          <div class="field-row">' +
    '            <label for="prefix">Or filter by prefix:</label>' +
    '            <input type="text" id="prefix" class="short" placeholder="e.g. m">' +
    "          </div>" +
    "        </div>" +
    "        <hr>" +
    '        <div class="section">' +
    '          <label for="single-lookup" class="field-label">Single Slip Lookup</label>' +
    '          <input type="text" id="single-lookup" class="full-width" placeholder="Tracking ID or Item barcode">' +
    "          <small>Print a slip for one specific transaction</small>" +
    "        </div>" +
    '        <div class="btn-row">' +
    '          <button class="btn primary" id="btn-generate">Generate All Slips</button>' +
    '          <button class="btn" id="btn-single">Print Single Slip</button>' +
    "        </div>" +
    "      </div>" +
    // ---- Fix Broken Holds Tab ----
    '      <div class="tab-content" id="tab-fix">' +
    '        <div class="section">' +
    "          <p>Scan for ITEM_HOLD / TRANSFER transactions missing an open request in FOLIO.</p>" +
    '          <div class="btn-row">' +
    '            <button class="btn primary" id="btn-list-broken">Scan for Broken Transactions</button>' +
    "          </div>" +
    "        </div>" +
    '        <div id="broken-results" style="display:none;">' +
    '          <div class="table-toolbar">' +
    '            <span id="broken-count"></span>' +
    '            <button class="btn danger" id="btn-sync-selected" disabled>Sync Selected</button>' +
    "          </div>" +
    '          <div class="table-wrap">' +
    '            <table id="broken-table">' +
    "              <thead><tr>" +
    '                <th><input type="checkbox" id="select-all-broken"></th>' +
    "                <th>Tracking ID</th>" +
    "                <th>State</th>" +
    "                <th>Item Status</th>" +
    "                <th>Request Status</th>" +
    "                <th>Barcode</th>" +
    "                <th>Title</th>" +
    "                <th>Sync</th>" +
    "              </tr></thead>" +
    '              <tbody id="broken-tbody"></tbody>' +
    "            </table>" +
    "          </div>" +
    "        </div>" +
    "        <hr>" +
    '        <div class="section">' +
    '          <label for="sync-ids" class="field-label">Sync Item Hold by Tracking ID</label>' +
    '          <input type="text" id="sync-ids" class="full-width" placeholder="Tracking ID(s), comma-separated">' +
    "          <small>Manually sync specific transaction(s)</small>" +
    '          <div class="btn-row">' +
    '            <button class="btn primary" id="btn-sync-manual">Sync</button>' +
    "          </div>" +
    "        </div>" +
    "      </div>" +
    // ---- Settings Tab ----
    '      <div class="tab-content" id="tab-settings">' +
    '        <div class="setting-group">' +
    '          <label for="okapi-url" class="field-label">FOLIO API Gateway</label>' +
    '          <input type="text" id="okapi-url" class="full-width" placeholder="e.g. https://okapi-tenant.folio.org">' +
    "          <small>Auto-detected from page if possible</small>" +
    "        </div>" +
    '        <div class="setting-group">' +
    '          <label for="okapi-tenant" class="field-label">Tenant</label>' +
    '          <input type="text" id="okapi-tenant" class="full-width" placeholder="e.g. fs00001234">' +
    "          <small>Auto-detected from page if possible</small>" +
    "        </div>" +
    '        <div class="setting-group">' +
    '          <label for="central-server-id" class="field-label">Central Server</label>' +
    '          <select id="central-server-id"><option value="">Detecting…</option></select>' +
    "        </div>" +
    '        <div class="btn-row">' +
    '          <button class="btn primary" id="btn-save-settings">Save Settings</button>' +
    "        </div>" +
    "      </div>" +
    "    </div>" +
    // ---- Footer: status, progress, log ----
    '    <div class="modal-footer">' +
    '      <div id="status" class="status-bar"></div>' +
    '      <progress id="progress" value="0" max="100"></progress>' +
    '      <button id="log-toggle" class="log-toggle" style="display:none;">Show Log <span id="log-count"></span></button>' +
    '      <div id="log" class="log-panel"></div>' +
    "    </div>" +
    "  </div>" +
    "</div>";
  shadow.appendChild(container);

  // ======================== DOM REFS ========================

  function $(id) {
    return shadow.getElementById(id);
  }

  var els = {
    overlay: $("overlay"),
    closeBtn: $("close-btn"),
    tenantInfo: $("tenant-info"),
    // Paging Slips
    allSPs: $("all-sps"),
    prefix: $("prefix"),
    singleLookup: $("single-lookup"),
    btnGenerate: $("btn-generate"),
    btnSingle: $("btn-single"),
    // Fix Broken Holds
    btnListBroken: $("btn-list-broken"),
    brokenResults: $("broken-results"),
    brokenCount: $("broken-count"),
    brokenTbody: $("broken-tbody"),
    selectAllBroken: $("select-all-broken"),
    btnSyncSelected: $("btn-sync-selected"),
    syncIds: $("sync-ids"),
    btnSyncManual: $("btn-sync-manual"),
    // Settings
    okapiUrl: $("okapi-url"),
    okapiTenant: $("okapi-tenant"),
    centralServerId: $("central-server-id"),
    agencyMap: null,
    btnSaveSettings: $("btn-save-settings"),
    // Footer
    status: $("status"),
    progress: $("progress"),
    logToggle: $("log-toggle"),
    logCount: $("log-count"),
    log: $("log"),
  };

  // ======================== UI HELPERS ========================

  function setStatus(msg, type) {
    els.status.textContent = msg;
    els.status.className = "status-bar" + (type ? " " + type : "");
  }

  function clearStatus() {
    els.status.textContent = "";
    els.status.className = "status-bar";
  }

  var _logEntryCount = 0;

  function addLog(msg, level) {
    _logEntryCount++;
    var d = document.createElement("div");
    d.textContent = msg;
    if (level === "error") d.className = "log-error";
    else if (level === "warn") d.className = "log-warn";
    els.log.appendChild(d);
    els.log.scrollTop = els.log.scrollHeight;
    // Show toggle button with count
    els.logToggle.style.display = "";
    els.logCount.textContent = "(" + _logEntryCount + ")";
  }

  function clearLog() {
    els.log.innerHTML = "";
    els.log.classList.remove("visible");
    els.logToggle.style.display = "none";
    _logEntryCount = 0;
    clearStatus();
    els.progress.classList.remove("visible");
  }

  function showProgress(val, max) {
    els.progress.classList.add("visible");
    els.progress.value = val;
    els.progress.max = max;
  }

  function hideProgress() {
    els.progress.classList.remove("visible");
  }

  // ======================== TAB SWITCHING ========================

  var tabBtns = shadow.querySelectorAll(".tab-btn");
  var tabContents = shadow.querySelectorAll(".tab-content");

  tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.getAttribute("data-tab");
      tabBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      tabContents.forEach(function (tc) {
        tc.classList.remove("active");
      });
      btn.classList.add("active");
      $("tab-" + target).classList.add("active");
    });
  });

  // ======================== CLOSE MODAL ========================

  els.closeBtn.addEventListener("click", function () {
    root.remove();
  });
  els.overlay.addEventListener("click", function (e) {
    if (e.target === els.overlay) root.remove();
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape" && document.getElementById(MODAL_ID)) {
      root.remove();
      document.removeEventListener("keydown", onEsc);
    }
  });

  // ======================== SESSION DETECTION ========================

  function detectSession() {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: "irtools_getSession" }, function (data) {
        resolve(data || {});
      });
    });
  }

  // ======================== FOLIO API CLIENT (proxied through background) ========================

  function _sendBg(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) { resolve(resp); });
    });
  }

  async function folioFetch(method, path, body, params) {
    var result = await _sendBg({
      type: "irtools_apiFetch",
      method: method,
      path: path,
      params: params || null,
      body: body,
      sessionUrl: session.url,
      sessionTenant: session.tenant,
    });
    if (!result) throw new Error("No response from background worker");
    if (result._error) throw new Error(result.message);
    if (!result.ok) {
      throw new Error(
        result.status + " " + result.statusText +
        (result.body ? ": " + result.body.substring(0, 500) : "")
      );
    }
    return result.data;
  }

  function folioGet(path, params) {
    return folioFetch("GET", path, null, params);
  }

  async function folioGetKey(path, key, params) {
    var data = await folioGet(path, params);
    return key ? data[key] || [] : data;
  }

  function folioGetCQL(path, key, cql) {
    return folioGetKey(path, key, { query: cql, limit: "1000" });
  }

  async function folioGetAll(path, key, extraParams) {
    var all = [];
    var offset = 0;
    var limit = 1000;
    while (true) {
      var params = { limit: String(limit), offset: String(offset) };
      if (extraParams) {
        Object.keys(extraParams).forEach(function (k) {
          params[k] = extraParams[k];
        });
      }
      var data = await folioGet(path, params);
      var records = key ? data[key] || [] : data;
      if (!Array.isArray(records) || records.length === 0) break;
      all = all.concat(records);
      var total = data.totalRecords;
      if (total == null || offset + records.length >= total) break;
      offset += records.length;
    }
    return all;
  }

  function folioPost(path, body) {
    return folioFetch("POST", path, body);
  }

  function folioPut(path, body) {
    return folioFetch("PUT", path, body);
  }

  // ======================== JWT DECODE ========================

  function decodeJwtPayload(token) {
    try {
      var parts = token.split(".");
      if (parts.length !== 3) return null;
      var payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(payload));
    } catch (_) {
      return null;
    }
  }

  // ======================== USER / SERVICE POINT ========================

  async function getCurrentUserId() {
    if (cachedUserId) return cachedUserId;
    // Try JWT
    if (session.token) {
      var payload = decodeJwtPayload(session.token);
      if (payload && payload.user_id) {
        cachedUserId = payload.user_id;
        return cachedUserId;
      }
    }
    // Fallback: API call
    var data = await folioGet("/bl-users/_self");
    if (data && data.user) cachedUserId = data.user.id;
    return cachedUserId;
  }

  async function getDefaultServicePoint() {
    if (cachedServicePointId) return cachedServicePointId;
    var userId = await getCurrentUserId();
    if (!userId) return null;
    var data = await folioGetCQL(
      "/service-points-users",
      "servicePointsUsers",
      "userId==" + userId
    );
    if (data.length > 0) {
      cachedServicePointId = data[0].defaultServicePointId;
    }
    return cachedServicePointId;
  }

  // ======================== SETTINGS STORAGE ========================

  function gatherSettings() {
    return {
      okapiUrl: els.okapiUrl.value.trim(),
      centralServerId: els.centralServerId.value,
      prefix: els.prefix.value,
      allSPs: els.allSPs.checked,
    };
  }

  function applySettings(s) {
    if (!s) return;
    if (s.okapiUrl) els.okapiUrl.value = s.okapiUrl;
    if (s.centralServerId != null) {
      els.centralServerId.dataset.savedValue = s.centralServerId;
    }
    if (s.prefix) els.prefix.value = s.prefix;
    if (s.allSPs != null) els.allSPs.checked = s.allSPs;
  }

  function saveSettings() {
    var tenantId = session.tenant || "default";
    _sendBg({ type: "irtools_saveProfile", tenantId: tenantId, profile: gatherSettings() });
  }

  function loadSettings() {
    var tenantId = session.tenant || "default";
    return _sendBg({ type: "irtools_loadProfile", tenantId: tenantId });
  }

  // ======================== CENTRAL SERVER CONFIG ========================

  async function fetchCentralServerConfig() {
    try {
      var csData = await folioGet("/inn-reach/central-servers", {
        limit: "100",
      });
      var centralServers = csData.centralServers || [];
      if (centralServers.length > 0) {
        els.centralServerId.innerHTML = "";
        centralServers.forEach(function (cs) {
          var opt = document.createElement("option");
          opt.value = cs.id;
          opt.textContent = cs.name || cs.id;
          els.centralServerId.appendChild(opt);
        });
        // Restore saved selection
        var savedVal = els.centralServerId.dataset.savedValue;
        if (savedVal) {
          for (var i = 0; i < els.centralServerId.options.length; i++) {
            if (els.centralServerId.options[i].value === savedVal) {
              els.centralServerId.value = savedVal;
              break;
            }
          }
        }
        // Store localServerCode from selected central server
        var selectedCs = centralServers.find(function (cs) {
          return cs.id === els.centralServerId.value;
        });
        if (selectedCs) {
          cachedLocalServerCode = selectedCs.localServerCode || "";
        }
      }

      // Fetch agency code → description map from the agencies endpoint
      try {
        var agenciesData = await folioGet("/inn-reach/central-servers/agencies");
        var csAgencies = agenciesData.centralServerAgencies || [];
        cachedAgencyCodeMap = {};
        csAgencies.forEach(function (server) {
          var csId = server.centralServerId || "";
          var map = {};
          (server.agencies || []).forEach(function (agency) {
            if (agency.agencyCode && agency.description) {
              map[agency.agencyCode] = agency.description;
            }
          });
          cachedAgencyCodeMap[csId] = map;
        });
      } catch (e) {
        console.warn("[InnReachTools] Agency code fetch error:", e.message);
      }

      // Build server ID → code mapping
      var serverIdToCode = {};
      centralServers.forEach(function (cs) {
        serverIdToCode[cs.id] = cs.centralServerCode || cs.id;
      });

      // Fetch patron type mappings (keyed by centralServerCode)
      try {
        var ptData = await folioGet("/inn-reach/central-servers/patron-types");
        var csPatronTypes = ptData.centralServerPatronTypes || [];
        cachedPatronCodeMap = {};
        csPatronTypes.forEach(function (cpt) {
          var csCode = serverIdToCode[cpt.centralServerId] || cpt.centralServerId || "";
          var map = {};
          (cpt.patronTypes || []).forEach(function (pt) {
            if (pt.centralPatronType != null && pt.description) {
              map[pt.centralPatronType] = pt.description;
            }
          });
          cachedPatronCodeMap[csCode] = map;
        });
      } catch (e) {
        console.warn("[InnReachTools] Patron type fetch error:", e.message);
      }
    } catch (e) {
      console.warn("[InnReachTools] Central server config error:", e.message);
    }
  }

  // ======================== MUSTACHE RENDERER ========================

  function resolveKey(ctx, key) {
    if (key === ".") return ctx["."] != null ? ctx["."] : ctx;
    var parts = key.split(".");
    var val = ctx;
    for (var i = 0; i < parts.length; i++) {
      if (val == null || typeof val !== "object") return undefined;
      val = val[parts[i]];
    }
    return val;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderMustache(tpl, ctx) {
    // Section tags {{#key}}...{{/key}}
    tpl = tpl.replace(
      /\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      function (_m, key, body) {
        var val = resolveKey(ctx, key);
        if (!val || (Array.isArray(val) && val.length === 0)) return "";
        if (Array.isArray(val)) {
          return val
            .map(function (item) {
              return renderMustache(
                body,
                typeof item === "object"
                  ? Object.assign({}, ctx, item, { ".": item })
                  : Object.assign({}, ctx, { ".": item })
              );
            })
            .join("");
        }
        return renderMustache(body, ctx);
      }
    );
    // Inverted section tags {{^key}}...{{/key}}
    tpl = tpl.replace(
      /\{\{\^([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      function (_m, key, body) {
        var val = resolveKey(ctx, key);
        return !val || (Array.isArray(val) && val.length === 0)
          ? renderMustache(body, ctx)
          : "";
      }
    );
    // Unescaped {{{key}}}
    tpl = tpl.replace(/\{\{\{([\w.]+)\}\}\}/g, function (_m, key) {
      var val = resolveKey(ctx, key);
      return val != null ? String(val) : "";
    });
    // Escaped {{key}}
    tpl = tpl.replace(/\{\{([\w.]+)\}\}/g, function (_m, key) {
      var val = resolveKey(ctx, key);
      return val != null ? escapeHtml(val) : "";
    });
    return tpl;
  }

  // ======================== PAGING SLIPS: BUILD CONTEXT ========================

  function buildSlipContext(txn, item, agencyCodeMap, patronCodeMap, localServerCode) {
    var ecnc = item.effectiveCallNumberComponents || {};
    var volumeEnum =
      (item.displaySummary || "").trim() ||
      (
        ((item.volume || "").trim() || (item.enumeration || "").trim() || "") +
        " " +
        (item.chronology || "")
      ).trim();
    var callParts = [ecnc.prefix, ecnc.callNumber, ecnc.suffix, volumeEnum]
      .map(function (v) {
        return v == null ? "" : String(v);
      })
      .filter(Boolean);

    var itemObj = {
      title: item.title || "",
      author:
        item.contributorNames && item.contributorNames.length
          ? item.contributorNames[0].name || ""
          : "",
      barcode: item.barcode || "",
      effectiveCallNumber: callParts.join(" ").trim(),
      effectiveLocationFolioName:
        (item.effectiveLocation && item.effectiveLocation.name) || "",
      hrid: item.hrid || "",
      shelvingOrder: item.effectiveShelvingOrder || "",
    };

    var hold = txn.hold || {};
    var pickupParts = (hold.pickupLocation || "").split(":");
    var centralServerCode = txn.centralServerCode || hold.centralServerCode || "";
    var transactionObj = {
      centralServerCode: centralServerCode,
      localServerCode: localServerCode || "",
      pickupLocationPrintName: pickupParts.length > 2 ? pickupParts[2] : "",
      pickupLocationCode: pickupParts.length > 0 ? pickupParts[0] : "",
      pickupLocationDeliveryStop: pickupParts.length > 3 ? pickupParts[3] : "",
      patronAgencyCode: hold.patronAgencyCode || "",
      patronAgencyDescription: agencyCodeMap[hold.patronAgencyCode] || "",
      itemAgencyCode: hold.itemAgencyCode || "",
      itemAgencyDescription: agencyCodeMap[hold.itemAgencyCode] || "",
      patronName: hold.patronName || "",
      patronTypeCode: hold.centralPatronType || "",
      patronTypeDescription:
        (patronCodeMap[centralServerCode] || {})[hold.centralPatronType] || "",
    };

    return { item: itemObj, innReachTransaction: transactionObj };
  }

  // ======================== PAGING SLIPS: GENERATE ALL ========================

  async function generate() {
    if (!session.url || !session.tenant) {
      setStatus(
        "FOLIO URL and Tenant required. Check the Settings tab.",
        "error"
      );
      return;
    }

    var BATCH_SIZE = 10;
    var centralServerId = els.centralServerId.value.trim();
    var agencyCodeMap = cachedAgencyCodeMap[centralServerId] || {};
    if (!agencyCodeMap || Object.keys(agencyCodeMap).length === 0) {
      setStatus(
        "Agency code mappings not available. Check central server selection in Settings.",
        "error"
      );
      return;
    }

    saveSettings();
    els.btnGenerate.disabled = true;
    clearLog();

    try {
      setStatus("Fetching service points…", "info");
      var servicePoints = await folioGetAll(
        "/service-points",
        "servicepoints"
      );
      var allSpCodes = servicePoints.map(function (sp) {
        return sp.code;
      });

      var selectedCodes;
      if (els.allSPs.checked) {
        selectedCodes = allSpCodes;
      } else {
        var pfx = (els.prefix.value || "").toLowerCase();
        selectedCodes = allSpCodes.filter(function (c) {
          return c.toLowerCase().startsWith(pfx);
        });
      }
      if (selectedCodes.length === 0) {
        setStatus("No service points matched the selected prefix.", "error");
        return;
      }
      addLog("Selected " + selectedCodes.length + " service point code(s).");

      setStatus("Building location map…", "info");
      var spIdCodeMap = {};
      servicePoints.forEach(function (sp) {
        spIdCodeMap[sp.id] = sp.code;
      });
      var locations = await folioGetAll("/locations", "locations");
      var spLocations = {};
      for (var li = 0; li < locations.length; li++) {
        var loc = locations[li];
        for (var si = 0; si < (loc.servicePointIds || []).length; si++) {
          var spId = loc.servicePointIds[si];
          var code = spIdCodeMap[spId];
          if (code) {
            if (!spLocations[code]) spLocations[code] = [];
            spLocations[code].push(loc.id);
          }
        }
      }

      setStatus("Fetching Inn-Reach transactions…", "info");
      var transactions = await folioGetAll(
        "/inn-reach/transactions",
        "transactions",
        { type: "ITEM", state: ["ITEM_HOLD", "TRANSFER"] }
      );
      addLog("Fetched " + transactions.length + " transactions.");

      setStatus("Fetching paging slip template…", "info");
      var templateData = await folioGet(
        "/inn-reach/central-servers/" +
          centralServerId +
          "/paging-slip-template"
      );
      var template = templateData.template;

      var itemIds = transactions
        .map(function (t) {
          return t.hold && t.hold.folioItemId;
        })
        .filter(Boolean);

      setStatus("Fetching item & request data…", "info");
      var itemsMap = {};
      var requestsMap = {};

      for (var i = 0; i < itemIds.length; i += BATCH_SIZE) {
        var batch = itemIds.slice(i, i + BATCH_SIZE);
        showProgress(i, itemIds.length);
        setStatus(
          "Fetching items " +
            (i + 1) +
            "–" +
            Math.min(i + BATCH_SIZE, itemIds.length) +
            " of " +
            itemIds.length +
            "…",
          "info"
        );

        var itemQuery = "id==(" + batch.join(" or ") + ")";
        var batchItems = await folioGetCQL(
          "/inventory/items",
          "items",
          itemQuery
        );
        batchItems.forEach(function (it) {
          itemsMap[it.id] = it;
        });

        var reqQuery = batch
          .map(function (id) {
            return 'itemId==' + id + ' and status=="Open - *"';
          })
          .join(" or ");
        var batchReqs = await folioGetCQL(
          "/request-storage/requests",
          "requests",
          reqQuery
        );
        batchReqs.forEach(function (r) {
          requestsMap[r.itemId] = r;
        });
      }
      showProgress(itemIds.length, itemIds.length);

      setStatus("Assembling paging slips…", "info");
      var contextObjs = [];

      for (var ti = 0; ti < transactions.length; ti++) {
        var txn = transactions[ti];
        if (!txn.hold || !txn.hold.folioItemId) continue;
        var item = itemsMap[txn.hold.folioItemId];
        if (!item) continue;

        var contextObj = buildSlipContext(txn, item, agencyCodeMap, cachedPatronCodeMap, cachedLocalServerCode);
        var request = requestsMap[item.id];
        if (request) {
          if (!(request.status || "").startsWith("Open - Not yet filled")) {
            addLog(
              "Txn " +
                (txn.trackingId || "") +
                ": request status is " +
                (request.status || "Unknown") +
                " — " +
                (item.title || "No title")
            );
          }
          var itemLocId =
            item.effectiveLocation && item.effectiveLocation.id;
          var matchesSP = selectedCodes.some(function (sp) {
            return (spLocations[sp] || []).indexOf(itemLocId) !== -1;
          });
          var itemStatus = (item.status && item.status.name) || "";
          if (matchesSP && itemStatus !== "Checked out") {
            contextObjs.push(contextObj);
          }
        } else {
          addLog(
            "No request for txn " +
              (txn.trackingId || "") +
              ": " +
              ((item.status && item.status.name) || "Unknown") +
              " — " +
              (item.title || "No title")
          );
        }
      }

      contextObjs.sort(function (a, b) {
        var locCmp = a.item.effectiveLocationFolioName.localeCompare(
          b.item.effectiveLocationFolioName
        );
        return locCmp !== 0
          ? locCmp
          : a.item.effectiveCallNumber.localeCompare(
              b.item.effectiveCallNumber
            );
      });

      if (contextObjs.length === 0) {
        setStatus("No paging slips to print — all transactions are either checked out or missing requests.", "warning");
        return;
      }

      setStatus("Rendering " + contextObjs.length + " slips…", "info");
      var slips = contextObjs.map(function (ctx) {
        return (
          '<div style="page-break-after: always;">' +
          renderMustache(template, ctx) +
          "</div>"
        );
      });

      var fullHTML =
        '<!DOCTYPE html><html lang="en"><head><title>Inn-Reach Paging Slips (' +
        slips.length +
        ")</title></head><body>" +
        slips.join("\n") +
        '<script>window.onload=function(){window.print();}</' + 'script>' +
        "</body></html>";

      var blob = new Blob([fullHTML], { type: "text/html" });
      var blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank");

      setStatus(
        "Done — generated " + slips.length + " slips.",
        "success"
      );
      addLog("Opened slips in a new tab.");
    } catch (err) {
      console.error("[InnReachTools]", err);
      setStatus(err.message, "error");
    } finally {
      els.btnGenerate.disabled = false;
    }
  }

  // ======================== PAGING SLIPS: SINGLE SLIP ========================

  async function generateSingle() {
    var lookup = (els.singleLookup.value || "").trim();
    if (!lookup) {
      setStatus("Enter an item barcode or tracking ID.", "error");
      return;
    }
    if (!session.url || !session.tenant) {
      setStatus(
        "FOLIO URL and Tenant required. Check the Settings tab.",
        "error"
      );
      return;
    }

    var centralServerId = els.centralServerId.value.trim();
    var agencyCodeMap = cachedAgencyCodeMap[centralServerId] || {};

    saveSettings();
    els.btnSingle.disabled = true;
    clearLog();

    try {
      setStatus("Searching for transaction…", "info");

      var transactions = await folioGetAll(
        "/inn-reach/transactions",
        "transactions",
        { type: "ITEM" }
      );

      var match = null;
      for (var i = 0; i < transactions.length; i++) {
        if (transactions[i].trackingId === lookup) {
          match = transactions[i];
          break;
        }
      }
      if (!match) {
        for (var j = 0; j < transactions.length; j++) {
          if (
            transactions[j].hold &&
            transactions[j].hold.folioItemBarcode === lookup
          ) {
            match = transactions[j];
            break;
          }
        }
      }
      if (!match) {
        setStatus('No ITEM transaction found for "' + lookup + '".', "error");
        return;
      }

      addLog(
        "Found transaction: " +
          match.trackingId +
          " (" +
          match.state +
          ")"
      );

      var terminalStates = [
        "FINAL_CHECKIN",
        "CANCEL_REQUEST",
        "BORROWING_SITE_CANCEL",
      ];
      if (terminalStates.indexOf(match.state) !== -1) {
        setStatus(
          "Transaction " +
            match.trackingId +
            " is in " +
            match.state +
            " state — cannot print slip for terminal transactions.",
          "error"
        );
        return;
      }
      if (!match.hold || !match.hold.folioItemId) {
        setStatus("Transaction has no linked FOLIO item.", "error");
        return;
      }

      setStatus("Fetching item details…", "info");
      var items = await folioGetCQL(
        "/inventory/items",
        "items",
        "id==" + match.hold.folioItemId
      );
      if (items.length === 0) {
        setStatus("Item not found in inventory.", "error");
        return;
      }
      var item = items[0];

      setStatus("Fetching paging slip template…", "info");
      var templateData = await folioGet(
        "/inn-reach/central-servers/" +
          centralServerId +
          "/paging-slip-template"
      );
      var template = templateData.template;

      var contextObj = buildSlipContext(match, item, agencyCodeMap, cachedPatronCodeMap, cachedLocalServerCode);
      var rendered =
        '<div style="page-break-after: always;">' +
        renderMustache(template, contextObj) +
        "</div>";

      var fullHTML =
        '<!DOCTYPE html><html lang="en"><head><title>Inn-Reach Paging Slip — ' +
        escapeHtml(item.barcode || match.trackingId) +
        "</title></head><body>" +
        rendered +
        '<script>window.onload=function(){window.print();}</' + 'script>' +
        "</body></html>";

      var blob = new Blob([fullHTML], { type: "text/html" });
      var blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank");

      setStatus(
        "Done — printed slip for " +
          (item.barcode || match.trackingId) +
          ".",
        "success"
      );
    } catch (err) {
      console.error("[InnReachTools]", err);
      setStatus(err.message, "error");
    } finally {
      els.btnSingle.disabled = false;
    }
  }

  // ======================== FIX BROKEN HOLDS: HELPERS ========================

  async function isItemLoanedOut(itemId) {
    var loans = await folioGetCQL(
      "/loan-storage/loans",
      "loans",
      'itemId=="' + itemId + '" and status.name=="Open"'
    );
    return loans.length > 0;
  }

  async function isRequestClosed(requestId) {
    var req = await folioGet("/request-storage/requests/" + requestId);
    return (req.status || "").indexOf("Closed") !== -1;
  }

  async function closeLoan(itemBarcode) {
    var spId = await getDefaultServicePoint();
    if (!spId)
      throw new Error("No default service point found for current user.");

    await folioPost("/circulation/check-in-by-barcode", {
      itemBarcode: itemBarcode,
      servicePointId: spId,
      checkInDate: new Date().toISOString(),
    });
    addLog("Checked in item: " + itemBarcode);
  }

  async function reopenRequest(requestId) {
    var req = await folioGet("/request-storage/requests/" + requestId);
    var wasCancelled =
      (req.status || "").toLowerCase().indexOf("cancelled") !== -1;
    req.status = "Open - Not yet filled";
    await folioPut("/request-storage/requests/" + requestId, req);
    addLog('Reopened request: ' + requestId + ' → "Open - Not yet filled"');
    return { wasCancelled: wasCancelled, request: req };
  }

  async function cancelRequest(request) {
    request.status = "Closed - Cancelled";
    await folioPut("/request-storage/requests/" + request.id, request);
    addLog("Cancelled request: " + request.id);
  }

  async function reopenLoan(itemBarcode) {
    var spId = await getDefaultServicePoint();
    if (!spId)
      throw new Error("No default service point found for current user.");

    var result = await folioPost(
      "/inn-reach/transactions/" +
        itemBarcode +
        "/check-out-item/" +
        spId,
      {}
    );
    return result;
  }

  async function setOutDateDueDate(newLoan, outDate, dueDate) {
    var loanId = newLoan.folioCheckOut.id;
    var loan = await folioGet("/loan-storage/loans/" + loanId);
    loan.loanDate = outDate;
    loan.dueDate = dueDate;
    await folioPut("/loan-storage/loans/" + loanId, loan);
    addLog(
      "Restored dates on loan " +
        loanId +
        ": out=" +
        outDate +
        ", due=" +
        dueDate
    );
  }

  async function syncCancelledRequest(requestId) {
    var result = await reopenRequest(requestId);
    if (result.wasCancelled) {
      await cancelRequest(result.request);
    }
  }

  // ======================== FIX BROKEN HOLDS: LIST BROKEN ========================

  async function listBrokenTransactions() {
    clearLog();
    els.brokenResults.style.display = "none";
    els.btnListBroken.disabled = true;

    try {
      setStatus("Fetching transactions…", "info");
      var transactions = await folioGetAll(
        "/inn-reach/transactions",
        "transactions",
        { type: "ITEM", state: ["ITEM_HOLD", "TRANSFER"] }
      );
      addLog("Fetched " + transactions.length + " transactions.");

      var itemIds = [];
      transactions.forEach(function (t) {
        var itemId = t.hold && t.hold.folioItemId;
        if (itemId) itemIds.push(itemId);
      });

      addLog(
        "Fetching item and request data for " + itemIds.length + " items…"
      );
      var itemsMap = {};
      var requestsMap = {};
      var BATCH_SIZE = 10;

      for (var i = 0; i < itemIds.length; i += BATCH_SIZE) {
        var batch = itemIds.slice(i, i + BATCH_SIZE);
        showProgress(i, itemIds.length);
        setStatus(
          "Fetching items " +
            (i + 1) +
            "–" +
            Math.min(i + BATCH_SIZE, itemIds.length) +
            " of " +
            itemIds.length +
            "…",
          "info"
        );

        var itemQuery = "id==(" + batch.join(" or ") + ")";
        var batchItems = await folioGetCQL(
          "/inventory/items",
          "items",
          itemQuery
        );
        batchItems.forEach(function (it) {
          itemsMap[it.id] = it;
        });

        var reqQuery = batch
          .map(function (id) {
            return 'itemId==' + id + ' and status=="Open - *"';
          })
          .join(" or ");
        var batchReqs = await folioGetCQL(
          "/request-storage/requests",
          "requests",
          reqQuery
        );
        batchReqs.forEach(function (r) {
          requestsMap[r.itemId] = r;
        });
      }
      showProgress(itemIds.length, itemIds.length);
      addLog(
        "Fetched " +
          Object.keys(itemsMap).length +
          " items and " +
          Object.keys(requestsMap).length +
          " requests."
      );

      // Identify broken transactions
      var broken = [];
      transactions.forEach(function (txn) {
        var itemId = txn.hold && txn.hold.folioItemId;
        if (!itemId) return;
        var item = itemsMap[itemId];
        if (item) {
          if (!requestsMap[item.id]) {
            broken.push({
              trackingId: txn.trackingId,
              state: txn.state,
              itemStatus:
                (item.status && item.status.name) || "Unknown",
              requestId: (txn.hold && txn.hold.folioRequestId) || "",
              requestStatus: "",
              itemBarcode: item.barcode || "",
              title: item.title || "No title",
            });
            addLog(
              "Broken: " +
                txn.trackingId +
                " — " +
                ((item.status && item.status.name) || "Unknown") +
                " — " +
                (item.title || ""),
              "error"
            );
          }
        } else {
          broken.push({
            trackingId: txn.trackingId,
            state: txn.state,
            itemStatus: "Item not found",
            requestId: (txn.hold && txn.hold.folioRequestId) || "",
            requestStatus: "",
            itemBarcode: (txn.hold && txn.hold.folioItemBarcode) || "",
            title: "",
          });
          addLog(
            "Item not found: " + txn.trackingId + " (ID: " + itemId + ")",
            "error"
          );
        }
      });

      // Fetch request statuses for broken transactions
      var reqIds = broken.map(function (b) { return b.requestId; }).filter(Boolean);
      if (reqIds.length > 0) {
        setStatus("Fetching request statuses…", "info");
        for (var ri = 0; ri < reqIds.length; ri += BATCH_SIZE) {
          var reqBatch = reqIds.slice(ri, ri + BATCH_SIZE);
          var reqCql = "id==(" + reqBatch.join(" or ") + ")";
          var reqs = await folioGetCQL("/request-storage/requests", "requests", reqCql);
          var reqStatusMap = {};
          reqs.forEach(function (r) { reqStatusMap[r.id] = r.status || "Unknown"; });
          broken.forEach(function (b) {
            if (b.requestId && reqStatusMap[b.requestId]) {
              b.requestStatus = reqStatusMap[b.requestId];
            }
          });
        }
      }

      // Populate table
      populateBrokenTable(broken);
      hideProgress();
      setStatus(
        "Found " + broken.length + " broken transaction(s).",
        broken.length > 0 ? "warning" : "success"
      );
    } catch (err) {
      console.error("[InnReachTools]", err);
      setStatus(err.message, "error");
    } finally {
      els.btnListBroken.disabled = false;
    }
  }

  function populateBrokenTable(rows) {
    els.brokenTbody.innerHTML = "";
    els.selectAllBroken.checked = false;
    els.btnSyncSelected.disabled = true;

    if (rows.length === 0) {
      els.brokenResults.style.display = "none";
      return;
    }

    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><input type="checkbox" class="broken-cb" data-id="' +
        escapeHtml(row.trackingId) +
        '"></td>' +
        "<td>" +
        escapeHtml(row.trackingId) +
        "</td>" +
        "<td>" +
        escapeHtml(row.state) +
        "</td>" +
        "<td>" +
        escapeHtml(row.itemStatus) +
        "</td>" +
        "<td>" +
        escapeHtml(row.requestStatus || "No request") +
        "</td>" +
        "<td>" +
        escapeHtml(row.itemBarcode) +
        "</td>" +
        "<td>" +
        escapeHtml(row.title) +
        "</td>" +
        '<td class="sync-status"></td>';
      els.brokenTbody.appendChild(tr);
    });

    els.brokenCount.textContent = rows.length + " broken transaction(s)";
    els.brokenResults.style.display = "block";
    updateSyncSelectedBtn();
  }

  function updateSyncSelectedBtn() {
    var checked = shadow.querySelectorAll(".broken-cb:checked");
    els.btnSyncSelected.disabled = checked.length === 0;
    // Auto-populate the manual sync input with selected tracking IDs
    var ids = [];
    checked.forEach(function (cb) { ids.push(cb.getAttribute("data-id")); });
    els.syncIds.value = ids.join(", ");
  }

  // ======================== FIX BROKEN HOLDS: SYNC ========================

  async function syncItemHold(trackingId) {
    addLog("--- Processing: " + trackingId + " ---");

    // Find the transaction
    var txnData = await folioGet("/inn-reach/transactions", {
      query: trackingId,
      limit: "10",
    });
    var results = txnData.transactions || [];

    if (results.length !== 1) {
      addLog(
        "No transaction (or multiple) found for: " + trackingId,
        "error"
      );
      return false;
    }
    var transaction = results[0];
    addLog(
      "Found transaction: " +
        transaction.trackingId +
        " (" +
        transaction.state +
        ")"
    );

    // Check for other active transactions on the same item
    var itemBarcode = (transaction.hold || {}).folioItemBarcode;
    if (itemBarcode) {
      var otherTxnData = await folioGet("/inn-reach/transactions", {
        itemBarcode: itemBarcode,
        type: "ITEM",
        sortBy: "transactionTime",
        sortOrder: "asc",
        limit: "100",
      });
      var others = (otherTxnData.transactions || []).filter(function (x) {
        return (
          (x.state === "ITEM_HOLD" || x.state === "TRANSFER") &&
          x.trackingId !== trackingId
        );
      });
      if (others.length > 0) {
        var msg =
          "Other active ITEM transactions for barcode " +
          itemBarcode +
          ":\n";
        others.forEach(function (tx) {
          msg += "  • " + tx.trackingId + " (" + tx.state + ")\n";
        });
        addLog(msg, "warn");
        if (
          !confirm(msg + "\nContinue processing " + trackingId + "?")
        ) {
          addLog("Skipped: " + trackingId);
          return false;
        }
      }
    }

    // Verify state
    if (
      transaction.state !== "ITEM_HOLD" &&
      transaction.state !== "TRANSFER"
    ) {
      addLog(
        "Transaction is in " +
          transaction.state +
          " state — not ITEM_HOLD or TRANSFER. Skipping.",
        "warn"
      );
      return false;
    }

    var itemId = (transaction.hold || {}).folioItemId;
    var requestId = (transaction.hold || {}).folioRequestId;
    var loanedOut = await isItemLoanedOut(itemId);

    if (loanedOut) {
      // Get the open loan
      var loans = await folioGetCQL(
        "/loan-storage/loans",
        "loans",
        'itemId=="' + itemId + '" and status.name=="Open"'
      );
      if (loans.length === 0) {
        addLog("No open loan found for item: " + itemId, "error");
        return false;
      }
      var folioLoan = loans[0];
      addLog(
        "Open loan found. Status: " +
          ((folioLoan.status || {}).name || "Unknown")
      );

      var holdPatronId = (transaction.hold || {}).folioPatronId;
      var loanUserId = folioLoan.userId;
      var loanOutDate = folioLoan.loanDate;
      var loanDueDate = folioLoan.dueDate;

      if (holdPatronId === loanUserId) {
        addLog("Loan user matches hold patron: " + loanUserId);
        var reqClosed = await isRequestClosed(requestId);

        // Close loan
        addLog("Closing loan…");
        await closeLoan(itemBarcode);

        // Reopen request if closed
        if (reqClosed) {
          addLog(
            "Request " + requestId + " is closed. Reopening…"
          );
          await reopenRequest(requestId);
        }

        // Reopen loan via Inn-Reach checkout
        addLog("Reopening loan via Inn-Reach checkout…");
        var newLoan = await reopenLoan(itemBarcode);
        if (!newLoan || !newLoan.folioCheckOut) {
          addLog("Failed to create new loan.", "error");
          return false;
        }
        addLog("New loan created: " + newLoan.folioCheckOut.id);

        // Restore original dates
        addLog("Restoring original loan dates…");
        await setOutDateDueDate(newLoan, loanOutDate, loanDueDate);
        addLog("✓ Sync complete for " + trackingId);
        return true;
      } else {
        addLog(
          "Patron mismatch: loan user " +
            loanUserId +
            " ≠ hold patron " +
            holdPatronId +
            ". Syncing cancelled request…",
          "warn"
        );
        await syncCancelledRequest(requestId);
        addLog("✓ Sync complete for " + trackingId);
        return true;
      }
    } else {
      var reqClosed2 = await isRequestClosed(requestId);
      if (reqClosed2) {
        addLog(
          "Item not loaned out, request closed. Syncing cancelled request…",
          "warn"
        );
        await syncCancelledRequest(requestId);
        addLog("✓ Sync complete for " + trackingId);
        return true;
      } else {
        addLog(
          "Item not loaned out and request is open. No action needed."
        );
        return true;
      }
    }
  }

  async function syncSelectedFromTable() {
    var checked = shadow.querySelectorAll(".broken-cb:checked");
    if (checked.length === 0) return;

    var ids = [];
    checked.forEach(function (cb) {
      ids.push(cb.getAttribute("data-id"));
    });

    if (
      !confirm(
        "Sync " +
          ids.length +
          " transaction(s)? This will modify loans and requests in FOLIO."
      )
    ) {
      return;
    }

    els.btnSyncSelected.disabled = true;
    clearLog();
    setStatus("Syncing " + ids.length + " transaction(s)…", "info");

    for (var i = 0; i < ids.length; i++) {
      var trackingId = ids[i];
      showProgress(i, ids.length);
      setStatus(
        "Syncing " + (i + 1) + " of " + ids.length + "…",
        "info"
      );

      // Find the row's status cell
      var cb = shadow.querySelector(
        '.broken-cb[data-id="' + trackingId + '"]'
      );
      var row = cb ? cb.closest("tr") : null;
      var statusCell = row ? row.querySelector(".sync-status") : null;

      try {
        var ok = await syncItemHold(trackingId);
        if (statusCell) {
          statusCell.textContent = ok ? "✓ Synced" : "— Skipped";
          statusCell.className =
            "sync-status " + (ok ? "synced" : "pending");
        }
      } catch (err) {
        addLog("Error syncing " + trackingId + ": " + err.message, "error");
        if (statusCell) {
          statusCell.textContent = "✗ Failed";
          statusCell.className = "sync-status failed";
        }
      }
    }
    showProgress(ids.length, ids.length);
    setStatus("Sync complete.", "success");
    els.btnSyncSelected.disabled = false;
  }

  async function syncManual() {
    var input = (els.syncIds.value || "").trim();
    if (!input) {
      setStatus("Enter one or more tracking IDs.", "error");
      return;
    }

    var ids = input
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);

    if (
      !confirm(
        "Sync " +
          ids.length +
          " transaction(s)? This will modify loans and requests in FOLIO."
      )
    ) {
      return;
    }

    els.btnSyncManual.disabled = true;
    clearLog();

    for (var i = 0; i < ids.length; i++) {
      showProgress(i, ids.length);
      setStatus(
        "Syncing " + (i + 1) + " of " + ids.length + "…",
        "info"
      );
      try {
        await syncItemHold(ids[i]);
      } catch (err) {
        addLog("Error syncing " + ids[i] + ": " + err.message, "error");
      }
    }
    showProgress(ids.length, ids.length);
    setStatus("Sync complete.", "success");
    els.btnSyncManual.disabled = false;
  }

  // ======================== INIT ========================

  async function init() {
    setStatus("Detecting FOLIO session…", "info");

    // Session was pre-detected by background.js (MAIN world + cookies)
    var detected = await detectSession();

    if (detected.url) session.url = detected.url;
    if (detected.tenant) session.tenant = detected.tenant;
    if (detected.token) session.token = detected.token;
    if (detected.userId) cachedUserId = detected.userId;

    // If URL not detected, derive from page origin
    if (!session.url && detected.origin) {
      session.url = detected.origin;
    }

    // Populate settings fields
    if (session.url) els.okapiUrl.value = session.url;
    if (session.tenant) els.okapiTenant.value = session.tenant;

    // Update tenant display
    if (session.tenant) {
      els.tenantInfo.textContent =
        session.tenant + (session.url ? " — " + session.url : "");
    }

    // Load saved per-tenant settings
    var saved = await loadSettings();
    if (saved) {
      applySettings(saved);
      // If saved has a different URL, prefer it
      if (saved.okapiUrl) {
        session.url = saved.okapiUrl;
        els.okapiUrl.value = saved.okapiUrl;
      }
    }

    if (!session.url || !session.tenant) {
      setStatus(
        "Could not detect FOLIO session. Enter connection details in the Settings tab.",
        "error"
      );
      // Switch to settings tab
      tabBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      tabContents.forEach(function (tc) {
        tc.classList.remove("active");
      });
      shadow.querySelector('[data-tab="settings"]').classList.add("active");
      $("tab-settings").classList.add("active");
      return;
    }

    // Fetch central server config
    await fetchCentralServerConfig();

    // Save current settings
    saveSettings();

    // Verify connectivity
    try {
      await folioGetAll("/service-points", "servicepoints");
      clearStatus();
    } catch (e) {
      setStatus(
        "Connected but API call failed: " +
          e.message.split("\n")[0] +
          ". Check Settings and ensure you are logged into FOLIO.",
        "error"
      );
    }
  }

  init();

  // ======================== EVENT LISTENERS ========================

  // Paging Slips
  els.btnGenerate.addEventListener("click", generate);
  els.btnSingle.addEventListener("click", generateSingle);
  els.singleLookup.addEventListener("keydown", function (e) {
    if (e.key === "Enter") generateSingle();
  });
  els.allSPs.addEventListener("change", function () {
    els.prefix.disabled = els.allSPs.checked;
  });

  // Fix Broken Holds
  els.btnListBroken.addEventListener("click", listBrokenTransactions);
  els.btnSyncSelected.addEventListener("click", syncSelectedFromTable);
  els.btnSyncManual.addEventListener("click", syncManual);
  els.syncIds.addEventListener("keydown", function (e) {
    if (e.key === "Enter") syncManual();
  });

  // Table checkboxes
  els.selectAllBroken.addEventListener("change", function () {
    var cbs = shadow.querySelectorAll(".broken-cb");
    cbs.forEach(function (cb) {
      cb.checked = els.selectAllBroken.checked;
    });
    updateSyncSelectedBtn();
  });
  els.brokenTbody.addEventListener("change", function (e) {
    if (e.target.classList.contains("broken-cb")) {
      updateSyncSelectedBtn();
    }
  });

  // Log toggle
  els.logToggle.addEventListener("click", function () {
    var visible = els.log.classList.toggle("visible");
    els.logToggle.textContent = visible ? "Hide Log " : "Show Log ";
    els.logToggle.appendChild(els.logCount);
  });

  // Settings
  els.btnSaveSettings.addEventListener("click", function () {
    // Sync manual URL/tenant edits back to session
    var url = els.okapiUrl.value.trim();
    var tenant = els.okapiTenant.value.trim();
    if (url) session.url = url;
    if (tenant) session.tenant = tenant;
    saveSettings();
    setStatus("Settings saved.", "success");
    // Re-fetch central server config with new settings
    fetchCentralServerConfig();
  });
})();
