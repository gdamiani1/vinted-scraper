/**
 * Helpers for reading Next.js React Server Component ("flight") payloads.
 *
 * Vinted's web app (2025+) no longer exposes a public JSON catalog API. Search results and item
 * details are embedded in the RSC payload of each page. The payload is a stream of
 * `<id>:<json>` lines. Rather than implementing a full flight decoder we locate the JSON objects
 * we care about with a marker string and a balanced-brace scanner that respects string escapes.
 */

/**
 * Extracts the balanced JSON object/array that starts at `start`.
 * @returns {{ json: string, end: number }} `end` is the index just after the closing bracket.
 */
export function extractBalanced(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') throw new Error(`extractBalanced: expected { or [ at ${start}, got ${JSON.stringify(open)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  throw new Error('extractBalanced: unterminated JSON structure');
}

/** Replaces the RSC `"$undefined"` placeholder with real `undefined` values, recursively. */
export function stripUndefined(value) {
  if (value === '$undefined') return undefined;
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

function objectStartForMarker(text, markerIndex, marker) {
  const inMarker = marker.search(/[{[]/);
  if (inMarker >= 0) return markerIndex + inMarker;
  let i = markerIndex + marker.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === '{' || text[i] === '[' ? i : -1;
}

function tryParse(json) {
  try {
    return stripUndefined(JSON.parse(json));
  } catch {
    return undefined;
  }
}

/**
 * Finds the first occurrence of `marker` and parses the JSON object that begins at the first
 * `{`/`[` inside the marker (or immediately after it).
 */
export function findObjectAfterKey(text, marker, { from = 0 } = {}) {
  let idx = text.indexOf(marker, from);
  while (idx >= 0) {
    const start = objectStartForMarker(text, idx, marker);
    if (start >= 0) {
      try {
        const { json } = extractBalanced(text, start);
        const parsed = tryParse(json);
        if (parsed !== undefined) return parsed;
      } catch {
        /* fall through and try the next occurrence */
      }
    }
    idx = text.indexOf(marker, idx + 1);
  }
  return undefined;
}

/**
 * Finds every JSON object introduced by `marker` for which `predicate` holds.
 * Nested matches are not skipped, so objects inside other matches are still found.
 */
export function findObjects(text, marker, predicate = () => true, { limit = Infinity } = {}) {
  const out = [];
  let idx = text.indexOf(marker);
  while (idx >= 0 && out.length < limit) {
    const start = objectStartForMarker(text, idx, marker);
    if (start >= 0) {
      try {
        const { json } = extractBalanced(text, start);
        const parsed = tryParse(json);
        if (parsed !== undefined && predicate(parsed)) out.push(parsed);
      } catch {
        /* ignore malformed candidates */
      }
    }
    idx = text.indexOf(marker, idx + 1);
  }
  return out;
}

/**
 * When a full HTML document is supplied, the flight payload is split across
 * `self.__next_f.push([1,"..."])` script calls as escaped JS strings. This unwraps them into
 * the same plain text the `RSC: 1` request would return. Plain flight text is returned as-is.
 */
export function unwrapHtmlFlight(text) {
  if (!text.includes('__next_f.push')) return text;
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      /* skip undecodable chunk */
    }
  }
  return chunks.join('');
}

export function isSessionRefreshPage(text) {
  return /<title>\s*Session refresh\s*<\/title>/i.test(text) || /"c":\["","session-refresh"\]/.test(text);
}

export function looksBlocked(text) {
  return /captcha-delivery\.com|geo\.captcha-delivery|DataDome|datadome/i.test(text) && !text.includes('"items":{"items":[');
}
