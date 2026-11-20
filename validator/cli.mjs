#!/usr/bin/env node
// Command-line front end for the Agent Atlas validator.
//
//   node validator/cli.mjs <network URL> [--origin <your origin>] [--json] [--min-score <n>]
//
// Exit code: 0 when the site is conformant and meets --min-score, 1 when it does not,
// 2 on a bad argument. Use it in CI: see action.yml.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { validateSite } from "./validator.js";

const USAGE = "Usage: node cli.mjs <network URL> [--origin <origin>] [--json] [--min-score <0-100>]";
const MARKS = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };

/** Parse the command line. */
export function parseArgs(argv) {
  const options = { url: null, origin: null, json: false, minScore: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--origin" || arg === "--min-score") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} needs a value.`);
      }
      index += 1;
      if (arg === "--origin") {
        options.origin = new URL(value).origin;
      } else {
        options.minScore = Number(value);
        if (!Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 100) {
          throw new Error("--min-score must be a number from 0 to 100.");
        }
      }
    } else if (options.url === null) {
      options.url = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (options.url === null) {
    throw new Error(USAGE);
  }
  return options;
}

/** Format a report as plain text lines. */
export function formatReport(report) {
  const lines = [`Agent Forge report for ${report.url}`, ""];
  lines.push(`Score ${report.score}/100 (grade ${report.grade}). ${report.conformant ? "Conformant." : "NOT conformant: a MUST requirement fails."}`);
  lines.push(`Categories: ${Object.entries(report.categories).map(([name, value]) => `${name} ${value}`).join(", ")}`, "");
  for (const check of report.checks) {
    lines.push(`${MARKS[check.status]}  [${check.level.toUpperCase()}] ${check.title}`);
    if (check.status !== "pass" && check.detail) {
      lines.push(`      ${check.detail}`);
    }
    if (check.status !== "pass" && check.fix) {
      lines.push(`      Fix: ${check.fix}`);
    }
  }
  if (report.peers.length) {
    lines.push("", "Peers:");
    for (const peer of report.peers) {
      lines.push(`  ${peer.url}: ${peer.score}/100 (${peer.grade})${peer.conformant ? "" : ` fails ${peer.failed.join(", ")}`}`);
    }
  }
  return lines;
}

/** Run the CLI. Returns the exit code. */
export async function main(argv, print = console.log) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    print(error.message);
    return 2;
  }
  const report = await validateSite(options.url, { origin: options.origin });
  if (options.json) {
    print(JSON.stringify(report, null, 2));
  } else {
    formatReport(report).forEach(line => print(line));
  }
  return report.conformant && report.score >= options.minScore ? 0 : 1;
}

const isScript = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isScript) {
  process.exitCode = await main(process.argv.slice(2));
}
