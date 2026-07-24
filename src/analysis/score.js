// Vantage scoring: turn a built parcel into a ranked set of best spots + a
// score raster for the heatmap. Combines the viewshed with hunting-domain
// factors (edge habitat, high ground, sun/aspect, wind discipline, concealment).

import { observeScore, observeFootprint } from './viewshed.js';
import { TILE, tile2lat } from '../data/geo.js';

const TREE_HEIGHT = 16; // metres of mature canopy

// Length over which a full open-to-closed canopy swing saturates the edge
// score. Turning the raw two-cell difference into a per-metre gradient makes
// `edge` independent of DEM zoom and of the grid border (where the difference
// spans one cell, not two); 66 m reproduces the previous tuning at the ~15 m
// samples a default-sized parcel uses.
const EDGE_GRADIENT_REF_M = 66;

// Effective sight-blocking canopy height for a tree-density 0..1. Density-gated
// so open ground and sparse/scattered cover stay see-through (you glass across
// meadows and broken timber), while only closed canopy walls off the view.
function effectiveCanopy(density) {
  const t = Math.max(0, Math.min(1, (density - 0.25) / 0.55));
  return t * t * TREE_HEIGHT;
}

// Sun-favoured aspect. The sun still rises east and sets west below the
// equator, but midday sun there comes from the north, so a southern-hemisphere
// parcel must reward north-facing slopes at midday.
const SUN_AZ = { dawn: 90, midday: 180, dusk: 270 };
const SUN_AZ_SOUTH = { dawn: 90, midday: 0, dusk: 270 };
const SUN_TEXT = {
  dawn: 'catches the morning sun',
  midday: 'well-lit through midday',
  dusk: 'holds the evening light',
};

// Build the derived layers the scorer needs (occlusion surface, edge map,
// summed-area table for fast local prominence, aspect azimuth).
function deriveLayers(parcel) {
  const { gridW, gridH, heights, forest, metersPerPx } = parcel;
  const n = gridW * gridH;
  const zc = new Float32Array(n);
  const edge = new Float32Array(n);
  const aspect = new Float32Array(n); // compass degrees the slope faces

  for (let i = 0; i < n; i++) zc[i] = heights[i] + effectiveCanopy(forest[i] / 255);

  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      const i = r * gridW + c;
      const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
      const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
      // forest-density gradient (per metre) -> edge strength
      const fgx = (forest[r * gridW + cr] - forest[r * gridW + cl]) / 255 / ((cr - cl) * metersPerPx);
      const fgy = (forest[rd * gridW + c] - forest[ru * gridW + c]) / 255 / ((rd - ru) * metersPerPx);
      edge[i] = Math.min(1, Math.hypot(fgx, fgy) * EDGE_GRADIENT_REF_M);
      // terrain aspect (downhill compass azimuth)
      const dzx = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * metersPerPx);
      const dzy = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * metersPerPx);
      const east = -dzx, south = -dzy; // downhill direction
      let az = (Math.atan2(east, -south) * 180) / Math.PI; // 0=N, 90=E
      if (az < 0) az += 360;
      aspect[i] = az;
    }
  }

  // summed-area table of heights for O(1) local mean (prominence)
  const sat = new Float64Array((gridW + 1) * (gridH + 1));
  const sw = gridW + 1;
  for (let r = 0; r < gridH; r++) {
    let rowSum = 0;
    for (let c = 0; c < gridW; c++) {
      rowSum += heights[r * gridW + c];
      sat[(r + 1) * sw + (c + 1)] = sat[r * sw + (c + 1)] + rowSum;
    }
  }
  const localMean = (c, r, rad) => {
    const c0 = Math.max(0, c - rad), c1 = Math.min(gridW - 1, c + rad);
    const r0 = Math.max(0, r - rad), r1 = Math.min(gridH - 1, r + rad);
    const area = (c1 - c0 + 1) * (r1 - r0 + 1);
    const s = sat[(r1 + 1) * sw + (c1 + 1)] - sat[r0 * sw + (c1 + 1)] - sat[(r1 + 1) * sw + c0] + sat[r0 * sw + c0];
    return s / area;
  };

  return { zc, edge, aspect, localMean };
}

