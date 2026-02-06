import test from 'node:test';
import assert from 'node:assert/strict';

import { MatcherAPI } from '../server-deploy/public/js/matcher-app.js';

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
