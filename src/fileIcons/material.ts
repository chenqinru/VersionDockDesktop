import type { IconResolver, IconResult } from './types';

// Helper for pure SVG data string
function svgWrap(content: string, viewBox = '0 0 24 24'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16">${content}</svg>`;
}

const ICONS: Record<string, string> = {
  folder: svgWrap('<path fill="#FFA000" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>'),
  folderOpen: svgWrap('<path fill="#FFB300" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/><path fill="#FFE082" opacity=".3" d="M4 8h16v10H4z"/>'),
  folderSrc: svgWrap('<path fill="#42A5F5" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/><path fill="#FFF" d="M14.5 10.5 12 13l2.5 2.5-1 1-3.5-3.5 3.5-3.5 1 1zm-5 0L7 13l2.5 2.5-1 1-3.5-3.5 3.5-3.5 1 1z" transform="scale(0.8) translate(3, 4)"/>'),
  folderGit: svgWrap('<path fill="#F4511E" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/><circle cx="12" cy="13" r="2.5" fill="#FFF"/>'),
  folderTest: svgWrap('<path fill="#66BB6A" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/><path fill="#FFF" d="M11 10h2v2h-2zm0 3h2v4h-2z"/>'),
  folderNode: svgWrap('<path fill="#689F38" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/><path fill="#FFF" d="M12 9.5l4 2.3v4.7l-4 2.3-4-2.3v-4.7l4-2.3z" opacity=".8"/>'),
  
  ts: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#3178C6" rx="3"/><path fill="#FFF" d="M10.7 8.3H5.5V9.9H7.3V17H9V9.9h1.7V8.3zm3.7 3.3c-.6-.4-1.2-.7-1.8-.7-.5 0-.8.2-.8.5 0 .3.2.5.8.7.9.4 2.1.8 2.1 2.1 0 1.2-.9 2-2.3 2-.9 0-1.7-.3-2.3-.8l.6-1.3c.6.4 1.2.7 1.8.7.5 0 .8-.2.8-.5 0-.3-.2-.5-.8-.7-.9-.4-2-.8-2-2.1 0-1.2.9-2 2.2-2 .8 0 1.5.3 2 .6l-.4 1.2z"/>'),
  tsx: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#0288D1" rx="3"/><path fill="#FFF" d="M6.5 8H3V9.2H4.3V15H5.4V9.2H6.5V8zm2.6 2.5c-.4-.3-.8-.5-1.3-.5-.4 0-.6.2-.6.4 0 .2.2.4.6.5.7.3 1.5.6 1.5 1.5 0 .9-.6 1.4-1.6 1.4-.6 0-1.2-.2-1.6-.6l.4-.9c.4.3.8.5 1.2.5.4 0 .6-.2.6-.4 0-.2-.1-.3-.6-.5-.6-.3-1.4-.6-1.4-1.5 0-.8.6-1.4 1.6-1.4.5 0 1 .2 1.4.4l-.3.9zm5 2.1l1.7-2.6h1.3l-2.3 3.4 2.4 3.6h-1.4L13.5 14l-1.7 3H10.5l2.4-3.6-2.3-3.4h1.4l1.4 2.5z"/>'),
  js: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#F7DF1E" rx="3"/><path fill="#000" d="M7.5 8.5h1.8v6.2c0 .9-.4 1.5-1.4 1.5-.4 0-.9-.1-1.3-.3l.3-1.4c.2.1.5.2.8.2.3 0 .5-.2.5-.5V8.5zm4.8 4.2c.6.3 1.2.6 1.8.6.5 0 .8-.2.8-.5 0-.3-.2-.5-.8-.7-.9-.4-2-.8-2-2.1 0-1.2.9-2 2.2-2 .8 0 1.5.3 2 .6l-.4 1.3c-.5-.3-1.1-.5-1.6-.5-.5 0-.8.2-.8.5 0 .3.2.5.8.7.9.4 2.1.8 2.1 2.1 0 1.2-.9 2-2.3 2-.9 0-1.7-.3-2.3-.8l.5-1.2z"/>'),
  jsx: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#F0B90B" rx="3"/><path fill="#000" d="M4.5 8.5h1.4v4.5c0 .7-.3 1.1-1 1.1-.3 0-.6-.1-.9-.2l.2-1c.2.1.4.1.6.1.2 0 .4-.1.4-.4V8.5zm3.5 3c.4.2.9.4 1.3.4.4 0 .6-.1.6-.4 0-.2-.1-.4-.6-.5-.7-.3-1.4-.6-1.4-1.5 0-.9.6-1.4 1.6-1.4.6 0 1.1.2 1.4.4l-.3.9c-.4-.2-.8-.4-1.2-.4-.3 0-.5.1-.5.3 0 .2.1.3.6.5.6.3 1.5.6 1.5 1.5 0 .9-.7 1.5-1.7 1.5-.7 0-1.2-.2-1.7-.5l.4-.9zm6.6 1.3l1.5-2.3h1.2l-2.1 3 2.1 3.2h-1.2L14 13.5l-1.5 2.7h-1.2l2.1-3.2-2-3h1.2l1.3 2.2z"/>'),
  vue: svgWrap('<path fill="#42B883" d="M2 3h4.5L12 12.5 17.5 3H22L12 20.5 2 3z"/><path fill="#35495E" d="M6.5 3h3.2L12 7.1 14.3 3h3.2L12 11.8 6.5 3z"/>'),
  svelte: svgWrap('<path fill="#FF3E00" d="M18.8 6.2C17.4 4.5 15.2 3.6 13 3.8c-2.8.2-5.3 1.9-6.3 4.5-.4 1.1-.5 2.3-.2 3.4.1.4.4.9.7 1.3L5.3 15c-1 1.3-1.5 2.9-1.2 4.6.4 2.1 1.9 3.8 3.9 4.6 2 .8 4.3.5 6.1-.7l2.8-1.9c1.6-1.1 2.6-2.8 2.8-4.7.1-1.2-.1-2.4-.6-3.4-.2-.4-.5-.9-.8-1.3l1.9-2c1.2-1.3 1.7-3 .9-4.7z"/>'),
  astro: svgWrap('<path fill="#FF5D01" d="M8.5 18.5l3.5-13 3.5 13-1.5-.5-2-7.5-2 7.5-1.5.5z"/><circle cx="12" cy="18.5" r="2" fill="#9C27B0"/>'),
  rust: svgWrap('<path fill="#DEA584" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5l-2-2.5h-1.5v2.5H8v-9h4c1.7 0 3 1.1 3 2.8 0 1.2-.7 2.2-1.7 2.6l2.2 3.6H13zm-2.5-4.5h1.5c.8 0 1.5-.5 1.5-1.3s-.7-1.3-1.5-1.3h-1.5v2.6z"/>'),
  python: svgWrap('<path fill="#3776AB" d="M11.9 2c-3.1 0-2.9 1.3-2.9 1.3l.01 1.4h3v.4H6.2S4 4.8 4 8c0 3.1 1.9 3 1.9 3h1.1v-1.6s-.1-1.9 1.9-1.9h3.3s1.8 0 1.8-1.8V4.8S14.8 2 11.9 2zm-1.6 1a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4z"/><path fill="#FFD43B" d="M12.1 22c3.1 0 2.9-1.3 2.9-1.3l-.01-1.4h-3v-.4h5.8s2.2.3 2.2-2.9c0-3.1-1.9-3-1.9-3h-1.1v1.6s.1 1.9-1.9 1.9H11.8s-1.8 0-1.8 1.8v2.9s-.9 2.8 2.1 2.8zm1.6-1a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4z"/>'),
  go: svgWrap('<path fill="#00ADD8" d="M4 10.5c0-2.5 2-4.5 4.5-4.5 1.7 0 3.2 1 3.9 2.5l-1.9.9c-.4-.9-1.2-1.4-2-1.4-1.4 0-2.5 1.1-2.5 2.5s1.1 2.5 2.5 2.5c1 0 1.7-.5 2.1-1.2H8.5v-1.9h4.5v3.4c-1 1.8-2.6 2.7-4.5 2.7C6 17 4 14.5 4 10.5zm11.5 4.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5zm0-2c1.4 0 2.5-1.1 2.5-2.5s-1.1-2.5-2.5-2.5-2.5 1.1-2.5 2.5 1.1 2.5 2.5 2.5z"/>'),
  java: svgWrap('<path fill="#5382A1" d="M8.5 19c3.5.5 7.5.5 10-.5-2.5 1.5-6.5 1.8-10 .5z"/><path fill="#E76F00" d="M13 3c-1.5 2-2 3.5 0 5.5-2-2-1-3.5 0-5.5zm-3 3c-1 1.5-1.5 2.5 0 4-1.5-1.5-.5-2.5 0-4zm5.5 5.5c2 1 4 2 2 4.5-1.5 2-5 2.5-8 2.5 5 0 7.5-1 6-7z"/>'),
  kotlin: svgWrap('<path fill="#7F52FF" d="M2 2h20L12 12 22 22H2V2z"/><path fill="#C711E1" d="M2 12l10-10H2v10z"/><path fill="#E4485D" d="M12 12L2 22h10l5-5-5-5z"/>'),
  c: svgWrap('<circle cx="12" cy="12" r="10" fill="#00599C"/><path fill="#FFF" d="M15.5 8.5c-.8-.7-1.9-1.1-3.2-1.1-2.7 0-4.7 1.9-4.7 4.6s2 4.6 4.7 4.6c1.3 0 2.4-.4 3.2-1.1l-1.2-1.5c-.5.4-1.2.7-2 .7-1.6 0-2.7-1.1-2.7-2.7s1.1-2.7 2.7-2.7c.8 0 1.5.3 2 .7l1.2-1.5z"/>'),
  cpp: svgWrap('<circle cx="12" cy="12" r="10" fill="#004482"/><path fill="#FFF" d="M13 8.5c-.6-.5-1.4-.8-2.4-.8-2 0-3.5 1.4-3.5 3.5s1.5 3.5 3.5 3.5c1 0 1.8-.3 2.4-.8l-.9-1.1c-.4.3-.9.5-1.5.5-1.2 0-2-.8-2-2.1s.8-2.1 2-2.1c.6 0 1.1.2 1.5.5l.9-1.1zm2.5 2h1v1.5H18v1h-1.5V14h-1v-1.5H14v-1h1.5V10.5zm3.5 0h1v1.5h1.5v1H20V14h-1v-1.5h-1.5v-1H19V10.5z"/>'),
  csharp: svgWrap('<circle cx="12" cy="12" r="10" fill="#68217A"/><path fill="#FFF" d="M12.5 9c-.6-.5-1.4-.8-2.3-.8-1.9 0-3.4 1.4-3.4 3.4s1.5 3.4 3.4 3.4c.9 0 1.7-.3 2.3-.8l-.9-1.1c-.4.3-.9.5-1.4.5-1.1 0-2-.8-2-2s.9-2 2-2c.5 0 1 .2 1.4.5l.9-1.1zm3 1h.8l-.3 1.2h.9v.8h-.9l-.3 1.2h.9v.8h-.9l-.4 1.6h-.8l.4-1.6h-1.2l-.4 1.6h-.8l.4-1.6H13v-.8h.8l.3-1.2H13v-.8h.8l.4-1.2h.8l-.4 1.2h1.2l.4-1.2zm-.3 2h-1.2l-.3 1.2h1.2l.3-1.2z"/>'),
  php: svgWrap('<ellipse cx="12" cy="12" rx="10" ry="6.5" fill="#777BB4"/><path fill="#FFF" d="M6 10h1.8c.8 0 1.4.4 1.4 1.1 0 .8-.6 1.2-1.4 1.2H6.9L6.5 14H5.2L6 10zm1.7 1.4c.3 0 .5-.1.5-.4 0-.2-.2-.3-.5-.3h-.6l-.1.7h.7zm3.4-1.4h1.3l-.4 1.6h1.2c.8 0 1.3.4 1.3 1.1 0 .8-.6 1.3-1.4 1.3h-1.8L12.7 14h-1.3l1.1-4zm1.9 1.9c.3 0 .5-.1.5-.4 0-.2-.2-.3-.5-.3h-.5l-.2.7h.7zm4.2-1.9h1.8c.8 0 1.4.4 1.4 1.1 0 .8-.6 1.2-1.4 1.2h-.9l-.4 1.7h-1.3l.8-4zm1.7 1.4c.3 0 .5-.1.5-.4 0-.2-.2-.3-.5-.3h-.6l-.1.7h.7z"/>'),
  ruby: svgWrap('<path fill="#CC342D" d="M4 8.5L8 3h8l4 5.5-8 12.5L4 8.5zm3.5-4L4.8 8h3.9L7.5 4.5zM9 4.2V8h6V4.2H9zm7.5.3L15.3 8h3.9L16.5 4.5zM5.3 9.5l5.9 9.2V9.5H5.3zm7.5 0v9.2l5.9-9.2h-5.9z"/>'),
  swift: svgWrap('<path fill="#F05138" d="M19.5 15.5c-3 3-7.5 3.5-11 1.5 2-1 3.5-2.5 4-4.5-2 .5-4 .5-5.5-.5 3-1.5 4.5-4 5-6.5-1.5 1-3.5 1.5-5 .5 3-2 4.5-5 5-7.5C8 1 4 4.5 3 9c-1 4.5 1 9.5 5 12.5 4 3 9.5 2.5 13.5-1.5l-2-4.5z"/>'),
  dart: svgWrap('<path fill="#0175C2" d="M4 14l3-9h10l3 3-6 12H7L4 14z"/><path fill="#00B4AB" d="M10 5l4 4-7 7-3-2 6-9z"/><path fill="#02569B" d="M14 9l6 3-6 8H8l6-11z"/>'),
  
  html: svgWrap('<path fill="#E44D26" d="M3 2l1.6 18 7.4 2 7.4-2L21 2H3z"/><path fill="#F16529" d="M12 3.8v16.4l5.9-1.6L19.2 3.8H12z"/><path fill="#EBEBEB" d="M12 8.2H8.3l-.2-2.5h7.8V3.8H6.1l.6 6.7H12V8.2zm0 6.6l-3.3-.9-.2-2.5H6.3l.4 4.5 5.3 1.5v-2.6z"/><path fill="#FFF" d="M12 8.2v2.3h3.5l-.3 3.6-3.2.9v2.6l5.3-1.5.6-7.9H12z"/>'),
  css: svgWrap('<path fill="#1572B6" d="M3 2l1.6 18 7.4 2 7.4-2L21 2H3z"/><path fill="#33A9DC" d="M12 3.8v16.4l5.9-1.6L19.2 3.8H12z"/><path fill="#EBEBEB" d="M12 8.2H8.3l-.2-2.5h7.8V3.8H6.1l.6 6.7H12V8.2zm0 6.6l-3.3-.9-.2-2.5H6.3l.4 4.5 5.3 1.5v-2.6z"/><path fill="#FFF" d="M12 8.2v2.3h3.5l-.3 3.6-3.2.9v2.6l5.3-1.5.6-7.9H12z"/>'),
  scss: svgWrap('<path fill="#CD6799" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm3.5 13.8c-1.8.8-3.9.5-4.8-.8-.6-.9-.3-1.8.5-2.3 1-.6 2.3-.6 3.4-1 .9-.4 1.3-.9 1.1-1.6-.2-.8-1-1.2-2.1-1-1.2.2-2.3.8-3.2 1.5l-.8-1.5c1.2-.9 2.7-1.5 4.3-1.7 2.2-.2 3.6.8 4 2.2.4 1.5-.2 2.7-1.6 3.4-1.1.5-2.3.6-3.4 1-.7.3-1 .7-.8 1.2.2.7.9 1.1 1.9 1 1.1-.1 2.2-.6 3.1-1.2l.4 1.8z"/>'),
  json: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#FBC02D" rx="3"/><path fill="#000" d="M8 7c-.6 0-1 .4-1 1v2c0 .6-.4 1-1 1 .6 0 1 .4 1 1v2c0 .6.4 1 1 1h1v-1.5H8.5v-1.8c0-.7-.4-1.3-1-1.5.6-.2 1-.8 1-1.5V8.5H9V7H8zm8 0h-1v1.5h.5v1.7c0 .7.4 1.3 1 1.5-.6.2-1 .8-1 1.5v1.8H15V17h1c.6 0 1-.4 1-1v-2c0-.6.4-1 1-1-.6 0-1-.4-1-1V8c0-.6-.4-1-1-1z"/>'),
  yaml: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#CB171E" rx="3"/><path fill="#FFF" d="M7 6.5l2.5 4.5v5.5H11v-5.5l2.5-4.5h-1.8L10.2 9.5 8.7 6.5H7zm7.5 4c-.8 0-1.5.7-1.5 1.5v4.5h1.5v-4.5c0-.2.1-.3.3-.3s.3.1.3.3v4.5h1.5v-4.5c0-.8-.7-1.5-1.5-1.5z"/>'),
  toml: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#9C27B0" rx="3"/><path fill="#FFF" d="M6 7h12v2.5h-4.5V17h-3V9.5H6V7z"/>'),
  xml: svgWrap('<path fill="#E65100" d="M12 2L3 7v10l9 5 9-5V7l-9-5zm-3.5 12.5l-1.4-1.4L9.2 11l-2.1-2.1L8.5 7.5 12 11l-3.5 3.5zm7 0L12 11l3.5-3.5 1.4 1.4L14.8 11l2.1 2.1-1.4 1.4z"/>'),
  sql: svgWrap('<ellipse cx="12" cy="6" rx="8" ry="3" fill="#0288D1"/><path fill="#0277BD" d="M4 6v5c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0 1.7-3.6 3-8 3S4 7.7 4 6z"/><path fill="#01579B" d="M4 11v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5c0 1.7-3.6 3-8 3s-8-1.3-8-3z"/>'),
  markdown: svgWrap('<rect width="20" height="16" x="2" y="4" fill="#083FA1" rx="2"/><path fill="#FFF" d="M5 8v8h2.5v-4.5l2 2.5 2-2.5V16H14V8h-2.5l-2 2.5-2-2.5H5zm11 0l-3 4h2v4h2v-4h2l-3-4z"/>'),
  docker: svgWrap('<path fill="#2496ED" d="M21.5 11c-.3 0-1.2.1-1.8.5-.4-.8-1.1-1.3-2-1.4l-.5-.1-.2.5c-.3.8-.2 1.7.3 2.4-1.2.1-5.3.3-7.3 2.1H2.5c-.3.8.2 2.5 1.5 3.5 2.5 2 6.5 2 9.5 2 4.5 0 8-2 8.5-6.5.9-.2 1.5-.9 1.5-1.5 0-.5-.9-1-2-1zM5 12h2v2H5v-2zm3 0h2v2H8v-2zm3 0h2v2h-2v-2zm-3-3h2v2H8V9zm3 0h2v2h-2V9zm3 0h2v2h-2V9zm0 3h2v2h-2v-2zm3-3h2v2h-2V9zm0 3h2v2h-2v-2z"/>'),
  git: svgWrap('<path fill="#F05032" d="M21.7 10.7l-8.4-8.4c-.9-.9-2.5-.9-3.4 0L7.6 4.6l3.3 3.3c.8-.3 1.7-.1 2.3.5.6.6.8 1.5.5 2.3l3.2 3.2c.8-.3 1.7-.1 2.3.5.9.9.9 2.5 0 3.4-.9.9-2.5.9-3.4 0-.7-.7-.9-1.7-.5-2.5l-3-3v4.6c.4.3.7.8.7 1.4 0 1.1-.9 2-2 2s-2-.9-2-2c0-.6.3-1.1.7-1.4V9.6c-.4-.3-.7-.8-.7-1.4 0-.8.5-1.5 1.2-1.8L6.2 3.2 2.3 7.1c-.9.9-.9 2.5 0 3.4l8.4 8.4c.9.9 2.5.9 3.4 0l7.6-7.6c.9-.9.9-2.4 0-3.6z"/>'),
  npm: svgWrap('<rect width="20" height="20" x="2" y="2" fill="#CB3837" rx="3"/><path fill="#FFF" d="M5 5v14h7V8.5h3.5V19H19V5H5z"/>'),
  lock: svgWrap('<rect width="14" height="10" x="5" y="10" fill="#FFA000" rx="2"/><path fill="#FFD54F" d="M8 10V7c0-2.2 1.8-4 4-4s4 1.8 4 4v3h-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v3H8z"/><circle cx="12" cy="15" r="1.5" fill="#3E2723"/>'),
  terminal: svgWrap('<rect width="20" height="16" x="2" y="4" fill="#263238" rx="2"/><path fill="#4CAF50" d="M6 8l4 3-4 3v-2l1.5-1L6 10V8zm5 5h5v2h-5v-2z"/>'),
  image: svgWrap('<rect width="18" height="14" x="3" y="5" fill="#4CAF50" rx="2"/><circle cx="8" cy="9.5" r="1.5" fill="#FFEB3B"/><path fill="#388E3C" d="M3 17l5-6 4 5 3-4 4 5H3z"/>'),
  font: svgWrap('<rect width="18" height="18" x="3" y="3" fill="#FF5722" rx="3"/><path fill="#FFF" d="M11 6h2l4.5 12h-2.2l-1.1-3.2H9.8L8.7 18H6.5L11 6zm1.8 7l-1.3-4.1h-.1L10.1 13h2.7z"/>'),
  config: svgWrap('<circle cx="12" cy="12" r="9" fill="#78909C"/><path fill="#FFF" d="M19.4 13c0-.3.1-.7.1-1s0-.7-.1-1l2.1-1.7c.2-.2.2-.4.1-.6l-2-3.5c-.1-.2-.4-.3-.6-.2l-2.5 1c-.5-.4-1.1-.7-1.8-.9l-.4-2.7c0-.2-.2-.4-.5-.4h-4c-.3 0-.5.2-.5.4l-.4 2.7c-.7.3-1.3.6-1.8.9l-2.5-1c-.2-.1-.5 0-.6.2l-2 3.5c-.1.2-.1.4.1.6l2.1 1.7c0 .3-.1.7-.1 1s0 .7.1 1l-2.1 1.7c-.2.2-.2.4-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.8.9l.4 2.7c0 .2.2.4.5.4h4c.3 0 .5-.2.5-.4l.4-2.7c.7-.3 1.3-.6 1.8-.9l2.5 1c.2.1.5 0 .6-.2l2-3.5c.1-.2.1-.4-.1-.6L19.4 13zm-7.4 2.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>'),
  file: svgWrap('<path fill="#90A4AE" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>'),
};

