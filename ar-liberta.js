/* =========================================================
   «A mia figlia Libertà» – AR experience (MindAR + Three.js)

   Loaded on demand by poesia-liberta.js with `import()`, only when the
   visitor taps "Avvia esperienza AR". The bare specifiers "three" and
   "mindar-image-three" are resolved by the <script type="importmap"> in
   poesia-liberta.html.

   How it works, in short:
     1. Ask the browser for the camera (so we can tell "denied" from other errors).
     2. MindAR opens the camera, loads the compiled image target (.mind) and
        tracks it. Whenever the image is seen, MindAR moves an "anchor" (a
        Three.js Group) so that it sits exactly on top of the image.
     3. Our poetic composition lives in a second group, `stage`, that copies the
        anchor's pose while the image is visible. MindAR hides the anchor the
        instant the image is lost; `stage` keeps the last pose instead, so the
        words can fade out slowly rather than vanish.
     4. The play/pause audio button and all messages are plain HTML, handled
        by poesia-liberta.js through the callbacks we receive here.

   The composition, on a soft charcoal veil over the page:
     title and author appear gently, then the key words (WORDS) come one at a
     time, each floating upwards and dissolving as the next one arrives. An
     optional archival picture rests faintly behind the words.

   Anchor coordinates: the image is 1 unit wide, centred on (0,0), and its
   height is `aspect` units. +X is right, +Y is up, +Z comes out of the image
   towards the viewer.
   ========================================================= */

import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

/* ---------- Words revealed one at a time ---------- */
const WORDS = ['LIBERTÀ', 'MEMORIA', 'CASA', 'LONTANANZA', 'RITORNO'];

/* ---------- Tunable look & feel (sizes in "image widths", times in seconds) ---------- */
const DEFAULT_ASPECT = 1;     // image height / width, replaced by the real value after loading
const TITLE_WIDTH = 0.8;      // width of the title line
const TITLE_Y = 0.34;         // title height, in image heights from the centre (0.5 = top edge)
const WORD_WIDTH = 0.86;      // width of the word plane
const WORD_Y = -0.04;         // word height, same unit as TITLE_Y
const TEXT_LIFT = 0.12;       // how far the text hovers in front of the image (+Z)
const WORD_RISE = 0.06;       // how far each word drifts upwards during its life
const PICTURE_WIDTH = 0.8;    // width of the optional archival picture (assets/ar/liberta/figure.png)
const PICTURE_LIFT = 0.04;
const PICTURE_OPACITY = 0.22; // low opacity: it stays behind the words
const VEIL_OPACITY = 0.58;    // charcoal wash over the page, so light text stays readable
const FADE_IN = 1.3;          // easing speeds of the whole composition (lower = slower)
const FADE_OUT = 1.8;

const TITLE_AT = 0.6;         // story timeline
const AUTHOR_AT = 1.9;
const TEXT_FADE = 2.4;        // title / author fade-in duration
const WORDS_AT = 5.5;         // first word appears
const WORD_PERIOD = 4.4;      // time between two words
const WORD_IN = 1.8;
const WORD_OUT = 1.8;
const WORDS_REST = 2.5;       // silence after the last word, then the words begin again
const CYCLE = (WORDS.length - 1) * WORD_PERIOD + WORD_PERIOD + WORD_OUT + WORDS_REST;

const COLORS = { charcoal: '#232a2f', paper: '#fbf9f5', sand: '#cdb59b', beige: '#e8dccb' };
const SERIF = '"Cormorant Garamond", "Iowan Old Style", Georgia, serif';
const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Error with a machine-readable `code`, turned into a friendly message by the page. */
class ARError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

/* ---------- Module state (the scene is built once and reused) ---------- */
let state = null;                  // scene objects, created on first start
let runId = 0;                     // bumped on every start/stop, lets old runs notice they were cancelled
let lastRun = Promise.resolve();   // starts are queued so two never overlap

/* =========================================================
   Public API
   ========================================================= */

