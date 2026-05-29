/**
 * Parse criteria from a GitHub issue body.
 * Searches for a markdown heading matching "Acceptance Criteria" or "Evaluation Criteria"
 * (case-insensitive, any number of # symbols), and extracts all text until the next ## heading
 * or end of string.
 *
 * @param {string} issueBody - The issue body text
 * @returns {string|null} - The extracted criteria text, trimmed, or null if not found
 */
export function parseCriteria(issueBody) {
  // Handle falsy or non-string inputs
  if (!issueBody || typeof issueBody !== 'string') {
    return null;
  }

  const lines = issueBody.split('\n');
  let criteriaStartIndex = -1;

  // Find the heading matching the criteria pattern
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: one or more #, followed by optional spaces, then (acceptance|evaluation) criteria
    if (/^#+\s+(acceptance|evaluation)\s+criteria/i.test(line)) {
      criteriaStartIndex = i;
      break;
    }
  }

  // If no matching heading found, return null
  if (criteriaStartIndex === -1) {
    return null;
  }

  // Collect lines from the line after the heading until we hit the next ## heading or end
  const contentLines = [];
  for (let i = criteriaStartIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    // Check if this line is a heading (starts with ##)
    if (/^##/.test(line)) {
      break;
    }
    contentLines.push(line);
  }

  // Join the content, trim, and return null if empty
  const content = contentLines.join('\n').trim();
  return content.length > 0 ? content : null;
}
