/* =========================================================
   Importer for the poem catalogue of https://www.michelepanepoeta.it/

   Run:   npm run import:poesie
          npm run import:poesie -- --offline   (reuse the cached feed, no network)
          npm run import:poesie -- --force     (overwrite poem files that differ)

   What it does
     1. Reads the blog's public Blogger JSON feed (a handful of requests,
        2 s apart; it stops at once on 403 / 429 / 5xx).
     2. Reads the site's own contents page ("Le Poesie di Michele Pane") to
        learn which posts are poems and which collection they belong to.
     3. Classifies every post conservatively: a post is a poem only if it has
        the shape of a "poem card" AND is in the contents page or carries a
        collection label. Everything else is rejected, with a reason.
     4. Writes data/poesie/<slug>.json (one per poem) and data/poesie/index.json.
     5. Writes a human-readable report to scripts/reports/.

   IMPORTANT about the text
     On michelepanepoeta.it the poems are published as IMAGES (scans of the
     printed pages), not as text. The importer never OCRs or retypes them:
     `text` stays empty and `textStatus` says "image-only", so a person can
     transcribe the poem from the scan and set `textStatus` to "verified".

   Existing poem files are never overwritten if they differ from what the
   importer would write (they may have been corrected by hand): a warning is
   printed instead. Use --force to overwrite on purpose.
   Files that carry a `transcriptionStatus` hold a hand-made transcription
   (draft or verified) and are always kept, quietly. Careful with --force:
   it would erase them.

   Encoding guard: nothing containing the replacement character U+FFFD is
   ever written (the run stops instead).
   ========================================================= */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data', 'poesie');
const CACHE_DIR = path.join(ROOT, '.cache', 'import-poesie');
const REPORT_DIR = path.join(ROOT, 'scripts', 'reports');

const SITE = 'https://www.michelepanepoeta.it';
const FEED = `${SITE}/feeds/posts/default?alt=json`;
const PAGE_SIZE = 150;
const DELAY_MS = 2000;
const USER_AGENT = 'MuseoDialetto-ImportBot/1.0 (polite, low-rate; one-off catalogue import)';

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const FORCE = args.has('--force');

/* ---------- Editorial configuration ---------- */

/** The 10 poems selected for AR: requested title → slug used by the AR architecture. */
const AR_SELECTION = [
  { requested: 'Alle muntagne',   slug: 'alle-muntagne' },
  { requested: 'A focara',        slug: 'a-focara' },
  { requested: 'Tora',            slug: 'tora' },
  { requested: 'U chiariallu',    slug: 'u-chiariellu' },
  { requested: 'I tumbari',       slug: 'i-tumbari' },
  { requested: 'Natale',          slug: 'natale' },
  { requested: 'A mia figlia libertà', slug: 'a-mia-figlia-liberta' },
  { requested: 'Vijila',          slug: 'vijila' },
  { requested: 'Viernu è vicinu', slug: 'viernu-e-vicinu' },
  { requested: "'ndiminaglia",    slug: 'ndiminaglia' },
];
/** Spellings that must be treated as the same poem when matching (requested → also accept). */
const AR_ALIASES = { 'u chiariallu': ['u chiariellu'] };
/** The only poem whose AR experience is complete. */
const AR_READY = new Set(['a-mia-figlia-liberta']);
/** The Libertà AR files live in assets/ar/liberta (kept as they are). */
const AR_FOLDER_OVERRIDE = { 'a-mia-figlia-liberta': 'liberta' };

/** Facts already present on the existing website (poesia-liberta.html), not on the blog. */
const KNOWN = {
  'a-mia-figlia-liberta': {
    place: 'Chicago, Ill.',
    date: '1937-04-08',
    audio: 'assets/audio/a-mia-figlia-liberta.mp3',
    arPage: 'poesia-liberta.html',
    notes: 'Luogo e data sono quelli indicati finora dal museo (Chicago, 8 aprile 1937). Il sito di origine colloca la poesia nella raccolta «Accuordi» (1911): la datazione è da verificare.',
  },
};

/**
 * Poems selected for AR that exist in the museum's plan but have no page or scan on the source site.
 * They get a data entry (so the AR plan stays complete) but `contentAvailable: false`:
 * the public archive neither lists them nor opens an empty detail page. No text is invented.
 */
