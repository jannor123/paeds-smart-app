/* Registered in the Cerner Code Console as a Provider, Public, SMART v1 app.
 * Scopes must match what is ticked on the app's registration.
 * Optional: set pathway to a file in the pathways/ folder, for example
 *   pathway: "pathways/vitals-reference-chart.json",
 * (live SMART launches lose the ?pathway= query string in the sign-in redirect). */
window.APP_CONFIG = {
  clientId: "6f3b242d-e7ac-4388-9593-3800d34ff882",
  scope: "patient/Patient.read patient/Observation.read launch openid profile",
  redirectPage: "index.html"
};
