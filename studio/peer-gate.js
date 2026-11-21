// Forge's trust rule for peers, in one place.
//
// A draft may list a peer only if the peer is conformant and scores PEER_MIN_SCORE or more.
// The rule is code, not a prompt: the draft checks, the agent's set_peers action and the
// Download button all call this module, whoever added the peer. A peer that cannot be read
// fails, so the rule fails closed.
import { scoreChecks, validateSite } from "../validator/validator.js";

export const PEER_MIN_SCORE = 60;

/** How long a peer's result is reused before it is checked again. */
const CACHE_MS = 60 * 1000;

export const PEER_CHECK_ID = "forge.peers.trusted";

/** Whether one peer's result passes the rule. */
export function peerPasses(result) {
  return Boolean(result && result.conformant && result.score >= PEER_MIN_SCORE);
}

/** One line on why a peer failed. */
export function describePeer(result) {
  if (result.conformant) {
    return `${result.url} scored ${result.score}`;
  }
  return `${result.url} scored ${result.score}, not conformant (fails ${result.failed.join(", ") || "a check"})`;
}

/**
 * Checks peers and remembers the results for a minute, so typing in the editor does not
 * fetch the same peer on every keystroke.
 */
export class PeerChecker {
  /**
   * :param options: {fetchImpl} for tests. Real fetch otherwise.
   */
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || null;
    this.cache = new Map();
  }

  /**
   * :param url: A peer's network URL.
   * :param fresh: Ignore the cached result.
   * :return: {url, score, grade, conformant, failed}
   */
  check(url, { fresh = false } = {}) {
    const now = Date.now();
    const cached = this.cache.get(url);
    if (!fresh && cached && now - cached.at < CACHE_MS) {
      return cached.promise;
    }
    const options = { checkPeers: false };
    if (this.fetchImpl) {
      options.fetchImpl = this.fetchImpl;
    }
    const promise = validateSite(url, options).then(report => ({
      url,
      score: report.score,
      grade: report.grade,
      conformant: report.conformant,
      failed: report.checks.filter(check => check.status === "fail").map(check => check.id),
    }));
    this.cache.set(url, { at: now, promise });
    return promise;
  }

  /** Check every peer. */
  checkAll(peers, options) {
    return Promise.all(peers.map(peer => this.check(peer.url, options)));
  }
}

/**
 * Add Forge's peer rule to a draft's report as a MUST check, and score the report again.
 * A draft with no peers is unchanged.
 *
 * :param report: A report from validateSite() on the draft.
 * :param results: Results from PeerChecker for every peer in the draft.
 * :return: A new report.
 */
export function applyPeerGate(report, results) {
  if (!results.length) {
    return report;
  }
  const failing = results.filter(result => !peerPasses(result));
  const check = {
    id: PEER_CHECK_ID,
    category: "safety",
    level: "must",
    status: failing.length ? "fail" : "pass",
    title: `Every peer is conformant and scores ${PEER_MIN_SCORE} or more`,
    detail: failing.map(describePeer).join("; "),
    fix: "Remove the failing peer, or ask its owner to fix the checks it fails. Use \"Check this peer\" to see its report.",
  };
  const checks = [...report.checks.filter(existing => existing.id !== PEER_CHECK_ID), check];
  return { ...report, ...scoreChecks(checks), checks };
}
