import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ForgeApp } from "../app.js";
import { ActionRegistry } from "../runtime/actions.js";
import { AgentNetwork, validateNetwork } from "../runtime/kernel.js";
import { SiteActions, registerActions } from "../site-actions.js";
import { getTemplate } from "../studio/templates.js";
import { validateSite } from "../validator/validator.js";

const read = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

/** Serve the repository's own files as if they were hosted at the dev address. */
function repoFetch() {
  const base = "http://localhost:8090/agent-forge/";
  return async url => {
    if (!url.startsWith(base)) {
      return new Response("nope", { status: 404 });
    }
    try {
      const body = await readFile(new URL(`../${url.slice(base.length)}`, import.meta.url), "utf8");
      return new Response(body, { status: 200, headers: { "access-control-allow-origin": "*" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
}

test("Forge's own network passes the runtime's validation", async () => {
  const network = new AgentNetwork(await read("agent_forge.network.json"), "agent_forge");
  assert.deepEqual(validateNetwork(network).errors, []);
  assert.equal(network.findFrontMan(), "forge_guide");
});

test("the runtime accepts every action's schema, and the manifest lists exactly the registered actions", async () => {
  const manifest = await read("agent-manifest.json");
  const registry = new ActionRegistry();
  await registerActions({ register: registry.register.bind(registry, { base: "http://localhost:8090/agent-forge", network: "agent_forge" }) });
  const names = SiteActions.definitions().map(action => action.name);
  assert.deepEqual([...names].sort(), [...manifest.actions.agentTools].sort());
  assert.equal(SiteActions.definitions().find(action => action.name === "load_template").effect, "irreversible");
});

test("the bridge shares only reads, and only names the manifest lists", async () => {
  const manifest = await read("agent-manifest.json");
  const { registerActions: registerBridge } = await import("../bridge/bridge-actions.js");
  const shared = [];
  registerBridge({ register: action => shared.push(action) });
  assert.ok(shared.length > 0);
  for (const action of shared) {
    assert.equal(action.effect, "read");
    assert.equal(action.availability, "bridge");
    assert.ok(manifest.actions.agentTools.includes(action.name), `${action.name} must be in actions.agentTools`);
  }
});

test("Forge is conformant itself", async () => {
  const report = await validateSite("http://localhost:8090/agent-forge/agent_forge", { fetchImpl: repoFetch(), origin: "https://caller.example" });
  assert.equal(report.conformant, true, JSON.stringify(report.checks.filter(c => c.status === "fail")));
  assert.ok(report.score >= 95, `score ${report.score}: ${JSON.stringify(report.checks.filter(c => c.status !== "pass").map(c => c.id))}`);
});

test("the agent's actions edit the draft through the same methods as the page, and Undo reverses them", async () => {
  const app = new ForgeApp({});
  app.project = getTemplate("cafe").build();
  const actions = Object.fromEntries(SiteActions.definitions().map(action => [action.name, action]));
  ForgeApp.page = app;

  assert.equal((await actions.get_project.execute({})).project.networkName, "corner_cafe");
  assert.equal((await actions.update_site.execute({ brand: "Bean There", networkName: "BAD NAME" })).ok, false);
  assert.equal(app.project.brand, "Corner Cafe Assistant");
  assert.equal((await actions.update_site.execute({ brand: "Bean There", sampleQueries: ["Open on Sunday?"] })).ok, true);
  assert.equal(app.project.brand, "Bean There");
  assert.deepEqual(app.project.sampleQueries, ["Open on Sunday?"]);

  const added = await actions.upsert_agent.execute({ name: "event_planner", description: "Answers questions about private events.", instructions: "You answer questions about private events." });
  assert.deepEqual(added.agents, ["cafe_host", "allergen_expert", "event_planner"]);
  assert.equal((await actions.upsert_agent.execute({ name: "Bad Name", description: "x", instructions: "x" })).ok, false);
  assert.equal((await actions.remove_agent.execute({ name: "nobody" })).ok, false);

  const checked = await actions.run_checks.execute({});
  assert.equal(checked.conformant, true);
  assert.ok(checked.hints.some(hint => /sample/.test(hint.text)));

  assert.equal((await actions.set_peers.execute({ peers: [{ url: "http://insecure.example/x" }] })).ok, false);

  assert.equal((await actions.load_template.execute({ id: "docs" })).ok, true);
  assert.equal(app.project.networkName, "docs_guide");
});

/** A fake web: one good peer, one that leaks a credential, and nothing else. */
function peerWeb() {
  const good = getTemplate("docs").build();
  const bad = getTemplate("docs").build();
  bad.networkName = "leaky";
  bad.facts = "Admin api_key = sk-abcdefghijklmnopqrstuvwxyz123456";
  const sites = { "https://good.example": good, "https://bad.example": bad };
  return async url => {
    const { origin, pathname } = new URL(url);
    const project = sites[origin];
    const body = project?.files().get(pathname.slice(1));
    return body === undefined
      ? new Response("not found", { status: 404, headers: { "access-control-allow-origin": "*" } })
      : new Response(body, { status: 200, headers: { "access-control-allow-origin": "*" } });
  };
}

test("set_peers enforces the trust rule in code, whatever the model asks", async () => {
  const app = new ForgeApp({}, { fetchImpl: peerWeb() });
  app.project = getTemplate("cafe").build();
  ForgeApp.page = app;
  const setPeers = SiteActions.definitions().find(action => action.name === "set_peers");

  const accepted = await setPeers.execute({ peers: [{ url: "https://good.example/docs_guide", label: "Docs" }] });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(accepted.checked[0].conformant, true);
  assert.deepEqual(app.project.peerOrigins(), ["https://good.example"]);

  // One failing peer refuses the whole list and leaves the draft as it was.
  const leaky = await setPeers.execute({ peers: [{ url: "https://good.example/docs_guide" }, { url: "https://bad.example/leaky" }] });
  assert.equal(leaky.ok, false);
  assert.match(leaky.reason, /bad\.example\/leaky/);
  assert.match(leaky.reason, /safety\.secrets/);
  assert.deepEqual(app.project.peerOrigins(), ["https://good.example"]);

  // A peer that cannot be read fails closed.
  const missing = await setPeers.execute({ peers: [{ url: "https://nowhere.example/ghost" }] });
  assert.equal(missing.ok, false);
  assert.deepEqual(app.project.peerOrigins(), ["https://good.example"]);

  // An empty list is allowed: removing peers needs no check.
  assert.equal((await setPeers.execute({ peers: [] })).ok, true);
  assert.deepEqual(app.project.peers, []);
});

test("undo restores the previous draft", () => {
  const app = new ForgeApp({});
  app.project = getTemplate("cafe").build();
  app.loadTemplate("docs");
  assert.equal(app.project.networkName, "docs_guide");
  app.undo();
  assert.equal(app.project.networkName, "corner_cafe");
});

test("a template id that does not exist is refused without touching the draft", () => {
  const app = new ForgeApp({});
  app.project = getTemplate("cafe").build();
  assert.equal(app.loadTemplate("nope").ok, false);
  assert.equal(app.project.networkName, "corner_cafe");
});
