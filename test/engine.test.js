const assert = require("assert");
const E = require("../js/engine.js");
const PW = require("../pathway.json");

const NOW = Date.parse("2026-10-02T03:00:00Z");
const minsAgo = m => new Date(NOW - m * 60000).toISOString();
const pt = { resourceType: "Patient", id: "p1", birthDate: "2020-06-01", name: [{ given: ["Test"], family: "Child" }] };
const obs = (code, value, unit, m, extra) => Object.assign({
  resourceType: "Observation", status: "final",
  code: { coding: [{ system: "http://loinc.org", code: code }] },
  valueQuantity: { value: value, unit: unit, code: unit }, effectiveDateTime: minsAgo(m)
}, extra || {});

function run(observations, manual) {
  const p = E.buildPatientState(pt, observations, NOW);
  const inputs = E.resolveInputs(PW, p, manual || {}, NOW);
  return { p, inputs, r: E.evaluate(PW, inputs, p.ageMonths) };
}
const level = x => (x.r.unclassified ? "unclassified" : x.r.decided.id);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok  " + name); }

test("patient age and name are derived from the Patient resource", () => {
  const { p } = run([]);
  assert.strictEqual(p.ageYears, 6);
  assert.strictEqual(p.name, "Test Child");
});

test("low saturation alone gives moderate, even with bedside assessment missing", () => {
  assert.strictEqual(level(run([obs("59408-5", 92, "%", 5)])), "moderate");
});

test("severe saturation gives severe", () => {
  assert.strictEqual(level(run([obs("59408-5", 88, "%", 5)])), "severe");
});

test("normal saturation with no bedside assessment is unclassified, never mild", () => {
  assert.strictEqual(level(run([obs("59408-5", 98, "%", 5)])), "unclassified");
});

test("no saturation on record is unclassified even if bedside inputs look mild", () => {
  assert.strictEqual(level(run([], { wob: "mild", speech: "sentences" })), "unclassified");
});

test("all inputs current and normal gives mild", () => {
  assert.strictEqual(level(run([obs("59408-5", 98, "%", 5)], { wob: "mild", speech: "sentences" })), "mild");
});

test("stale normal saturation cannot support mild", () => {
  assert.strictEqual(level(run([obs("59408-5", 98, "%", 45)], { wob: "mild", speech: "sentences" })), "unclassified");
});

test("stale low saturation still raises severity and is flagged stale", () => {
  const x = run([obs("59408-5", 88, "%", 50)]);
  assert.strictEqual(level(x), "severe");
  assert.strictEqual(x.inputs.spo2.status, "stale");
  assert.ok(x.r.levels[0].criteria[0].stale);
});

test("bedside severe finding overrides a normal saturation", () => {
  assert.strictEqual(level(run([obs("59408-5", 98, "%", 5)], { wob: "severe", speech: "sentences" })), "severe");
});

test("most severe level wins when several criteria are met", () => {
  assert.strictEqual(level(run([obs("59408-5", 92, "%", 5)], { wob: "severe", speech: "phrases" })), "severe");
});

test("entered-in-error observations are ignored", () => {
  const x = run([obs("59408-5", 80, "%", 5, { status: "entered-in-error" }), obs("59408-5", 98, "%", 6)], { wob: "mild", speech: "sentences" });
  assert.strictEqual(level(x), "mild");
});

test("the most recent observation is used", () => {
  const x = run([obs("59408-5", 85, "%", 20), obs("59408-5", 97, "%", 3)], { wob: "mild", speech: "sentences" });
  assert.strictEqual(x.inputs.spo2.value, 97);
  assert.strictEqual(level(x), "mild");
});

test("alternate LOINC code for saturation is accepted", () => {
  assert.strictEqual(level(run([obs("2708-6", 91, "%", 5)])), "moderate");
});

test("implausible value is flagged invalid and blocks classification as mild", () => {
  const x = run([obs("59408-5", 980, "%", 5)], { wob: "mild", speech: "sentences" });
  assert.strictEqual(x.inputs.spo2.status, "invalid");
  assert.strictEqual(level(x), "unclassified");
});

test("unexpected unit is flagged invalid", () => {
  const x = run([obs("59408-5", 0.9, "1", 5)], { wob: "mild", speech: "sentences" });
  assert.strictEqual(x.inputs.spo2.status, "invalid");
  assert.strictEqual(level(x), "unclassified");
});

test("observations without a usable timestamp are ignored", () => {
  const o = obs("59408-5", 98, "%", 5); delete o.effectiveDateTime;
  assert.strictEqual(E.resolveInputs(PW, E.buildPatientState(pt, [o], NOW), {}, NOW).spo2.status, "missing");
});

