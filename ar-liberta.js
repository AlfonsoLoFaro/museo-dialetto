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
     3. Everything we put inside that anchor appears glued to the image:
        a thin frame, a floating text panel and an optional picture.
     4. The play/pause audio button and all messages are plain HTML, handled
        by poesia-liberta.js through the callbacks we receive here.

   Anchor coordinates: the image is 1 unit wide, centred on (0,0), and its
   height is `aspect` units. +X is right, +Y is up, +Z comes out of the image
   towards the viewer.
   ========================================================= */

import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

/* ---------- Tunable look & feel (all sizes in "image widths") ---------- */
const PANEL_WIDTH = 0.9;      // width of the floating text panel (1 = as wide as the image)
const PANEL_Y = 0;            // vertical position of the panel's centre, in image heights from the
                              // image centre: 0 = centred, 0.3 = higher, -0.3 = lower
const PANEL_LIFT = 0.12;      // how far the panel hovers in front of the image (+Z)
const DEFAULT_ASPECT = 1;     // image height / width, replaced by the real value after loading
const PICTURE_WIDTH = 0.8;    // width of the optional picture (assets/ar/liberta/figure.png)
const PICTURE_LIFT = 0.05;

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
 * @param {string}   [opts.pictureSrc]   optional transparent PNG floating over the image
 * @param {string}   opts.title          poem title
 * @param {string}   opts.author         poet
 * @param {string[]} opts.excerpt        excerpt, one verse per entry
 * @param {string}   opts.footer         small line at the bottom of the panel
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

  // Now the real target size is known: fit the frame / panel to it.
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

  // The anchor follows target #0 of the .mind file.
  const anchor = mindar.addAnchor(0);

  // --- Thin sand-coloured frame around the image ---
  const frameMat = new THREE.LineBasicMaterial({ color: 0xcdb59b, transparent: true, opacity: 0 });
  const frame = new THREE.LineSegments(new THREE.BufferGeometry(), frameMat);
  anchor.group.add(frame);

  // --- Floating text panel (title + excerpt painted on a canvas) ---
  const { texture, aspect: panelAspect } = await makePanelTexture(opts);
  const panelHeight = PANEL_WIDTH * panelAspect;
  const panelMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, panelHeight), panelMat);
  anchor.group.add(panel);

  // --- Optional picture (silently skipped when the file does not exist) ---
  let picture = null;
  const pictureTexture = await loadOptionalTexture(opts.pictureSrc);
  if (pictureTexture) {
    const img = pictureTexture.image;
    picture = new THREE.Mesh(
      new THREE.PlaneGeometry(PICTURE_WIDTH, PICTURE_WIDTH * (img.height / img.width)),
      new THREE.MeshBasicMaterial({ map: pictureTexture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
    );
    anchor.group.add(picture);
  }

  // Positions that depend on the image's height/width ratio.
  let panelBaseY = 0;
  const setAspect = (aspect) => {
    frame.geometry.dispose();
    frame.geometry = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.03, 1.03 * aspect));
    panelBaseY = aspect * PANEL_Y;
  };
  setAspect(DEFAULT_ASPECT);

  const s = {
    mindar, renderer, anchor, setAspect,
    found: false,
    fade: 0,                 // 0 = invisible, 1 = fully shown; eased towards `found`
    callbacks: opts,
  };

  // Image recognised / lost. MindAR shows and hides the anchor group by itself;
  // we only restart the fade-in and tell the page.
  anchor.onTargetFound = () => {
    s.found = true;
    s.fade = 0;
    if (s.callbacks.onFound) s.callbacks.onFound();
  };
  anchor.onTargetLost = () => {
    s.found = false;
    if (s.callbacks.onLost) s.callbacks.onLost();
  };

  // Render loop: ease the fade, make the panel float gently, draw.
  let last = performance.now();
  s.tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);   // seconds, capped after pauses
    const t = now / 1000;
    last = now;

    s.fade += ((s.found ? 1 : 0) - s.fade) * (1 - Math.exp(-dt * 4));
    const bob = reduceMotion ? 0 : Math.sin(t * 1.3) * 0.012;

    panelMat.opacity = s.fade;
    panel.position.set(0, panelBaseY + bob - (1 - s.fade) * 0.05, PANEL_LIFT);
    frameMat.opacity = s.fade * 0.85;
    if (picture) {
      picture.material.opacity = s.fade;
      picture.position.set(0, bob * 0.6, PICTURE_LIFT + (reduceMotion ? 0 : Math.sin(t * 0.9) * 0.01));
    }

    renderer.render(scene, camera);
  };

  return s;
}

