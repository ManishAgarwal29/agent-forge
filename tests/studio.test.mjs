import assert from "node:assert/strict";
import { crc32 as nodeCrc32 } from "node:zlib";
import { test } from "node:test";
import { validateSite } from "../validator/validator.js";
import { buildBundle, buildZip, factsHtml } from "../studio/export.js";
import { PREVIEW_BASE, Project, isValidName, slug } from "../studio/project.js";
import { TEMPLATES, getTemplate } from "../studio/templates.js";
import { createVirtualFetch } from "../studio/virtual-site.js";
import { createZip, crc32 } from "../studio/zip.js";

const lint = project => validateSite(`${PREVIEW_BASE}/${project.networkName}`, {
  fetchImpl: createVirtualFetch(PREVIEW_BASE, project.files()),
  checkPeers: false,
});

for (const template of TEMPLATES) {
  test(`template "${template.id}" publishes a conformant network`, async () => {
    const report = await lint(template.build());
    assert.equal(report.conformant, true, JSON.stringify(report.checks.filter(c => c.status === "fail")));
    assert.ok(report.score >= 90, `${template.id} scored ${report.score}: ${JSON.stringify(report.checks.filter(c => c.status !== "pass").map(c => c.id))}`);
  });
}

test("the front agent comes first and peers become its tools and labels", () => {
  const project = getTemplate("cafe").build();
  project.peers = [{ url: "https://peer.example/transit", label: "Transit" }];
  const network = project.buildNetwork();
  assert.equal(network.tools[0].name, "cafe_host");
  assert.deepEqual(network.tools[0].tools, ["allergen_expert", "https://peer.example/transit"]);
  assert.deepEqual(network.link_labels, { "https://peer.example/transit": "Transit" });
  assert.deepEqual(project.buildManifest().allowed_peers, ["https://peer.example"]);
  assert.match(network.tools[0].instructions, /Partner tools ask/);
  assert.doesNotMatch(network.tools[1].instructions, /Partner tools ask/);
});

test("a peer the draft lists is checked against its allowed_peers by the linter", async () => {
  const project = getTemplate("blank").build();
  project.peers = [{ url: "https://peer.example/transit", label: "Transit" }];
  const report = await lint(project);
  assert.equal(report.checks.find(c => c.id === "safety.peers.declared").status, "pass");
});

test("a draft with a broken reference, a missing front agent or a duplicate name is flagged", async () => {
  const project = getTemplate("cafe").build();
  project.agent("cafe_host").tools.push("ghost");
  // Unknown tool names are dropped when the network is built, so the published file stays valid.
  assert.equal((await lint(project)).conformant, true);
  project.front = "nobody";
  assert.ok(project.hints().some(h => h.level === "error" && /front agent/.test(h.text)));
  project.agents.push({ ...project.agents[0] });
  assert.ok(project.hints().some(h => /Two agents/.test(h.text)));
});

test("hints warn about missing facts, sample facts and oversized instructions", () => {
  const blank = Project.blank();
  assert.ok(blank.hints().some(h => /No site facts/.test(h.text)));
  assert.ok(getTemplate("cafe").build().hints().some(h => /sample/.test(h.text)));
  const big = Project.blank();
  big.facts = "x".repeat(7000);
  assert.ok(big.hints().some(h => /characters of instructions/.test(h.text)));
});

test("renaming and removing agents keeps references consistent", () => {
  const project = getTemplate("cafe").build();
  project.renameAgent("allergen_expert", "diet_expert");
  assert.deepEqual(project.agent("cafe_host").tools, ["diet_expert"]);
  project.removeAgent("diet_expert");
  assert.deepEqual(project.agent("cafe_host").tools, []);
  project.removeAgent("cafe_host");
  assert.equal(project.front, "");
});

