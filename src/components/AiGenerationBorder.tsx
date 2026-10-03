import { useId, type CSSProperties } from 'react';
export function AiGenerationBorder({ active, radius = 3 }: { active: boolean; radius?: number }) {
  const gradient = useId();
  if (!active) return null;
  return (
    <svg className="ai-generation-border" aria-hidden="true" focusable="false" style={{ '--ai-input-radius': `${radius}px`, '--ai-marquee-radius': `${Math.max(0, radius - .5)}px` } as CSSProperties}>
      <defs>
        <linearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--vscode-charts-blue, #3794ff)" />
          <stop offset="55%" stopColor="var(--vscode-charts-purple, #a371f7)" />
          <stop offset="100%" stopColor="var(--vscode-charts-blue, #3794ff)" />
        </linearGradient>
      </defs>
      <rect className="ai-generation-track" pathLength="100" style={{ stroke: `url(#${gradient})` }} />
    </svg>
  );
}
