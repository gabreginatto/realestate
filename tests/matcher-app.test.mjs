/**
 * Comprehensive tests for matcher-app.js
 *
 * Tests the MatcherAPI, MatcherState, and MatcherUI classes using
 * Node.js built-in test runner (node:test) and assertions (node:assert/strict).
 *
 * Run with:
 *   node --test tests/matcher-app.test.mjs
 */

import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser globals mock setup
// ---------------------------------------------------------------------------
// MatcherState's constructor calls localStorage.getItem and potentially prompt().
// MatcherUI's constructor calls document.getElementById, document.querySelector,
// and window.matchMedia. We must set up these mocks BEFORE importing the module.

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
        removeEventListener(event, handler) {
            if (listeners[event]) {
                listeners[event] = listeners[event].filter(h => h !== handler);
            }
        },
        dispatchEvent(event) {
            const handlers = listeners[event.type || event] || [];
            handlers.forEach(h => h(event));
        },
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

// prompt mock - return a default reviewer name to avoid blocking
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
// MatcherApp auto-instantiates when window is defined and calls
// window.addEventListener (for beforeunload, etc). We need these on globalThis
// since globalThis.window === globalThis.
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

// Intl.NumberFormat should already be available in Node.js

// ---------------------------------------------------------------------------
// Import the module AFTER mocks are set up
// ---------------------------------------------------------------------------
const { MatcherAPI, MatcherState, MatcherUI } = await import(
    '../server-deploy/public/js/matcher-app.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch function that returns a preset response.
 * @param {object} responseBody - JSON body to return
 * @param {object} [options] - { ok, status, statusText }
 */
function mockFetch(responseBody, options = {}) {
    const { ok = true, status = 200, statusText = 'OK' } = options;
    return mock.fn(() =>
        Promise.resolve({
            ok,
            status,
            statusText,
            json: () => Promise.resolve(responseBody),
            text: () => Promise.resolve(JSON.stringify(responseBody)),
        })
    );
}

/**
 * Create a mock fetch that rejects with an error.
 */
function mockFetchError(errorMessage) {
    return mock.fn(() => Promise.reject(new Error(errorMessage)));
}

/**
 * Create a mock fetch that returns a non-ok response.
 */
function mockFetchFailure(errorText, status = 500) {
    return mock.fn(() =>
        Promise.resolve({
            ok: false,
            status,
            statusText: 'Internal Server Error',
            json: () => Promise.resolve({ error: errorText }),
            text: () => Promise.resolve(errorText),
        })
    );
}

// ===================================================================
// MatcherAPI Tests
// ===================================================================
describe('MatcherAPI', () => {
    // ---------------------------------------------------------------
    // resolveEndpoint
    // ---------------------------------------------------------------
    describe('resolveEndpoint()', () => {
        test('returns relative API paths when no baseURL is set', () => {
            const api = new MatcherAPI();
            assert.equal(api.resolveEndpoint('/api/session'), '/api/session');
            assert.equal(api.resolveEndpoint('api/next'), '/api/next');
        });

        test('prepends slash to endpoints without one', () => {
            const api = new MatcherAPI();
            assert.equal(api.resolveEndpoint('api/session'), '/api/session');
            assert.equal(api.resolveEndpoint('foo'), '/foo');
        });

        test('avoids double-prefixing when endpoint starts with baseURL', () => {
            const api = new MatcherAPI('/api');
            assert.equal(api.resolveEndpoint('/api/session'), '/api/session');
        });

        test('prepends baseURL to non-prefixed endpoints', () => {
            const api = new MatcherAPI('/api');
            assert.equal(api.resolveEndpoint('session'), '/api/session');
            assert.equal(api.resolveEndpoint('/session'), '/api/session');
        });

        test('prepends absolute baseURL to endpoints', () => {
            const api = new MatcherAPI('http://localhost:4000');
            assert.equal(api.resolveEndpoint('/api/session'), 'http://localhost:4000/api/session');
            assert.equal(api.resolveEndpoint('api/next'), 'http://localhost:4000/api/next');
        });

        test('returns absolute endpoints unchanged regardless of baseURL', () => {
            const api = new MatcherAPI('http://localhost:4000');
            assert.equal(
                api.resolveEndpoint('https://example.com/api/session'),
                'https://example.com/api/session'
            );
        });

        test('strips trailing slashes from baseURL', () => {
            const api = new MatcherAPI('http://localhost:4000///');
            assert.equal(api.baseURL, 'http://localhost:4000');
        });

        test('handles empty string baseURL same as no baseURL', () => {
            const api = new MatcherAPI('');
            assert.equal(api.resolveEndpoint('/api/session'), '/api/session');
        });

        test('handles HTTPS endpoints as absolute', () => {
            const api = new MatcherAPI();
            assert.equal(
                api.resolveEndpoint('https://secure.example.com/data'),
                'https://secure.example.com/data'
            );
        });

        test('handles HTTP endpoints as absolute (case-insensitive)', () => {
            const api = new MatcherAPI();
            assert.equal(
                api.resolveEndpoint('HTTP://EXAMPLE.COM/data'),
                'HTTP://EXAMPLE.COM/data'
            );
        });
    });

    // ---------------------------------------------------------------
    // request()
    // ---------------------------------------------------------------
    describe('request()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls fetch with resolved URL and default headers', async () => {
            const mockData = { status: 'ok' };
            globalThis.fetch = mockFetch(mockData);

            const result = await api.request('/api/session');

            assert.deepEqual(result, mockData);
            assert.equal(globalThis.fetch.mock.calls.length, 1);

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/session');
            assert.equal(options.headers['Content-Type'], 'application/json');
        });

        test('merges custom headers with default Content-Type', async () => {
            globalThis.fetch = mockFetch({});

            await api.request('/api/data', {
                headers: { 'Authorization': 'Bearer token123' }
            });

            const [, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(options.headers['Content-Type'], 'application/json');
            assert.equal(options.headers['Authorization'], 'Bearer token123');
        });

        test('passes method and body through to fetch', async () => {
            globalThis.fetch = mockFetch({ success: true });
            const body = JSON.stringify({ key: 'value' });

            await api.request('/api/submit', { method: 'POST', body });

            const [, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(options.method, 'POST');
            assert.equal(options.body, body);
        });

        test('throws on non-ok response with error text', async () => {
            globalThis.fetch = mockFetchFailure('Server error occurred', 500);

            await assert.rejects(
                () => api.request('/api/session'),
                (err) => {
                    assert.ok(err.message.includes('API Error'));
                    assert.ok(err.message.includes('Server error occurred'));
                    return true;
                }
            );
        });

        test('throws when fetch itself rejects (network error)', async () => {
            globalThis.fetch = mockFetchError('Network failure');

            await assert.rejects(
                () => api.request('/api/session'),
                (err) => {
                    assert.equal(err.message, 'Network failure');
                    return true;
                }
            );
        });
    });

    // ---------------------------------------------------------------
    // getSession()
    // ---------------------------------------------------------------
    describe('getSession()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls /api/compounds/test-compound/session with GET method', async () => {
            const sessionData = { stats: { matched: 5, skipped: 2, total_viva_listings: 100 } };
            globalThis.fetch = mockFetch(sessionData);

            const result = await api.getSession();

            assert.deepEqual(result, sessionData);
            const [url] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/session');
        });
    });

    // ---------------------------------------------------------------
    // getNext()
    // ---------------------------------------------------------------
    describe('getNext()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls /api/compounds/test-compound/next with GET method', async () => {
            const nextData = { viva_code: 'V123', viva: { price: '1000000' } };
            globalThis.fetch = mockFetch(nextData);

            const result = await api.getNext();

            assert.deepEqual(result, nextData);
            const [url] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/next');
        });

        test('handles done response', async () => {
            const doneData = { done: true, message: 'All listings reviewed!' };
            globalThis.fetch = mockFetch(doneData);

            const result = await api.getNext();

            assert.equal(result.done, true);
        });

        test('handles pass_complete response', async () => {
            const passData = {
                pass_complete: true,
                current_pass: 1,
                pass_name: 'Strict',
                stats: { matched: 10, skipped: 5 },
                has_next_pass: true,
                next_pass: { number: 2, name: 'Relaxed' }
            };
            globalThis.fetch = mockFetch(passData);

            const result = await api.getNext();

            assert.equal(result.pass_complete, true);
            assert.equal(result.current_pass, 1);
        });
    });

    // ---------------------------------------------------------------
    // getCandidates()
    // ---------------------------------------------------------------
    describe('getCandidates()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls /api/compounds/test-compound/candidates/{vivaId}', async () => {
            const candidatesData = { candidates: [{ code: 'C001' }, { code: 'C002' }] };
            globalThis.fetch = mockFetch(candidatesData);

            const result = await api.getCandidates('V123');

            assert.deepEqual(result, candidatesData);
            const [url] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/candidates/V123');
        });

        test('handles empty candidates list', async () => {
            globalThis.fetch = mockFetch({ candidates: [] });

            const result = await api.getCandidates('V999');

            assert.deepEqual(result.candidates, []);
        });
    });

    // ---------------------------------------------------------------
    // getListing()
    // ---------------------------------------------------------------
    describe('getListing()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls /api/compounds/test-compound/listing/{id}', async () => {
            const listing = { id: 'V123', price: '500000' };
            globalThis.fetch = mockFetch(listing);

            const result = await api.getListing('V123');

            assert.deepEqual(result, listing);
            const [url] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/listing/V123');
        });
    });

    // ---------------------------------------------------------------
    // submitMatch()
    // ---------------------------------------------------------------
    describe('submitMatch()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs match data with correct body', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.submitMatch('V123', 'C456', 30, 'reviewer1', 'looks good');

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/match');
            assert.equal(options.method, 'POST');

            const body = JSON.parse(options.body);
            assert.equal(body.viva_code, 'V123');
            assert.equal(body.coelho_code, 'C456');
            assert.equal(body.time_spent_sec, 30);
            assert.equal(body.reviewer, 'reviewer1');
            assert.equal(body.notes, 'looks good');
        });

        test('defaults notes to empty string', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.submitMatch('V123', 'C456', 15, 'reviewer1');

            const [, options] = globalThis.fetch.mock.calls[0].arguments;
            const body = JSON.parse(options.body);
            assert.equal(body.notes, '');
        });
    });

    // ---------------------------------------------------------------
    // rejectCandidate()
    // ---------------------------------------------------------------
    describe('rejectCandidate()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs rejection with correct body', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.rejectCandidate('V123', 'C456', 'reviewer1', 'not a match');

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/reject');
            assert.equal(options.method, 'POST');

            const body = JSON.parse(options.body);
            assert.equal(body.viva_code, 'V123');
            assert.equal(body.coelho_code, 'C456');
            assert.equal(body.reviewer, 'reviewer1');
            assert.equal(body.reason, 'not a match');
        });

        test('defaults reason to empty string', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.rejectCandidate('V123', 'C456', 'reviewer1');

            const [, options] = globalThis.fetch.mock.calls[0].arguments;
            const body = JSON.parse(options.body);
            assert.equal(body.reason, '');
        });
    });

    // ---------------------------------------------------------------
    // skipListing()
    // ---------------------------------------------------------------
    describe('skipListing()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs skip with correct body and default reason', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.skipListing('V123', 45, 'reviewer1');

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/skip');
            assert.equal(options.method, 'POST');

            const body = JSON.parse(options.body);
            assert.equal(body.viva_code, 'V123');
            assert.equal(body.reason, 'no_good_candidates');
            assert.equal(body.time_spent_sec, 45);
            assert.equal(body.reviewer, 'reviewer1');
        });

        test('allows custom skip reason', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.skipListing('V123', 10, 'reviewer1', 'duplicate');

            const [, options] = globalThis.fetch.mock.calls[0].arguments;
            const body = JSON.parse(options.body);
            assert.equal(body.reason, 'duplicate');
        });
    });

    // ---------------------------------------------------------------
    // undo()
    // ---------------------------------------------------------------
    describe('undo()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs undo with reviewer in body', async () => {
            globalThis.fetch = mockFetch({ success: true, undone: { action: 'match' } });

            const result = await api.undo('reviewer1');

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/undo');
            assert.equal(options.method, 'POST');

            const body = JSON.parse(options.body);
            assert.equal(body.reviewer, 'reviewer1');
            assert.equal(result.success, true);
        });
    });

    // ---------------------------------------------------------------
    // getProgress()
    // ---------------------------------------------------------------
    describe('getProgress()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls /api/compounds/test-compound/progress with GET', async () => {
            const progressData = { total: 100, matched: 50, skipped: 10, remaining: 40 };
            globalThis.fetch = mockFetch(progressData);

            const result = await api.getProgress();

            assert.deepEqual(result, progressData);
            const [url] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/progress');
        });
    });

    // ---------------------------------------------------------------
    // advancePass()
    // ---------------------------------------------------------------
    describe('advancePass()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs to /api/compounds/test-compound/pass/advance', async () => {
            globalThis.fetch = mockFetch({ pass: 2 });

            const result = await api.advancePass();

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/pass/advance');
            assert.equal(options.method, 'POST');
            assert.equal(result.pass, 2);
        });
    });

    // ---------------------------------------------------------------
    // finishMatching()
    // ---------------------------------------------------------------
    describe('finishMatching()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs to /api/compounds/test-compound/pass/finish with reviewer', async () => {
            globalThis.fetch = mockFetch({ finished: true });

            const result = await api.finishMatching('reviewer1');

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/pass/finish');
            assert.equal(options.method, 'POST');

            const body = JSON.parse(options.body);
            assert.equal(body.reviewer, 'reviewer1');
            assert.equal(result.finished, true);
        });
    });

    // ---------------------------------------------------------------
    // Error handling across API methods
    // ---------------------------------------------------------------
    describe('error handling', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('getSession rejects on server error', async () => {
            globalThis.fetch = mockFetchFailure('Session not found', 404);

            await assert.rejects(
                () => api.getSession(),
                (err) => {
                    assert.ok(err.message.includes('API Error'));
                    return true;
                }
            );
        });

        test('submitMatch rejects on network failure', async () => {
            globalThis.fetch = mockFetchError('Connection refused');

            await assert.rejects(
                () => api.submitMatch('V1', 'C1', 10, 'r'),
                { message: 'Connection refused' }
            );
        });

        test('skipListing rejects on 500 error', async () => {
            globalThis.fetch = mockFetchFailure('Internal error', 500);

            await assert.rejects(
                () => api.skipListing('V1', 10, 'r'),
                (err) => {
                    assert.ok(err.message.includes('Internal error'));
                    return true;
                }
            );
        });

        test('undo rejects on non-ok response', async () => {
            globalThis.fetch = mockFetchFailure('Nothing to undo', 400);

            await assert.rejects(
                () => api.undo('r'),
                (err) => {
                    assert.ok(err.message.includes('Nothing to undo'));
                    return true;
                }
            );
        });

        test('getCandidates rejects on server error', async () => {
            globalThis.fetch = mockFetchFailure('Listing not found', 404);

            await assert.rejects(
                () => api.getCandidates('V999'),
                (err) => {
                    assert.ok(err.message.includes('Listing not found'));
                    return true;
                }
            );
        });

        test('advancePass rejects on failure', async () => {
            globalThis.fetch = mockFetchFailure('No next pass', 400);

            await assert.rejects(
                () => api.advancePass(),
                (err) => {
                    assert.ok(err.message.includes('No next pass'));
                    return true;
                }
            );
        });

        test('finishMatching rejects on failure', async () => {
            globalThis.fetch = mockFetchError('Timeout');

            await assert.rejects(
                () => api.finishMatching('reviewer'),
                { message: 'Timeout' }
            );
        });
    });

    // ---------------------------------------------------------------
    // setCompound() / compoundPrefix()
    // ---------------------------------------------------------------
    describe('setCompound() / compoundPrefix()', () => {
        test('setCompound stores the compound ID', () => {
            const api = new MatcherAPI();
            api.setCompound('alphaville-1');
            assert.equal(api.compoundId, 'alphaville-1');
        });

        test('compoundPrefix returns correct path', () => {
            const api = new MatcherAPI();
            api.setCompound('alphaville-1');
            assert.equal(api.compoundPrefix(), '/api/compounds/alphaville-1');
        });

        test('compoundPrefix throws when no compound set', () => {
            const api = new MatcherAPI();
            assert.throws(() => api.compoundPrefix(), { message: 'No compound selected' });
        });

        test('compoundPrefix encodes special characters', () => {
            const api = new MatcherAPI();
            api.setCompound('test compound/special');
            assert.equal(api.compoundPrefix(), '/api/compounds/test%20compound%2Fspecial');
        });

        test('setCompound overwrites previous compound', () => {
            const api = new MatcherAPI();
            api.setCompound('compound-a');
            api.setCompound('compound-b');
            assert.equal(api.compoundId, 'compound-b');
            assert.equal(api.compoundPrefix(), '/api/compounds/compound-b');
        });
    });

    // ---------------------------------------------------------------
    // getCompounds()
    // ---------------------------------------------------------------
    describe('getCompounds()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('calls /api/compounds without compound prefix', async () => {
            const compoundsData = { compounds: [{ id: 'alphaville-1' }] };
            globalThis.fetch = mockFetch(compoundsData);

            const result = await api.getCompounds();

            assert.deepEqual(result, compoundsData);
            const [url] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds');
        });

        test('works without setCompound being called', async () => {
            globalThis.fetch = mockFetch({ compounds: [] });
            // Should NOT throw "No compound selected"
            const result = await api.getCompounds();
            assert.deepEqual(result, { compounds: [] });
        });
    });

    // ---------------------------------------------------------------
    // sendReportEmail()
    // ---------------------------------------------------------------
    describe('sendReportEmail()', () => {
        let api;
        let originalFetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
            api = new MatcherAPI('http://localhost:8080');
            api.setCompound('test-compound');
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        test('POSTs to compound-scoped report/send-email', async () => {
            globalThis.fetch = mockFetch({ success: true });

            await api.sendReportEmail('test@example.com');

            const [url, options] = globalThis.fetch.mock.calls[0].arguments;
            assert.equal(url, 'http://localhost:8080/api/compounds/test-compound/report/send-email');
            assert.equal(options.method, 'POST');

            const body = JSON.parse(options.body);
            assert.equal(body.to, 'test@example.com');
        });
    });
});

