export function parseTitle(markdown) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match?.[1] ?? 'Untitled PRD';
}