test("pathway file has a lowest level with no criteria and every criterion input exists", () => {
  assert.strictEqual(PW.levels[PW.levels.length - 1].criteria.length, 0);
  PW.levels.forEach(l => l.criteria.forEach(c => assert.ok(PW.inputs[c.input], c.input)));
});


/* ---------- Age bands ---------- */

// Fixture only. These numbers are arbitrary test values, not clinical thresholds.
const FIX = {
  id: "fixture", name: "fixture", version: "0",
  inputs: { hr: { label: "HR", source: "fhir", loinc: ["8867-4"], unit: "/min", acceptUnits: ["/min"], maxAgeMin: 30, required: true } },
  context: [],
  levels: [
    { id: "high", label: "High", actions: [], criteria: [
      { input: "hr", op: "gt", text: "HR above limit for age",
        value: { byAge: [ { upToMonths: 12, value: 200 }, { upToMonths: 216, value: 100 } ] } } ] },
    { id: "normal", label: "Normal", actions: [], criteria: [] }
  ]
};
function runFix(birthDate, hr, pw) {
  const patient = Object.assign({}, pt, { birthDate });
  const p = E.buildPatientState(patient, hr === null ? [] : [obs("8867-4", hr, "/min", 5)], NOW);
  const inputs = E.resolveInputs(pw || FIX, p, {}, NOW);
  return { p, r: E.evaluate(pw || FIX, inputs, p.ageMonths) };
}

test("age in months uses whole calendar months", () => {
  assert.strictEqual(E.ageInMonths("2025-08-02", NOW), 14);
  assert.strictEqual(E.ageInMonths("2025-10-03", NOW), 11);
  assert.strictEqual(E.ageInMonths("2025-10-02", NOW), 12);
  assert.strictEqual(E.ageInMonths("2026-10-02", NOW), 0);
});

test("missing, partial, invalid or future birth dates give unknown age", () => {
  ["", undefined, "2020", "2020-06", "not a date", "2020-13-01", "2027-01-01"].forEach(b =>
    assert.strictEqual(E.ageInMonths(b, NOW), null, String(b)));
});

test("the limit changes at the band boundary (upper bound exclusive)", () => {
  assert.strictEqual(level(runFix("2025-10-03", 150)), "normal"); // 11 months: limit 200
  assert.strictEqual(level(runFix("2025-10-02", 150)), "high");   // 12 months: limit 100
});

test("the criterion records the limit and band that were applied", () => {
  const c = runFix("2025-10-02", 150).r.levels[0].criteria[0];
  assert.strictEqual(c.threshold, 100);
  assert.deepStrictEqual(c.band, { fromMonths: 12, toMonths: 216 });
  assert.strictEqual(c.banded, true);
});

test("unknown age with a banded rule and nothing else met is unclassified, never normal", () => {
  const x = runFix(undefined, 80);
  assert.strictEqual(level(x), "unclassified");
  assert.ok(x.r.problems.some(p => p.key === "age" && p.status === "missing"));
});

test("a met criterion still stands when age is unknown and another rule does not need age", () => {
  const pw = JSON.parse(JSON.stringify(FIX));
  pw.levels[0].criteria.push({ input: "hr", op: "gt", value: 300, text: "HR above 300" });
  assert.strictEqual(level(runFix(undefined, 320, pw)), "high");
});

test("age beyond the last band is unclassified", () => {
  const x = runFix("2000-01-01", 80);
  assert.strictEqual(level(x), "unclassified");
  assert.ok(x.r.problems.some(p => p.key === "age" && p.status === "outside"));
});

/* ---------- Pathway validation ---------- */

const clone = o => JSON.parse(JSON.stringify(o));
const errsFor = mut => { const pw = clone(FIX); mut(pw); return E.validatePathway(pw); };

test("the shipped asthma pathway and the fixture are valid", () => {
  assert.deepStrictEqual(E.validatePathway(PW), []);
  assert.deepStrictEqual(E.validatePathway(FIX), []);
});

test("the unfilled age-banded template is rejected because values are not set", () => {
  const errs = E.validatePathway(require("../pathways/age-banded-template.json"));
  assert.ok(errs.length > 0);
  assert.ok(errs.every(e => /has not been set/.test(e)));
});

test("bands that do not increase are rejected", () => {
  assert.ok(errsFor(pw => { pw.levels[0].criteria[0].value.byAge[1].upToMonths = 6; }).some(e => /greater than the previous/.test(e)));
});

test("bands that stop short of 18 years are rejected", () => {
  assert.ok(errsFor(pw => { pw.levels[0].criteria[0].value.byAge[1].upToMonths = 120; }).some(e => /cover every age/.test(e)));
});