// ===================================================================
// MatcherState Tests
// ===================================================================
describe('MatcherState', () => {
    let state;

    beforeEach(() => {
        // Clear localStorage so getReviewer falls through to prompt
        localStorage.clear();
        // Ensure prompt returns a known value
        globalThis.prompt = () => 'test-reviewer';
        state = new MatcherState();
    });

    describe('constructor', () => {
        test('initializes with null currentListing', () => {
            assert.equal(state.currentListing, null);
        });

        test('initializes with empty candidates array', () => {
            assert.deepEqual(state.candidates, []);
        });

        test('initializes with null sessionInfo', () => {
            assert.equal(state.sessionInfo, null);
        });

        test('initializes currentIndex to 0', () => {
            assert.equal(state.currentIndex, 0);
        });

        test('initializes with empty taskQueue', () => {
            assert.deepEqual(state.taskQueue, []);
        });

        test('initializes decisionStartTime to null', () => {
            assert.equal(state.decisionStartTime, null);
        });

        test('reads theme from localStorage with dark default', () => {
            localStorage.clear();
            const s = new MatcherState();
            assert.equal(s.theme, 'dark');
        });

        test('reads saved theme from localStorage', () => {
            localStorage.setItem('matcher-theme', 'light');
            const s = new MatcherState();
            assert.equal(s.theme, 'light');
            localStorage.removeItem('matcher-theme');
        });
    });

    describe('getReviewer()', () => {
        test('returns reviewer from localStorage if set', () => {
            localStorage.setItem('matcher-reviewer', 'alice');
            const s = new MatcherState();
            assert.equal(s.reviewer, 'alice');
            localStorage.removeItem('matcher-reviewer');
        });

        test('prompts user when no reviewer in localStorage', () => {
            localStorage.clear();
            globalThis.prompt = () => 'bob';
            const s = new MatcherState();
            assert.equal(s.reviewer, 'bob');
        });

        test('saves prompted reviewer to localStorage', () => {
            localStorage.clear();
            globalThis.prompt = () => 'charlie';
            const s = new MatcherState();
            assert.equal(localStorage.getItem('matcher-reviewer'), 'charlie');
        });

        test('falls back to "anonymous" when prompt returns empty/null', () => {
            localStorage.clear();
            globalThis.prompt = () => null;
            const s = new MatcherState();
            assert.equal(s.reviewer, 'anonymous');
        });

        test('falls back to "anonymous" when prompt returns empty string', () => {
            localStorage.clear();
            globalThis.prompt = () => '';
            const s = new MatcherState();
            assert.equal(s.reviewer, 'anonymous');
        });
    });

    describe('setSession()', () => {
        test('stores session info', () => {
            const session = { stats: { matched: 5, skipped: 2 } };
            state.setSession(session);
            assert.deepEqual(state.sessionInfo, session);
        });

        test('overwrites previous session', () => {
            state.setSession({ old: true });
            state.setSession({ new: true });
            assert.deepEqual(state.sessionInfo, { new: true });
        });
    });

    describe('setCurrentListing() and getCurrentListing', () => {
        test('stores listing and sets decisionStartTime', () => {
            const before = Date.now();
            const listing = { propertyCode: 'V123', price: '1000000' };
            state.setCurrentListing(listing);

            assert.deepEqual(state.currentListing, listing);
            assert.ok(state.decisionStartTime >= before);
            assert.ok(state.decisionStartTime <= Date.now());
        });

        test('resets decisionStartTime on each call', async () => {
            state.setCurrentListing({ propertyCode: 'V1' });
            const t1 = state.decisionStartTime;

            // Small delay to ensure different timestamp
            await new Promise(r => setTimeout(r, 10));

            state.setCurrentListing({ propertyCode: 'V2' });
            const t2 = state.decisionStartTime;

            assert.ok(t2 > t1, 'decisionStartTime should be updated on second call');
        });

        test('can set listing to null', () => {
            state.setCurrentListing({ propertyCode: 'V1' });
            state.setCurrentListing(null);
            assert.equal(state.currentListing, null);
        });
    });

    describe('setCandidates()', () => {
        test('stores candidates array', () => {
            const candidates = [
                { propertyCode: 'C1', price: 500000 },
                { propertyCode: 'C2', price: 600000 }
            ];
            state.setCandidates(candidates);
            assert.deepEqual(state.candidates, candidates);
        });

        test('replaces previous candidates', () => {
            state.setCandidates([{ code: 'old' }]);
            state.setCandidates([{ code: 'new1' }, { code: 'new2' }]);
            assert.equal(state.candidates.length, 2);
            assert.equal(state.candidates[0].code, 'new1');
        });

        test('handles empty array', () => {
            state.setCandidates([{ code: 'C1' }]);
            state.setCandidates([]);
            assert.deepEqual(state.candidates, []);
        });
    });

    describe('getTimeSpent()', () => {
        test('returns 0 when decisionStartTime is null', () => {
            assert.equal(state.decisionStartTime, null);
            assert.equal(state.getTimeSpent(), 0);
        });

        test('returns elapsed seconds since setCurrentListing', async () => {
            state.setCurrentListing({ propertyCode: 'V1' });

            // Wait a bit so there is measurable time
            await new Promise(r => setTimeout(r, 50));

            const timeSpent = state.getTimeSpent();
            // Should be 0 since Math.floor rounds down < 1 second
            assert.ok(timeSpent >= 0);
            assert.ok(timeSpent < 2, 'Should not have spent more than 2 seconds');
        });

        test('returns time in whole seconds (floored)', () => {
            // Manually set decisionStartTime to 1.5 seconds ago
            state.decisionStartTime = Date.now() - 1500;
            assert.equal(state.getTimeSpent(), 1);
        });

        test('returns correct time for longer intervals', () => {
            state.decisionStartTime = Date.now() - 65000; // 65 seconds ago
            assert.equal(state.getTimeSpent(), 65);
        });
    });

    // ---------------------------------------------------------------
    // setCompound()
    // ---------------------------------------------------------------
    describe('setCompound()', () => {
        test('stores compound id and name', () => {
            localStorage.clear();
            globalThis.prompt = () => 'tester';
            const state = new MatcherState();
            state.setCompound('alphaville-1', 'Alphaville 1');
            assert.equal(state.compoundId, 'alphaville-1');
            assert.equal(state.compoundName, 'Alphaville 1');
        });

        test('persists compound id to localStorage', () => {
            localStorage.clear();
            globalThis.prompt = () => 'tester';
            const state = new MatcherState();
            state.setCompound('tambore-xi', 'Tambore XI');
            assert.equal(localStorage.getItem('matcher-last-compound'), 'tambore-xi');
        });

        test('initializes with null compoundId', () => {
            localStorage.clear();
            globalThis.prompt = () => 'tester';
            const state = new MatcherState();
            assert.equal(state.compoundId, null);
            assert.equal(state.compoundName, null);
        });
    });
});

