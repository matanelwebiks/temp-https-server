/**
 * generate-data.js
 *
 * Generates ALL static test-data files for the test server.
 * Binary formats (SHP, GPKG, GDB) require ogr2ogr (GDAL) on PATH.
 *
 * Run:  node generate-data.js
 *
 * Generates:
 *   ── Text-based (always) ──
 *   test-data/points.geojson         60 points, WGS84
 *   test-data/polygons.geojson       25 polygons, WGS84
 *   test-data/lines.geojson          15 linestrings, WGS84
 *   test-data/roads.geojson          20 linestrings (roads), WGS84
 *   test-data/zones.geojson          8 zone polygons, WGS84
 *   test-data/buildings.geojson      60 MultiPolygon features, WGS84
 *   test-data/parcels-src.geojson    120 polygons (source for shapefile)
 *   test-data/locations.csv          35 records with lon,lat
 *   test-data/data.csv               existing format (EPSG:2039 x,y)
 *   test-data/data.txt               tab-delimited (EPSG:2039 x,y)
 *   test-data/data.gpx               GPX waypoints
 *   test-data/data.xml               GML points
 *   test-data/data.json              JSON with WKT column
 *
 *   ── Binary (requires ogr2ogr) ──
 *   test-data/data.shp.zip           Shapefile from points.geojson
 *   test-data/data.gpkg              GeoPackage from points.geojson
 *   test-data/data.gdb.zip           File GDB from points.geojson
 *   test-data/data.xlsx              Excel file
 *   test-data/parcels.zip            Shapefile (EPSG:2039) from parcels-src.geojson
 *   test-data/buildings.gpkg         GeoPackage from buildings.geojson
 *   test-data/layers.zip             Zip containing zones.geojson
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const DATA_DIR = path.join(__dirname, 'test-data');

// ─── Random helpers ─────────────────────────────────────────────────
function rand(min, max) {
  return +(min + Math.random() * (max - min)).toFixed(6);
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Israel bounding box (WGS84)
function israelPoint() {
  return [rand(34.2, 35.8), rand(29.5, 33.3)];
}

// Israel TM Grid (EPSG:2039) approximate
function israelPointITM() {
  return [randInt(130000, 270000), randInt(380000, 790000)];
}

function smallPolygon(center, size) {
  const [cx, cy] = center;
  const h = size / 2;
  return [[
    [+(cx - h).toFixed(6), +(cy - h).toFixed(6)],
    [+(cx + h).toFixed(6), +(cy - h).toFixed(6)],
    [+(cx + h).toFixed(6), +(cy + h).toFixed(6)],
    [+(cx - h).toFixed(6), +(cy + h).toFixed(6)],
    [+(cx - h).toFixed(6), +(cy - h).toFixed(6)],
  ]];
}

function multiPolygonCoords(center, size) {
  const [cx, cy] = center;
  const offset = size * 0.6;
  return [
    smallPolygon([cx - offset / 2, cy], size * 0.8),
    smallPolygon([cx + offset / 2, cy], size * 0.8),
  ];
}

function lineStringCoords(segCount) {
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

// ─── Name pools ─────────────────────────────────────────────────────
const CITIES = [
  'Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth',
  'Eilat', 'Ashdod', 'Netanya', 'Rishon LeZion', 'Petah Tikva',
  'Holon', 'Bat Yam', 'Ramat Gan', 'Herzliya', 'Kfar Saba',
  'Raanana', 'Rehovot', 'Ashkelon', 'Lod', 'Ramla',
  'Modiin', 'Acre', 'Tiberias', 'Safed', 'Dimona',
  'Arad', 'Kiryat Gat', 'Kiryat Shmona', 'Sderot', 'Or Yehuda',
  'Givatayim', 'Ramat Hasharon', 'Hod Hasharon', 'Yavne', 'Rosh HaAyin',
  'Migdal HaEmek', 'Afula', 'Yokneam', 'Carmiel', 'Nahariya',
  'Beit Shemesh', 'Kiryat Ono', 'Kiryat Bialik', 'Kiryat Motzkin', 'Nesher',
  'Tirat Carmel', 'Gedera', 'Or Akiva', 'Kadima', 'Pardes Hanna',
  'Ariel', 'Maalot', 'Beit Shean', 'Ofakim', 'Yeruham',
  'Mitzpe Ramon', 'Ein Gedi', 'Caesarea', 'Zichron Yaakov', 'Hadera',
];
const CATEGORIES = ['park', 'school', 'hospital', 'restaurant', 'museum', 'market', 'library', 'station', 'mall', 'office'];
const ROAD_NAMES = ['Main St', 'Oak Ave', 'Herzl Blvd', 'Ben Gurion Way', 'Weizmann St', 'Jabotinsky Rd', 'Rothschild Blvd', 'Dizengoff St', 'Allenby Rd', 'King George St', 'Balfour St', 'Bialik St', 'Nordau Blvd', 'Sokolov St', 'Arlozorov St', 'Ibn Gvirol St', 'Kaplan St', 'Begin Rd', 'Yigal Alon St', 'HaYarkon St'];
const OWNERS = ['City', 'State', 'Private', 'Municipality', 'National Park Authority', 'JNF', 'ILA'];
const ZONE_TYPES = ['Industrial', 'Residential', 'Commercial', 'Agricultural', 'Mixed Use', 'Educational', 'Military', 'Nature Reserve'];
const STATUSES = ['active', 'inactive', 'pending', 'archived'];

// ─── ogr2ogr helpers ────────────────────────────────────────────────
function run(cmd) {
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (err) {
    console.warn(`  ⚠ Command failed: ${err.message}`);
    return false;
  }
}

function zipFolder(sourceDir, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 5 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, path.basename(sourceDir));
    archive.finalize();
  });
}

function zipFiles(files, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 5 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const f of files) {
      if (fs.existsSync(f)) archive.file(f, { name: path.basename(f) });
    }
    archive.finalize();
  });
}

// ═════════════════════════════════════════════════════════════════════
//  TEXT-BASED DATA GENERATORS
// ═════════════════════════════════════════════════════════════════════

function generatePointsGeoJSON() {
  console.log('── points.geojson (60 points) ──');
  const features = [];
  for (let i = 0; i < 60; i++) {
    const [lon, lat] = israelPoint();
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: i < CITIES.length ? CITIES[i] : `Point ${i + 1}`,
        value: randInt(10, 500),
        category: pick(CATEGORIES),
      },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'points.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ points.geojson');
}

function generatePolygonsGeoJSON() {
  console.log('── polygons.geojson (25 polygons) ──');
  const features = [];
  for (let i = 0; i < 25; i++) {
    const center = israelPoint();
    const size = rand(0.005, 0.02);
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: smallPolygon(center, size) },
      properties: { name: `Polygon ${i + 1}`, area: randInt(100, 50000), owner: pick(OWNERS), zoneType: pick(ZONE_TYPES) },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'polygons.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ polygons.geojson');
}

function generateRoadsGeoJSON() {
  console.log('── roads.geojson (20 linestrings) ──');
  const features = [];
  for (let i = 0; i < 20; i++) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: lineStringCoords(randInt(3, 8)) },
      properties: { road_id: i + 1, road_name: ROAD_NAMES[i % ROAD_NAMES.length], lanes: pick([1, 2, 3, 4, 6]), surface: pick(['asphalt', 'concrete', 'gravel', 'dirt']) },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'roads.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ roads.geojson');
}

function generateZonesGeoJSON() {
  console.log('── zones.geojson (8 zone polygons) ──');
  const features = [];
  for (let i = 0; i < 8; i++) {
    const center = israelPoint();
    const size = rand(0.01, 0.05);
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: smallPolygon(center, size) },
      properties: { zone_id: `zone_${String.fromCharCode(97 + i)}`, name: ZONE_TYPES[i], maxHeight: pick([12, 15, 20, 25, 30, 40, 50]) },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'zones.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ zones.geojson');
}

function generateBuildingsGeoJSON() {
  console.log('── buildings.geojson (60 MultiPolygon features) ──');
  const features = [];
  for (let i = 0; i < 60; i++) {
    const center = israelPoint();
    const size = rand(0.002, 0.008);
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: multiPolygonCoords(center, size) },
      properties: { building_id: i + 1, address: `${randInt(1, 200)} ${pick(ROAD_NAMES)}`, floors: randInt(1, 30), type: pick(['residential', 'commercial', 'office', 'industrial', 'public']) },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'buildings.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ buildings.geojson');
}

function generateParcelsSourceGeoJSON() {
  console.log('── parcels-src.geojson (120 polygons for shapefile) ──');
  const features = [];
  for (let i = 0; i < 120; i++) {
    const center = israelPoint();
    const size = rand(0.003, 0.015);
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: smallPolygon(center, size) },
      properties: { parcelId: `P${String(i + 1).padStart(4, '0')}`, area: randInt(200, 80000), owner: pick(OWNERS), status: pick(STATUSES) },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'parcels-src.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ parcels-src.geojson');
}

function generateLocationsCsv() {
  console.log('── locations.csv (35 records) ──');
  const rows = ['id,name,lon,lat,category,status'];
  for (let i = 0; i < 35; i++) {
    const [lon, lat] = israelPoint();
    rows.push(`${i + 1},${i < CITIES.length ? CITIES[i] : `Location ${i + 1}`},${lon},${lat},${pick(CATEGORIES)},${pick(STATUSES)}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'locations.csv'), rows.join('\n') + '\n');
  console.log('  ✓ locations.csv');
}

function generateLinesGeoJSON() {
  console.log('── lines.geojson (15 linestrings) ──');
  const features = [];
  for (let i = 0; i < 15; i++) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: lineStringCoords(randInt(3, 10)) },
      properties: { id: i + 1, name: `Line ${i + 1}` },
    });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  console.log('  ✓ lines.geojson');
}

function generateDataCsv() {
  console.log('── data.csv (ITM coordinates) ──');
  const rows = ['name,x,y,value'];
  const names = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth', 'Eilat', 'Ashdod', 'Netanya', 'Rishon LeZion', 'Petah Tikva'];
  for (const name of names) {
    const [x, y] = israelPointITM();
    rows.push(`${name},${x},${y},${randInt(10, 500)}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'data.csv'), rows.join('\n') + '\n');
  console.log('  ✓ data.csv');
}

function generateDataTxt() {
  console.log('── data.txt (tab-delimited, ITM) ──');
  const rows = ['name\tx\ty\tvalue'];
  const names = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth'];
  for (const name of names) {
    const [x, y] = israelPointITM();
    rows.push(`${name}\t${x}\t${y}\t${randInt(10, 500)}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'data.txt'), rows.join('\n') + '\n');
  console.log('  ✓ data.txt');
}

function generateDataGpx() {
  console.log('── data.gpx (waypoints) ──');
  const names = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth'];
  const wpts = names.map(name => {
    const [lon, lat] = israelPoint();
    return `  <wpt lat="${lat}" lon="${lon}"><name>${name}</name></wpt>`;
  }).join('\n');
  fs.writeFileSync(path.join(DATA_DIR, 'data.gpx'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="test-server">\n${wpts}\n</gpx>`);
  console.log('  ✓ data.gpx');
}

function generateDataXml() {
  console.log('── data.xml (GML points) ──');
  const names = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth'];
  const members = names.map(name => {
    const [lon, lat] = israelPoint();
    return `  <gml:featureMember>\n    <Feature>\n      <name>${name}</name>\n      <value>${randInt(10, 500)}</value>\n      <gml:Point srsName="EPSG:4326"><gml:coordinates>${lon},${lat}</gml:coordinates></gml:Point>\n    </Feature>\n  </gml:featureMember>`;
  }).join('\n');
  fs.writeFileSync(path.join(DATA_DIR, 'data.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml">\n${members}\n</gml:FeatureCollection>`);
  console.log('  ✓ data.xml');
}

function generateDataJson() {
  console.log('── data.json (WKT column) ──');
  const names = ['Tel Aviv', 'Jerusalem', 'Haifa', 'Beer Sheva', 'Nazareth'];
  const items = names.map((name, i) => {
    const [lon, lat] = israelPoint();
    return { id: i + 1, name, wkt: `POINT (${lon} ${lat})`, value: randInt(10, 500) };
  });
  fs.writeFileSync(path.join(DATA_DIR, 'data.json'), JSON.stringify(items, null, 2));
  console.log('  ✓ data.json');
}

function generateTargetCsvFiles() {
  console.log('── target.csv, other.csv, readme.csv (for zip tests) ──');
  const targetRows = ['id,name,x,y,val'];
  for (let i = 0; i < 10; i++) {
    const [x, y] = israelPointITM();
    targetRows.push(`${i + 1},Target ${i + 1},${x},${y},${randInt(1, 100)}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'target.csv'), targetRows.join('\n') + '\n');

  const otherRows = ['id,label'];
  for (let i = 0; i < 5; i++) otherRows.push(`${i + 1},Other ${i + 1}`);
  fs.writeFileSync(path.join(DATA_DIR, 'other.csv'), otherRows.join('\n') + '\n');

  fs.writeFileSync(path.join(DATA_DIR, 'readme.csv'), 'info\nThis archive contains target.csv and other.csv\n');
  console.log('  ✓ target.csv, other.csv, readme.csv');
}

// ═════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════
async function main() {
  console.log('');
  console.log('═══  Generating test data  ═══');
  console.log('');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── Text-based files (always generated) ────────────────────────────
  generatePointsGeoJSON();
  generatePolygonsGeoJSON();
  generateLinesGeoJSON();
  generateRoadsGeoJSON();
  generateZonesGeoJSON();
  generateBuildingsGeoJSON();
  generateParcelsSourceGeoJSON();
  generateLocationsCsv();
  generateDataCsv();
  generateDataTxt();
  generateDataGpx();
  generateDataXml();
  generateDataJson();
  generateTargetCsvFiles();

  // ── Check ogr2ogr ─────────────────────────────────────────────────
  let hasOgr = false;
  try {
    execSync('ogr2ogr --version', { stdio: 'pipe' });
    hasOgr = true;
    console.log('\n✓ ogr2ogr found');
  } catch {
    console.warn('\n⚠ ogr2ogr not found — binary formats (SHP, GPKG, GDB) will be skipped.');
    console.warn('  Install GDAL to generate them: https://gdal.org/download.html');
  }

  const GEOJSON = path.join(DATA_DIR, 'points.geojson');

  // ── Shapefile from points → data.shp.zip ──────────────────────────
  if (hasOgr) {
    const shpDir = path.join(DATA_DIR, '_shp_tmp');
    if (fs.existsSync(shpDir)) fs.rmSync(shpDir, { recursive: true });
    fs.mkdirSync(shpDir, { recursive: true });
    const shpPath = path.join(shpDir, 'data.shp');
    console.log('\n── Shapefile (data.shp.zip) ──');
    if (run(`ogr2ogr -f "ESRI Shapefile" "${shpPath}" "${GEOJSON}"`)) {
      const parts = fs.readdirSync(shpDir).map(f => path.join(shpDir, f));
      await zipFiles(parts, path.join(DATA_DIR, 'data.shp.zip'));
      console.log('  ✓ data.shp.zip');
    }
    fs.rmSync(shpDir, { recursive: true, force: true });
  }

  // ── GeoPackage from points → data.gpkg ────────────────────────────
  if (hasOgr) {
    const gpkgPath = path.join(DATA_DIR, 'data.gpkg');
    if (fs.existsSync(gpkgPath)) fs.unlinkSync(gpkgPath);
    console.log('\n── GeoPackage (data.gpkg) ──');
    if (run(`ogr2ogr -f "GPKG" "${gpkgPath}" "${GEOJSON}"`)) {
      console.log('  ✓ data.gpkg');
    }
  }

  // ── File GDB from points → data.gdb.zip ───────────────────────────
  if (hasOgr) {
    const gdbDir = path.join(DATA_DIR, 'data.gdb');
    if (fs.existsSync(gdbDir)) fs.rmSync(gdbDir, { recursive: true });
    console.log('\n── File Geodatabase (data.gdb.zip) ──');
    if (run(`ogr2ogr -f "OpenFileGDB" "${gdbDir}" "${GEOJSON}"`)) {
      await zipFolder(gdbDir, path.join(DATA_DIR, 'data.gdb.zip'));
      console.log('  ✓ data.gdb.zip');
      fs.rmSync(gdbDir, { recursive: true, force: true });
    }
  }

  // ── Parcels shapefile (EPSG:2039) → parcels.zip ───────────────────
  if (hasOgr) {
    const parcelsSrc = path.join(DATA_DIR, 'parcels-src.geojson');
    const parcelsShpDir = path.join(DATA_DIR, '_parcels_shp_tmp');
    if (fs.existsSync(parcelsShpDir)) fs.rmSync(parcelsShpDir, { recursive: true });
    fs.mkdirSync(parcelsShpDir, { recursive: true });
    const parcelsShp = path.join(parcelsShpDir, 'parcels.shp');
    console.log('\n── Parcels Shapefile EPSG:2039 (parcels.zip) ──');
    if (run(`ogr2ogr -f "ESRI Shapefile" -t_srs EPSG:2039 "${parcelsShp}" "${parcelsSrc}"`)) {
      const parts = fs.readdirSync(parcelsShpDir).map(f => path.join(parcelsShpDir, f));
      await zipFiles(parts, path.join(DATA_DIR, 'parcels.zip'));
      console.log('  ✓ parcels.zip');
    }
    fs.rmSync(parcelsShpDir, { recursive: true, force: true });
  }

  // ── Buildings GeoPackage → buildings.gpkg ──────────────────────────
  if (hasOgr) {
    const buildingsSrc = path.join(DATA_DIR, 'buildings.geojson');
    const buildingsGpkg = path.join(DATA_DIR, 'buildings.gpkg');
    if (fs.existsSync(buildingsGpkg)) fs.unlinkSync(buildingsGpkg);
    console.log('\n── Buildings GeoPackage (buildings.gpkg) ──');
    if (run(`ogr2ogr -f "GPKG" "${buildingsGpkg}" "${buildingsSrc}"`)) {
      console.log('  ✓ buildings.gpkg');
    }
  }

  // ── XLSX ───────────────────────────────────────────────────────────
  console.log('\n── Excel (data.xlsx) ──');
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
    console.warn(`  ⚠ data.xlsx failed: ${err.message}`);
  }

  // ── layers.zip (contains zones.geojson) ────────────────────────────
  console.log('\n── layers.zip ──');
  const zonesFile = path.join(DATA_DIR, 'zones.geojson');
  if (fs.existsSync(zonesFile)) {
    await zipFiles([zonesFile], path.join(DATA_DIR, 'layers.zip'));
    console.log('  ✓ layers.zip');
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n── Files in test-data/ ──');
  const files = fs.readdirSync(DATA_DIR).filter(f => !f.startsWith('_'));
  for (const f of files.sort()) {
    const stat = fs.statSync(path.join(DATA_DIR, f));
    const size = stat.isDirectory() ? 'DIR' : `${(stat.size / 1024).toFixed(1)} KB`;
    console.log(`  ${f.padEnd(30)} ${size}`);
  }
  console.log('\nDone.');
}

main().catch(console.error);
