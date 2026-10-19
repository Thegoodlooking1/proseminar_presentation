/* Sound Topographies – main.js (Version 1: line skeleton)
   - Vite + Three.js 0.180.x
   - Terrain rendered as wireframe only (skeleton)
   - City markers in wireframe
   - Ribbons as lines
   - Static wave (no pulse animation)
   - Screenshot key: S
*/

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';

async function loadCSVDataset(path) {
  const res = await fetch(path);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) {
    console.warn('[DATA] Empty CSV at', path);
    return { freq: new Map(), total: 0 };
  }

  // normalize header to lowercase for matching
  const header = lines.shift().split(',').map(h => h.trim().toLowerCase());

  const iPhon = header.findIndex(h => h === 'phoneme');
  let iFreq   = header.findIndex(h => h === 'frequency');

  // Fallbacks: freq, count, prob, value, or just "the second column"
  if (iFreq === -1) {
    const candidates = ['freq', 'count', 'prob', 'value'];
    for (const name of candidates) {
      const idx = header.findIndex(h => h === name);
      if (idx !== -1) { iFreq = idx; break; }
    }
  }
  if (iFreq === -1 && header.length > 1) {
    // last-ditch: assume column 1 is the numeric one
    iFreq = 1;
  }

  if (iPhon === -1 || iFreq === -1) {
    console.warn('[DATA] Could not find phoneme/frequency columns in', path, 'header =', header);
    return { freq: new Map(), total: 0 };
  }

  const map = new Map();
  let total = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const phon = cols[iPhon]?.trim();
    const raw  = cols[iFreq] ?? '';
    const freq = Number(raw);

    if (!phon || !Number.isFinite(freq)) continue;
    map.set(phon, (map.get(phon) || 0) + freq);
    total += freq;
  }

  // normalize to probabilities
  if (total > 0) {
    for (const [k, v] of map) map.set(k, v / total);
  }

  console.log('[DATA] Parsed', path, 'unique phonemes:', map.size, 'total raw:', total);
  return { freq: map, total };
}

// Global re-displace + recolor (safe to call anytime)
function reDisplaceAndRecolor() {
  if (!terrainGeometry) return;

  // 1) geometry
  displaceTerrain(terrainGeometry, { ...CONFIG.TERRAIN });
  terrainGeometry.computeVertexNormals();

  {
    const pos = terrainGeometry.attributes.position;
    const y0 = pos.getY(0), y1 = pos.getY(pos.count - 1);
    console.log('[REDISP]', 'y0=', y0.toFixed(3), 'yN=', y1.toFixed(3),
                't=', (window.__timeDriftValue||0).toFixed(2),
                'W=', JSON.stringify(CONFIG.UI?.weights),
                'inf=', CONFIG.TERRAIN.dataInfluence);
  }

  // 2) base colors (still computed but not visible in line mode)
  (CONFIG.TERRAIN.useWidthTint ? applyHeightAndWidthColors : applyElevationColors)(terrainGeometry);

  // 3) overlays (colors only; won’t affect wireframe)
  const heatToggle = document.getElementById('transitionHeat');
  const heatOn = !!(heatToggle && heatToggle.checked);
  if (!heatOn) applyDataInfluenceOverlay(terrainGeometry, 0.35);
  else applyTransitionHeatmap?.(terrainGeometry);

  // 4) snapshot base vertex colors for audio colour modulation (unused in line view, but harmless)
  const colAttr = terrainGeometry.getAttribute('color');
  if (colAttr && colAttr.array) {
    if (!BASE_COLORS || BASE_COLORS.length !== colAttr.array.length) {
      BASE_COLORS = new Float32Array(colAttr.array.length);
    }
    BASE_COLORS.set(colAttr.array);
  }

  // 5) refresh audio baseline
  const pos = terrainGeometry.attributes.position;
  AUDIO.restY = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) AUDIO.restY[i] = pos.getY(i);
}

// make it callable from anywhere (UI handlers will call this)
window.reDisplaceAndRecolor = reDisplaceAndRecolor;

async function bootDataFromCSVs() {
  const limboo = await loadCSVDataset('/data/Limboo.csv');
  const bhutia = await loadCSVDataset('/data/Bhutia.csv');

  DATA_A = limboo;
  DATA_B = bhutia;
  DATA   = DATA_A;

  computeClassCoeffs?.();

  console.log('[DATA] Loaded:', { limboo, bhutia });
  console.log('[DATA] CLASS_COEFFS =', CLASS_COEFFS);

  // first paint
  reDisplaceAndRecolor?.();
}

// -------------------------
// Config
// -------------------------
const CONFIG = {
  MAP_TEXTURE: '/assets/silk_route_map.jpeg', // unused, kept for bounds
  SCENE_BG: 0x0b0f14,
  TERRAIN: {
    width: 200,
    depth: 140,
    segmentsX: 240,
    segmentsZ: 180,
    heightScale: 28,
    noiseScale: 0.06,
    ridgeBias: 0.4,      // 0..1
    useWidthTint: true,
    dataInfluence: 0.5,  // 0..1 (slider)
  },
  MAP_PLANE: {
    width: 220,
    height: 160,
    elevationOffset: -0.6,
  },
  LIGHTS: {
    ambient: 0x556677,
    dir: 0xffffff,
    dirIntensity: 1.1,
  },
  CITIES: [
    { name: "Xi'an", lon: 108.9398, lat: 34.3416 },
    { name: 'Lhasa', lon: 91.1175, lat: 29.6469 },
    { name: 'Kathmandu', lon: 85.3240, lat: 27.7172 },
    { name: 'Gangtok', lon: 88.6130, lat: 27.3389 },
    { name: 'Thimphu', lon: 89.6480, lat: 27.4728 },
  ],
  MAP_BOUNDS: {
    lonMin: 70.0, lonMax: 120.0,
    latMin: 20.0, latMax: 45.0,
  },
  UI: {
    weights: { vowels: 1.0, sibilants: 1.0, nasals: 1.0, stops: 1.0 },
    regional: { enabled: false, alpha: 0.6 } // mix strength: 0..1
  },
};

