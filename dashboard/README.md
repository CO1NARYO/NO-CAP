# NO CAP teacher dashboard (hosted)

A web app where instructors **create an account and sign in** to watch NO CAP incidents arrive live during a Google Forms exam. Instructors install nothing: they open your dashboard's web address. It runs on **Vercel** with a **Postgres** database (Neon).

Students keep using the NO CAP Chrome extension. They opt in by connecting to the dashboard with a join code; until then nothing leaves their computer.

> **What the dashboard can and cannot see.** It shows what the extension records: tab switches, new tabs, unauthorized or prohibited websites (domain only), exam-tab closures, page-hidden events and window-focus losses. It cannot see other applications, other devices or other browsers. “Not confirmed” incidents say only that the window lost focus. A report is supporting evidence for an instructor's review, never proof of cheating.

There are two roles:

- **The operator** (you, once): deploys the dashboard and decides who may create instructor accounts.
- **Instructors**: sign in, create exams, share a join code, watch the class.

---

## Part 1: Deploy it (operator, about 15 minutes)

You need a free [GitHub](https://github.com) account, a [Vercel](https://vercel.com) account, and this repository pushed to GitHub.

> This has not been deployed on real Vercel or Neon from where it was written. The backend is tested against a real Postgres engine, but follow the smoke test in step 7 before an exam.

### 1. Push the repository to GitHub

```bash
git init && git add . && git commit -m "NO CAP"
# create an empty repository on GitHub, then:
git remote add origin https://github.com/<you>/no-cap.git
git push -u origin main
```

### 2. Import the project on Vercel

1. Vercel dashboard → **Add New… → Project** → import your repository.
2. **Root Directory:** click *Edit* and choose **`dashboard`**. This matters: the dashboard lives in that folder.
3. **Framework Preset:** *Other*. Leave the build command empty. (`vercel.json` already sets the output folder to `public`.)
4. Press **Deploy**. The first deploy will work, but the database is not connected yet.

### 3. Add the database

1. In the project, open **Storage** (or the Vercel Marketplace) and add **Neon Postgres**, then connect it to this project.
2. Vercel adds a `DATABASE_URL` environment variable automatically. The app creates its own tables on first use, so there is nothing to migrate by hand.

### 4. Set the environment variables

Project → **Settings → Environment Variables**:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes (added by step 3) | Postgres connection string. |
| `ALLOWED_EMAIL_DOMAINS` | recommended | Only these email domains may create an instructor account, for example `school.edu,uni.edu`. |
| `INSTRUCTOR_SIGNUP_CODE` | recommended | Instructors must also enter this invitation code when creating an account. |
| `CRON_SECRET` | yes, for automatic deletion | A long random string. Vercel sends it to the daily cleanup job (`/api/cron/purge`). Without it, nothing is purged automatically. |
| `RETENTION_DAYS` | optional (default `30`) | Exams with no student activity for this many days are deleted. `0` turns off automatic deletion. |

> **Set at least one of `ALLOWED_EMAIL_DOMAINS` or `INSTRUCTOR_SIGNUP_CODE`.** If neither is set, anyone who finds the address can create an instructor account and store student records in your database.

Then **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.

### 5. Open it and create the first account

Go to `https://<your-project>.vercel.app`, choose **Create account**, and sign up. Give instructors that same address and the invitation code (if you set one).

### 6. Tell students the address

Students enter your `https://…vercel.app` address plus the exam's join code (shown on the dashboard) in NO CAP → Settings → Instructor dashboard. NO CAP requires `https://` for any non-local address, which Vercel provides automatically. You can use your own domain later (Vercel → Settings → Domains); tell students which address to use.

### 7. Smoke test before real use

1. Open `https://<your-project>.vercel.app/api/config`. You should see JSON. If you see a 404 or an error page, check that **Root Directory** is `dashboard` and that the deployment succeeded.
2. Create an account, create an exam, and connect a second Chrome profile as a student.
3. Start the exam as the student, switch tabs, and confirm the incident appears on the dashboard within about 3 seconds.
4. Work through the dashboard checklist in `tests/detection-tests.md` (D02 to D20).

### Things to know

- **Vercel plan:** the free Hobby plan is meant for personal, non-commercial use. Check Vercel's terms for your school's situation; an institution may need a paid plan.
- **Database sleep:** Neon's free tier suspends idle databases. The first request after a quiet period can take a second or two. Open the dashboard a few minutes before an exam.
- **Free-tier limits:** check the current Vercel and Neon limits (function invocations, storage, compute hours) against your class size. Every connected student reports about every 30 seconds plus once per change.
- **Daily cleanup:** Vercel Cron on the free plan runs at most once per day, which is what `vercel.json` schedules (03:00 UTC).
- **Forgot password:** there is no email reset. The operator can set a new password:

  ```bash
  cd dashboard && npm install
  DATABASE_URL="<your Neon connection string>" node scripts/set-password.mjs teacher@school.edu "a-new-long-password"
  ```

  Instructors can also delete their own account from the dashboard.

---

## Part 2: Using it (instructors)

1. Open the dashboard address, then **Create account** (with the invitation code if asked) or **Sign in**.
2. **New exam:** enter a title and, ideally, the form's published respond link (it contains `/forms/d/e/` and ends in `/viewform`). Review the rules (strict mode, focus-loss grace period, review threshold, prohibited and allowed sites) and create it. You get a **6-character join code**.
3. Give students the dashboard address and the join code. They connect from NO CAP → **Settings → Instructor dashboard**, tick the consent box and press **Connect**. Their extension then uses your form and rules.
4. Once everyone has joined, press **Stop accepting students**.
5. During the exam, the roster updates about every 3 seconds with no refresh:
   - **Live** means reporting normally. **Not reporting** means no report for 90 seconds (closed laptop, lost Wi-Fi, crash or disabled extension). It is a prompt to check on the student, not evidence of cheating.
   - **Detected** means NO CAP saw a concrete action (a tab switch, a prohibited domain). **Not confirmed** means only that the window lost focus or the page was hidden. NO CAP cannot say what the student did.
   - **Flagged for review** means the student reached your incident threshold. It is not a finding of misconduct.
   - Click a student for their incidents, times, domains and session events. Use search, **Flagged only**, **With incidents** and sorting to focus, and the optional beep for new incidents.
6. After the exam, **Export CSV**, then **Delete exam and records** when you are finished. Records are also deleted automatically after the retention period.

Instructors only ever see their own exams.

---

## Running it on your own computer instead (optional)

The same backend runs locally with an in-process Postgres, with no Vercel and no Neon:

```bash
cd dashboard
npm install
npm run dev          # http://127.0.0.1:8787, data in ./data
```

Create an instructor account on the sign-in page. Students on the same network can connect to `http://<your-computer's-address>:8787` only if you start it with `HOST=0.0.0.0`; NO CAP allows plain `http://` only for localhost and school network addresses.

---

## How it works

- **Front end:** static files in `public/` (plain HTML and JavaScript, no framework). It polls `GET /api/exams/:id/live?since=…` every 3 seconds, and the server returns only students that changed since the last cursor. Vercel functions cannot hold a connection open, so polling replaces a push stream.
- **Back end:** one serverless function, `api/[...path].js`, serves all `/api/*` routes through `lib/app.js`. State lives only in Postgres (accounts, sign-in sessions, exams, students, reports, rate limits), so any number of function instances can serve a request.
- **Student API** (called by the extension, CORS enabled): `POST /api/join`, `POST /api/policy`, `POST /api/sync`.
- **Instructor API** (cookie session): `POST /api/signup|login|logout|account/delete`, `GET /api/me`, `GET|POST /api/exams`, `GET|PATCH|DELETE /api/exams/:id`, `GET /api/exams/:id/live`, `GET /api/exams/:id/export.csv`.
- **Cleanup:** `GET /api/cron/purge` (Vercel Cron, protected by `CRON_SECRET`).
- **`shared.js`** is copied from the extension (the single source of truth) into `lib/` and `public/`. After editing the root `shared.js`, run `npm run sync-shared`; `tests/static-check.mjs` fails if the copies drift.

## Security model

- **Passwords:** stored only as salted scrypt hashes. Sign-in errors are identical for unknown emails and wrong passwords, and unknown emails take as long to check as wrong passwords.
- **Sessions:** a random token in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie. Only its hash is stored. Sessions last 7 days and end on sign-out.
- **CSRF:** every state-changing request needs a custom header and a same-origin `Origin`.
- **Rate limits:** sign-in, sign-up and join attempts are limited in the database, so they hold across serverless instances.
- **Isolation:** every exam query is scoped to the signed-in instructor. Tests confirm another account gets “not found” when reading, editing, exporting or deleting someone else's exam.
- **Student access:** a join code yields a random per-student token (stored hashed) that can only report that student's own sessions.
- **Untrusted input:** reports are validated and size-limited, and unknown fields are dropped. A student can still edit their own report, which is why records are not tamper-proof.
- **Browser hardening:** strict Content-Security-Policy (no inline scripts or styles), all text rendered as text, CSV export neutralises spreadsheet formulas, HSTS.
- **Not included:** email verification, email-based password reset, multi-factor authentication, institution single sign-on, audit logs.

## Privacy and retention

Stored per instructor: name, email, password hash. Stored per student: name, optional student ID, join and consent time, last report time, and session reports (incident times, categories, website domains, short detail text). Not stored: page paths or query strings, form content or answers, screenshots, keystrokes or browsing history.

Exams are deleted automatically after `RETENTION_DAYS` of inactivity (30 by default) and immediately when an instructor presses **Delete exam and records**. Instructors can delete their whole account and everything under it. Exported CSV files are copies for which the instructor is responsible.

Check that collecting and keeping this data complies with your institution's policy and local law, tell students in advance which service receives their records, and remember that your database provider and Vercel process this data on your behalf.

## Tests

From the repository root (run `npm install` once inside `dashboard/` first):

```bash
node tests/dashboard.test.mjs              # accounts, isolation, join/sync, polling, CSV, retention, restrictions
node tests/dashboard-integration.mjs       # the real extension background code against the real backend
node tests/static-check.mjs                # file layout, vercel.json, shared.js copies in sync
```

These use a real Postgres engine (PGlite) and real HTTP, but not Vercel or Neon themselves, and not a browser. The dashboard page's appearance and the Vercel deployment need the manual checks in `tests/detection-tests.md` (D02 to D20).
