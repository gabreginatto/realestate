/**
 * Tests for MatcherAPI - resolveEndpoint and compound-scoped routes.
 *
 * Run with:
 *   node --test tests/matcher-api.test.mjs
 */

import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser globals mock setup (required before importing matcher-app.js)
// ---------------------------------------------------------------------------

/** Create a minimal DOM element mock */
function createElement(tag = 'div') {
    const listeners = {};
    return {
        tagName: tag.toUpperCase(),
        textContent: '',
        innerHTML: '',
        style: {},
        dataset: {},
        src: '',
        alt: '',
        href: '',
        disabled: false,
        className: '',
        parentElement: null,
        children: [],
        classList: {
            _classes: new Set(),
            add(c) { this._classes.add(c); },
            remove(...cs) { cs.forEach(c => this._classes.delete(c)); },
            contains(c) { return this._classes.has(c); },
            toggle(c) { this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c); }
        },
        setAttribute(k, v) { this[`_attr_${k}`] = v; },
        getAttribute(k) { return this[`_attr_${k}`] ?? null; },
        addEventListener(event, handler) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        },
        removeEventListener() {},
        dispatchEvent() {},
        appendChild(child) { this.children.push(child); return child; },
        querySelector(sel) { return createElement(); },
        querySelectorAll(sel) { return []; },
        remove() {},
        get offsetWidth() { return 100; },
        onload: null,
    };
}

// Storage mock
const storageData = {};
globalThis.localStorage = {
    getItem(key) { return storageData[key] ?? null; },
    setItem(key, val) { storageData[key] = String(val); },
    removeItem(key) { delete storageData[key]; },
    clear() { Object.keys(storageData).forEach(k => delete storageData[k]); },
};

// prompt mock
globalThis.prompt = () => 'test-reviewer';

// document mock
globalThis.document = {
    getElementById(id) { return createElement(); },
    querySelector(sel) { return createElement(); },
    querySelectorAll(sel) { return []; },
    createElement(tag) { return createElement(tag); },
    documentElement: {
        getAttribute(k) { return null; },
        setAttribute(k, v) { this[`_attr_${k}`] = v; },
    },
    addEventListener() {},
};

// window mock
if (typeof globalThis.addEventListener !== 'function') {
    globalThis.addEventListener = () => {};
}
if (typeof globalThis.removeEventListener !== 'function') {
    globalThis.removeEventListener = () => {};
}
globalThis.window = globalThis;
globalThis.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
});
Object.defineProperty(globalThis, 'navigator', {
    value: { vibrate() {} },
    writable: true,
    configurable: true,
});

