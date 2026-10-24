# NO CAP

A Chrome extension (Manifest V3) that helps teachers review whether students stayed on an authorized **Google Forms** exam. It records tab switches, new tabs, unauthorized pages, window-focus changes and page-visibility changes in a timestamped log, warns the student when it happens, and gives the instructor a local review screen.

> **Honest scope.** NO CAP is a deterrent and a source of supporting evidence. It cannot guarantee cheat prevention, its logs are not tamper-proof, and a record is **not proof** that a student cheated. Read [Known limitations](#13-known-limitations) before using it for a graded exam.

Google Forms still owns the questions, the answers and the submission. NO CAP never reads, changes or submits them.

---

## 1. Project title and overview

**NO CAP** watches the browser, not the student. During an active session it treats one Google Form as the only permitted page and records when the student leaves it.

## 2. Purpose and objectives

- Discourage leaving the exam page during an online exam.
- Record each departure with a time and the best information the browser can provide.
- Distinguish what was **detected** (for example, "activated a tab on `chatgpt.com`") from what **cannot be confirmed** (for example, "Chrome lost focus", which does not say what the student did).
- Keep everything local, minimal and transparent: the student sees the rules and the permissions before starting.

## 3. Features and limitations

**Features**

- Setup popup: validates and saves the exact Google Forms link, status shown as Not Started / In Progress / Violation Detected / Exam Ended, Start and End buttons, live incident count, elapsed time and recent incidents.
- Start only after the student opens the authorized form and accepts the rules.
- Detects: switching tabs, opening new tabs, activating or navigating to unauthorized pages, the exam tab navigating away, closing the exam tab, the exam page becoming hidden, and the Chrome window losing focus (with a configurable grace period).
- Configurable prohibited domains (ChatGPT and several other AI sites by default) and explicit allowed exceptions (Google sign-in by default).
- Best-effort recognition of PDF tabs and `file://` tabs.
- Warnings: desktop notification, popup warning, and a small dismissible banner on the exam page.
- Duplicate protection: the several events produced by one action (tab event, visibility event, URL event) become **one** incident.
- Optional **Strict Mode** (best effort) and optional violation threshold that flags a session for review.
- Local instructor review page with CSV and JSON export and print view.
- **Optional live teacher dashboard** (`dashboard/`): a hosted web app (deploys to Vercel with a Postgres database) where instructors create an account, create an exam, and watch student incidents arrive live. Students connect with a join code and consent. The instructor's form and rules are applied to every connected student. See [`dashboard/README.md`](dashboard/README.md).
- Recovers from extension reloads, browser restarts and closed tabs, and records the interruption.

**Limitations (summary)** — see section 13.

## 4. Technologies used

- Chrome Extensions Manifest V3 (service worker, content script, popup, options page)
- HTML5, CSS3, JavaScript (ES modules, no build step, no dependencies)
- Chrome APIs: `tabs`, `windows`, `storage`, `notifications`, `alarms`
- Page Visibility API (`visibilitychange`)
- Teacher dashboard: Vercel serverless functions (Node.js 22), Postgres on Neon, plain HTML/JS front end that polls for live updates
- Google Forms as the exam platform
- Git and GitHub for version control

## 5. Prerequisites

- Google Chrome **120 or newer** (or another Chromium browser that supports MV3 service workers and 30-second alarms)
- A published Google Form and its respond link
- Optional, for the automated checks and to run the teacher dashboard: Node.js 18 or newer

## 6. Installation

1. Download or clone this repository so the folder contains `manifest.json` at its top level.
2. Optional: run the automated checks (see [Manual testing](#12-manual-testing-instructions)).

## 7. Loading the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the repository folder (the one that contains `manifest.json`).
4. Pin **NO CAP** from the puzzle-piece menu so the popup is easy to reach.
5. If Chrome shows an error, open **Errors** on the extension card and check that the folder you selected is the one containing `manifest.json`.

Optional, for local-file detection: on the extension's **Details** page, enable **Allow access to file URLs**. Without it Chrome may hide `file://` addresses from the extension.

To exercise the logic in an Incognito window, enable **Allow in Incognito** on the Details page. Monitoring works only in profiles and windows where the extension is allowed to run.

## 8. Configuring the Google Forms exam URL

1. Open the form's respond page in a tab. The address contains `/forms/d/e/…` and ends in `/viewform`.
2. Click the NO CAP icon.
3. Press **Use current tab** (or paste the link and press **Save link**).

Accepted: `https://docs.google.com/forms/d/e/<id>/viewform` (also `formResponse`, which is normalized to `viewform`), including the Workspace form `/a/<domain>/forms/…` variant. Query strings and fragments are discarded.

Rejected, with a message: editor links (`/edit`), `forms.gle` short links, Google Docs/Sheets/Slides pages, non-HTTPS links and anything else. Only that one form is authorized; other pages on `docs.google.com` are **not** allowed.

## 9. Starting, monitoring and ending an examination

**Start**

1. Close other tabs you do not need. Anything left open counts as "another tab" if the student switches to it.
2. Open the authorized form in the window you will use and make sure that tab is active.
3. Open the popup, read the rules, tick the acceptance box, press **Start Exam**.

**While the exam runs**

- A small pill at the top right of the form shows monitoring status, the incident count and elapsed time. It does not block questions or answers.
- On an incident the student sees a notification, a banner on the form and a warning in the popup, with the incident count and time. **Resume exam** (banner) or **Return to exam page** (popup) acknowledges the warning. Incidents are never deleted by returning.
- If the exam tab was closed, **Return to exam page** reopens the form.
- Settings and the full log are locked while the exam runs, so viewing them cannot disturb the exam page. The popup shows the three most recent incidents.

**End**

Press **End Exam** twice (the second press confirms). Monitoring stops. Finished sessions are kept until deleted.

**Review**

Open the popup footer's **Open session log** (or Settings → Open session log). Choose a session. The log shows the session id, start and end times, duration, incident count, review flag, interruptions, and for each incident the time, category, evidence level, domain and notes. Use **Export CSV**, **Export JSON** or **Print**.

## 10. Permission explanations

| Permission | Why it is needed |
|------------|------------------|
| `tabs` | Read the **address** of tabs (to compare against the authorized form and the prohibited list) and receive tab events: created, activated, updated, closed. This is the broadest permission. NO CAP only uses it while a session is active, and stores domains only. |
| `storage` | Save settings, the current session and finished sessions in `chrome.storage.local`. Nothing is synced to Google; data leaves the device only if the student connects to an instructor dashboard. |
| `notifications` | Show a desktop notification when an incident is recorded. |
| `alarms` | A 30-second heartbeat so that, after a crash or restart, the log can say how long monitoring was interrupted. |
| Content script on `https://docs.google.com/forms/*` and `https://docs.google.com/a/*/forms/*` | Reports Page Visibility changes and shows the in-page pill and warning banner. It runs on Google Forms pages only, never reads form content, and uses a closed shadow root so it cannot disturb the form's own styling. |
| Optional host access (`https://*/*`, `http://*/*`) | **Optional and off by default.** Used only if a student connects to an instructor dashboard: Chrome asks the student to allow NO CAP to contact that one address, and requests go nowhere else. |

There are **no** required host permissions, no remote code, no network requests unless the student connects to a dashboard, and no `scripting`, `history`, `webRequest`, `cookies`, `desktopCapture` or `debugger` permissions. The window APIs used for focus monitoring need no permission.

## 11. Privacy and data handling

- **Stored locally by default** (`chrome.storage.local`), in this browser profile. Nothing is uploaded unless the student chooses to connect to an instructor dashboard (see below). Without a connection, a teacher on another computer sees the data only if the log is exported and shared.
- **Stored:** session id, start/end times, incident times, category, domain (for example `chatgpt.com`), domain category, short detail text, and the settings in force.
- **Not stored:** questions, answers, form content, passwords or Google account details, full URLs, paths, query strings, page titles, screenshots, keystrokes, or unrelated browsing history. The only tab addresses read are those of tabs the student activates or navigates to during an active session, and they are reduced to a domain immediately.
- Monitoring is **visible**: the student sees the rules and agrees before starting, and the pill is shown on the exam page while it runs.
- Nothing is monitored outside an active session.
- **Instructor dashboard (opt-in).** If the student connects, they must tick a consent box naming what is sent: their name (and optional student ID) and their incident records (times, categories, website domains, short details). The in-page pill says “Reporting to instructor” while it runs and the popup shows the connection. Page addresses beyond the domain, answers, form content and tab ids are never sent. The dashboard operator is responsible for retention (30 days by default, deletable at any time).
- Logs persist until intentionally deleted (Settings → **Delete all session logs** or **Delete logs and restore defaults**). Exported files may contain student-identifying context; handle them according to your institution's policy. Check that your use of monitoring complies with your school's rules and local law, and tell students in advance.
- The logs are supporting evidence for an instructor's review, not definitive proof.

## 12. Manual testing instructions

Automated checks (Node 18+; the dashboard tests need `npm install` once inside `dashboard/`):

```bash
node tests/static-check.mjs      # manifest, referenced files, minimal permissions
node tests/shared.test.mjs       # URL validation and classification
node tests/background-sim.mjs    # detection and de-duplication against a mocked chrome API
node tests/dashboard.test.mjs    # dashboard backend: accounts, isolation, join/sync, polling, CSV, retention
node tests/dashboard-integration.mjs   # real extension code against the real dashboard backend
```

Manual tests in real Chrome are listed with expected results in [`tests/detection-tests.md`](tests/detection-tests.md). They cover starting from an authorized URL, tab switching, new tabs, prohibited sites, focus loss and regain, minimizing, closing the exam tab, returning after a warning, duplicate-free counting, ending and reviewing a session, extension reload and restart handling, and normal form use and submission.

## 13. Known limitations

- **No guarantee.** A student can bypass a browser extension: another browser or profile, a second device, a phone, a virtual machine, disabling or removing the extension, or opening the form before starting a session. Strict Mode makes this harder, not impossible.
- **Focus loss is ambiguous.** When Chrome loses focus the browser does not say which application received it. NO CAP records "window lost focus" as **not confirmed** and never claims a specific application was used. Notifications, system dialogs and accidental clicks can also cause it (hence the grace period).
- **Native applications are invisible.** A browser extension cannot reliably tell whether the student opened Word, Notepad, a separate PDF reader, locally stored notes or any other desktop program. Only a Chrome tab with a visible `file://` or `.pdf` address can be recognized, and `file://` addresses need "Allow access to file URLs".
- **Same-screen use is not detected**, for example a second monitor showing notes while Chrome keeps focus.
- **Logs are not tamper-proof.** They live in the student's browser profile and are produced by software on the student's computer.
- **Visibility vs. other tabs in a split view or separate window:** a visible second window next to the exam window is detected only if the student clicks into it.
- **New tabs opened by links inside the form** (for example a link in a question) are recorded as new tabs, because the browser cannot tell intent.
- **Extension reload:** tab and focus monitoring continue, but the exam page must be reloaded to restore the in-page pill and visibility monitoring; reloading a form may discard unsaved answers, which is Google Forms behavior.
- **Published links only:** the extension matches the `/forms/d/e/…` respond link; `forms.gle` short links and editor links cannot be matched.
- **Incognito and other profiles** are only monitored if the extension is enabled there.
- **Reporting needs the optional dashboard.** Without it, records reach an instructor only through manual export. With it, reports are live but depend on the student's network and are produced by software on the student's computer, so a student who disables or blocks the extension simply stops reporting (the dashboard shows “Not reporting”, which is not proof of anything).
- **Dashboard scope:** accounts are email and password with no email verification or email-based reset (the operator can set a new password, see `dashboard/README.md`). Restrict sign-ups with `ALLOWED_EMAIL_DOMAINS` or `INSTRUCTOR_SIGNUP_CODE`, otherwise anyone who finds the address can create an instructor account. There is no single sign-on.
- **Test coverage:** the automated scripts use a mocked Chrome API. Behavior in real Chrome across operating systems should be confirmed with the manual test plan.

When stronger control is required, use a separately authorized, managed examination environment (managed devices, kiosk or lockdown mode, supervised testing center) rather than expecting a browser extension to provide it.

## 14. Future improvements

- Per-teacher accounts and single sign-on for the dashboard, and a hosted option.
- Managed-policy deployment (`chrome.storage.managed`) so administrators can lock settings centrally on school devices.
- Support for several authorized forms or timed windows per session.
- Signed or hashed log entries to make casual tampering easier to notice.
- Localization and richer accessibility options for the warning banner.
- Localized review reports (PDF export).

## 15. License

MIT. See [LICENSE](LICENSE).

---

## Repository structure

```text
no-cap/
├── manifest.json        Manifest V3 definition
├── background.js        Service worker: detection, incident logging, session lifecycle
├── content.js           Google Forms page: visibility reporting, status pill, warning banner
├── shared.js            Pure helpers: URL validation/classification, categories, formatting
├── popup.html/.css/.js  Setup, start/end, live status
├── options.html/.css/.js  Detection settings, domain lists, data deletion
├── review.html/.css/.js   Local instructor review screen and export
├── icons/               16, 48 and 128 px icons
├── dashboard/           Optional hosted teacher dashboard (Vercel + Postgres)
│   ├── api/[...path].js     Vercel serverless entry point (all /api routes)
│   ├── lib/                 Backend: handler, database, passwords, validation
│   ├── public/              Dashboard page (index.html, app.js, style.css)
│   ├── local.js             Run the same backend on your own computer
│   ├── vercel.json          Deployment settings and daily retention cron
│   └── README.md            Deployment, accounts, security model
├── tests/
│   ├── detection-tests.md   Manual and automated test plan with expected results
│   ├── static-check.mjs     Manifest and file-reference validation
│   ├── shared.test.mjs      Unit tests for shared.js
│   ├── background-sim.mjs   Detection logic against a mocked chrome API
│   ├── dashboard.test.mjs   Dashboard backend tests (real Postgres engine)
│   └── dashboard-integration.mjs  Extension background code against the real backend
├── README.md
├── .gitignore
└── LICENSE
```

## Requirement status

| Area | Status |
|------|--------|
| Tab switching, new tabs, activating or navigating to unauthorized pages, exam tab closed | **Implemented** (uses tab events and URLs) |
| Page-visibility monitoring | **Implemented** (content script) |
| Window-focus monitoring with grace period | **Implemented**, but the result is always **not confirmed** about what the student did |
| Prohibited domains (configurable, ChatGPT and other AI sites by default) | **Implemented** for Chrome tabs in the monitored profile |
| Warnings (notification, popup, in-page banner), counter, timestamps, return to exam, preserved logs | **Implemented** |
| Violation threshold and review flag | **Implemented** (a flag, not a verdict) |
| Local instructor review, CSV/JSON export | **Implemented** (local only) |
| Duplicate-free counting | **Implemented** (merge window; covered by simulated tests) |
| Reload and restart handling | **Implemented**, with the reload caveat above |
| Strict Mode (close new tabs, return to exam tab, go back) | **Best effort**; can be bypassed |
| PDF and local-file tabs | **Best effort**; depends on Chrome exposing the address and on the file-access toggle |
| Other applications (Word, Notepad, separate PDF readers, local notes) | **Cannot be detected** by an extension; needs a managed examination environment |
| Other browsers, profiles, devices | **Cannot be detected** |
| Live delivery of incidents to an instructor dashboard | **Implemented** as an opt-in hosted web app with instructor accounts (`dashboard/`). The backend and its link to the extension are tested; actual Vercel/Neon deployment and the dashboard page in a browser still need the manual checks in `tests/detection-tests.md` |
| Teacher-controlled form and rules per exam | **Implemented** (applied when a student connects and again at Start Exam) |
| Institution single sign-on, email verification, email password reset | **Not implemented** |
