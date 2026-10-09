/* =========================================================
   Dynamic poem page (poesia.html?slug=<slug>)

   Loads data/poesie/<slug>.json and draws the page:
   title, author, text (one block per stanza), collection, place,
   date, notes, audio (only if the poem has one) and
   the AR state (only if the poem is AR-enabled):
     arEnabled + arReady + arPage → "Avvia esperienza AR" (link to the AR page)
     arEnabled, not ready         → "Esperienza AR in preparazione"
     not arEnabled                → nothing
   Everything coming from the data is inserted as text, never as HTML.
   ========================================================= */

import { loadJSON, loadCollections, formatDate, el, poemUrl } from './poesie-common.js';

const $ = (id) => document.getElementById(id);

const SITE_TITLE = 'Michele Pane · Museo Permanente del Dialetto';

// Slugs are lowercase words joined by dashes: anything else is rejected before touching the network.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The AR page of a ready poem must be a plain relative .html file of this site.
const AR_PAGE_PATTERN = /^[A-Za-z0-9_-]+\.html$/;

const ICON_PLAY = '<svg class="icon icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const ICON_PAUSE = '<svg class="icon icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z"/></svg>';
const ICON_AR = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><circle cx="12" cy="12" r="2.6"/></svg>';

/* ---------- Entry point ---------- */

async function init() {
  const slug = new URLSearchParams(location.search).get('slug') || '';

  if (!slug) return showMissing('Nessuna poesia indicata', 'Scegli una poesia dal catalogo.');
  if (!SLUG_PATTERN.test(slug)) return showMissing();

  let poem;
  try {
    poem = await loadJSON(`data/poesie/${slug}.json`);
  } catch (error) {
    if (error.status === 404) return showMissing();
    console.error(error);
    return showMissing('Non riesco a caricare la poesia', 'La scheda non è raggiungibile in questo momento. Riprova tra poco.');
  }
  if (!poem || poem.slug !== slug) return showMissing();
  // Listed in the data (e.g. selected for AR) but the poem text is not available yet: no empty detail page.
  if (poem.contentAvailable === false) {
    return showMissing('Poesia in preparazione', 'Il testo di questa poesia non è ancora disponibile nell’archivio.');
  }

  // The index and collection metadata only add navigation and details: the page works without them.
  const [index, collections] = await Promise.all([
    loadJSON('data/poesie/index.json').catch(() => null),
    loadCollections(),
  ]);

  render(poem, (index ? index.poems || [] : []).filter((p) => p.contentAvailable !== false), collections);
}

function showMissing(title = 'Poesia non trovata', text = 'La scheda che cerchi non esiste o non è più disponibile.') {
  $('loading').hidden = true;
  $('poem-view').hidden = true;
  $('missing-title').textContent = title;
  $('missing-text').textContent = text;
  $('not-found').hidden = false;
  document.title = `${title} – ${SITE_TITLE}`;
}

/* ---------- Rendering ---------- */

function render(poem, indexPoems, collections) {
  const collection = collections.find((c) => c.nome === poem.collection);
  const collectionHref = collection ? `poesie.html?collezione=${encodeURIComponent(collection.slug)}` : 'poesie.html';

  document.title = `${poem.title} – ${SITE_TITLE}`;
  $('meta-description').content = `«${poem.title}», poesia di ${poem.author || 'Michele Pane'}${poem.collection ? ` (raccolta ${poem.collection})` : ''}. Museo Permanente del Dialetto.`;

  // Header
  const crumb = $('crumb-collection');
  crumb.textContent = poem.collection || 'Poesie';
  crumb.href = collectionHref;
  $('poem-collection').textContent = poem.collection ? `Raccolta · ${poem.collection}` : 'Poesia';
  $('poem-title').textContent = poem.title;
  $('poem-author').textContent = poem.author || 'Michele Pane';

  renderActions(poem);
  renderText(poem);
  renderDateline(poem);
  renderNotes(poem);
  renderMeta(poem, collection);
  renderPager(poem, indexPoems);

  $('loading').hidden = true;
  $('not-found').hidden = true;
  $('poem-view').hidden = false;
}

function renderActions(poem) {
  const box = $('poem-actions');
  box.replaceChildren();

  // Audio: only when the poem has an audio file
  if (poem.audio) box.append(buildAudio(poem.audio));

  // AR: only when the poem is AR-enabled
  if (poem.arEnabled) {
    const canLaunch = poem.arReady && AR_PAGE_PATTERN.test(poem.arPage || '');
    if (canLaunch) {
      const link = el('a', 'btn btn-ghost');
      link.href = poem.arPage;
      link.innerHTML = `${ICON_AR}<span>Avvia esperienza AR</span>`;
      box.append(link);
      $('ar-note').hidden = false;
    } else {
      box.append(el('span', 'ar-soon', 'Esperienza AR in preparazione'));
    }
  }
}

