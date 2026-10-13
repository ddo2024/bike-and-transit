const express = require('express');
const path = require('path');
const googleMaps = require('./googleMaps');
const { createSearchService } = require('./searchService');
const { validateSearchRequest } = require('./validation');

function createApp({ mapsClient = googleMaps, searchTimeoutMs, browserApiKey = null, transitProvider } = {}) {
  const app = express();
  const service = createSearchService(mapsClient, { searchTimeoutMs, transitProvider });
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api/map-config', (req, res) => res.json({ browserApiKey }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.post('/api/search', async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const input = validateSearchRequest(req.body);
      const result = await service.search(input, { signal: controller.signal });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      const status = error.statusCode || (error.code === 'UPSTREAM_TIMEOUT' ? 504 : 502);
      res.status(status).json({ error: status === 400 || status === 504
        ? error.message : 'Route search failed. Please check the server API configuration or try again.' });
    } finally {
      res.off('close', onClose);
    }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid JSON search request.' });
  });
  return app;
}

module.exports = { createApp };
