const urls = new Map();
const hits = new Map();

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;
const MAX_URL_LENGTH = 2048;
const MAX_HITS_PER_CODE = 1000;

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

export function shorten(url) {
  const normalised = validateUrl(url);

  // Retry on collision rather than silently overwriting someone else's link.
  let code = createCode();
  for (let attempt = 0; urls.has(code) && attempt < 10; attempt++) {
    code = createCode();
  }
  if (urls.has(code)) {
    throw new Error('could not allocate a unique code');
  }

  urls.set(code, normalised);
  hits.set(code, []);
  return code;
}

/** Returns undefined for an unknown code. Callers must handle that. */
export function resolve(code) {
  if (typeof code !== 'string') return undefined;
  return urls.get(code);
}

export function recordHit(code, referrer) {
  const entries = hits.get(code);
  if (!entries) return false;
  // Bounded: a link that gets hammered must not grow memory without limit.
  if (entries.length >= MAX_HITS_PER_CODE) entries.shift();
  entries.push({ at: Date.now(), referrer: referrer ?? null });
  return true;
}

/** Returns null for an unknown code so the caller can send a 404. */
export function stats(code) {
  const entries = hits.get(code);
  if (!entries) return null;
  return {
    code,
    url: urls.get(code),
    clicks: entries.length,
    lastClickAt: entries.length ? entries[entries.length - 1].at : null,
    referrers: entries.reduce((acc, hit) => {
      const key = hit.referrer ?? 'direct';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export function reset() {
  urls.clear();
  hits.clear();
}