/**
 * Start the AR experience.
 * @param {object}   opts
 * @param {HTMLElement} opts.stage       container for the camera video + canvas
 * @param {string}   opts.targetSrc      compiled MindAR target (.mind)
 * @param {string}   [opts.pictureSrc]   optional archival picture shown faintly behind the words
 * @param {string}   opts.title          poem title
 * @param {string}   opts.author         poet
 * @param {string[]} [opts.words]        words revealed one by one (default: WORDS above)
 * @param {(phase:'camera'|'loading'|'scanning')=>void} opts.onPhase
 * @param {()=>void} opts.onFound        image recognised
 * @param {()=>void} opts.onLost         image lost
 * @returns {Promise<void>} resolves when the camera is live and scanning;
 *                          rejects with an ARError (see `code`) otherwise.
 */
export function startAR(opts) {
  const id = ++runId;
  const run = lastRun.catch(() => {}).then(() => doStart(opts, id));
  lastRun = run;
  return run;
}

/** Stop the camera and the render loop. Safe to call at any time, even mid-start. */
export function stopAR() {
  runId++;
  if (!state) return;
  state.renderer.setAnimationLoop(null);
  resetTracking();
  stopMindAR();
}

/**
 * Forget that the image was ever seen. MindAR keeps its own `anchor.visible`
 * flag: if it stayed true after closing the AR layer with the image in view,
 * `onTargetFound` would never fire again on the next visit.
 */
function resetTracking() {
  state.found = false;
  state.fade = 0;
  state.time = 0;
  state.stage.visible = false;
  state.anchor.visible = false;
  state.anchor.group.visible = false;
}

/* =========================================================
   Start-up sequence
   ========================================================= */

async function doStart(opts, id) {
  const cancelled = () => id !== runId;
  if (cancelled()) return;

  // 1. Camera permission. MindAR rejects with no error object when the camera
  //    is denied, so we ask first to be able to explain what went wrong.
  opts.onPhase('camera');
  await requestCamera();
  if (cancelled()) return;

  // 2. Make sure the target file is really there (MindAR's own error is cryptic).
  opts.onPhase('loading');
  await ensureReachable(opts.targetSrc);
  if (cancelled()) return;

  // 3. Build the scene the first time only.
  if (!state) state = await buildScene(opts);
  if (cancelled()) return;
  state.callbacks = opts;
  resetTracking();

  // 4. Start MindAR (opens the camera again, loads the target, begins tracking).
  opts.stage.querySelectorAll('video').forEach((v) => v.remove()); // leftovers from a failed attempt
  try {
    await state.mindar.start();
  } catch (err) {
    stopMindAR();
    throw new ARError('start-failed', err);
  }
  if (cancelled()) {            // closed while it was starting
    stopMindAR();
    return;
  }

  // Now the real target size is known: fit the frame / veil / text to it.
  const dims = state.mindar.controller && state.mindar.controller.markerDimensions;
  if (dims && dims[0] && dims[0][0] > 0) state.setAspect(dims[0][1] / dims[0][0]);

  state.renderer.setAnimationLoop(state.tick);
  opts.onPhase('scanning');
}

/** Ask for the camera once, then release it straight away (MindAR reopens it). */
async function requestCamera() {
  if (!window.isSecureContext) throw new ARError('insecure');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new ARError('unsupported');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },   // rear camera on phones
      audio: false,
    });
  } catch (err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
      case 'PermissionDeniedError':
        throw new ARError('denied', err);
      case 'NotFoundError':
      case 'DevicesNotFoundError':
      case 'OverconstrainedError':
        throw new ARError('no-camera', err);
      default:                                // NotReadableError (camera busy), AbortError, …
        throw new ARError('camera-error', err);
    }
  }
  stream.getTracks().forEach((track) => track.stop());
}

async function ensureReachable(src) {
  let res;
  try {
    res = await fetch(src, { method: 'HEAD' });
  } catch (err) {
    throw new ARError('network', err);
  }
  if (!res.ok && res.status !== 405) throw new ARError('target-missing');
}

