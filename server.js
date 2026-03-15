const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = 3333;
const DATA_DIR = path.join(__dirname, 'test-data');

// =====================================================================
//  DATA FILES — one per DataType
// =====================================================================
//  DataType        File                       Notes
//  ─────────────── ────────────────────────── ──────────────────────────
//  GEOJSON         points.geojson             WGS84 point features
//  CSV             data.csv                   x,y columns (EPSG:2039)
//  TXT             data.txt                   tab-delimited, x,y columns
//  XLSX            data.xlsx                  x,y columns (generated)
//  GPX             data.gpx                   GPX waypoints (WGS84)
//  XML             data.xml                   GML (WGS84 points)
//  JSON            data.json                  array with wkt column
//  SHP             data.shp.zip               zipped shapefile
//  GPKG            data.gpkg                  GeoPackage (binary)
//  GDB             data.gdb.zip               zipped File Geodatabase
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

// ─── Logging middleware ──────────────────────────────────────────────
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
      `${icon}  ${req.method.padEnd(6)} ${req.originalUrl.padEnd(50)} → ${res.statusCode}  (${ms}ms)  auth=${masked}`
    );
  });
  next();
});

// ─── Auth helpers ────────────────────────────────────────────────────
const BASIC_USER = 'testuser';
const BASIC_PASS = 'testpass';
const BEARER_TOKEN = 'test-token-123';
const API_KEY = 'my-secret-key';
const QUERY_TOKEN = 'my-query-token';

function requireBasic(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    console.log('  ✗ AUTH FAIL: Missing or non-Basic Authorization header');
    res.set('WWW-Authenticate', 'Basic realm="test-server"');
    return res.status(401).json({ error: 'Basic auth required. Send: Authorization: Basic base64(testuser:testpass)' });
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, ...passParts] = decoded.split(':');
  const pass = passParts.join(':');
  if (user === BASIC_USER && pass === BASIC_PASS) {
    console.log('  ✓ AUTH OK: Basic auth accepted');
    return next();
  }
  console.log(`  ✗ AUTH FAIL: Bad credentials (got ${user}:***)`);
  res.set('WWW-Authenticate', 'Basic realm="test-server"');
  return res.status(401).json({ error: 'Invalid credentials' });
}

function requireBearer(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    console.log('  ✗ AUTH FAIL: Missing or non-Bearer Authorization header');
    return res.status(401).json({ error: 'Bearer token required. Send: Authorization: Bearer test-token-123' });
  }
  if (auth.split(' ')[1] === BEARER_TOKEN) {
    console.log('  ✓ AUTH OK: Bearer token accepted');
    return next();
  }
  console.log('  ✗ AUTH FAIL: Bad bearer token');
  return res.status(401).json({ error: 'Invalid bearer token' });
}

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] === API_KEY) {
    console.log('  ✓ AUTH OK: X-Api-Key accepted');
    return next();
  }
  console.log('  ✗ AUTH FAIL: Bad or missing X-Api-Key header');
  return res.status(403).json({ error: 'Custom header required. Send: X-Api-Key: my-secret-key' });
}

function requireQueryToken(req, res, next) {
  if (req.query.token === QUERY_TOKEN) {
    console.log('  ✓ AUTH OK: query token accepted');
    return next();
  }
  console.log('  ✗ AUTH FAIL: Bad or missing query token');
  return res.status(403).json({ error: 'Query param required: ?token=my-query-token' });
}

// ─── Serve helpers ───────────────────────────────────────────────────
function serveFile(filename) {
  return (req, res) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: `File not found: ${filename}. Run "node generate-data.js" first.` });
    return res.download(filePath);
  };
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

// ─── Register file routes for each auth prefix ──────────────────────
function registerFileRoutes(prefix, middleware) {
  const mw = middleware ? [middleware] : [];

  // Each DataType gets its own endpoint
  for (const [dataType, filename] of Object.entries(ALL_FILES)) {
    app.get(`${prefix}/${filename}`, ...mw, serveFile(filename));
  }

  // Also serve lines.geojson
  app.get(`${prefix}/lines.geojson`, ...mw, serveFile('lines.geojson'));

  // Zips
  app.get(`${prefix}/archive.zip`, ...mw, serveZip(['points.geojson'], 'archive.zip'));
  app.get(`${prefix}/large-archive.zip`, ...mw, serveZip(
    ['target.csv', 'other.csv', 'readme.csv'], 'large-archive.zip'
  ));
}

