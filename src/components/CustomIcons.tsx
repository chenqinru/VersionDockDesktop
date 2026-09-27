import type { SVGProps } from 'react';

export function SelectAllIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      aria-hidden="true"
      className="custom-icon"
      {...props}
    >
      <rect x="2" y="2" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.6 8.2l2.3 2.4 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function InvertSelectionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="custom-icon"
      {...props}
    >
      <defs>
        <clipPath id="versiondock-inv-clip">
          <rect x="2" y="2" width="12" height="12" rx="2.5" />
        </clipPath>
      </defs>
      <path d="M1 1L15 15H1V1Z" fill="currentColor" clipPath="url(#versiondock-inv-clip)" />
      <rect x="2" y="2" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function WarningConflictIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="custom-icon vd-conflict-pulse-icon"
      {...props}
    >
      <defs>
        <style>{`
          @keyframes vd-conflict-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.35; transform: scale(0.92); }
          }
          .vd-conflict-pulse-icon .vd-conflict-g {
            transform-origin: 8px 8.5px;
            animation: vd-conflict-pulse 1.6s ease-in-out infinite;
          }
        `}</style>
      </defs>
      <g className="vd-conflict-g">
        <path fill="#F59E0B" d="M6.93 1.9a1.23 1.23 0 0 1 2.14 0l6.17 10.8a1.23 1.23 0 0 1-1.07 1.84H1.83a1.23 1.23 0 0 1-1.07-1.84L6.93 1.9z" />
        <rect x="7.2" y="5.2" width="1.6" height="4.2" rx="0.8" fill="#18181B" />
        <circle cx="8" cy="11.8" r="0.9" fill="#18181B" />
      </g>
    </svg>
  );
}

