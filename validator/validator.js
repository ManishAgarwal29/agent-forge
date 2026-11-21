// Agent Forge linter and conformance validator.
//
// Checks one published agent network against the Minimum Viable Specification for a
// Worldwide Agentic Web (MVP Profile 0.3) and scores how far a caller can trust it.
// It reads only public files, the way a calling browser does, and runs unchanged in a
// browser page and in Node 22+. It reuses the runtime's own parser and validator
// (../runtime), so "valid" here means "the runtime will run it".
//
// Usage:
//   import { validateSite } from "./atlas-validator.js";
//   const report = await validateSite("https://partner.example/partner_network");
import { parseHocon } from "../runtime/hocon.js";
import { AgentNetwork, isExternalAgent, isMcpTool, validateNetwork } from "../runtime/kernel.js";

/** Requirement levels, as in RFC 2119. A failed MUST makes a site non-conformant. */
export const LEVELS = Object.freeze({ MUST: "must", SHOULD: "should", MAY: "may" });

/** Weight of each requirement level in the trust score. */
const WEIGHTS = Object.freeze({ must: 10, should: 4, may: 1 });

/** The score a non-conformant site can never exceed. */
export const NON_CONFORMANT_CAP = 49;

/** Hosts where http is allowed, for local development. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Origin sent when the caller names none: it stands for "any other site". */
const ANY_SITE = "https://caller.example";