// =====================================================================
//  INDEX PAGE
// =====================================================================
app.get('/', (req, res) => {
  // Build file rows dynamically
  const fileRows = Object.entries(ALL_FILES).map(([dt, f]) => {
    const exists = fs.existsSync(path.join(DATA_DIR, f));
    const status = exists ? '✓' : '✗ (run generate-data.js)';
    return `<tr><td>${dt}</td><td><a href="/public/${f}">/public/${f}</a></td><td>${status}</td></tr>`;
  }).join('\n    ');

  // Build auth test rows
  const authRows = Object.entries(ALL_FILES).map(([dt, f]) => {
    return `
    <tr>
      <td>${dt}</td>
      <td><a href="/public/${f}">/public/${f}</a></td>
      <td>/basic/${f}</td>
      <td>/token/${f}</td>
      <td>/headers/${f}</td>
      <td><a href="/query/${f}?token=my-query-token">/query/${f}?token=...</a></td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>HTTP Source Test Server</title>
  <style>
    body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; max-width: 1300px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #569cd6; }
    h2 { color: #4ec9b0; margin-top: 30px; }
    h3 { color: #dcdcaa; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    th, td { text-align: left; padding: 6px 10px; border: 1px solid #444; }
    th { background: #333; color: #9cdcfe; }
    a { color: #ce9178; }
    code { color: #d7ba7d; background: #333; padding: 2px 6px; border-radius: 3px; }
    .ok { color: #6a9955; }
    .miss { color: #f44747; }
    pre { background: #2d2d2d; padding: 12px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>HTTP Source Test Server</h1>
  <p>Simulates all <code>DataType</code> + <code>AuthType</code> combinations for auto-update-layers testing.</p>

  <h2>Available Data Files</h2>
  <table>
    <tr><th>DataType</th><th>Public URL</th><th>Status</th></tr>
    ${fileRows}
  </table>

  <h2>Auth Types</h2>
  <h3>Credentials</h3>
  <pre>
Basic Auth    →  testuser:testpass  (base64: dGVzdHVzZXI6dGVzdHBhc3M=)
Bearer Token  →  test-token-123
API Key       →  X-Api-Key: my-secret-key
Query Param   →  ?token=my-query-token</pre>

  <h3>All Endpoints (every DataType × every AuthType)</h3>
  <table>
    <tr>
      <th>DataType</th>
      <th>none (1)</th>
      <th>basic (2)</th>
      <th>token (3)</th>
      <th>custom_headers (8)</th>
      <th>query_params (9)</th>
    </tr>
    ${authRows}
  </table>

  <h2>Edge Cases</h2>
  <table>
    <tr><th>Endpoint</th><th>Behaviour</th></tr>
    <tr><td><a href="/slow/points.geojson">/slow/points.geojson</a></td><td>5-second delay</td></tr>
    <tr><td><a href="/large/data.csv">/large/data.csv</a></td><td>~50 MB CSV streamed on-the-fly</td></tr>
    <tr><td><a href="/redirect/points.geojson">/redirect/points.geojson</a></td><td>302 → /public/points.geojson</td></tr>
    <tr><td><a href="/404">/404</a></td><td>Returns 404</td></tr>
    <tr><td><a href="/500">/500</a></td><td>Returns 500</td></tr>
    <tr><td><a href="/no-range/archive.zip">/no-range/archive.zip</a></td><td>Zip without Range support</td></tr>
  </table>

  <h2>Zip Archives (for targetFileName testing)</h2>
  <table>
    <tr><th>Endpoint</th><th>Contents</th><th>targetFileName</th></tr>
    <tr><td><a href="/public/archive.zip">/public/archive.zip</a></td><td>points.geojson</td><td>points.geojson</td></tr>
    <tr><td><a href="/public/large-archive.zip">/public/large-archive.zip</a></td><td>target.csv, other.csv, readme.csv</td><td>target.csv</td></tr>
  </table>

  <h2>Data Notes</h2>
  <ul>
    <li><b>CSV, TXT, XLSX</b> — have <code>x</code>, <code>y</code> columns in <b>EPSG:2039</b> (Israeli TM Grid)</li>
    <li><b>JSON</b> — has a <code>wkt</code> column with WKT geometry (e.g. <code>POINT (34.7818 32.0853)</code>)</li>
    <li><b>GEOJSON, GPX, XML (GML)</b> — WGS84 geometries</li>
    <li><b>SHP, GPKG, GDB</b> — binary formats, auto-generated at startup if ogr2ogr/GDAL is available</li>
  </ul>
</body>
</html>`);
});

// =====================================================================
//  REGISTER ALL ROUTES
// =====================================================================

// Public — AuthType.none (1)
registerFileRoutes('/public', null);

// Basic — AuthType.basic (2)
registerFileRoutes('/basic', requireBasic);

// Bearer Token — AuthType.token (3)
registerFileRoutes('/token', requireBearer);

// Custom Headers — AuthType.custom_headers (8)
registerFileRoutes('/headers', requireApiKey);

// Query Params — AuthType.query_params (9)
registerFileRoutes('/query', requireQueryToken);

// =====================================================================
//  EDGE CASES
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

// Errors
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
//  Generate ALL data files at startup
// =====================================================================
const { execSync } = require('child_process');

function runCmd(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function zipFilesSync(files, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const arch = archiver('zip', { zlib: { level: 5 } });
    output.on('close', resolve);
    arch.on('error', reject);
    arch.pipe(output);
    for (const f of files) {
      if (fs.existsSync(f)) arch.file(f, { name: path.basename(f) });
    }
    arch.finalize();
  });
}

