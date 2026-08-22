const counts = new Map();
const submissions = [];

const MAX_WORD_LENGTH = 24;
const MAX_UNIQUE_WORDS = 300;
const MAX_SUBMISSIONS = 5000;

/**
 * Reduce a submission to a comparable word, or throw.
 *
 * Normalising is what makes "Agents", "agents " and "AGENTS" one bar instead of
 * three, and the allow-list is the first of two defences against markup — the
 * second is the renderer, which never builds HTML from this at all.
 */
export function normalise(raw) {
  if (typeof raw !== 'string') throw new Error('word must be a string');

  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') throw new Error('word must not be empty');
  if (trimmed.length > MAX_WORD_LENGTH) {
    throw new Error(`word must be at most ${MAX_WORD_LENGTH} characters`);
  }

  // Letters, digits, and the punctuation that legitimately sits inside a word.
  const cleaned = trimmed.replace(/[^\p{L}\p{N}'-]/gu, '');
  if (cleaned === '') throw new Error('word must contain letters or digits');
  if (!/\p{L}/u.test(cleaned)) throw new Error('word must contain at least one letter');

  return cleaned;
}

export function submit(raw, clientId) {
  const word = normalise(raw);

  if (!counts.has(word) && counts.size >= MAX_UNIQUE_WORDS) {
    throw new Error('the cloud is full');
  }

  counts.set(word, (counts.get(word) ?? 0) + 1);

  // Bounded: a booth running all day must not grow without limit.
  submissions.push({ word, at: Date.now(), clientId: clientId ?? null });
  if (submissions.length > MAX_SUBMISSIONS) submissions.shift();

  return word;
}

/** Every word, most-said first. Ties break alphabetically so order is stable. */
export function ranked() {
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

export function total() {
  let sum = 0;
  for (const count of counts.values()) sum += count;
  return sum;
}

export function uniqueWords() {
  return counts.size;
}

/**
 * Words with a render weight from 0 to 1.
 *
 * Scaled against the most-said word so the cloud looks right whether the top
 * word has three mentions or three hundred.
 */
export function weighted(limit = 60) {
  const list = ranked().slice(0, limit);
  const max = list.length ? list[0].count : 1;
  return list.map((entry) => ({ ...entry, weight: entry.count / max }));
}

export function snapshot(limit = 60) {
  return { total: total(), unique: uniqueWords(), words: weighted(limit) };
}

export function reset() {
  counts.clear();
  submissions.length = 0;
}
