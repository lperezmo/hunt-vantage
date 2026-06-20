// Optional 3D "stand-eye" view: drape the parcel's satellite imagery over its
// real elevation, mark the chosen vantage, and shade what it can see. Ported in
// spirit from ode-to-yosemite's terrain renderer, scaled down to one parcel.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let renderer, raf, controls;

export function openViewer(canvas, result, spot) {
  disposeViewer();

  const { gridW, gridH, heights, metersPerPx, forest } = result;
  const W = (gridW - 1) * metersPerPx;
  const H = (gridH - 1) * metersPerPx;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb4d6);
  scene.fog = new THREE.Fog(0x8fb4d6, W * 0.9, W * 3.2);

  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight || 1.6, 1, 60000);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  resize(renderer, camera, canvas);

  scene.add(new THREE.HemisphereLight(0xddeeff, 0x46402f, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.3);
  sun.position.set(-1, 1.4, 0.6);
  scene.add(sun);

  // ---- terrain mesh (origin at grid centre, +x east, +z south, +y up) ----
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(gridW * gridH * 3);
  const uv = new Float32Array(gridW * gridH * 2);
  const halfW = W / 2, halfH = H / 2;
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      const i = r * gridW + c;
      pos[i * 3] = c * metersPerPx - halfW;
      pos[i * 3 + 1] = heights[i];
      pos[i * 3 + 2] = r * metersPerPx - halfH;
      uv[i * 2] = c / (gridW - 1);
      uv[i * 2 + 1] = 1 - r / (gridH - 1);
    }
  }
  const idx = [];
  for (let r = 0; r < gridH - 1; r++) {
    for (let c = 0; c < gridW - 1; c++) {
      const a = r * gridW + c;
      idx.push(a, a + gridW, a + 1, a + 1, a + gridW, a + gridW + 1);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(gridW * gridH > 65000 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const texture = buildTexture(result, spot);
  const mat = new THREE.MeshLambertMaterial({ map: texture });
  scene.add(new THREE.Mesh(geo, mat));

  // ---- vantage marker ----
  const vWorld = new THREE.Vector3(
    spot.ox * metersPerPx - halfW,
    heights[spot.oy * gridW + spot.ox],
    spot.oy * metersPerPx - halfH
  );
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(8, W * 0.012), Math.max(28, W * 0.04), 4),
    new THREE.MeshBasicMaterial({ color: 0xb6e06a })
  );
  marker.position.copy(vWorld).y += Math.max(28, W * 0.04) / 2 + 6;
  scene.add(marker);
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, Math.max(28, W * 0.04), 6),
    new THREE.MeshBasicMaterial({ color: 0x15200a })
  );
  stem.position.copy(vWorld).y += Math.max(28, W * 0.04) / 2 + 6;
  scene.add(stem);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(vWorld);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  const back = Math.max(W, H) * 0.55;
  camera.position.set(vWorld.x - back * 0.4, vWorld.y + back * 0.6, vWorld.z + back * 0.7);
  controls.update();

  const onResize = () => resize(renderer, camera, canvas);
  window.addEventListener('resize', onResize);
  renderer._onResize = onResize;

  const loop = () => {
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
}

function resize(renderer, camera, canvas) {
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Imagery texture with the viewshed footprint tinted cyan on top.
function buildTexture(result, spot) {
  const { gridW, gridH, texBitmap, texW, texH } = result;
  const tw = texBitmap ? texW : gridW;
  const th = texBitmap ? texH : gridH;
  const cv = document.createElement('canvas');
  cv.width = tw; cv.height = th;
  const ctx = cv.getContext('2d');
  if (texBitmap) {
    ctx.drawImage(texBitmap, 0, 0);
  } else {
    // fallback: paint forest density green
    const img = ctx.createImageData(gridW, gridH);
    for (let i = 0; i < gridW * gridH; i++) {
      const f = result.forest[i] / 255;
      img.data[i * 4] = 90 - f * 40; img.data[i * 4 + 1] = 110 + f * 70; img.data[i * 4 + 2] = 70; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  // overlay footprint (scaled from grid res to texture res)
  const fp = spot.footprint;
  const ov = document.createElement('canvas');
  ov.width = gridW; ov.height = gridH;
  const octx = ov.getContext('2d');
  const oimg = octx.createImageData(gridW, gridH);
  for (let i = 0; i < fp.length; i++) {
    if (fp[i]) { oimg.data[i * 4] = 120; oimg.data[i * 4 + 1] = 220; oimg.data[i * 4 + 2] = 255; oimg.data[i * 4 + 3] = 90; }
  }
  octx.putImageData(oimg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(ov, 0, 0, tw, th);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function disposeViewer() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (controls) { controls.dispose(); controls = null; }
  if (renderer) {
    if (renderer._onResize) window.removeEventListener('resize', renderer._onResize);
    renderer.dispose();
    renderer = null;
  }
}
