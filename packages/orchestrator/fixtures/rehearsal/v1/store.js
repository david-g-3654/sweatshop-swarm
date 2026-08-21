const urls = new Map();
const hits = new Map();

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function createCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export function shorten(url) {
  const code = createCode();
  urls.set(code, url);
  hits.set(code, []);
  return code;
}

export function resolve(code) {
  return urls.get(code);
}

export function recordHit(code, referrer) {
  hits.get(code).push({ at: Date.now(), referrer });
}

export function stats(code) {
  const entries = hits.get(code);
  return { code, url: urls.get(code), clicks: entries.length };
}
