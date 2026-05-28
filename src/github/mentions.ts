const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function containsMention(text: string, mention: string): boolean {
  if (!text) return false;
  const m = mention.trim();
  if (!m) return false;
  // Require the mention to be preceded by start-of-string or whitespace, and NOT followed
  // by a word character or hyphen. This prevents false positives like "@worker-bot"
  // matching "@worker" while still matching "@worker," or "@worker." correctly.
  const re = new RegExp(`(^|\\s)${escapeRegex(m)}(?![-\\w])`, "i");
  return re.test(text);
}