function normalize(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  return (v) => (v - min) / span;
}

export function analyze(parcel, ui) {
  const { gridW, gridH, heights, forest, metersPerPx, bbox, pyn, pys, demZoom } = parcel;
  const { zc, edge, aspect, localMean } = deriveLayers(parcel);
  const g = { gridW, gridH, heights, zc, edge, metersPerPx };

  // weights (UI gives 0..100; renormalise to sum 1)
  const wRaw = ui.weights;
  const wSum = Object.values(wRaw).reduce((a, b) => a + b, 0) || 1;
  const w = {};
  for (const k in wRaw) w[k] = wRaw[k] / wSum;

  const windOn = ui.windFromDeg >= 0;
  let windBlowX = 0, windBlowY = 0;
  if (windOn) {
    // wind "from" compass deg -> unit vector of where it (and scent) travels
    const blowAz = (ui.windFromDeg + 180) % 360;
    const rad = (blowAz * Math.PI) / 180;
    windBlowX = Math.sin(rad);   // +x = east
    windBlowY = -Math.cos(rad);  // +y = south (grid down)
  }
  const southern = (bbox.north + bbox.south) / 2 < 0;
  const sunTable = southern ? SUN_AZ_SOUTH : SUN_AZ;
  const sunAz = sunTable[ui.huntTime] ?? (southern ? 0 : 180);

  const p = {
    eyeHeight: ui.eyeHeight,
    maxRange: ui.maxRange,
    rays: 96,
    windBlowX, windBlowY,
  };

  // candidate grid (subsampled to keep the work bounded)
  const stride = Math.max(1, Math.round(Math.sqrt((gridW * gridH) / 2600)));
  const cgW = Math.floor((gridW - 1) / stride) + 1;
  const cgH = Math.floor((gridH - 1) / stride) + 1;
  const promRad = Math.min(60, Math.max(6, Math.round(280 / metersPerPx)));

  const visA = new Float32Array(cgW * cgH);
  const edgeA = new Float32Array(cgW * cgH);
  const promA = new Float32Array(cgW * cgH);
  const sunA = new Float32Array(cgW * cgH);
  const windA = new Float32Array(cgW * cgH);
  const conA = new Float32Array(cgW * cgH);

  for (let cy = 0; cy < cgH; cy++) {
    for (let cx = 0; cx < cgW; cx++) {
      const ox = Math.min(cx * stride, gridW - 1);
      const oy = Math.min(cy * stride, gridH - 1);
      const i = oy * gridW + ox;
      const o = observeScore(g, ox, oy, p);
      const ci = cy * cgW + cx;
      visA[ci] = o.visArea;
      edgeA[ci] = o.edgeVis;
      promA[ci] = heights[i] - localMean(ox, oy, promRad);
      const da = Math.abs(((aspect[i] - sunAz + 540) % 360) - 180); // 0..180
      sunA[ci] = 1 - da / 180;
      windA[ci] = windOn ? o.windScore : 0.5;
      conA[ci] = edge[i]; // concealment: standing in/near cover edge
    }
  }

  const nVis = normalize(visA), nEdge = normalize(edgeA), nProm = normalize(promA);
  const nCon = normalize(conA);
  const score = new Float32Array(cgW * cgH);
  for (let i = 0; i < score.length; i++) {
    score[i] =
      w.vis * nVis(visA[i]) +
      w.edge * nEdge(edgeA[i]) +
      w.prom * nProm(promA[i]) +
      w.sun * sunA[i] +
      w.wind * windA[i] +
      w.con * nCon(conA[i]);
  }

  // non-maximum suppression -> distinct top spots
  const spacing = Math.max(2, Math.round(160 / metersPerPx / stride));
  const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]);
  const picked = [];
  const taken = new Uint8Array(cgW * cgH);
  for (const idx of order) {
    if (picked.length >= 6) break;
    const cx = idx % cgW, cy = (idx / cgW) | 0;
    if (taken[idx]) continue;
    picked.push({ cx, cy, idx, s: score[idx] });
    for (let dy = -spacing; dy <= spacing; dy++) {
      for (let dx = -spacing; dx <= spacing; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < cgW && ny < cgH) taken[ny * cgW + nx] = 1;
      }
    }
  }

  // detail pass on the winners: footprint + reasons
  // Grid columns are evenly spaced in longitude, but rows are evenly spaced in
  // web-mercator pixel y (see buildParcel), which is nonlinear in latitude, so
  // a row is georeferenced through the mercator inverse and not by lerping
  // between north and south. Both take fractional / out-of-range values so the
  // overlay extents below can be expressed in the same grid coordinates.
  const lon = (col) => bbox.west + (gridW <= 1 ? 0 : (col / (gridW - 1)) * (bbox.east - bbox.west));
  const lat = (row) =>
    gridH <= 1
      ? bbox.north
      : tile2lat((pyn + (row * (pys - pyn)) / (gridH - 1)) / TILE, demZoom);
  const sMin = picked.length ? picked[picked.length - 1].s : 0;
  const sMax = picked.length ? picked[0].s : 1;

  const spots = picked.map((pk, rank) => {
    const ox = Math.min(pk.cx * stride, gridW - 1);
    const oy = Math.min(pk.cy * stride, gridH - 1);
    const i = oy * gridW + ox;
    const fp = observeFootprint(g, ox, oy, p);
    const prom = heights[i] - localMean(ox, oy, promRad);
    const visibleAcres = Math.round((fp.seen * metersPerPx * metersPerPx) / 4047);

    // contributions for the "why"
    const contrib = [
      { k: 'vis', v: w.vis * nVis(visA[pk.idx]), t: `glasses about ${visibleAcres} acres of open ground` },
      { k: 'edge', v: w.edge * nEdge(edgeA[pk.idx]), t: 'overlooks lots of forest-edge habitat' },
      { k: 'prom', v: w.prom * nProm(promA[pk.idx]), t: prom > 2 ? `sits ${Math.round(prom)} m above the local terrain` : 'reads the terrain well' },
      { k: 'sun', v: w.sun * sunA[pk.idx], t: SUN_TEXT[ui.huntTime] },
      { k: 'wind', v: windOn ? w.wind * windA[pk.idx] : 0, t: 'keeps your scent off the prime habitat' },
      { k: 'con', v: w.con * nCon(conA[pk.idx]), t: 'tucked into edge cover so you stay hidden' },
    ].filter((x) => x.v > 0).sort((a, b) => b.v - a.v);

    const why = capitalize(contrib.slice(0, 3).map((x) => x.t).join(' · '));
    const rel = sMax > sMin ? (pk.s - sMin) / (sMax - sMin) : 1;
    const rating = Math.round(55 + rel * 44); // 55..99 feel-good score

    return {
      rank: rank + 1,
      lon: lon(ox), lat: lat(oy),
      elevation: Math.round(heights[i]),
      rating,
      why,
      visibleAcres,
      footprint: fp.vis,
      ox, oy,
    };
  });

  // normalised score raster for the heatmap (0..1)
  const nScore = normalize(score);
  const heat = new Float32Array(score.length);
  for (let i = 0; i < score.length; i++) heat[i] = nScore(score[i]);

  // Extents for the canvas overlays. A raster pixel's CENTRE is what carries
  // its sample, so a cgW x cgH heat canvas whose samples sit on grid columns
  // 0, stride, 2*stride ... must be stretched half a candidate cell past the
  // outermost samples, not fitted to the bbox. Fitting it to the bbox both
  // shifted the heat half a cell and stretched it over the gap between the
  // last sampled column and the bbox edge.
  const heatBbox = {
    west: lon(-0.5 * stride), east: lon((cgW - 0.5) * stride),
    north: lat(-0.5 * stride), south: lat((cgH - 0.5) * stride),
  };
  // Same logic for the full-resolution footprint canvas (one pixel per sample).
  const gridBbox = {
    west: lon(-0.5), east: lon(gridW - 0.5),
    north: lat(-0.5), south: lat(gridH - 0.5),
  };

  return {
    gridW, gridH, cgW, cgH, stride,
    bbox, heatBbox, gridBbox, metersPerPx,
    heat, spots,
    // raw layers returned so the 3D view can reuse them
    heights, forest,
    demZoom,
  };
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
