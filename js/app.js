(function () {
  "use strict";
  var E = window.PathEngine;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function monthsSpan(m) {
    return m >= 12 && m % 12 === 0 ? (m / 12) + (m === 12 ? " year" : " years") : m + (m === 1 ? " month" : " months");
  }
  function fmtBand(b) { return monthsSpan(b.fromMonths) + " to under " + monthsSpan(b.toMonths); }
  function fmtPatientAge(m) { return m < 24 ? m + (m === 1 ? " month" : " months") : Math.floor(m / 12) + " years"; }

  var params = new URLSearchParams(location.search);
  var DEMO_MODE = params.has("demo");
  var PW_OK = /^(pathway\.json|pathways\/[A-Za-z0-9._-]+\.json)$/;
  // The clinician normally chooses the pathway from the dropdown. For testing, a pathway can be
  // preselected from the address (?pathway=...) or from config.js (live launches lose the query string).
  var PRESELECT = null;
  var cfgPath = window.APP_CONFIG && window.APP_CONFIG.pathway;
  if (cfgPath && PW_OK.test(cfgPath)) PRESELECT = cfgPath;
  var reqPath = params.get("pathway");
  if (reqPath && PW_OK.test(reqPath)) PRESELECT = reqPath;

  var S = {
    pw: null,
    manifest: [],
    loadToken: 0,
    client: null,
    patientRes: null,
    observations: [],
    fetchedAt: null,
    serverUrl: null,
    lastRequests: [],
    lastCount: null,
    failures: {},
    unavailable: [],
    grantedScope: null,
    demoKey: "a",
    manual: {},
    manualKeys: []
  };
  var auditLog = [];
  var current = null;

  function showError(html) {
    $("subtitle").textContent = "";
    $("errorBox").innerHTML = html;
    $("errorBox").classList.remove("hidden");
    $("app").classList.add("hidden");
  }

  function allLoincCodes(pw) {
    var codes = [];
    Object.keys(pw.inputs).forEach(function (k) { if (pw.inputs[k].loinc) codes = codes.concat(pw.inputs[k].loinc); });
    pw.context.forEach(function (c) { codes = codes.concat(c.loinc); });
    return codes.filter(function (c, i) { return codes.indexOf(c) === i; });
  }

  /* ---------- Data loading ---------- */

  var PAGE_SIZE = 20, TRIES = 2;

  function httpStatus(err) {
    if (!err) return null;
    if (err.statusCode) return err.statusCode;
    if (err.status) return err.status;
    var m = /^\s*(\d{3})\b/.exec(err.message || "");
    return m ? +m[1] : null;
  }

  // Retry timeouts, server errors and network failures. Client errors (401, 403, 404) are not retried.
  function withRetry(fn, tries) {
    var attempt = 0;
    function go() {
      return fn().catch(function (err) {
        attempt++;
        var st = httpStatus(err);
        var retryable = st === null || st >= 500 || st === 429;
        if (attempt < tries && retryable) {
          return new Promise(function (r) { setTimeout(r, 1500 * attempt); }).then(go);
        }
        throw err;
      });
    }
    return go();
  }

  function loadObservations() {
    if (DEMO_MODE) {
      S.patientRes = window.DEMO[S.demoKey].patient;
      S.observations = window.DEMO[S.demoKey].observations;
      S.failures = {}; S.unavailable = []; S.lastRequests = [];
      S.fetchedAt = Date.now();
      return Promise.resolve();
    }
    // One small request per LOINC code. A single request for all codes timed out on the sandbox,
    // and separate requests let one failure be reported precisely instead of losing everything.
    var codes = allLoincCodes(S.pw);
    var failures = {}, all = [], urls = [];
    return Promise.all(codes.map(function (code) {
      var url = "Observation?patient=" + encodeURIComponent(S.client.patient.id) +
        "&code=" + encodeURIComponent("http://loinc.org|" + code) + "&_count=" + PAGE_SIZE;
      urls.push(url);
      return withRetry(function () { return S.client.request(url, { pageLimit: 1, flat: true }); }, TRIES)
        .then(function (list) {
          list = list || [];
          all = all.concat(list);
          // Cerner returns observations newest first, so the first page holds the latest values.
          // If a full page comes back in any other order, that guarantee does not hold: treat as not retrieved.
          if (list.length >= PAGE_SIZE && !E.isNewestFirst(list)) {
            failures[code] = "a full page of " + list.length + " observations was not newest-first, so the newest value may be missing";
          }
        }, function (err) {
          failures[code] = err && err.message ? err.message : String(err);
        });
    })).then(function () {
      var seen = {};
      S.observations = all.filter(function (o) {
        if (!o.id) return true;
        if (seen[o.id]) return false;
        seen[o.id] = true; return true;
      });
      S.failures = failures;
      S.unavailable = Object.keys(failures);
      S.lastRequests = urls;
      S.lastCount = S.observations.length;
      S.fetchedAt = Date.now();
    });
  }

  function boot() {
    // If the EHR launched this page directly (launch URI set to index.html), hand over to launch.html.
    if (!DEMO_MODE && params.has("iss") && params.has("launch") && !params.has("state")) {
      location.replace("launch.html" + location.search);
      return Promise.resolve();
    }
    return fetch("pathways/manifest.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load pathways/manifest.json (HTTP " + r.status + ")");
        return r.json();
      })
      .then(function (m) {
        S.manifest = ((m && m.pathways) || []).filter(function (p) { return p && p.label && PW_OK.test(p.file); });
        if (!S.manifest.length) throw new Error("pathways/manifest.json lists no usable pathways");
        if (PRESELECT && !S.manifest.some(function (p) { return p.file === PRESELECT; })) {
          S.manifest.push({ file: PRESELECT, label: "From address or config: " + PRESELECT, description: "Not listed in the pathway manifest." });
        }
        if (DEMO_MODE) { S.patientRes = window.DEMO[S.demoKey].patient; return null; }
        return FHIR.oauth2.ready().then(function (client) {
          S.client = client;
          S.serverUrl = client.state.serverUrl;
          S.grantedScope = client.state.tokenResponse && client.state.tokenResponse.scope;
          return client.patient.read().then(function (p) { S.patientRes = p; });
        });
      })
      .then(function () {
        $("errorBox").classList.add("hidden");
        $("app").classList.remove("hidden");
        $("subtitle").textContent = "Choose a pathway to begin.";
        setupOnce();
        showPatientLine();
        if (PRESELECT) { $("pathwaySelect").value = PRESELECT; return choosePathway(PRESELECT); }
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        if (!DEMO_MODE && /no.*state|launch|sessionStorage|key/i.test(msg)) {
          showError("<strong>No SMART session found.</strong> Open this app from PowerChart or the Code Console test launcher so it receives a patient. To look at the interface with synthetic data, add <code>?demo=1</code> to the address.<br><span class='muted small'>Detail: " + esc(msg) + "</span>");
        } else {
          showError("<strong>Could not load patient data.</strong> " + esc(msg));
        }
      });
  }

  /* ---------- Interface ---------- */

  function showPatientLine() {
    var p = E.buildPatientState(S.patientRes, [], Date.now());
    var text = "Patient: " + p.name + ", " + (p.ageMonths === null ? "age unknown" : fmtPatientAge(p.ageMonths));
    if (p.ageMonths !== null && p.ageMonths >= E.MAX_AGE_MONTHS) {
      text += ". This patient is 18 or over: paediatric age bands will not apply.";
    }
    $("patientLine").textContent = text;
  }

  // Load, validate and apply the chosen pathway, then fetch the data it needs.
  function choosePathway(file) {
    var token = ++S.loadToken;
    $("pathwayError").classList.add("hidden");
    if (!file) {
      S.pw = null;
      $("work").classList.add("hidden");
      $("loadBanner").classList.add("hidden");
      $("pathwayDesc").textContent = "No classification is shown until you choose a pathway.";
      $("subtitle").textContent = "Choose a pathway to begin.";
      return Promise.resolve();
    }
    var entry = S.manifest.filter(function (p) { return p.file === file; })[0];
    $("pathwayDesc").textContent = "Loading…";
    return fetch(file, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load " + file + " (HTTP " + r.status + ")");
        return r.json();
      })
      .then(function (pw) {
        if (token !== S.loadToken) return null;
        var problems = E.validatePathway(pw);
        if (problems.length) { var e = new Error("PATHWAY_INVALID"); e.list = problems; throw e; }
        S.pw = pw;
        S.manual = {};
        $("defJson").textContent = JSON.stringify(pw, null, 2);
        applyPathwayUi();
        return loadObservations().then(function () {
          if (token !== S.loadToken) return;
          $("pathwayDesc").textContent = entry && entry.description ? entry.description : "";
          $("subtitle").textContent = S.pw.name + ", version " + S.pw.version;
          $("work").classList.remove("hidden");
          render();
        });
      })
      .catch(function (err) {
        if (token !== S.loadToken) return;
        S.pw = null;
        $("work").classList.add("hidden");
        $("loadBanner").classList.add("hidden");
        $("pathwayDesc").textContent = "";
        $("subtitle").textContent = "Choose a pathway to begin.";
        var box = $("pathwayError");
        if (err && err.list) {
          box.innerHTML = "<strong>This pathway file has problems and will not be used.</strong> Nothing is classified until they are fixed in " + esc(file) + ".<ul>" +
            err.list.slice(0, 12).map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") +
            (err.list.length > 12 ? "<li>… and " + (err.list.length - 12) + " more</li>" : "") + "</ul>";
        } else {
          box.innerHTML = "<strong>Could not load that pathway.</strong> " + esc(err && err.message ? err.message : err);
        }
        box.classList.remove("hidden");
      });
  }

  function applyPathwayUi() {
    S.manualKeys = Object.keys(S.pw.inputs).filter(function (k) { return S.pw.inputs[k].source === "manual"; });
    $("manualPanel").classList.toggle("hidden", S.manualKeys.length === 0);
    $("manualInputs").innerHTML = S.manualKeys.map(function (key) {
      var def = S.pw.inputs[key];
      return '<label for="m_' + esc(key) + '">' + esc(def.label) + '</label><select id="m_' + esc(key) + '">' +
        '<option value="">Not yet assessed</option>' +
        def.options.map(function (o) { return '<option value="' + esc(o.v) + '">' + esc(o.t) + "</option>"; }).join("") + "</select>";
    }).join("");
    S.manualKeys.forEach(function (key) {
      $("m_" + key).addEventListener("change", function (e) { S.manual[key] = e.target.value; render(); });
    });
    $("disagreeBox").classList.add("hidden");
  }

  function setupOnce() {
    $("pathwaySelect").innerHTML = '<option value="">Choose a pathway…</option>' + S.manifest.map(function (p) {
      return '<option value="' + esc(p.file) + '">' + esc(p.label) + "</option>";
    }).join("");
    $("pathwayDesc").textContent = "No classification is shown until you choose a pathway.";
    $("pathwaySelect").addEventListener("change", function (e) { choosePathway(e.target.value); });

    if (DEMO_MODE) {
      $("demoPicker").classList.remove("hidden");
      $("patientSelect").innerHTML = Object.keys(window.DEMO).map(function (k) {
        return '<option value="' + k + '">' + esc(window.DEMO[k].label) + "</option>";
      }).join("");
      $("patientSelect").addEventListener("change", function (e) {
        S.demoKey = e.target.value; S.manual = {};
        S.manualKeys.forEach(function (k) { $("m_" + k).value = ""; });
        S.patientRes = window.DEMO[S.demoKey].patient;
        showPatientLine();
        if (S.pw) loadObservations().then(render);
      });
    }

    $("refreshBtn").addEventListener("click", function () {
      var btn = $("refreshBtn"); btn.disabled = true;
      loadObservations().then(render).catch(function (err) {
        $("fetchedAt").textContent = "Refresh failed: " + (err && err.message ? err.message : err);
      }).then(function () { btn.disabled = false; });
    });
    $("agreeBtn").addEventListener("click", function () { record("Agreed with classification"); });
    $("disagreeBtn").addEventListener("click", function () { $("disagreeBox").classList.toggle("hidden"); });
    $("saveDisagree").addEventListener("click", function () {
      var r = $("reason").value.trim();
      if (!r) { $("reason").focus(); return; }
      record("Disagreed: " + r);
      $("reason").value = ""; $("disagreeBox").classList.add("hidden");
    });
    $("downloadLog").addEventListener("click", downloadLog);

    // Staleness depends on the clock, so re-evaluate periodically without refetching.
    setInterval(render, 30000);
  }

  function fmtAgo(m) { return m < 1 ? "just now" : m + " min ago"; }

  function render() {
    if (!S.pw) return;
    var now = Date.now();
    var patient = E.buildPatientState(S.patientRes, S.observations, now);
    var inputs = E.resolveInputs(S.pw, patient, S.manual, now, S.unavailable);
    var result = E.evaluate(S.pw, inputs, patient.ageMonths);
    current = { patient: patient, inputs: inputs, result: result, now: now };

    $("statusBar").innerHTML = DEMO_MODE
      ? "<span>Demo mode: synthetic data, no server connection</span>"
      : "<span>Connected via SMART on FHIR</span><span>Server: " + esc(S.serverUrl) + "</span>";
    $("diagBody").textContent = DEMO_MODE ? "Demo mode: no server connection." : [
      "FHIR server:      " + S.serverUrl,
      "Patient id:       " + (S.client && S.client.patient && S.client.patient.id),
      "Scopes requested: " + (window.APP_CONFIG && window.APP_CONFIG.scope),
      "Scopes granted:   " + (S.grantedScope || "(not reported)"),
      "Observation queries:\n  " + S.lastRequests.join("\n  "),
      "Observations returned: " + S.lastCount,
      "Codes that failed: " + (Object.keys(S.failures).map(function (c) { return c + " (" + S.failures[c].slice(0, 200) + ")"; }).join("; ") || "none"),
      "Observation codes seen: " + (S.observations.map(function (o) {
        var c = o.code && o.code.coding && o.code.coding[0]; return c ? c.code : "?";
      }).filter(function (c, i, a) { return a.indexOf(c) === i; }).join(", ") || "none")
    ].join("\n");
    var failedCodes = Object.keys(S.failures);
    if (failedCodes.length) {
      $("loadBanner").innerHTML = "<strong>Some data could not be retrieved from the record.</strong> It is treated as unavailable, never as normal, so the classification below may be incomplete. Use Refresh from record to try again." +
        "<ul>" + failedCodes.map(function (c) { return "<li>LOINC " + esc(c) + ": " + esc(S.failures[c].slice(0, 160)) + "</li>"; }).join("") + "</ul>";
      $("loadBanner").classList.remove("hidden");
    } else {
      $("loadBanner").classList.add("hidden");
    }
    $("fetchedAt").textContent = "Fetched " + new Date(S.fetchedAt).toLocaleTimeString("en-AU");

    $("patientHeader").innerHTML =
      '<div class="pt"><span class="name">' + esc(patient.name) + "</span><span>" +
      (patient.ageMonths === null ? "Age unknown" : fmtPatientAge(patient.ageMonths)) + "</span></div>" +
      (patient.ageMonths === null ? '<p class="small" style="color:var(--mod)">No usable birth date on the record. Age-dependent limits cannot be applied.</p>' : "");

    var rows = [];
    Object.keys(S.pw.inputs).forEach(function (key) {
      var def = S.pw.inputs[key];
      if (def.source !== "fhir") return;
      var i = inputs[key];
      var gone = i.status === "missing" || i.status === "unavailable";
      var value = gone ? "No value"
        : i.status === "invalid" ? esc(i.raw) + " " + esc(i.rawUnit || "") + " (rejected)"
        : esc(i.value) + " " + esc(def.unit);
      var when = i.status === "missing" ? "None on record" : i.status === "unavailable" ? "Not retrieved" : fmtAgo(i.ageMin);
      var chipText = i.status === "ok" ? "Current"
        : i.status === "stale" ? "Stale (over " + def.maxAgeMin + " min)"
        : i.status === "invalid" ? "Implausible or unexpected unit"
        : i.status === "unavailable" ? "Could not be retrieved"
        : i.status === "partial" ? "Some data could not be retrieved" : "Missing";
      var chipClass = i.status === "unavailable" ? "invalid" : i.status === "partial" ? "stale" : i.status;
      rows.push("<tr><td>" + esc(def.label) + "</td><td>" + value + "</td><td>" + when +
        '</td><td><span class="chip ' + chipClass + '">' + chipText + "</span></td></tr>");
    });
    S.pw.context.forEach(function (c) {
      var hit = patient.latest(c.loinc);
      var q = hit && hit.resource.valueQuantity;
      var cFailed = !hit && c.loinc.some(function (x) { return S.unavailable.indexOf(x) !== -1; });
      rows.push("<tr><td>" + esc(c.label) + "</td><td>" + (q ? esc(q.value) + " " + esc(c.unit) : "No value") +
        "</td><td>" + (hit ? fmtAgo(Math.max(0, Math.round((now - hit.time) / 60000))) : cFailed ? "Not retrieved" : "None on record") +
        '</td><td class="muted">Shown for context, not used by this draft</td></tr>');
    });
    $("obsBody").innerHTML = rows.join("");

    var box = $("result"), d = result.decided;
    function problemNames(list) {
      return list.map(function (p) {
        if (p.key === "age") return "age (" + (p.status === "missing" ? "no usable birth date on the record" : "outside the pathway's age bands") + ")";
        return S.pw.inputs[p.key].label.toLowerCase() + " (" + p.status + ")";
      }).join(", ");
    }
    if (result.unclassified) {
      box.className = "result none";
      box.innerHTML = '<p class="level">Unable to classify</p><p style="margin:0">No criterion for a higher level is met, but these inputs are needed to rule them out: ' +
        esc(problemNames(result.problems)) + ". Obtain or enter them. This tool does not default to mild on incomplete data.</p>";
    } else {
      box.className = "result " + d.id;
      var lowest = d.criteria.length === 0;
      var gaps = result.problems.length && !lowest
        ? '<p style="margin:8px 0 0">Some inputs are still missing, stale or rejected (' + esc(problemNames(result.problems)) + "). Missing data could only raise severity, not lower it.</p>" : "";
      box.innerHTML = '<p class="level">' + esc(d.label) + '</p><p style="margin:0">' +
        (lowest ? "No criterion for a higher level is met, and all required inputs are current."
          : "At least one criterion for this level is met.") + "</p>" + gaps;
    }

    $("trace").innerHTML = result.levels.map(function (lv) {
      var head = '<div class="levelhead">' + esc(lv.label) + "</div>";
      if (!lv.criteria.length) {
        var applies = result.decided && result.decided.id === lv.id;
        return head + '<ul class="trace"><li><span class="state ' + (applies ? "met" : "not") + '">' + (applies ? "Applies" : "Does not apply") +
          "</span><span>Assigned only when no higher level is met and all required inputs are current</span></li></ul>";
      }
      return head + '<ul class="trace">' + lv.criteria.map(function (c) {
        var label = c.state === "met" ? "Met" : c.state === "not" ? "Not met" : "No data";
        var cls = c.state === "met" ? "met" : c.state === "not" ? "not" : "nodata";
        var lim = !c.banded ? "" : c.band
          ? ' <span class="muted">(limit ' + esc(c.threshold) + " for " + esc(fmtBand(c.band)) + ")</span>"
          : ' <span class="muted">(no limit: age not usable)</span>';
        return '<li><span class="state ' + cls + '">' + label + "</span><span>" + esc(c.text) + lim +
          (c.stale && c.state === "met" ? ' <span class="chip stale">stale value</span>' : "") + "</span></li>";
      }).join("") + "</ul>";
    }).join("");

    $("actions").innerHTML = d
      ? d.actions.map(function (a) { return '<li class="placeholder">' + esc(a) + "</li>"; }).join("")
      : '<li class="placeholder">No actions shown until the missing inputs are resolved.</li>';

    $("agreeBtn").disabled = result.unclassified;
  }

  /* ---------- Audit log ---------- */

  function record(action) {
    var c = current;
    var snapshot = {};
    Object.keys(c.inputs).forEach(function (k) {
      var i = c.inputs[k];
      snapshot[k] = { status: i.status, value: i.value === undefined ? null : i.value, ageMin: i.ageMin === undefined ? null : i.ageMin };
    });
    auditLog.unshift({
      time: new Date(c.now).toISOString(),
      mode: DEMO_MODE ? "demo" : "smart",
      server: S.serverUrl,
      patientId: c.patient.id,
      pathway: S.pw.id,
      pathwayVersion: S.pw.version,
      classification: c.result.unclassified ? "unable-to-classify" : c.result.decided.id,
      inputs: snapshot,
      dataFetchedAt: new Date(S.fetchedAt).toISOString(),
      action: action
    });
    $("log").innerHTML = auditLog.map(function (e) {
      return "<li><strong>" + esc(new Date(e.time).toLocaleTimeString("en-AU")) + "</strong> " + esc(c.patient.name) + ": " +
        esc(e.classification) + ". " + esc(e.action) + '<br><span class="muted">Pathway ' + esc(e.pathwayVersion) + ", data fetched " +
        esc(new Date(e.dataFetchedAt).toLocaleTimeString("en-AU")) + "</span></li>";
    }).join("");
    $("downloadLog").disabled = false;
  }

  function downloadLog() {
    var blob = new Blob([JSON.stringify(auditLog, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pathway-audit-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  boot();
})();
