// Cheap whitespace+punctuation tokenizer good enough for budget checks.
// Real model tokenization is unnecessary here — we only need:
//   1. count of tokens for glue budget
//   2. token-level diff for migrate change-pct
//   3. lowercased token set for forbidden-token detection

const TOKEN_RE = /[a-zA-Z0-9'\-]+|[.,;:!?()\[\]{}"]/g;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function tokenizeLower(text: string): string[] {
  return tokenize(text).map((t) => t.toLowerCase());
}

export function tokenCount(text: string): number {
  return tokenize(text).length;
}

// Levenshtein-on-tokens, with early bail-out at maxDistance + 1.
export function tokenEditDistance(a: string[], b: string[], maxDistance = 1024): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost
      );
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export function changeFraction(oldText: string, newText: string): number {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length === 0 && b.length === 0) return 0;
  const denom = Math.max(a.length, b.length);
  const dist = tokenEditDistance(a, b);
  return dist / denom;
}
