import assert from "node:assert/strict";
import { test } from "node:test";
import { ForgeApp } from "../app.js";
import { PEER_CHECK_ID, PeerChecker, applyPeerGate, peerPasses } from "../studio/peer-gate.js";
import { getTemplate } from "../studio/templates.js";
import { scoreChecks } from "../validator/validator.js";

/** A fake web: one good peer, one that leaks a credential, and nothing else. */
function peerWeb(counter = { calls: 0 }) {
  const good = getTemplate("docs").build();
  const bad = getTemplate("docs").build();
  bad.networkName = "leaky";
  bad.facts = "Admin api_key = sk-abcdefghijklmnopqrstuvwxyz123456";
  const sites = { "https://good.example": good, "https://bad.example": bad };
  return async url => {
    counter.calls += 1;
    const { origin, pathname } = new URL(url);
    const body = sites[origin]?.files().get(pathname.slice(1));
    return body === undefined
      ? new Response("not found", { status: 404, headers: { "access-control-allow-origin": "*" } })
      : new Response(body, { status: 200, headers: { "access-control-allow-origin": "*" } });
  };
}

const GOOD = { url: "https://good.example/docs_guide", label: "Docs" };
const BAD = { url: "https://bad.example/leaky", label: "Leaky" };
const GONE = { url: "https://nowhere.example/ghost", label: "Ghost" };

test("scoreChecks matches the validator's rules", () => {
  const pass = { category: "safety", level: "must", status: "pass" };
  assert.deepEqual(scoreChecks([pass]), { score: 100, grade: "A", conformant: true, categories: { safety: 100 } });
  const scored = scoreChecks([pass, { ...pass, status: "fail" }]);
  assert.equal(scored.conformant, false);
  assert.ok(scored.score <= 49);
});

test("applyPeerGate leaves a draft without peers alone and fails one with a bad peer", () => {
  const report = { checks: [{ id: "x", category: "conformance", level: "must", status: "pass" }], score: 100, conformant: true };
  assert.equal(applyPeerGate(report, []), report);
  const good = { url: GOOD.url, score: 100, conformant: true, failed: [] };
  const bad = { url: BAD.url, score: 49, conformant: false, failed: ["safety.secrets"] };
  assert.equal(applyPeerGate(report, [good]).conformant, true);
  const gated = applyPeerGate(report, [good, bad]);
  assert.equal(gated.conformant, false);
  const check = gated.checks.find(c => c.id === PEER_CHECK_ID);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /bad\.example\/leaky.*safety\.secrets/);
  assert.equal(peerPasses({ conformant: true, score: 59 }), false);
});

test("the checker reuses a recent result unless asked for a fresh one", async () => {
  const counter = { calls: 0 };
  const checker = new PeerChecker({ fetchImpl: peerWeb(counter) });
  await checker.check(GOOD.url);
  const after = counter.calls;
  await checker.check(GOOD.url);
  assert.equal(counter.calls, after);
  await checker.check(GOOD.url, { fresh: true });
  assert.ok(counter.calls > after);
});

test("a peer added by hand fails the draft's checks, and a good one passes", async () => {
  const app = new ForgeApp({}, { fetchImpl: peerWeb() });
  app.project = getTemplate("cafe").build();
  app.project.peers = [GOOD];
  await app.lint();
  assert.equal(app.report.conformant, true);
  assert.equal(app.report.checks.find(c => c.id === PEER_CHECK_ID).status, "pass");

  // As if typed into the Peers section: no set_peers, no model.
  app.project.peers = [GOOD, BAD];
  await app.lint();
  assert.equal(app.report.conformant, false);
  assert.ok(app.report.score <= 49);

  app.project.peers = [GONE];
  await app.lint();
  assert.equal(app.report.conformant, false, "an unreadable peer fails closed");
});

test("Download refuses while a peer fails, and says why", async () => {
  const app = new ForgeApp({}, { fetchImpl: peerWeb() });
  app.project = getTemplate("cafe").build();
  app.project.peers = [BAD];
  const result = await app.exportZip();
  assert.equal(result.ok, false);
  assert.match(result.reason, /Not downloaded/);
  assert.match(result.reason, /bad\.example\/leaky/);
});

test("the agent's set_peers still refuses a bad list and keeps the old one", async () => {
  const app = new ForgeApp({}, { fetchImpl: peerWeb() });
  app.project = getTemplate("cafe").build();
  assert.equal((await app.setPeers([GOOD])).ok, true);
  const refused = await app.setPeers([GOOD, BAD]);
  assert.equal(refused.ok, false);
  assert.deepEqual(app.project.peers.map(p => p.url), [GOOD.url]);
});
