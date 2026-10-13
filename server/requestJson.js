const https = require('https');

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function upstreamError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// The deadline spans connection establishment and the entire response, including
// a server that keeps sending data but never finishes. Dependencies are injectable
// so timeout and cancellation behavior can be tested without network access.
function createRequestJson({
  request: sendRequest = https.request,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return function requestJson(url, {
    method = 'GET', headers = {}, body, signal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(upstreamError('Google Maps API request was cancelled.', 'ABORT_ERR', signal.reason));
        return;
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        reject(new TypeError('Request timeout must be a finite positive number.'));
        return;
      }

      let request;
      let response;
      let timer;
      let settled = false;
      let responseBody = '';

      function finish(error, data) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          // Keep error handlers attached: destroy can emit an asynchronous error.
          // All handlers ignore events after settlement.
          request?.destroy();
          response?.destroy();
          reject(error);
        } else {
          resolve(data);
        }
      }

      function onAbort() {
        finish(upstreamError('Google Maps API request was cancelled.', 'ABORT_ERR', signal.reason));
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimer(() => {
        finish(upstreamError('Google Maps API request exceeded its deadline.', 'UPSTREAM_TIMEOUT'));
      }, timeoutMs);

      try {
        const requestUrl = new URL(url);
        const serializedBody = body === undefined ? undefined : JSON.stringify(body);
        request = sendRequest(requestUrl, {
          method,
          headers: {
            Accept: 'application/json',
            ...(serializedBody === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
        }, (incoming) => {
          response = incoming;
          response.on('error', (error) => {
            finish(upstreamError('Google Maps API response failed.', 'UPSTREAM_RESPONSE_FAILED', error));
          });
          response.on('aborted', () => {
            finish(upstreamError('Google Maps API response was interrupted.', 'UPSTREAM_RESPONSE_ABORTED'));
          });
          response.on('data', (chunk) => {
            if (!settled) responseBody += chunk;
          });
          response.on('end', () => {
            if (settled) return;
            if (response.statusCode < 200 || response.statusCode >= 300) {
              finish(upstreamError(
                `Google Maps API request failed for ${requestUrl.pathname} with status ${response.statusCode}.`,
                'UPSTREAM_HTTP_ERROR',
              ));
              return;
            }
            try {
              finish(null, responseBody ? JSON.parse(responseBody) : {});
            } catch {
              // JSON syntax errors can quote the response, so omit their cause.
              finish(upstreamError('Invalid JSON from Google Maps API.', 'UPSTREAM_INVALID_JSON'));
            }
          });
          if (settled) response.destroy();
        });
        request.on('error', (error) => {
          finish(upstreamError('Google Maps API request failed.', 'UPSTREAM_REQUEST_FAILED', error));
        });
        if (serializedBody !== undefined) request.write(serializedBody);
        request.end();
      } catch (error) {
        finish(upstreamError('Could not create Google Maps API request.', 'UPSTREAM_REQUEST_FAILED', error));
      }
    });
  };
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  createRequestJson,
  requestJson: createRequestJson(),
};
