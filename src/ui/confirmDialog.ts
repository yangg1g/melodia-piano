/**
 * 非阻塞确认对话框
 */

export function showConfirm(
  msg: string,
  elements: {
    dialog: HTMLElement;
    msgEl: HTMLElement;
    okBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    elements.msgEl.textContent = msg;
    elements.dialog.hidden = false;
    const cleanup = (result: boolean) => {
      elements.dialog.hidden = true;
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    elements.okBtn.addEventListener('click', onOk, { once: true });
    elements.cancelBtn.addEventListener('click', onCancel, { once: true });
  });
}