// ---------------------------------------------------------------------------
// Import the module AFTER mocks are set up
// ---------------------------------------------------------------------------
const { MatcherAPI } = await import('../server-deploy/public/js/matcher-app.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch that returns a preset JSON response.
 */
function mockFetch(responseBody, options = {}) {
    const { ok = true, status = 200 } = options;
    return mock.fn(() =>
        Promise.resolve({
            ok,
            status,
            json: () => Promise.resolve(responseBody),
            text: () => Promise.resolve(JSON.stringify(responseBody)),
        })
    );
}

// ===================================================================
// resolveEndpoint tests (original 4 tests preserved)
// ===================================================================

test('resolveEndpoint returns relative API paths by default', () => {
    const api = new MatcherAPI();
    assert.equal(api.resolveEndpoint('/api/session'), '/api/session');
    assert.equal(api.resolveEndpoint('api/next'), '/api/next');
});

test('resolveEndpoint avoids double-prefixing relative base paths', () => {
    const api = new MatcherAPI('/api');
    assert.equal(api.resolveEndpoint('/api/session'), '/api/session');
    assert.equal(api.resolveEndpoint('session'), '/api/session');
});

test('resolveEndpoint respects absolute base URLs', () => {
    const api = new MatcherAPI('http://localhost:4000');
    assert.equal(api.resolveEndpoint('/api/session'), 'http://localhost:4000/api/session');
    assert.equal(api.resolveEndpoint('api/next'), 'http://localhost:4000/api/next');
});

test('resolveEndpoint returns absolute endpoints unchanged', () => {
    const api = new MatcherAPI('http://localhost:4000');
    assert.equal(api.resolveEndpoint('https://example.com/api/session'), 'https://example.com/api/session');
});

// ===================================================================
// setCompound() and compoundPrefix()
// ===================================================================

describe('setCompound() and compoundPrefix()', () => {
    test('setCompound() stores the compoundId', () => {
        const api = new MatcherAPI();
        api.setCompound('alphaville-1');
        assert.equal(api.compoundId, 'alphaville-1');
    });

    test('setCompound() overwrites a previously set compoundId', () => {
        const api = new MatcherAPI();
        api.setCompound('alphaville-1');
        api.setCompound('tambore-xi');
        assert.equal(api.compoundId, 'tambore-xi');
    });

    test('compoundPrefix() returns correct path', () => {
        const api = new MatcherAPI();
        api.setCompound('alphaville-1');
        assert.equal(api.compoundPrefix(), '/api/compounds/alphaville-1');
    });

    test('compoundPrefix() throws "No compound selected" when no compound set', () => {
        const api = new MatcherAPI();
        assert.throws(
            () => api.compoundPrefix(),
            { message: 'No compound selected' }
        );
    });

    test('compoundPrefix() throws after compoundId is set to null', () => {
        const api = new MatcherAPI();
        api.setCompound('alphaville-1');
        api.compoundId = null;
        assert.throws(
            () => api.compoundPrefix(),
            { message: 'No compound selected' }
        );
    });

    test('compoundPrefix() encodes special characters in compound ID', () => {
        const api = new MatcherAPI();
        api.setCompound('my compound/special&chars');
        assert.equal(
            api.compoundPrefix(),
            '/api/compounds/my%20compound%2Fspecial%26chars'
        );
    });

    test('compoundPrefix() encodes spaces in compound ID', () => {
        const api = new MatcherAPI();
        api.setCompound('alpha ville 1');
        assert.equal(
            api.compoundPrefix(),
            '/api/compounds/alpha%20ville%201'
        );
    });
});

// ===================================================================
// getCompounds() - does NOT need compound prefix
// ===================================================================

describe('getCompounds()', () => {
    let api;
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        api = new MatcherAPI();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('calls /api/compounds without requiring a compound to be set', async () => {
        const data = { compounds: [{ id: 'alphaville-1' }, { id: 'tambore-xi' }] };
        globalThis.fetch = mockFetch(data);

        // No setCompound() called - should still work
        const result = await api.getCompounds();

        assert.deepEqual(result, data);
        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds');
    });

    test('returns compound data even when a compound is already set', async () => {
        const data = { compounds: [{ id: 'alphaville-1' }] };
        globalThis.fetch = mockFetch(data);

        api.setCompound('tambore-xi');
        const result = await api.getCompounds();

        assert.deepEqual(result, data);
        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds');
    });
});

// ===================================================================
// Compound-scoped endpoint URL tests
// ===================================================================

describe('compound-scoped endpoints generate correct URLs', () => {
    let api;
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch({ ok: true });
        api = new MatcherAPI();
        api.setCompound('alphaville-1');
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('getSession() calls /api/compounds/{id}/session', async () => {
        await api.getSession();

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/session');
    });

    test('getNext() without reviewer calls /api/compounds/{id}/next', async () => {
        await api.getNext();

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/next');
    });

    test('getNext() with reviewer appends query parameter', async () => {
        await api.getNext('alice');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/next?reviewer=alice');
    });

    test('getNext() encodes reviewer name with special characters', async () => {
        await api.getNext('Bob Smith & Co');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/next?reviewer=Bob%20Smith%20%26%20Co');
    });

    test('getListing() calls /api/compounds/{id}/listing/{listingId}', async () => {
        await api.getListing('V123');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/listing/V123');
    });

    test('getListing() encodes listing ID with special characters', async () => {
        await api.getListing('V/123&abc');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/listing/V%2F123%26abc');
    });

    test('getCandidates() calls /api/compounds/{id}/candidates/{vivaId}', async () => {
        await api.getCandidates('V456');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/candidates/V456');
    });

    test('getCandidates() encodes vivaId with special characters', async () => {
        await api.getCandidates('V 456/special');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/candidates/V%20456%2Fspecial');
    });

    test('submitMatch() POSTs to /api/compounds/{id}/match', async () => {
        await api.submitMatch('V123', 'C456', 30, 'reviewer1', 'good match');

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/match');
        assert.equal(options.method, 'POST');

        const body = JSON.parse(options.body);
        assert.equal(body.viva_code, 'V123');
        assert.equal(body.coelho_code, 'C456');
        assert.equal(body.time_spent_sec, 30);
        assert.equal(body.reviewer, 'reviewer1');
        assert.equal(body.notes, 'good match');
    });

    test('rejectCandidate() POSTs to /api/compounds/{id}/reject', async () => {
        await api.rejectCandidate('V123', 'C456', 'reviewer1', 'wrong property');

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/reject');
        assert.equal(options.method, 'POST');

        const body = JSON.parse(options.body);
        assert.equal(body.viva_code, 'V123');
        assert.equal(body.coelho_code, 'C456');
        assert.equal(body.reviewer, 'reviewer1');
        assert.equal(body.reason, 'wrong property');
    });

    test('skipListing() POSTs to /api/compounds/{id}/skip', async () => {
        await api.skipListing('V123', 45, 'reviewer1');

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/skip');
        assert.equal(options.method, 'POST');

        const body = JSON.parse(options.body);
        assert.equal(body.viva_code, 'V123');
        assert.equal(body.reason, 'no_good_candidates');
        assert.equal(body.time_spent_sec, 45);
        assert.equal(body.reviewer, 'reviewer1');
    });

    test('undo() POSTs to /api/compounds/{id}/undo', async () => {
        await api.undo('reviewer1');

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/undo');
        assert.equal(options.method, 'POST');

        const body = JSON.parse(options.body);
        assert.equal(body.reviewer, 'reviewer1');
    });

    test('getProgress() calls /api/compounds/{id}/progress', async () => {
        await api.getProgress();

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/progress');
    });

    test('advancePass() POSTs to /api/compounds/{id}/pass/advance', async () => {
        await api.advancePass();

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/pass/advance');
        assert.equal(options.method, 'POST');
    });

    test('finishMatching() POSTs to /api/compounds/{id}/pass/finish', async () => {
        await api.finishMatching('reviewer1');

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/pass/finish');
        assert.equal(options.method, 'POST');

        const body = JSON.parse(options.body);
        assert.equal(body.reviewer, 'reviewer1');
    });

    test('sendReportEmail() POSTs to /api/compounds/{id}/report/send-email', async () => {
        await api.sendReportEmail('test@example.com');

        const [url, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, '/api/compounds/alphaville-1/report/send-email');
        assert.equal(options.method, 'POST');

        const body = JSON.parse(options.body);
        assert.equal(body.to, 'test@example.com');
    });
});

// ===================================================================
// Compound-scoped endpoints with baseURL
// ===================================================================

describe('compound-scoped endpoints with absolute baseURL', () => {
    let api;
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch({ ok: true });
        api = new MatcherAPI('http://localhost:8080');
        api.setCompound('tambore-xi');
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('getSession() prepends baseURL to compound path', async () => {
        await api.getSession();

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, 'http://localhost:8080/api/compounds/tambore-xi/session');
    });

    test('getNext() prepends baseURL to compound path', async () => {
        await api.getNext('bob');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, 'http://localhost:8080/api/compounds/tambore-xi/next?reviewer=bob');
    });

    test('getListing() prepends baseURL to compound path', async () => {
        await api.getListing('L100');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, 'http://localhost:8080/api/compounds/tambore-xi/listing/L100');
    });

    test('getCandidates() prepends baseURL to compound path', async () => {
        await api.getCandidates('V200');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, 'http://localhost:8080/api/compounds/tambore-xi/candidates/V200');
    });

    test('submitMatch() prepends baseURL to compound path', async () => {
        await api.submitMatch('V1', 'C1', 10, 'rev');

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, 'http://localhost:8080/api/compounds/tambore-xi/match');
    });

    test('getCompounds() prepends baseURL without compound prefix', async () => {
        await api.getCompounds();

        const [url] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url, 'http://localhost:8080/api/compounds');
    });
});

