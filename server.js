const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { execSync } = require('child_process');

const app = express();
const PORT = 3333;
const HTTPS_PORT = 3443;
const DATA_DIR = path.join(__dirname, 'test-data');

// Trust reverse-proxy headers (X-Forwarded-Proto, etc.)
// so req.protocol returns 'https' behind Railway / nginx / etc.
app.set('trust proxy', true);

// =====================================================================
//  SECTION 1 — CONSTANTS & DATA FILE MAP
// =====================================================================

const ALL_FILES = {
  GEOJSON: 'points.geojson',
  CSV:     'data.csv',
  TXT:     'data.txt',
  XLSX:    'data.xlsx',
  GPX:     'data.gpx',
  XML:     'data.xml',
  JSON:    'data.json',
  SHP:     'data.shp.zip',
  GPKG:    'data.gpkg',
  GDB:     'data.gdb.zip',
};

// =====================================================================
//  SECTION 2 — AUTH CREDENTIALS
// =====================================================================

// Legacy credentials (backward-compatible)
const LEGACY_BASIC_USER = 'testuser';
const LEGACY_BASIC_PASS = 'testpass';
const LEGACY_BEARER     = 'test-token-123';
const LEGACY_API_KEY    = 'my-secret-key';
const LEGACY_QUERY_TOK  = 'my-query-token';

// New credentials (per spec)
const NEW_BEARER        = 'my-secret-token-123';
const NEW_API_KEY       = 'test-api-key-456';
const NEW_CUSTOM_HEADERS = { 'x-custom-auth': 'custom-value-1', 'x-workspace-id': 'workspace-abc' };
const NEW_QUERY_PARAMS  = { token: 'secret-query-token', workspace: 'ws1' };
const SECURE_API_BEARER = 'test-bearer-token-789';

// =====================================================================
//  SECTION 3 — LOGGING MIDDLEWARE
// =====================================================================

app.use((req, res, next) => {
  const start = Date.now();
  const authRaw = req.headers.authorization || '';
  const masked = authRaw
    ? authRaw.replace(/^(Basic |Bearer )(.{4}).*/, '$1$2****')
    : '(none)';
  res.on('finish', () => {
    const ms = Date.now() - start;
    const icon = res.statusCode < 400 ? '✓' : '✗';
    console.log(
      `${icon}  ${req.method.padEnd(6)} ${req.originalUrl.padEnd(60)} → ${res.statusCode}  (${ms}ms)  auth=${masked}`
    );
  });
  next();
});

// =====================================================================
//  SECTION 4 — AUTH MIDDLEWARE FACTORIES
// =====================================================================

// --- Legacy auth (for /public, /basic, /token, /headers, /query) -----

function requireBasicLegacy(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="test-server"');
    return res.status(401).json({ error: 'Basic auth required' });
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, ...pp] = decoded.split(':');
  if (user === LEGACY_BASIC_USER && pp.join(':') === LEGACY_BASIC_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="test-server"');
  return res.status(401).json({ error: 'Invalid credentials' });
}

function requireBearerLegacy(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.split(' ')[1] === LEGACY_BEARER) return next();
  return res.status(401).json({ error: 'Bearer token required' });
}

function requireApiKeyLegacy(req, res, next) {
  if (req.headers['x-api-key'] === LEGACY_API_KEY) return next();
  return res.status(403).json({ error: 'X-Api-Key header required' });
}

function requireQueryTokenLegacy(req, res, next) {
  if (req.query.token === LEGACY_QUERY_TOK) return next();
  return res.status(403).json({ error: 'Query param ?token= required' });
}

// --- New auth (for /files/protected/*) --------------------------------

function requireBasicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="test-server"');
    return res.status(401).json({ error: 'Basic auth required. Send: Authorization: Basic base64(testuser:testpass)' });
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, ...pp] = decoded.split(':');
  if (user === LEGACY_BASIC_USER && pp.join(':') === LEGACY_BASIC_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="test-server"');
  return res.status(401).json({ error: 'Invalid credentials' });
}

function requireBearerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && auth.split(' ')[1] === NEW_BEARER) return next();
  return res.status(401).json({ error: 'Bearer token required. Send: Authorization: Bearer my-secret-token-123' });
}

function requireApiKeyAuth(req, res, next) {
  if (req.headers['x-api-key'] === NEW_API_KEY) return next();
  return res.status(401).json({ error: 'API key required. Send: X-API-Key: test-api-key-456' });
}

function requireCustomHeaders(req, res, next) {
  for (const [key, val] of Object.entries(NEW_CUSTOM_HEADERS)) {
    if ((req.headers[key] || '').toLowerCase() !== val.toLowerCase()) {
      return res.status(401).json({
        error: `Custom headers required. Send: X-Custom-Auth: custom-value-1 and X-Workspace-Id: workspace-abc`
      });
    }
  }
  return next();
}

function requireQueryParams(req, res, next) {
  for (const [key, val] of Object.entries(NEW_QUERY_PARAMS)) {
    if (req.query[key] !== val) {
      return res.status(401).json({
        error: `Query params required: ?token=secret-query-token&workspace=ws1`
      });
    }
  }
  return next();
}

function requireSecureApiBearer(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && auth.split(' ')[1] === SECURE_API_BEARER) return next();
  return res.status(401).json({ error: 'Bearer token required. Send: Authorization: Bearer test-bearer-token-789' });
}

// =====================================================================
//  SECTION 5 — FILE SERVING HELPERS
// =====================================================================

function serveFile(filename) {
  return (req, res) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: `File not found: ${filename}. Run "node generate-data.js" first.` });
    return res.download(filePath);
  };
}

function serveAnyFile(req, res) {
  const filename = req.params.file || req.params[0];
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: `File not found: ${filename}` });
  return res.download(filePath);
}

