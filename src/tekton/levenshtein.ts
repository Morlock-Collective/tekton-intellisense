/** Classic edit-distance, used to suggest "did you mean" fixes for misspelled references. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const prev = new Array<number>(bl + 1);
  const curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

/** Returns the closest candidate to `target` if it's within a reasonable edit-distance threshold. */
export function closestMatch(target: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  const threshold = Math.max(2, Math.floor(target.length / 3));
  return bestDist <= threshold ? best : undefined;
}
