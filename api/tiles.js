// Vercel serverless function (and Vite dev middleware) that proxies map tiles.
//
// Why a proxy: the analysis reads raw pixel data from elevation + imagery tiles
// (canvas getImageData), which requires CORS-clean responses. This proxy adds
// `Access-Control-Allow-Origin`, edge-caches the tiles, and keeps the upstream
// source swappable without touching the client.
//
//   GET /api/tiles?src=dem|img&z=<z>&x=<x>&y=<y>
//
// Sources (both keyless):
//   dem - AWS Open Data "terrain-tiles", Terrarium-encoded PNG (Mapzen/NASA/USGS)
//   img - Esri World Imagery (note: ArcGIS tile path is /{z}/{y}/{x})

const SOURCES = {
  dem: (z, x, y) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  img: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

const Z_MAX = { dem: 15, img: 19 };

// Upstream call budget. vercel.json allows maxDuration 30s; bailing out well
// before that turns a hung upstream into a handled 502 instead of a platform
// 504 that has burned the whole function budget.
const UPSTREAM_TIMEOUT_MS = 8000;

// Only this site may use the proxy cross-origin. Without an allowlist the
// deployment is a free, CORS-clean, week-cached mirror of Esri imagery and the
// AWS terrain tiles, billed to whoever owns this project.
const ALLOWED_HOSTS =
  /^(hunt-vantage[a-z0-9-]*\.vercel\.app|localhost(:\d+)?|127\.0\.0\.1(:\d+)?|\[::1\](:\d+)?)$/i;

// Returns the value for Access-Control-Allow-Origin, '' when the request is
// same-origin (browsers omit Origin, and no CORS header is needed), or null
// when the origin is not allowed.
function allowedOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return '';
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return null;
  }
  const self = req?.headers?.host;
  if (self && host.toLowerCase() === String(self).toLowerCase()) return origin;
  return ALLOWED_HOSTS.test(host) ? origin : null;
}

const intParam = (params, key) => {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return NaN;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
};

export async function proxyTile(req, res) {
  res.setHeader('Vary', 'Origin');
  const origin = allowedOrigin(req);
  if (origin === null) {
    res.statusCode = 403;
    res.end('origin not allowed');
    return;
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);

  let params;
  try {
    params = new URL(req?.url ?? '', 'http://localhost').searchParams;
  } catch {
    res.statusCode = 400;
    res.end('bad url');
    return;
  }

  const src = params.get('src');
  const z = intParam(params, 'z');
  const x = intParam(params, 'x');
  const y = intParam(params, 'y');
  const make = SOURCES[src];

  if (!make || Number.isNaN(z) || Number.isNaN(x) || Number.isNaN(y)) {
    res.statusCode = 400;
    res.end('expected ?src=dem|img&z&x&y as integers');
    return;
  }
  // Upper bounds matter as much as lower ones: an out-of-range x or y is a
  // guaranteed upstream miss and an unbounded supply of distinct cache keys.
  const span = 2 ** z;
  if (z < 0 || z > (Z_MAX[src] ?? 20) || x < 0 || y < 0 || x >= span || y >= span) {
    res.statusCode = 400;
    res.end('tile out of range');
    return;
  }

  try {
    const upstream = await fetch(make(z, x, y), {
      headers: { 'User-Agent': 'hunt-vantage (github.com/lperezmo/hunt-vantage)' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      res.statusCode = upstream.status;
      res.end(`upstream ${upstream.status}`);
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
    res.statusCode = 200;
    res.end(buf);
  } catch (err) {
    res.statusCode = 502;
    res.end('proxy error: ' + (err?.message || 'unknown'));
  }
}

export default function handler(req, res) {
  return proxyTile(req, res);
}
