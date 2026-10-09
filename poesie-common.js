/* =========================================================
   Small helpers shared by the archive (archivio.js) and the
   poem page (poesia.js). Data lives in data/poesie/*.json.
   ========================================================= */

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** Fetches a JSON file; throws an Error carrying `.status` when the server answers with an error. */
export async function loadJSON(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const error = new Error(`${url}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Collections metadata (year/place of publication); optional, the pages work without it. */
export async function loadCollections() {
  try {
    const data = await loadJSON('data/collezioni.json');
    return data.collezioni || [];
  } catch {
    return [];
  }
}

/** "1937-04-08" → "8 aprile 1937"; "1937-04" → "aprile 1937"; "1937" → "1937"; anything else is shown as written. */
export function formatDate(value) {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value || '');
  if (!match) return value || '';
  const [, year, month, day] = match;
  if (!month) return year;
  const name = MONTHS[Number(month) - 1];
  if (!name) return year;
  return day ? `${Number(day)} ${name} ${year}` : `${name} ${year}`;
}

/**
 * Search key: lowercase, no accents, no apostrophes/quotes/punctuation, single spaces.
 * Only used to MATCH titles; titles themselves are always shown exactly as stored.
 */
export function searchKey(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Creates an element with optional class and text (textContent: nothing from the data is ever parsed as HTML). */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Link to a poem in the dynamic page. */
export const poemUrl = (slug) => `poesia.html?slug=${encodeURIComponent(slug)}`;
