export function showBootError(error: unknown) {
  console.error("Mira failed to start.", error);
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;

  const content = document.createElement("div");
  content.id = "boot-error";
  content.setAttribute("role", "alert");

  const message = document.createElement("p");
  message.textContent = "Mira nu s-a putut încărca.";
  content.append(message);

  if (import.meta.env.DEV && error instanceof Error) {
    const detail = document.createElement("p");
    detail.textContent = error.message;
    content.append(detail);
  }

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reîncarcă";
  reload.addEventListener("click", () => window.location.reload());
  content.append(reload);
  bootShell.replaceChildren(content);
}
