// Radial line-of-sight viewshed over the terrain AND the tree canopy.
//
// The DEM is bare-earth, so we see game standing on the ground (compare against
// `heights`), but the thing that BLOCKS a sightline is the canopy surface
// `zc = ground + treeDensity * treeHeight` (plus the terrain itself). Classic
// R2 sweep: march each ray outward tracking the running max elevation angle.

const TWO_PI = Math.PI * 2;

// Scalar score of a candidate observer. Accumulates, over every visible ground
// cell within range:
//   visArea  — near-weighted count (closer game = more valuable)
//   edgeVis  — near-weighted forest/opening edge (where game moves)
//   windDot  — near-weighted "is this habitat upwind of me?" (scent discipline)
//   cells    — raw visible cell count (for the visible-% reason string)
export function observeScore(g, ox, oy, p) {
  const { gridW, gridH, heights, zc, edge, metersPerPx } = g;
  const eyeZ = heights[oy * gridW + ox] + p.eyeHeight;
  const rangeCells = p.maxRange / metersPerPx;
  const nRays = p.rays;
  const wantWind = p.windBlowX !== 0 || p.windBlowY !== 0;

  let visArea = 0, edgeVis = 0, windDot = 0, cells = 0;

  for (let a = 0; a < nRays; a++) {
    const ang = (a / nRays) * TWO_PI;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let maxSlope = -Infinity;
    for (let t = 1; t <= rangeCells; t++) {
      const fx = ox + dx * t, fy = oy + dy * t;
      const ix = fx | 0, iy = fy | 0;
      if (ix < 0 || iy < 0 || ix >= gridW || iy >= gridH) break;
      const idx = iy * gridW + ix;
      const dist = t * metersPerPx;
      const groundSlope = (heights[idx] - eyeZ) / dist;
      if (groundSlope >= maxSlope) {
        const near = 1 - t / rangeCells;
        const e = edge[idx];
        visArea += near;
        edgeVis += near * e;
        cells++;
        if (wantWind) {
          // habitat weight, projected onto "upwind of observer" direction.
          // wind*Blow* is the direction the wind (and your scent) travels.
          const w = near * (0.4 + 0.6 * e);
          windDot += w * -(dx * p.windBlowX + dy * p.windBlowY);
        }
      }
      const occSlope = (zc[idx] - eyeZ) / dist;
      if (occSlope > maxSlope) maxSlope = occSlope;
    }
  }

  const windScore = wantWind && visArea > 0 ? Math.min(1, Math.max(0, (windDot / visArea + 1) / 2)) : 0.5;
  return { visArea, edgeVis, windDot, cells, windScore };
}

// Accurate visible-cell footprint for a single observer (for the map overlay)
// plus the visible fraction of the in-range disc. Unlike the radial sweep above
// (fast, fine for relative ranking), this tests EVERY cell in the disc with its
// own line-of-sight march, so the footprint is dense and the percentage is real.
// Only run for the handful of winning spots.
export function observeFootprint(g, ox, oy, p) {
  const { gridW, gridH, heights, zc, metersPerPx } = g;
  const eyeZ = heights[oy * gridW + ox] + p.eyeHeight;
  const rangeCells = p.maxRange / metersPerPx;
  const r2 = rangeCells * rangeCells;
  const vis = new Uint8Array(gridW * gridH);
  const rc = Math.ceil(rangeCells);

  let seen = 0, inDisc = 0;
  const c0 = Math.max(0, ox - rc), c1 = Math.min(gridW - 1, ox + rc);
  const r0 = Math.max(0, oy - rc), r1 = Math.min(gridH - 1, oy + rc);

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ddx = c - ox, ddy = r - oy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > r2) continue;
      inDisc++;
      if (d2 === 0) { vis[r * gridW + c] = 1; seen++; continue; }

      const targetDist = Math.sqrt(d2);
      const steps = Math.max(1, Math.round(targetDist));
      const targetSlope = (heights[r * gridW + c] - eyeZ) / (targetDist * metersPerPx);
      let blocked = false;
      // walk the intermediate cells; an occluder hides the target only if it
      // rises above the eye->target line, measured at the occluder's OWN
      // distance (not the parametric step) so the angle comparison is exact.
      for (let s = 1; s < steps; s++) {
        const fx = ox + (ddx * s) / steps;
        const fy = oy + (ddy * s) / steps;
        const ix = fx | 0, iy = fy | 0;
        const od = Math.hypot(ix - ox, iy - oy);
        if (od < 0.5 || od >= targetDist - 0.5) continue;
        const occSlope = (zc[iy * gridW + ix] - eyeZ) / (od * metersPerPx);
        if (occSlope > targetSlope + 1e-6) { blocked = true; break; }
      }
      if (!blocked) { vis[r * gridW + c] = 1; seen++; }
    }
  }
  return { vis, seen, visiblePercent: inDisc ? seen / inDisc : 0 };
}
