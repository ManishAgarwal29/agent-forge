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
/* The page written from the draft: intro, facts and footer. */
h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); margin: 0 0 8px; line-height: 1.15; }
h2 { margin: 0 0 12px; }
.lead { font-size: 1.1rem; max-width: 62ch; }
.button { display: inline-block; background: #2c4fa3; color: #fff; padding: 9px 16px; border-radius: 10px; text-decoration: none; font-weight: 600; }
.facts { background: #fff; border: 1px solid #d0d7de; border-radius: 14px; padding: 20px 24px; margin-top: 28px; line-height: 1.55; }
.facts h3 { margin: 18px 0 6px; font-size: 1.05rem; }
.facts ul { margin: 0 0 10px; padding-left: 20px; }
.facts p { margin: 0 0 8px; }
.cannot { margin-top: 14px; padding: 10px 12px; background: #f6f8fa; border-radius: 10px; }
.try { margin: 0 0 4px; font-weight: 600; }
.samples { margin: 0 0 8px; padding-left: 20px; color: #3d444d; }
footer { width: min(960px, 100% - 32px); margin: 0 auto 40px; color: #59636e; font-size: 0.9rem; }
@media (max-width: 760px) { .assistant-panels { grid-template-columns: 1fr; } }
`;

/**
 * Turn the site facts into HTML, so the page shows people what the agents know.
 * Plain-text conventions: a short line ending in ":" is a heading, "- " starts a list item,
 * "Label: value" gets a bold label, and anything else is a paragraph. Everything is escaped.
 *
 * :param facts: The facts text.
 * :return: HTML, or "" when there are no facts.
 */
export function factsHtml(facts) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) {
      out.push(`      <ul>\n${list.map(item => `        <li>${item}</li>`).join("\n")}\n      </ul>`);
      list = [];
    }
  };
  const labelled = line => {
    const match = /^([^:]{2,40}):\s+(.+)$/.exec(line);
    return match ? `<strong>${escapeHtml(match[1])}:</strong> ${escapeHtml(match[2])}` : escapeHtml(line);
  };
  for (const raw of String(facts || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (/^[-*•]\s+/.test(line)) {
      list.push(labelled(line.replace(/^[-*•]\s+/, "")));
    } else if (line.endsWith(":") && line.length <= 60) {
      flush();
      out.push(`      <h3>${escapeHtml(line.slice(0, -1))}</h3>`);
    } else {
      flush();
      out.push(`      <p>${labelled(line)}</p>`);
    }
  }
  flush();
  return out.join("\n");
}

function indexHtml(project, options = {}) {
  const brand = escapeHtml(project.brand);
  const description = escapeHtml(project.description || "Ask this site's assistant.");
  const facts = factsHtml(project.facts);
  const samples = project.sampleQueries.map(query => `        <li>${escapeHtml(query)}</li>`).join("\n");
  const cannot = project.notSupported.trim() ? `\n      <p class="cannot"><strong>Not available here:</strong> this site cannot ${escapeHtml(project.notSupported.trim())}</p>` : "";
  const factsSection = facts ? `
    <section class="facts" aria-labelledby="facts-heading">
      <h2 id="facts-heading">About us</h2>
${facts}${cannot}
    </section>` : "";
  const samplesBlock = samples ? `
      <p class="try">Try asking:</p>
      <ul class="samples">
${samples}
      </ul>` : "";
  const credit = options.forgeUrl
    ? `\n  <footer><p>Made with <a href="${escapeHtml(options.forgeUrl)}">Agent Forge</a>. The assistant runs in your browser and answers only from the facts on this page.</p></footer>`
    : "";
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
    <header class="intro">
      <h1>${brand}</h1>
      <p class="lead">${description}</p>
      <p><a class="button" href="#assistant">Ask the assistant</a></p>
    </header>
    <!-- This page was written from your Forge draft. Edit it freely, or copy the assistant
         section below, assistant.css and the <script> tag into your existing page. Keep
         the ids: site.js uses #assistant-status and #agent-app. -->${factsSection}
    <section id="assistant" class="assistant" aria-labelledby="assistant-heading">
      <h2 id="assistant-heading">Ask ${brand}</h2>${samplesBlock}
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
  </main>${credit}
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
- \`index.html\`, \`site.js\`, \`assistant.css\`: a page written from your draft: your description, your facts, sample questions and the assistant. Edit it freely, or copy the assistant section into your own page.
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
 * :param options: {forgeUrl} to credit Agent Forge in the page footer.
 * :return: [{path, data}] ready for createZip.
 */
export async function buildBundle(project, runtime, options = {}) {
  const entries = [];
  for (const [path, data] of project.files()) {
    entries.push({ path, data });
  }
  entries.push(
    { path: "index.html", data: indexHtml(project, options) },
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

export async function buildZip(project, runtime, options = {}) {
  return createZip(await buildBundle(project, runtime, options));
}
