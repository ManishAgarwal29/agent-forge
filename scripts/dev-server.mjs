// Local static server that behaves like GitHub Pages for this project: the site is served
// under a path prefix (default /agent-forge/) and every file carries
// Access-Control-Allow-Origin: *.
//
//   node scripts/dev-server.mjs [--port 8080] [--host 127.0.0.1] [--prefix /agent-forge]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option("port", "8080"));
const host = option("host", "127.0.0.1");
const prefix = `/${option("prefix", "/agent-forge").replace(/^\/|\/$/g, "")}`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  if (url.pathname === "/" || url.pathname === prefix) {
    response.writeHead(302, { ...headers, Location: `${prefix}/` });
    return response.end();
  }
  if (!url.pathname.startsWith(`${prefix}/`)) {
    response.writeHead(404, headers);
    return response.end("Not found");
  }
  let relative = decodeURIComponent(url.pathname.slice(prefix.length));
  if (relative.endsWith("/")) {
    relative += "index.html";
  }
  const file = normalize(join(ROOT, relative));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    response.writeHead(403, headers);
    return response.end("Forbidden");
  }
  try {
    if (!(await stat(file)).isFile()) {
      throw new Error("not a file");
    }
    response.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, headers);
    response.end("Not found");
  }
});

server.listen(port, host, () => console.log(`Serving ${ROOT} at http://${host}:${port}${prefix}/`));