/* =========================================================
   Text panel, painted on a canvas and used as a texture.
   Canvas text gives us the site's real typefaces (Cormorant
   Garamond + Inter) with no extra 3D font files.
   ========================================================= */

async function makePanelTexture({ title, author, excerpt, footer }) {
  const SERIF = '"Cormorant Garamond", "Iowan Old Style", Georgia, serif';
  const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  const COLORS = { paper: '#fbf9f5', ink: '#232a2f', ink2: '#3b4449', sand: '#cdb59b', sandDeep: '#8d6e4f', muted: '#6b6661' };

  await loadFonts([title, author, ...excerpt, footer].join(' '));

  const W = 1024;                       // texture width in pixels
  const PAD = 96;                       // inner margin
  const canvas = document.createElement('canvas');
  canvas.width = W;
  const ctx = canvas.getContext('2d');

  // Greedy word wrap using the current ctx.font.
  const wrap = (text, font) => {
    ctx.font = font;
    const lines = [];
    let line = '';
    text.split(/\s+/).filter(Boolean).forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > W - PAD * 2) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines;
  };

  // 1) Lay everything out top to bottom to learn the final height.
  const items = [];                     // what to draw: text lines and one rule
  let y = 104;
  const addText = (text, font, color, lineHeight, letterSpacing = '0px') => {
    wrap(text, font).forEach((line) => {
      items.push({ type: 'text', text: line, font, color, letterSpacing, y: y + lineHeight / 2 });
      y += lineHeight;
    });
  };

  addText(author.toUpperCase(), `600 26px ${SANS}`, COLORS.sandDeep, 36, '6px');
  y += 26;
  addText(title, `500 88px ${SERIF}`, COLORS.ink, 92);
  y += 34;
  items.push({ type: 'rule', y });
  y += 50;
  excerpt.forEach((verse) => addText(verse, `italic 400 46px ${SERIF}`, COLORS.ink2, 62));
  y += 38;
  addText(footer, `400 24px ${SANS}`, COLORS.muted, 34, '2px');
  const H = Math.ceil(y + 96);

  // 2) Paint. (Changing canvas.height resets the context, so style comes after.)
  canvas.height = H;

  // Warm off-white card with softly rounded corners…
  roundedRect(ctx, 0, 0, W, H, 18);
  ctx.fillStyle = COLORS.paper;
  ctx.globalAlpha = 0.96;
  ctx.fill();
  ctx.globalAlpha = 1;
  // …and a fine sand line inset from the edge, like a museum label.
  roundedRect(ctx, 30, 30, W - 60, H - 60, 6);
  ctx.strokeStyle = COLORS.sand;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  items.forEach((item) => {
    if (item.type === 'rule') {
      ctx.fillStyle = COLORS.sand;
      ctx.fillRect(W / 2 - 48, item.y, 96, 2);
      return;
    }
    ctx.font = item.font;
    ctx.fillStyle = item.color;
    if ('letterSpacing' in ctx) ctx.letterSpacing = item.letterSpacing;   // not supported by older browsers: harmless
    ctx.fillText(item.text, W / 2, item.y);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;               // crisper when the panel is seen at an angle
  return { texture, aspect: H / W };
}

/** Rounded-rectangle path (ctx.roundRect is missing on older Safari). */
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Wait (max 3 s) for the web fonts: canvas would otherwise paint with a fallback face. */
async function loadFonts(text) {
  if (!document.fonts || !document.fonts.load) return;
  const wait = new Promise((resolve) => setTimeout(resolve, 3000));
  const fonts = Promise.all([
    document.fonts.load('500 88px "Cormorant Garamond"', text),
    document.fonts.load('italic 400 46px "Cormorant Garamond"', text),
    document.fonts.load('600 26px Inter', text),
    document.fonts.load('400 24px Inter', text),
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