function serveZip(entries, zipName, options = {}) {
  return (req, res) => {
    if (options.noRange) res.set('Accept-Ranges', 'none');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => res.status(500).json({ error: err.message }));
    archive.pipe(res);
    for (const entry of entries) {
      const fp = path.join(DATA_DIR, entry);
      if (fs.existsSync(fp)) archive.file(fp, { name: entry });
    }
    archive.finalize();
  };
}

// =====================================================================
//  SECTION 6 — IN-MEMORY API DATA GENERATION
// =====================================================================

function rand(min, max) { return +(min + Math.random() * (max - min)).toFixed(6); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function israelPoint() { return [rand(34.2, 35.8), rand(29.5, 33.3)]; }

function smallPoly(center, size) {
  const [cx, cy] = center;
  const h = size / 2;
  return [[
    [+(cx-h).toFixed(6), +(cy-h).toFixed(6)],
    [+(cx+h).toFixed(6), +(cy-h).toFixed(6)],
    [+(cx+h).toFixed(6), +(cy+h).toFixed(6)],
    [+(cx-h).toFixed(6), +(cy+h).toFixed(6)],
    [+(cx-h).toFixed(6), +(cy-h).toFixed(6)],
  ]];
}

function lineCoords(segCount) {
  const start = israelPoint();
  const coords = [start];
  for (let i = 1; i < segCount; i++) {
    const prev = coords[coords.length - 1];
    coords.push([
      +(prev[0] + (Math.random() - 0.5) * 0.02).toFixed(6),
      +(prev[1] + (Math.random() - 0.5) * 0.02).toFixed(6),
    ]);
  }
  return coords;
}

const CATEGORIES = ['park', 'school', 'hospital', 'restaurant', 'museum', 'market', 'library', 'station'];
const ROAD_NAMES = ['Main St', 'Oak Ave', 'Herzl Blvd', 'Ben Gurion Way', 'Weizmann St', 'Jabotinsky Rd', 'Rothschild Blvd', 'Dizengoff St', 'Allenby Rd', 'King George St'];
const OWNERS = ['City', 'State', 'Private', 'Municipality', 'National Park'];
const STATUSES = ['active', 'inactive', 'pending', 'archived'];
const ZONE_TYPES = ['Industrial', 'Residential', 'Commercial', 'Agricultural', 'Mixed Use', 'Educational', 'Military', 'Nature Reserve'];
const EVENT_TITLES = ['Concert', 'Marathon', 'Festival', 'Exhibition', 'Conference', 'Workshop', 'Meetup', 'Hackathon', 'Fair', 'Ceremony'];

// -- Generate datasets once at startup --

function generateApiPoints(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const [lon, lat] = israelPoint();
    items.push({
      id: i + 1,
      name: `Point ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) || ''}`,
      lon, lat,
      category: pick(CATEGORIES),
    });
  }
  return items;
}

function generateApiParcels(count) {
  const features = [];
  for (let i = 0; i < count; i++) {
    const center = israelPoint();
    const size = rand(0.005, 0.02);
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: smallPoly(center, size) },
      properties: {
        parcelId: `A${String(i + 1).padStart(3, '0')}`,
        area: randInt(200, 80000),
        owner: pick(OWNERS),
      },
    });
  }
  return features;
}

function generateApiZones() {
  const zones = {};
  const count = randInt(5, 10);
  for (let i = 0; i < count; i++) {
    const [x, y] = israelPoint();
    const key = `zone_${String.fromCharCode(97 + i)}`;
    zones[key] = {
      name: ZONE_TYPES[i % ZONE_TYPES.length],
      x, y,
      maxHeight: pick([12, 15, 20, 25, 30, 40, 50]),
    };
  }
  return zones;
}

function generateApiRoads(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const coords = lineCoords(randInt(3, 8));
    const wkt = 'LINESTRING(' + coords.map(c => `${c[0]} ${c[1]}`).join(', ') + ')';
    items.push({
      road_id: i + 101,
      road_name: ROAD_NAMES[i % ROAD_NAMES.length] + (i >= ROAD_NAMES.length ? ` ${Math.floor(i / ROAD_NAMES.length) + 1}` : ''),
      geom_wkt: wkt,
      lanes: pick([1, 2, 3, 4, 6]),
    });
  }
  return items;
}

function generateApiEvents(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const [lon, lat] = israelPoint();
    items.push({
      event_id: i + 1,
      title: `${pick(EVENT_TITLES)} ${i + 1}`,
      longitude: lon,
      latitude: lat,
    });
  }
  return items;
}

function generateApiBuildings(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const [lon, lat] = israelPoint();
    items.push({
      id: i + 1,
      address: `${randInt(1, 500)} ${pick(ROAD_NAMES)}`,
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return items;
}

function generateApiSecureLocations(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const [x, y] = israelPoint();
    items.push({
      loc_id: i + 1,
      x, y,
      status: pick(STATUSES),
    });
  }
  return items;
}

function generateRateLimitedData(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const [lon, lat] = israelPoint();
    items.push({ id: i + 1, name: `RL-Point ${i + 1}`, lon, lat });
  }
  return items;
}

// ========= Datasets (populated in start()) ===========================
let apiPoints = [];
let apiParcels = [];
let apiZones = {};
let apiRoads = [];
let apiEvents = [];
let apiBuildings = [];
let apiSecureLocations = [];
let apiRateLimitedData = [];

// =====================================================================
//  SECTION 7 — LEGACY FILE ROUTES (/public, /basic, /token, /headers, /query)
// =====================================================================

function registerLegacyFileRoutes(prefix, middleware) {
  const mw = middleware ? [middleware] : [];
  for (const [, filename] of Object.entries(ALL_FILES)) {
    app.get(`${prefix}/${filename}`, ...mw, serveFile(filename));
  }
  // Additional files
  app.get(`${prefix}/lines.geojson`, ...mw, serveFile('lines.geojson'));
  app.get(`${prefix}/archive.zip`, ...mw, serveZip(['points.geojson'], 'archive.zip'));
  app.get(`${prefix}/large-archive.zip`, ...mw, serveZip(['target.csv', 'other.csv', 'readme.csv'], 'large-archive.zip'));
}