// -------------------------
// Globals
// -------------------------
let renderer, scene, camera, controls;
let terrainMesh, terrainGeometry;
let cityGroup, ribbonGroup, labelGroup;
let clock;
let NOISE_SEED = 1337; // changes noise field reproducibly
let CLASS_COEFFS = null; // { A:{v,s,n,tp}, B:{v,s,n,tp}, D:{v,s,n,tp} }  // D = B−A
let BASE_COLORS = null;   // Float32Array snapshot of per-vertex RGB (after base recolor)
let DATA_A = null, DATA_B = null, DATA = null;

// Pulse object kept but never used (static wave)
let PULSE = {
  active: false,
  until: 0,
  strength: 0.6,
  restY: null,   // Float32Array snapshot of Y at pulse start
};

let AUDIO = {
  ctx: null,
  src: null,
  analyser: null,
  gain: null,
  buffer: null,
  playing: false,
  level: 0,       // 0..1 smoothed
  smooth: 0.15,   // smoothing factor for visual stability
  amp: 0.18,      // terrain modulation strength (world units)
  restY: null,    // snapshot of terrain Y for continuous modulation
};
AUDIO.forceBypass = true; // disable audio geometry writes
AUDIO.amp = 0.75;
AUDIO.smooth = 0.06;

// Each anchor has a lon/lat and a target drift t (0=Limboo, 1=Bhutia)
const REGION_ANCHORS = [
  { name: "Lhasa",    lon: 91.1175, lat: 29.6469, t: 0.20 },
  { name: "Kathmandu",lon: 85.3240, lat: 27.7172, t: 0.55 },
  { name: "Gangtok",  lon: 88.6130, lat: 27.3389, t: 0.35 },
  { name: "Thimphu",  lon: 89.6480, lat: 27.4728, t: 0.40 },
  { name: "Xi'an",    lon:108.9398, lat: 34.3416, t: 0.80 },
];

let REGION_POINTS = []; // filled at init after we have lonLatToXZ

// debug helpers for audio
const __audioTmp = { arr: null, td: null };
let __frames = 0;

const AUDIOFX = { lastLevel: 0, beat: 0 }; // beat = short burst envelope

function getF(map, k) { return (map && map.freq && typeof map.freq.get === 'function') ? (map.freq.get(k) || 0) : 0; }

function classScoresForT(t) {
  if (!CLASS_COEFFS) {
    return { v: 0, s: 0, n: 0, tp: 0 };
  }
  const { A, D } = CLASS_COEFFS;
  // A + t*(B−A)
  return {
    v: A.v  + t * D.v,
    s: A.s  + t * D.s,
    n: A.n  + t * D.n,
    tp: A.tp + t * D.tp,
  };
}

function dataHeightFromScores(scores) {
  const W = CONFIG.UI.weights;
  // same semantics you already use: vowels/nasals lift, sibilants/stops erode
  return (scores.v * 0.6 * W.vowels) + (scores.n * 0.3 * W.nasals)
       - (scores.s * 0.5 * W.sibilants) - (scores.tp * 0.25 * W.stops);
}

function computeClassCoeffs() {
  if (!DATA_A || !DATA_B) { CLASS_COEFFS = null; return; }

  const pick = (D, keys) => {
    let s = 0, c = 0;
    for (const k of keys) { s += (D.freq.get(k) || 0); c++; }
    return c ? s / c : 0;
  };

  const VOW = ['a','e','i','o','u'];
  const SIB = ['s','sh','z'];
  const NAS = ['m','n','ng'];
  const STP = ['p','b','t','d','k','g'];

  const A = {
    v: pick(DATA_A, VOW),
    s: pick(DATA_A, SIB),
    n: pick(DATA_A, NAS),
    tp: pick(DATA_A, STP)
  };
  const B = {
    v: pick(DATA_B, VOW),
    s: pick(DATA_B, SIB),
    n: pick(DATA_B, NAS),
    tp: pick(DATA_B, STP)
  };
  const D = { v: B.v - A.v, s: B.s - A.s, n: B.n - A.n, tp: B.tp - A.tp };
  CLASS_COEFFS = { A, B, D };
}

// -------------------------
// Boot
// -------------------------
start();
async function start() {
  await init();
  animate();
}

function installAudioDebug() {
  // small on-screen meter
  const el = document.createElement('div');
  el.id = 'audioMeter';
  el.style.cssText = 'position:fixed;left:10px;bottom:10px;padding:6px 10px;background:#0008;color:#0f0;font:12px monospace;z-index:9999;border-radius:6px;';
  document.body.appendChild(el);

  // heartbeat: shows if update loop and analyser are alive
  setInterval(() => {
    const lvl = (AUDIO?.level ?? 0).toFixed(3);
    el.textContent = `[AUDIO] playing:${!!AUDIO?.playing} level:${lvl} frames:${__frames}`;
    console.log('[AUDIO TICK]', { playing: !!AUDIO?.playing, level: +lvl, frames: __frames, hasAnalyser: !!AUDIO?.analyser });
    __frames = 0;
  }, 1000);
}

