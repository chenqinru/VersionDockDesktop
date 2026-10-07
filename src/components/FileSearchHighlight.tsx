export function FileSearchHighlight({ text, query }: { text: string; query?: string }) {
  const needle = query?.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const segments = [];
  let start = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (index > start) segments.push(text.slice(start, index));
    segments.push(<mark className="search-match-highlight" key={index}>{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
    index = lower.indexOf(needle, start);
  }
  segments.push(text.slice(start));
  return <>{segments}</>;
}
