// MapLibre map: satellite basemap, geocode search, rectangle drawing, and the
// result overlays (vantage heatmap + selected-spot viewshed footprint + pins).

import maplibregl from 'maplibre-gl';

const SAT_STYLE = {
  version: 8,
  sources: {
    sat: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
};

const corners = (b) => [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];

export function setupMap(onBox) {
  const map = new maplibregl.Map({
    container: 'map',
    style: SAT_STYLE,
    center: [-105.5, 40.3],
    zoom: 11,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-right');

  let drawing = false;
  let startLngLat = null;
  let box = null;
  const markers = [];

  const heatCanvas = document.createElement('canvas');
  const fpCanvas = document.createElement('canvas');

  map.on('load', () => {
    map.addSource('draw', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#b6e06a', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#b6e06a', 'line-width': 2, 'line-dasharray': [2, 1] } });
  });

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function rectFeature(b) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...corners(b), corners(b)[0]]] } }],
    };
  }
  const norm = (a, b) => ({
    west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
  });

  // ---- rectangle drawing ----
  function beginDraw() {
    drawing = true;
    map.getCanvas().style.cursor = 'crosshair';
    map.dragPan.disable();
  }
  function cancelDraw() {
    drawing = false;
    map.getCanvas().style.cursor = '';
    map.dragPan.enable();
  }
  map.on('mousedown', (e) => {
    if (!drawing) return;
    startLngLat = e.lngLat;
  });
  map.on('mousemove', (e) => {
    if (!drawing || !startLngLat) return;
    map.getSource('draw')?.setData(rectFeature(norm(startLngLat, e.lngLat)));
  });
  map.on('mouseup', (e) => {
    if (!drawing || !startLngLat) return;
    box = norm(startLngLat, e.lngLat);
    startLngLat = null;
    cancelDraw();
    map.getSource('draw')?.setData(rectFeature(box));
    onBox(box);
  });

  // ---- overlays ----
  // Run fn once the style is ready (addSource throws otherwise).
  function whenStyle(fn) {
    if (map.isStyleLoaded()) { fn(); return; }
    const h = () => {
      if (map.isStyleLoaded()) { map.off('styledata', h); fn(); }
    };
    map.on('styledata', h);
  }

  function ensureOverlay(id, canvas, b) {
    if (map.getSource(id)) {
      map.getSource(id).setCoordinates(corners(b));
      map.triggerRepaint();
    } else {
      map.addSource(id, { type: 'canvas', canvas, coordinates: corners(b), animate: false });
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': id === 'heat' ? 0.7 : 0.6, 'raster-resampling': 'linear' } });
    }
  }

  function showHeatmap(result) { whenStyle(() => drawHeatmap(result)); }
  function drawHeatmap(result) {
    const { cgW, cgH, heat } = result;
    heatCanvas.width = cgW; heatCanvas.height = cgH;
    const ctx = heatCanvas.getContext('2d');
    const img = ctx.createImageData(cgW, cgH);
    for (let i = 0; i < heat.length; i++) {
      const [r, g, b] = ramp(heat[i]);
      const a = 40 + heat[i] * 180;
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    ensureOverlay('heat', heatCanvas, result.bbox);
    if (map.getLayer('draw-fill')) map.moveLayer('draw-line'); // keep box on top
  }

  function showFootprint(result, spot) { whenStyle(() => drawFootprint(result, spot)); }
  function drawFootprint(result, spot) {
    const { gridW, gridH } = result;
    fpCanvas.width = gridW; fpCanvas.height = gridH;
    const ctx = fpCanvas.getContext('2d');
    const img = ctx.createImageData(gridW, gridH);
    const fp = spot.footprint;
    for (let i = 0; i < fp.length; i++) {
      if (fp[i]) { img.data[i * 4] = 150; img.data[i * 4 + 1] = 225; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 150; }
    }
    ctx.putImageData(img, 0, 0);
    ensureOverlay('fp', fpCanvas, result.bbox);
    if (map.getLayer('draw-line')) map.moveLayer('draw-line');
  }

  function clearMarkers() { markers.forEach((m) => m.remove()); markers.length = 0; }

  function addMarkers(spots, onSelect) {
    clearMarkers();
    spots.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'pin';
      el.textContent = s.rank;
      Object.assign(el.style, {
        width: '26px', height: '26px', borderRadius: '50% 50% 50% 0', transform: 'rotate(-45deg)',
        background: '#b6e06a', color: '#15200a', display: 'grid', placeItems: 'center',
        fontWeight: '700', fontSize: '13px', border: '2px solid #15200a', cursor: 'pointer',
        boxShadow: '0 2px 6px rgba(0,0,0,.5)',
      });
      const inner = document.createElement('span');
      inner.textContent = s.rank; inner.style.transform = 'rotate(45deg)';
      el.textContent = ''; el.appendChild(inner);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(s.rank); });
      const m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([s.lon, s.lat]).addTo(map);
      markers.push(m);
    });
  }

  function clearAll() {
    box = null;
    clearMarkers();
    map.getSource('draw')?.setData(emptyFC());
    for (const id of ['heat', 'fp']) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  async function geocode(q) {
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { const lat = +m[1], lon = +m[2]; map.flyTo({ center: [lon, lat], zoom: 14 }); return true; }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { 'Accept-Language': 'en' },
      });
      const data = await r.json();
      if (!data.length) return false;
      const { lat, lon, boundingbox } = data[0];
      if (boundingbox) {
        map.fitBounds([[+boundingbox[2], +boundingbox[0]], [+boundingbox[3], +boundingbox[1]]], { maxZoom: 14, padding: 40 });
      } else {
        map.flyTo({ center: [+lon, +lat], zoom: 14 });
      }
      return true;
    } catch { return false; }
  }

  function setBox(b, { fit = true } = {}) {
    box = b;
    const apply = () => map.getSource('draw')?.setData(rectFeature(b));
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
    if (fit) map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 0 });
  }

  return {
    map, beginDraw, cancelDraw, geocode, setBox,
    showHeatmap, showFootprint, addMarkers, clearAll,
    getBox: () => box,
    flyToSpot: (s) => map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 14.5) }),
  };
}

// score 0..1 -> red(low) .. yellow .. green(high)
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.5) { const u = t / 0.5; return [217, 105 + u * 90, 74]; }
  const u = (t - 0.5) / 0.5;
  return [217 - u * 74, 195 - u * 4, 74]; // -> green 143,191,79
}
