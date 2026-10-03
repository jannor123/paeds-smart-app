(function () {
  "use strict";
  var cfg = window.EXPLORER_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };
  var store = [];          // one entry per query: { q, url, resources, status, message, capped }
  var meta = { server: null, patient: null };
  var textCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  /* ---------- helpers to describe any resource ---------- */

  function codeable(r) {
    return r.code || r.medicationCodeableConcept || r.vaccineCode || (Array.isArray(r.type) ? r.type[0] : r.type) || null;
  }
  function labelOf(r) {
    var x = codeable(r);
    if (!x || typeof x !== "object") return r.resourceType;
    if (x.text) return x.text;
    var codings = x.coding || [];
    for (var i = 0; i < codings.length; i++) if (codings[i].display) return codings[i].display;
    return codings[0] && codings[0].code ? codings[0].code : "(unlabelled)";
  }
  function codesOf(r) {
    var x = codeable(r);
    if (!x || !x.coding) return "";
    return x.coding.map(function (c) { return (c.system || "").replace(/^https?:\/\//, "").split("/").slice(-1)[0] + "|" + c.code; }).join(", ");
  }
  function whenOf(r) {
    return r.effectiveDateTime || (r.effectivePeriod && (r.effectivePeriod.end || r.effectivePeriod.start)) || r.onsetDateTime ||
      r.recordedDate || r.authoredOn || r.occurrenceDateTime || (r.period && r.period.start) || r.issued || (r.meta && r.meta.lastUpdated) || "";
  }
  function group(entries) {
    var map = {};
    entries.forEach(function (e) {
      var key = e.type + "||" + labelOf(e.r);
      var g = map[key] || (map[key] = { type: e.type, label: labelOf(e.r), count: 0, latest: "", codes: codesOf(e.r) });
      g.count++;
      var w = whenOf(e.r);
      if (w > g.latest) g.latest = w;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.count - a.count; });
  }

  /* ---------- networking ---------- */

  function httpStatus(err) {
    if (!err) return null;
    if (err.statusCode) return err.statusCode;
    var m = /^\s*(\d{3})\b/.exec(err.message || "");
    return m ? +m[1] : null;
  }
  function withRetry(fn, tries) {
    var attempt = 0;
    function go() {
      return fn().catch(function (err) {
        attempt++;
        var st = httpStatus(err);
        if (attempt < tries && (st === null || st >= 500 || st === 429)) {
          return new Promise(function (r) { setTimeout(r, 1500 * attempt); }).then(go);
        }
        throw err;
      });
    }
    return go();
  }

  function runQueries(client) {
    var chain = Promise.resolve();
    cfg.queries.forEach(function (q, idx) {
      chain = chain.then(function () {
        $("progress").textContent = "Reading " + (idx + 1) + " of " + cfg.queries.length + ": " + q.label + "…";
        var url = q.type + "?patient=" + encodeURIComponent(client.patient.id) + (q.params ? "&" + q.params : "") + "&_count=" + cfg.pageSize;
        return withRetry(function () { return client.request(url, { pageLimit: cfg.maxPages, flat: true }); }, 2)
          .then(function (list) {
            var res = (list || []).filter(function (r) { return r && r.resourceType === q.type; });
            store.push({ q: q, url: url, resources: res, status: "ok", capped: res.length >= cfg.pageSize * cfg.maxPages });
          }, function (err) {
            store.push({ q: q, url: url, resources: [], status: "error", code: httpStatus(err), message: (err && err.message ? err.message : String(err)).slice(0, 300) });
          })
          .then(renderResults);
      });
    });
    return chain.then(function () {
      var total = store.reduce(function (n, s) { return n + s.resources.length; }, 0);
      var failed = store.filter(function (s) { return s.status === "error"; }).length;
      $("progress").textContent = "Done. " + total + " resources retrieved from " + (store.length - failed) + " of " + store.length + " queries" +
        (failed ? "; " + failed + " failed (see the Result column)." : ".");
      $("downloadBtn").disabled = false;
    });
  }

  /* ---------- rendering ---------- */

  function renderResults() {
    $("resultsBody").innerHTML = store.map(function (s) {
      var groups = group(s.resources.map(function (r) { return { type: s.q.type, r: r }; }));
      var result;
      if (s.status === "error") {
        result = '<span class="chip invalid">' + (s.code ? "HTTP " + s.code : "Failed") + "</span> <span class='small muted'>" + esc(s.message) + "</span>";
      } else if (!s.resources.length) {
        result = '<span class="chip missing">Nothing returned</span>';
      } else {
        result = '<span class="chip ok">Retrieved</span>' + (s.capped ? ' <span class="chip stale">stopped at the page cap, more may exist</span>' : "") +
          "<details><summary>" + groups.length + " distinct item" + (groups.length === 1 ? "" : "s") + "</summary><div class='scroll'><table><tbody>" +
          groups.slice(0, 40).map(function (g) {
            return "<tr><td>" + esc(g.label) + "</td><td class='num'>" + g.count + "</td><td class='mono'>" + esc(g.codes) + "</td></tr>";
          }).join("") + (groups.length > 40 ? "<tr><td colspan='3' class='muted'>… and " + (groups.length - 40) + " more (use the search or the download)</td></tr>" : "") +
          "</tbody></table></div></details>";
      }
      return "<tr><td>" + esc(s.q.label) + "</td><td>" + result + "</td><td class='num'>" + s.resources.length + "</td></tr>";
    }).join("");
  }

  function haystack(r) {
    if (textCache && textCache.has(r)) return textCache.get(r);
    var t = JSON.stringify(r).toLowerCase();
    if (textCache) textCache.set(r, t);
    return t;
  }

  function renderSearch() {
    var q = $("q").value.trim().toLowerCase();
    if (!q) { $("searchBody").innerHTML = '<tr><td colspan="5" class="muted">Nothing searched yet.</td></tr>'; return; }
    var hits = [];
    store.forEach(function (s) {
      s.resources.forEach(function (r) { if (haystack(r).indexOf(q) !== -1) hits.push({ type: s.q.label, r: r }); });
    });
    if (!hits.length) { $("searchBody").innerHTML = '<tr><td colspan="5" class="muted">No match in the retrieved data.</td></tr>'; return; }
    var gs = group(hits.map(function (h) { return { type: h.type, r: h.r }; }));
    $("searchBody").innerHTML = gs.slice(0, 60).map(function (g) {
      return "<tr><td>" + esc(g.type) + "</td><td>" + esc(g.label) + "</td><td class='num'>" + g.count + "</td><td>" +
        esc(g.latest ? g.latest.slice(0, 10) : "") + "</td><td class='mono'>" + esc(g.codes) + "</td></tr>";
    }).join("") + (gs.length > 60 ? '<tr><td colspan="5" class="muted">… and ' + (gs.length - 60) + " more. Narrow the search.</td></tr>" : "");
  }

  function download() {
    var out = { fetchedAt: new Date().toISOString(), server: meta.server, patient: meta.patient, queries: store.map(function (s) {
      return { label: s.q.label, url: s.url, status: s.status, message: s.message || null, resources: s.resources };
    }) };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sandbox-record-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function showError(html) {
    $("subtitle").textContent = "";
    $("errorBox").innerHTML = html;
    $("errorBox").classList.remove("hidden");
    $("app").classList.add("hidden");
  }

  /* ---------- start ---------- */

  function boot() {
    FHIR.oauth2.ready().then(function (client) {
      meta.server = client.state.serverUrl;
      var sandbox = meta.server.indexOf(cfg.sandboxTenant) !== -1;
      if (!sandbox && !cfg.allowNonSandbox) {
        showError("<strong>Refused.</strong> This explorer only reads the Cerner sandbox tenant. The server it was launched against is not that tenant, so nothing was read.<br><span class='small'>" + esc(meta.server) + "</span>");
        return;
      }
      return client.patient.read().then(function (p) {
        meta.patient = p;
        $("errorBox").classList.add("hidden");
        $("app").classList.remove("hidden");
        $("subtitle").textContent = "Reading everything the granted scopes allow for the launched patient.";
        $("statusBar").innerHTML = "<span>Server: " + esc(meta.server) + "</span><span>Scopes granted: " +
          esc((client.state.tokenResponse && client.state.tokenResponse.scope) || "(not reported)") + "</span>";
        var name = p.name && p.name[0] ? (p.name[0].text || [(p.name[0].given || []).join(" "), p.name[0].family].join(" ")) : "Unnamed";
        $("patientBox").innerHTML = "<p style='margin:0'><strong>" + esc(name) + "</strong>, born " + esc(p.birthDate || "unknown") +
          ", " + esc(p.gender || "sex not recorded") + "<br><span class='muted small'>Patient id " + esc(p.id) + "</span></p>";
        $("downloadBtn").addEventListener("click", download);
        var t = null;
        $("q").addEventListener("input", function () { clearTimeout(t); t = setTimeout(renderSearch, 250); });
        return runQueries(client);
      });
    }).catch(function (err) {
      showError("<strong>Could not start.</strong> Open this from the Code Console test launcher for the explorer app, not directly.<br><span class='muted small'>Detail: " + esc(err && err.message ? err.message : err) + "</span>");
    });
  }

  boot();
})();
