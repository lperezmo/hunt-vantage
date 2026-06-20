# Hunt Vantage — Best Glassing/Stand Spot Finder

A standalone, Vercel-deployable web app: a hunter enters a location (or draws a
box over their ground), and the app returns the **best vantage points** —
ranked, mapped, and explained — using real elevation, satellite-derived tree
cover, and a line-of-sight (viewshed) analysis.

This plan is grounded in a teardown of `shlokkhemani/ode-to-yosemite` (cloned
alongside this folder). That repo already solves the hardest plumbing: pulling
**keyless** elevation + satellite tiles for an arbitrary bounding box, decoding
them into a metric heightmap, and classifying canopy-vs-open from the imagery.
We lift that pipeline and add the new IP: an **on-demand** version of it plus a
**viewshed-based vantage scoring** engine.

---

## 1. What we reuse vs. what's new

### Directly reusable from ode-to-yosemite
| Source file | What it gives us | How we use it |
|---|---|---|
| `tools/fetch-terrain.mjs` | Slippy-tile math, **Terrarium DEM decode** (`h = R*256 + G + B/256 - 32768`), **Esri imagery stitch**, **`canopy()` classifier** (green-dominance), **slope-suppressed forest mask** | The crown jewel. Port to run **on-demand for a user bbox** instead of baking one fixed area. |
| `src/terrain.js` | `heightAt(x,z)` bilinear sampler, `forestAt(x,z)`, `lonLatToWorld()`, chunked mesh build, metric frame (1 unit = 1 m, mercator corrected by `cos(lat)`) | `heightAt`/`forestAt` are the exact primitives the viewshed ray-marcher needs. Mesh build → optional 3D view. |
| `src/controls.js`, `src/lighting.js`, `src/atmosphere.js` | Fly/walk camera, time-of-day, fog | Optional 3D "stand-eye view" polish (Phase 4). |
| `tools/verify.mjs`, `tools/shoot.mjs` | Headless Playwright control + screenshot rig | Test harness, ported. |