function zipFolderSync(sourceDir, outZip) {
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
  console.log('── Generating test data at startup ──');

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

  // ── Check ogr2ogr ──
  let hasOgr = false;
  try {
    execSync('ogr2ogr --version', { stdio: 'pipe' });
    hasOgr = true;
    console.log('  ✓ ogr2ogr found');
  } catch {
    console.warn('  ⚠ ogr2ogr not found — SHP, GPKG, GDB will be skipped');
  }

  // ── Shapefile → zip ──
  if (hasOgr) {
    const shpDir = path.join(DATA_DIR, '_shp_tmp');
    if (fs.existsSync(shpDir)) fs.rmSync(shpDir, { recursive: true });
    fs.mkdirSync(shpDir, { recursive: true });
    const shpPath = path.join(shpDir, 'data.shp');
    if (runCmd(`ogr2ogr -f "ESRI Shapefile" "${shpPath}" "${GEOJSON}"`)) {
      const parts = fs.readdirSync(shpDir).map(f => path.join(shpDir, f));
      await zipFilesSync(parts, path.join(DATA_DIR, 'data.shp.zip'));
      console.log('  ✓ data.shp.zip');
    }
    fs.rmSync(shpDir, { recursive: true, force: true });
  }

  // ── GeoPackage ──
  if (hasOgr) {
    const gpkgPath = path.join(DATA_DIR, 'data.gpkg');
    if (fs.existsSync(gpkgPath)) fs.unlinkSync(gpkgPath);
    if (runCmd(`ogr2ogr -f "GPKG" "${gpkgPath}" "${GEOJSON}"`)) {
      console.log('  ✓ data.gpkg');
    }
  }

  // ── File GDB → zip ──
  if (hasOgr) {
    const gdbDir = path.join(DATA_DIR, 'data.gdb');
    if (fs.existsSync(gdbDir)) fs.rmSync(gdbDir, { recursive: true });
    if (runCmd(`ogr2ogr -f "OpenFileGDB" "${gdbDir}" "${GEOJSON}"`)) {
      await zipFolderSync(gdbDir, path.join(DATA_DIR, 'data.gdb.zip'));
      console.log('  ✓ data.gdb.zip');
      fs.rmSync(gdbDir, { recursive: true, force: true });
    }
  }

  console.log('');
}