const MANUAL_POEMS = [
  {
    title: 'Natale',
    slug: 'natale',
    author: 'Michele Pane',
    text: '',
    place: '',
    date: '',
    collection: 'Accuordi',
    section: '',
    notes: '',
    internalNotes: 'Elencata nell’indice di «Accuordi» (1911), ma non esistono una scansione né una pagina dedicata. Nessun testo inserito: in attesa del testo o di un’altra fonte da parte del museo.',
    arEnabled: true,
    arReady: false,
    arSlug: 'natale',
    arFolder: 'natale',
    arPage: '',
    audio: '',
    textStatus: 'unavailable',
    contentAvailable: false,
    order: 12.5, // between "Vijila" and "U Focularu" in the 1911 contents
  },
];

/** Contents-page section header → collection (+ sub-section). Order = display order. */
const SECTIONS = [
  { key: "uominu russu",                      collection: "L'Uominu Russu" },
  { key: "trilogia",                          collection: 'Trilogia' },
  { key: "accuordi",                          collection: 'Accuordi' },
  { key: "lu calavrise ngrisatu",             collection: "Lu calavrise 'ngrisatu" },
  { key: "viole e ortiche",                   collection: 'Viole e Ortiche', section: 'Viole' },
  { key: "ortiche",                           collection: 'Viole e Ortiche', section: 'Ortiche' },
  { key: "trologia in dialetto calabrese",    collection: 'Viole e Ortiche', section: 'Trilogia in dialetto calabrese' },
  { key: "trilogia in dialetto calabrese",    collection: 'Viole e Ortiche', section: 'Trilogia in dialetto calabrese' },
  { key: "sorrisi",                           collection: 'Sorrisi' },
  { key: "peccati",                           collection: 'Peccati' },
  { key: "garibaldina",                       collection: 'Garibaldina' },
];
const COLLECTION_ORDER = ["L'Uominu Russu", 'Trilogia', 'Accuordi', "Lu calavrise 'ngrisatu", 'Viole e Ortiche', 'Sorrisi', 'Peccati', 'Garibaldina'];

/** Blog labels that mark a poem post, and the collection they suggest (fallback only). */
const LABEL_COLLECTION = {
  accuordi: 'Accuordi', viole: 'Viole e Ortiche', 'viole e ortiche': 'Viole e Ortiche', ortiche: 'Viole e Ortiche',
  peccati: 'Peccati', sorrisi: 'Sorrisi', trilogia: 'Trilogia', poesie: '', a: '',
};
/** Titles of collection overview pages (never poems). */
const COLLECTION_PAGE_TITLES = new Set([
  'trilogia', 'viole e ortiche', 'accuordi e sospiri', 'sorrisi', 'peccati', 'garibaldina',
  'calavrise ngrisatu', 'u calavrise ngrisatu', 'viole e ortiche trilogia in dialetto calabrese',
  'viole e ortiche seconda parte ortiche',
]);

/* ---------- Small helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lower-case, no accents, no apostrophes/quotes, single spaces: for MATCHING only, never for display. */
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’‘'`´"“”«»]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const flat = (s) => norm(s).replace(/ /g, '');

/** Edit distance, used only to pair a post title with a slightly different spelling in the contents page. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

const slugify = (s) => norm(s).replace(/ /g, '-');

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));

const htmlToText = (html) => decode(
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
).replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const cleanTitle = (t) => decode(t).replace(/\s+/g, ' ').trim();

/* ---------- Network (polite) ---------- */

class StopImport extends Error {}

async function fetchJson(url, cacheName) {
  const cacheFile = path.join(CACHE_DIR, cacheName);
  if (OFFLINE) {
    if (!existsSync(cacheFile)) throw new StopImport(`--offline requested but ${cacheName} is not cached yet.`);
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  }
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    throw new StopImport(`The server answered HTTP ${res.status} for ${url}. Stopping: do not retry now.`);
  }
  if (!res.ok) throw new StopImport(`Unexpected HTTP ${res.status} for ${url}.`);
  const json = await res.json();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(json));
  return json;
}