### New (the actual product)
1. **2D map UI** — search-to-location + draw-a-box, heatmap overlay, ranked pins.
2. **On-demand data pipeline** — fetch tiles for *any* bbox at request time (the
   reference bakes 76 MB for one fixed valley; we can't ship that per parcel).
3. **Viewshed + vantage scoring engine** — the core algorithm (§4).
4. **Hunting-domain factors** — wind, sun/aspect, edge habitat, access (§4).
5. **Serverless tile proxy** — solves browser CORS and shields any keyed source.

---

## 2. User flow

1. **Land** on a full-screen satellite map (MapLibre GL). A search bar geocodes
   a place name / coordinates and flies there.
2. **Define the ground** — draw a rectangle (or polygon) over the hunting area.
   Soft cap ~25 km² with a friendly warning above that.
3. **Analyze** — one button. Progress bar while tiles download + analysis runs.
4. **See results** — a green→red **vantage heatmap** drapes over the parcel; the
   top 3–5 spots drop as pins with a one-line score + reason
   (*"Sees 78% of the parcel · 42 m above the meadow · faces E for morning light
   · downwind of the bedding edge"*).
5. **Inspect a pin** — side panel shows that spot's **viewshed footprint**
   (exactly what's visible from there) shaded on the map, plus its stat
   breakdown and weight contributions.
6. **3D stand-eye view** (optional) — drop into the Yosemite-style Three.js
   scene of just this parcel, camera at the chosen vantage, sightlines drawn,
   time-of-day + wind arrow toggles.
7. **Share / export** — shareable URL (bbox + weights encoded), GPX/KML pin
   export for a GPS or onX/HuntStand.

---

## 3. Architecture (Vercel-first)

**Recommendation: static SPA + thin serverless tile proxy + client-side compute.**

```
Browser (static SPA on Vercel CDN)
  ├─ MapLibre GL JS ........ map, draw, heatmap, pins  (2D)
  ├─ Three.js .............. parcel stand-eye view      (3D, lazy-loaded)
  └─ Web Worker ............ DEM decode + viewshed + scoring (keeps UI at 60fps)
        │ fetches tiles via
        ▼
Vercel Edge/Serverless  /api/tiles  → AWS Terrarium DEM + imagery
  (CORS, edge caching, attribution, optional key shielding)

Optional: Vercel KV / Blob — cache analysis by bbox+weights hash.
```

**Why client-side compute (not an `/api/analyze`):** hunting parcels are small.
A 40–640-acre property at z14 (~7.6 m/sample) is only ~60–250 samples per side —
a few hundred KB of DEM. Running the viewshed in a Web Worker means **$0
function compute, infinite scale, no 10s/60s Vercel timeout risk**, and instant
re-runs when the user nudges a weight slider. We keep a server-side `/api/analyze`
path documented as a fallback for very large parcels, but it's not the default.

**Tiles still need the proxy** because AWS S3 / Esri tiles aren't guaranteed
CORS-open from a browser, and the proxy is where we add edge caching +
attribution + the option to swap imagery sources without touching the client.

---

## 4. The vantage-scoring engine (core IP)

### 4.1 Inputs (all derived from the two keyless rasters)
- **Elevation** `z(x,y)` — Terrarium DEM (bare-earth-ish; SRTM/USGS derived).
- **Tree density** `d(x,y)` ∈ [0,1] — ported `canopy()` classifier + slope mask.
- **Canopy height surface** `zc = z + d · H_tree` (H_tree ≈ 20–30 m configurable)
  — what actually blocks a sightline. (Enhancement: swap in Meta/WRI 1 m global
  **canopy height** raster for real heights instead of `d · H_tree`.)
- **Slope & aspect** — finite-difference of the DEM (already done for the mask).
- **Edge map** — gradient magnitude of `d`; high where forest meets opening
  (game transition zones).
- **Optional**: prevailing wind vector (user), sun azimuth for the hunt window,
  OSM roads for access (ported `tools/fetch-osm.mjs`).

### 4.2 Viewshed (line of sight over terrain **and** canopy)
For a candidate observer cell at eye height `e` (1.7 m standing, or +tree-stand
height), cast `R` rays (e.g. 360 at 1°) out to a max glassing range `Rmax`
(default 800 m). March each ray sample-by-sample; track the running **maximum
elevation angle**. A target cell is *visible* if its angle (using ground height
`z`, since you want to see game on the ground) exceeds the running max set by the
**canopy surface** `zc` of everything between observer and target. This is the
classic R2/R3 sweep — O(R · Rmax/step) per observer.

```
visible(observer):
  maxAngle = -inf
  for each ray:
    maxAngle = -inf
    for t in step..Rmax step Δ:
      p = observer + t·dir
      occluderH = zc(p)                      # terrain + trees block
      angle = (occluderH - eyeZ) / t
      groundAngle = (z(p) - eyeZ) / t        # can we see the ground here?
      if groundAngle >= maxAngle: mark p visible
      maxAngle = max(maxAngle, angle)
```

### 4.3 Per-cell vantage score
Score each candidate observer (weights are user-tunable sliders, sensible
defaults shown):

| Factor | Default wt | Meaning |
|---|---|---|
| **Visible huntable area** | 0.35 | Σ visible cells, weighted ↑ for near cells (game in range) and for **huntable habitat** (meadow/edge, not bare cliff/water). |
| **Edge visibility** | 0.20 | How much forest↔opening edge the viewshed covers — where game moves. |
| **Local prominence** | 0.15 | Height above the local mean (better sightlines, thermals). |
| **Sun / aspect** | 0.10 | Aspect vs. sun azimuth for the chosen hunt window (sun at your back, game lit; reduce glare). |
| **Wind discipline** | 0.10 | Penalize positions whose scent (downwind cone) blows *into* the high-value habitat the viewshed covers. |
| **Self-concealment** | 0.05 | Small bonus for being at/just inside a forest edge (see without being skylined). |
| **Access** | 0.05 | Distance from OSM roads — closer = easier (user can invert to favor remote/low-pressure). |

Score raster → **non-maximum suppression** (min spacing, e.g. 150 m) → ranked
list of distinct vantage candidates, each with a generated plain-English reason
string from its top contributing factors.

### 4.4 Performance plan
Full reverse-viewshed (every cell observes) is expensive, so:
1. **Coarse-to-fine**: score on a downsampled grid (15–30 m cells); compute full
   viewsheds only for the top-K coarse winners, refined at full DEM res.
2. **Prune observers**: skip cells below local-mean elevation and deep-interior
   forest cells (poor sightlines) before the expensive pass.
3. **Web Worker** (or a small pool) keeps the main thread at 60 fps.
4. **WebGPU/WebGL2 compute** as an optional accelerator (viewshed as a fragment
   pass into a render target) for large parcels — Phase 5 enhancement.
5. **Hard cap + warning** on parcel area; log any downsampling so we never imply
   full-res coverage when we sampled.

---

## 5. Proposed repo structure

```
hunt-vantage/
  index.html
  package.json            # vite, three, maplibre-gl, @turf/turf, playwright(dev), sharp(dev)
  vite.config.js
  vercel.json             # static build + /api routes
  src/
    main.js               # bootstrap, state, URL (de)serialize
    ui/
      map.js              # MapLibre: geocode search, rectangle/polygon draw, heatmap, pins
      panel.js            # results panel, weight sliders, viewshed footprint toggle
      progress.js
    data/
      tiles.js            # bbox -> tile list -> fetch (ported tile math from fetch-terrain.mjs)
      dem.js              # Terrarium decode, heightAt, slope, aspect (ported from terrain.js)
      forest.js           # canopy() classifier + slope-suppressed mask (ported)
      osm.js              # optional roads/access (ported fetch-osm.mjs)
    analysis/
      viewshed.js         # radial LoS over terrain + canopy
      score.js            # weighted scoring, edge map, prominence, wind, NMS, reason strings
      worker.js           # Web Worker host wiring data/ + analysis/
    scene/                # Phase 4 (optional 3D), ported from ode-to-yosemite/src
      terrain3d.js controls.js lighting.js vantage3d.js
  api/
    tiles.js              # /api/tiles?src=dem|img&z=&x=&y=  proxy + cache + attribution
    analyze.js            # (optional fallback) server-side viewshed for huge parcels
  tools/
    verify.mjs            # ported Playwright control/render checks
  README.md  PLAN.md
```

---

## 6. Build phases

- **Phase 0 — Scaffold (½ day).** Vite SPA, MapLibre satellite map, geocode
  search, draw-rectangle, deploy a hello-world to Vercel. *Done = a box on a map,
  live on a vercel.app URL.*
- **Phase 1 — On-demand data (1–2 days).** Port tile math + Terrarium decode +
  `canopy()` mask into `data/` running for a user bbox; add `/api/tiles` proxy.
  *Done = draw a box → console shows a correct heightmap + forest mask (validate
  against a known peak elevation & a known meadow).* 
- **Phase 2 — Viewshed + heatmap (2–3 days).** `viewshed.js` + `score.js` in a
  worker; vantage heatmap overlay + top-5 pins with reasons; click-a-pin shows
  its viewshed footprint. *Done = ranked spots that visibly make sense on flat
  vs. ridge terrain.*
- **Phase 3 — Hunting factors (1–2 days).** Wind, sun/aspect, edge, access +
  weight sliders + live re-score; GPX/KML export; shareable URL. 
- **Phase 4 — 3D stand-eye view (2–3 days, optional).** Port the Three.js
  renderer for the single parcel; camera at vantage, draw visible-area shading +
  sightlines; time-of-day + wind arrow.
- **Phase 5 — Polish (1–2 days).** Mobile layout, KV/Blob caching, WebGPU
  viewshed for big parcels, attribution/ToS, error states, onboarding.

---

## 7. Key decisions & risks

- **Imagery source / ToS.** Esri World Imagery (used by the reference) requires
  attribution and its ToS may not cover a third-party app. For **US hunting**,
  strongly consider **USDA NAIP** (≈0.6–1 m, public domain) as the canopy-
  classification source — better than Esri and license-clean. Keep the source
  pluggable behind `/api/tiles`.
- **Canopy realism.** `canopy()` is leaf-on/summer-biased; deciduous winter
  cover is under-counted. The synthetic `d · H_tree` occluder is an
  approximation — flag it, and offer the **global canopy-height raster** swap as
  the accuracy upgrade.
- **DEM is bare-earth, not surface.** Good — it means we add canopy ourselves and
  the viewshed for *seeing game on the ground* is correct. (If we accidentally
  used a DSM we'd double-count trees.)
- **CORS.** Solved by `/api/tiles`. Verify AWS/Esri response caching headers and
  set our own edge cache.
- **Compute cost on large parcels.** Coarse-to-fine + cap + (optional) WebGPU.
- **Not legal/safety advice.** Add a disclaimer: property boundaries, legal
  shooting hours, and safe backstops are the hunter's responsibility — the app
  models *sightlines*, not legality.

---

## 8. Recommended next step

Scaffold **Phase 0 + Phase 1** as a real, deployable skeleton (map + draw-box +
on-demand DEM/forest for the box, proven correct), since that's the part with the
highest technical uncertainty and it's where the ported pipeline pays off. The
viewshed engine (Phase 2) then has clean, validated inputs to build on.
