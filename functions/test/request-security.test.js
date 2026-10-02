import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequestEnvelope, secureResponse } from '../request-security.js';
const origin = 'https://planning-with-ai-52d58.web.app';
const request = (url, extra = {}, headers = {}) => ({ url, method: 'POST', body: {}, ...extra, get: name => ({ origin, 'content-type': 'application/json', ...headers })[name] });
test('every route has an envelope cap, including auxiliary handlers before authentication', () => {
  for (const path of ['/api/ai/workflow', '/api/ai/retention/export', '/api/ai/admin/access', '/api/login-security/session']) {
    assert.throws(() => validateRequestEnvelope(request(path, { rawBody: Buffer.alloc(16385) })), { status: 413 });
    assert.equal(validateRequestEnvelope(request(path, { rawBody: Buffer.alloc(16384) })), path);
  }
  assert.throws(() => validateRequestEnvelope(request('/api/ai/profile', { rawBody: Buffer.alloc(190001) })), { status: 413 });
  assert.throws(() => validateRequestEnvelope(request('/line-webhook/123', { rawBody: Buffer.alloc(1048577) })), { status: 413 });
  assert.throws(() => validateRequestEnvelope(request('/api/line/reply', {}, { 'content-length': '9000000' })), { status: 413 });
  assert.throws(() => validateRequestEnvelope(request('/api/line/reply', {}, { 'content-length': '-1' })), { status: 400 });
});
test('browser APIs reject cross-site, missing-origin writes and non-JSON envelopes', () => {
  assert.throws(() => validateRequestEnvelope(request('/api/ai/workflow', {}, { origin: 'https://evil.invalid' })), { status: 403 });
  assert.throws(() => validateRequestEnvelope(request('/api/ai/workflow', {}, { origin: undefined })), { status: 403 });
  assert.throws(() => validateRequestEnvelope(request('/api/ai/workflow', { method: 'GET' }, { 'sec-fetch-site': 'cross-site' })), { status: 403 });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) assert.throws(() => validateRequestEnvelope(request('/api/ai/workflow', {}, { 'content-type': type })), { status: 415 });
  assert.throws(() => validateRequestEnvelope(request('/api/ai/workflow', { body: [] })), { status: 400 });
  assert.equal(validateRequestEnvelope(request('/api/ai/workflow', {}, { 'content-type': 'Application/JSON; charset=utf-8' })), '/api/ai/workflow');
});
test('platform webhooks, callbacks and token-authorized read clients retain their own security checks', () => {
  for (const path of ['/line-webhook/123', '/zernio-webhook']) assert.equal(validateRequestEnvelope(request(path, {}, { origin: undefined })), path);
  assert.equal(validateRequestEnvelope(request('/zernio-callback', { method: 'GET' }, { origin: undefined })), '/zernio-callback');
  assert.equal(validateRequestEnvelope(request('/api/ai/profile', { method: 'GET' }, { origin: undefined })), '/api/ai/profile');
  const media = '/api/line/media/123456/00000000-0000-4000-8000-000000000001';
  assert.equal(validateRequestEnvelope(request(media, { method: 'GET' }, { origin: 'https://line.me', 'sec-fetch-site': 'cross-site' })), media);
  const headers = {}; secureResponse({ set: (key, value) => { headers[key] = value; } });
  assert.equal(headers['Cache-Control'], 'private, no-store'); assert.equal(headers['Referrer-Policy'], 'no-referrer');
});
