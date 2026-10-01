export class TabStripAutoScroller {
  private frame: number | undefined;
  private element: HTMLElement | null = null;
  private clientX = 0;
  private onScroll: () => void = () => undefined;
  private previousTime = 0;

  update(element: HTMLElement | null, clientX: number, onScroll: () => void): void {
    this.element = element;
    this.clientX = clientX;
    this.onScroll = onScroll;
    if (!element || this.speed() === 0) { this.stop(); return; }
    if (this.frame === undefined) this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.previousTime = 0;
  }

  private speed(): number {
    const element = this.element;
    if (!element || element.scrollWidth <= element.clientWidth) return 0;
    const rect = element.getBoundingClientRect();
    const edge = Math.min(40, rect.width / 3);
    if (edge <= 0 || this.clientX < rect.left - 40 || this.clientX > rect.right + 40) return 0;
    if (this.clientX < rect.left + edge && element.scrollLeft > 0) return -600 * Math.min(1, (rect.left + edge - this.clientX) / edge);
    if (this.clientX > rect.right - edge && element.scrollLeft < element.scrollWidth - element.clientWidth) return 600 * Math.min(1, (this.clientX - rect.right + edge) / edge);
    return 0;
  }

  private tick = (time: number): void => {
    this.frame = undefined;
    const speed = this.speed();
    if (!this.element || speed === 0) { this.stop(); return; }
    const elapsed = this.previousTime ? Math.min(32, time - this.previousTime) : 16;
    this.previousTime = time;
    const previous = this.element.scrollLeft;
    this.element.scrollLeft = Math.max(0, Math.min(this.element.scrollWidth - this.element.clientWidth, previous + speed * elapsed / 1000));
    if (previous !== this.element.scrollLeft) this.onScroll();
    if (this.speed() !== 0) {
      if (this.frame === undefined) this.frame = requestAnimationFrame(this.tick);
    } else this.stop();
  };
}
