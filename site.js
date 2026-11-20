// Mounts the assistant inside the page. Load it with:
//   <script type="module" src="site.js"></script>
import "./app.js";

/**
 * Boots the browser runtime in the page's assistant section.
 *
 * It points the runtime at this folder, so the manifest, network and actions load from
 * the same place as the page. Forge's actions change a draft the visitor can undo, so the
 * runtime's own confirmation dialog and consent card are enough.
 */
export class AssistantMount {
  /** The first chat message once the visitor has a key. */
  static GREETING = "Tell me about your website: what it is, who visits, and the facts a visitor asks about, such as prices, hours and policies. I will draft the agents, check them against the specification and fix what fails. You can undo anything I change.";

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      // Load the runtime here, so a missing or broken runtime is reported too.
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      AssistantMount.engine = booted.engine;
      const needsKey = !booted.engine.mockLLM
        && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
      status.textContent = needsKey
        ? "The assistant needs your AI provider key. Add it in AI model settings below. The workspace above works without one."
        : "Assistant connected to this page.";
      if (!needsKey) {
        AssistantMount.greet();
      }
      return booted.engine;
    } catch (error) {
      // The page must keep working without the assistant.
      status.textContent = "The assistant could not load. The workspace above still works.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /** Replace the runtime's general first chat message with GREETING. */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      first.textContent = AssistantMount.GREETING;
    }
  }
}

// Boot only in a browser. Node tests import this file to read the greeting.
if (typeof window !== "undefined") {
  await AssistantMount.start();
}
