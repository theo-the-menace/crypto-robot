export function quoteChatPrompt(selection: string, question: string) {
  const quote = selection.trim().slice(0, 4000).replace(/\n/g, '\n> ');
  return quote ? `> ${quote}\n\n${question.trim()}` : question.trim();
}
