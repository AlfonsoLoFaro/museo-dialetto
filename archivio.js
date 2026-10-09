/* =========================================================
   Poetry archive (poesie.html)

   Reads data/poesie/index.json (+ data/collezioni.json for the
   collection metadata) and draws a catalogue grouped by collection,
   with title search and collection filters.
   The URL keeps the state, so a view can be shared or linked:
     poesie.html?collezione=accuordi      one collection
     poesie.html?collezione=ar            poems with an AR experience
     poesie.html?q=tora                   title search
   Titles are shown exactly as stored in the data; accents and
   apostrophes are ignored only when searching.
   ========================================================= */

import { loadJSON, loadCollections, searchKey, el, poemUrl } from './poesie-common.js';

const $ = (id) => document.getElementById(id);
const catalogue = $('catalogue');
const filtersBox = $('filters');
const statusLine = $('status');
const empty = $('empty');
const searchInput = $('search-input');

const AR_FILTER = 'ar';

let poems = [];          // index.json entries, already in catalogue order
let collections = [];    // [{ name, slug, year, place }]
const state = { q: '', filter: '' };   // filter: '' (all) | collection slug | 'ar'

const slugify = (text) => searchKey(text).replace(/ /g, '-');

/* ---------- Data ---------- */

async function init() {
  try {
    const [index, meta] = await Promise.all([loadJSON('data/poesie/index.json'), loadCollections()]);
    // Poems without available content (e.g. selected for AR, text still to come) are not listed
    poems = (index.poems || []).filter((p) => p.contentAvailable !== false);
    collections = (index.collections || []).map((name) => {
      const found = meta.find((c) => c.nome === name) || {};
      return { name, slug: found.slug || slugify(name), year: found.anno || '', place: found.luogo || '' };
    });
  } catch (error) {
    console.error(error);
    showEmpty(
      'Non riesco a caricare le poesie',
      'Il catalogo non è raggiungibile in questo momento. Riprova tra poco; se apri la pagina da un file locale, serve un server (per esempio «npx serve»).',
      false
    );
    statusLine.textContent = '';
    catalogue.setAttribute('aria-busy', 'false');
    return;
  }

  // Restore the state from the URL
  const params = new URLSearchParams(location.search);
  state.q = params.get('q') || '';
  const wanted = params.get('collezione') || '';
  if (wanted === AR_FILTER || collections.some((c) => c.slug === wanted)) state.filter = wanted;
  searchInput.value = state.q;

  buildFilters();
  render();
  catalogue.setAttribute('aria-busy', 'false');
}

/* ---------- Filters ---------- */

function buildFilters() {
  const options = [{ slug: '', label: 'Tutte', count: poems.length }];
  collections.forEach((c) => options.push({ slug: c.slug, label: c.name, count: poems.filter((p) => p.collection === c.name).length }));
  options.push({ slug: AR_FILTER, label: 'Con esperienza AR', count: poems.filter((p) => p.arEnabled).length });

  filtersBox.replaceChildren(...options.map((o) => {
    const button = el('button', 'filter', `${o.label} · ${o.count}`);
    button.type = 'button';
    button.dataset.filter = o.slug;
    button.addEventListener('click', () => { state.filter = o.slug; render(); });
    return button;
  }));
}