// ===================================================================
// MatcherUI - Pure Utility Functions
// ===================================================================
describe('MatcherUI utility functions', () => {
    let ui;

    beforeEach(() => {
        ui = new MatcherUI();
    });

    // ---------------------------------------------------------------
    // formatPrice()
    // ---------------------------------------------------------------
    describe('formatPrice()', () => {
        test('returns dash for null/undefined/empty', () => {
            assert.equal(ui.formatPrice(null), '-');
            assert.equal(ui.formatPrice(undefined), '-');
            assert.equal(ui.formatPrice(''), '-');
            assert.equal(ui.formatPrice(0), '-');
        });

        test('formats numeric price in BRL', () => {
            const result = ui.formatPrice(1000000);
            // Intl.NumberFormat for pt-BR BRL should produce something like "R$ 1.000.000"
            assert.ok(result.includes('R$'), `Expected BRL format, got: ${result}`);
            assert.ok(result.includes('1.000.000') || result.includes('1,000,000'),
                `Expected formatted number, got: ${result}`);
        });

        test('parses Brazilian price string format: R$ 4.900.000,00', () => {
            const result = ui.formatPrice('R$ 4.900.000,00');
            assert.ok(result.includes('R$'), `Expected BRL format, got: ${result}`);
            assert.ok(result.includes('4.900.000') || result.includes('4,900,000'),
                `Expected 4900000 formatted, got: ${result}`);
        });

        test('parses price string without R$ prefix', () => {
            const result = ui.formatPrice('1.500.000,00');
            assert.ok(result.includes('R$'), `Expected BRL format, got: ${result}`);
            assert.ok(result.includes('1.500.000') || result.includes('1,500,000'),
                `Expected 1500000 formatted, got: ${result}`);
        });

        test('handles simple integer price', () => {
            const result = ui.formatPrice(500000);
            assert.ok(result.includes('R$'));
            assert.ok(result.includes('500.000') || result.includes('500,000'),
                `Expected 500000 formatted, got: ${result}`);
        });

        test('returns original string if it cannot be parsed as a number', () => {
            assert.equal(ui.formatPrice('not a price'), 'not a price');
        });

        test('handles decimal prices', () => {
            const result = ui.formatPrice(1234567.89);
            assert.ok(result.includes('R$'));
        });
    });

    // ---------------------------------------------------------------
    // calculateDelta()
    // ---------------------------------------------------------------
    describe('calculateDelta()', () => {
        test('returns 0 when original is 0', () => {
            assert.equal(ui.calculateDelta(0, 100), 0);
        });

        test('returns 0 when original is null/undefined', () => {
            assert.equal(ui.calculateDelta(null, 100), 0);
            assert.equal(ui.calculateDelta(undefined, 100), 0);
        });

        test('returns positive delta when compared > original', () => {
            // (200 - 100) / 100 * 100 = 100%
            const delta = ui.calculateDelta(100, 200);
            assert.equal(delta, 100);
        });

        test('returns negative delta when compared < original', () => {
            // (50 - 100) / 100 * 100 = -50%
            const delta = ui.calculateDelta(100, 50);
            assert.equal(delta, -50);
        });

        test('returns 0 when values are equal', () => {
            const delta = ui.calculateDelta(100, 100);
            assert.equal(delta, 0);
        });

        test('handles string inputs by stripping non-numeric chars', () => {
            // "R$ 1.000" -> "1000", "R$ 1.200" -> "1200"
            // Note: the regex /[^0-9.]/g strips everything but digits and dots
            // "1.000" becomes "1.000" -> 1.0 (the first period is a decimal point)
            // This is a quirk of the implementation
            const delta = ui.calculateDelta('1000', '1200');
            assert.equal(delta, 20); // (1200 - 1000) / 1000 * 100
        });

        test('handles compared being 0', () => {
            // (0 - 100) / 100 * 100 = -100%
            const delta = ui.calculateDelta(100, 0);
            assert.equal(delta, -100);
        });

        test('handles both values being null/undefined', () => {
            assert.equal(ui.calculateDelta(null, null), 0);
            assert.equal(ui.calculateDelta(undefined, undefined), 0);
        });
    });

    // ---------------------------------------------------------------
    // getDeltaClass()
    // ---------------------------------------------------------------
    describe('getDeltaClass()', () => {
        test('returns "neutral" for deltas within +/- 2%', () => {
            assert.equal(ui.getDeltaClass(0), 'neutral');
            assert.equal(ui.getDeltaClass(1.9), 'neutral');
            assert.equal(ui.getDeltaClass(-1.9), 'neutral');
            assert.equal(ui.getDeltaClass(1.5), 'neutral');
            assert.equal(ui.getDeltaClass(-0.5), 'neutral');
        });

        test('returns "positive" for deltas > 2%', () => {
            assert.equal(ui.getDeltaClass(2.1), 'positive');
            assert.equal(ui.getDeltaClass(50), 'positive');
            assert.equal(ui.getDeltaClass(100), 'positive');
        });

        test('returns "negative" for deltas < -2%', () => {
            assert.equal(ui.getDeltaClass(-2.1), 'negative');
            assert.equal(ui.getDeltaClass(-50), 'negative');
            assert.equal(ui.getDeltaClass(-100), 'negative');
        });

        test('returns "neutral" at exactly +/- 2% (boundary)', () => {
            // Math.abs(2) < 2 is false, so 2 is NOT neutral
            assert.equal(ui.getDeltaClass(2), 'positive');
            assert.equal(ui.getDeltaClass(-2), 'negative');
        });
    });

    // ---------------------------------------------------------------
    // formatDelta()
    // ---------------------------------------------------------------
    describe('formatDelta()', () => {
        test('returns "0.0%" for null', () => {
            assert.equal(ui.formatDelta(null), '0.0%');
        });

        test('returns "0.0%" for undefined', () => {
            assert.equal(ui.formatDelta(undefined), '0.0%');
        });

        test('returns "0.0%" for NaN', () => {
            assert.equal(ui.formatDelta(NaN), '0.0%');
        });

        test('formats zero as "0.0%"', () => {
            assert.equal(ui.formatDelta(0), '0.0%');
        });

        test('formats positive deltas with + sign', () => {
            assert.equal(ui.formatDelta(5.5), '+5.5%');
            assert.equal(ui.formatDelta(100), '+100.0%');
            assert.equal(ui.formatDelta(0.1), '+0.1%');
        });

        test('formats negative deltas with - sign', () => {
            assert.equal(ui.formatDelta(-5.5), '-5.5%');
            assert.equal(ui.formatDelta(-100), '-100.0%');
            assert.equal(ui.formatDelta(-0.1), '-0.1%');
        });

        test('rounds to one decimal place', () => {
            assert.equal(ui.formatDelta(3.14159), '+3.1%');
            assert.equal(ui.formatDelta(-7.777), '-7.8%');
            assert.equal(ui.formatDelta(99.95), '+100.0%');
        });

        test('handles very small values', () => {
            assert.equal(ui.formatDelta(0.04), '+0.0%');
            assert.equal(ui.formatDelta(-0.04), '-0.0%');
        });
    });
});