// ===================================================================
// Compound-scoped endpoints throw without compound
// ===================================================================

describe('compound-scoped endpoints throw when no compound is set', () => {
    let api;

    beforeEach(() => {
        api = new MatcherAPI();
    });

    test('getSession() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.getSession(),
            { message: 'No compound selected' }
        );
    });

    test('getNext() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.getNext(),
            { message: 'No compound selected' }
        );
    });

    test('getListing() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.getListing('V1'),
            { message: 'No compound selected' }
        );
    });

    test('getCandidates() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.getCandidates('V1'),
            { message: 'No compound selected' }
        );
    });

    test('submitMatch() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.submitMatch('V1', 'C1', 10, 'r'),
            { message: 'No compound selected' }
        );
    });

    test('skipListing() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.skipListing('V1', 10, 'r'),
            { message: 'No compound selected' }
        );
    });

    test('undo() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.undo('r'),
            { message: 'No compound selected' }
        );
    });

    test('getProgress() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.getProgress(),
            { message: 'No compound selected' }
        );
    });

    test('advancePass() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.advancePass(),
            { message: 'No compound selected' }
        );
    });

    test('finishMatching() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.finishMatching('r'),
            { message: 'No compound selected' }
        );
    });

    test('sendReportEmail() throws "No compound selected"', async () => {
        await assert.rejects(
            () => api.sendReportEmail('a@b.com'),
            { message: 'No compound selected' }
        );
    });
});

// ===================================================================
// Switching compounds mid-session
// ===================================================================

describe('switching compounds updates URL paths', () => {
    let api;
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch({ ok: true });
        api = new MatcherAPI();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('URLs reflect the currently selected compound', async () => {
        api.setCompound('alphaville-1');
        await api.getSession();
        const [url1] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(url1, '/api/compounds/alphaville-1/session');

        api.setCompound('tambore-xi');
        await api.getSession();
        const [url2] = globalThis.fetch.mock.calls[1].arguments;
        assert.equal(url2, '/api/compounds/tambore-xi/session');
    });
});
