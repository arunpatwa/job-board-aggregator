// ============================================================
// RESUME HELPER — "Resume" button backed by a local server
// ============================================================
//
// The site is static, so tailoring runs on the owner's machine via
// resume-helper/server.py. The button only appears for visitors who opted in
// with ?resume-helper=on (remembered in localStorage) and whose helper is up,
// so other visitors never probe localhost.

import { escape, showToast } from './ui_utils.js';

const HELPER_URL = 'http://127.0.0.1:8765';
const STORAGE_KEY = 'resume-helper';
const POLL_MS = 5000;

/** job url -> latest status object from the helper */
const jobStates = new Map();
const polling = new Set();

function readOptIn() {
    try {
        const flag = new URLSearchParams(window.location.search).get('resume-helper');
        if (flag === 'on') localStorage.setItem(STORAGE_KEY, 'on');
        if (flag === 'off') localStorage.removeItem(STORAGE_KEY);
        return localStorage.getItem(STORAGE_KEY) === 'on';
    } catch {
        return false;
    }
}

// Read before url_state.js rewrites the query string.
const optedIn = readOptIn();

/** Probe the helper once; shows the Resume buttons if it answers. */
export async function initResumeHelper() {
    if (!optedIn) return;
    try {
        const res = await fetch(`${HELPER_URL}/health`, { cache: 'no-store' });
        if (res.ok) {
            document.body.classList.add('resume-helper-online');
            return;
        }
    } catch { /* helper not running */ }
    showToast('Resume helper is not running. Start resume-helper/server.py and reload.', 'warning');
}

function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
}

function buttonState(status) {
    if (!status) return { label: 'Resume', cls: 'btn-outline-dark', busy: false, title: 'Tailor resume + cover letter' };
    switch (status.state) {
        case 'queued':
            return { label: `Queued #${status.queue_position || 1}`, cls: 'btn-outline-secondary', busy: true, title: 'Waiting for another resume to finish' };
        case 'running':
            return { label: formatElapsed(status.elapsed), cls: 'btn-outline-warning', busy: true, title: status.stage || 'Generating' };
        case 'done':
            return { label: 'Download', cls: 'btn-success', busy: false, title: status.score ? `Reviewed score ${status.score}` : 'Download PDFs' };
        case 'stopped':
            return { label: 'Skipped', cls: 'btn-outline-danger', busy: false, title: status.message || 'Not built' };
        default:
            return { label: 'Retry', cls: 'btn-danger', busy: false, title: status.message || 'Failed' };
    }
}

/** Button markup for a job row (hidden by CSS unless the helper is online). */
export function renderResumeButton(job) {
    const url = job.absolute_url || job.url;
    if (!url) return '';
    const st = buttonState(jobStates.get(url));
    const company = job.company || job.company_slug || '';
    const location = job.location && typeof job.location === 'object' ? job.location.name : job.location;
    return `<button type="button" class="btn btn-sm ${st.cls} resume-btn ms-1"
                ${st.busy ? 'disabled' : ''}
                title="${escape(st.title)}"
                data-job-url="${escape(url)}"
                data-company="${escape(company)}"
                data-title="${escape(job.title || '')}"
                data-location="${escape(location || '')}"
                data-ats="${escape(job.ats || '')}">${escape(st.label)}</button>`;
}

function refreshButtons(url) {
    const st = buttonState(jobStates.get(url));
    document.querySelectorAll(`.resume-btn[data-job-url="${CSS.escape(url)}"]`).forEach(btn => {
        btn.className = `btn btn-sm ${st.cls} resume-btn ms-1`;
        btn.disabled = st.busy;
        btn.title = st.title;
        btn.textContent = st.label;
    });
}

async function downloadFiles(status) {
    for (const f of status.files) {
        const res = await fetch(`${HELPER_URL}/file/${status.id}/${f.kind}`);
        if (!res.ok) throw new Error(`Could not download ${f.name}`);
        const blobUrl = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }
}

async function poll(url, id) {
    if (polling.has(id)) return;
    polling.add(id);
    try {
        while (true) {
            await new Promise(r => setTimeout(r, POLL_MS));
            const res = await fetch(`${HELPER_URL}/status/${id}`, { cache: 'no-store' });
            if (!res.ok) throw new Error('Helper lost track of this job (was it restarted?)');
            const status = await res.json();
            jobStates.set(url, status);
            refreshButtons(url);
            if (status.state === 'done') {
                const score = status.score ? ` (reviewed ${status.score})` : '';
                showToast(`Resume ready for ${status.company}${score}`, 'success');
                await downloadFiles(status);
                return;
            }
            if (status.state === 'stopped') {
                showToast(`${status.company}: ${status.message}`, 'warning');
                return;
            }
            if (status.state === 'error') {
                showToast(`${status.company}: resume failed. ${status.message}`, 'danger');
                return;
            }
        }
    } catch (err) {
        jobStates.set(url, { state: 'error', message: err.message });
        refreshButtons(url);
        showToast(err.message, 'danger');
    } finally {
        polling.delete(id);
    }
}

/** Click handler for .resume-btn (wired via event delegation). */
export async function handleResumeClick(btn) {
    const url = btn.dataset.jobUrl;
    const current = jobStates.get(url);

    if (current?.state === 'done') {
        try { await downloadFiles(current); } catch (err) { showToast(err.message, 'danger'); }
        return;
    }
    let override = false;
    if (current?.state === 'stopped') {
        if (!current.can_override) {
            showToast(`${current.company}: ${current.message}`, 'warning');
            return;
        }
        override = window.confirm(`${current.company}: ${current.message}\n\nBuild the resume anyway?`);
        if (!override) return;
    }

    btn.disabled = true;
    try {
        const res = await fetch(`${HELPER_URL}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                company: btn.dataset.company,
                title: btn.dataset.title,
                location: btn.dataset.location,
                ats: btn.dataset.ats,
                override,
            }),
        });
        if (!res.ok) throw new Error((await res.json()).error || `Helper returned ${res.status}`);
        const status = await res.json();
        jobStates.set(url, status);
        refreshButtons(url);

        if (status.state === 'done') {
            await downloadFiles(status);
        } else if (status.state === 'stopped') {
            showToast(`${status.company}: ${status.message}`, 'warning');
        } else {
            showToast(`Tailoring resume for ${status.company}. This takes a few minutes.`, 'info');
            poll(url, status.id);
        }
    } catch (err) {
        btn.disabled = false;
        showToast(`Resume helper error: ${err.message}`, 'danger');
    }
}
