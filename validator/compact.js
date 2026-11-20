// Shrinks a validation report to what a model or another site needs.
// Text that came from the checked site is clipped, because it is untrusted.
import { verdictFor } from "./validator.js";

const MAX_TEXT = 300;

/** Shorten text from another site before it reaches a model or a screen. */
export function clip(text, limit = MAX_TEXT) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * :param report: A report from validateSite().
 * :return: Plain data with the verdict, failed checks, warnings and what the network reaches.
 */
export function compactReport(report) {
  const verdict = verdictFor(report);
  const pick = status => report.checks.filter(check => check.status === status)
    .map(check => ({ id: check.id, level: check.level, title: check.title, detail: clip(check.detail), fix: check.fix }));
  const summary = report.summary;
  return {
    url: report.url,
    score: report.score,
    grade: report.grade,
    conformant: report.conformant,
    verdict: verdict.label,
    categories: report.categories,
    failed: pick("fail"),
    warnings: pick("warn"),
    passedCount: report.checks.filter(check => check.status === "pass").length,
    site: summary && {
      brand: clip(summary.brand, 80),
      network: summary.network,
      frontAgent: summary.frontMan,
      description: clip(summary.description),
      agents: summary.agents.map(agent => ({ name: agent.name, description: clip(agent.description, 160), calls: agent.calls })),
      peerNetworks: summary.peers,
      mcpServers: summary.mcps,
      websiteTools: summary.websiteTools,
    },
    peers: report.peers,
  };
}
