// Agent Forge page: build an agent network for a website, check it as you type, try it in a
// chat, and download a folder that publishes it.
//
// The page and the assistant share one object, ForgeApp.page. The visitor's controls and the
// agent's website_* tools (site-actions.js) call the same methods, so the visitor always sees
// what the agent changed and can undo it.
import { h } from "./studio/dom.js";
import { buildZip } from "./studio/export.js";
import { PREVIEW_BASE, Project, isValidName, slug } from "./studio/project.js";
import { TEMPLATES, getTemplate } from "./studio/templates.js";
import { createVirtualFetch } from "./studio/virtual-site.js";
import { clip, compactReport } from "./validator/compact.js";
import { validateSite, verdictFor } from "./validator/validator.js";

const STORE_KEY = "forge.project.v1";
const MAX_UNDO = 25;
const LINT_DELAY_MS = 350;
const EDIT_BURST_MS = 1500;
const SITE_KEYS = ["brand", "networkName", "description", "sampleQueries", "facts", "notSupported", "model"];

/** Read and write the draft in localStorage, ignoring storage that is blocked or full. */
class Store {
  static load() {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      return raw ? new Project(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  static save(project) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(project));
    } catch {
      // Private mode or a full disk: the draft lives on for this visit.
    }
  }
}

function field(label, control, help) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, help ? h("span", { class: "help" }, help) : null);
}

export class ForgeApp {
  /** The one page object, set when the page loads. */
  static page = null;

  constructor(doc, options = {}) {
    this.doc = doc;
    this.options = options;
    this.project = Store.load() || Project.blank();
    this.undoStack = [];
    this.lastEdit = 0;
    this.report = null;
    this.lintRun = 0;
    this.lintTimer = null;
    this.tab = "checks";
    this.selectedFile = "";
    this.runtimeList = null;
  }

  init() {
    const $ = selector => this.doc.querySelector(selector);
    this.els = {
      templates: $("#templates"),
      site: $("#editor-site"),
      agents: $("#editor-agents"),
      peers: $("#editor-peers"),
      status: $("#forge-status"),
      panel: $("#panel-body"),
      tabs: [...this.doc.querySelectorAll("[data-tab]")],
      undo: $("#undo"),
    };
    this.els.templates.replaceChildren(...TEMPLATES.map(template => h("button", { type: "button", class: "template", onclick: () => this.loadTemplate(template.id) },
      h("strong", {}, template.title), h("span", {}, template.blurb))));
    for (const tab of this.els.tabs) {
      tab.addEventListener("click", () => this.showTab(tab.dataset.tab));
    }
    $("#export").addEventListener("click", () => this.exportZip());
    this.els.undo.addEventListener("click", () => this.undo());
    $("#import").addEventListener("change", event => this.importFile(event.target.files[0], event.target));
    this.renderEditor();
    this.showTab("checks");
    this.scheduleLint(0);
  }

  // ---- State ---------------------------------------------------------------------