test("unknown input, unknown operator and non-numeric value are rejected", () => {
  assert.ok(errsFor(pw => { pw.levels[0].criteria[0].input = "nope"; }).some(e => /unknown input/.test(e)));
  assert.ok(errsFor(pw => { pw.levels[0].criteria[0].op = "approx"; }).some(e => /unknown operator/.test(e)));
  assert.ok(errsFor(pw => { pw.levels[0].criteria[0].value = "high"; }).some(e => /has not been set/.test(e)));
});

test("the lowest level must have no criteria", () => {
  assert.ok(errsFor(pw => { pw.levels[1].criteria.push({ input: "hr", op: "gt", value: 1, text: "x" }); }).some(e => /lowest/.test(e)));
});

test("a bedside criterion must use a value from its option list", () => {
  const pw = clone(PW); pw.levels[0].criteria[1].value = "very severe";
  assert.ok(E.validatePathway(pw).some(e => /not one of the options/.test(e)));
});

test("evaluate refuses to run an invalid pathway", () => {
  const pw = clone(FIX); pw.levels[0].criteria[0].value.byAge[0].value = null;
  assert.throws(() => E.evaluate(pw, {}, 24), /Invalid pathway/);
});

/* ---------- Vitals reference chart pathway ---------- */

const VP = require("../pathways/vitals-reference-chart.json");
// Independent copy of the table as supplied, so a transcription slip in the pathway file is caught.
const CHART = [
  { upTo: 1,   hr: [110, 160], rr: [30, 60] },
  { upTo: 12,  hr: [100, 160], rr: [30, 50] },
  { upTo: 36,  hr: [90, 150],  rr: [25, 35] },
  { upTo: 72,  hr: [80, 140],  rr: [20, 30] },
  { upTo: 156, hr: [70, 120],  rr: [18, 25] },
  { upTo: 216, hr: [60, 100],  rr: [12, 20] }
];
function birthFor(months) {
  const total = 2026 * 12 + 9 - months; // NOW is 2 October 2026
  return Math.floor(total / 12) + "-" + String((total % 12) + 1).padStart(2, "0") + "-02";
}
function runV(months, hr, rr) {
  const patient = Object.assign({}, pt, { birthDate: birthFor(months) });
  const o = [];
  if (hr !== null) o.push(obs("8867-4", hr, "/min", 5));
  if (rr !== null) o.push(obs("9279-1", rr, "/min", 5));
  const p = E.buildPatientState(patient, o, NOW);
  assert.strictEqual(p.ageMonths, months);
  return { r: E.evaluate(VP, E.resolveInputs(VP, p, {}, NOW), p.ageMonths) };
}
const mid = (months, key) => { const b = CHART.find(x => months < x.upTo); return Math.round((b[key][0] + b[key][1]) / 2); };
const lv = x => (x.r.unclassified ? "unclassified" : x.r.decided.id);

test("the vitals pathway file matches the supplied chart, band by band", () => {
  assert.deepStrictEqual(E.validatePathway(VP), []);
  const want = ["hr:gt:1", "hr:lt:0", "rr:gt:1", "rr:lt:0"];
  VP.levels[0].criteria.forEach((c, k) => {
    const [key, op, idx] = want[k].split(":");
    assert.strictEqual(c.input, key); assert.strictEqual(c.op, op);
    assert.deepStrictEqual(c.value.byAge.map(b => b.upToMonths), CHART.map(b => b.upTo));
    assert.deepStrictEqual(c.value.byAge.map(b => b.value), CHART.map(b => b[key][+idx]));
  });
});

test("mid-range vitals are within range in every band", () => {
  [0, 5, 20, 50, 100, 200].forEach(m => assert.strictEqual(lv(runV(m, mid(m, "hr"), mid(m, "rr"))), "within", m + " months"));
});

test("limits are inclusive: exactly at a limit is within, one beyond is flagged", () => {
  CHART.forEach((b, i) => {
    const m = i === 0 ? 0 : CHART[i - 1].upTo; // first month of the band
    assert.strictEqual(lv(runV(m, b.hr[1], mid(m, "rr"))), "within", "HR upper at " + m);
    assert.strictEqual(lv(runV(m, b.hr[1] + 1, mid(m, "rr"))), "flag", "HR above at " + m);
    assert.strictEqual(lv(runV(m, b.hr[0], mid(m, "rr"))), "within", "HR lower at " + m);
    assert.strictEqual(lv(runV(m, b.hr[0] - 1, mid(m, "rr"))), "flag", "HR below at " + m);
    assert.strictEqual(lv(runV(m, mid(m, "hr"), b.rr[1])), "within", "RR upper at " + m);
    assert.strictEqual(lv(runV(m, mid(m, "hr"), b.rr[1] + 1)), "flag", "RR above at " + m);
    assert.strictEqual(lv(runV(m, mid(m, "hr"), b.rr[0])), "within", "RR lower at " + m);
    assert.strictEqual(lv(runV(m, mid(m, "hr"), b.rr[0] - 1)), "flag", "RR below at " + m);
  });
});

