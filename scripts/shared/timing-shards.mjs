/** Deterministic longest-first assignment. All shards must use the same weights. */
export function partitionByTiming(files, { count, key, weight, overhead = [] }) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid shard count');
  const shards = Array.from({ length: count }, () => []);
  const totals = shards.map((_, index) => overhead[index] ?? 0);
  if (totals.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid shard overhead');
  const ordered = files.map(file => ({ file, key: key(file), weight: weight(file) }));
  if (new Set(ordered.map(row => row.key)).size !== files.length) throw new Error('Duplicate test specification');
  if (ordered.some(row => !Number.isFinite(row.weight) || row.weight <= 0)) throw new Error('Invalid test weight');
  ordered.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const row of ordered) {
    let selected = -1;
    for (let index = 0; index < count; index++) {
      if (selected < 0 || totals[index] < totals[selected]
        || totals[index] === totals[selected] && shards[index].length < shards[selected].length) selected = index;
    }
    shards[selected].push(row.file);
    totals[selected] += row.weight;
  }
  return shards;
}
