export function parseCriteria(issueBody) {
  if (!issueBody) {
    return null;
  }

  const lines = issueBody.split("\n");
  let criteriaStartIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^##+ *(acceptance|evaluation) criteria/i.test(lines[i])) {
      criteriaStartIndex = i;
      break;
    }
  }

  if (criteriaStartIndex === -1) {
    return null;
  }

  const contentLines = [];
  for (let i = criteriaStartIndex + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      break;
    }
    contentLines.push(lines[i]);
  }

  const content = contentLines.join("\n").trim();
  return content.length > 0 ? content : null;
}
