import { describe, expect, it } from "vitest";
import { hasAnyLabel } from "../src/github/issues.js";
describe("hasAnyLabel", () => {
    it("matches case-insensitively", () => {
        const issue = { labels: ["Accepted"] };
        expect(hasAnyLabel(issue, ["accepted"])).toBe(true);
    });
    it("returns false when none match", () => {
        const issue = { labels: ["triage"] };
        expect(hasAnyLabel(issue, ["accepted", "done"])).toBe(false);
    });
});
//# sourceMappingURL=issues-filter.test.js.map