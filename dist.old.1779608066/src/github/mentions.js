const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function containsMention(text, mention) {
    if (!text)
        return false;
    const m = mention.trim();
    if (!m)
        return false;
    const re = new RegExp(`(^|\\s)${escapeRegex(m)}(\\b|\\s|$)`, "i");
    return re.test(text);
}
//# sourceMappingURL=mentions.js.map