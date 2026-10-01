// ============================================================
// URL STATE MANAGEMENT
// ============================================================

/** Default "Date Posted" window (in days) applied on a fresh page load */
export const DEFAULT_POSTED = '3';

/**
 * Filters and sort applied when the page is opened without any filter params
 * (e.g. the bare site URL). Any filter param in the URL replaces all of these.
 */
const DEFAULT_QUERY = new URLSearchParams({
    title: 'software engineer, backend, associate software, mts, member of technical',
    location: 'india, noida, gurgaon, gurugam, bengaluru, mumbai, pune,delhi,bangalore',
    ats: 'Ashby,Bamboohr,Greenhouse,Lever,Workday,iCIMS,Paylocity',
    skill_level: 'entry,mid',
    exclude: 'senior, staff, devops, platform, sre',
    sort_key: 'posted',
    sort_dir: 'desc',
}).toString();

const STATE_KEYS = ['title', 'company', 'location', 'salary', 'remote', 'status', 'ats',
    'skill_level', 'exclude', 'include', 'posted', 'page', 'sort_key', 'sort_dir'];

/**
 * Sync current filter/sort/page state to the URL query string.
 * @param {object} filterState
 * @param {number} currentPage
 * @param {{ key: string|null, direction: string }} sortState
 */
export function updateURL(filterState, currentPage, sortState) {
    const params = new URLSearchParams();

    if (filterState.title) params.set('title', filterState.title);
    if (filterState.company) params.set('company', filterState.company);
    if (filterState.location) params.set('location', filterState.location);
    if (filterState.salary) params.set('salary', filterState.salary)
    if (filterState.remoteOnly) params.set('remote', '1');
    if (filterState.status) params.set('status', filterState.status);
    if (filterState.ats && filterState.ats.length) params.set('ats', filterState.ats.join(','));
    if (filterState.skill_level && filterState.skill_level.length) params.set('skill_level', filterState.skill_level.join(','));
    if (filterState.exclude) params.set('exclude', filterState.exclude)
    if (filterState.include) params.set('include', filterState.include)
    // Only carry `posted` in the URL when it differs from the default window
    if ((filterState.posted ?? DEFAULT_POSTED) !== DEFAULT_POSTED) {
        params.set('posted', filterState.posted || 'any');
    }
    if (currentPage > 1) params.set('page', currentPage.toString());

    if (sortState.key) {
        params.set('sort_key', sortState.key);
        params.set('sort_dir', sortState.direction);
    }

    const newURL = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;

    window.history.replaceState({}, '', newURL);
}

/**
 * Read filter/sort/page state from the URL and populate DOM inputs.
 * @returns {{ hasFilters: boolean, page: number }}
 */
export function loadFromURL() {
    let params = new URLSearchParams(window.location.search);
    if (!STATE_KEYS.some(k => params.has(k))) params = new URLSearchParams(DEFAULT_QUERY);

    const title = params.get('title') || '';
    const company = params.get('company') || '';
    const location = params.get('location') || '';
    const salary = params.get('salary') || '';
    const remote = params.get('remote') === '1';
    const page = parseInt(params.get('page')) || 1;
    const status = params.get('status') || '';
    const ats = params.get('ats') || '';
    const skillLevel = params.get('skill_level') || '';
    const exclude = params.get('exclude') || '';
    const include = params.get('include') || '';
    const postedParam = params.get('posted');
    const posted = postedParam === null ? DEFAULT_POSTED : (postedParam === 'any' ? '' : postedParam);

    document.getElementById('filter-title').value = title;
    document.getElementById('filter-company').value = company;
    document.getElementById('filter-location').value = location;
    document.getElementById('filter-salary-min').value = salary;
    document.getElementById('filter-remote-only').checked = remote;
    document.getElementById('filter-status').value = status;

    const atsValues = ats ? ats.split(',').map(v => v.trim()).filter(Boolean) : [];
    Array.from(document.getElementById('filter-ats').options).forEach(o => {
        o.selected = atsValues.includes(o.value);
    });

    const skillValues = skillLevel ? skillLevel.split(',').map(v => v.trim()).filter(Boolean) : [];
    Array.from(document.getElementById('filter-skill-level').options).forEach(o => {
        o.selected = skillValues.includes(o.value);
    });

    document.getElementById('filter-exclude').value = exclude;
    document.getElementById('filter-include').value = include;
    document.getElementById('filter-posted').value = posted;

    const hasFilters = !!(title || company || location || salary || remote || status || ats || skillLevel || exclude || include || posted);

    const sortKey = params.get('sort_key') || null;
    const sortDir = params.get('sort_dir') || 'asc';

    return { hasFilters, page, sortKey, sortDir };
}