registerLegacyFileRoutes('/public', null);
registerLegacyFileRoutes('/basic', requireBasicLegacy);
registerLegacyFileRoutes('/token', requireBearerLegacy);
registerLegacyFileRoutes('/headers', requireApiKeyLegacy);
registerLegacyFileRoutes('/query', requireQueryTokenLegacy);

// =====================================================================
//  SECTION 8 — NEW FILE ROUTES (/files/public, /files/protected/*)
//  Spec endpoints A1–A8
// =====================================================================

// A7 — Large file (>100MB GeoJSON streamed on-the-fly)
// MUST be registered before the :file wildcard so it isn't swallowed
app.get('/files/public/large-dataset.geojson', (req, res) => {
  res.set('Content-Type', 'application/geo+json');
  res.set('Content-Disposition', 'attachment; filename="large-dataset.geojson"');
  res.write('{"type":"FeatureCollection","features":[\n');

  const TARGET_BYTES = 110 * 1024 * 1024; // ~110 MB
  let written = 0;
  let id = 0;
  let first = true;

  function writeChunk() {
    let ok = true;
    while (written < TARGET_BYTES && ok) {
      const [lon, lat] = israelPoint();
      const feature = JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { id: ++id, name: `Feature ${id}`, value: randInt(1, 1000) },
      });
      const line = (first ? '' : ',\n') + feature;
      first = false;
      ok = res.write(line);
      written += line.length;
    }
    if (written < TARGET_BYTES) {
      res.once('drain', writeChunk);
    } else {
      res.end('\n]}');
      console.log(`  📦 Streamed large GeoJSON: ${(written / 1024 / 1024).toFixed(1)} MB, ${id} features`);
    }
  }
  writeChunk();
});

// A1 — Public file (no auth)
app.get('/files/public/:file', serveAnyFile);

// A2 — Basic Auth
app.get('/files/protected/basic/:file', requireBasicAuth, serveAnyFile);

// A3 — Bearer Token
app.get('/files/protected/bearer/:file', requireBearerAuth, serveAnyFile);

// A4 — API Key
app.get('/files/protected/apikey/:file', requireApiKeyAuth, serveAnyFile);

// A5 — Custom Headers
app.get('/files/protected/custom/:file', requireCustomHeaders, serveAnyFile);

// A6 — Query Params auth
app.get('/files/protected/query/:file', requireQueryParams, serveAnyFile);

// A8 — 404 for missing file under /files/
app.get('/files/not-found.geojson', (req, res) => {
  res.status(404).json({ error: 'File not found: not-found.geojson' });
});

// =====================================================================
//  SECTION 9 — API SOURCE ENDPOINTS (/api/v1/*)
//  All API endpoints are registered under every auth prefix:
//    /api/v1/*              — no auth (backward compat)
//    /api/v1/basic/*        — Basic auth
//    /api/v1/bearer/*       — Bearer token
//    /api/v1/apikey/*       — API Key header
//    /api/v1/custom/*       — Custom headers
//    /api/v1/query/*        — Query params auth
// =====================================================================

function registerApiRoutes(prefix, middleware) {
  const mw = middleware ? [middleware] : [];

  // --- B1: Array + Offset + X/Y ---------------------------------------
  app.get(`${prefix}/points`, ...mw, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit  = parseInt(req.query.limit)  || 100;
    const page = apiPoints.slice(offset, offset + limit);
    res.json({
      success: true,
      total: apiPoints.length,
      result: { records: page },
    });
  });

  // --- B2: GeoJSON + Page number --------------------------------------
  app.get(`${prefix}/parcels`, ...mw, (req, res) => {
    const pageNum  = parseInt(req.query.page)     || 1;
    const pageSize = parseInt(req.query.pageSize)  || 50;
    const start = (pageNum - 1) * pageSize;
    const page = apiParcels.slice(start, start + pageSize);
    const totalPages = Math.ceil(apiParcels.length / pageSize);
    res.json({
      data: {
        type: 'FeatureCollection',
        features: page,
      },
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalCount: apiParcels.length,
      },
    });
  });

  // --- B3: Object + No pagination -------------------------------------
  app.get(`${prefix}/config/zones`, ...mw, (req, res) => {
    res.json({ zones: apiZones });
  });

  // --- B4: WKT + Offset -----------------------------------------------
  app.get(`${prefix}/roads`, ...mw, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit  = parseInt(req.query.limit)  || 200;
    const page = apiRoads.slice(offset, offset + limit);
    res.json({
      count: apiRoads.length,
      items: page,
    });
  });

  // --- B5: NextPage (full URL) ----------------------------------------
  app.get(`${prefix}/events`, ...mw, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const cursor = req.query.cursor;

    let offset = 0;
    if (cursor) {
      try { offset = JSON.parse(Buffer.from(cursor, 'base64').toString()).offset; } catch { offset = 0; }
    }

    const page = apiEvents.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    let next = null;
    if (nextOffset < apiEvents.length) {
      const nextCursor = Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64');
      const proto = req.protocol;
      const host = req.get('host');
      // Build next URL preserving the current prefix path
      const basePath = req.baseUrl + req.path; // e.g. /api/v1/events or /api/v1/bearer/events
      next = `${proto}://${host}${basePath}?cursor=${nextCursor}&limit=${limit}`;
    }

    res.json({ data: page, next });
  });

  // --- B6: NextPage (cursor token + nextPageParam) --------------------
  app.get(`${prefix}/buildings`, ...mw, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const afterCursor = req.query.after;

    let offset = 0;
    if (afterCursor) {
      try { offset = JSON.parse(Buffer.from(afterCursor, 'base64').toString()).offset; } catch { offset = 0; }
    }

    const page = apiBuildings.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    let cursor = null;
    if (nextOffset < apiBuildings.length) {
      cursor = Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64');
    }

    res.json({ results: page, cursor });
  });

  // --- B7: Secure locations + offset ----------------------------------
  app.get(`${prefix}/secure/locations`, ...mw, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit  = parseInt(req.query.limit)  || 50;
    const page = apiSecureLocations.slice(offset, offset + limit);
    res.json({
      total: apiSecureLocations.length,
      data: page,
    });
  });

  // --- B8: Empty dataset ----------------------------------------------
  app.get(`${prefix}/empty`, ...mw, (req, res) => {
    res.json({ records: [] });
  });
}

