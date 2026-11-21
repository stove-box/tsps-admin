// The window has no native frame: the panel's own top bar (or a plain bar on the starting screen)
// becomes the title bar. Drag it to move, double-click to maximize; X hides to the tray like before.
(() => {
  const call = (command) => window.__TAURI_INTERNALS__.invoke(`plugin:window|${command}`, { label: "main" });
  const ICONS = {
    minimize: '<path d="M5 12h14" />',
    toggle_maximize: '<rect x="5.5" y="5.5" width="13" height="13" rx="1" />',
    hide: '<path d="M6 6l12 12M18 6 6 18" />',
  };
  const LABELS = { minimize: "Minimize", toggle_maximize: "Maximize", hide: "Close to tray" };

  function install() {
    if (document.getElementById("tsps-window-controls")) return;
    let bar = document.querySelector("header.top-bar");
    if (!bar) {
      bar = document.createElement("header");
      bar.className = "tsps-plain-bar";
      document.body.prepend(bar);
    }
    // Drag from the bar and its text, not from its buttons.
    bar.setAttribute("data-tauri-drag-region", "");
    for (const el of bar.querySelectorAll(".bar-left, .logo, .title, .title *, .conn")) el.setAttribute("data-tauri-drag-region", "");

    const style = document.createElement("style");
    style.textContent = `
      .tsps-plain-bar { position: fixed; inset: 0 0 auto 0; height: 36px; display: flex; justify-content: flex-end; background: #121315; z-index: 2147483646; }
      #tsps-window-controls { display: flex; align-self: stretch; margin: 0 -14px 0 auto; }
      #tsps-window-controls button { width: 46px; border: 0; padding: 0; display: grid; place-items: center; cursor: default;
        background: transparent; color: #aaa59a; }
      #tsps-window-controls button:hover { background: rgba(202, 169, 94, .14); color: #e4dfd3; }
      #tsps-window-controls button.close:hover { background: #8c1d16; color: #fff; }
      #tsps-window-controls button:focus-visible { outline: 2px solid #ffff00; outline-offset: -2px; }
      #tsps-window-controls svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
      .tsps-plain-bar #tsps-window-controls { margin: 0; }`;
    document.head.append(style);

    const controls = document.createElement("div");
    controls.id = "tsps-window-controls";
    for (const command of ["minimize", "toggle_maximize", "hide"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = command === "hide" ? "close" : "";
      button.setAttribute("aria-label", LABELS[command]);
      button.title = LABELS[command];
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[command]}</svg>`;
      button.addEventListener("click", () => call(command));
      controls.append(button);
    }
    bar.append(controls);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
