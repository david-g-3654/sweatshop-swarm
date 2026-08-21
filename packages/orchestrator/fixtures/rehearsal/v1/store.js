const links = new Map();
const hits = new Map();

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function createCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export function shorten(url, label) {
  const code = createCode();
  links.set(code, { code, url, label: label || url, createdAt: Date.now() });
  hits.set(code, []);
  return code;
}

export function resolve(code) {
  return links.get(code)?.url;
}

export function recordHit(code, referrer) {
  hits.get(code).push({ at: Date.now(), referrer });
}

export function stats(code) {
  const entries = hits.get(code);
  const link = links.get(code);
  return { code, url: link.url, label: link.label, clicks: entries.length };
}

export function allStats() {
  return [...links.keys()].map((code) => stats(code)).sort((a, b) => b.clicks - a.clicks);
}

export function totalClicks() {
  let total = 0;
  for (const entries of hits.values()) total += entries.length;
  return total;
}

export function clicksPerSecond(seconds = 30, now = Date.now()) {
  const buckets = new Array(seconds).fill(0);
  for (const entries of hits.values()) {
    for (const hit of entries) {
      const age = Math.floor((now - hit.at) / 1000);
      if (age < seconds) buckets[seconds - 1 - age] += 1;
    }
  }
  return buckets;
}

export function reset() {
  links.clear();
  hits.clear();
}