function stopMindAR() {
  try {
    state.mindar.stop();        // stops the camera tracks and the tracker
  } catch (err) {
    /* nothing to stop yet: the camera had not started */
  }
}

/* =========================================================
   Scene
   ========================================================= */

const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** Smootherstep: 0 → 1 with a very gentle start and end (museum-slow transitions). */
const ease = (x) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };

async function buildScene(opts) {
  const mindar = new MindARThree({
    container: opts.stage,
    imageTargetSrc: opts.targetSrc,
    maxTrack: 1,
    // We draw our own loading / scanning / error screens in HTML.
    uiLoading: 'no',
    uiScanning: 'no',
    uiError: 'no',
  });
  const { renderer, scene, camera } = mindar;

  // The anchor follows target #0 of the .mind file. It stays empty: MindAR
  // hides it the moment the image is lost, which would cut our fade-out short.
  const anchor = mindar.addAnchor(0);

  // `stage` mirrors the anchor's pose while the image is seen, then keeps it.
  const stage = new THREE.Group();
  stage.matrixAutoUpdate = false;
  stage.visible = false;
  scene.add(stage);

  const words = (opts.words && opts.words.length ? opts.words : WORDS).map((w) => w.toUpperCase());
  await loadFonts([opts.title, opts.author, ...words].join(' '));

  // Every layer is transparent and ordered explicitly: veil < picture < frame < text.
  const layer = (map, width, height, order) => {
    const mat = new THREE.MeshBasicMaterial({ map, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    mesh.renderOrder = order;
    stage.add(mesh);
    return mesh;
  };

  // --- Soft charcoal veil over the page ---
  const veil = layer(makeVeilTexture(), 1, 1, 1);

  // --- Optional archival picture (silently skipped when the file does not exist) ---
  let picture = null;
  let pictureRatio = 1;
  const pictureTexture = await loadOptionalTexture(opts.pictureSrc);
  if (pictureTexture) {
    const img = pictureTexture.image;
    pictureRatio = img.height / img.width;
    picture = layer(pictureTexture, PICTURE_WIDTH, PICTURE_WIDTH * pictureRatio, 2);
  }

  // --- Thin sand-coloured frame around the image ---
  const frameMat = new THREE.LineBasicMaterial({ color: 0xcdb59b, transparent: true, opacity: 0, depthWrite: false });
  const frame = new THREE.LineSegments(new THREE.BufferGeometry(), frameMat);
  frame.renderOrder = 3;
  stage.add(frame);

  // --- Title and author ---
  const titleTex = makeTitleTexture(opts.title);
  const authorTex = makeAuthorTexture(opts.author);
  const titleH = TITLE_WIDTH * titleTex.aspect;
  const authorH = TITLE_WIDTH * authorTex.aspect;
  const title = layer(titleTex.texture, TITLE_WIDTH, titleH, 4);
  const author = layer(authorTex.texture, TITLE_WIDTH, authorH, 4);

  // --- The words: one plane each, so two can cross-fade ---
  const wordTex = makeWordTextures(words);
  const wordH = WORD_WIDTH * wordTex.aspect;
  const wordMeshes = wordTex.textures.map((tex) => layer(tex, WORD_WIDTH, wordH, 5));

  // Positions that depend on the image's height/width ratio.
  let aspect = DEFAULT_ASPECT;
  const setAspect = (a) => {
    aspect = a;
    frame.geometry.dispose();
    frame.geometry = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.03, 1.03 * a));
    veil.scale.set(1.08, 1.08 * a, 1);
    if (picture) picture.scale.setScalar(Math.min(1, (a * 0.9) / (PICTURE_WIDTH * pictureRatio)));
  };
  setAspect(DEFAULT_ASPECT);

  const s = {
    mindar, renderer, anchor, stage, setAspect,
    found: false,
    fade: 0,                 // 0 = invisible, 1 = fully shown; eased towards `found`
    time: 0,                 // seconds of "story" played since the image was recognised
    callbacks: opts,
  };

  // Image recognised / lost. A short loss (a hand passing by) resumes the story
  // where it was; only after a full fade-out does it start again from the title.
  anchor.onTargetFound = () => {
    s.found = true;
    if (s.fade < 0.02) s.time = 0;
    if (s.callbacks.onFound) s.callbacks.onFound();
  };
  anchor.onTargetLost = () => {
    s.found = false;
    if (s.callbacks.onLost) s.callbacks.onLost();
  };

  // Render loop: follow the pose, ease the fade, run the timeline, draw.
  let last = performance.now();
  s.tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);   // seconds, capped after pauses
    last = now;

    s.fade += ((s.found ? 1 : 0) - s.fade) * (1 - Math.exp(-dt * (s.found ? FADE_IN : FADE_OUT)));
    if (s.fade > 0.01) s.time += dt;
    if (anchor.group.visible) stage.matrix.copy(anchor.group.matrix);
    stage.visible = s.fade > 0.002;

    if (stage.visible) {
      const T = s.time;
      const f = s.fade;
      const drift = reduceMotion ? 0 : 1;
      const sway = (speed, phase) => drift * Math.sin(T * speed + phase);

      veil.material.opacity = f * VEIL_OPACITY * ease(T / 3);
      frameMat.opacity = f * 0.5 * ease(T / 2.5);
      if (picture) {
        picture.material.opacity = f * PICTURE_OPACITY * ease((T - 1) / 3.5);
        picture.position.set(sway(0.21, 0) * 0.01, sway(0.17, 1) * 0.01, PICTURE_LIFT);
        picture.rotation.z = sway(0.13, 2) * 0.012;
      }

      // Title and author rise a little as they appear, then recede while the words play.
      const dim = 1 - 0.35 * ease((T - WORDS_AT) / 3);
      const titleIn = ease((T - TITLE_AT) / TEXT_FADE);
      const authorIn = ease((T - AUTHOR_AT) / TEXT_FADE);
      const titleY = aspect * TITLE_Y;
      title.material.opacity = f * titleIn * dim;
      title.position.set(0, titleY - (1 - titleIn) * 0.03 + sway(0.9, 0) * 0.004, TEXT_LIFT);
      author.material.opacity = f * authorIn * dim;
      author.position.set(0, titleY - titleH / 2 - authorH / 2 + 0.02 - (1 - authorIn) * 0.03 + sway(0.9, 0.6) * 0.004, TEXT_LIFT);

      // The words: each fades in, drifts upwards, and dissolves as the next one arrives.
      const tc = T < WORDS_AT ? -1 : (T - WORDS_AT) % CYCLE;
      wordMeshes.forEach((mesh, i) => {
        const u = tc - i * WORD_PERIOD;                       // seconds since this word appeared
        const env = u < 0 ? 0 : ease(u / WORD_IN) * (1 - ease((u - WORD_PERIOD) / WORD_OUT));
        mesh.material.opacity = f * env;
        mesh.visible = mesh.material.opacity > 0.003;
        if (!mesh.visible) return;
        const life = clamp01(u / (WORD_PERIOD + WORD_OUT));
        mesh.position.set(
          sway(0.55, i * 1.7) * 0.01,
          aspect * WORD_Y + (life - 0.5) * WORD_RISE * drift,
          TEXT_LIFT + 0.02
        );
        mesh.scale.setScalar(1 + (reduceMotion ? 0 : (life - 0.5) * 0.06));
      });
    }

    renderer.render(scene, camera);
  };

  return s;
}