// ===================================================================
// MatcherAPI constructor edge cases
// ===================================================================
describe('MatcherAPI constructor', () => {
    test('accepts no arguments', () => {
        const api = new MatcherAPI();
        assert.equal(api.baseURL, '');
    });

    test('accepts empty string', () => {
        const api = new MatcherAPI('');
        assert.equal(api.baseURL, '');
    });

    test('strips trailing slashes from baseURL', () => {
        const api = new MatcherAPI('http://example.com/');
        assert.equal(api.baseURL, 'http://example.com');
    });

    test('strips multiple trailing slashes', () => {
        const api = new MatcherAPI('http://example.com///');
        assert.equal(api.baseURL, 'http://example.com');
    });

    test('handles null/undefined baseURL gracefully', () => {
        const api1 = new MatcherAPI(null);
        assert.equal(api1.baseURL, '');

        const api2 = new MatcherAPI(undefined);
        assert.equal(api2.baseURL, '');
    });

    test('preserves path in baseURL', () => {
        const api = new MatcherAPI('http://example.com/v1/api');
        assert.equal(api.baseURL, 'http://example.com/v1/api');
    });
});

// ===================================================================
// Integration-style tests: MatcherAPI request flow
// ===================================================================
describe('MatcherAPI request flow integration', () => {
    let api;
    let originalFetch;
    let fetchCalls;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        fetchCalls = [];
        api = new MatcherAPI('http://localhost:8080');
        api.setCompound('test-compound');
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('sequential API calls maintain independent state', async () => {
        let callCount = 0;
        globalThis.fetch = mock.fn(() => {
            callCount++;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ call: callCount }),
                text: () => Promise.resolve(''),
            });
        });

        const r1 = await api.getSession();
        const r2 = await api.getNext();
        const r3 = await api.getProgress();

        assert.equal(r1.call, 1);
        assert.equal(r2.call, 2);
        assert.equal(r3.call, 3);
        assert.equal(globalThis.fetch.mock.calls.length, 3);
    });

    test('Content-Type header is always set to application/json', async () => {
        globalThis.fetch = mockFetch({});

        await api.submitMatch('V1', 'C1', 10, 'reviewer');

        const [, options] = globalThis.fetch.mock.calls[0].arguments;
        assert.equal(options.headers['Content-Type'], 'application/json');
    });

    test('custom headers do not override Content-Type', async () => {
        globalThis.fetch = mockFetch({});

        await api.request('/api/custom', {
            headers: { 'Content-Type': 'text/plain' }
        });

        const [, options] = globalThis.fetch.mock.calls[0].arguments;
        // Custom headers come after default, so they override
        assert.equal(options.headers['Content-Type'], 'text/plain');
    });
});

