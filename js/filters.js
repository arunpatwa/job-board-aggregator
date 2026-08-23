// ============================================================
// FILTERING
// ============================================================

import { escapeRegex } from './ui_utils.js';
import { loadApplicationStatus } from './storage.js';
import { DEFAULT_POSTED } from './url_state.js';

function splitCsv(s) {
    return s.split(',').map(t => t.trim()).filter(Boolean);
}

function getMultiSelectValues(id) {
    return Array.from(document.getElementById(id).selectedOptions)
        .map(o => o.value)
        .filter(Boolean);
}

/**
 * Read current filter values from the DOM.
 * @returns {object} Filter state object
 */
export function readFilterInputs() {
    return {
        hideRecruiters: document.getElementById('filter-hide-recruiters').checked,
        remoteOnly: document.getElementById('filter-remote-only').checked,
        hideApplied: document.getElementById('filter-hide-applied').checked,
        title: document.getElementById('filter-title').value.toLowerCase().trim(),
        company: document.getElementById('filter-company').value.toLowerCase().trim(),
        location: document.getElementById('filter-location').value.toLowerCase().trim(),
        salary: document.getElementById('filter-salary-min').value,
        status: document.getElementById('filter-status').value,
        ats: getMultiSelectValues('filter-ats'),
        skill_level: getMultiSelectValues('filter-skill-level'),
        posted: document.getElementById('filter-posted').value,
        exclude: document.getElementById('filter-exclude').value.toLowerCase().trim(),
        include: document.getElementById('filter-include').value.toLowerCase().trim(),
    };
}

/**
 * Filter the full jobs array based on the current filter inputs.
 * @param {Array} allJobs - The complete jobs array
 * @returns {{ filteredJobs: Array, filterState: object }}
 */
export function filterJobs(allJobs) {
    const f = readFilterInputs();
    const apps = loadApplicationStatus();

    const titleRegexes = splitCsv(f.title).map(t => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'));
    const companyRegexes = splitCsv(f.company).map(t => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'));
    const locationRegexes = splitCsv(f.location).map(t => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i'));

    const atsLower = f.ats.map(v => v.toLowerCase());
    const skillLower = f.skill_level.map(v => v.toLowerCase());

    const filterState = {
        title: f.title,
        company: f.company,
        location: f.location,
        salary: f.salary,
        remoteOnly: f.remoteOnly,
        status: f.status,
        ats: f.ats,
        skill_level: f.skill_level,
        posted: f.posted,
        exclude: f.exclude,
        include: f.include
    };

    const filteredJobs = allJobs.filter(job => {
        // Recruiter filter
        if (f.hideRecruiters && job.is_recruiter === true) return false;

        // Application status
        const url = job.url;
        const jobStatus = apps[url]?.status || '';

        if (f.hideApplied && (jobStatus === 'applied' || jobStatus === 'ignored')) return false;
        if (f.status && jobStatus !== f.status) return false;

        // Text fields
        const title = (job.title || '').toLowerCase();
        const company = ((job.company || job.company_slug) || '').toLowerCase();
        let location = '';
        if (job.location) {
            location = typeof job.location === 'object'
                ? (job.location.name || '').toLowerCase()
                : (job.location || '').toLowerCase();
        }

        // in your filter state collection
        const minSalary = parseInt(document.getElementById('filter-salary-min').value) || 0;

        // in filteredJobs
        if (minSalary > 0) {
            const median = job.salary?.median;
            if (!median || median < minSalary) return false;
        }

        // Remote only
        if (f.remoteOnly) {
            const isRemote = location.includes('remote')
                || (job.workplaceType && job.workplaceType.toLowerCase() === 'remote');
            if (!isRemote) return false;
        }

        // ATS (multi-select: match any)
        if (atsLower.length) {
            const jobAts = (job.ats || '').toLowerCase();
            if (!atsLower.includes(jobAts)) return false;
        }

        // Skill level (multi-select: match any)
        if (skillLower.length) {
            const jobSkillLevel = (job.skill_level || '').toLowerCase();
            if (!skillLower.includes(jobSkillLevel)) return false;
        }

        // Date posted (within N days)
        if (f.posted) {
            const days = parseInt(f.posted, 10);
            const raw = job.updated_at || job.first_seen;
            const t = raw ? Date.parse(raw) : NaN;
            if (isNaN(t)) return false;   // no date = excluded when a date filter is active
            const ageDays = (Date.now() - t) / 86400000;
            if (ageDays > days) return false;
        }

        // Exclude title keywords
        if (f.exclude) {
            const excludeTerms = f.exclude.split(',').map(t => t.trim()).filter(Boolean);
            if (excludeTerms.some(term => title.includes(term))) return false;
        }

        // Include Title keywords
        if (f.include) {
            const includeTerms = f.include.split(',').map(t => t.trim()).filter(Boolean);
            if (!includeTerms.some(term => title.includes(term))) return false;
        }

        // Title / company / location: match ANY of the comma-separated terms
        if (titleRegexes.length && !titleRegexes.some(r => r.test(title))) return false;
        if (companyRegexes.length && !companyRegexes.some(r => r.test(company))) return false;
        if (locationRegexes.length && !locationRegexes.some(r => r.test(location))) return false;

        return true;
    });

    return { filteredJobs, filterState };
}

/** Reset all filter DOM inputs to defaults */
export function clearFilterInputs() {
    document.getElementById('filter-title').value = '';
    document.getElementById('filter-company').value = '';
    document.getElementById('filter-location').value = '';
    document.getElementById('filter-salary-min').value = '';
    document.getElementById('filter-exclude').value = '';
    document.getElementById('filter-include').value = '';
    document.getElementById('filter-status').value = '';
    Array.from(document.getElementById('filter-ats').options).forEach(o => o.selected = false);
    Array.from(document.getElementById('filter-skill-level').options).forEach(o => o.selected = false);
    document.getElementById('filter-posted').value = DEFAULT_POSTED;
    document.getElementById('filter-hide-recruiters').checked = true;
    document.getElementById('filter-remote-only').checked = false;
    document.getElementById('filter-hide-applied').checked = false;
}
