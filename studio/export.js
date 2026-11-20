// Assembles the folder a visitor uploads to publish their open agentic website:
// the data files from the Project, a page that mounts the assistant, and the browser runtime.
import { createZip } from "./zip.js";

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const ASSISTANT_CSS = `/* Assistant layout, from the agentify-website skill. Change --ns-primary to your brand colour. */
body { font-family: system-ui, sans-serif; margin: 0; color: #1f2328; background: #f6f8fa; }
main { width: min(960px, 100% - 32px); margin: 0 auto; padding: 32px 0 64px; }
.assistant { margin-top: 40px; }
.assistant-note { color: #59636e; font-size: 0.9rem; }
#agent-app {
  --ns-font: system-ui, sans-serif;
  --ns-bg: #ffffff;
  --ns-fg: #1f2328;
  --ns-primary: #2c4fa3;
  --ns-accent: #2c4fa3;
  --ns-border: #d0d7de;
  --ns-panelbg: #ffffff;
  --ns-msgbg: #f1f3f9;
  --ns-muted: #59636e;
}
.assistant-panels { display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 16px; margin-top: 16px; }
#agent-app.ns-composed-app [data-ns-slot="chat"] { height: 640px; }
#agent-app .ns-chat { background: var(--ns-bg); }
#agent-app input[type="checkbox"], #agent-app input[type="radio"] { width: auto; }
#agent-app .ns-header { flex-wrap: wrap; }
#agent-app button { margin: 0; }
#agent-app .ns-msg { overflow-wrap: break-word; }
#agent-app .ns-consent { background: #fffbeb; }
#agent-app .ns-consent-actions { flex-wrap: wrap; }
#agent-app .ns-consent-actions button { white-space: nowrap; }
body > dialog button { margin-right: 8px; }
@media (max-width: 760px) { .assistant-panels { grid-template-columns: 1fr; } }
`;

function indexHtml(project) {
  const brand = escapeHtml(project.brand);
  const description = escapeHtml(project.description || "Ask this site's assistant.");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${brand}</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="assistant.css">
  <script type="module" src="site.js"></script>
</head>
<body>
  <main>
    <h1>${brand}</h1>
    <p>${description}</p>
    <!-- Replace this page with your own content, or copy the section below, assistant.css
         and the <script> tag into your existing page. Keep the ids: site.js uses
         #assistant-status and #agent-app. -->
    <section id="assistant" class="assistant" aria-labelledby="assistant-heading">
      <h2 id="assistant-heading">Ask ${brand}</h2>
      <p class="assistant-note">Your messages go to the AI provider you choose in the settings below. This site does not pay for them and never sees your key.</p>
      <p id="assistant-status" role="status">Connecting the assistant… If this message stays, the assistant could not load.</p>
      <div id="agent-app">
        <div data-ns-slot="header"></div>
        <div class="assistant-panels">
          <div data-ns-slot="chat"></div>
          <div data-ns-slot="agents"></div>
        </div>
        <div data-ns-slot="settings"></div>
      </div>
    </section>
  </main>
</body>
</html>
`;
}

function siteJs(project) {
  const greeting = JSON.stringify(project.description || "How can I help?");
  return `// Mounts the assistant. Load it with <script type="module" src="site.js"></script>.
const GREETING = ${greeting};

async function start() {
  const status = document.querySelector("#assistant-status");
  const siteBase = new URL("./", import.meta.url).href;
  try {
    const { boot } = await import("./runtime/index.js");
    const booted = await boot("#agent-app", {
      originUrl: siteBase,
      sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
    });
    const needsKey = !booted.engine.mockLLM && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
    status.textContent = needsKey
      ? "The assistant needs your AI provider key. Add it in AI model settings below."
      : "Assistant connected to this page.";
    if (!needsKey) {
      const first = document.querySelector("#ns-msgs .ns-msg.bot");
      if (first) {
        first.textContent = GREETING;
      }
    }
  } catch (error) {
    status.textContent = "The assistant could not load. The page still works without it.";
    console.error("Assistant startup failed", error);
  }
}

await start();
`;
}

function readme(project) {
  return `# ${project.brand}

This folder is an open agentic website made with Agent Forge. It follows the Minimum Viable
Specification for a Worldwide Agentic Web (Profile 0.3).

- \`agent-manifest.json\`, \`${project.networkName}.network.json\`, \`links.json\`: the public description of your agent network.
- \`runtime/\`: the browser runtime (nsdeploy, Apache 2.0). It runs the network in the visitor's browser, on the visitor's own AI key.
- \`index.html\`, \`site.js\`, \`assistant.css\`: a page that mounts the assistant. Replace the page, or copy the assistant section into your own.
- \`forge-project.json\`: your draft. Open it again in Agent Forge with **Import**.

## Publish on GitHub Pages

1. Create a public repository and upload everything in this folder, including the \`.well-known\` folder.
2. In the repository, open Settings, then Pages. Choose the \`main\` branch and the root folder.
3. Your network URL is \`https://<user>.github.io/<repository>/${project.networkName}\`.
4. Check it in Agent Forge or with \`node validator/cli.mjs <network URL>\`.

\`.nojekyll\` is included so GitHub serves the \`.well-known\` folder.

## Notes

- The network file is public. Do not put secrets or private data in the instructions or the facts.
- Visitors pay for the model calls with their own key. Keep the facts short.
- Peers: other sites can call this network by its URL, and it can call the peers you listed in Agent Forge, after the visitor agrees.
`;
}

/**
 * :param project: A Project.
 * :param runtime: {paths: string[], read: (path) => Promise<string>} for the runtime folder.
 * :return: [{path, data}] ready for createZip.
 */
export async function buildBundle(project, runtime) {
  const entries = [];
  for (const [path, data] of project.files()) {
    entries.push({ path, data });
  }
  entries.push(
    { path: "index.html", data: indexHtml(project) },
    { path: "site.js", data: siteJs(project) },
    { path: "assistant.css", data: ASSISTANT_CSS },
    { path: "README.md", data: readme(project) },
    { path: ".nojekyll", data: "" },
    { path: "forge-project.json", data: `${JSON.stringify(project, null, 2)}\n` },
  );
  for (const path of runtime.paths) {
    entries.push({ path: `runtime/${path}`, data: await runtime.read(path) });
  }
  return entries;
}

export async function buildZip(project, runtime) {
  return createZip(await buildBundle(project, runtime));
}
