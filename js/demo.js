/* Synthetic demo patients, used only when the app is opened with ?demo=1. */
(function () {
  var T0 = Date.now();
  function iso(m) { return new Date(T0 - m * 60000).toISOString(); }
  function birth(y) { return new Date(T0 - y * 365.25 * 864e5).toISOString().slice(0, 10); }
  function obs(loinc, display, value, unit, m) {
    return {
      resourceType: "Observation", status: "final",
      code: { coding: [{ system: "http://loinc.org", code: loinc, display: display }] },
      valueQuantity: { value: value, unit: unit, code: unit }, effectiveDateTime: iso(m)
    };
  }
  function pt(id, name, years) {
    return { resourceType: "Patient", id: id, name: [{ text: name }], birthDate: birth(years) };
  }
  window.DEMO = {
    a: { label: "Demo A: saturation low, bedside assessment not yet entered",
         patient: pt("demo-a", "Demo Patient A", 6),
         observations: [obs("59408-5", "Oxygen saturation", 92, "%", 5), obs("9279-1", "Respiratory rate", 34, "/min", 5), obs("8867-4", "Heart rate", 118, "/min", 5)] },
    b: { label: "Demo B: low saturation recorded 50 minutes ago",
         patient: pt("demo-b", "Demo Patient B", 3),
         observations: [obs("59408-5", "Oxygen saturation", 88, "%", 50), obs("9279-1", "Respiratory rate", 48, "/min", 50), obs("8867-4", "Heart rate", 150, "/min", 50)] },
    c: { label: "Demo C: no saturation recorded",
         patient: pt("demo-c", "Demo Patient C", 9),
         observations: [obs("9279-1", "Respiratory rate", 22, "/min", 8), obs("8867-4", "Heart rate", 96, "/min", 8)] },
    d: { label: "Demo D: normal saturation, assessment not yet entered",
         patient: pt("demo-d", "Demo Patient D", 11),
         observations: [obs("59408-5", "Oxygen saturation", 98, "%", 4), obs("9279-1", "Respiratory rate", 18, "/min", 4), obs("8867-4", "Heart rate", 84, "/min", 4)] }
  };
})();
