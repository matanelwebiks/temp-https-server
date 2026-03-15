/**
 * generate-data.js
 *
 * Generates binary geo-formats from points.geojson using ogr2ogr.
 * Also generates data.xlsx from data.csv.
 *
 * Prerequisites: ogr2ogr (GDAL) must be installed and on PATH.
 *
 * Run:  node generate-data.js
 *
 * Generates:
 *   test-data/data.shp.zip   — Shapefile (zipped .shp/.shx/.dbf/.prj)
 *   test-data/data.gpkg      — GeoPackage
 *   test-data/data.gdb.zip   — File Geodatabase (zipped folder)
 *   test-data/data.xlsx      — Excel file
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const DATA_DIR = path.join(__dirname, 'test-data');
const GEOJSON = path.join(DATA_DIR, 'points.geojson');

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
      if (fs.existsSync(f)) {
        archive.file(f, { name: path.basename(f) });
      }
    }
    archive.finalize();
  });
}

async function main() {
  console.log('');
  console.log('═══  Generating test data  ═══');
  console.log('');

  // ── Check ogr2ogr ──
  let hasOgr = false;
  try {
    execSync('ogr2ogr --version', { stdio: 'pipe' });
    hasOgr = true;
    console.log('✓ ogr2ogr found');
  } catch {
    console.warn('⚠ ogr2ogr not found — binary formats (SHP, GPKG, GDB) will be skipped.');
    console.warn('  Install GDAL to generate them: https://gdal.org/download.html');
  }

  // ── Shapefile → zip ──
  if (hasOgr) {
    const shpDir = path.join(DATA_DIR, '_shp_tmp');
    if (fs.existsSync(shpDir)) fs.rmSync(shpDir, { recursive: true });
    fs.mkdirSync(shpDir, { recursive: true });

    const shpPath = path.join(shpDir, 'data.shp');
    console.log('\n── Shapefile ──');
    if (run(`ogr2ogr -f "ESRI Shapefile" "${shpPath}" "${GEOJSON}"`)) {
      // Zip all shapefile parts
      const parts = fs.readdirSync(shpDir).map(f => path.join(shpDir, f));
      const outZip = path.join(DATA_DIR, 'data.shp.zip');
      await zipFiles(parts, outZip);
      console.log(`✓ Created ${outZip}`);
    }
    fs.rmSync(shpDir, { recursive: true, force: true });
  }

  // ── GeoPackage ──
  if (hasOgr) {
    const gpkgPath = path.join(DATA_DIR, 'data.gpkg');
    if (fs.existsSync(gpkgPath)) fs.unlinkSync(gpkgPath);
    console.log('\n── GeoPackage ──');
    if (run(`ogr2ogr -f "GPKG" "${gpkgPath}" "${GEOJSON}"`)) {
      console.log(`✓ Created ${gpkgPath}`);
    }
  }

  // ── File GDB → zip ──
  if (hasOgr) {
    const gdbDir = path.join(DATA_DIR, 'data.gdb');
    if (fs.existsSync(gdbDir)) fs.rmSync(gdbDir, { recursive: true });
    console.log('\n── File Geodatabase ──');
    if (run(`ogr2ogr -f "OpenFileGDB" "${gdbDir}" "${GEOJSON}"`)) {
      const outZip = path.join(DATA_DIR, 'data.gdb.zip');
      await zipFolder(gdbDir, outZip);
      console.log(`✓ Created ${outZip}`);
      fs.rmSync(gdbDir, { recursive: true, force: true });
    }
  }

  // ── XLSX ──
  console.log('\n── Excel (XLSX) ──');
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
    const xlsxPath = path.join(DATA_DIR, 'data.xlsx');
    XLSX.writeFile(wb, xlsxPath);
    console.log(`✓ Created ${xlsxPath}`);
  } catch (err) {
    console.warn(`⚠ Could not generate XLSX: ${err.message}`);
  }

  // ── Summary ──
  console.log('\n── Files in test-data/ ──');
  const files = fs.readdirSync(DATA_DIR).filter(f => !f.startsWith('_'));
  for (const f of files.sort()) {
    const stat = fs.statSync(path.join(DATA_DIR, f));
    const size = stat.isDirectory() ? 'DIR' : `${(stat.size / 1024).toFixed(1)} KB`;
    console.log(`  ${f.padEnd(25)} ${size}`);
  }
  console.log('\nDone.');
}

main().catch(console.error);
