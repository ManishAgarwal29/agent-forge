# Agent Forge

Agent Forge builds, checks and tests an agent network for a website in the browser, then gives you a folder that publishes it as an open agentic website. No server, no Node, no build step.

Publishing an agent network today means installing Node, running a coding agent against the agentify-website skill, and copying runtime files by hand. Forge replaces that with a workspace for a site owner who has never built an agent.

1. **Start** from a template (cafe, local service, docs) or ask Forge's assistant to draft it from your facts.
2. **Edit** the site facts and the agents.
3. **Check** the draft against the [Minimum Viable Specification for a Worldwide Agentic Web](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md) (Profile 0.3), live, as you type.
4. **Try** it in a chat. The preview runs the draft in the same browser runtime a visitor's browser would use. Without a saved AI key it is a dry run that shows which agents your network calls. With a key, replies are real.
5. **Download** a zip with the manifest, network file, page, runtime, README and `.nojekyll`, and upload it to GitHub Pages or any static host.

## What is in it

| Part | Where |
| --- | --- |
| Draft model and file generator | `studio/project.js` |
| Templates | `studio/templates.js` |
| In-memory site used by the linter and the preview | `studio/virtual-site.js` |
| Zip writer and bundle builder | `studio/zip.js`, `studio/export.js` |
| Preview frame | `studio/preview.html`, `studio/preview.js` |
| Conformance linter (browser and Node 22, no dependencies) | `validator/validator.js` |
| Command line and CI use | `validator/cli.mjs`, `action.yml` |
| Forge as an open agentic website | `agent-manifest.json`, `agent_forge.network.json` (source: `agent_forge.hocon`), `site-actions.js`, `runtime/` |
| Reads Forge shares with other agentic sites | `bridge/bridge-actions.js` |

## The agent network

`forge_guide` is the front agent. It owns the website tools and delegates to `site_architect` (how many agents, and what each does) and `copywriter` (role instructions). Its tools edit the draft the visitor sees: `get_project`, `update_site`, `upsert_agent`, `remove_agent`, `set_peers`, `run_checks`, `get_starter_templates`, `load_template` and `validate_site`.

- Every change is visible in the workspace and reversible with Undo. Replacing the whole draft with a template is the one `irreversible` action, so the runtime asks first.
- The agent is told never to invent facts about the visitor's site. Facts come only from the visitor.
- Before it adds a peer it runs `validate_site` and refuses peers that are not conformant or score under 60.

Other sites can load `…/agent_forge` as a peer. Through Forge's action bridge their agents get `validate_site` and `get_starter_templates`.

## What the linter checks

Each check is a MUST, SHOULD or MAY, weighted 10, 4 and 1. A failed MUST makes the site non-conformant and caps the score at 49. It covers: reachable manifest and network file, CORS, data-only JSON, the runtime's own graph validation, front agent, input schemas, instructions, credentials in public text, instructions that hide behaviour, peer allow-lists, private-context rules, execution limits and the action bridge. It reads public files only and does not run a site's agents. A passing score means the site is well formed, not that its answers are right.

Studio-level hints go further for a draft: missing or sample facts, instruction size (visitors pay for it on every call), unnamed peers.

## Run it

```shell
node scripts/dev-server.mjs --port 8090      # http://localhost:8090/agent-forge/
node --test "tests/*.test.mjs"
node validator/cli.mjs <network URL> --min-score 75
node scripts/runtime-files.mjs               # after changing runtime/
```

The assistant needs an LLM key that you enter in **AI model settings** (Otari, OpenRouter, OpenAI and others). The workspace, the linter and the dry-run preview need none.

## Check a site in CI

```yaml
- uses: <owner>/agent-forge@main
  with:
    url: https://your-site.example/your_network
    min-score: 75
```

## Publish Forge on GitHub Pages

Push to `main` and set Pages to "GitHub Actions". `.github/workflows/pages.yml` runs the tests and deploys. Forge has no URL baked in, so any repository name works. GitHub Pages serves every file with `Access-Control-Allow-Origin: *`.

## Credits

`runtime/` is the browser runtime from the agentic-web repository's `agentify-website` skill (nsdeploy, Apache 2.0, see `runtime/LICENSE.txt`). Agent Forge is Apache 2.0.