const EXTENSION_MAP: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  rs: 'rust',
  py: 'python', pyc: 'python',
  go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', gemfile: 'ruby',
  swift: 'swift', dart: 'dart',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'config', env: 'config',
  xml: 'xml', sql: 'sql',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal', fish: 'terminal', ps1: 'terminal', bat: 'terminal', cmd: 'terminal',
  dockerfile: 'docker',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image',
  ttf: 'font', woff: 'font', woff2: 'font', otf: 'font',
  lock: 'lock',
  txt: 'file', log: 'file',
};

const EXACT_FILE_MAP: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  'cargo.toml': 'rust',
  'cargo.lock': 'lock',
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'readme.md': 'markdown',
  'license': 'config',
  'license.md': 'config',
  'tsconfig.json': 'ts',
  'vite.config.ts': 'ts',
  'vite.config.js': 'js',
};

const FOLDER_MAP: Record<string, string> = {
  src: 'folderSrc',
  source: 'folderSrc',
  test: 'folderTest',
  tests: 'folderTest',
  __tests__: 'folderTest',
  dist: 'folder',
  build: 'folder',
  node_modules: 'folderNode',
  '.git': 'folderGit',
};

export const materialResolver: IconResolver = {
  resolve(name: string, isFolder: boolean, isOpen: boolean): IconResult {
    const lower = name.toLowerCase();
    if (isFolder) {
      const special = FOLDER_MAP[lower];
      if (special && ICONS[special]) {
        return { type: 'svg', svg: ICONS[special] };
      }
      return { type: 'svg', svg: isOpen ? ICONS.folderOpen : ICONS.folder };
    }

    const exact = EXACT_FILE_MAP[lower];
    if (exact && ICONS[exact]) {
      return { type: 'svg', svg: ICONS[exact] };
    }

    const parts = lower.split('.');
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join('.');
      const match = EXTENSION_MAP[ext];
      if (match && ICONS[match]) {
        return { type: 'svg', svg: ICONS[match] };
      }
    }

    return { type: 'svg', svg: ICONS.file };
  },
};
