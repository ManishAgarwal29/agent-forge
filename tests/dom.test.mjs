import assert from "node:assert/strict";
import { test } from "node:test";
import { fill } from "../studio/dom.js";

test("fill skips empty values instead of showing them as text", () => {
  let received = null;
  const node = { replaceChildren: (...children) => { received = children; } };
  fill(node, "a", null, undefined, false, ["b", [null, "c"]]);
  assert.deepEqual(received, ["a", "b", "c"]);
});