function buildAudio(src) {
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = src;

  const button = el('button', 'btn btn-primary');
  button.type = 'button';
  button.setAttribute('aria-pressed', 'false');
  button.innerHTML = `${ICON_PLAY}${ICON_PAUSE}<span class="btn-label">Ascolta la poesia</span>`;
  const label = button.querySelector('.btn-label');
  const status = $('audio-status');

  const sync = () => {
    const playing = !audio.paused && !audio.ended;
    button.setAttribute('aria-pressed', String(playing));
    label.textContent = playing ? 'Metti in pausa' : 'Ascolta la poesia';
  };
  audio.addEventListener('play', () => { status.textContent = ''; sync(); });
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
  audio.addEventListener('error', () => {
    status.textContent = 'L’audio non è disponibile in questo momento.';
    sync();
  });

  button.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().catch(() => { status.textContent = 'Non riesco ad avviare l’audio: riprova.'; });
    } else {
      audio.pause();
    }
  });
  return button;
}

/** Stanzas are separated by a blank line, verses by a line break. Spelling and punctuation are left exactly as stored. */
function renderText(poem) {
  const box = $('poem-text');
  box.replaceChildren();
  box.className = '';

  const text = (poem.text || '').replace(/\r\n?/g, '\n').trim();

  if (!text) {
    // Text not transcribed yet: say so (no outside link).
    const note = el('div', 'poem-pending');
    note.append(el('p', 'poem-pending-title', 'Testo in corso di trascrizione'));
    note.append(el('p', null, 'Il testo in dialetto sarà pubblicato qui dopo una trascrizione attenta, nel rispetto della grafia originale.'));
    box.append(note);
    return;
  }

  box.className = 'poem-text';
  text.split(/\n{2,}/).forEach((stanzaText) => {
    const stanza = el('p', 'stanza');
    stanzaText.split('\n').forEach((verse, i) => {
      if (i > 0) stanza.append(document.createElement('br'));
      stanza.append(document.createTextNode(verse));
    });
    box.append(stanza);
  });

  // Dedication printed under the title in the book (kept apart from the verses)
  if (poem.dedication) box.before(el('p', 'poem-dedication', poem.dedication));

  // Discreet notice while the transcription still has to be checked against the printed book
  if (poem.transcriptionStatus === 'draft') {
    box.after(el('p', 'poem-draft-note', 'Trascrizione provvisoria da fonte digitalizzata. Testo in fase di verifica.'));
  }
}

function renderDateline(poem) {
  const line = $('poem-dateline');
  line.replaceChildren();
  const parts = [];
  if (poem.place) parts.push(document.createTextNode(poem.place));
  if (poem.date) {
    const time = document.createElement('time');
    time.textContent = formatDate(poem.date);
    if (/^\d{4}(-\d{2}){0,2}$/.test(poem.date)) time.dateTime = poem.date;
    parts.push(time);
  }
  parts.forEach((part, i) => { if (i > 0) line.append(', '); line.append(part); });
  line.hidden = parts.length === 0;
}

function renderNotes(poem) {
  const notes = (poem.notes || '').trim();
  $('poem-notes-text').textContent = notes;
  $('poem-notes').hidden = !notes;
}

/** "Scheda dell'opera": only the rows that have a value. */
function renderMeta(poem, collection) {
  const rows = [];
  rows.push(['Titolo', poem.title]);
  if (poem.printedTitle && poem.printedTitle !== poem.title) rows.push(['Titolo a stampa', poem.printedTitle]);
  rows.push(['Autore', poem.author || 'Michele Pane']);
  if (poem.collection) {
    const published = collection ? [collection.luogo, collection.anno].filter(Boolean).join(', ') : '';
    rows.push(['Raccolta', published ? `${poem.collection} (${published})` : poem.collection]);
  }
  if (poem.section) rows.push(['Sezione', poem.section]);
  if (poem.place) rows.push(['Luogo', poem.place]);
  if (poem.date) rows.push(['Data', formatDate(poem.date)]);
  if (poem.arEnabled) rows.push(['Realtà aumentata', poem.arReady ? 'Disponibile' : 'In preparazione']);

  $('meta-list').replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const dd = el('dd');
    dd.textContent = value;
    row.append(el('dt', null, label), dd);
    return row;
  }));
}

/** Previous / next poem of the same collection (catalogue order). */
function renderPager(poem, indexPoems) {
  const pager = $('poem-pager');
  pager.replaceChildren();

  const siblings = indexPoems.filter((p) => p.collection === poem.collection);
  const at = siblings.findIndex((p) => p.slug === poem.slug);
  if (at === -1) { pager.hidden = true; return; }

  const make = (target, label, className) => {
    const link = el('a', className);
    link.href = poemUrl(target.slug);
    link.append(el('small', null, label), el('span', null, target.title));
    return link;
  };
  if (siblings[at - 1]) pager.append(make(siblings[at - 1], '← Precedente', 'pager-prev'));
  if (siblings[at + 1]) pager.append(make(siblings[at + 1], 'Successiva →', 'pager-next'));
  pager.hidden = pager.childElementCount === 0;
}

init();
