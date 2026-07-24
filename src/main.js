import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { setupMap } from './ui/map.js';
import { renderResults } from './ui/panel.js';
import { bboxAreaKm2 } from './data/geo.js';

const $ = (id) => document.getElementById(id);
const MAX_AREA_KM2 = 30;

function spawnWorker() {
  const w = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });
  w.onmessage = onWorkerMessage;
  return w;
}
let worker = spawnWorker();

let lastResult = null;
let panelCtl = null;
let selectedRank = null;
let running = false;
// Bumped on every start and on Clear, so results from a discarded run are
// ignored instead of repainting the map for a bbox the user threw away.
let runId = 0;

const tooBigText = (area) =>
  `That box is ~${area.toFixed(0)} km², over the ${MAX_AREA_KM2} km² limit. Draw a smaller area and try again.`;

const map = setupMap((box) => {
  const area = bboxAreaKm2(box);
  const tooBig = area > MAX_AREA_KM2;
  $('analyze-btn').disabled = tooBig;
  $('clear-btn').hidden = false;
  $('draw-hint').textContent = tooBig
    ? tooBigText(area)
    : `Area ~${area.toFixed(1)} km². Ready - press “Find best vantage points”.`;
  endDrawUi();
});

const DEFAULT_HINT = 'Tap “Draw hunting area”, then drag a box across your ground.';
let drawingMode = false;

function endDrawUi() {
  drawingMode = false;
  document.body.classList.remove('drawing');
  $('draw-btn').classList.remove('active');
  $('draw-btn').textContent = 'Draw hunting area';
}

// ---- search ----
async function doSearch() {
  const q = $('search').value.trim();
  if (!q) return;
  $('search-btn').textContent = '…';
  const res = await map.geocode(q);
  $('search-btn').textContent = 'Go';
  if (!res.ok) {
    $('draw-hint').textContent =
      res.reason === 'rate-limited'
        ? 'Place search is temporarily rate limited. Wait a minute, or type lat,lng directly.'
        : 'Could not find that place. Try lat,lng or a more specific name.';
  }
}
$('search-btn').addEventListener('click', doSearch);
$('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// ---- draw (toggle: tap again to cancel) ----
$('draw-btn').addEventListener('click', () => {
  if (drawingMode) {
    map.cancelDraw();
    endDrawUi();
    $('draw-hint').textContent = DEFAULT_HINT;
    return;
  }
  map.beginDraw();
  drawingMode = true;
  document.body.classList.add('drawing'); // collapses the sidebar on mobile for room
  $('draw-btn').classList.add('active');
  $('draw-btn').textContent = 'Cancel drawing';
  $('draw-hint').textContent = 'Drag a box across your ground - press and drag on the map (touch works).';
});
$('clear-btn').addEventListener('click', () => {
  runId += 1; // any in-flight run now belongs to a discarded box
  // Tear the worker down as well as ignoring its output: otherwise it keeps
  // fetching tiles for the discarded box and the next run queues behind it.
  if (running) { worker.terminate(); worker = spawnWorker(); }
  running = false;
  map.clearAll();
  endDrawUi();
  lastResult = null; selectedRank = null;
  $('results').innerHTML = '';
  $('analyze-btn').disabled = true;
  $('clear-btn').hidden = true;
  $('progress').hidden = true;
  $('draw-hint').textContent = DEFAULT_HINT;
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
  // Hard cap: the grid, the tile fetches and the allocations all scale with
  // area, so an oversized box (including one arriving via ?bbox=) is refused
  // outright rather than tying up the browser and the tile proxy.
  const area = bboxAreaKm2(box);
  if (area > MAX_AREA_KM2) {
    $('analyze-btn').disabled = true;
    $('draw-hint').textContent = tooBigText(area);
    return;
  }
  running = true;
  runId += 1;
  $('analyze-btn').disabled = true;
  $('progress').hidden = false;
  setProgress(0.02, 'Starting…');
  // reflect the area in a shareable URL
  const u = new URL(location.href);
  u.searchParams.set('bbox', [box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)).join(','));
  history.replaceState(null, '', u);
  worker.postMessage({ bbox: box, ui: readUi(), runId });
}

$('analyze-btn').addEventListener('click', () => runAnalysis(map.getBox()));

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.round(pct * 100)}%`;
  $('progress-label').textContent = label || '';
}

function onWorkerMessage(e) {
  const msg = e.data;
  if (msg.runId !== runId) return; // stale run (cleared or superseded)
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
}

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
  $('viewer-title').textContent = `3D stand-eye view - Vantage ${rank}`;
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
  // Reject out-of-range or inverted boxes: they otherwise reach the mercator
  // math as a negative-width parcel or a past-the-pole latitude.
  const inRange =
    box.south >= -85 && box.north <= 85 && box.south < box.north &&
    box.west >= -180 && box.east <= 180 && box.west < box.east;
  if (!inRange) return;
  let fired = false;
  const start = () => {
    if (fired) return;
    fired = true;
    map.setBox(box);
    $('analyze-btn').disabled = bboxAreaKm2(box) > MAX_AREA_KM2;
    $('clear-btn').hidden = false;
    runAnalysis(box);
  };
  // run once the map has loaded so fitBounds + overlays apply cleanly
  if (map.map.loaded()) start();
  else map.map.once('load', start);
})();
