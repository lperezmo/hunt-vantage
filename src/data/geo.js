// Web-mercator slippy-tile math, ported from ode-to-yosemite/tools/fetch-terrain.mjs.
// Everything works in a local metric frame so distances/heights are true to scale.

export const EARTH_CIRCUMFERENCE = 40075016.686;
export const TILE = 256;

export const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const lat2tile = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
};
export const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tile2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// Mercator metres per pixel at a zoom, before latitude correction.
export const mercPerPx = (z) => EARTH_CIRCUMFERENCE / 2 ** z / TILE;

// True ground metres per pixel at a zoom & latitude.
export const metersPerPx = (z, lat) => mercPerPx(z) * Math.cos((lat * Math.PI) / 180);

// Decode a Terrarium-encoded RGBA pixel into metres above sea level.
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

// Pick the DEM zoom so the cropped grid stays under `maxGrid` samples per side.
// Bigger parcels drop to a coarser zoom; small parcels get finer detail.
// If nothing in [min, max] fits, keep dropping below `min` rather than
// returning `min` with an unbounded grid: a huge bbox must never turn into a
// multi-gigabyte allocation or a tile-fetch storm.
export function pickDemZoom(bbox, { maxGrid = 420, min = 12, max = 15 } = {}) {
  const gridSide = (z) => {
    const w = (lon2tile(bbox.east, z) - lon2tile(bbox.west, z)) * TILE;
    const h = (lat2tile(bbox.south, z) - lat2tile(bbox.north, z)) * TILE;
    return Math.max(w, h);
  };
  for (let z = max; z >= min; z--) {
    if (gridSide(z) <= maxGrid) return z;
  }
  for (let z = min - 1; z >= 0; z--) {
    if (gridSide(z) <= maxGrid) return z;
  }
  return 0;
}

// Rough area of a bbox in km², for the soft size cap.
export function bboxAreaKm2(bbox) {
  const latMid = (bbox.north + bbox.south) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((latMid * Math.PI) / 180);
  const w = Math.abs(bbox.east - bbox.west) * mPerDegLon;
  const h = Math.abs(bbox.north - bbox.south) * mPerDegLat;
  return (w * h) / 1e6;
}
