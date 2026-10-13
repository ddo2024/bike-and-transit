const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { test } = require('node:test');
const { createRequestJson, DEFAULT_REQUEST_TIMEOUT_MS } = require('./requestJson');

function harness({ constructionError } = {}) {
  const timers = new Map();
  const requests = [];
  let nextTimer = 0;
  const requestJson = createRequestJson({
    setTimer(callback, delay) {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delay });
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
    request(url, options, callback) {
      if (constructionError) throw constructionError;
      const request = new EventEmitter();
      request.body = '';
      request.write = (chunk) => { request.body += chunk; };
      request.end = () => { request.ended = true; };
      request.destroy = () => { request.destroyed = true; };
      request.respond = (statusCode = 200) => {
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.destroy = () => { response.destroyed = true; };
        callback(response);
        return response;
      };
      requests.push({ url, options, request });
      return request;
    },
  });
  return { requestJson, requests, timers };
}

test('success parses chunked JSON and clears deadline and abort listener', async () => {
  const { requestJson, requests, timers } = harness();
  const controller = new AbortController();
  const promise = requestJson('https://example.test/route', {
    method: 'POST', body: { address: 'A' }, signal: controller.signal,
  });
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const { request, options } = requests[0];
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(request.body, '{"address":"A"}');
  const response = request.respond();
  response.emit('data', '{"routes":');
  response.emit('data', '[]}');
  response.emit('end');
  assert.deepEqual(await promise, { routes: [] });
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  assert.equal(request.destroyed, undefined);
});

test('deadline terminates a request that never connects', async () => {
  const { requestJson, requests, timers } = harness();
  const controller = new AbortController();
  const promise = requestJson('https://example.test', { signal: controller.signal, timeoutMs: 25 });
  const [{ callback, delay }] = timers.values();
  assert.equal(delay, 25);
  callback();
  await assert.rejects(promise, { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(requests[0].request.destroyed, true);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('streaming data does not reset the wall-clock deadline', async () => {
  const { requestJson, requests, timers } = harness();
  const promise = requestJson('https://example.test');
  const response = requests[0].request.respond();
  const deadline = [...timers.values()][0];
  response.emit('data', '{');
  response.emit('data', '"stillStreaming":');
  assert.equal([...timers.values()][0], deadline);
  deadline.callback();
  await assert.rejects(promise, { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(response.destroyed, true);
  assert.equal(requests[0].request.destroyed, true);
  // Late errors from socket destruction must not become uncaught exceptions.
  response.emit('error', new Error('late response error'));
  requests[0].request.emit('error', new Error('late socket error'));
  response.emit('end');
});

test('abort before construction does not send a request or install a timer', async () => {
  const { requestJson, requests, timers } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestJson('https://example.test', { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(requests.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort during a response closes transport and clears deadline and listener', async () => {
  const { requestJson, requests, timers } = harness();
  const controller = new AbortController();
  const promise = requestJson('https://example.test', { signal: controller.signal });
  const response = requests[0].request.respond();
  controller.abort(new Error('search deadline'));
  await assert.rejects(promise, { code: 'ABORT_ERR' });
  assert.equal(requests[0].request.destroyed, true);
  assert.equal(response.destroyed, true);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('response aborts and errors reject instead of hanging', async (t) => {
  for (const [event, code] of [['aborted', 'UPSTREAM_RESPONSE_ABORTED'], ['error', 'UPSTREAM_RESPONSE_FAILED']]) {
    await t.test(event, async () => {
      const { requestJson, requests, timers } = harness();
      const promise = requestJson('https://example.test');
      const response = requests[0].request.respond();
      response.emit(event, new Error('socket failed'));
      await assert.rejects(promise, { code });
      assert.equal(timers.size, 0);
      assert.equal(requests[0].request.destroyed, true);
    });
  }
});

test('request construction and socket errors release resources', async (t) => {
  await t.test('construction', async () => {
    const { requestJson, timers } = harness({ constructionError: new Error('invalid request') });
    const controller = new AbortController();
    await assert.rejects(requestJson('https://example.test', { signal: controller.signal }), { code: 'UPSTREAM_REQUEST_FAILED' });
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
  await t.test('socket', async () => {
    const { requestJson, requests, timers } = harness();
    const promise = requestJson('https://example.test');
    requests[0].request.emit('error', new Error('connection refused'));
    await assert.rejects(promise, { code: 'UPSTREAM_REQUEST_FAILED' });
    assert.equal(timers.size, 0);
  });
});

test('malformed and HTTP error responses do not expose upstream response text', async (t) => {
  for (const [status, body, code] of [
    [200, 'private-address or secret', 'UPSTREAM_INVALID_JSON'],
    [403, '{"error":{"message":"private-address or secret"}}', 'UPSTREAM_HTTP_ERROR'],
  ]) {
    await t.test(String(status), async () => {
      const { requestJson, requests, timers } = harness();
      const promise = requestJson('https://example.test/route?key=secret');
      const response = requests[0].request.respond(status);
      response.emit('data', body);
      response.emit('end');
      await assert.rejects(promise, (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private-address|secret/);
        return true;
      });
      assert.equal(timers.size, 0);
    });
  }
});

test('invalid deadline is rejected before contacting upstream', async () => {
  const { requestJson, requests } = harness();
  await assert.rejects(requestJson('https://example.test', { timeoutMs: 0 }), TypeError);
  assert.equal(requests.length, 0);
});