function syncFilterButtons() {
  filtersBox.querySelectorAll('.filter').forEach((button) => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

/* ---------- Rendering ---------- */

function matches(poem) {
  if (state.filter === AR_FILTER && !poem.arEnabled) return false;
  if (state.filter && state.filter !== AR_FILTER) {
    const collection = collections.find((c) => c.slug === state.filter);
    if (!collection || poem.collection !== collection.name) return false;
  }
  const key = searchKey(state.q);
  if (!key) return true;
  const haystack = searchKey(`${poem.title} ${poem.section || ''} ${poem.collection}`);
  // every typed word must appear (in any order)
  return key.split(' ').every((word) => haystack.includes(word));
}

function badge(text, className) {
  return el('span', `badge ${className}`, text);
}

function renderItem(poem, number) {
  const li = el('li', 'catalogue-row');
  const link = el('a', 'catalogue-item');
  link.href = poemUrl(poem.slug);

  link.append(el('span', 'catalogue-num', String(number).padStart(2, '0')));

  const main = el('span', 'catalogue-main');
  main.append(el('span', 'catalogue-title', poem.title));
  const details = [poem.section, poem.date].filter(Boolean).join(' · ');
  if (details) main.append(el('span', 'catalogue-sub', details));
  link.append(main);

  const badges = el('span', 'catalogue-badges');
  if (poem.arEnabled) {
    badges.append(poem.arReady ? badge('Esperienza AR', 'badge-ar') : badge('AR in preparazione', 'badge-ar-soon'));
  }
  if (poem.hasAudio) badges.append(badge('Audio', 'badge-plain'));
  link.append(badges);

  link.append(el('span', 'catalogue-arrow', '→'));
  li.append(link);
  return li;
}

function renderGroup(collection, group) {
  const section = el('section', 'catalogue-group');
  section.setAttribute('aria-labelledby', `col-${collection.slug}`);

  const head = el('header', 'catalogue-group-head');
  const title = el('h3', null, collection.name);
  title.id = `col-${collection.slug}`;
  const all = poems.filter((p) => p.collection === collection.name);
  const total = all.length;
  const published = [collection.place, collection.year].filter(Boolean).join(', ');
  const countText = group.length === total ? `${total} poesie` : `${group.length} di ${total} poesie`;
  head.append(title, el('p', 'catalogue-group-meta', [published, countText].filter(Boolean).join(' · ')));
  section.append(head);

  const list = el('ol', 'catalogue-list');
  let lastSection = null;
  group.forEach((poem) => {
    // Sub-headings for collections made of sections (e.g. Viole / Ortiche)
    if (poem.section && poem.section !== lastSection) {
      const sub = el('li', 'catalogue-subhead', poem.section);
      sub.setAttribute('role', 'presentation');
      list.append(sub);
    }
    lastSection = poem.section || null;
    list.append(renderItem(poem, all.indexOf(poem) + 1));
  });
  section.append(list);
  return section;
}

function showEmpty(title, text, canReset = true) {
  $('empty-title').textContent = title;
  $('empty-text').textContent = text;
  $('reset-btn').hidden = !canReset;
  empty.hidden = false;
}

function render() {
  const visible = poems.filter(matches);

  const groups = collections
    .map((c) => ({ collection: c, group: visible.filter((p) => p.collection === c.name) }))
    .filter((g) => g.group.length);
  // Poems of a collection missing from index.collections are still shown (never silently dropped)
  const known = new Set(collections.map((c) => c.name));
  const strays = visible.filter((p) => !known.has(p.collection));
  if (strays.length) groups.push({ collection: { name: strays[0].collection || 'Altre poesie', slug: 'altre', year: '', place: '' }, group: strays });

  catalogue.replaceChildren(...groups.map((g) => renderGroup(g.collection, g.group)));

  syncFilterButtons();

  if (visible.length === 0) {
    showEmpty('Nessuna poesia trovata', 'Prova con un’altra parola, oppure togli il filtro della raccolta.');
  } else {
    empty.hidden = true;
  }

  const searching = searchKey(state.q) !== '';
  statusLine.textContent = searching || state.filter
    ? `${visible.length} ${visible.length === 1 ? 'poesia' : 'poesie'} su ${poems.length}`
    : `${poems.length} poesie in ${collections.length} raccolte`;

  // Keep the URL in step with the view (no new history entries while typing)
  const params = new URLSearchParams();
  if (state.filter) params.set('collezione', state.filter);
  if (state.q.trim()) params.set('q', state.q.trim());
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

/* ---------- Events ---------- */

searchInput.addEventListener('input', () => { state.q = searchInput.value; render(); });
$('search-form').addEventListener('submit', (e) => e.preventDefault());
$('reset-btn').addEventListener('click', () => {
  state.q = '';
  state.filter = '';
  searchInput.value = '';
  render();
  searchInput.focus();
});

init();
