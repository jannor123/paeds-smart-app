# Paediatric pathway support: SMART on FHIR prototype

A static web app that launches from Cerner (Oracle Health) PowerChart or the Code Console sandbox, reads vitals through FHIR R4, and classifies acute asthma severity from a rules file. It is a prototype with placeholder thresholds. It is not clinically validated and must only be used with synthetic sandbox data.

## What is in the folder

| File | Purpose |
|---|---|
| `launch.html` | SMART launch URI. Starts the OAuth flow. |
| `index.html`, `js/app.js` | Redirect URI and the app itself. |
| `js/engine.js` | Rules engine and FHIR adapter. Pure functions, no network. |
| `pathway.json` | The asthma pathway as data. This is the file the clinical lead edits. |
| `pathways/age-banded-template.json` | Template for age-banded vital sign limits. Every limit is `null` and must be authored. |
| `config.js` | Client ID and scopes. |
| `js/demo.js` | Synthetic patients for `index.html?demo=1`. |
| `test/engine.test.js` | Safety tests. Run with `node test/engine.test.js`. |
| `explorer/` | Separate sandbox-only tool to see what a record holds. |
| `lib/` | Vendored `fhirclient` 3.0.0 (Apache-2.0). |

## Look at it first (no Cerner needed)

Serve the folder over HTTP, for example `python3 -m http.server 8000`, and open `http://localhost:8000/index.html?demo=1`.

## Run it against the Cerner public sandbox

You do not need to host anything to test. Cerner's sandbox accepts `localhost` URLs, because the launch happens in your own browser.

1. In this folder run `python3 -m http.server 8000`.
2. Create a free account and sign in to the Code Console (code.cerner.com). Register a new app:
   - App type: Provider
   - SMART launch URI: `http://localhost:8000/launch.html`
   - Redirect URI: `http://localhost:8000/index.html`
   - Privacy: Public (browser-only app, no server)
   - FHIR version: R4
   - Standard scopes: `launch`, `online_access`, `openid`, `profile` (the console pre-ticks the required ones)
   - Patient scopes: Patient read, Observation read
3. Copy the client ID from the app's details page into `config.js`. No redeploy is needed when serving locally.
4. In the Code Console open your app, choose Begin Testing (or Test Sandbox), pick a synthetic patient and Launch. The published sandbox tenant is `ec2458f2-1e24-41c8-b71b-0e701af7583d` and the login is `portal` / `portal`.

Field names in the Code Console change from time to time. Follow its prompts and keep the scopes and URIs as above.

To test from a public URL instead (for example GitHub Pages), use the same settings with your HTTPS URLs.

### If it does not work

Open "Connection details" in the app. It lists the server, scopes requested and granted, the exact Observation query and how many observations came back.

| Symptom | Likely cause |
|---|---|
| Launch page says no client ID | `config.js` still has the placeholder. |
| Redirect URI mismatch error from Cerner | The registered redirect URI differs from the one the app sends. It should be exactly the URL of `index.html`. If Cerner still rejects it, try registering the folder URL (ending in `/`), which is what Cerner's own tutorial registers. |
| "No SMART session found" | The app was opened directly instead of through the launcher. |
| 401 or 403 on Observation | Observation read was not ticked on the app registration, or the granted scopes (see Connection details) are narrower than requested. |
| 504 Gateway Timeout from the sandbox | Cerner's shared sandbox is sometimes slow. The app asks for each LOINC code separately and retries a failed request once. Anything still failing shows as "Could not be retrieved" with a red banner, and is treated as unavailable, never as normal. Use Refresh from record, or relaunch. |
| Banner says a full page was not newest-first | Cerner documents that observation results come back newest first, so the app reads only the first page of each code. If a full page ever arrives in another order, the app stops trusting it and reports the code as not retrieved. |
| Every vital shows as stale | Sandbox patients have vitals dated years ago, so stale is expected. A stale value still counts towards higher severity but never towards a lowest level. Use demo mode to see current values. |
| App loads but says "Unable to classify" | The sandbox patient has no oxygen saturation, or it is recorded under a code not in `pathway.json`. Connection details shows the codes that were returned. Try another sandbox patient, or add the code to `pathway.json`. This is the engine behaving as designed. |

