/* Record explorer: a developer tool for looking at what a SANDBOX patient record holds.
 * Register it in the Code Console as its own Provider, Public, SMART v1, FHIR R4 app:
 *   Launch URI:   http://localhost:8000/explorer/launch.html
 *   Redirect URI: http://localhost:8000/explorer/index.html
 * Tick Read for every resource type listed below (or delete the entries you do not want to request;
 * the requested scopes are built from this list, so they always match). */
window.EXPLORER_CONFIG = {
  clientId: "REPLACE_WITH_EXPLORER_CLIENT_ID",
  sandboxTenant: "ec2458f2-1e24-41c8-b71b-0e701af7583d",
  allowNonSandbox: false,   // leave false: the tool refuses to read a real tenant
  pageSize: 50,
  maxPages: 10,             // per query, so at most pageSize x maxPages resources each
  queries: [
    { label: "Observation: vital-signs",    type: "Observation", params: "category=vital-signs" },
    { label: "Observation: laboratory",     type: "Observation", params: "category=laboratory" },
    { label: "Observation: social-history", type: "Observation", params: "category=social-history" },
    { label: "Observation: survey",         type: "Observation", params: "category=survey" },
    { label: "Observation: exam",           type: "Observation", params: "category=exam" },
    { label: "Observation: procedure",      type: "Observation", params: "category=procedure" },
    { label: "Observation: therapy",        type: "Observation", params: "category=therapy" },
    { label: "Observation: imaging",        type: "Observation", params: "category=imaging" },
    { label: "Observation: sdoh",           type: "Observation", params: "category=sdoh" },
    { label: "Condition",                   type: "Condition" },
    { label: "AllergyIntolerance",          type: "AllergyIntolerance" },
    { label: "MedicationRequest",           type: "MedicationRequest" },
    { label: "MedicationAdministration",    type: "MedicationAdministration" },
    { label: "Procedure",                   type: "Procedure" },
    { label: "Encounter",                   type: "Encounter" },
    { label: "Immunization",                type: "Immunization" },
    { label: "DiagnosticReport",            type: "DiagnosticReport" },
    { label: "DocumentReference",           type: "DocumentReference" },
    { label: "ServiceRequest",              type: "ServiceRequest" },
    { label: "CarePlan",                    type: "CarePlan" }
  ]
};
