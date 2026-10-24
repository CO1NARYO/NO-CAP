# NO CAP test plan

Tests marked **[AUTO]** are covered by the scripts in this folder. Tests marked **[MANUAL]** must be run by a person in real Chrome, because Chrome's tab, window and focus behavior cannot be fully reproduced in a script.

## Automated checks

```bash
node tests/static-check.mjs      # manifest valid, every referenced file exists, permissions are minimal
node tests/shared.test.mjs       # URL validation, URL classification, helpers
node tests/background-sim.mjs    # detection, merging and lifecycle logic against a mocked chrome API
node tests/dashboard.test.mjs    # dashboard backend: accounts, isolation, join/sync, polling, CSV, retention
node tests/dashboard-integration.mjs   # real extension background code against the real dashboard backend
```

Expected: each script ends with a "passed" line and exits with code 0.

## Setup for manual tests

1. Load the extension (see README, "Installation").
2. Create a throwaway Google Form with two or three questions. Click **Send**, copy the link, and open it in Chrome. The address should contain `/forms/d/e/` and end with `/viewform`.
3. Use a second Chrome tab on any ordinary website (for example `https://example.com`) as the "other tab".
4. In **Settings**, leave the defaults: Strict Mode off, grace period 3 s, threshold 3.
5. Between tests, open the popup and press **Return to exam page** to clear the warning. Incidents are kept; only the warning is dismissed. To test counts from zero, end the exam and start a new session.

## Test cases

