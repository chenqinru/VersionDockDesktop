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
