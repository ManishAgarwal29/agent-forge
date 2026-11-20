// Runs the visitor's draft in the browser runtime, inside the preview frame.
//
// The runtime loads a site by fetching its files. Here every fetch to PREVIEW_BASE is
// answered from the draft in memory, and every other fetch (the AI provider, a peer) goes
// to the network as usual. So the preview runs the same files the download publishes.
import { PREVIEW_BASE } from "./project.js";
import { createVirtualFetch } from "./virtual-site.js";

const status = document.querySelector("#preview-status");
const page = window.parent?.ForgeApp?.page;

if (!page) {
  status.textContent = "Open this preview from the Forge workspace.";
} else {
  const realFetch = window.fetch.bind(window);
  window.fetch = createVirtualFetch(PREVIEW_BASE, () => page.previewFiles(), realFetch);
  try {
    const { boot } = await import("../runtime/index.js");
    const booted = await boot("#agent-app", {
      originUrl: PREVIEW_BASE,
      sandboxWorkerUrl: new URL("../runtime/sandbox-worker.js", import.meta.url).href,
    });
    const live = !booted.engine.mockLLM && booted.engine.byokKey && booted.engine.byokKey !== "demo";
    status.textContent = live
      ? "Live preview: replies come from your AI provider, using your saved key."
      : "Dry run: no AI key is saved, so replies are canned. It shows which agents your network calls. Save a key in the settings below the page to get real answers, then restart.";
  } catch (error) {
    status.textContent = `The preview could not start: ${error.message}`;
    console.error(error);
  }
}
