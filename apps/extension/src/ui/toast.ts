let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const element = document.getElementById("toast");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("toast--error", kind === "error");
  element.hidden = false;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(
    () => {
      element.hidden = true;
    },
    kind === "error" ? 7000 : 4200,
  );
}