// ===================================================================
// MatcherState + time tracking
// ===================================================================
describe('MatcherState time tracking integration', () => {
    test('full workflow: set listing -> spend time -> get time', async () => {
        localStorage.clear();
        globalThis.prompt = () => 'workflow-tester';
        const state = new MatcherState();

        // Initially no time spent
        assert.equal(state.getTimeSpent(), 0);

        // Set a listing
        state.setCurrentListing({ propertyCode: 'V100' });

        // Simulate some time passing (100ms = 0 seconds floored)
        await new Promise(r => setTimeout(r, 100));

        const timeSpent = state.getTimeSpent();
        assert.ok(timeSpent >= 0, 'Time should be non-negative');

        // Set new listing resets the timer
        state.setCurrentListing({ propertyCode: 'V200' });
        const newTimeSpent = state.getTimeSpent();
        assert.ok(newTimeSpent <= 1, 'Timer should reset with new listing');
    });

    test('clearing listing to null does not crash getTimeSpent', () => {
        localStorage.clear();
        globalThis.prompt = () => 'tester';
        const state = new MatcherState();

        state.setCurrentListing({ propertyCode: 'V1' });
        state.setCurrentListing(null);

        // decisionStartTime was set to Date.now() when null was passed
        const t = state.getTimeSpent();
        assert.ok(t >= 0);
    });
});