test("a project survives a JSON round trip and clamps hostile input", () => {
  const original = getTemplate("service").build();
  const copy = new Project(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(copy.files(), original.files());
  const hostile = new Project({ networkName: "../../x", maxSteps: 9999, agents: Array.from({ length: 50 }, (_, i) => ({ name: `a${i}` })), facts: "y".repeat(10 ** 6) });
  assert.equal(hostile.networkName, "my_site");
  assert.equal(hostile.maxSteps, 30);
  assert.equal(hostile.agents.length, 12);
  assert.equal(hostile.facts.length, 20000);
});

test("names", () => {
  assert.equal(slug("Corner Cafe!"), "corner_cafe");
  assert.equal(slug("123"), "my_site");
  assert.equal(isValidName("a_b1"), true);
  assert.equal(isValidName("A"), false);
});

test("the virtual site serves drafts, answers 404 elsewhere and can fall through", async () => {
  const files = new Map([["agent-manifest.json", "{}"]]);
  const virtual = createVirtualFetch(PREVIEW_BASE, files);
  assert.equal((await virtual(`${PREVIEW_BASE}/agent-manifest.json`)).status, 200);
  assert.equal((await virtual(`${PREVIEW_BASE}/./agent-manifest.json`)).status, 200);
  assert.equal((await virtual(`${PREVIEW_BASE}/nope.json`)).status, 404);
  assert.equal((await virtual("https://other.example/x")).status, 404);
  const through = createVirtualFetch(PREVIEW_BASE, files, async () => new Response("real"));
  assert.equal(await (await through("https://other.example/x")).text(), "real");
});

test("zip entries have correct CRCs and a valid directory", () => {
  assert.equal(crc32(new TextEncoder().encode("hello world")), nodeCrc32("hello world"));
  const zip = createZip([{ path: "a.txt", data: "hello" }, { path: "dir/b.json", data: "{}" }, { path: ".nojekyll", data: "" }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 22 + 10, true), 3);
  const centralOffset = view.getUint32(zip.length - 22 + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  assert.equal(view.getUint32(centralOffset + 16, true), nodeCrc32("hello"));
});

test("facts become headings, lists, labels and paragraphs, all escaped", () => {
  const html = factsHtml("Opening hours: 8 to 5\n\nMenu:\n- Soup, 6.00\n- <b>Cake</b>\nWe bake daily & early.");
  assert.match(html, /<p><strong>Opening hours:<\/strong> 8 to 5<\/p>/);
  assert.match(html, /<h3>Menu<\/h3>/);
  assert.match(html, /<li>Soup, 6\.00<\/li>/);
  assert.match(html, /<li>&lt;b&gt;Cake&lt;\/b&gt;<\/li>/);
  assert.match(html, /<p>We bake daily &amp; early\.<\/p>/);
  assert.equal(factsHtml(""), "");
});

test("the page shows the facts, the sample questions, the limits and the credit", async () => {
  const project = getTemplate("cafe").build();
  project.sampleQueries = ["<script>x</script>?"];
  const entries = await buildBundle(project, { paths: [], read: async () => "" }, { forgeUrl: "https://forge.example/" });
  const page = entries.find(entry => entry.path === "index.html").data;
  assert.match(page, /<h2 id="facts-heading">About us<\/h2>/);
  assert.match(page, /Tomato Soup, 6\.50/);
  assert.match(page, /&lt;script&gt;x&lt;\/script&gt;\?/);
  assert.match(page, /Not available here:/);
  assert.match(page, /Made with <a href="https:\/\/forge\.example\/">Agent Forge<\/a>/);
  const bare = Project.blank();
  const plain = (await buildBundle(bare, { paths: [], read: async () => "" })).find(entry => entry.path === "index.html").data;
  assert.doesNotMatch(plain, /About us|Made with/);
});

test("the bundle holds the data files, the page, the runtime and the draft", async () => {
  const project = getTemplate("docs").build();
  project.brand = 'Docs <script>alert("x")</script>';
  const runtime = { paths: ["index.js", "generated/graph.gen.mjs"], read: async path => `// ${path}` };
  const entries = await buildBundle(project, runtime);
  const paths = entries.map(entry => entry.path);
  for (const expected of ["agent-manifest.json", "docs_guide.network.json", "links.json", ".well-known/nsdeploy.json", "index.html", "site.js", ".nojekyll", "forge-project.json", "runtime/index.js", "runtime/generated/graph.gen.mjs"]) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
  const page = entries.find(entry => entry.path === "index.html").data;
  assert.doesNotMatch(page, /<script>alert/);
  assert.ok((await buildZip(project, runtime)).length > 1000);
  assert.deepEqual(new Project(JSON.parse(entries.find(entry => entry.path === "forge-project.json").data)).files(), project.files());
});