async function init() {
  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(CONFIG.SCENE_BG, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(CONFIG.SCENE_BG, 0.006);

  await bootDataFromCSVs();

  // Camera
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(0, 160, 220);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.35;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 60;
  controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI * 0.495;

  // Lights (minimal, won’t affect basic line material much but kept for future)
  const amb = new THREE.AmbientLight(0x223344, 0.6);
  scene.add(amb);

  const hemi = new THREE.HemisphereLight(0xe0ecff, 0x0b0f14, 0.35);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(120, 220, 140);

  // enable shadows for this light
  dir.castShadow = true;

  // shadow quality + bounds
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 10;
  dir.shadow.camera.far  = 800;
  dir.shadow.camera.left   = -250;
  dir.shadow.camera.right  =  250;
  dir.shadow.camera.top    =  250;
  dir.shadow.camera.bottom = -250;

scene.add(dir);


  // Groups
  cityGroup = new THREE.Group();
  ribbonGroup = new THREE.Group();
  labelGroup = new THREE.Group();
  scene.add(cityGroup, ribbonGroup, labelGroup);
  
  REGION_POINTS = REGION_ANCHORS.map(a => {
    const p = lonLatToXZ(a.lon, a.lat);
    return { x: p.x, z: p.z, t: a.t };
  });

  // Terrain
  regenerate();

  // UI
  wireUI();
  window.addEventListener('resize', onResize);

  installAudioDebug();
}

// ---------------------------------------------
// Auto-scale city labels to stay readable (labels disabled for V1)
// ---------------------------------------------
function updateLabelScales() {
  // We’re not adding label sprites in V1, so this can stay no-op in practice
  if (!labelGroup) return;
}

// Pulse functions kept but never used (static)
function easeOutSine(t) { return Math.sin((t * Math.PI) / 2); }

// -------------------------
// AUDIO helpers (mostly kept for future versions)
// -------------------------
async function loadAudioFromFile(file) {
  if (!file) return;
  if (!AUDIO.ctx) AUDIO.ctx = new (window.AudioContext || window.webkitAudioContext)();

  try {
    const arr = await file.arrayBuffer();
    const buf = await AUDIO.ctx.decodeAudioData(arr);
    AUDIO.buffer = buf;

    ensureAudioPipeline();
    AUDIO.playing = false;

    if (!AUDIO.gain) AUDIO.gain = AUDIO.ctx.createGain();
    AUDIO.gain.gain.value = 0.85;

    if (!AUDIO.analyser) {
      AUDIO.analyser = AUDIO.ctx.createAnalyser();
      AUDIO.analyser.fftSize = 1024;
    }

    AUDIO.gain.disconnect();
    AUDIO.gain.connect(AUDIO.analyser);
    AUDIO.analyser.disconnect();
    AUDIO.analyser.connect(AUDIO.ctx.destination);

    AUDIO.playing = false;
    console.log('[Audio] Loaded file:', file.name, 'duration(s):', buf.duration.toFixed(2));
  } catch (err) {
    console.error('[Audio] Failed to decode file:', err);
  }
}

async function toggleAudioPlay() {
  if (!AUDIO.ctx || !AUDIO.buffer) return;

  try { await AUDIO.ctx.resume(); } catch(e) { console.warn('AudioContext resume failed:', e); }

  if (!AUDIO.playing) {
    await AUDIO.ctx.resume?.();
    ensureAudioPipeline();
    
    const src = AUDIO.ctx.createBufferSource();
    src.buffer = AUDIO.buffer;
    src.loop = true;

    src.connect(AUDIO.gain);
    AUDIO.src = src;

    if (terrainGeometry) {
      const pos = terrainGeometry.attributes.position;
      AUDIO.restY = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) AUDIO.restY[i] = pos.getY(i);
    }

    src.start(0);
    AUDIO.playing = true;
    console.log('[Audio] Playback started');
  } else {
    try { AUDIO.src && AUDIO.src.stop(0); } catch {}
    AUDIO.playing = false;

    if (terrainGeometry && AUDIO.restY) {
      const pos = terrainGeometry.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, AUDIO.restY[i]);
      pos.needsUpdate = true;
      terrainGeometry.computeVertexNormals();
    }
    console.log('[Audio] Playback stopped');
  }
}

function updateAudioTerrainModulation() {
  // Bypassed in Version 1
  return;
}

function updateAudioVisuals() {
  // No emissive material or exposure modulation needed for line view
  return;
}

let __colorTick = 0;
const __tmpColor = new THREE.Color();
function modulateVertexColorsFromAudio(geometry) {
  // No effect in Version 1 (wireframe only)
  return;
}

function animate() {
  requestAnimationFrame(animate);
  __frames++;

  controls.update();

  // Audio pipeline kept but disabled visually/geom
  // updateAudioLevel?.();
  // updateAudioTerrainModulation?.();
  // updateAudioVisuals?.();
  // modulateVertexColorsFromAudio?.(terrainGeometry);

  // No pulse animation in V1 → static wave
  // updatePulse?.();

  updateLabelScales?.();

  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// -------------------------
// Terrain pipeline
// -------------------------
function regenerate() {
  if (terrainMesh) {
    terrainMesh.geometry.dispose();
    terrainMesh.material.dispose();
    scene.remove(terrainMesh);
  }

  terrainGeometry = new THREE.PlaneGeometry(
    CONFIG.TERRAIN.width,
    CONFIG.TERRAIN.depth,
    CONFIG.TERRAIN.segmentsX,
    CONFIG.TERRAIN.segmentsZ
  );
  terrainGeometry.rotateX(-Math.PI / 2);

  displaceTerrain(terrainGeometry, {
    noiseScale: CONFIG.TERRAIN.noiseScale,
    heightScale: CONFIG.TERRAIN.heightScale,
    ridgeBias: CONFIG.TERRAIN.ridgeBias,
  });

  recomputeRidgeSizing(terrainGeometry);

  // ⬇️ KEY PART: line-only skeleton
  const terrainMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,     // <-- uses your color attribute
  roughness: 0.95,        // terrain = matte
  metalness: 0.0,         // no metal
  flatShading: false      // smooth shading (set true for stylized faceted mountains)
  });



  terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrainMesh.castShadow = false;
  terrainMesh.receiveShadow = true;

  scene.add(terrainMesh);

  // Base coloring + overlays still run for internal logic (not visible)
  if (CONFIG.TERRAIN.useWidthTint) applyHeightAndWidthColors(terrainGeometry);
  else applyElevationColors(terrainGeometry);

  applyDataInfluenceOverlay(terrainGeometry, 0.35);

  rebuildCitiesAndRibbons();
  frameCameraToTerrain();
}

function makeSeededNoise(seed) {
  let s = seed >>> 0;
  function rnd() { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; }
  const dx = rnd() * 1000, dz = rnd() * 1000;
  const perlin = new ImprovedNoise();
  return {
    noise(x, y, z) { return perlin.noise(x + dx, y, z + dz); }
  };
}