  /** Run a change on the draft. Keeps an undo snapshot, saves, then re-checks. */
  snapshot() {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > MAX_UNDO) {
      this.undoStack.shift();
    }
  }

  change(mutate, { structural = true } = {}) {
    this.snapshot();
    this.lastEdit = 0;
    const result = mutate(this.project);
    this.afterChange(structural);
    return result;
  }

  afterChange(structural) {
    Store.save(this.project);
    if (!this.els) {
      return;
    }
    this.els.undo.disabled = this.undoStack.length === 0;
    if (structural) {
      this.renderEditor();
    }
    this.scheduleLint();
  }

  undo() {
    const previous = this.undoStack.pop();
    if (previous) {
      this.project = new Project(JSON.parse(previous));
      this.afterChange(true);
      this.say("Undone.");
    }
  }

  say(message, isError = false) {
    if (!this.els) {
      return;
    }
    this.els.status.textContent = message;
    this.els.status.dataset.error = isError ? "true" : "false";
  }

  // ---- Operations shared by the page and the agent --------------------------------

  /** Replace the draft with a template. The previous draft stays one Undo away. */
  loadTemplate(id) {
    const template = getTemplate(id);
    if (!template) {
      return { ok: false, reason: `No template "${id}". Use one of: ${TEMPLATES.map(t => t.id).join(", ")}.` };
    }
    this.change(() => {
      this.project = template.build();
    });
    this.say(`Loaded the "${template.title}" template. Undo brings your previous draft back.`);
    return { ok: true, template: template.id };
  }

  getTemplates() {
    return { ok: true, templates: TEMPLATES.map(({ id, title, blurb }) => ({ id, title, blurb })) };
  }

  getProject() {
    const project = this.project.toJSON();
    return {
      ok: true,
      project: { ...project, facts: clip(project.facts, 3000), factsLength: project.facts.length },
      instructionChars: this.project.budget(),
      hints: this.project.hints(),
    };
  }

  /** Change the site-level fields. Unknown keys are ignored. */
  updateSite(args) {
    if (args.networkName !== undefined && !isValidName(args.networkName)) {
      return { ok: false, reason: "networkName must be lower case letters, digits and underscores, starting with a letter." };
    }
    this.change(project => {
      for (const key of SITE_KEYS) {
        if (args[key] !== undefined) {
          project[key] = key === "sampleQueries" ? args[key].slice(0, 8) : String(args[key]);
        }
      }
      Object.assign(project, new Project(project.toJSON()));
    });
    return { ok: true };
  }

  /** Add or replace one agent by name. */
  upsertAgent(args) {
    if (!isValidName(args.name)) {
      return { ok: false, reason: "name must be lower case letters, digits and underscores, starting with a letter." };
    }
    if (!this.project.agent(args.name) && this.project.agents.length >= 12) {
      return { ok: false, reason: "A network holds at most 12 agents." };
    }
    this.change(project => {
      const existing = project.agent(args.name) || {};
      project.upsertAgent({ ...existing, ...args });
      if (args.front === true) {
        project.front = args.name;
      }
    });
    return { ok: true, agents: this.project.agents.map(agent => agent.name), front: this.project.front };
  }

  removeAgent(name) {
    if (!this.project.agent(name)) {
      return { ok: false, reason: `No agent named "${name}".` };
    }
    this.change(project => project.removeAgent(name));
    return { ok: true, agents: this.project.agents.map(agent => agent.name), front: this.project.front };
  }

  /** Replace the list of partner networks the front agent may call. */
  setPeers(peers) {
    const clean = [];
    for (const peer of peers) {
      let url;
      try {
        url = new URL(String(peer.url).trim());
      } catch {
        return { ok: false, reason: `"${peer.url}" is not a URL.` };
      }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !local) {
        return { ok: false, reason: `${url.href} must use https.` };
      }
      if (url.pathname.endsWith("/") || url.search || url.hash) {
        return { ok: false, reason: `${url.href} must end in the network name, with no trailing slash, query or #.` };
      }
      clean.push({ url: url.href, label: String(peer.label || url.host).slice(0, 60) });
    }
    this.change(project => {
      project.peers = clean;
    });
    return { ok: true, peers: clean };
  }

  /** Check a published site, for the visitor choosing a peer. */
  async checkSite(url) {
    const report = await validateSite(url, this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {});
    return { ok: true, ...compactReport(report) };
  }

  /** Run the linter on the draft now, and show the result. */
  async runChecks() {
    await this.lint();
    const report = this.report;
    return { ok: true, ...compactReport(report), hints: this.project.hints() };
  }

  // ---- Checking -------------------------------------------------------------------

  scheduleLint(delay = LINT_DELAY_MS) {
    if (!this.els) {
      return;
    }
    clearTimeout(this.lintTimer);
    this.lintTimer = setTimeout(() => this.lint(), delay);
  }

  async lint() {
    const run = (this.lintRun += 1);
    const files = this.project.files();
    const report = await validateSite(`${PREVIEW_BASE}/${this.project.networkName}`, {
      fetchImpl: createVirtualFetch(PREVIEW_BASE, files),
      checkPeers: false,
    });
    if (run === this.lintRun) {
      this.report = report;
      if (!this.els) {
        return;
      }
      if (this.tab === "checks") {
        this.renderChecks();
      }
      if (this.tab === "files") {
        this.renderFiles();
      }
      this.renderBadge();
    }
  }

  /** The draft's files as the preview chat should see them: a dry run unless the visitor saved a key. */
  previewFiles() {
    const files = new Map(this.project.files());
    const manifest = JSON.parse(files.get("agent-manifest.json"));
    manifest.llm_router = { base_url: "browser://mock", mock: true, byok_router: this.project.router };
    files.set("agent-manifest.json", JSON.stringify(manifest, null, 2));
    return files;
  }

  // ---- Rendering ------------------------------------------------------------------

  renderBadge() {
    const badge = this.doc.querySelector("#score-badge");
    if (!badge || !this.report) {
      return;
    }
    const verdict = verdictFor(this.report);
    badge.dataset.tone = verdict.tone;
    badge.textContent = this.report.conformant ? `Conformant · ${this.report.score}` : `Not conformant · ${this.report.score}`;
  }

  showTab(name) {
    this.tab = name;
    for (const tab of this.els.tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    }
    if (name === "checks") {
      this.renderChecks();
    } else if (name === "try") {
      this.renderPreview();
    } else {
      this.renderFiles();
    }
  }

  renderEditor() {
    const project = this.project;
    const text = (key, props = {}) => h("input", { type: "text", value: project[key], ...props, oninput: event => this.edit(() => { project[key] = event.target.value; }) });
    const area = (key, rows, props = {}) => h("textarea", { rows, value: project[key], ...props, oninput: event => this.edit(() => { project[key] = event.target.value; }) });
    this.els.site.replaceChildren(
      field("Site or assistant name", text("brand", { maxlength: 80 })),
      field("Network name", h("input", {
        type: "text", value: project.networkName, maxlength: 40, spellcheck: "false",
        oninput: event => {
          const value = event.target.value;
          event.target.setAttribute("aria-invalid", String(!isValidName(value)));
          if (isValidName(value)) {
            this.edit(() => { project.networkName = value; });
          }
        },
      }), "Lower case letters, digits and underscores. It ends your network's URL."),
      field("What this assistant does, in one sentence", text("description", { maxlength: 300 })),
      field("Sample questions, one per line", h("textarea", { rows: 3, value: project.sampleQueries.join("\n"), oninput: event => this.edit(() => {
        project.sampleQueries = event.target.value.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 8);
      }) }), "Other sites show these before they call you."),
      field("Site facts", h("textarea", { rows: 12, value: project.facts, oninput: event => this.edit(() => { project.facts = event.target.value; }) }), "Everything the agents may say as fact: prices, hours, policies. Agents answer only from this."),
      field("What this site cannot do", area("notSupported", 2), "For example: take payments, book tables."),
    );
    this.els.agents.replaceChildren(
      ...project.agents.map(agent => this.agentEditor(agent)),
      h("button", { type: "button", onclick: () => this.addAgent() }, "Add an agent"),
    );
    this.els.peers.replaceChildren(
      h("p", { class: "muted" }, "Partner sites your front agent may call, after the visitor agrees on a card. Check a peer first: only add sites that are conformant."),
      ...project.peers.map((peer, index) => this.peerEditor(peer, index)),
      h("button", { type: "button", onclick: () => this.change(p => { p.peers.push({ url: "https://", label: "" }); }) }, "Add a peer"),
    );
    this.els.undo.disabled = this.undoStack.length === 0;
  }

  /** Apply an edit that needs no re-render: save, then check again. */
  edit(mutate) {
    // Typing makes many edits. One undo step covers a burst of them.
    const now = Date.now();
    if (now - this.lastEdit > EDIT_BURST_MS) {
      this.snapshot();
    }
    this.lastEdit = now;
    mutate();
    this.afterChange(false);
  }

  addAgent() {
    let index = this.project.agents.length + 1;
    while (this.project.agent(`agent_${index}`)) {
      index += 1;
    }
    this.change(project => project.upsertAgent({ name: `agent_${index}`, description: "", instructions: "", useFacts: true, tools: [] }));
  }

  agentEditor(agent) {
    const project = this.project;
    const others = project.agents.filter(other => other.name !== agent.name);
    return h("details", { class: "agent", open: true },
      h("summary", {}, h("strong", {}, agent.name), project.front === agent.name ? h("span", { class: "tag" }, "front") : null, h("span", { class: "muted" }, ` ${agent.description}`)),
      field("Name", h("input", {
        type: "text", value: agent.name, maxlength: 40, spellcheck: "false",
        onchange: event => {
          const value = event.target.value;
          if (!isValidName(value) || project.agent(value)) {
            event.target.value = agent.name;
            this.say("An agent name must be unique, in lower case letters, digits and underscores.", true);
            return;
          }
          this.change(p => p.renameAgent(agent.name, value));
        },
      })),
      field("What it does (other agents read this to decide when to call it)", h("input", { type: "text", value: agent.description, maxlength: 300, oninput: event => this.edit(() => { agent.description = event.target.value; }) })),
      field("Its role and how it should answer", h("textarea", { rows: 5, value: agent.instructions, oninput: event => this.edit(() => { agent.instructions = event.target.value; }) }), "The grounding rules and the site facts are added for you."),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: agent.useFacts, onchange: event => this.edit(() => { agent.useFacts = event.target.checked; }) }), " Give this agent the site facts"),
      h("label", { class: "check" }, h("input", { type: "radio", name: "front", checked: project.front === agent.name, onchange: () => this.change(p => { p.front = agent.name; }) }), " This is the front agent: the one visitors and other sites talk to"),
      others.length ? h("fieldset", {}, h("legend", {}, "Can ask"), others.map(other => h("label", { class: "check" },
        h("input", { type: "checkbox", checked: agent.tools.includes(other.name), onchange: event => this.edit(() => {
          agent.tools = event.target.checked ? [...agent.tools, other.name] : agent.tools.filter(name => name !== other.name);
        }) }), ` ${other.name}`))) : null,
      project.agents.length > 1 ? h("button", { type: "button", class: "quiet", onclick: () => this.change(p => p.removeAgent(agent.name)) }, "Remove this agent") : null,
    );
  }

  peerEditor(peer, index) {
    const result = h("span", { class: "peer-result", role: "status" });
    return h("div", { class: "peer" },
      field("Network URL", h("input", { type: "url", value: peer.url, placeholder: "https://site.example/network_name", oninput: event => this.edit(() => { peer.url = event.target.value.trim(); }) })),
      field("Name shown on the consent card", h("input", { type: "text", value: peer.label, maxlength: 60, oninput: event => this.edit(() => { peer.label = event.target.value; }) })),
      h("div", { class: "row" },
        h("button", { type: "button", onclick: async () => {
          result.textContent = "Checking…";
          try {
            const report = await validateSite(peer.url);
            const verdict = verdictFor(report);
            result.textContent = `${verdict.label}: ${report.score}/100${report.conformant ? "" : `. Fails ${report.checks.filter(c => c.status === "fail").map(c => c.id).join(", ")}`}`;
            result.dataset.tone = verdict.tone;
          } catch {
            result.textContent = "Could not check this address.";
          }
        } }, "Check this peer"),
        h("button", { type: "button", class: "quiet", onclick: () => this.change(p => p.peers.splice(index, 1)) }, "Remove"),
        result));
  }

  renderChecks() {
    const report = this.report;
    const hints = this.project.hints();
    if (!report) {
      this.els.panel.replaceChildren(h("p", { class: "muted" }, "Checking…"));
      return;
    }
    const verdict = verdictFor(report);
    const open = report.checks.filter(check => check.status !== "pass");
    this.els.panel.replaceChildren(
      h("div", { class: "summary", "data-tone": verdict.tone },
        h("strong", {}, report.conformant ? "Conformant" : "Not conformant yet"),
        h("span", {}, ` ${report.score}/100, grade ${report.grade}. ${report.checks.filter(c => c.status === "pass").length} of ${report.checks.length} checks pass.`)),
      hints.length ? h("div", {}, h("h4", {}, "For you"), h("ul", { class: "issues" }, hints.map(hint => h("li", { "data-level": hint.level }, h("span", { class: "tag" }, hint.level), " ", hint.text)))) : null,
      open.length ? h("div", {}, h("h4", {}, "Specification checks"), h("ul", { class: "issues" }, open.map(check => h("li", { "data-level": check.status },
        h("span", { class: "tag" }, check.level.toUpperCase()), " ", check.title,
        check.detail ? h("div", { class: "muted" }, clip(check.detail, 300)) : null,
        check.fix ? h("div", {}, h("strong", {}, "Fix: "), check.fix) : null)))) : h("p", {}, "Every specification check passes."),
      h("p", { class: "muted small" }, "These are the same checks Agent Forge runs on any published site. They read the files your draft would publish, in your browser."),
    );
  }

  renderPreview() {
    const frame = h("iframe", { class: "preview", title: "Preview of your agent network", src: new URL("studio/preview.html", import.meta.url).href });
    this.els.panel.replaceChildren(
      h("p", { class: "muted" }, "This chat runs your draft in the browser, the way a visitor's browser would run the published site. Without an AI key saved in the settings below it is a dry run: it shows which agents your network calls, with canned replies. With a key saved, replies are real."),
      h("button", { type: "button", onclick: () => this.renderPreview() }, "Restart with my latest changes"),
      frame);
  }

  renderFiles() {
    const files = this.project.files();
    if (!files.has(this.selectedFile)) {
      this.selectedFile = [...files.keys()][1] || [...files.keys()][0];
    }
    const select = h("select", { "aria-label": "File", onchange: event => { this.selectedFile = event.target.value; this.renderFiles(); } },
      [...files.keys()].map(path => h("option", { value: path, selected: path === this.selectedFile }, path)));
    this.els.panel.replaceChildren(
      h("p", { class: "muted" }, "The public files your site publishes. Download the folder to get them with a page and the runtime."),
      select,
      h("pre", { class: "file" }, files.get(this.selectedFile)));
  }

  // ---- Export and import ----------------------------------------------------------

  async exportZip() {
    const problems = this.project.hints().filter(hint => hint.level === "error");
    if (problems.length) {
      this.say(`Fix this first: ${problems[0].text}`, true);
      return;
    }
    this.say("Building your folder…");
    try {
      const base = new URL("./", import.meta.url);
      const fetchImpl = this.options.fetchImpl || fetch;
      this.runtimeList ||= await (await fetchImpl(new URL("runtime-files.json", base))).json();
      const runtime = {
        paths: this.runtimeList,
        read: async path => {
          const response = await fetchImpl(new URL(`runtime/${path}`, base));
          if (!response.ok) {
            throw new Error(`${path}: ${response.status}`);
          }
          return response.text();
        },
      };
      const zip = await buildZip(this.project, runtime);
      const link = h("a", { href: URL.createObjectURL(new Blob([zip], { type: "application/zip" })), download: `${this.project.networkName}-site.zip` });
      this.doc.body.append(link);
      link.click();
      link.remove();
      this.say(`Downloaded ${this.project.networkName}-site.zip. Open README.md inside for the two-minute publish steps.`);
    } catch (error) {
      this.say(`The download failed: ${error.message}`, true);
    }
  }

  async importFile(file, input) {
    if (!file) {
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      this.change(() => {
        this.project = new Project(data);
      });
      this.say(`Imported ${file.name}.`);
    } catch {
      this.say("That file is not a forge-project.json.", true);
    }
    input.value = "";
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  ForgeApp.page = new ForgeApp(document);
  window.ForgeApp = ForgeApp;
  ForgeApp.page.init();
}

export { slug };