/* =========================================================
   Textures, painted on canvases. Canvas text gives us the
   site's real typefaces (Cormorant Garamond + Inter) with
   no extra 3D font files.
   ========================================================= */

function makeCanvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;               // crisper when seen at an angle
  return texture;
}

/** Draw `text` centred at (x, y), `spacing` pixels between letters (older browsers lack ctx.letterSpacing). */
function drawSpaced(ctx, text, x, y, spacing) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  ctx.textAlign = 'left';
  let cx = x - total / 2;
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + spacing;
  });
}

function spacedWidth(ctx, text, spacing) {
  const chars = [...text];
  return chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + spacing * (chars.length - 1);
}

/** Soft charcoal rectangle whose edges melt into the camera image. */
function makeVeilTexture() {
  const N = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COLORS.charcoal;
  ctx.fillRect(0, 0, N, N);
  // Multiply the alpha by a horizontal, then a vertical, edge fade.
  ctx.globalCompositeOperation = 'destination-in';
  [[N, 0], [0, N]].forEach(([dx, dy]) => {
    const g = ctx.createLinearGradient(0, 0, dx, dy);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.14, 'rgba(0,0,0,1)');
    g.addColorStop(0.86, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
  });
  return makeCanvasTexture(canvas);
}

/** «A mia figlia Libertà»: soft off-white italic serif. */
function makeTitleTexture(text) {
  const W = 1024;
  const H = 170;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  let size = 96;
  ctx.font = `italic 500 ${size}px ${SERIF}`;
  const maxW = W - 80;
  const measured = ctx.measureText(text).width;
  if (measured > maxW) {
    size = Math.floor((size * maxW) / measured);
    ctx.font = `italic 500 ${size}px ${SERIF}`;
  }
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.paper;
  ctx.shadowColor = 'rgba(35, 42, 47, 0.55)';   // a soft charcoal shadow, not a glow
  ctx.shadowBlur = 18;
  drawSpaced(ctx, text, W / 2, H / 2, 1);
  return { texture: makeCanvasTexture(canvas), aspect: H / W };
}

