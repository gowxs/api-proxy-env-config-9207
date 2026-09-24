/**
 * Reciprocal Rank Fusion: merges ranked lists (vector search, full-text
 * search) without comparing their incompatible scores. score = Σ 1/(k + rank).
 */
export function reciprocalRankFusion<T extends { id: string }>(
  lists: T[][],
  limit: number,
  k = 60,
): (T & { score: number })[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(item.id, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ ...e.item, score: e.score }));
}