// =====================================================================
//  Start
// =====================================================================
async function start() {
  await generateAllData();

  // Check which files exist
  const present = [];
  const missing = [];
  for (const [dt, f] of Object.entries(ALL_FILES)) {
    (fs.existsSync(path.join(DATA_DIR, f)) ? present : missing).push(`${dt} (${f})`);
  }

  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  HTTP Source Test Server running on http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');

    console.log('Files present:');
    for (const f of present) console.log(`  ✓ ${f}`);
    if (missing.length) {
      console.log('Files MISSING (ogr2ogr not available):');
      for (const f of missing) console.log(`  ✗ ${f}`);
    }

    console.log('');
    console.log('Credentials:');
    console.log(`  Basic Auth   →  testuser:testpass  (base64: dGVzdHVzZXI6dGVzdHBhc3M=)`);
    console.log(`  Bearer Token →  test-token-123`);
    console.log(`  API Key      →  X-Api-Key: my-secret-key`);
    console.log(`  Query Param  →  ?token=my-query-token`);
    console.log('');
    console.log('Test Matrix (for backoffice UI):');
    console.log('┌───────────────────┬────────────┬──────────────────┬──────────────────────────────────────────────────────────────────────┬─────────────────┬──────────┐');
    console.log('│ Test              │ sourceType │ authType         │ sourceUrl                                                            │ targetFileName  │ dataType │');
    console.log('├───────────────────┼────────────┼──────────────────┼──────────────────────────────────────────────────────────────────────┼─────────────────┼──────────┤');
    console.log('│ GeoJSON           │ http (7)   │ none (1)         │ http://localhost:3333/public/points.geojson                          │ —               │ GEOJSON  │');
    console.log('│ CSV (x,y)         │ http (7)   │ none (1)         │ http://localhost:3333/public/data.csv                                │ —               │ CSV      │');
    console.log('│ TXT (x,y)         │ http (7)   │ none (1)         │ http://localhost:3333/public/data.txt                                │ —               │ TXT      │');
    console.log('│ XLSX (x,y)        │ http (7)   │ none (1)         │ http://localhost:3333/public/data.xlsx                               │ —               │ XLSX     │');
    console.log('│ GPX               │ http (7)   │ none (1)         │ http://localhost:3333/public/data.gpx                                │ —               │ GPX      │');
    console.log('│ XML (GML)         │ http (7)   │ none (1)         │ http://localhost:3333/public/data.xml                                │ —               │ XML      │');
    console.log('│ JSON (wkt)        │ http (7)   │ none (1)         │ http://localhost:3333/public/data.json                               │ —               │ JSON     │');
    console.log('│ SHP (zip)         │ http (7)   │ none (1)         │ http://localhost:3333/public/data.shp.zip                            │ —               │ SHP      │');
    console.log('│ GPKG              │ http (7)   │ none (1)         │ http://localhost:3333/public/data.gpkg                               │ —               │ GPKG     │');
    console.log('│ GDB (zip)         │ http (7)   │ none (1)         │ http://localhost:3333/public/data.gdb.zip                            │ —               │ GDB      │');
    console.log('│ Zip (geojson)     │ http (7)   │ none (1)         │ http://localhost:3333/public/archive.zip                             │ points.geojson  │ GEOJSON  │');
    console.log('│ Zip (multi)       │ http (7)   │ none (1)         │ http://localhost:3333/public/large-archive.zip                       │ target.csv      │ CSV      │');
    console.log('├───────────────────┼────────────┼──────────────────┼──────────────────────────────────────────────────────────────────────┼─────────────────┼──────────┤');
    console.log('│ Basic Auth        │ http (7)   │ basic (2)        │ http://localhost:3333/basic/points.geojson                           │ —               │ GEOJSON  │');
    console.log('│ Bearer Token      │ http (7)   │ token (3)        │ http://localhost:3333/token/points.geojson                           │ —               │ GEOJSON  │');
    console.log('│ Custom Headers    │ http (7)   │ custom_headers(8)│ http://localhost:3333/headers/points.geojson                         │ —               │ GEOJSON  │');
    console.log('│ Query Params      │ http (7)   │ query_params (9) │ http://localhost:3333/query/points.geojson?token=my-query-token      │ —               │ GEOJSON  │');
    console.log('├───────────────────┼────────────┼──────────────────┼──────────────────────────────────────────────────────────────────────┼─────────────────┼──────────┤');
    console.log('│ Zip no-range      │ http (7)   │ none (1)         │ http://localhost:3333/no-range/archive.zip                           │ points.geojson  │ GEOJSON  │');
    console.log('│ Slow (5s)         │ http (7)   │ none (1)         │ http://localhost:3333/slow/points.geojson                            │ —               │ GEOJSON  │');
    console.log('│ Large CSV (50MB)  │ http (7)   │ none (1)         │ http://localhost:3333/large/data.csv                                 │ —               │ CSV      │');
    console.log('│ Redirect          │ http (7)   │ none (1)         │ http://localhost:3333/redirect/points.geojson                        │ —               │ GEOJSON  │');
    console.log('│ 404 Error         │ http (7)   │ none (1)         │ http://localhost:3333/404                                            │ —               │ —        │');
    console.log('│ 500 Error         │ http (7)   │ none (1)         │ http://localhost:3333/500                                            │ —               │ —        │');
    console.log('└───────────────────┴────────────┴──────────────────┴──────────────────────────────────────────────────────────────────────┴─────────────────┴──────────┘');
    console.log('');
    console.log(`Open http://localhost:${PORT} for the full endpoint list.`);
    console.log('');
  });
}

start().catch(console.error);