async function checkRobots() {
  if (OFFLINE) return;
  const res = await fetch(`${SITE}/robots.txt`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return;
  const txt = await res.text();
  if (/^\s*Disallow:\s*\/feeds/im.test(txt)) throw new StopImport('robots.txt disallows /feeds: stopping.');
  await sleep(DELAY_MS);
}

async function loadFeed() {
  const posts = [];
  let start = 1;
  for (;;) {
    const json = await fetchJson(`${FEED}&max-results=${PAGE_SIZE}&start-index=${start}`, `feed-${start}.json`);
    const entries = json.feed.entry || [];
    entries.forEach((e) => posts.push(toPost(e)));
    const total = Number(json.feed['openSearch$totalResults'].$t);
    start += PAGE_SIZE;
    if (!entries.length || start > total) {
      return { posts, total };
    }
    if (!OFFLINE) await sleep(DELAY_MS);
  }
}

function toPost(e) {
  const html = e.content ? e.content.$t : '';
  const url = (e.link.find((l) => l.rel === 'alternate') || {}).href || '';
  const text = htmlToText(html);
  return {
    title: cleanTitle(e.title.$t),
    url,
    path: url.replace(SITE + '/', ''),
    published: e.published.$t.slice(0, 10),
    labels: (e.category || []).map((c) => c.term),
    htmlLength: html.length,
    text,
    textLength: text.length,
    images: (html.match(/<img\b/gi) || []).length,
    iframes: (html.match(/<iframe\b/gi) || []).length,
    // Media links that are not plain image links (Drive, YouTube, mp3…), kept for traceability.
    media: [...new Set([...html.matchAll(/(?:href|src)="(https?:\/\/(?:drive\.google\.com|www\.youtube\.com|youtu\.be)[^"]*|[^"]*\.mp3[^"]*)"/gi)].map((m) => decode(m[1])))],
    raw: html,
  };
}

/* ---------- The site's own contents page ---------- */

function parseContents(posts) {
  const page = posts.find((p) => p.path.endsWith('2024/10/le-poesie-di-michele-pane.html'));
  if (!page) return { items: [], found: false };
  const items = [];
  let current = null;
  page.text.split('\n').forEach((raw) => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) return;
    if (line.startsWith('-')) {
      const title = line.replace(/^-\s*/, '').trim();
      if (title && current) items.push({ title, ...current, order: items.length });
      return;
    }
    const sec = SECTIONS.find((s) => s.key === norm(line));
    if (sec) current = { collection: sec.collection, section: sec.section || '' };
  });
  return { items, found: true, url: page.url };
}

/** Titles printed in the 1911 table of contents of "Accuordi" on the libello page (no dash). */
function parseAccuordiContents(posts) {
  const page = posts.find((p) => p.path.endsWith('2024/11/luominu-russu-il-libello-luominu-russu.html'));
  if (!page) return [];
  const lines = page.text.split('\n').map((l) => l.replace(/^[-\s]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const from = lines.findIndex((l) => /^ACCUORDI/.test(l));
  const to = lines.findIndex((l) => /^LU CALAVRISE/.test(l));
  if (from < 0 || to < 0) return [];
  return lines.slice(from + 1, to).filter((l) => !/^Raccolta|^a Napoli|^Casella/i.test(l));
}

/* ---------- Classification ---------- */

const hasLabel = (p, ...names) => p.labels.some((l) => names.includes(l.toLowerCase()));

/** Shape shared by every poem post: a few images and (at most) the one-line "click on the logos" prompt. */
const isPoemCard = (p) => p.textLength < 200 && p.images >= 2 && p.images <= 12 && p.htmlLength < 12000
  && p.published >= '2024-01-01' && !COLLECTION_PAGE_TITLES.has(norm(p.title));

function rejectionReason(p) {
  if (hasLabel(p, 'reprint', 'commenti e spunti') || /spunto/.test(p.path)) return 'critical essay / commentary (not imported)';
  if (COLLECTION_PAGE_TITLES.has(norm(p.title)) || (p.images > 12 && p.textLength < 200)) return 'collection overview page (images of the book pages)';
  if (hasLabel(p, 'video') || (p.textLength < 80 && p.iframes > 0)) return 'video-only post';
  if (hasLabel(p, 'foto di m. pane')) return 'photograph';
  if (hasLabel(p, 'premio', 'adami', 'personaggi', 'personaggi 1', 'il borgo', 'la chiesa', 'nome')) return 'institutional / local-history page';
  if (p.textLength === 0 && p.images === 0) return 'empty post';
  if (hasLabel(p, 'scritti') || p.textLength > 1500) return 'long text page (essay, dossier, biography, or long-poem text with wrapped lines)';
  return 'not a poem card (no poem markers)';
}

/* ---------- AR matching ---------- */

function describeSpellingDifference(requested, source) {
  if (requested === source) return 'identical';
  const diffs = [];
  if (requested.toLowerCase() !== source.toLowerCase() && norm(requested) === norm(source)) diffs.push('accents/apostrophes/spaces');
  else if (norm(requested) !== norm(source)) diffs.push('different letters');
  if (requested !== source && requested.toLowerCase() === source.toLowerCase()) diffs.push('capitalisation');
  if (norm(requested) === norm(source) && !diffs.length) diffs.push('capitalisation or apostrophe style');
  return diffs.join(', ');
}

/* ---------- Build poems ---------- */

function classify(posts, contents) {
  const indexByNorm = new Map();
  contents.items.forEach((it) => {
    const k = flat(it.title);
    if (!indexByNorm.has(k)) indexByNorm.set(k, []);
    indexByNorm.get(k).push(it);
  });

  const candidates = [];
  const rejected = [];
  posts.forEach((p) => {
    const inIndex = indexByNorm.has(flat(p.title));
    const labelOk = p.labels.some((l) => norm(l) in LABEL_COLLECTION);
    if (p.title && isPoemCard(p) && (inIndex || labelOk)) candidates.push({ post: p, inIndex });
    else rejected.push({ post: p, reason: rejectionReason(p) });
  });

  // Same title on several posts: keep as many posts as the contents page lists, best first.
  const groups = new Map();
  candidates.forEach((c) => {
    const k = flat(c.post.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  const kept = [];
  const duplicates = [];
  groups.forEach((list, k) => {
    const allowed = Math.max(1, (indexByNorm.get(k) || []).length);
    list.sort((a, b) => scorePost(b.post) - scorePost(a.post));
    list.slice(0, allowed).forEach((c) => kept.push(c));
    list.slice(allowed).forEach((c) => duplicates.push({ title: c.post.title, kept: list[0].post.url, dropped: c.post.url, reason: 'same title, same poem listed once in the contents page' }));
  });
  return { kept, rejected, duplicates, indexByNorm };
}

/** Prefer posts that carry a poem label and the 2024 poem-card shape; then the older one. */
function scorePost(p) {
  return (p.labels.some((l) => norm(l) in LABEL_COLLECTION) ? 10 : 0) + (p.images >= 4 ? 2 : 0);
}

function buildPoems(kept, indexByNorm, posts, rejected) {
  const usedSlugs = new Set();
  const flags = [];

  // The AR selection: find the source title for each requested title.
  const arBySlugKey = new Map();   // flat(source title) → selection
  const arReport = AR_SELECTION.map((sel) => {
    const accepted = [norm(sel.requested), ...(AR_ALIASES[norm(sel.requested)] || [])].map((s) => s.replace(/ /g, ''));
    const hit = kept.find((c) => accepted.includes(flat(c.post.title)));
    if (hit) arBySlugKey.set(hit.post.url, sel);
    return {
      requested: sel.requested,
      slug: sel.slug,
      matched: Boolean(hit),
      sourceTitle: hit ? hit.post.title : null,
      spelling: hit ? describeSpellingDifference(sel.requested, hit.post.title) : null,
      source: hit ? hit.post.url : null,
    };
  });

  // Pair every kept post with its contents-page entry: exact spelling first, then the closest spelling.
  const taken = new Set();
  const entryOf = new Map();
  kept.forEach(({ post }) => {
    const free = (indexByNorm.get(flat(post.title)) || []).find((e) => !taken.has(e));
    if (free) { taken.add(free); entryOf.set(post, free); }
  });
  const allEntries = [...indexByNorm.values()].flat();
  kept.forEach(({ post }) => {
    if (entryOf.has(post)) return;
    const f = flat(post.title);
    const best = allEntries.filter((e) => !taken.has(e))
      .map((e) => ({ e, d: distance(f, flat(e.title)) }))
      .sort((x, y) => x.d - y.d)[0];
    if (best && best.d <= Math.max(2, Math.floor(f.length * 0.2))) { taken.add(best.e); entryOf.set(post, best.e); }
  });

  const poems = kept.map(({ post }) => {
    const entry = entryOf.get(post);
    const labelHint = post.labels.map((l) => LABEL_COLLECTION[norm(l)]).find(Boolean) || '';
    const collection = entry ? entry.collection : labelHint;
    if (entry && labelHint && labelHint !== collection && !(collection === 'Viole e Ortiche')) {
      flags.push({ title: post.title, url: post.url, note: `blog label suggests "${labelHint}" but the contents page puts it in "${collection}" (contents page used)` });
    }
    if (!entry) flags.push({ title: post.title, url: post.url, note: `not found in the contents page (spelling differs or poem missing there); collection taken from the blog label: "${labelHint || 'none'}"` });
    else if (norm(entry.title) !== norm(post.title)) {
      flags.push({ title: post.title, url: post.url, note: `the site's contents page spells it "${entry.title}" (post title kept as display title)` });
    }
    if (!collection) flags.push({ title: post.title, url: post.url, note: 'no collection could be determined' });

    const sel = arBySlugKey.get(post.url);
    let slug = sel ? sel.slug : slugify(post.title);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      flags.push({ title: post.title, url: post.url, note: `slug "${slug}" already taken by another poem with the same title: used "${slug}-${n}". Check whether the two posts are different poems.` });
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);

    const known = KNOWN[slug] || {};
    const arEnabled = Boolean(sel);
    return {
      title: post.title,
      slug,
      author: 'Michele Pane',
      text: '',
      place: known.place || '',
      date: known.date || '',
      collection,
      section: entry ? entry.section : '',
      notes: known.notes || '',
      arEnabled,
      arReady: arEnabled && AR_READY.has(slug),
      arSlug: arEnabled ? slug : '',
      arFolder: arEnabled ? (AR_FOLDER_OVERRIDE[slug] || slug) : '',
      arPage: arEnabled ? (known.arPage || '') : '', // standalone AR page, only for poems whose AR is ready
      audio: known.audio || '',
      textStatus: 'image-only',
      order: entry ? entry.order : 9999,
    };
  });
  poems.forEach((p, i) => { const e = entryOf.get(kept[i].post); Object.defineProperty(p, 'contentsTitle', { value: e ? e.title : '', enumerable: false }); });

  // Posts about the same poem that were not imported (video, essay, other editions).
  const related = [];
  poems.forEach((poem) => {
    const t = flat(poem.title);
    rejected.forEach(({ post, reason }) => {
      const pt = flat(post.title);
      if (!pt || reason.startsWith('collection overview')) return;
      if (pt === t || (t.length >= 12 && pt.includes(t))) related.push({ poem: poem.title, title: post.title || '(no title)', url: post.url, reason });
    });
  });
  // Long-text versions of L'Uominu Russu: worth a manual look.
  const longText = rejected.filter(({ post }) => /uominu-russu|luominu-russu/.test(post.path) && post.textLength > 1500)
    .map(({ post }) => ({ title: post.title || '(no title)', url: post.url, textLength: post.textLength }));

  poems.sort((a, b) => (COLLECTION_ORDER.indexOf(a.collection) - COLLECTION_ORDER.indexOf(b.collection)) || (a.order - b.order) || a.title.localeCompare(b.title, 'it'));
  return { poems, flags, arReport, related, longText };
}

/* ---------- Writing ---------- */

/** Refuses to produce text containing U+FFFD (the replacement character = a decoding error upstream). */
function assertClean(text, what) {
  const at = text.indexOf('\uFFFD');
  if (at !== -1) throw new Error(`Encoding error: the replacement character U+FFFD is present in ${what} (near "${text.slice(Math.max(0, at - 20), at + 20)}"). Nothing was written.`);
  return text;
}

const stable = (o) => assertClean(JSON.stringify(o, null, 2) + '\n', `the data of "${o.slug || o.title || 'index'}"`);

async function writePoems(poems) {
  await mkdir(DATA_DIR, { recursive: true });
  const result = { created: [], unchanged: [], overwritten: [], protectedFiles: [], handTranscribed: [] };
  for (const poem of poems) {
    const file = path.join(DATA_DIR, `${poem.slug}.json`);
    const next = stable(poem);
    if (!existsSync(file)) {
      await writeFile(file, next, 'utf8');
      result.created.push(poem.slug);
      continue;
    }
    const current = await readFile(file, 'utf8');
    let transcribed = false;
    try { transcribed = Boolean(JSON.parse(current).transcriptionStatus); } catch { /* unreadable file: handled below as "differs" */ }
    if (current === next) result.unchanged.push(poem.slug);
    else if (transcribed && !FORCE) result.handTranscribed.push(poem.slug);
    else if (FORCE) {
      await writeFile(file, next, 'utf8');
      result.overwritten.push(poem.slug);
    } else {
      result.protectedFiles.push(poem.slug);
      console.warn(`! ${poem.slug}.json differs from the import and was NOT overwritten (corrected by hand?). Use --force to overwrite.`);
    }
  }
  return result;
}

/** index.json is rebuilt from the poem files on disk, so hand corrections show up in it. */
async function writeIndex() {
  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const poems = [];
  for (const f of files) poems.push(JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8')));
  poems.sort((a, b) => (COLLECTION_ORDER.indexOf(a.collection) - COLLECTION_ORDER.indexOf(b.collection)) || ((a.order ?? 9999) - (b.order ?? 9999)) || a.title.localeCompare(b.title, 'it'));
  const entries = poems.map((p) => ({
    title: p.title,
    slug: p.slug,
    collection: p.collection,
    section: p.section || '',
    date: p.date || '',
    arEnabled: Boolean(p.arEnabled),
    arReady: Boolean(p.arReady),
    hasText: Boolean(p.text && p.text.trim()),
    contentAvailable: p.contentAvailable !== false,
    hasAudio: Boolean(p.audio),
  }));
  const collections = COLLECTION_ORDER.filter((c) => entries.some((e) => e.collection === c));
  entries.forEach((e) => { if (e.collection && !collections.includes(e.collection)) collections.push(e.collection); });
  await writeFile(path.join(DATA_DIR, 'index.json'), stable({ count: entries.length, collections, poems: entries }), 'utf8');
  return entries;
}

function makeReport(ctx) {
  const { total, posts, contents, candidates, kept, rejected, duplicates, built, writeResult, entries, accuordiToc, missingFromSite } = ctx;
  const L = [];
  const h = (s) => L.push('', `## ${s}`, '');
  L.push('# Import report – michelepanepoeta.it', '', `Generated: ${new Date().toISOString()}`);
  h('Totals');
  L.push(`- Blogger posts analysed: **${posts.length}** (the feed declares ${total})`);
  L.push(`- Poem candidates detected: **${candidates}**`);
  L.push(`- Poems imported (poem files now on disk): **${entries.length}**  (created ${writeResult.created.length}, unchanged ${writeResult.unchanged.length}, overwritten ${writeResult.overwritten.length}, protected ${writeResult.protectedFiles.length}, hand-transcribed kept ${writeResult.handTranscribed.length})`);
  L.push(`- Poems with full text: **${entries.filter((e) => e.hasText).length}** (the source publishes the texts as images)`);
  L.push(`- Duplicates dropped: **${duplicates.length}**`);
  L.push(`- Rejected / non-poem posts: **${rejected.length}**`);
  L.push(`- Contents page items: ${contents.items.length}`);

  h('Collections');
  const byColl = {};
  built.poems.forEach((p) => { byColl[p.collection || '(none)'] = (byColl[p.collection || '(none)'] || 0) + 1; });
  Object.entries(byColl).forEach(([c, n]) => L.push(`- ${c}: ${n}`));

  h('AR selection (10 requested poems)');
  built.arReport.forEach((a) => L.push(a.matched
    ? `- ✔ "${a.requested}" → **${a.sourceTitle}** → slug \`${a.slug}\` · spelling vs. request: ${a.spelling}`
    : MANUAL_POEMS.some((m) => m.slug === a.slug)
      ? `- ◌ "${a.requested}" → no page or scan on the site: manual entry \`${a.slug}\` (arEnabled, contentAvailable: false, no text)`
      : `- ✘ "${a.requested}" → NOT FOUND on the site (slug \`${a.slug}\` reserved, no poem file created)`));

  h('Imported poems');
  built.poems.forEach((p) => L.push(`- ${p.title} — ${p.collection}${p.section ? ' / ' + p.section : ''} — \`${p.slug}\`${p.arEnabled ? ' — AR' + (p.arReady ? ' ready' : ' planned') : ''}`));

  h('Poems to review manually');
  built.flags.forEach((f) => L.push(`- **${f.title}**: ${f.note} `));
  if (!built.flags.length) L.push('- none');

  h('Duplicates and related posts');
  duplicates.forEach((d) => L.push(`- ${d.title}: ${d.reason}`));
  built.related.forEach((r) => L.push(`- "${r.poem}" also appears as "${r.title}" — ${r.reason}`));

  h("L'Uominu Russu: long text versions");
  L.push('These pages contain real text, but verses are hard-wrapped mid-line, so verse breaks cannot be restored faithfully. Not imported: transcribe by hand.');
  built.longText.forEach((l) => L.push(`- ${l.title} (${l.textLength} chars)`));

  h('Listed on the site but no page found');
  missingFromSite.forEach((m) => L.push(`- ${m}`));
  L.push('', `Titles in the 1911 contents of "Accuordi" (libello page): ${accuordiToc.join(', ') || 'n/a'}`);

  h('Rejected posts');
  const byReason = {};
  rejected.forEach(({ post, reason }) => { (byReason[reason] = byReason[reason] || []).push(post); });
  Object.entries(byReason).forEach(([reason, list]) => {
    L.push(`### ${reason} (${list.length})`, '');
    list.forEach((p) => L.push(`- ${p.title || '(no title)'}`));
    L.push('');
  });
  return L.join('\n') + '\n';
}

/* ---------- Main ---------- */

async function main() {
  console.log(OFFLINE ? 'Offline mode: using the cached feed.' : 'Reading the public feed of michelepanepoeta.it (polite mode)…');
  await checkRobots();
  const { posts, total } = await loadFeed();
  console.log(`Posts read: ${posts.length} (declared: ${total})`);

  const contents = parseContents(posts);
  if (!contents.found) console.warn('! Contents page not found: classification relies on labels only.');
  const { kept, rejected, duplicates, indexByNorm } = classify(posts, contents);
  const built = buildPoems(kept, indexByNorm, posts, rejected);
  MANUAL_POEMS.forEach((m) => { if (!built.poems.some((p) => p.slug === m.slug)) built.poems.push({ ...m }); });
  const writeResult = await writePoems(built.poems);
  const entries = await writeIndex();

  // Contents-page items that match no poem we imported (loosely: spelling variants are not "missing").
  const importedKeys = built.poems.map((p) => flat(p.title));
  const paired = new Set(built.poems.map((p) => p.contentsTitle).filter(Boolean));
  const loose = (t) => { const k = flat(t); return importedKeys.some((i) => i === k || (k.length >= 5 && (i.includes(k) || k.includes(i))) || distance(i, k) <= 2); };
  const missingFromSite = contents.items.filter((it) => !paired.has(it.title) && !loose(it.title)).map((it) => `${it.title} (${it.collection}${it.section ? ' / ' + it.section : ''})`);
  const accuordiToc = parseAccuordiContents(posts);
  accuordiToc.filter((t) => t !== t.toUpperCase() && !loose(t) && !missingFromSite.some((m) => flat(m).startsWith(flat(t)))).forEach((t) => missingFromSite.push(`${t} (only in the 1911 Accuordi contents)`));

  const report = makeReport({ total, posts, contents, candidates: kept.length + duplicates.length, kept, rejected, duplicates, built, writeResult, entries, accuordiToc, missingFromSite });
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path.join(REPORT_DIR, 'import-report.md'), assertClean(report, 'the import report'), 'utf8');

  console.log(`\nImported poems: ${entries.length}  | rejected: ${rejected.length} | duplicates dropped: ${duplicates.length}`);
  console.log(`Files: created ${writeResult.created.length}, unchanged ${writeResult.unchanged.length}, overwritten ${writeResult.overwritten.length}, protected ${writeResult.protectedFiles.length}, hand-transcribed kept ${writeResult.handTranscribed.length}`);
  console.log(`AR matches: ${built.arReport.filter((a) => a.matched).length}/10`);
  console.log(`Report: ${path.relative(ROOT, path.join(REPORT_DIR, 'import-report.md'))}`);
}

main().catch((err) => {
  if (err instanceof StopImport) {
    console.error(`\nStopped: ${err.message}`);
    console.error('Nothing was changed after this point. Try later, or import by hand (see scripts/reports/).');
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});
