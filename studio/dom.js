/**
 * Build a DOM element. Text goes in as text, never as HTML, because drafts and reports
 * can quote other sites.
 *
 * :param tag: Element name.
 * :param props: Attributes. "class" sets the class, "on<event>" adds a listener, and
 *   false, null and undefined are skipped. "value" and "checked" set properties.
 * :param children: Nodes, strings or nested arrays. Falsy values are skipped.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === "class") {
      node.className = value;
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else if (key === "value" || key === "checked") {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}
