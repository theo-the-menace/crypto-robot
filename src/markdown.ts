export function normalizeChatMarkdown(markdown: string) {
  let normalized = markdown;
  let previous = '';
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(/(^>\s+\d+\.[^\n]*?)>\s+(?=\d+\.)/gm, '$1\n> ');
  }

  const lines: string[] = [];
  let fenced = false;
  for (const line of normalized.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      lines.push(line);
      continue;
    }
    const fences = line.match(/```/g)?.length ?? 0;
    if (!fenced && fences === 1 && /```\s*$/.test(line)) {
      lines.push(line.replace(/\s*```\s*$/, ''), '```');
      fenced = true;
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
