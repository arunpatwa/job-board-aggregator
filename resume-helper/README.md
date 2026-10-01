# Resume helper

Adds a **Resume** button to each job on the board. Clicking it tailors your resume and
cover letter to that job with Claude Code (the `resume-tailor` skill) and downloads both PDFs.

The board is a static GitHub Pages site, so the work runs on your own machine: the button
talks to this small server at `http://127.0.0.1:8765`. When the server isn't running, the
button doesn't appear.

## How it works

1. The button sends the job's URL, company, title and ATS to `POST /generate`.
2. The server fetches the full job description from the ATS's public API (Greenhouse, Lever,
   Ashby, Workday, BambooHR), or from the posting page (iCIMS, Paylocity, fallback).
3. It runs `claude -p --permission-mode auto` in the resume folder with the job description,
   asking for the resume-tailor skill non-interactively.
4. The page polls `GET /status/<id>`; when the PDFs exist it downloads them from
   `GET /file/<id>/resume` and `GET /file/<id>/cover_letter`.

Jobs run one at a time. A job that has closed, or that the skill's experience gate rejects,
shows **Skipped** with the reason (hover the button). Clicking **Resume** on a job that is
already built downloads the PDFs again without rebuilding.

## Setup

1. Start the server:
   ```bash
   python3 resume-helper/server.py
   ```
2. Enable the button in your browser once by opening
   <https://arunpatwa.github.io/job-board-aggregator/?resume-helper=on>
   (`?resume-helper=off` hides it again). Other visitors never see it.
3. Chrome may ask to allow the site to access devices on your local network. Allow it,
   since that is how the page reaches the helper.

### Start automatically at login (systemd)

```bash
mkdir -p ~/.config/systemd/user
cp resume-helper/resume-helper.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now resume-helper
journalctl --user -u resume-helper -f   # follow its log
```

## Configuration

Environment variables (defaults in brackets):

| Variable | Purpose |
|---|---|
| `RESUME_DIR` | Resume project folder [`~/Downloads/new_resume_claude/Claude`] |
| `RESUME_HELPER_PORT` | Port [`8765`] |
| `RESUME_JOB_TIMEOUT` | Seconds before a run is abandoned [`2400`] |
| `RESUME_HELPER_LOGS` | Claude output and fetched JD per job [`~/.cache/resume-helper`] |
| `CLAUDE_BIN` | Claude Code executable [`claude`] |

## Security

The server binds to `127.0.0.1` only. It accepts requests only from the job board's origin
(and `localhost:8000` for local development), requires a JSON body so other sites cannot
trigger a run with a plain form post, and serves only PDFs inside `RESUME_DIR` that a run
produced.