function regionalT(x, z) {
  if (!CONFIG.UI.regional.enabled || REGION_POINTS.length === 0) return null;
  let num = 0, den = 0;
  for (const p of REGION_POINTS) {
    const dx = x - p.x, dz = z - p.z;
    const d2 = dx*dx + dz*dz;
    const w = 1.0 / Math.max(1e-3, d2);
    num += w * p.t;
    den += w;
  }
  return den > 0 ? (num / den) : null;
}

function displaceTerrain(geometry, opts) {
  if (!geometry) return;

  const p = opts || {};
  const noiseScale  = (p.noiseScale  !== undefined) ? p.noiseScale  : CONFIG.TERRAIN.noiseScale;
  const heightScale = (p.heightScale !== undefined) ? p.heightScale : CONFIG.TERRAIN.heightScale;
  const ridgeBias   = (p.ridgeBias   !== undefined) ? p.ridgeBias   : CONFIG.TERRAIN.ridgeBias;
  const influence   = (CONFIG.TERRAIN.dataInfluence ?? 0.5);

  const position = geometry.attributes.position;
  const perlin   = makeSeededNoise(NOISE_SEED);
  const ridgeExp = THREE.MathUtils.lerp(1.0, 0.65, ridgeBias);

  const tGlobal  = (window.__timeDriftValue || 0);
  const useRegional   = !!(CONFIG.UI?.regional?.enabled);
  const alphaRegional = (CONFIG.UI?.regional?.alpha ?? 0.6);

  const C = CLASS_COEFFS || { A:{v:0,s:0,n:0,tp:0}, D:{v:0,s:0,n:0,tp:0} };
  const A = C.A, D = C.D;
  const W = CONFIG.UI?.weights || { vowels:1, sibilants:1, nasals:1, stops:1 };

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);

    const nx = x * noiseScale;
    const nz = z * noiseScale;
    const n1 = perlin.noise(nx,          0, nz);
    const n2 = perlin.noise(nx * 2.03,   0, nz * 2.03) * 0.5;
    const n3 = perlin.noise(nx * 4.07,   0, nz * 4.07) * 0.25;
    let n = (n1 + n2 + n3) / (1 + 0.5 + 0.25);
    n = Math.sign(n) * Math.pow(Math.abs(n), ridgeExp);
    const baseH = n * heightScale;

    const tRegional = useRegional ? regionalT(x, z) : null;
    const tLocal = (tRegional == null)
      ? tGlobal
      : THREE.MathUtils.lerp(tGlobal, tRegional, alphaRegional);

    const vCls  = A.v  + tLocal * D.v;
    const sCls  = A.s  + tLocal * D.s;
    const nCls  = A.n  + tLocal * D.n;
    const tpCls = A.tp + tLocal * D.tp;

    const Wv = (W.vowels    ?? 1);
    const Ws = (W.sibilants ?? 1);
    const Wn = (W.nasals    ?? 1);
    const Wt = (W.stops     ?? 1);

    const baseMod =
        (vCls * 0.6) +
        (nCls * 0.3) -
        (sCls * 0.5) -
        (tpCls * 0.25);

    const boostMod =
        (vCls * 2.0 * (Wv - 1)) +
        (nCls * 1.4 * (Wn - 1)) -
        (sCls * 1.8 * (Ws - 1)) -
        (tpCls * 1.2 * (Wt - 1));

    const dataMod = baseMod + boostMod;
    const fallback = (!CLASS_COEFFS) ? (dataHeightMod(x, z)) : 0;
    const dataH = (dataMod + fallback) * heightScale * (influence * 4.0);
    position.setY(i, baseH + dataH);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
}

function recomputeRidgeSizing(geometry) {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const targetMaxY = CONFIG.TERRAIN.heightScale;
  const currentMaxY = bbox.max.y;
  if (currentMaxY === 0) return;
  const s = targetMaxY / currentMaxY;

  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i), pos.getY(i) * s, pos.getZ(i));
  }
  pos.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
}

// -------------------------
// Palettes + color ramps (still here but invisible on wireframe)
// -------------------------
function getBasePalette(name) {
  switch (name) {
    case 'monsoon':
      return [
        { t:0.00, color:new THREE.Color('#052b36') },
        { t:0.25, color:new THREE.Color('#1f6f7a') },
        { t:0.40, color:new THREE.Color('#2f9e44') },
        { t:0.60, color:new THREE.Color('#85d1a0') },
        { t:0.78, color:new THREE.Color('#a9d6cb') },
        { t:0.92, color:new THREE.Color('#cbd5d8') },
        { t:1.00, color:new THREE.Color('#ffffff') },
      ];
    case 'autumn':
      return [
        { t:0.00, color:new THREE.Color('#082f49') },
        { t:0.25, color:new THREE.Color('#225e73') },
        { t:0.40, color:new THREE.Color('#8c510a') },
        { t:0.60, color:new THREE.Color('#d08b2e') },
        { t:0.78, color:new THREE.Color('#e9c46a') },
        { t:0.92, color:new THREE.Color('#9e9e9e') },
        { t:1.00, color:new THREE.Color('#f2f2f2') },
      ];
    case 'snow':
      return [
        { t:0.00, color:new THREE.Color('#1b2838') },
        { t:0.25, color:new THREE.Color('#32526b') },
        { t:0.40, color:new THREE.Color('#6c92b8') },
        { t:0.60, color:new THREE.Color('#b9d2f0') },
        { t:0.78, color:new THREE.Color('#dfe9f8') },
        { t:0.92, color:new THREE.Color('#f5f7fb') },
        { t:1.00, color:new THREE.Color('#ffffff') },
      ];
    default: // spring
      return [
        { t:0.00, color:new THREE.Color('#0b3d91') },
        { t:0.25, color:new THREE.Color('#41b6c4') },
        { t:0.40, color:new THREE.Color('#2ca25f') },
        { t:0.60, color:new THREE.Color('#a1d99b') },
        { t:0.78, color:new THREE.Color('#c2b280') },
        { t:0.92, color:new THREE.Color('#8c8c8c') },
        { t:1.00, color:new THREE.Color('#ffffff') },
      ];
  }
}