| ID | Type | Steps | Expected result |
|----|------|-------|-----------------|
| T01 | MANUAL | Open the popup on a non-Forms page. Paste the form link and press **Save link**. | “Link saved.” The saved link is shown. |
| T02 | AUTO + MANUAL | Paste `https://example.com`, `https://forms.gle/abc`, a `/edit` link and a Google Docs link, pressing **Save link** each time. | Each is rejected with a specific message. The saved link does not change. |
| T03 | MANUAL | With the saved link set, but the form **not** open, tick the rules box. | **Start Exam** stays disabled and the popup says to open the exam form. |
| T04 | MANUAL | Open the form, open the popup, tick the rules box, press **Start Exam**. | Status bubble moves to **In Progress**. Badge shows `ON`. A small “NO CAP monitoring on” pill appears at the top right of the form. Question fields still work normally. |
| T05 | MANUAL | Try to start without ticking the rules box. | Start is not possible. |
| T06 | MANUAL | Click your other tab (`example.com`). | One incident: category **Switched to another tab**, domain `example.com`, evidence **Detected**. Desktop notification appears. Badge shows `1` in red. |
| T07 | MANUAL | Return to the exam tab. Look at the page. | A warning banner shows the message and a **Resume exam** button. The banner does not cover the questions. Status is **Violation Detected**. |
| T08 | MANUAL | Press **Resume exam** (or **Return to exam page** in the popup). | Banner disappears, status returns to **In Progress**, the incident count is unchanged, and the incident still exists in the log. |
| T09 | AUTO + MANUAL | Press Ctrl+T (new tab) and leave it open, then return to the exam. | **One** incident (**New tab opened**), not two or three, even though several browser events fired. |
| T10 | AUTO + MANUAL | In a tab, visit `https://chatgpt.com`, then return. | One incident, category **Prohibited website**, domain `chatgpt.com`, domain category **AI assistant**. No page path or query is stored. |
| T11 | MANUAL | Add `example.com` as a prohibited domain in Settings (before starting a new session), then visit it. | Category becomes **Prohibited website** for `example.com`. |
| T12 | MANUAL | In the exam tab, type another site's address and press Enter. | Incident **Unauthorized webpage** with that domain. Pressing Back returns to the form. |
| T13 | MANUAL | Open a PDF in Chrome (for example a link to a `.pdf` file) and view it. | Incident **Local file or PDF tab**, domain category **PDF document**. |
| T14 | MANUAL | Open a local `.pdf` or `.html` file with `file://` in Chrome. | Incident **Local file or PDF tab** if Chrome exposes the address. If you do not enable “Allow access to file URLs” for the extension, the result may be **Not confirmed**; this is expected and documented. |
| T15 | AUTO + MANUAL | Click on another application (for example Notepad) and stay there for 10 seconds, then return to Chrome. | One incident **Window lost focus**, evidence **Not confirmed**. The log does **not** claim which application was used. |
| T16 | AUTO + MANUAL | Click another application for 1 second and return. | No incident (shorter than the 3 s grace period). The review page notes one ignored brief focus loss. |
| T17 | AUTO + MANUAL | Minimize Chrome for 10 seconds, then restore. | **One** incident (not one for focus plus one for visibility). The log shows both signals on that incident. |
| T18 | MANUAL | Open the exam page in a second Chrome window and switch to it, then back. | An incident is recorded for leaving the monitored window or tab. |
| T19 | AUTO + MANUAL | Close the exam tab. | Incident **Exam tab closed**. The popup warns the student. |
| T20 | MANUAL | After T19, press **Return to exam page** in the popup. | The form is reopened and monitoring re-attaches without recording an extra “new tab” incident. (The form's unsaved answers may be lost; that is Google Forms behavior.) |
| T21 | MANUAL | Turn on **Strict Mode** in Settings, start a new session, and open a new tab. | The new tab is closed and the exam tab is focused. The incident is still recorded. |
| T22 | MANUAL | With Strict Mode on, navigate the exam tab to another site. | The tab goes Back to the form. The incident is still recorded. |
| T23 | AUTO + MANUAL | Reach the threshold (default 3 incidents). | The popup shows **Flagged**. The review page shows the session as flagged and describes it as a review flag, not a finding of misconduct. |
| T24 | MANUAL | During an exam, open the popup. Try to open Settings or the full log. | Both are disabled. The popup shows the three most recent incidents instead. Settings cannot be changed mid-exam. |
| T25 | AUTO + MANUAL | Press **End Exam** twice (it asks for confirmation). | Status is **Exam Ended**. Monitoring stops: switching tabs afterwards records nothing. |
| T26 | MANUAL | Open **Open session log** (popup footer). | Session id, start and end times, duration, total incidents, each incident's time, category, evidence (Detected or Not confirmed), domain and notes are shown. Export CSV, Export JSON and Print work. |
| T27 | AUTO + MANUAL | Start a new session after ending one. | The older session is still in the log dropdown. Nothing was deleted. |
| T28 | MANUAL | Go to chrome://extensions and reload NO CAP during an exam. | The session continues. The log shows a “Monitoring was interrupted (extension reloaded or updated)” event and earlier incidents are still there. Tab and focus monitoring continue. Reload the exam page to restore the in-page pill and visibility monitoring. |
| T29 | MANUAL | Quit Chrome during an exam and reopen it with the form restored. | On restart the log shows an interruption event, the exam tab is found again, and no false “new tab” incidents are recorded in the first few seconds. |
| T30 | MANUAL | Answer questions, move between form sections, and submit the form while monitored. | The form behaves normally. NO CAP never changes or submits answers. After submission the log shows a note that the confirmation page was reached. |
| T31 | MANUAL | In Settings, press **Delete all session logs** (twice to confirm) after ending the exam. | All sessions disappear from the review page. Settings stay. During an exam this button is disabled. |
| T32 | MANUAL | Inspect chrome://extensions → NO CAP → Details. | Permissions shown match README. No site-access permission beyond Google Forms pages. |
| T33 | MANUAL | Open DevTools → Application → Storage → Extension storage (or inspect the service worker) and look at stored incidents. | Only domains, categories, times and detail text are stored. No question text, answers, page paths or query strings. |

## Dashboard tests (hosted instructor dashboard)

Setup: deploy the dashboard (see `dashboard/README.md`) or run it locally with `cd dashboard && npm install && npm run dev` and open `http://127.0.0.1:8787`. Use a second Chrome profile or window as the "student", with a throwaway Google Form.

| ID | Type | Steps | Expected result |
|----|------|-------|-----------------|
| D01 | AUTO | Run `node tests/dashboard.test.mjs` and `node tests/dashboard-integration.mjs`. | Both end with a “passed” line. |
| D02 | MANUAL (after deploying) | Open `https://<your-project>.vercel.app/api/config`. | JSON such as `{"signupCodeRequired":…}` appears. If you get a 404 or a Vercel error page, the `dashboard` folder was not set as the Root Directory or the function did not deploy. |
| D03 | MANUAL | Create an account with a weak password, then a valid one. | The weak one is refused with a message. The valid one lands on the empty dashboard. |
| D04 | MANUAL | If you set `ALLOWED_EMAIL_DOMAINS` or `INSTRUCTOR_SIGNUP_CODE`, try signing up outside the rule. | Refused with a clear message. |
| D05 | MANUAL | Sign out, sign in with the wrong password, then the right one. | Same error message for wrong password and unknown email. Repeated failures are limited. |
| D06 | MANUAL | Create an exam with a bad form link (`https://forms.gle/x`), then a valid one. | The bad link is rejected. The valid exam shows a 6-character join code. |
| D07 | MANUAL | Student profile: NO CAP → Settings → Instructor dashboard. Try Connect without consent, with a wrong code, then correctly. | Each failure shows a clear message. Success shows “Connected to …” after Chrome's one-time permission prompt. The student appears as **Joined** within about 3 seconds. |
| D08 | MANUAL | Student presses **Start Exam**. | **Live / In progress** appears within a few seconds. The form pill says “Reporting to instructor”. |
| D09 | MANUAL | Student switches to another tab. | A row highlight and a **Latest incidents** entry appear within about 3 seconds, without refreshing. The count rises by exactly one. |
| D10 | MANUAL | Student clicks into another application for 10 s and returns. | **Window lost focus** with evidence **Not confirmed**. |
| D11 | MANUAL | Reach the review threshold. | A **Flagged for review** badge appears and the Flagged chip counts it. |
| D12 | MANUAL | Student presses **Resume exam**. | Status returns from **Violation detected** to **In progress**. The incident remains. |
| D13 | MANUAL | Sign in as a second instructor account in a private window. | The second account sees none of the first account's exams. |
| D14 | MANUAL | Student goes offline for two minutes. | **Not reporting** appears with the last report time. No accusation is made. |
| D15 | MANUAL | Edit the exam's rules, then the student starts a new session. | The new session uses the new rules. A running session keeps its old ones. |
| D16 | MANUAL | **Stop accepting students**, then try to join from another profile. | “Unknown or closed join code.” |
| D17 | MANUAL | **Export CSV**. | One row per incident, opens in a spreadsheet. |
| D18 | MANUAL | Leave the exam idle for 10+ minutes (database may sleep), then open the dashboard and have a student sync. | First request may be slower (a second or two) but succeeds. Test this before the exam day. |
| D19 | MANUAL | **Delete exam and records**, then account deletion with a wrong and then the right password. | Wrong password is refused without signing you out. Right password removes the account and all its data. The student's popup reports the connection is no longer accepted. |
| D20 | MANUAL | After a day, check Vercel → Project → Cron Jobs / Logs. | `/api/cron/purge` ran and returned 200 (needs `CRON_SECRET` set). |

## Reporting results

For each manual test record: Chrome version, operating system, Pass/Fail, and notes. A failed test that involves another application, another browser or another device is not a bug: those are listed as limitations in the README.
