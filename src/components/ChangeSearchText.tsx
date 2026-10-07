import { useChangeSearch } from './changeSearch';
import { FileSearchHighlight } from './FileSearchHighlight';
export function ChangeSearchText({ text }: { text: string }) {
  const search = useChangeSearch();
  return <FileSearchHighlight text={text} query={search.query} />;
}