/** A hairline rule and the poet's name in small warm-beige capitals. */
function makeAuthorTexture(text) {
  const W = 1024;
  const H = 120;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.sand;
  ctx.fillRect(W / 2 - 40, 18, 80, 2);

  ctx.font = `600 30px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.beige;
  ctx.shadowColor = 'rgba(35, 42, 47, 0.55)';
  ctx.shadowBlur = 12;
  drawSpaced(ctx, text.toUpperCase(), W / 2, 72, 9);
  return { texture: makeCanvasTexture(canvas), aspect: H / W };
}

/** One texture per word, all set at the same size so the sequence feels like one voice. */
function makeWordTextures(words) {
  const W = 1280;
  const H = 320;
  const BASE = 170;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `500 ${BASE}px ${SERIF}`;
  const widest = Math.max(...words.map((w) => spacedWidth(probe, w, BASE * 0.14)));
  const size = Math.min(BASE, Math.floor((BASE * (W - 120)) / widest));

  const textures = words.map((word) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.font = `500 ${size}px ${SERIF}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.paper;
    ctx.shadowColor = 'rgba(35, 42, 47, 0.5)';
    ctx.shadowBlur = 24;
    drawSpaced(ctx, word, W / 2, H / 2 + size * 0.04, size * 0.14);
    return makeCanvasTexture(canvas);
  });
  return { textures, aspect: H / W };
}

/** Wait (max 3 s) for the web fonts: canvas would otherwise paint with a fallback face. */
async function loadFonts(text) {
  if (!document.fonts || !document.fonts.load) return;
  const wait = new Promise((resolve) => setTimeout(resolve, 3000));
  const fonts = Promise.all([
    document.fonts.load('500 170px "Cormorant Garamond"', text),
    document.fonts.load('italic 500 96px "Cormorant Garamond"', text),
    document.fonts.load('600 30px Inter', text),
  ]).catch(() => {});
  await Promise.race([fonts, wait]);
}

/** Load an optional image; resolves to null when it does not exist. */
async function loadOptionalTexture(src) {
  if (!src) return null;
  try {
    const head = await fetch(src, { method: 'HEAD' });
    const type = head.headers.get('content-type') || '';
    if (!head.ok || !type.startsWith('image/')) return null;
    const texture = await new THREE.TextureLoader().loadAsync(src);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch (err) {
    return null;
  }
}
