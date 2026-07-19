/**
 * 倒计时覆盖层
 */

export function countdown(seconds: number, parent: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'countdown-overlay';
    parent.appendChild(overlay);

    let remaining = seconds;
    const tick = () => {
      overlay.textContent = String(remaining);
      remaining--;
      if (remaining < 0) {
        overlay.remove();
        resolve();
      } else {
        setTimeout(tick, 1000);
      }
    };
    tick();
  });
}