function getColorStopsForDrift(t) {
  const A = getBasePalette(CONFIG.UI.palette);
  const B = getBasePalette('autumn');
  const stops = A.map((s, i) => ({
    t: s.t,
    color: s.color.clone().lerp(B[i].color, t)
  }));

  const v = DATA ? (((DATA.freq.get('a')||0)+(DATA.freq.get('i')||0)+(DATA.freq.get('u')||0))/3) : 0;
  for (const st of stops) {
    const hsl = {h:0,s:0,l:0};
    st.color.getHSL(hsl);
    st.color.setHSL(THREE.MathUtils.clamp(hsl.h - 0.03*v,0,1), hsl.s, hsl.l);
  }
  return stops;
}

function applyElevationColors(geometry, options) {
  const opts = options || {};
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const minY = (opts.minY !== undefined ? opts.minY : bbox.min.y);
  const maxY = (opts.maxY !== undefined ? opts.maxY : bbox.max.y);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const stops = opts.stops || getColorStopsForDrift(window.__timeDriftValue || 0);

  function sampleRamp(tNorm) {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (tNorm >= a.t && tNorm <= b.t) {
        const localT = (tNorm - a.t) / (b.t - a.t);
        return a.color.clone().lerp(b.color, localT);
      }
    }
    return (tNorm < stops[0].t) ? stops[0].color.clone() : stops[stops.length - 1].color.clone();
  }

  const pos = geometry.attributes.position.array;
  const vertCount = pos.length / 3;
  let colorAttr = geometry.getAttribute('color');
  if (!colorAttr || colorAttr.count !== vertCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    geometry.setAttribute('color', colorAttr);
  }
  const colors = colorAttr.array;

  const denom = (maxY - minY) || 1.0;
  for (let i = 0; i < vertCount; i++) {
    const y = pos[i * 3 + 1];
    const t = clamp((y - minY) / denom, 0, 1);
    const c = sampleRamp(t);
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  colorAttr.needsUpdate = true;
}

function applyHeightAndWidthColors(geometry) {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const minY = bbox.min.y;
  const maxY = bbox.max.y;
  const cx = (bbox.min.x + bbox.max.x) * 0.5;
  const cz = (bbox.min.z + bbox.max.z) * 0.5;
  const maxR = Math.hypot(bbox.max.x - cx, bbox.max.z - cz) || 1;

  const stops = getColorStopsForDrift(window.__timeDriftValue || 0);

  function sampleRamp(tNorm) {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (tNorm >= a.t && tNorm <= b.t) {
        const local = (tNorm - a.t) / (b.t - a.t);
        return a.color.clone().lerp(b.color, local);
      }
    }
    return (tNorm < stops[0].t) ? stops[0].color.clone() : stops[stops.length - 1].color.clone();
  }

  const pos = geometry.attributes.position.array;
  const vertCount = pos.length / 3;
  let colorAttr = geometry.getAttribute('color');
  if (!colorAttr || colorAttr.count !== vertCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    geometry.setAttribute('color', colorAttr);
  }
  const colors = colorAttr.array;

  for (let i = 0; i < vertCount; i++) {
    const x = pos[i * 3 + 0];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];

    const tH = (y - minY) / ((maxY - minY) || 1);
    const r = Math.hypot(x - cx, z - cz) / maxR;

    const base = sampleRamp(THREE.MathUtils.clamp(tH, 0, 1));
    const tint = new THREE.Color().setHSL(0.58 + 0.1 * r, 0.45, 0.5);
    const final = base.clone().lerp(tint, 0.22);

    colors[i * 3 + 0] = final.r;
    colors[i * 3 + 1] = final.g;
    colors[i * 3 + 2] = final.b;
  }
  colorAttr.needsUpdate = true;
}

// -------------------------
// Data Influence diagnostic overlay
// -------------------------
function applyDataInfluenceOverlay(geometry, strength = 0.35) {
  const pos = geometry.attributes.position.array;
  const vertCount = pos.length / 3;

  if (CONFIG.TERRAIN.useWidthTint) applyHeightAndWidthColors(geometry);
  else applyElevationColors(geometry);

  let colorAttr = geometry.getAttribute('color');
  if (!colorAttr || colorAttr.count !== vertCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    geometry.setAttribute('color', colorAttr);
  }
  const colors = colorAttr.array;

  for (let i = 0; i < vertCount; i++) {
    const x = pos[i * 3 + 0];
    const z = pos[i * 3 + 2];

    const delta = dataHeightMod(x, z);
    const t = THREE.MathUtils.clamp((delta * 2 + 0.5), 0, 1);
    const up = new THREE.Color(0xff5e5e);
    const down = new THREE.Color(0x4ea3ff);
    const overlay = down.clone().lerp(up, t);

    const r = colors[i*3+0], g = colors[i*3+1], b = colors[i*3+2];
    const base = new THREE.Color(r, g, b);
    base.lerp(overlay, strength * (CONFIG.TERRAIN.dataInfluence ?? 0.5));

    colors[i*3+0] = base.r;
    colors[i*3+1] = base.g;
    colors[i*3+2] = base.b;
  }
  colorAttr.needsUpdate = true;
}