/** Patterns that look like credentials. Published instructions are public by design. */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an OpenAI-style key (sk-...)"],
  [/\botk_[A-Za-z0-9_]{10,}/, "an Otari key (otk_...)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, "a bearer token"],
  [/\b(?:api[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i, "a credential assignment"],
];

/** Phrases that try to override the caller's agent or hide actions from the visitor. */
const INJECTION_PATTERNS = [
  [/ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|messages)/i, "tells the model to ignore earlier instructions"],
  [/(?:do\s+not|don'?t|never)\s+(?:tell|inform|show|reveal\s+to)\s+the\s+(?:user|visitor|customer)/i, "tells the model to hide something from the visitor"],
  [/(?:send|post|forward|upload|exfiltrate)\b[^.\n]{0,80}\bhttps?:\/\//i, "tells the model to send data to a URL"],
  [/(?:reveal|print|output|repeat)\b[^.\n]{0,40}\b(?:system\s+prompt|api\s*key|credentials|chat\s+history)/i, "tells the model to reveal private context"],
  [/(?:disable|bypass|skip)\b[^.\n]{0,40}\b(?:confirmation|consent|approval)/i, "tells the model to skip confirmation"],
];

const LEFTOVER_PLACEHOLDER = /\bTODO\b|<[a-z]+(?:_[a-z]+)+>/;

/** Letter grade for a score. */
export function gradeFor(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

/**
 * Score a list of checks: each category and the whole list, 0 to 100. A failed MUST makes
 * the list non-conformant and caps the score at NON_CONFORMANT_CAP.
 *
 * :param checks: [{category, level, status}]
 * :return: {score, grade, conformant, categories}
 */
export function scoreChecks(checks) {
  const tally = () => ({ earned: 0, total: 0 });
  const all = tally();
  const byCategory = {};
  for (const check of checks) {
    const weight = WEIGHTS[check.level];
    const bucket = byCategory[check.category] || (byCategory[check.category] = tally());
    bucket.total += weight;
    all.total += weight;
    if (check.status === "pass") {
      bucket.earned += weight;
      all.earned += weight;
    }
  }
  const percent = bucket => (bucket.total ? Math.round((100 * bucket.earned) / bucket.total) : 100);
  const categories = {};
  for (const [name, bucket] of Object.entries(byCategory)) {
    categories[name] = percent(bucket);
  }
  const conformant = !checks.some(check => check.status === "fail");
  let overall = percent(all);
  if (!conformant) {
    overall = Math.min(overall, NON_CONFORMANT_CAP);
  }
  return { score: overall, grade: gradeFor(overall), conformant, categories };
}

/**
 * Collects checks and turns them into a report.
 *
 * Each check has a requirement level. A passed check earns its weight. A failed MUST is a
 * "fail" and makes the site non-conformant. A failed SHOULD is a "warn", and a failed MAY
 * is an "info".
 */
class Report {
  constructor() {
    this.checks = [];
  }

  /**
   * Record one check.
   *
   * :param id: Stable identifier, such as "manifest.cors".
   * :param category: conformance, interop, safety or transparency.
   * :param level: One of LEVELS.
   * :param passed: Whether the site satisfies it.
   * :param title: What was checked, as a statement that is true when it passes.
   * :param detail: What was found. Shown when the check does not pass, or as evidence.
   * :param fix: How to fix it. Shown when the check does not pass.
   */
  add(id, category, level, passed, title, detail = "", fix = "") {
    let status = "pass";
    if (!passed) {
      status = level === LEVELS.MUST ? "fail" : level === LEVELS.SHOULD ? "warn" : "info";
    }
    this.checks.push({ id, category, level, status, title, detail, fix });
    return passed;
  }

  get failed() {
    return this.checks.filter(check => check.status === "fail");
  }

  /** Score each category and the whole report, 0 to 100. */
  score() {
    return scoreChecks(this.checks);
  }
}

/** Normalise a thrown fetch error into a sentence a person can act on. */
function describeFetchError(error, browser) {
  const message = error && error.name === "AbortError" ? "timed out" : String((error && error.message) || error);
  if (browser && /failed to fetch|networkerror|load failed/i.test(message)) {
    return "the browser could not read it. The server is down, the address is wrong, or it sends no CORS header for this site";
  }
  return message;
}

/** Run-wide state shared by every request of one validation. */
class Context {
  constructor(options) {
    this.fetch = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.browser = typeof window !== "undefined" && typeof window.document !== "undefined";
    this.origin = options.origin || null;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.checkPeers = options.checkPeers ?? true;
    this.maxPeerDepth = options.maxPeerDepth ?? 1;
    this.depth = options.depth ?? 0;
    this.selfOrigin = this.browser ? window.location.origin : this.origin;
    this.requests = 0;
  }

  /**
   * Fetch one public file.
   *
   * :return: {ok, status, text, headers, url} or {ok: false, error}.
   */
  async get(url) {
    this.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init = { signal: controller.signal, redirect: "follow", cache: "no-store" };
      // Browsers forbid setting Origin. A server-side check sends it, so CORS can be read.
      if (!this.browser) {
        init.headers = { Origin: this.origin || ANY_SITE };
      }
      const response = await this.fetch(url, init);
      const text = await response.text();
      return { ok: true, status: response.status, text, headers: response.headers, url: response.url || url };
    } catch (error) {
      return { ok: false, error: describeFetchError(error, this.browser) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Say why a browser on the caller's origin could not read a fetched file, if it could not.
   * In a browser a successful fetch already proves CORS allowed this page. In Node the
   * Access-Control-Allow-Origin header is read directly.
   *
   * :return: A problem sentence, or null.
   */
  corsProblem(file) {
    if (this.browser) {
      return null;
    }
    const caller = this.origin || ANY_SITE;
    if (new URL(file.url).origin === caller) {
      return null;
    }
    const allowed = file.headers.get("access-control-allow-origin");
    if (allowed === null) {
      return "sends no Access-Control-Allow-Origin header, so a browser on another site cannot read it";
    }
    const value = allowed.trim();
    if (value === "*" || value === caller) {
      return null;
    }
    return `sends Access-Control-Allow-Origin "${value}", which leaves out ${caller}`;
  }
}

/** Parse a JSON object, or return null. */
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Split a network URL into the folder that holds the manifest and the network name. */
export function parseNetworkUrl(ref) {
  let url = null;
  try {
    url = new URL(ref);
  } catch {
    return { error: `"${ref}" is not a full URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `"${ref}" is not an http or https URL.` };
  }
  if (url.pathname.endsWith("/") || ref.includes("?") || ref.includes("#")) {
    return { error: `"${ref}" must end in the network name, with no trailing "/", query or "#".` };
  }
  const segments = url.pathname.split("/");
  return {
    url: url.href,
    origin: url.origin,
    host: url.hostname.includes(":") ? `[${url.hostname.replace(/^\[|\]$/g, "")}]` : url.hostname,
    protocol: url.protocol,
    name: segments[segments.length - 1],
    folder: new URL("./", url).href.replace(/\/$/, ""),
  };
}

/** Collect the agents, the peers and the MCP servers a network can reach. */
function describeNetwork(network) {
  const agents = [];
  const peers = [];
  const mcps = [];
  for (const spec of network.config.tools || []) {
    const calls = [];
    for (const ref of spec.tools || []) {
      if (isMcpTool(ref)) {
        const url = typeof ref === "string" ? ref : ref.url;
        mcps.push(url);
        calls.push(url);
      } else if (typeof ref === "string" && /^https?:\/\//i.test(ref)) {
        peers.push(ref);
        calls.push(ref);
      } else if (typeof ref === "string") {
        calls.push(ref);
      }
    }
    agents.push({
      name: spec.name,
      description: spec.function?.description || "",
      calls,
      usesLlm: typeof spec.instructions === "string" && spec.instructions.length > 0,
    });
  }
  return { agents, peers: [...new Set(peers)], mcps: [...new Set(mcps)] };
}

/** Return every string the network publishes that an agent or visitor reads. */
function publishedText(network) {
  const parts = [];
  for (const spec of network.config.tools || []) {
    parts.push({ agent: spec.name, text: String(spec.instructions || "") });
    parts.push({ agent: spec.name, text: String(spec.function?.description || "") });
  }
  return parts;
}

/** Check that the URL is well formed and uses HTTPS. */
function checkUrl(report, target) {
  report.add("url.form", "conformance", LEVELS.MUST, !target.error, "The network URL is the site folder plus the network name",
    target.error || "", "Use the folder that holds agent-manifest.json, then the network name, such as https://site.example/my_network.");
  if (target.error) {
    return false;
  }
  const secure = target.protocol === "https:" || LOOPBACK_HOSTS.includes(target.host);
  report.add("url.https", "safety", LEVELS.MUST, secure, "The site is served over HTTPS",
    secure ? "" : `${target.url} uses plain http.`, "Serve the site over HTTPS. Only localhost may use http.");
  return true;
}

/** Fetch and check the manifest. Returns {manifest, entry} or null. */
async function checkManifest(report, ctx, target) {
  const manifestUrl = `${target.folder}/agent-manifest.json`;
  const file = await ctx.get(manifestUrl);
  const reachable = file.ok && file.status === 200;
  report.add("manifest.fetch", "conformance", LEVELS.MUST, reachable, "agent-manifest.json is publicly reachable",
    file.ok ? `${manifestUrl} answered ${file.status}.` : `${manifestUrl}: ${file.error}.`,
    "Publish agent-manifest.json in the folder before the network name, and keep it public.");
  if (!reachable) {
    return null;
  }
  const problem = ctx.corsProblem(file);
  const sameOrigin = ctx.browser && new URL(manifestUrl).origin === ctx.selfOrigin;
  report.add("manifest.cors", "interop", LEVELS.MUST, problem === null, "Other sites can read the manifest (CORS)",
    problem ? `The manifest ${problem}.` : sameOrigin ? "Same origin as Atlas, so CORS was not exercised." : "Readable from another origin.",
    "Send Access-Control-Allow-Origin: * on the manifest, the network file, links.json and the bridge.");
  const manifest = parseObject(file.text);
  report.add("manifest.json", "conformance", LEVELS.MUST, manifest !== null, "The manifest is a JSON object",
    manifest ? "" : "The file is not valid JSON, or not a JSON object.", "Fix the JSON syntax.");
  if (!manifest) {
    return null;
  }
  const networks = Array.isArray(manifest.networks) ? manifest.networks : [];
  const entry = networks.find(item => item && typeof item === "object" && item.name === target.name) || null;
  const listed = networks.map(item => item && item.name).filter(Boolean);
  report.add("manifest.network", "conformance", LEVELS.MUST, entry !== null, `The manifest lists the network "${target.name}"`,
    entry ? "" : `It lists: ${listed.length ? listed.join(", ") : "no networks"}. A caller never runs another name.`,
    "Make the last part of the URL equal a networks[].name in the manifest.");
  if (!entry) {
    return { manifest, entry: null };
  }
  const hasFiles = typeof entry.hocon === "string" && entry.hocon.length > 0 && typeof entry.front_man === "string" && entry.front_man.length > 0;
  report.add("manifest.entry", "conformance", LEVELS.MUST, hasFiles, "The network entry names its file (hocon) and front agent (front_man)",
    hasFiles ? "" : "The entry lacks hocon or front_man.", 'Add "hocon": "./name.network.json" and "front_man": "<agent name>".');
  report.add("manifest.description", "transparency", LEVELS.SHOULD, typeof entry.description === "string" && entry.description.length > 0,
    "The network has a one-sentence description", "", 'Add a "description" to the network entry.');
  report.add("manifest.samples", "transparency", LEVELS.SHOULD, Array.isArray(entry.sample_queries) && entry.sample_queries.length > 0,
    "The network lists sample queries", "", 'Add "sample_queries" so callers know what to ask.');
  return { manifest, entry: hasFiles ? entry : null };
}

/** Fetch, parse and check the network file. Returns the AgentNetwork or null. */
async function checkNetworkFile(report, ctx, target, entry) {
  const url = new URL(entry.hocon, `${target.folder}/`).href;
  const file = await ctx.get(url);
  const reachable = file.ok && file.status === 200;
  report.add("network.fetch", "conformance", LEVELS.MUST, reachable, "The network file is publicly reachable",
    file.ok ? `${url} answered ${file.status}.` : `${url}: ${file.error}.`, "Publish the file named in hocon and keep it public.");
  if (!reachable) {
    return null;
  }
  const problem = ctx.corsProblem(file);
  report.add("network.cors", "interop", LEVELS.MUST, problem === null, "Other sites can read the network file (CORS)",
    problem ? `The network file ${problem}.` : "", "Send Access-Control-Allow-Origin: * on the network file.");
  let config = null;
  let parseError = "";
  try {
    config = parseHocon(file.text);
  } catch (error) {
    parseError = error.message;
  }
  report.add("network.parse", "conformance", LEVELS.MUST, config !== null, "The network file parses as data-only HOCON/JSON",
    parseError, "Publish a fully resolved file: no includes, substitutions or environment variables.");
  if (config === null) {
    return null;
  }
  const network = new AgentNetwork(config, entry.name);
  const { errors } = validateNetwork(network);
  report.add("network.validate", "conformance", LEVELS.MUST, errors.length === 0, "The runtime accepts the agent graph",
    errors.join(" "), "Fix duplicate or missing agent references and make sure one front agent exists.");
  const front = network.getAgentSpec(entry.front_man);
  report.add("network.front", "conformance", LEVELS.MUST, front !== null, "The front agent in the manifest exists in the network",
    front ? "" : `The manifest names "${entry.front_man}", which the network does not define.`, "Make front_man match an agent name.");
  return network;
}

/** Check the quality, safety and portability of the agent definitions. */
function checkAgents(report, network, manifest) {
  const specs = network.config.tools || [];
  report.add("network.metadata", "transparency", LEVELS.SHOULD, Boolean(network.metadata().description),
    "The network describes itself (metadata.description)", "", 'Add "metadata": {"description": "..."}.');
  const undescribed = specs.filter(spec => !spec.function?.description).map(spec => spec.name);
  report.add("agents.described", "conformance", LEVELS.SHOULD, undescribed.length === 0, "Every agent has a function description",
    undescribed.length ? `Missing on: ${undescribed.join(", ")}.` : "", "Add function.description so callers can decide when to use the agent.");
  const unschematised = specs.filter(spec => !spec.function?.parameters || typeof spec.function.parameters !== "object").map(spec => spec.name);
  report.add("agents.schemas", "conformance", LEVELS.SHOULD, unschematised.length === 0, "Every agent declares an input schema (JSON Schema)",
    unschematised.length ? `Missing on: ${unschematised.join(", ")}.` : "", "Add function.parameters with type, properties and required.");
  const uninstructed = specs.filter(spec => !spec.instructions).map(spec => spec.name);
  report.add("agents.instructions", "conformance", LEVELS.SHOULD, uninstructed.length === 0, "Every agent has instructions",
    uninstructed.length ? `Missing on: ${uninstructed.join(", ")}.` : "", "Add instructions to each agent that uses an LLM.");
  const leftovers = publishedText(network).filter(part => LEFTOVER_PLACEHOLDER.test(part.text)).map(part => part.agent);
  report.add("network.placeholders", "conformance", LEVELS.SHOULD, leftovers.length === 0, "No template placeholders are left (TODO, <name>)",
    leftovers.length ? `Found in: ${[...new Set(leftovers)].join(", ")}.` : "", "Replace every TODO and <placeholder>.");

  // Safety: public text and credentials.
  const haystacks = [...publishedText(network).map(part => ({ where: `agent "${part.agent}"`, text: part.text })), { where: "the manifest", text: JSON.stringify(manifest) }];
  const secrets = [];
  for (const { where, text } of haystacks) {
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        secrets.push(`${where} contains ${label}`);
      }
    }
  }
  report.add("safety.secrets", "safety", LEVELS.MUST, secrets.length === 0, "No credentials are published in the instructions or manifest",
    secrets.join("; "), "Remove the credential and rotate it. Published instructions are public by design.");
  const injections = [];
  for (const part of publishedText(network)) {
    for (const [pattern, label] of INJECTION_PATTERNS) {
      if (pattern.test(part.text)) {
        injections.push(`agent "${part.agent}" ${label}`);
      }
    }
  }
  report.add("safety.instructions", "safety", LEVELS.SHOULD, injections.length === 0, "Instructions do not try to override callers or hide actions",
    injections.join("; "), "Remove instructions that hide behaviour from the visitor or try to override the caller's agent.");
  const wildcard = specs.filter(spec => [spec.allow?.to_downstream?.sly_data, spec.allow?.to_upstream?.sly_data].some(list => Array.isArray(list) && list.includes("*"))).map(spec => spec.name);
  report.add("safety.private-context", "safety", LEVELS.SHOULD, wildcard.length === 0, "Private context (sly_data) is not shared with a wildcard",
    wildcard.length ? `Wildcard allow rule on: ${wildcard.join(", ")}.` : "", 'List the exact sly_data fields allowed to cross a boundary instead of "*".');
  const bounded = Boolean(network.config.max_steps || network.config.max_iterations || network.config.max_execution_seconds
    || specs.some(spec => spec.max_steps || spec.max_iterations || spec.max_execution_seconds));
  report.add("safety.limits", "safety", LEVELS.SHOULD, bounded, "The network declares execution limits (steps or time)",
    "", 'Set "max_steps" or "max_execution_seconds" so a caller cannot be made to pay for runaway loops.');
}

/** Check the peers and MCP servers a network reaches, against its own policy. */
function checkReach(report, target, manifest, reach) {
  const policyMode = manifest.peer_policy?.mode || "closed";
  const allowed = Array.isArray(manifest.allowed_peers) ? manifest.allowed_peers : [];
  const denied = Array.isArray(manifest.peer_policy?.deny_origins) ? manifest.peer_policy.deny_origins : [];
  const external = [...reach.peers, ...reach.mcps];
  const insecure = external.filter(url => {
    const parsed = parseNetworkUrl(url.replace(/\/$/, "") || url);
    return !parsed.error && parsed.protocol === "http:" && !LOOPBACK_HOSTS.includes(parsed.host);
  });
  report.add("safety.peers.https", "safety", LEVELS.MUST, insecure.length === 0, "Every peer and MCP server uses HTTPS",
    insecure.join(", "), "Use https URLs for peers and MCP servers.");
  const refused = [];
  for (const url of reach.peers) {
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      refused.push(url);
      continue;
    }
    const listed = allowed.includes(origin) || target.origin === origin;
    if (denied.includes(origin) || (policyMode !== "open" && !listed)) {
      refused.push(url);
    }
  }
  report.add("safety.peers.declared", "safety", LEVELS.MUST, refused.length === 0, "Every peer network is allowed by the site's own peer policy",
    refused.length ? `The runtime refuses: ${refused.join(", ")}.` : "", "Add each peer origin to allowed_peers, or remove the peer.");
  if (reach.peers.length > 0) {
    report.add("safety.peers.closed", "safety", LEVELS.SHOULD, policyMode !== "open", "Peers are limited to a named list (closed peer policy)",
      policyMode === "open" ? "peer_policy.mode is open, so any site can be called." : "", 'Set peer_policy.mode to "closed" and list peers in allowed_peers.');
  }
}

/** Check the optional parts of the manifest: key control, actions and the bridge. */
async function checkInterop(report, ctx, target, manifest) {
  const router = manifest.llm_router || null;
  const byok = manifest.deployment?.direct_byok === true || Boolean(router?.byok_router);
  report.add("interop.byok", "interop", LEVELS.SHOULD, byok, "Visitors can bring their own LLM key (BYOK)",
    "", 'Set deployment.direct_byok to true and offer llm_router.byok_router so the host does not pay for inference.');
  const links = await ctx.get(`${target.folder}/links.json`);
  const linksOk = links.ok && (links.status === 200 || links.status === 404);
  report.add("interop.links", "interop", LEVELS.MAY, linksOk && links.status === 200 && parseObject(links.text) !== null,
    "links.json is published", links.ok && links.status === 404 ? "No links.json. The runtime ignores a missing file." : "", "Publish links.json for named peer links.");
  const actions = manifest.actions;
  if (actions === null || typeof actions !== "object") {
    return;
  }
  report.add("actions.version", "conformance", LEVELS.MUST, actions.version === 1, "actions.version is 1",
    `Found ${JSON.stringify(actions.version)}.`, "Set actions.version to 1. Other runtimes refuse the site otherwise.");
  const hasBridge = typeof actions.bridge === "string" && actions.bridge.length > 0;
  report.add("actions.bridge", "interop", LEVELS.MUST, hasBridge, "Site actions come with an action bridge",
    hasBridge ? "" : "Without a bridge a caller waits 10 seconds, then asks its visitor to open a popup.", 'Set actions.bridge to "./bridge/action-bridge.html".');
  if (!hasBridge) {
    return;
  }
  const bridgeUrl = new URL(actions.bridge, `${target.folder}/`).href;
  const sameOrigin = new URL(bridgeUrl).origin === target.origin;
  report.add("actions.origin", "safety", LEVELS.MUST, sameOrigin, "The bridge is on the site's own origin",
    sameOrigin ? "" : `${bridgeUrl} is on another origin, so callers refuse it.`, "Host the bridge on the same origin as the manifest.");
  if (!sameOrigin) {
    return;
  }
  const bridge = await ctx.get(bridgeUrl);
  const bridgeOk = bridge.ok && bridge.status === 200;
  report.add("actions.reachable", "interop", LEVELS.MUST, bridgeOk, "The bridge page is reachable",
    bridge.ok ? `${bridgeUrl} answered ${bridge.status}.` : `${bridgeUrl}: ${bridge.error}.`, "Publish bridge/action-bridge.html.");
  if (!bridgeOk) {
    return;
  }
  const frameOptions = ctx.browser ? null : bridge.headers.get("x-frame-options");
  report.add("actions.framing", "interop", LEVELS.MUST, frameOptions === null, "The bridge can be loaded in a frame by other sites",
    frameOptions ? `The bridge sends X-Frame-Options "${frameOptions}".` : "", "Remove X-Frame-Options from the bridge folder.");
}

/** Describe the site's non-blocking disclosures. */
function checkTransparency(report, manifest) {
  const mcp = manifest.agent_mcp;
  if (mcp && typeof mcp === "object") {
    report.add("transparency.mcp", "transparency", LEVELS.MAY, mcp.available === true || Boolean(mcp.reason),
      "The manifest says whether an MCP facade exists, and why not", "", "Set agent_mcp.available and a reason.");
  }
  report.add("transparency.brand", "transparency", LEVELS.MAY, Boolean(manifest.brand), "The site names its assistant (brand)", "", 'Add a "brand".');
}

/**
 * Validate one published agent network.
 *
 * :param networkUrl: The folder that holds agent-manifest.json, then the network name.
 * :param options: {fetchImpl, origin, timeoutMs, checkPeers, maxPeerDepth}. origin is the
 *   caller's origin, which only a server-side check needs, for the CORS comparison.
 * :return: A report with score, grade, conformant, categories, checks, summary and peers.
 */
export async function validateSite(networkUrl, options = {}) {
  const ctx = new Context(options);
  const report = new Report();
  const target = parseNetworkUrl(String(networkUrl).trim());
  const result = {
    url: target.url || String(networkUrl),
    checkedAt: new Date().toISOString(),
    summary: null,
    peers: [],
  };
  const finish = () => Object.assign(result, report.score(), { checks: report.checks, requests: ctx.requests });

  if (!checkUrl(report, target)) {
    return finish();
  }
  const found = await checkManifest(report, ctx, target);
  if (!found || !found.entry) {
    return finish();
  }
  const { manifest, entry } = found;
  const network = await checkNetworkFile(report, ctx, target, entry);
  await checkInterop(report, ctx, target, manifest);
  checkTransparency(report, manifest);
  if (network) {
    checkAgents(report, network, manifest);
    const reach = describeNetwork(network);
    checkReach(report, target, manifest, reach);
    result.summary = {
      brand: manifest.brand || "",
      network: entry.name,
      frontMan: entry.front_man,
      description: entry.description || network.metadata().description || "",
      agents: reach.agents,
      peers: reach.peers,
      mcps: reach.mcps,
      sampleQueries: entry.sample_queries || [],
      websiteTools: manifest.actions?.agentTools || [],
      router: manifest.llm_router?.base_url || "",
    };
    if (ctx.checkPeers && ctx.depth < ctx.maxPeerDepth && reach.peers.length) {
      result.peers = await Promise.all(reach.peers.slice(0, 8).map(async peerUrl => {
        const peer = await validateSite(peerUrl, { ...options, depth: ctx.depth + 1 });
        return { url: peerUrl, score: peer.score, grade: peer.grade, conformant: peer.conformant, failed: peer.checks.filter(c => c.status === "fail").map(c => c.id) };
      }));
      const broken = result.peers.filter(peer => !peer.conformant);
      report.add("interop.peers.healthy", "interop", LEVELS.SHOULD, broken.length === 0, "Every peer network this site calls is itself conformant",
        broken.length ? `Not conformant: ${broken.map(peer => peer.url).join(", ")}.` : "", "Replace or fix the peers that fail.");
      Object.assign(result, report.score(), { checks: report.checks });
    }
  }
  return finish();
}

/**
 * Turn a report into the plain verdict a caller acts on.
 *
 * :return: {label, tone, callable}. tone is "good", "careful" or "bad".
 */
export function verdictFor(report) {
  if (!report.conformant) {
    return { label: "Do not call", tone: "bad", callable: false };
  }
  if (report.score >= 75) {
    return { label: "Safe to call", tone: "good", callable: true };
  }
  if (report.score >= 60) {
    return { label: "Usable with care", tone: "careful", callable: true };
  }
  return { label: "Do not call", tone: "bad", callable: false };
}

/**
 * Find the networks a site publishes, from a site address instead of a network URL.
 *
 * :param address: A site or folder URL, such as https://site.example/ or https://site.example/agents.
 * :return: The network URLs listed in that folder's agent-manifest.json, or [] when it has none.
 */
export async function discoverNetworks(address, options = {}) {
  const ctx = new Context(options);
  let folder = "";
  try {
    const url = new URL(String(address).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return [];
    }
    folder = new URL("./", url.pathname.endsWith("/") ? url : `${url.href}/`).href.replace(/\/$/, "");
  } catch {
    return [];
  }
  const file = await ctx.get(`${folder}/agent-manifest.json`);
  const manifest = file.ok && file.status === 200 ? parseObject(file.text) : null;
  const networks = Array.isArray(manifest?.networks) ? manifest.networks : [];
  return networks.filter(item => item && typeof item.name === "string").map(item => `${folder}/${item.name}`);
}
