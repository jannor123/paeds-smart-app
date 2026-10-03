/* Pathway engine and FHIR adapter.
 * Pure functions, no DOM and no network, so the same code runs in the browser and in Node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PathEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var OPS = {
    lt:  function (a, b) { return a < b; },
    lte: function (a, b) { return a <= b; },
    gt:  function (a, b) { return a > b; },
    gte: function (a, b) { return a >= b; },
    eq:  function (a, b) { return a === b; }
  };

  // Age bands must cover every age from birth to this many months (18 years).
  var MAX_AGE_MONTHS = 216;

  /* ---------- Age ---------- */

  // Whole calendar months since birth. Needs a full YYYY-MM-DD date; partial or future dates give null.
  function ageInMonths(birthDate, nowMs) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate || "");
    if (!m) return null;
    var by = +m[1], bm = +m[2], bd = +m[3];
    if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
    var now = new Date(nowMs);
    var months = (now.getUTCFullYear() - by) * 12 + (now.getUTCMonth() + 1 - bm) - (now.getUTCDate() < bd ? 1 : 0);
    return months >= 0 ? months : null;
  }

  /* ---------- FHIR adapter ---------- */

  function humanName(pt) {
    var n = pt.name && pt.name[0];
    if (!n) return "Unnamed patient";
    if (n.text) return n.text;
    return [(n.given || []).join(" "), n.family].filter(Boolean).join(" ") || "Unnamed patient";
  }

  function obsTime(o) {
    var t = o.effectiveDateTime || (o.effectivePeriod && (o.effectivePeriod.end || o.effectivePeriod.start)) || o.effectiveInstant || o.issued;
    var ms = t ? Date.parse(t) : NaN;
    return isNaN(ms) ? null : ms;
  }

  // True if the list is in non-increasing effective-time order (observations without a time are skipped).
  function isNewestFirst(list) {
    var prev = null;
    for (var i = 0; i < list.length; i++) {
      var t = obsTime(list[i]);
      if (t === null) continue;
      if (prev !== null && t > prev) return false;
      prev = t;
    }
    return true;
  }

  function hasLoinc(o, codes) {
    var codings = (o.code && o.code.coding) || [];
    return codings.some(function (c) {
      return c.system === "http://loinc.org" && codes.indexOf(c.code) !== -1;
    });
  }

  /* patientResource: FHIR Patient. observations: array of FHIR Observation. */
  function buildPatientState(patientResource, observations, nowMs) {
    var ageMonths = ageInMonths(patientResource.birthDate, nowMs);
    var usable = (observations || []).filter(function (o) {
      return o && o.resourceType === "Observation" &&
        o.status !== "entered-in-error" && o.status !== "cancelled" && o.valueQuantity;
    });
    return {
      id: patientResource.id,
      name: humanName(patientResource),
      ageMonths: ageMonths,
      ageYears: ageMonths === null ? null : Math.floor(ageMonths / 12),
      latest: function (codes) {
        var hits = usable.filter(function (o) { return hasLoinc(o, codes); })
          .map(function (o) { return { o: o, t: obsTime(o) }; })
          .filter(function (x) { return x.t !== null; });
        hits.sort(function (x, y) { return y.t - x.t; });
        return hits.length ? { resource: hits[0].o, time: hits[0].t } : null;
      }
    };
  }

  /* ---------- Input resolution ---------- */

  // unavailable: LOINC codes the app tried to fetch but could not (timeout, error). Never treated as 'no value'.
  function resolveInputs(pw, patient, manual, nowMs, unavailable) {
    var out = {};
    Object.keys(pw.inputs).forEach(function (key) {
      var def = pw.inputs[key];
      if (def.source === "fhir") {
        var failed = (unavailable || []).some(function (c) { return def.loinc.indexOf(c) !== -1; });
        var hit = patient.latest(def.loinc);
        if (!hit) { out[key] = { status: failed ? "unavailable" : "missing" }; return; }
        var q = hit.resource.valueQuantity;
        var unit = q.code || q.unit;
        var ageMin = Math.max(0, Math.round((nowMs - hit.time) / 60000));
        var bad = typeof q.value !== "number" || !isFinite(q.value) ||
          (def.acceptUnits && unit && def.acceptUnits.indexOf(unit) === -1) ||
          (def.plausible && (q.value < def.plausible[0] || q.value > def.plausible[1]));
        if (bad) {
          out[key] = { status: "invalid", raw: q.value, rawUnit: unit, ageMin: ageMin };
          return;
        }
        var status = ageMin > def.maxAgeMin ? "stale" : "ok";
        if (failed && status === "ok") status = "partial"; // a newer value may exist that could not be fetched
        out[key] = { value: q.value, ageMin: ageMin, time: hit.time, status: status };
      } else {
        out[key] = manual && manual[key] ? { value: manual[key], status: "ok" } : { status: "missing" };
      }
    });
    return out;
  }

  /* ---------- Pathway file validation (fail closed) ---------- */

  function validatePathway(pw) {
    var errs = [];
    if (!pw || typeof pw !== "object") return ["The pathway file is not a JSON object."];
    if (!pw.inputs || typeof pw.inputs !== "object") errs.push("No inputs are defined.");
    if (!Array.isArray(pw.levels) || !pw.levels.length) errs.push("No levels are defined.");
    if (errs.length) return errs;

    Object.keys(pw.inputs).forEach(function (k) {
      var d = pw.inputs[k];
      if (d.source === "fhir") {
        if (!Array.isArray(d.loinc) || !d.loinc.length) errs.push("Input '" + k + "' needs at least one LOINC code.");
        if (typeof d.maxAgeMin !== "number") errs.push("Input '" + k + "' needs maxAgeMin (how many minutes old a value may be before it is stale).");
      } else if (d.source === "manual") {
        if (!Array.isArray(d.options) || !d.options.length) errs.push("Input '" + k + "' needs a list of options.");
      } else {
        errs.push("Input '" + k + "' has an unknown source (use 'fhir' or 'manual').");
      }
    });

    var last = pw.levels[pw.levels.length - 1];
    if (last.criteria && last.criteria.length) {
      errs.push("The last (lowest) level must have no criteria, so that it applies only when nothing higher is met.");
    }

    pw.levels.forEach(function (lv) {
      (lv.criteria || []).forEach(function (c, i) {
        var where = "Level '" + lv.id + "', criterion " + (i + 1);
        var d = pw.inputs[c.input];
        if (!d) { errs.push(where + ": unknown input '" + c.input + "'."); return; }
        if (!OPS[c.op]) { errs.push(where + ": unknown operator '" + c.op + "'."); return; }
        if (!c.text) errs.push(where + ": missing display text.");
        var v = c.value;
        if (v !== null && typeof v === "object") {
          if (d.source !== "fhir") errs.push(where + ": age bands only apply to numeric inputs from the record.");
          if (!Array.isArray(v.byAge) || !v.byAge.length) { errs.push(where + ": byAge must list at least one band."); return; }
          var prev = 0;
          v.byAge.forEach(function (b, j) {
            if (typeof b.upToMonths !== "number" || b.upToMonths <= prev) {
              errs.push(where + ", band " + (j + 1) + ": upToMonths must be a number greater than the previous band's (" + prev + ").");
            } else {
              prev = b.upToMonths;
            }
            if (typeof b.value !== "number" || !isFinite(b.value)) {
              errs.push(where + ", band " + (j + 1) + ": the value has not been set.");
            }
          });
          if (prev < MAX_AGE_MONTHS) {
            errs.push(where + ": bands must cover every age up to 18 years (" + MAX_AGE_MONTHS + " months). The last band ends at " + prev + " months.");
          }
        } else if (d.source === "manual") {
          if (c.op !== "eq") errs.push(where + ": bedside inputs can only use the 'eq' operator.");
          if (!d.options.some(function (o) { return o.v === v; })) errs.push(where + ": '" + v + "' is not one of the options for '" + c.input + "'.");
        } else if (typeof v !== "number" || !isFinite(v)) {
          errs.push(where + ": the value has not been set.");
        }
      });
    });
    return errs;
  }

  /* ---------- Rules ---------- */

  // Returns the numeric limit that applies at this age, or the reason it cannot be determined.
  function resolveThreshold(value, ageMonths) {
    if (value === null || typeof value !== "object") return { ok: true, value: value };
    if (ageMonths === null) return { ok: false, reason: "age-unknown" };
    var prev = 0;
    for (var i = 0; i < value.byAge.length; i++) {
      var b = value.byAge[i];
      if (ageMonths < b.upToMonths) return { ok: true, value: b.value, band: { fromMonths: prev, toMonths: b.upToMonths } };
      prev = b.upToMonths;
    }
    return { ok: false, reason: "age-outside-bands" };
  }

  function evaluate(pw, inputs, ageMonths) {
    var errs = validatePathway(pw);
    if (errs.length) throw new Error("Invalid pathway: " + errs.join(" "));
    if (ageMonths === undefined) ageMonths = null;
    var ageIssue = null;

    var levels = pw.levels.map(function (lv) {
      return {
        id: lv.id, label: lv.label, actions: lv.actions,
        criteria: lv.criteria.map(function (c) {
          var inp = inputs[c.input];
          var usable = inp && (inp.status === "ok" || inp.status === "stale" || inp.status === "partial");
          var th = resolveThreshold(c.value, ageMonths);
          var copy = { input: c.input, op: c.op, text: c.text, banded: c.value !== null && typeof c.value === "object" };
          if (th.ok) { copy.threshold = th.value; copy.band = th.band || null; }
          else { copy.reason = th.reason; if (!ageIssue) ageIssue = th.reason; }
          if (!usable || !th.ok) { copy.state = "nodata"; return copy; }
          copy.state = OPS[c.op](inp.value, th.value) ? "met" : "not";
          copy.stale = inp.status === "stale";
          return copy;
        })
      };
    });

    var hit = null;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i].criteria.some(function (c) { return c.state === "met"; })) { hit = levels[i]; break; }
    }

    var problems = Object.keys(pw.inputs)
      .filter(function (k) { return pw.inputs[k].required && inputs[k].status !== "ok"; })
      .map(function (k) { return { key: k, status: inputs[k].status }; });
    if (ageIssue) problems.push({ key: "age", status: ageIssue === "age-unknown" ? "missing" : "outside" });

    var decided = null, unclassified = false;
    if (hit) decided = hit;                          // a met criterion is a safe floor even with gaps elsewhere
    else if (problems.length) unclassified = true;   // never default to the lowest level on incomplete data
    else decided = levels[levels.length - 1];

    return { levels: levels, decided: decided, unclassified: unclassified, problems: problems };
  }

  return {
    ageInMonths: ageInMonths,
    isNewestFirst: isNewestFirst,
    buildPatientState: buildPatientState,
    resolveInputs: resolveInputs,
    validatePathway: validatePathway,
    evaluate: evaluate,
    humanName: humanName,
    MAX_AGE_MONTHS: MAX_AGE_MONTHS
  };
});