// Register API routes: no-auth + all 5 auth types
registerApiRoutes('/api/v1',          null);
registerApiRoutes('/api/v1/basic',    requireBasicAuth);
registerApiRoutes('/api/v1/bearer',   requireBearerAuth);
registerApiRoutes('/api/v1/apikey',   requireApiKeyAuth);
registerApiRoutes('/api/v1/custom',   requireCustomHeaders);
registerApiRoutes('/api/v1/query',    requireQueryParams);

// --- B9: Rate-limit simulation (no auth variants — always at root) ----
const rateLimitState = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 5000;
const RATE_MAX_REQUESTS = 3;

app.get('/api/v1/ratelimited/data', (req, res) => {
  const key = req.ip;
  const now = Date.now();
  let entry = rateLimitState.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  rateLimitState.set(key, entry);

  if (entry.count > RATE_MAX_REQUESTS) {
    res.set('Retry-After', '2');
    return res.status(429).json({ error: 'Too Many Requests', retryAfter: 2 });
  }

  const offset = parseInt(req.query.offset) || 0;
  const limit  = parseInt(req.query.limit)  || 100;
  const page = apiRateLimitedData.slice(offset, offset + limit);
  res.json({
    total: apiRateLimitedData.length,
    data: page,
  });
});

// =====================================================================
//  SECTION 10 — ERROR CASE ENDPOINTS (Spec section C)
// =====================================================================