function applyTransitionHeatmap(geometry, intensity = 0.9, gamma = 0.5, threshold = 0.03) {
  if (!DATA_A || !DATA_B) return;

  (CONFIG.TERRAIN.useWidthTint ? applyHeightAndWidthColors : applyElevationColors)(geometry);

  const pos = geometry.attributes.position.array;
  const vertCount = pos.length / 3;

  let colorAttr = geometry.getAttribute('color');
  if (!colorAttr || colorAttr.count !== vertCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    geometry.setAttribute('color', colorAttr);
  }
  const colors = colorAttr.array;

  const eps = 0.05;
  const tGlobal = (window.__timeDriftValue || 0);

  const useRegional = CONFIG.UI?.regional?.enabled;
  const alpha = (CONFIG.UI?.regional?.alpha ?? 0.6);

  const sensitivities = new Float32Array(vertCount);
  let minS = Infinity, maxS = -Infinity;

  for (let i = 0; i < vertCount; i++) {
    const x = pos[i*3+0];
    const z = pos[i*3+2];

    const tReg = useRegional ? regionalT(x, z) : null;
    const t0 = (tReg == null) ? tGlobal : THREE.MathUtils.lerp(tGlobal, tReg, alpha);

    const tA = THREE.MathUtils.clamp(t0 - eps, 0, 1);
    const tB = THREE.MathUtils.clamp(t0 + eps, 0, 1);

    const sA = classScoresForT(tA);
    const sB = classScoresForT(tB);

    const hA = dataHeightFromScores(sA);
    const hB = dataHeightFromScores(sB);

    const sens = Math.abs(hB - hA);
    sensitivities[i] = sens;
    if (sens < minS) minS = sens;
    if (sens > maxS) maxS = sens;
  }

  const range = Math.max(1e-6, maxS - minS);
  for (let i = 0; i < vertCount; i++) {
    let t = (sensitivities[i] - minS) / range;
    if (t < threshold) t = 0;
    t = Math.pow(t, gamma);
    sensitivities[i] = t;
  }

  const cLo = new THREE.Color(0x3a7bd5);
  const cHi = new THREE.Color(0xff00ff);

  for (let i = 0; i < vertCount; i++) {
    const t = sensitivities[i];
    if (t <= 0) continue;

    const overlay = cLo.clone().lerp(cHi, t);

    const r = colors[i*3+0], g = colors[i*3+1], b = colors[i*3+2];
    const base = new THREE.Color(r, g, b);

    const o = overlay.clone().multiplyScalar(t * intensity);
    base.r = 1 - (1 - base.r) * (1 - o.r);
    base.g = 1 - (1 - base.g) * (1 - o.g);
    base.b = 1 - (1 - base.b) * (1 - o.b);

    colors[i*3+0] = base.r;
    colors[i*3+1] = base.g;
    colors[i*3+2] = base.b;
  }
  colorAttr.needsUpdate = true;
}

// -------------------------
// Data layer
// -------------------------
async function loadPhonemeData(url) {
  const txt = await fetch(url).then(r => r.text());
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length === 0) return { freq: new Map(), trans: new Map() };

  const header = lines.shift().split(',').map(s => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const freq = new Map();
  const trans = new Map();

  for (let li = 0; li < lines.length; li++) {
    const cols = lines[li].split(',');
    const p = cols[idx.phoneme] || '';
    const c = Number(cols[idx.count] || '0');
    const from = (idx.from !== undefined) ? (cols[idx.from] || '') : '';
    const to = (idx.to !== undefined) ? (cols[idx.to] || '') : '';
    const pr = Number((idx.prob !== undefined) ? (cols[idx.prob] || '0') : '0');

    if (p) freq.set(p, (freq.get(p) || 0) + (Number.isFinite(c) ? c : 0));
    if (from && to) trans.set(`${from}->${to}`, Number.isFinite(pr) ? pr : 0);
  }

  const max = Math.max(1, ...freq.values());
  for (const k of freq.keys()) freq.set(k, freq.get(k) / max);
  return { freq, trans };
}

async function bootData() {
  try {
    [DATA_A, DATA_B] = await Promise.all([
      loadPhonemeData('/data/limboo.csv'),
      loadPhonemeData('/data/bhutia.csv'),
    ]);
    DATA = DATA_A;
  
    computeClassCoeffs();

    console.log('DATA_A vowels:', DATA_A?.freq.get('a'), 'sibilants:', DATA_A?.freq.get('s'));
    console.log('DATA_B vowels:', DATA_B?.freq.get('a'), 'sibilants:', DATA_B?.freq.get('s'));
  } catch (e) {
    console.warn('Data load failed; proceeding without dataset influence.', e);
    DATA_A = null; DATA_B = null; DATA = null;
  }
}

function lerpData(A, B, t) {
  if (!A || !B) return A || B || null;
  const freq = new Map();
  const keys = new Set([...A.freq.keys(), ...B.freq.keys()]);
  for (const k of keys) {
    const av = A.freq.get(k) || 0;
    const bv = B.freq.get(k) || 0;
    freq.set(k, av * (1 - t) + bv * t);
  }
  return { freq, trans: B.trans };
}

function dataHeightMod(_x, _z) {
  if (!DATA) return 0;
  const W = CONFIG.UI.weights;

  const v = avg([DATA.freq.get('a'), DATA.freq.get('e'), DATA.freq.get('i'), DATA.freq.get('o'), DATA.freq.get('u')]);
  const s = avg([DATA.freq.get('s'), DATA.freq.get('sh'), DATA.freq.get('z')]);
  const n = avg([DATA.freq.get('m'), DATA.freq.get('n'), DATA.freq.get('ng')]);
  const t = avg([DATA.freq.get('p'), DATA.freq.get('b'), DATA.freq.get('t'), DATA.freq.get('d'), DATA.freq.get('k'), DATA.freq.get('g')]);

  return (v * 0.6 * W.vowels) + (n * 0.3 * W.nasals) - (s * 0.5 * W.sibilants) - (t * 0.25 * W.stops);
}
function avg(arr) {
  let sum = 0, c = 0;
  for (const v of arr) { if (typeof v === 'number' && !Number.isNaN(v)) { sum += v; c++; } }
  return c ? sum / c : 0;
}

// -------------------------
// Cities & ribbons
// -------------------------
function rebuildCitiesAndRibbons() {
  for (const g of [cityGroup, ribbonGroup, labelGroup]) {
    while (g.children.length) g.remove(g.children[0]);
  }

  // Wireframe city markers
  CONFIG.CITIES.forEach(addSoundscapeAtLonLat);

  // Line ribbons between cities
  for (let i = 0; i < CONFIG.CITIES.length - 1; i++) {
    const a = lonLatToXZ(CONFIG.CITIES[i].lon, CONFIG.CITIES[i].lat);
    const b = lonLatToXZ(CONFIG.CITIES[i + 1].lon, CONFIG.CITIES[i + 1].lat);
    const line = buildRibbon(a, b);
    ribbonGroup.add(line);
  }
}

