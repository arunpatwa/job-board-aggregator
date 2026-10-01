#!/usr/bin/env python3
"""
Local resume helper for the job board.

The job board is a static site, so it cannot run Claude or LaTeX. This small
server runs on your own machine; the "Resume" button on the site calls it.
For each job it:
  1. fetches the full job description from the ATS's public API,
  2. runs `claude -p` with the resume-tailor skill (same as a manual session),
  3. serves the built resume and cover letter PDFs back to the browser.

Only the Python standard library is used. Run:  python3 resume-helper/server.py
"""

import html
import json
import os
import queue
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

# ============================================================
# CONFIG (override with environment variables)
# ============================================================

HOST = os.environ.get("RESUME_HELPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("RESUME_HELPER_PORT", "8765"))
RESUME_DIR = Path(
    os.environ.get("RESUME_DIR", "/home/sherlock/Downloads/new_resume_claude/Claude")
).resolve()
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
JOB_TIMEOUT = int(os.environ.get("RESUME_JOB_TIMEOUT", str(40 * 60)))
LOG_DIR = Path(os.environ.get("RESUME_HELPER_LOGS", Path.home() / ".cache" / "resume-helper"))

ALLOWED_ORIGINS = {
    "https://arunpatwa.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# ============================================================
# JOB DESCRIPTION FETCHING
# ============================================================


def _get(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def _get_json(url):
    return json.loads(_get(url))


def html_to_text(raw):
    """Crude HTML -> plain text that keeps list items and paragraph breaks."""
    raw = html.unescape(raw or "")
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<li[^>]*>", "\n- ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</(p|div|h[1-6]|ul|ol|tr)>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
    raw = re.sub(r"\n\s*\n\s*(\n\s*)+", "\n\n", raw)
    return "\n".join(line.strip() for line in raw.splitlines()).strip()


def fetch_greenhouse(url, company):
    # https://job-boards.greenhouse.io/{slug}/jobs/{id}  (also boards.greenhouse.io), or a
    # company-domain page with ?gh_jid={id}, where the scraped "company" is the board slug.
    m = re.search(r"greenhouse\.io/([^/]+)/jobs/(\d+)", url)
    jid = re.search(r"[?&]gh_jid=(\d+)", url)
    if m:
        slug, job_id = m[1], m[2]
    elif jid and company:
        slug, job_id = company, jid[1]
    else:
        return None
    data = _get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{job_id}")
    return html_to_text(data.get("content", ""))


def fetch_lever(url, company):
    # https://jobs.lever.co/{slug}/{id}
    m = re.search(r"jobs\.lever\.co/([^/]+)/([0-9a-f-]{36})", url)
    if not m:
        return None
    d = _get_json(f"https://api.lever.co/v0/postings/{m[1]}/{m[2]}")
    parts = [d.get("descriptionPlain") or html_to_text(d.get("description", ""))]
    for lst in d.get("lists", []):
        parts.append(f"\n{lst.get('text', '')}\n{html_to_text(lst.get('content', ''))}")
    parts.append(d.get("additionalPlain") or "")
    return "\n".join(p for p in parts if p)


def fetch_ashby(url, company):
    # https://jobs.ashbyhq.com/{slug}/{id}
    m = re.search(r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f-]{36})", url)
    if not m:
        return None
    board = _get_json(f"https://api.ashbyhq.com/posting-api/job-board/{m[1]}")
    for job in board.get("jobs", []):
        if job.get("id") == m[2]:
            return job.get("descriptionPlain") or html_to_text(job.get("descriptionHtml", ""))
    return None


def fetch_workday(url, company):
    # https://{co}.wd{n}.myworkdayjobs.com/{site}/job/{rest}
    p = urlparse(url)
    m = re.match(r"/(?:[a-z]{2}-[A-Z]{2}/)?([^/]+)/(job/.+)", p.path)
    if not m:
        return None
    company = p.hostname.split(".")[0]
    api = f"{p.scheme}://{p.hostname}/wday/cxs/{company}/{m[1]}/{m[2]}"
    info = _get_json(api).get("jobPostingInfo", {})
    return html_to_text(info.get("jobDescription", ""))


def fetch_bamboohr(url, company):
    # https://{slug}.bamboohr.com/careers/{id}
    m = re.search(r"https://([^.]+)\.bamboohr\.com/careers/(\d+)", url)
    if not m:
        return None
    d = _get_json(f"https://{m[1]}.bamboohr.com/careers/{m[2]}/detail")
    opening = (d.get("result") or {}).get("jobOpening") or {}
    return html_to_text(opening.get("description", ""))


def fetch_page(url):
    """Fallback for iCIMS, Paylocity and anything else: strip the page's HTML."""
    if "icims.com" in url and "in_iframe" not in url:
        url += ("&" if "?" in url else "?") + "in_iframe=1"
    return html_to_text(_get(url, accept="text/html"))


FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "workday": fetch_workday,
    "bamboohr": fetch_bamboohr,
}


class JobUnavailable(Exception):
    """The posting is closed or its description could not be read."""


CLOSED_CODES = (404, 410)


def fetch_job_description(url, ats, company=None):
    fetcher = FETCHERS.get((ats or "").lower())
    text = None
    if fetcher:
        try:
            text = fetcher(url, company)
        except urllib.error.HTTPError as e:
            if e.code in CLOSED_CODES:
                raise JobUnavailable("This posting has closed (the ATS no longer lists it).")
            print(f"  {ats} API fetch failed ({e}); falling back to page HTML")
        except (urllib.error.URLError, ValueError, KeyError, TimeoutError) as e:
            print(f"  {ats} API fetch failed ({e}); falling back to page HTML")
    if not text or len(text) < 300:
        try:
            text = fetch_page(url)
        except urllib.error.HTTPError as e:
            if e.code in CLOSED_CODES:
                raise JobUnavailable("This posting has closed (the page returns not found).")
            raise
    if len(text) < 300:
        raise JobUnavailable("Could not read a job description from this posting's page.")
    return text[:30000]


# ============================================================
# CLAUDE RUN
# ============================================================

PROMPT = """Use the resume-tailor skill for the job below.

This request comes from the "Resume" button on my job board and runs NON-INTERACTIVELY:
nobody can answer questions during this run.
- Follow the resume-tailor skill fully: experience gate, tailoring, build, checks, independent
  review, cover letter, match report, tracker row.
- Never ask a question. If the experience gate stops the build, or the skill says to ask before
  building (for example seniority implied by the title), do not build: stop and report why.
- A keyword that facts.md does not support is a gap, not a question.
{override}
Company: {company}  (this is the ATS board id; name folders and files after the employer's real
name as written in the job description, e.g. "c3iot" -> C3AI)
Role: {title}
Location: {location}
Job URL: {url}

Job description:
<<<
{jd}
>>>

End your reply with exactly one final line, with absolute paths:
RESULT_JSON: {{"status": "built" or "stopped", "reason": "<one sentence>", "resume_pdf": "<path or null>", "cover_letter_pdf": "<path or null>", "reviewed_score": <number or null>}}
"""


def newest_pdf(pattern, since):
    hits = [p for p in RESUME_DIR.rglob(pattern) if p.stat().st_mtime >= since]
    return max(hits, key=lambda p: p.stat().st_mtime) if hits else None


def safe_pdf(path):
    """Accept a PDF path only if it exists inside RESUME_DIR."""
    if not path:
        return None
    p = Path(path).resolve()
    if p.suffix.lower() == ".pdf" and p.is_file() and RESUME_DIR in p.parents:
        return p
    return None


class Job:
    def __init__(self, payload):
        self.id = uuid.uuid4().hex[:12]
        self.url = payload["url"]
        self.company = payload.get("company") or "Unknown"
        self.title = payload.get("title") or ""
        self.location = payload.get("location") or ""
        self.ats = payload.get("ats") or ""
        self.override = bool(payload.get("override"))
        self.can_override = False  # True when the skill's experience gate stopped it
        self.state = "queued"  # queued | running | done | stopped | error
        self.stage = "Waiting in queue"
        self.message = ""
        self.score = None
        self.files = {}  # kind -> Path
        self.created = time.time()
        self.started = None
        self.finished = None

    def to_dict(self):
        end = self.finished or time.time()
        return {
            "id": self.id,
            "url": self.url,
            "company": self.company,
            "title": self.title,
            "state": self.state,
            "stage": self.stage,
            "message": self.message,
            "score": self.score,
            "can_override": self.can_override,
            "elapsed": int(end - self.started) if self.started else 0,
            "queue_position": queue_position(self),
            "files": [{"kind": k, "name": p.name} for k, p in self.files.items()],
        }


JOBS = {}  # id -> Job
JOBS_BY_URL = {}  # job url -> Job
WORK = queue.Queue()
LOCK = threading.Lock()


def queue_position(job):
    if job.state != "queued":
        return 0
    with LOCK:
        waiting = sorted((j for j in JOBS.values() if j.state == "queued"), key=lambda j: j.created)
    return waiting.index(job) + 1 if job in waiting else 0


def run_job(job):
    job.state, job.started = "running", time.time()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{job.id}.log"

    job.stage = "Fetching job description"
    jd = fetch_job_description(job.url, job.ats, job.company)
    (LOG_DIR / f"{job.id}.jd.txt").write_text(jd, encoding="utf-8")

    job.stage = "Tailoring resume and cover letter with Claude"
    override = (
        "- Arun reviewed the experience-gate reason for this job and explicitly asked to build it\n"
        "  anyway. Skip the gate, build everything, and list the seniority gap in the match report.\n"
        if job.override else ""
    )
    prompt = PROMPT.format(
        company=job.company, title=job.title, location=job.location, url=job.url, jd=jd,
        override=override,
    )
    cmd = [CLAUDE_BIN, "-p", "--permission-mode", "auto", "--output-format", "json"]
    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.run(
            cmd, input=prompt, cwd=RESUME_DIR, text=True,
            stdout=subprocess.PIPE, stderr=log, timeout=JOB_TIMEOUT,
        )
        log.write("\n--- stdout ---\n" + proc.stdout)

    try:
        result_text = json.loads(proc.stdout).get("result", "")
    except json.JSONDecodeError:
        result_text = proc.stdout

    m = re.search(r"RESULT_JSON:\s*(\{.*\})", result_text)
    result = {}
    if m:
        try:
            result = json.loads(m[1])
        except json.JSONDecodeError:
            pass

    resume = safe_pdf(result.get("resume_pdf")) or newest_pdf("ArunPatwa_Resume_*.pdf", job.started)
    cover = safe_pdf(result.get("cover_letter_pdf")) or newest_pdf("ArunPatwa_CoverLetter_*.pdf", job.started)
    job.score = result.get("reviewed_score")
    job.message = result.get("reason") or ""

    if resume:
        job.files["resume"] = resume
        if cover:
            job.files["cover_letter"] = cover
        job.state = "done"
    elif result.get("status") == "stopped":
        job.state = "stopped"
        job.can_override = True
    else:
        job.state = "error"
        job.message = job.message or (result_text.strip()[-400:] or f"claude exited with code {proc.returncode}")
    job.stage = ""


def worker():
    # One job at a time: runs share facts.md and the tracker CSV.
    while True:
        job = WORK.get()
        try:
            run_job(job)
        except JobUnavailable as e:
            job.state, job.message = "stopped", str(e)
        except subprocess.TimeoutExpired:
            job.state, job.message = "error", f"Timed out after {JOB_TIMEOUT // 60} minutes"
        except Exception as e:  # report any failure to the browser instead of hanging
            job.state, job.message = "error", f"{type(e).__name__}: {e}"
        finally:
            job.stage = ""
            job.finished = time.time()
            print(f"[{job.id}] {job.company}: {job.state} {job.message}")


# ============================================================
# HTTP
# ============================================================


class Handler(BaseHTTPRequestHandler):
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._json(403, {"error": "origin not allowed"})
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome's Private/Local Network Access preflight for public site -> localhost
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._json(403, {"error": "origin not allowed"})
        parts = urlparse(self.path).path.strip("/").split("/")

        if parts == ["health"]:
            return self._json(200, {"ok": True})

        if len(parts) == 2 and parts[0] == "status":
            job = JOBS.get(parts[1])
            return self._json(200, job.to_dict()) if job else self._json(404, {"error": "unknown job"})

        if len(parts) == 3 and parts[0] == "file":
            job = JOBS.get(parts[1])
            path = job.files.get(parts[2]) if job else None
            if not path or not path.is_file():
                return self._json(404, {"error": "no such file"})
            data = path.read_bytes()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._json(404, {"error": "not found"})

    def do_POST(self):
        # JSON content type forces a CORS preflight, so other sites cannot trigger runs.
        if not self._origin_ok() or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(403, {"error": "forbidden"})
        if urlparse(self.path).path != "/generate":
            return self._json(404, {"error": "not found"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "invalid JSON"})

        url = payload.get("url") or ""
        if not url.startswith("https://"):
            return self._json(400, {"error": "a job url is required"})

        with LOCK:
            existing = JOBS_BY_URL.get(url)
            # Reuse a queued/running/finished job; rerun after a failure or a gate override.
            rerun = existing and (
                existing.state == "error"
                or (existing.can_override and payload.get("override"))
            )
            if existing and not rerun:
                return self._json(200, existing.to_dict())
            job = Job(payload)
            JOBS[job.id] = job
            JOBS_BY_URL[url] = job
        WORK.put(job)
        print(f"[{job.id}] queued: {job.company} - {job.title}")
        return self._json(202, job.to_dict())

    def log_message(self, fmt, *args):
        pass  # keep the console for job events only


def main():
    if not RESUME_DIR.is_dir():
        raise SystemExit(f"RESUME_DIR not found: {RESUME_DIR}")
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Resume helper listening on http://{HOST}:{PORT}  (resume dir: {RESUME_DIR})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
