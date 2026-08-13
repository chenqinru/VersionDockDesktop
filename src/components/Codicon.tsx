interface Props { name: string; className?: string }
export function Codicon({ name, className = '' }: Props) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} />;
}
