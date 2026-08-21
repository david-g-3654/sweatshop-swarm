const links = new Map();
const hits = new Map();

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;
const MAX_URL_LENGTH = 2048;
const MAX_HITS_PER_CODE = 5000;

export function createCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

/** Throws on anything that is not a plausible http(s) URL. */
export function validateUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('url must be a non-empty string');
  }
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`url must be at most ${MAX_URL_LENGTH} characters`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('url is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must use http or https');
  }
  return parsed.toString();
}

export function shorten(url, label) {
  const normalised = validateUrl(url);

  // Retry on collision rather than silently overwriting someone else's link.
  let code = createCode();
  for (let attempt = 0; links.has(code) && attempt < 10; attempt++) code = createCode();
  if (links.has(code)) throw new Error('could not allocate a unique code');

  links.set(code, {
    code,
    url: normalised,
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : normalised,
    createdAt: Date.now(),
  });
  hits.set(code, []);
  return code;
}

export function resolve(code) {
  if (typeof code !== 'string') return undefined;
  return links.get(code)?.url;
}

/**
 * Record one click.
 *
 * Increment-in-place on the array we already hold. Nothing reads a count,
 * computes a new one and writes it back, so a burst of clicks arriving together
 * cannot lose any of them.
 */
export function recordHit(code, referrer) {
  const entries = hits.get(code);
  if (!entries) return false;
  if (entries.length >= MAX_HITS_PER_CODE) entries.shift();
  entries.push({ at: Date.now(), referrer: referrer ?? null });
  return true;
}

export function stats(code) {
  const link = links.get(code);
  const entries = hits.get(code);
  if (!link || !entries) return null;
  return {
    code,
    url: link.url,
    label: link.label,
    clicks: entries.length,
    lastClickAt: entries.length ? entries[entries.length - 1].at : null,
    referrers: entries.reduce((acc, hit) => {
      const key = hit.referrer ?? 'direct';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** Every link, busiest first — exactly what the dashboard chart renders. */
export function allStats() {
  return [...links.keys()]
    .map((code) => stats(code))
    .filter(Boolean)
    .sort((a, b) => b.clicks - a.clicks || a.code.localeCompare(b.code));
}

export function totalClicks() {
  let total = 0;
  for (const entries of hits.values()) total += entries.length;
  return total;
}

/** Clicks per second over the last `seconds`, oldest bucket first. */
export function clicksPerSecond(seconds = 30, now = Date.now()) {
  const buckets = new Array(seconds).fill(0);
  for (const entries of hits.values()) {
    for (const hit of entries) {
      const age = Math.floor((now - hit.at) / 1000);
      if (age >= 0 && age < seconds) buckets[seconds - 1 - age] += 1;
    }
  }
  return buckets;
}

export function reset() {
  links.clear();
  hits.clear();
}
