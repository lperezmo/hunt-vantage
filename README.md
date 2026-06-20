# Hunt Vantage 🦌🔭

**Find the best glassing / stand spots for any hunting ground.** Draw a box on
the map (or search a place), and the app pulls real elevation + satellite tree
cover for that ground, runs a line-of-sight **viewshed** analysis, and ranks the
spots that see the most — explained in plain English, with a 3D stand-eye view.

No API keys. Everything runs on free, keyless data:

- **Elevation** — Mapzen/AWS Terrain Tiles (Terrarium-encoded, NASA/USGS derived)
- **Imagery + tree cover** — Esri World Imagery, classified canopy-vs-open
- Both fetched on demand through a tiny serverless proxy, decoded in the browser.

The geospatial pipeline (tile math, Terrarium decode, canopy classifier) is
adapted from [`shlokkhemani/ode-to-yosemite`](https://github.com/shlokkhemani/ode-to-yosemite);
the on-demand fetching, viewshed engine, and hunting-domain scoring are new here.

## How it works

1. **You draw the ground.** Search to a location, then drag a rectangle over it
   (soft cap ~30 km²).
2. **The app builds the parcel.** A Web Worker fetches elevation + imagery tiles,
   decodes a metric heightmap, and classifies a tree-density mask (slope-suppressed
   so cliffs don't read as forest).
3. **It scores every spot.** For a grid of candidate observers it casts radial
   sightlines over the terrain **and the tree canopy** (`zc = ground + density × tree height`),
   then blends:
   | Factor | What it rewards |
   |---|---|
   | Visibility | sees the most huntable ground in range (closer = worth more) |
   | Edge habitat | overlooks forest↔opening transitions where game moves |
   | High ground | local prominence — better sightlines & thermals |
   | Sun / aspect | sun-favoured slopes for the chosen hunt window |
   | Wind discipline | keeps your scent off the prime habitat |
   | Concealment | sits in edge cover so you aren't skylined |
4. **You get ranked spots** — a green→red vantage heatmap, numbered pins, each
   spot's exact viewshed footprint, a GPX export, and a 3D drape of the parcel
   with the vantage marked.

Weights, glassing range, eye height (standing vs. tree stand), wind, and hunt
time are all tunable in **Tune the analysis**.

## Run locally

```sh
npm install
npm run dev      # open the printed localhost URL
```

`npm run build` produces the static site in `dist/`. The `/api/tiles` proxy runs
as a Vercel serverless function in production and as Vite dev middleware locally
(`vite.config.js`), so behaviour is identical in both.

## Deploy

Push to GitHub and import into Vercel (framework preset: **Vite**), or `vercel`
from the repo root. `vercel.json` pins the build + the tile-proxy function.

## Caveats

- Tree classification is leaf-on/summer-biased; deciduous winter cover is
  under-counted. Canopy height is an assumption (`~22 m`) — swap in a real
  canopy-height raster for sharper occlusion.
- The DEM is bare-earth, so you correctly see game on the ground; trees are added
  as the occluder on top.
- **Not legal or safety advice.** It models *sightlines* — not legal shooting
  hours, property boundaries, or safe backstops. Hunt responsibly.

---

Elevation © Mapzen/AWS Terrain Tiles · Imagery © Esri, Maxar, Earthstar Geographics ·
Geocoding © OpenStreetMap/Nominatim.
