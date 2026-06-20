# Hunt Vantage

Find the best glassing and stand spots for any hunting ground. Draw a box on the
map (or search a place), and the app pulls real elevation and satellite tree
cover for that ground, runs a line-of-sight viewshed analysis, and ranks the
spots that see the most, explained in plain English, with a 3D stand-eye view.

[![Live on Vercel](https://img.shields.io/badge/Live-hunt--vantage.vercel.app-000000?logo=vercel&logoColor=white)](https://hunt-vantage.vercel.app)
[![Built with Claude Opus 4.8](https://img.shields.io/badge/Built%20with-Claude%20Opus%204.8-D4A27F?logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Three.js](https://img.shields.io/badge/Three.js-r170-000000?logo=three.js&logoColor=white)](https://threejs.org)
[![MapLibre GL](https://img.shields.io/badge/MapLibre_GL-4-396CB2?logo=maplibre&logoColor=white)](https://maplibre.org)

No API keys. Everything runs on free, keyless data:

- Elevation: Mapzen/AWS Terrain Tiles (Terrarium-encoded, NASA/USGS derived).
- Imagery and tree cover: Esri World Imagery, classified canopy versus open.
- Both fetched on demand through a small serverless proxy, decoded in the browser.

## How it works

1. You draw the ground. Search to a location, then drag a rectangle over it
   (soft cap about 30 sq km).
2. The app builds the parcel. A Web Worker fetches elevation and imagery tiles,
   decodes a metric heightmap, and classifies a tree-density mask
   (slope-suppressed so cliffs do not read as forest).
3. It scores every spot. For a grid of candidate observers it casts radial
   sightlines over the terrain and the tree canopy (canopy surface equals ground
   plus an effective tree height that scales with density), then blends:

   | Factor | What it rewards |
   |---|---|
   | Visibility | sees the most huntable ground in range (closer counts for more) |
   | Edge habitat | overlooks forest-to-opening transitions where game moves |
   | High ground | local prominence, for better sightlines and thermals |
   | Sun and aspect | sun-favored slopes for the chosen hunt window |
   | Wind discipline | keeps your scent off the prime habitat |
   | Concealment | sits in edge cover so you are not skylined |

4. You get ranked spots: a green-to-red vantage heatmap, numbered pins, each
   spot's exact viewshed footprint, acres of open ground visible, a GPX export,
   and a 3D drape of the parcel with the vantage marked.

Weights, glassing range, eye height (standing versus tree stand), wind, and hunt
time are all tunable under "Tune the analysis". Any drawn area produces a
shareable URL (the bbox is encoded in the link), so you can send a parcel to a
hunting partner and it re-runs on open.

## Run locally

```sh
npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` produces the static site in
`dist/`. The `/api/tiles` proxy runs as a Vercel serverless function in
production and as Vite dev middleware locally (see `vite.config.js`), so behavior
is identical in both.

## Deploy

This repo is connected to Vercel, so pushing to `master` deploys automatically.
To set it up fresh: import the repo into Vercel (framework preset Vite), or run
`vercel` from the repo root. `vercel.json` pins the build and the tile-proxy
function.

## Caveats

- Tree classification is leaf-on and summer-biased, so deciduous winter cover is
  under-counted. Canopy height is an assumption that scales with density. Swap in
  a real canopy-height raster for sharper occlusion.
- The DEM is bare-earth, so you correctly see game on the ground; trees are added
  as the occluder on top.
- Not legal or safety advice. It models sightlines, not legal shooting hours,
  property boundaries, or safe backstops. Hunt responsibly.

## Acknowledgements

- Built with the help of Claude Opus 4.8 (Anthropic), running in Claude Code. The
  data pipeline, viewshed engine, scoring, UI, tests, and deployment were all
  produced in that session.
- Based on and inspired by
  [ode-to-yosemite](https://github.com/shlokkhemani/ode-to-yosemite) by Shlok
  Khemani. The keyless terrain and satellite tile pipeline, the Terrarium
  elevation decode, and the canopy-from-imagery classifier are adapted from that
  project. Huge thanks and full credit to that work for showing what was possible
  and giving this app its foundation.

## Attribution

Elevation: Mapzen/AWS Terrain Tiles. Imagery: Esri, Maxar, Earthstar Geographics.
Geocoding: OpenStreetMap and Nominatim.
