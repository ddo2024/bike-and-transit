require('dotenv').config();
const { createApp } = require('./app');
const mapsClient = require('./googleMaps');
const { createGtfsProvider } = require('./gtfs/provider');
const { createTransitRuntime, positive } = require('./gtfs/runtime');

const PORT = process.env.PORT || 3000;
const runtime = createTransitRuntime();
const transitProvider = createGtfsProvider(runtime, mapsClient, {
  horizonHours: positive(process.env.GTFS_SEARCH_HOURS, 6, 1, 24),
  maxTransfers: Math.floor(positive(process.env.GTFS_MAX_TRANSFERS, 2, 0, 4)),
  matrixBudget: Math.floor(positive(process.env.BIKE_MATRIX_ELEMENT_BUDGET, 3000, 50, 10000)),
});
runtime.start();
const app = createApp({ transitProvider, browserApiKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY || null });
app.listen(PORT, () => {
  console.log(`Bike transit app listening on http://localhost:${PORT}`);
});
