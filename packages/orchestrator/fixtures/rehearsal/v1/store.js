const counts = new Map();
const submissions = [];

export function normalise(raw) {
  return raw.trim().toLowerCase();
}

export function submit(raw, clientId) {
  const word = normalise(raw);
  counts.set(word, (counts.get(word) ?? 0) + 1);
  submissions.push({ word, at: Date.now(), clientId });
  return word;
}

export function ranked() {
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}

export function total() {
  let sum = 0;
  for (const count of counts.values()) sum += count;
  return sum;
}

export function uniqueWords() {
  return counts.size;
}

export function weighted(limit = 60) {
  const list = ranked().slice(0, limit);
  const max = list[0].count;
  return list.map((entry) => ({ ...entry, weight: entry.count / max }));
}

export function snapshot(limit = 60) {
  return { total: total(), unique: uniqueWords(), words: weighted(limit) };
}

export function reset() {
  counts.clear();
  submissions.length = 0;
}