function addSoundscapeAtLonLat(city) {
  const p = lonLatToXZ(city.lon, city.lat);
  const y = sampleTerrainHeight(p.x, p.z) + 1.2;

  // Wireframe sphere marker
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffcc66, wireframe: true })
  );
  m.position.set(p.x, y, p.z);
  m.castShadow = false;
  m.receiveShadow = false;
  cityGroup.add(m);

  // No label sprites in Version 1 (pure line-based look)
}

function buildRibbon(a, b) {
  const pts = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = THREE.MathUtils.lerp(a.x, b.x, t);
    const z = THREE.MathUtils.lerp(a.z, b.z, t);
    const y = sampleTerrainHeight(x, z) + 0.4 + Math.sin(t * Math.PI) * 0.8;
    pts.push(new THREE.Vector3(x, y, z));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0xff8855 });
  return new THREE.Line(geo, mat);
}

// -------------------------
// Terrain sampling & geo utils
// -------------------------
function sampleTerrainHeight(x, z) {
  const g = terrainGeometry;
  if (!g) return 0;
  const w = CONFIG.TERRAIN.width;
  const d = CONFIG.TERRAIN.depth;
  const segX = CONFIG.TERRAIN.segmentsX;
  const segZ = CONFIG.TERRAIN.segmentsZ;
  const pos = g.attributes.position;

  const fx = ((x + w / 2) / w) * segX;
  const fz = ((z + d / 2) / d) * segZ;
  const x0 = THREE.MathUtils.clamp(Math.floor(fx), 0, segX);
  const z0 = THREE.MathUtils.clamp(Math.floor(fz), 0, segZ);
  const x1 = THREE.MathUtils.clamp(x0 + 1, 0, segX);
  const z1 = THREE.MathUtils.clamp(z0 + 1, 0, segZ);

  function idx(ix, iz) { return iz * (segX + 1) + ix; }

  const i00 = idx(x0, z0);
  const i10 = idx(x1, z0);
  const i01 = idx(x0, z1);
  const i11 = idx(x1, z1);

  const v00 = pos.getY(i00);
  const v10 = pos.getY(i10);
  const v01 = pos.getY(i01);
  const v11 = pos.getY(i11);

  const tx = fx - x0;
  const tz = fz - z0;
  const v0 = THREE.MathUtils.lerp(v00, v10, tx);
  const v1 = THREE.MathUtils.lerp(v01, v11, tx);
  return THREE.MathUtils.lerp(v0, v1, tz);
}

function lonLatToXZ(lon, lat) {
  const b = CONFIG.MAP_BOUNDS;
  const u = (lon - b.lonMin) / (b.lonMax - b.lonMin);
  const v = 1 - (lat - b.latMin) / (b.latMax - b.latMin);
  const x = (u - 0.5) * CONFIG.MAP_PLANE.width;
  const z = (v - 0.5) * CONFIG.MAP_PLANE.height;
  return { x, z };
}

