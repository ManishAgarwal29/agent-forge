// The read actions Agent Forge shares with other agent sites, through its action bridge.
// bridge/agent-manifest.json loads this module in the bridge frame, which has no Forge page.
// Each action has the name the page's own action has (site-actions.js), so the network's
// instructions fit both.
import { TEMPLATES } from "../studio/templates.js";
import { compactReport } from "../validator/compact.js";
import { validateSite } from "../validator/validator.js";

/**
 * Shares two reads with every agent site that calls Forge: the starter templates, and a
 * conformance check of any published network. Both show only public facts, so any caller
 * may use them. A caller's agent can ask Forge "is this peer safe to call?" first.
 */
class BridgeActions {
  /** Share with every site on the web: the data is public. */
  static CALLERS = ["*"];

  /**
   * Register the shared reads with the bridge's registry.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register({
      name: "get_starter_templates",
      description: "List the starter templates for an agent network: id, title and what each is for.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ ok: true, templates: TEMPLATES.map(({ id, title, blurb }) => ({ id, title, blurb })) }),
    });
    actions.register({
      name: "validate_site",
      description: "Check a published agentic website's public files against the open agentic web specification and score how far to trust it (0 to 100, conformant or not). Takes the network URL: the folder that holds agent-manifest.json, then the network name. Returns the verdict, failed checks with fixes and warnings. Does not run the site's agents.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string", maxLength: 500, description: "Network URL, such as https://site.example/my_network." } },
      },
      execute: BridgeActions.validateSite,
    });
  }

  static async validateSite(args) {
    return { ok: true, ...compactReport(await validateSite(args.url)) };
  }
}

export const registerActions = BridgeActions.registerActions;