test("the limit steps at each age boundary", () => {
  assert.strictEqual(lv(runV(0, 105, 40)), "flag");     // newborn lower HR 110
  assert.strictEqual(lv(runV(1, 105, 40)), "within");   // infant lower HR 100
  assert.strictEqual(lv(runV(11, 155, 40)), "within");  // infant upper HR 160
  assert.strictEqual(lv(runV(12, 155, 30)), "flag");    // toddler upper HR 150
  assert.strictEqual(lv(runV(35, 100, 31)), "within");  // toddler upper RR 35
  assert.strictEqual(lv(runV(36, 100, 31)), "flag");    // pre-school upper RR 30
  assert.strictEqual(lv(runV(155, 110, 20)), "within"); // school-age upper HR 120
  assert.strictEqual(lv(runV(156, 110, 16)), "flag");   // adolescent upper HR 100
});

test("age 18 years or more, or an unusable birth date, is unclassified", () => {
  assert.strictEqual(lv(runV(215, 80, 16)), "within");
  const p = E.buildPatientState(Object.assign({}, pt, { birthDate: birthFor(216) }), [obs("8867-4", 80, "/min", 5), obs("9279-1", 16, "/min", 5)], NOW);
  assert.strictEqual(lv({ r: E.evaluate(VP, E.resolveInputs(VP, p, {}, NOW), p.ageMonths) }), "unclassified");
});

test("one vital missing and the other normal is unclassified, never within range", () => {
  assert.strictEqual(lv(runV(72, 100, null)), "unclassified");
  assert.strictEqual(lv(runV(72, null, 20)), "unclassified");
});

test("an abnormal value still flags when the other vital is missing", () => {
  assert.strictEqual(lv(runV(72, 150, null)), "flag");
});

/* ---------- Data that could not be retrieved ---------- */

function runU(observations, manual, unavailable) {
  const p = E.buildPatientState(pt, observations, NOW);
  const inputs = E.resolveInputs(PW, p, manual || {}, NOW, unavailable);
  return { inputs, r: E.evaluate(PW, inputs, p.ageMonths) };
}

test("a failed saturation fetch is 'unavailable', not 'missing', and blocks a mild result", () => {
  const x = runU([], { wob: "mild", speech: "sentences" }, ["59408-5", "2708-6"]);
  assert.strictEqual(x.inputs.spo2.status, "unavailable");
  assert.strictEqual(level(x), "unclassified");
});

test("a value from one code still counts when the other code failed, but is only 'partial'", () => {
  const x = runU([obs("59408-5", 98, "%", 5)], { wob: "mild", speech: "sentences" }, ["2708-6"]);
  assert.strictEqual(x.inputs.spo2.status, "partial");
  assert.strictEqual(level(x), "unclassified");           // cannot support mild
  const y = runU([obs("59408-5", 88, "%", 5)], {}, ["2708-6"]);
  assert.strictEqual(level(y), "severe");                  // can still raise severity
});

test("a failure on an unrelated code does not affect the input", () => {
  const x = runU([obs("59408-5", 98, "%", 5)], { wob: "mild", speech: "sentences" }, ["9279-1"]);
  assert.strictEqual(x.inputs.spo2.status, "ok");
  assert.strictEqual(level(x), "mild");
});

/* ---------- Newest-first check ---------- */

test("isNewestFirst accepts descending order and rejects ascending order", () => {
  const a = obs("9279-1", 20, "/min", 5), b = obs("9279-1", 21, "/min", 30), c = obs("9279-1", 22, "/min", 90);
  assert.strictEqual(E.isNewestFirst([a, b, c]), true);
  assert.strictEqual(E.isNewestFirst([c, b, a]), false);
  assert.strictEqual(E.isNewestFirst([a]), true);
  assert.strictEqual(E.isNewestFirst([]), true);
});

test("isNewestFirst allows equal times and skips observations without a time", () => {
  const a = obs("9279-1", 20, "/min", 5), b = obs("9279-1", 21, "/min", 5);
  const noTime = obs("9279-1", 22, "/min", 5); delete noTime.effectiveDateTime;
  assert.strictEqual(E.isNewestFirst([a, b, noTime]), true);
});

console.log("\n" + passed + " tests passed");
