// Binary feeds have bounded downloads and never expose token-bearing URLs in errors.
async function download(url, { fetchImpl = fetch, timeoutMs = 20000, maxBytes = 30_000_000 } = {}) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) {
      const error = new Error(`Transit feed HTTP ${response.status}`);
      error.status = response.status;
      const value = response.headers.get('retry-after');
      error.retryAfterMs = /^\d+$/.test(value || '') ? +value * 1000 : Math.max(0, Date.parse(value) - Date.now()) || 0;
      throw error;
    }
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Transit feed too large');
    const parts = []; let length = 0;
    for await (const part of response.body) {
      length += part.length;
      if (length > maxBytes) throw new Error('Transit feed too large');
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  } catch (cause) {
    const error = new Error(cause.status ? `Transit feed HTTP ${cause.status}` : 'Transit feed download failed');
    error.status = cause.status; error.retryAfterMs = cause.retryAfterMs;
    throw error;
  }
}
module.exports = { download };