// 404 — missing file
app.get('/files/:any', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.params.any}` });
});

// 500 — server error
app.get('/api/v1/server-error', (req, res) => {
  res.status(500).json({ error: 'Internal Server Error — simulated for testing' });
});

// Timeout — hang for 70 seconds
app.get('/api/v1/timeout', (req, res) => {
  console.log('  ⏳ /api/v1/timeout — hanging for 70s...');
  setTimeout(() => {
    res.json({ message: 'Response after 70s delay' });
  }, 70000);
});

// Malformed JSON — returns invalid JSON with 200
app.get('/api/v1/malformed', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.status(200).send('{invalid json: not valid, missing quotes [}');
});

// =====================================================================
//  SECTION 11 — LEGACY EDGE CASES
// =====================================================================

// Slow response (5s delay)
app.get('/slow/:file', (req, res) => {
  console.log('  ⏳ Delaying response by 5 seconds...');
  setTimeout(() => {
    const filePath = path.join(DATA_DIR, req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath);
  }, 5000);
});

// Large CSV (~50MB) streamed on-the-fly
app.get('/large/data.csv', (req, res) => {
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="large-data.csv"');
  res.write('id,name,x,y,value\n');
  const TARGET_BYTES = 50 * 1024 * 1024;
  let written = 0;
  let id = 1;
  const names = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth', 'Eilat', 'Ashdod', 'Netanya'];
  function writeChunk() {
    let ok = true;
    while (written < TARGET_BYTES && ok) {
      const name = names[id % names.length];
      const x = 160000 + Math.floor(Math.random() * 80000);
      const y = 530000 + Math.floor(Math.random() * 250000);
      const value = Math.floor(Math.random() * 1000);
      const line = `${id},${name},${x},${y},${value}\n`;
      ok = res.write(line);
      written += line.length;
      id++;
    }
    if (written < TARGET_BYTES) {
      res.once('drain', writeChunk);
    } else {
      res.end();
      console.log(`  📦 Streamed large CSV: ${(written / 1024 / 1024).toFixed(1)} MB, ${id - 1} rows`);
    }
  }
  writeChunk();
});

// Redirect
app.get('/redirect/:file', (req, res) => {
  res.redirect(302, `/public/${req.params.file}`);
});

// Errors (legacy)
app.get('/404', (req, res) => {
  res.status(404).json({ error: 'Not Found — this endpoint always returns 404' });
});
app.get('/500', (req, res) => {
  res.status(500).json({ error: 'Internal Server Error — this endpoint always returns 500' });
});

// Zip without Range
app.get('/no-range/archive.zip', (req, res) => {
  res.set('Accept-Ranges', 'none');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="archive.zip"');
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => res.status(500).json({ error: err.message }));
  archive.pipe(res);
  archive.file(path.join(DATA_DIR, 'points.geojson'), { name: 'points.geojson' });
  archive.finalize();
});

// =====================================================================
//  SECTION 12 — INDEX PAGE
// =====================================================================

app.get('/', (req, res) => {
  const fileRows = Object.entries(ALL_FILES).map(([dt, f]) => {
    const exists = fs.existsSync(path.join(DATA_DIR, f));
    const status = exists ? '✓' : '✗ (run generate-data.js)';
    return `<tr><td>${dt}</td><td><a href="/public/${f}">/public/${f}</a></td><td>${status}</td></tr>`;
  }).join('\n    ');

  const authRows = Object.entries(ALL_FILES).map(([dt, f]) => `
    <tr>
      <td>${dt}</td>
      <td><a href="/public/${f}">/public/${f}</a></td>
      <td>/basic/${f}</td>
      <td>/token/${f}</td>
      <td>/headers/${f}</td>
      <td><a href="/query/${f}?token=my-query-token">/query/${f}?token=...</a></td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Auto-Update Layers — Test Server</title>
  <style>
    body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; max-width: 1400px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #569cd6; }
    h2 { color: #4ec9b0; margin-top: 30px; }
    h3 { color: #dcdcaa; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    th, td { text-align: left; padding: 6px 10px; border: 1px solid #444; }
    th { background: #333; color: #9cdcfe; }
    a { color: #ce9178; }
    code { color: #d7ba7d; background: #333; padding: 2px 6px; border-radius: 3px; }
    pre { background: #2d2d2d; padding: 12px; border-radius: 4px; overflow-x: auto; }
    .section { margin: 20px 0; padding: 15px; border: 1px solid #333; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Auto-Update Layers — Test Server</h1>
  <p>Serves HTTP file downloads and paginated API endpoints for testing <code>sourceType=http</code> and <code>sourceType=api</code>.</p>

  <!-- ═══ HTTP SOURCE — NEW ENDPOINTS ═══ -->
  <h2>A. HTTP Source — File Download (NEW)</h2>
  <table>
    <tr><th>Endpoint</th><th>Auth</th><th>Credentials</th></tr>
    <tr><td><a href="/files/public/points.geojson">/files/public/:file</a></td><td>None</td><td>—</td></tr>
    <tr><td>/files/protected/basic/:file</td><td>Basic</td><td>testuser:testpass</td></tr>
    <tr><td>/files/protected/bearer/:file</td><td>Bearer</td><td>my-secret-token-123</td></tr>
    <tr><td>/files/protected/apikey/:file</td><td>API Key</td><td>X-API-Key: test-api-key-456</td></tr>
    <tr><td>/files/protected/custom/:file</td><td>Custom Headers</td><td>X-Custom-Auth: custom-value-1, X-Workspace-Id: workspace-abc</td></tr>
    <tr><td>/files/protected/query/:file?token=secret-query-token&amp;workspace=ws1</td><td>Query Params</td><td>token=secret-query-token, workspace=ws1</td></tr>
    <tr><td><a href="/files/public/large-dataset.geojson">/files/public/large-dataset.geojson</a></td><td>None</td><td>~110 MB streamed GeoJSON</td></tr>
  </table>

  <!-- ═══ API SOURCE ═══ -->
  <h2>B. API Source — Paginated REST Endpoints</h2>
  <p>Every API endpoint is available under all auth prefixes:</p>
  <table>
    <tr><th>Auth</th><th>Prefix</th><th>Credentials</th></tr>
    <tr><td>None</td><td><code>/api/v1/*</code></td><td>—</td></tr>
    <tr><td>Basic</td><td><code>/api/v1/basic/*</code></td><td>testuser:testpass</td></tr>
    <tr><td>Bearer</td><td><code>/api/v1/bearer/*</code></td><td>my-secret-token-123</td></tr>
    <tr><td>API Key</td><td><code>/api/v1/apikey/*</code></td><td>X-API-Key: test-api-key-456</td></tr>
    <tr><td>Custom Headers</td><td><code>/api/v1/custom/*</code></td><td>X-Custom-Auth: custom-value-1, X-Workspace-Id: workspace-abc</td></tr>
    <tr><td>Query Params</td><td><code>/api/v1/query/*</code></td><td>?token=secret-query-token&amp;workspace=ws1</td></tr>
  </table>

  <h3>Endpoint Matrix (rows = endpoints, columns = auth)</h3>
  <table>
    <tr><th>Endpoint</th><th>Format</th><th>Geometry</th><th>Pagination</th><th>Records</th><th>None</th><th>Basic</th><th>Bearer</th><th>ApiKey</th><th>Custom</th><th>Query</th></tr>
    <tr><td>points</td><td>array</td><td>X/Y</td><td>offset</td><td>${apiPoints.length}</td>
        <td><a href="/api/v1/points?offset=0&limit=5">/api/v1/points</a></td>
        <td>/api/v1/basic/points</td><td>/api/v1/bearer/points</td><td>/api/v1/apikey/points</td><td>/api/v1/custom/points</td><td>/api/v1/query/points</td></tr>
    <tr><td>parcels</td><td>geojson</td><td>geom</td><td>pageNumber</td><td>${apiParcels.length}</td>
        <td><a href="/api/v1/parcels?page=1&pageSize=5">/api/v1/parcels</a></td>
        <td>/api/v1/basic/parcels</td><td>/api/v1/bearer/parcels</td><td>/api/v1/apikey/parcels</td><td>/api/v1/custom/parcels</td><td>/api/v1/query/parcels</td></tr>
    <tr><td>config/zones</td><td>object</td><td>X/Y</td><td>none</td><td>${Object.keys(apiZones).length}</td>
        <td><a href="/api/v1/config/zones">/api/v1/config/zones</a></td>
        <td>/api/v1/basic/config/zones</td><td>/api/v1/bearer/config/zones</td><td>/api/v1/apikey/config/zones</td><td>/api/v1/custom/config/zones</td><td>/api/v1/query/config/zones</td></tr>
    <tr><td>roads</td><td>array</td><td>WKT</td><td>offset</td><td>${apiRoads.length}</td>
        <td><a href="/api/v1/roads?offset=0&limit=5">/api/v1/roads</a></td>
        <td>/api/v1/basic/roads</td><td>/api/v1/bearer/roads</td><td>/api/v1/apikey/roads</td><td>/api/v1/custom/roads</td><td>/api/v1/query/roads</td></tr>
    <tr><td>events</td><td>array</td><td>X/Y</td><td>nextPage (URL)</td><td>${apiEvents.length}</td>
        <td><a href="/api/v1/events?limit=5">/api/v1/events</a></td>
        <td>/api/v1/basic/events</td><td>/api/v1/bearer/events</td><td>/api/v1/apikey/events</td><td>/api/v1/custom/events</td><td>/api/v1/query/events</td></tr>
    <tr><td>buildings</td><td>array</td><td>geom</td><td>nextPage (cursor)</td><td>${apiBuildings.length}</td>
        <td><a href="/api/v1/buildings?limit=5">/api/v1/buildings</a></td>
        <td>/api/v1/basic/buildings</td><td>/api/v1/bearer/buildings</td><td>/api/v1/apikey/buildings</td><td>/api/v1/custom/buildings</td><td>/api/v1/query/buildings</td></tr>
    <tr><td>secure/locations</td><td>array</td><td>X/Y</td><td>offset</td><td>${apiSecureLocations.length}</td>
        <td><a href="/api/v1/secure/locations?offset=0&limit=5">/api/v1/secure/locations</a></td>
        <td>/api/v1/basic/secure/locations</td><td>/api/v1/bearer/secure/locations</td><td>/api/v1/apikey/secure/locations</td><td>/api/v1/custom/secure/locations</td><td>/api/v1/query/secure/locations</td></tr>
    <tr><td>empty</td><td>array</td><td>—</td><td>none</td><td>0</td>
        <td><a href="/api/v1/empty">/api/v1/empty</a></td>
        <td>/api/v1/basic/empty</td><td>/api/v1/bearer/empty</td><td>/api/v1/apikey/empty</td><td>/api/v1/custom/empty</td><td>/api/v1/query/empty</td></tr>
    <tr><td colspan="5">ratelimited/data (no auth variants)</td>
        <td colspan="6"><a href="/api/v1/ratelimited/data?offset=0&limit=10">/api/v1/ratelimited/data</a> — 429 after ${RATE_MAX_REQUESTS} rapid requests</td></tr>
  </table>

  <!-- ═══ ERROR CASES ═══ -->
  <h2>C. Error Cases</h2>
  <table>
    <tr><th>Endpoint</th><th>Response</th></tr>
    <tr><td><a href="/files/not-found.geojson">/files/not-found.geojson</a></td><td>404</td></tr>
    <tr><td>/files/protected/basic/data.zip (no auth)</td><td>401</td></tr>
    <tr><td><a href="/api/v1/server-error">/api/v1/server-error</a></td><td>500</td></tr>
    <tr><td><a href="/api/v1/timeout">/api/v1/timeout</a></td><td>Hangs 70s</td></tr>
    <tr><td><a href="/api/v1/malformed">/api/v1/malformed</a></td><td>200 with invalid JSON</td></tr>
  </table>

  <!-- ═══ LEGACY ROUTES ═══ -->
  <h2>Legacy — File Downloads (backward compatible)</h2>
  <table>
    <tr><th>DataType</th><th>Public</th><th>Basic</th><th>Bearer</th><th>API Key</th><th>Query</th></tr>
    ${authRows}
  </table>
  <h3>Legacy Credentials</h3>
  <pre>
Basic Auth    →  testuser:testpass
Bearer Token  →  test-token-123
API Key       →  X-Api-Key: my-secret-key
Query Param   →  ?token=my-query-token</pre>

  <h2>Legacy Edge Cases</h2>
  <table>
    <tr><th>Endpoint</th><th>Behaviour</th></tr>
    <tr><td><a href="/slow/points.geojson">/slow/:file</a></td><td>5-second delay</td></tr>
    <tr><td><a href="/large/data.csv">/large/data.csv</a></td><td>~50 MB CSV streamed</td></tr>
    <tr><td><a href="/redirect/points.geojson">/redirect/:file</a></td><td>302 → /public/:file</td></tr>
    <tr><td><a href="/404">/404</a></td><td>404</td></tr>
    <tr><td><a href="/500">/500</a></td><td>500</td></tr>
    <tr><td><a href="/no-range/archive.zip">/no-range/archive.zip</a></td><td>Zip without Range</td></tr>
  </table>

  <h2>API Config Examples</h2>
  <pre>
B1 /api/v1/points       → { dataFormat:"array",   dataPath:"result.records", geometryType:"xy", xField:"lon", yField:"lat", paginationType:"offset",     pageSize:100, totalCountPath:"total" }
B2 /api/v1/parcels      → { dataFormat:"geojson",  dataPath:"data.features",  geometryType:"geom",                          paginationType:"pageNumber",  pageSize:50,  totalCountPath:"pagination.totalCount" }
B3 /api/v1/config/zones → { dataFormat:"object",   dataPath:"zones",          geometryType:"xy", xField:"x", yField:"y",    paginationType:"none" }
B4 /api/v1/roads        → { dataFormat:"array",   dataPath:"items",           geometryType:"wkt", wktField:"geom_wkt",      paginationType:"offset",     pageSize:200, totalCountPath:"count" }
B5 /api/v1/events       → { dataFormat:"array",   dataPath:"data",            geometryType:"xy", xField:"longitude", yField:"latitude", paginationType:"nextPage", pageSize:100, nextPagePath:"next" }
B6 /api/v1/buildings    → { dataFormat:"array",   dataPath:"results",         geometryType:"geom", geomField:"geometry",    paginationType:"nextPage", pageSize:100, nextPagePath:"cursor", nextPageParam:"after" }
B7 /api/v1/secure/loc.  → { dataFormat:"array",   dataPath:"data",            geometryType:"xy", xField:"x", yField:"y",    paginationType:"offset",     pageSize:50,  totalCountPath:"total" }
B8 /api/v1/empty        → { dataFormat:"array",   dataPath:"records",         geometryType:"xy", xField:"x", yField:"y",    paginationType:"none" }
  </pre>
</body>
</html>`);
});

// =====================================================================
//  SECTION 13 — STARTUP DATA GENERATION
// =====================================================================

function runCmd(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true; } catch { return false; }
}

function zipFilesAsync(files, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const arch = archiver('zip', { zlib: { level: 5 } });
    output.on('close', resolve);
    arch.on('error', reject);
    arch.pipe(output);
    for (const f of files) { if (fs.existsSync(f)) arch.file(f, { name: path.basename(f) }); }
    arch.finalize();
  });
}

function zipFolderAsync(sourceDir, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const arch = archiver('zip', { zlib: { level: 5 } });
    output.on('close', resolve);
    arch.on('error', reject);
    arch.pipe(output);
    arch.directory(sourceDir, path.basename(sourceDir));
    arch.finalize();
  });
}

async function generateAllData() {
  console.log('');
  console.log('── Generating data at startup ──');

  const GEOJSON = path.join(DATA_DIR, 'points.geojson');

  // ── XLSX ──
  try {
    const XLSX = require('xlsx');
    const rows = [
      ['name', 'x', 'y', 'value'],
      ['Tel Aviv', 171750, 631750, 100],
      ['Jerusalem', 219540, 626540, 200],
      ['Haifa', 198100, 743500, 150],
      ['Beer Sheva', 166260, 547260, 80],
      ['Nazareth', 222500, 730000, 60],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'data');
    XLSX.writeFile(wb, path.join(DATA_DIR, 'data.xlsx'));
    console.log('  ✓ data.xlsx');
  } catch (err) {
    console.warn('  ⚠ data.xlsx failed:', err.message);
  }

  // ── ogr2ogr binary formats ──
  let hasOgr = false;
  try { execSync('ogr2ogr --version', { stdio: 'pipe' }); hasOgr = true; console.log('  ✓ ogr2ogr found'); }
  catch { console.warn('  ⚠ ogr2ogr not found — SHP, GPKG, GDB will be skipped'); }

  if (hasOgr && fs.existsSync(GEOJSON)) {
    // Shapefile
    const shpDir = path.join(DATA_DIR, '_shp_tmp');
    if (fs.existsSync(shpDir)) fs.rmSync(shpDir, { recursive: true });
    fs.mkdirSync(shpDir, { recursive: true });
    if (runCmd(`ogr2ogr -f "ESRI Shapefile" "${path.join(shpDir, 'data.shp')}" "${GEOJSON}"`)) {
      await zipFilesAsync(fs.readdirSync(shpDir).map(f => path.join(shpDir, f)), path.join(DATA_DIR, 'data.shp.zip'));
      console.log('  ✓ data.shp.zip');
    }
    fs.rmSync(shpDir, { recursive: true, force: true });

    // GeoPackage
    const gpkg = path.join(DATA_DIR, 'data.gpkg');
    if (fs.existsSync(gpkg)) fs.unlinkSync(gpkg);
    if (runCmd(`ogr2ogr -f "GPKG" "${gpkg}" "${GEOJSON}"`)) console.log('  ✓ data.gpkg');

    // File GDB
    const gdbDir = path.join(DATA_DIR, 'data.gdb');
    if (fs.existsSync(gdbDir)) fs.rmSync(gdbDir, { recursive: true });
    if (runCmd(`ogr2ogr -f "OpenFileGDB" "${gdbDir}" "${GEOJSON}"`)) {
      await zipFolderAsync(gdbDir, path.join(DATA_DIR, 'data.gdb.zip'));
      console.log('  ✓ data.gdb.zip');
      fs.rmSync(gdbDir, { recursive: true, force: true });
    }

    // Parcels shapefile (EPSG:2039) if parcels-src.geojson exists
    const parcelsSrc = path.join(DATA_DIR, 'parcels-src.geojson');
    if (fs.existsSync(parcelsSrc)) {
      const pDir = path.join(DATA_DIR, '_parcels_tmp');
      if (fs.existsSync(pDir)) fs.rmSync(pDir, { recursive: true });
      fs.mkdirSync(pDir, { recursive: true });
      if (runCmd(`ogr2ogr -f "ESRI Shapefile" -t_srs EPSG:2039 "${path.join(pDir, 'parcels.shp')}" "${parcelsSrc}"`)) {
        await zipFilesAsync(fs.readdirSync(pDir).map(f => path.join(pDir, f)), path.join(DATA_DIR, 'parcels.zip'));
        console.log('  ✓ parcels.zip');
      }
      fs.rmSync(pDir, { recursive: true, force: true });
    }

    // Buildings GeoPackage
    const bldgSrc = path.join(DATA_DIR, 'buildings.geojson');
    if (fs.existsSync(bldgSrc)) {
      const bldgGpkg = path.join(DATA_DIR, 'buildings.gpkg');
      if (fs.existsSync(bldgGpkg)) fs.unlinkSync(bldgGpkg);
      if (runCmd(`ogr2ogr -f "GPKG" "${bldgGpkg}" "${bldgSrc}"`)) console.log('  ✓ buildings.gpkg');
    }
  }

  // ── layers.zip ──
  const zonesFile = path.join(DATA_DIR, 'zones.geojson');
  if (fs.existsSync(zonesFile) && !fs.existsSync(path.join(DATA_DIR, 'layers.zip'))) {
    await zipFilesAsync([zonesFile], path.join(DATA_DIR, 'layers.zip'));
    console.log('  ✓ layers.zip');
  }

  // ── Generate in-memory API datasets ──
  console.log('  Generating in-memory API datasets...');
  apiPoints           = generateApiPoints(350);
  apiParcels          = generateApiParcels(230);
  apiZones            = generateApiZones();
  apiRoads            = generateApiRoads(1500);
  apiEvents           = generateApiEvents(300);
  apiBuildings        = generateApiBuildings(500);
  apiSecureLocations  = generateApiSecureLocations(120);
  apiRateLimitedData  = generateRateLimitedData(200);
  console.log(`  ✓ points=${apiPoints.length} parcels=${apiParcels.length} zones=${Object.keys(apiZones).length} roads=${apiRoads.length} events=${apiEvents.length} buildings=${apiBuildings.length} secureLocations=${apiSecureLocations.length}`);

  // ── Generate GDB file for each API layer ──
  if (hasOgr) {
    console.log('  Generating GDB files for API layers...');

    // Helper: convert API dataset to GeoJSON FeatureCollection, write to temp file, convert to GDB zip
    async function apiToGdb(name, features) {
      const fc = { type: 'FeatureCollection', features };
      const tmpGeojson = path.join(DATA_DIR, `_api_${name}.geojson`);
      fs.writeFileSync(tmpGeojson, JSON.stringify(fc));

      const gdbDir = path.join(DATA_DIR, `api-${name}.gdb`);
      if (fs.existsSync(gdbDir)) fs.rmSync(gdbDir, { recursive: true });
      if (runCmd(`ogr2ogr -f "OpenFileGDB" "${gdbDir}" "${tmpGeojson}"`)) {
        const outZip = path.join(DATA_DIR, `api-${name}.gdb.zip`);
        await zipFolderAsync(gdbDir, outZip);
        console.log(`  ✓ api-${name}.gdb.zip`);
        fs.rmSync(gdbDir, { recursive: true, force: true });
      }
      fs.unlinkSync(tmpGeojson);
    }

    // points — X/Y → Point
    await apiToGdb('points', apiPoints.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id, name: p.name, category: p.category },
    })));

    // parcels — already GeoJSON features (Polygon)
    await apiToGdb('parcels', apiParcels);

    // zones — object with X/Y → Point
    await apiToGdb('zones', Object.entries(apiZones).map(([key, z]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [z.x, z.y] },
      properties: { zone_id: key, name: z.name, maxHeight: z.maxHeight },
    })));

    // roads — WKT linestrings → parse to GeoJSON LineString
    await apiToGdb('roads', apiRoads.map(r => {
      // Parse "LINESTRING(x1 y1, x2 y2, ...)" to coordinates array
      const coordStr = r.geom_wkt.replace('LINESTRING(', '').replace(')', '');
      const coords = coordStr.split(', ').map(pair => {
        const [x, y] = pair.split(' ').map(Number);
        return [x, y];
      });
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { road_id: r.road_id, road_name: r.road_name, lanes: r.lanes },
      };
    }));

    // events — X/Y → Point
    await apiToGdb('events', apiEvents.map(e => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.longitude, e.latitude] },
      properties: { event_id: e.event_id, title: e.title },
    })));

    // buildings — already have GeoJSON geometry
    await apiToGdb('buildings', apiBuildings.map(b => ({
      type: 'Feature',
      geometry: b.geometry,
      properties: { id: b.id, address: b.address },
    })));

    // secure/locations — X/Y → Point
    await apiToGdb('locations', apiSecureLocations.map(l => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.x, l.y] },
      properties: { loc_id: l.loc_id, status: l.status },
    })));
  }

  console.log('');
}

// =====================================================================
//  SECTION 14 — START (HTTP + HTTPS)
// =====================================================================

async function start() {
  await generateAllData();

  // Check which files exist
  const present = [];
  const missing = [];
  for (const [dt, f] of Object.entries(ALL_FILES)) {
    (fs.existsSync(path.join(DATA_DIR, f)) ? present : missing).push(`${dt} (${f})`);
  }

  // ── HTTP Server ──
  http.createServer(app).listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  HTTP  → http://localhost:${PORT}`);
  });

  // ── HTTPS Server (self-signed cert) ──
  try {
    const selfsigned = require('selfsigned');
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      {
        algorithm: 'sha256',
        days: 365,
        keySize: 2048,
        extensions: [
          { name: 'subjectAltName', altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ]},
        ],
      }
    );
    https.createServer({ key: pems.private, cert: pems.cert }, app).listen(HTTPS_PORT, () => {
      console.log(`  HTTPS → https://localhost:${HTTPS_PORT}`);
      console.log('═══════════════════════════════════════════════════════════════════');
    });
  } catch (err) {
    console.warn(`  ⚠ HTTPS disabled (selfsigned not installed): ${err.message}`);
    console.log('═══════════════════════════════════════════════════════════════════');
  }

  console.log('');
  console.log('Files present:');
  for (const f of present) console.log(`  ✓ ${f}`);
  if (missing.length) {
    console.log('Files MISSING:');
    for (const f of missing) console.log(`  ✗ ${f}`);
  }

  console.log('');
  console.log('Credentials (NEW — /files/protected/*):');
  console.log('  Basic Auth      →  testuser:testpass');
  console.log('  Bearer Token    →  my-secret-token-123');
  console.log('  API Key         →  X-API-Key: test-api-key-456');
  console.log('  Custom Headers  →  X-Custom-Auth: custom-value-1 + X-Workspace-Id: workspace-abc');
  console.log('  Query Params    →  ?token=secret-query-token&workspace=ws1');
  console.log('  Secure API      →  Bearer test-bearer-token-789');
  console.log('');
  console.log('Credentials (LEGACY — /basic, /token, /headers, /query):');
  console.log('  Basic Auth      →  testuser:testpass');
  console.log('  Bearer Token    →  test-token-123');
  console.log('  API Key         →  X-Api-Key: my-secret-key');
  console.log('  Query Param     →  ?token=my-query-token');
  console.log('');
  console.log('API Endpoints:');
  console.log(`  /api/v1/points           → ${apiPoints.length} records  (offset pagination, X/Y)`);
  console.log(`  /api/v1/parcels          → ${apiParcels.length} features (page-number, GeoJSON polygons)`);
  console.log(`  /api/v1/config/zones     → ${Object.keys(apiZones).length} zones    (no pagination, object format)`);
  console.log(`  /api/v1/roads            → ${apiRoads.length} records (offset, WKT linestrings)`);
  console.log(`  /api/v1/events           → ${apiEvents.length} records (nextPage URL, X/Y)`);
  console.log(`  /api/v1/buildings        → ${apiBuildings.length} records (nextPage cursor, GeoJSON points)`);
  console.log(`  /api/v1/secure/locations  → ${apiSecureLocations.length} records (offset, auth required)`);
  console.log(`  /api/v1/empty            → 0 records  (empty dataset test)`);
  console.log(`  /api/v1/ratelimited/data → 429 after ${RATE_MAX_REQUESTS} rapid requests`);
  console.log(`  /api/v1/server-error     → 500`);
  console.log(`  /api/v1/timeout          → hangs 70s`);
  console.log(`  /api/v1/malformed        → invalid JSON`);
  console.log('');
  console.log(`Open http://localhost:${PORT} for full endpoint list.`);
  console.log('');
}

start().catch(console.error);