## Choosing a pathway

The clinician chooses the pathway from a dropdown at the top of the app. Nothing is classified, and no vitals are requested, until one is chosen. Switching pathway clears bedside entries and fetches only the codes the new pathway needs.

To add a pathway: put the file in `pathways/`, then add an entry (`file`, `label`, `description`) to `pathways/manifest.json`. The file is validated when chosen, and a file with problems is refused with the reasons shown. For testing you can preselect one with `?pathway=pathways/your-file.json` or `pathway:` in `config.js`; a file that is not in the manifest shows as "From address or config".

## Age-banded limits

A criterion's `value` can be a single number or an age-banded list:

```json
"value": { "byAge": [ { "upToMonths": 12, "value": 0 }, { "upToMonths": 216, "value": 0 } ] }
```

A band applies when the patient's age in whole months is below `upToMonths` and at or above the previous band's (the first band starts at 0). The numbers above are zeros only to show the shape: set them from your local guideline.

The engine checks every pathway file before use and refuses to run one that has problems (fail closed). It rejects bands that do not increase, bands that stop short of 18 years (216 months), unknown inputs or operators, values that have not been set, and a lowest level that has criteria. The app lists the problems on screen.

At run time, a banded rule needs a usable birth date. If the age is missing, unparseable or beyond the last band, the result is "Unable to classify" unless some other criterion already puts the patient in a level. The trace shows which limit and age band were applied.

To try the template: copy it, fill in the limits, add it to the manifest, and choose it from the dropdown. Pathway files must live in the `pathways/` folder.

## Record explorer (sandbox only)

`explorer/` is a separate developer tool that reads everything the granted scopes allow for the launched sandbox patient (vitals, labs, conditions, allergies, medications, procedures, encounters and more), summarises what is there by item and code, lets you search it, and downloads it as JSON. Use it to find out what the sandbox record holds, for example whether anything records work of breathing or speech.

It is its own app so the clinical app keeps requesting only the two scopes it needs.

1. Register a second app in the Code Console: Provider, Public, SMART v1, Online, FHIR R4 product. Launch URI `http://localhost:8000/explorer/launch.html`, redirect URI `http://localhost:8000/explorer/index.html`.
2. Tick Read in the Patient Product APIs table for every resource in `explorer/config.js` (Patient, Observation, Condition, AllergyIntolerance, MedicationRequest, MedicationAdministration, Procedure, Encounter, Immunization, DiagnosticReport, DocumentReference, ServiceRequest, CarePlan). The requested scopes are built from that list, so delete any entry you do not tick.
3. Put its client ID in `explorer/config.js`.
4. In the Code Console, Begin Testing for the explorer app and Launch.

The explorer refuses to read any tenant other than the Cerner sandbox. Some resource types need specific search parameters on Cerner and may return a 400 or 403. The Result column shows the server's message, and the queries are in `explorer/config.js`.

## Safety behaviour built into the engine

- The highest level with any met criterion wins.
- Missing, stale or invalid required inputs never produce the lowest level. The result is "Unable to classify".
- A stale value can raise severity but cannot support a mild result.
- Values outside the plausible range, or with an unexpected unit, are rejected and shown as such.
- Observations marked entered-in-error or cancelled are ignored.
- Every criterion is shown as met, not met or no data.

## Known gaps before this could go near a ward

- Thresholds and actions in `pathway.json` are placeholders. The clinical lead must author and version them.
- Age is calendar age. Corrected age for preterm infants is not handled.
- The audit log lives in the browser tab only. A real deployment needs a server-side audit store.
- Bedside findings are typed in and not written back to the record.
- Not yet run against the live sandbox from the environment this was built in. Only the engine tests and a demo-mode smoke test were run.
- Production use at a hospital needs the app provisioned against that hospital's tenant through their Oracle Health contacts, plus local clinical governance, privacy review and a decision on regulatory status (TGA) for software that influences treatment.
