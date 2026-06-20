import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { setupMap } from './ui/map.js';
import { renderResults } from './ui/panel.js';
import { bboxAreaKm2 } from './data/geo.js';

const $ = (id) => document.getElementById(id);
const MAX_AREA_KM2 = 30;

const worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });

let lastResult = null;
let panelCtl = null;
let selectedRank = null;
let running = false;

const map = setupMap((box) => {
  $('analyze-btn').disabled = false;
  $('clear-btn').hidden = false;
  const area = bboxAreaKm2(box);
  $('draw-hint').textContent =
    area > MAX_AREA_KM2
      ? `⚠ ~${area.toFixed(0)} km² is large — analysis is capped at ${MAX_AREA_KM2} km² and may be coarse. Draw a smaller area for detail.`
      : `Area ~${area.toFixed(1)} km². Ready — press “Find best vantage points”.`;
  $('draw-btn').classList.remove('active');
});

// ---- search ----
async function doSearch() {
  const q = $('search').value.trim();
  if (!q) return;
  $('search-btn').textContent = '…';
  const ok = await map.geocode(q);
  $('search-btn').textContent = 'Go';
  if (!ok) $('draw-hint').textContent = 'Could not find that place. Try lat,lng or a more specific name.';
}
$('search-btn').addEventListener('click', doSearch);
$('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// ---- draw ----
$('draw-btn').addEventListener('click', () => {
  map.beginDraw();
  $('draw-btn').classList.add('active');
  $('draw-hint').textContent = 'Now click-drag a box on the map over your ground.';
});
$('clear-btn').addEventListener('click', () => {
  map.clearAll();
  lastResult = null; selectedRank = null;
  $('results').innerHTML = '';
  $('analyze-btn').disabled = true;
  $('clear-btn').hidden = true;
  $('draw-hint').textContent = 'Click the button, then drag a box on the map over your ground.';
});

// ---- analyze ----
function readUi() {
  return {
    huntTime: $('hunt-time').value,
    windFromDeg: Number($('wind-dir').value),
    maxRange: Number($('range').value),
    eyeHeight: Number($('eye').value),
    weights: {
      vis: +$('w-vis').value, edge: +$('w-edge').value, prom: +$('w-prom').value,
      sun: +$('w-sun').value, wind: +$('w-wind').value, con: +$('w-con').value,
    },
  };
}

function runAnalysis(box) {
  if (!box || running) return;
  running = true;
  $('analyze-btn').disabled = true;
  $('progress').hidden = false;
  setProgress(0.02, 'Starting…');
  // reflect the area in a shareable URL
  const u = new URL(location.href);
  u.searchParams.set('bbox', [box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)).join(','));
  history.replaceState(null, '', u);
  worker.postMessage({ bbox: box, ui: readUi() });
}

$('analyze-btn').addEventListener('click', () => runAnalysis(map.getBox()));

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.round(pct * 100)}%`;
  $('progress-label').textContent = label || '';
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    setProgress(msg.pct, msg.label);
  } else if (msg.type === 'result') {
    running = false;
    $('analyze-btn').disabled = false;
    setTimeout(() => { $('progress').hidden = true; }, 400);
    lastResult = msg.result;
    map.showHeatmap(lastResult);
    map.addMarkers(lastResult.spots, selectSpot);
    panelCtl = renderResults($('results'), lastResult.spots, {
      onSelect: selectSpot,
      onView3d: open3d,
    });
    if (lastResult.spots.length) selectSpot(1);
  } else if (msg.type === 'error') {
    running = false;
    $('analyze-btn').disabled = false;
    $('progress').hidden = true;
    $('draw-hint').textContent = `Analysis failed: ${msg.message}. Try again or a different area.`;
  }
};

function selectSpot(rank) {
  if (!lastResult) return;
  const spot = lastResult.spots.find((s) => s.rank === rank);
  if (!spot) return;
  selectedRank = rank;
  panelCtl?.select(rank);
  map.showFootprint(lastResult, spot);
  map.flyToSpot(spot);
}

// ---- 3D viewer ----
let view3dMod = null;
async function open3d(rank) {
  if (!lastResult) return;
  const spot = lastResult.spots.find((s) => s.rank === rank);
  if (!spot) return;
  $('viewer').hidden = false;
  $('viewer-title').textContent = `3D stand-eye view — Vantage ${rank}`;
  view3dMod = view3dMod || await import('./scene/view3d.js');
  // give the canvas a frame to lay out before sizing the renderer
  requestAnimationFrame(() => view3dMod.openViewer($('viewer-canvas'), lastResult, spot));
}
$('viewer-close').addEventListener('click', () => {
  $('viewer').hidden = true;
  view3dMod?.disposeViewer();
});

// ---- shareable / deep-link box: ?bbox=west,south,east,north ----
(function initFromUrl() {
  const raw = new URL(location.href).searchParams.get('bbox');
  if (!raw) return;
  const p = raw.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return;
  const box = { west: p[0], south: p[1], east: p[2], north: p[3] };
  let fired = false;
  const start = () => {
    if (fired) return;
    fired = true;
    map.setBox(box);
    $('analyze-btn').disabled = false;
    $('clear-btn').hidden = false;
    runAnalysis(box);
  };
  // run once the map has loaded so fitBounds + overlays apply cleanly
  if (map.map.loaded()) start();
  else map.map.once('load', start);
})();
