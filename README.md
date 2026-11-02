# HireHound

**Your AI job-hunting agent. It sniffs out the right roles and applies while you sleep.**

HireHound finds jobs on Internshala (plus LinkedIn and Naukri in agent mode), decides which ones are worth it, and applies from **your own logged-in Chrome window**. An AI model scores every listing and writes honest, tailored answers using only facts from your profile, for about a cent per application.

Maintained by **Vishwanath B** ([GitHub](https://github.com/vishwab0815) · [LinkedIn](https://linkedin.com/in/vishwab0815)).

---

## How it works

You open Chrome with remote debugging turned on and log in to your job sites as usual. The bot connects to that window, so it uses your real session: no stored passwords, no separate headless browser.

There are two modes, set with `BOT_MODE`:

| | `scripted` (default, Internshala) | `agent` (any site) |
|---|---|---|
| Who drives the browser | Plain Playwright code | The AI model, step by step through Playwright MCP |
| LLM calls | 1 per listing page (scoring) + 1 per application (answers) | 20-80 per application |
| Typical cost | about **$0.006 per application** | about $0.50-0.90 per application |
| Typical time | about 20 seconds per application | 3-5 minutes per application |

In scripted mode a run looks like this:

1. Open each Internshala search URL and read the listing cards.
2. Drop anything already applied to, already seen, on your blocklist, or ruled out by a hard rule (location, English level).
3. Score the rest in **one** call to a cheap model (Haiku), strictly, against your profile.
4. For each job above `MIN_SCORE`: open it, open the Easy Apply form, and read every question.
5. Make **one** call to write all the answers and the cover letter, using only facts from your profile.
6. Fill the form, click submit, then reload the job page and count the application **only** if Internshala shows "Already applied".

## Safety rails

- **Dry run is enforced in code.** With `DRY_RUN=true` the form is filled and screenshotted, but the submit button is never clicked.
- **Limits:** `DAILY_LIMIT`, `MAX_PER_RUN`, a USD cost cap (`MAX_COST_USD`), and at most one application per company per day.
- **Verified submissions:** an application is only recorded after Internshala confirms it.
- **Honest answers:** the prompts forbid made-up skills, ratings are capped at 4/5, and generated text is checked for technologies that aren't in your profile.
- **Skips instead of guessing:** forms with fields the bot can't fill (file uploads, unknown widgets) are skipped, not half-submitted.
- **Privacy:** contact details are swapped for placeholders before text goes to the helper LLM. The dashboard only listens on `localhost`. Your profile, answers, resume, database and browser profile are all git-ignored.

---

## Quick start

### 1. Requirements

- Node.js 18 or newer (tested on 24). No C++ build tools needed.
- Google Chrome
- An Anthropic API key: https://console.anthropic.com/settings/keys

### 2. Install

```bash
git clone https://github.com/vishwab0815/hirehound.git
cd hirehound
npm install
```

### 3. Configure

```bash
cp .env.example .env
cp config/profile.example.json config/profile.json
cp config/answers.example.json config/answers.json
cp config/resumes.example.json config/resumes.json
```

- `.env`: add your `ANTHROPIC_API_KEY`. Keep `DRY_RUN=true` for the first run.
- `config/profile.json`: your real details. The bot never writes anything that isn't backed by this file.
- `config/answers.json`: your own answers to common questions (salary, notice period, night shifts, ...).
- `config/resumes.json`: your resume PDF(s). Put the files in `assets/`.
- `config/sites.json`: which sites and search URLs to use. Only Internshala is enabled by default.

### 4. Start Chrome with remote debugging

Use a separate profile folder so it doesn't clash with your everyday Chrome:

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%CD%\chrome-profile

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$PWD/chrome-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$PWD/chrome-profile"
```

Log in to Internshala (and any other site) in that window. If port 9222 is taken (on Windows, Edge WebView sometimes uses it), pick another port and set `CDP_ENDPOINT` to match.

### 5. Run

```bash
npm start
```

Check the log and the dashboard at http://localhost:3000. Every answer the bot writes is printed in the log, so you can read exactly what would be sent. When you're happy, set `DRY_RUN=false` and run it again.

---

## Configuration

### `.env`

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `BOT_MODE` | `scripted` | `scripted` for fast Internshala automation, `agent` to let the model drive any site |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Writes the form answers (and drives the agent) |
| `SCORING_MODEL` | `claude-haiku-5-5` | Scores listings in scripted mode |
| `CDP_ENDPOINT` | `http://localhost:9222` | Chrome remote debugging address |
| `DRY_RUN` | `true` | Fill forms but never submit |
| `DAILY_LIMIT` | `10` | Max applications per day |
| `MAX_PER_RUN` | `3` | Max applications per run |
| `MIN_SCORE` | `6` | Minimum match score (1-10) |
| `MAX_COST_USD` | `2` | Stop the run once API spend passes this (0 = no cap) |
| `DELAY_MIN` / `DELAY_MAX` | `2000` / `5000` | Random pause between actions, in ms |
| `LLM_AUX_PROVIDER` / `LLM_AUX_MODEL` | `anthropic` / `claude-haiku-5-5` | Helper model for cover letters, tailored resumes and recruiter notes (`anthropic`, `ollama` or `openai`) |
| `TELEGRAM_*`, `SMTP_*`, `EMAIL_RECIPIENT` | empty | Optional notifications and email reports |
| `CRON_ENABLED` / `CRON_TIME` | `false` / `09:00` | Run automatically once a day |
| `CHROME_PATH` | auto | Chrome binary used to print tailored resumes to PDF |

### Tracking outcomes

```bash
npm run result                 # list recent applications with ids
npm run result 12 interview    # waiting, replied, interview, offer, rejected, no_response
```

Outcomes show up as a reply rate and an interview count on the dashboard.

---

## Upgrading from the Portuguese version

- **Config files:** `npm run migrate-config` converts `perfil.json`, `respostas.json` and `curriculos.json` into `profile.json`, `answers.json` and `resumes.json`, and updates `sites.json` in place. Existing files are never overwritten unless you pass `-- --force`.
- **Database:** nothing to do. On first start, `data/candidaturas.db` is copied into the new `data/applications.db`, and the old file is kept as a backup.

---

## Project structure

```
src/
  index.ts            entry point: loads config, runs the scripted and/or agent flows
  config.ts           .env and config/*.json loading
  types.ts
  core/               logger, sql.js database, error classification, token/cost tracker, scheduler
  scripted/           Internshala scripted mode, its prompts, structured-output LLM call
  agent/              MCP agent loop, custom tools, history pruning, Playwright MCP client
  filters/            rule-based job score and deal breakers, company/title blocklist
  llm/                helper LLM providers, PII anonymisation, made-up skill check
  writing/            cover letter, recruiter note, tailored resume
  notify/             Telegram and email
  dashboard/          local dashboard
  cli/                mark-result command
scripts/
  migrate-config.ts   converts old config files
  internshala/        read-only helpers for inspecting Internshala's markup
config/               *.example.json templates (your real files are git-ignored)
tests/                vitest
```

## Development

```bash
npm run test:run     # 77 tests, no network needed
npm run typecheck
```

If Internshala changes its markup, the helpers in `scripts/internshala/` print the current listing cards, form fields and "Already applied" state without submitting anything.

## Troubleshooting

| Problem | Fix |
|---|---|
| `connect ECONNREFUSED` on the CDP port | Chrome isn't running with `--remote-debugging-port`, or `CDP_ENDPOINT` points to a different port |
| Chrome ignores the debugging flag | Another Chrome window with the same profile is already open. Close it, or use `--user-data-dir` |
| Every job is skipped | Lower `MIN_SCORE`, check your target roles in `profile.json`, and make sure you're logged in |
| "unsupported fields" in the report | The form needs something the bot can't fill (usually a file upload). Apply to that one by hand |
| Tailored resume PDF fails | Set `CHROME_PATH` to your Chrome or Chromium binary |

## License

Released under the [MIT License](LICENSE).

Use it responsibly: follow each site's terms of service, review what the bot writes in dry-run mode first, and only apply to jobs you'd actually take.
