export function log(level, msg, fields = {}) {
    const line = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...fields
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
}
//# sourceMappingURL=log.js.map