export function normalizeLabels(labels: unknown[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === "string") out.push(l);
    else if (l && typeof l === "object" && "name" in l && typeof (l as any).name === "string") out.push((l as any).name);
  }
  return out;
}

export function hasAnyLabel(issue: { labels: string[] }, labels: string[]): boolean {
  const have = new Set(issue.labels.map((l) => l.toLowerCase()));
  return labels.some((l) => have.has(l.toLowerCase()));
}
