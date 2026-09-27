import '@testing-library/jest-dom/vitest';

if (typeof window !== 'undefined' && !window.ResizeObserver) {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = MockResizeObserver as unknown as typeof window.ResizeObserver;
  globalThis.ResizeObserver = window.ResizeObserver;
}