function frameCameraToTerrain() {
  terrainGeometry.computeBoundingBox();
  const bb = terrainGeometry.boundingBox;
  const size = new THREE.Vector3();
  bb.getSize(size);
  const maxDim = Math.max(size.x, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = maxDim / (2 * Math.tan(fov / 2)) + CONFIG.TERRAIN.heightScale * 1.2;
  camera.position.set(0, dist * 0.85, dist);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

// -------------------------
// Text sprite labels (unused in V1, kept for future)
// -------------------------
function makeTextSprite(message) {
  const fontSize = 90;
  const pad = 20;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  const textW = ctx.measureText(message).width;
  canvas.width = Math.ceil(textW + pad * 2);
  canvas.height = Math.ceil(fontSize + pad * 2);
  const ctx2 = canvas.getContext('2d');
  ctx2.font = `${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  ctx2.fillStyle = 'rgba(255,255,255,0.95)';
  ctx2.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx2.lineWidth = 6;
  ctx2.textBaseline = 'top';
  ctx2.strokeText(message, pad, pad);
  ctx2.fillText(message, pad, pad);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.02;
  sprite.scale.set(canvas.width * scale * 0.08, canvas.height * scale * 0.08, 1);
  return sprite;
}

function ensureAudioPipeline() {
  if (!AUDIO.ctx) AUDIO.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (!AUDIO.gain) AUDIO.gain = AUDIO.ctx.createGain();
  if (!AUDIO.analyser) AUDIO.analyser = AUDIO.ctx.createAnalyser();

  AUDIO.gain.gain.value = 0.85;
  AUDIO.analyser.fftSize = 1024;
  AUDIO.analyser.smoothingTimeConstant = 0;

  try { AUDIO.gain.disconnect(); } catch {}
  try { AUDIO.analyser.disconnect(); } catch {}
  AUDIO.gain.connect(AUDIO.analyser);
  AUDIO.analyser.connect(AUDIO.ctx.destination);
}

function updateAudioLevel() {
  if (!AUDIO?.analyser || !AUDIO?.playing) { AUDIO.level = 0; return; }
  const a = AUDIO.analyser;
  if (!__audioTmp.td || __audioTmp.td.length !== a.fftSize) {
    __audioTmp.td = new Uint8Array(a.fftSize);
  }
  a.getByteTimeDomainData(__audioTmp.td);

  let sum = 0;
  for (let i = 0; i < __audioTmp.td.length; i++) {
    const v = (__audioTmp.td[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / __audioTmp.td.length);
  const s = AUDIO.smooth ?? 0.15;
  AUDIO.level = (AUDIO.level ?? 0) * (1 - s) + rms * s;

  AUDIO.bass = AUDIO.level;
  AUDIO.pres = AUDIO.level * 0.6;
}

// -------------------------
// UI
// -------------------------
function wireUI() {
  const regenBtn        = document.getElementById('regenerateBtn');
  const timeDrift       = document.getElementById('timeDrift');
  const dataInfluence   = document.getElementById('dataInfluence');
  const toggleLabels    = document.getElementById('toggleLabels');
  const toggleRibbons   = document.getElementById('toggleRibbons');
  const recordBtn       = document.getElementById('recordBtn');
  const resetViewBtn    = document.getElementById('resetView');
  const newSeedBtn      = document.getElementById('newSeed');

  const wVowels         = document.getElementById('wVowels');
  const wSibs           = document.getElementById('wSibs');
  const wNasals         = document.getElementById('wNasals');
  const wStops          = document.getElementById('wStops');

  const regionalize     = document.getElementById('regionalize');
  const regionalAlpha   = document.getElementById('regionalAlpha');

  const transitionHeat  = document.getElementById('transitionHeat');

  function recolorBase() {
    (CONFIG.TERRAIN.useWidthTint ? applyHeightAndWidthColors : applyElevationColors)(terrainGeometry);
  }

  let __prevPalette = CONFIG.UI.palette;

  function recolorWithOverlays() {
    const heatOn = !!(transitionHeat && transitionHeat.checked);

    if (heatOn) {
      __prevPalette = CONFIG.UI.palette;
      CONFIG.UI.palette = 'snow';
    } else {
      CONFIG.UI.palette = __prevPalette || CONFIG.UI.palette;
    }

    recolorBase();

    if (!heatOn) applyDataInfluenceOverlay(terrainGeometry, 0.35);
    if (heatOn && typeof applyTransitionHeatmap === 'function') {
      applyTransitionHeatmap(terrainGeometry);
    }

    const colAttr = terrainGeometry.getAttribute('color');
    if (colAttr && colAttr.array) {
      if (!BASE_COLORS || BASE_COLORS.length !== colAttr.array.length) {
        BASE_COLORS = new Float32Array(colAttr.array.length);
      }
      BASE_COLORS.set(colAttr.array);
    }
  }

  // Regenerate button → static re-displace
  if (regenBtn) {
    regenBtn.addEventListener('click', () => {
      window.reDisplaceAndRecolor?.();
    });
  }

  window.__timeDriftValue = 0;
  if (timeDrift) {
    timeDrift.addEventListener('input', (e) => {
      const t = parseFloat(e.target.value || '0');
      console.log('[UI] timeDrift ->', window.__timeDriftValue);
      window.__timeDriftValue = THREE.MathUtils.clamp(t, 0, 1);

      if (DATA_A && DATA_B) DATA = lerpData(DATA_A, DATA_B, t);

      window.reDisplaceAndRecolor?.();
    });
  }

  if (dataInfluence) {
    CONFIG.TERRAIN.dataInfluence = parseFloat(dataInfluence.value || '0.5');
    dataInfluence.addEventListener('input', (e) => {
      CONFIG.TERRAIN.dataInfluence = parseFloat(e.target.value || '0');
      console.log('[UI] dataInfluence ->', CONFIG.TERRAIN.dataInfluence);
      window.reDisplaceAndRecolor?.();
    });
  }

  if (toggleLabels) {
    labelGroup.visible = false; // labels off by default in V1
    toggleLabels.addEventListener('change', (e) => {
      labelGroup.visible = !!e.target.checked;
    });
  }
  if (toggleRibbons) {
    ribbonGroup.visible = !!toggleRibbons.checked;
    toggleRibbons.addEventListener('change', (e) => {
      ribbonGroup.visible = !!e.target.checked;
    });
  }

  if (recordBtn && typeof recordCanvas === 'function') {
    recordBtn.addEventListener('click', () => recordCanvas(20));
  }

  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      frameCameraToTerrain();
    });
  }

  if (typeof NOISE_SEED === 'undefined') window.NOISE_SEED = Math.floor(Math.random() * 1e9);
  if (newSeedBtn) {
    newSeedBtn.addEventListener('click', () => {
      NOISE_SEED = Math.floor(Math.random() * 1e9);
      window.reDisplaceAndRecolor?.();
    });
  }

  function bindWeight(el, key) {
    if (!el) return;
    if (!CONFIG.UI.weights) CONFIG.UI.weights = { vowels: 1, sibilants: 1, nasals: 1, stops: 1 };
    CONFIG.UI.weights[key] = parseFloat(el.value || '1');
    el.addEventListener('input', (e) => {
      CONFIG.UI.weights[key] = parseFloat(e.target.value || '1');
      console.log('[UI] weight change', key, '->', CONFIG.UI.weights[key]);
      window.reDisplaceAndRecolor?.();
    });
  }
  bindWeight(wVowels, 'vowels');
  bindWeight(wSibs,   'sibilants');
  bindWeight(wNasals, 'nasals');
  bindWeight(wStops,  'stops');

  if (regionalize) {
    if (CONFIG.UI?.regional) regionalize.checked = !!CONFIG.UI.regional.enabled;
    regionalize.addEventListener('change', () => {
      if (!CONFIG.UI.regional) CONFIG.UI.regional = { enabled: false, alpha: 0.6 };
      CONFIG.UI.regional.enabled = !!regionalize.checked;
      window.reDisplaceAndRecolor?.();
    });
  }
  if (regionalAlpha) {
    if (CONFIG.UI?.regional && typeof CONFIG.UI.regional.alpha === 'number') {
      regionalAlpha.value = CONFIG.UI.regional.alpha;
    }
    regionalAlpha.addEventListener('input', (e) => {
      if (!CONFIG.UI.regional) CONFIG.UI.regional = { enabled: false, alpha: 0.6 };
      CONFIG.UI.regional.alpha = parseFloat(e.target.value || '0.6');
      window.reDisplaceAndRecolor?.();
    });
  }

  if (transitionHeat) {
    transitionHeat.addEventListener('change', () => {
      recolorWithOverlays();
    });
  }

  // Screenshot key: S
  window.addEventListener('keydown', (ev) => {
    if (ev.key && ev.key.toLowerCase() === 's') {
      const a = document.createElement('a');
      a.download = `sound_topographies_skeleton_${Date.now()}.png`;
      a.href = renderer.domElement.toDataURL('image/png');
      a.click();
    }
  });

  recolorWithOverlays();
}

function recordCanvas(seconds = 6) {
  const stream = renderer.domElement.captureStream(60);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sound_topographies_${Date.now()}.webm`;
    a.click();
  };
  rec.start();
  setTimeout(() => rec.stop(), seconds * 1000);
}
