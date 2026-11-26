/** Promise-based wrapper around the shared confirmation dialog. */
export function askConfirm(title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
  const dialog = document.getElementById("confirm-dialog");
  const titleElement = document.getElementById("confirm-title");
  const messageElement = document.getElementById("confirm-message");
  const ok = document.getElementById("confirm-ok");
  const cancel = document.getElementById("confirm-cancel");
  if (!(dialog instanceof HTMLDialogElement) || !titleElement || !messageElement || !ok || !cancel) {
    return Promise.resolve(window.confirm(message));
  }

  titleElement.textContent = title;
  messageElement.textContent = message;
  ok.textContent = confirmLabel;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancelEvent);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onCancelEvent = (event: Event): void => {
      event.preventDefault();
      finish(false);
    };

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancelEvent);
    dialog.showModal();
    ok.focus();
  });
}
