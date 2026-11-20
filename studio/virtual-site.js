// Serves a draft's files from memory, as if a site were hosted at PREVIEW_BASE.
// The linter and the preview both read the draft through this, so they see exactly what
// would be published, without a server and without writing a file.

const TYPES = {
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/**
 * :param base: The address the draft pretends to live at, with no trailing slash.
 * :param files: A Map (or function returning a Map) from path to text.
 * :param fallback: fetch for any other address, or null to answer 404.
 * :return: A fetch function.
 */
export function createVirtualFetch(base, files, fallback = null) {
  const prefix = `${base.replace(/\/$/, "")}/`;
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input.url;
    // Normalise as a server would: "./x" and "a/../x" both name the file x.
    let url = raw;
    try {
      url = new URL(raw).href;
    } catch {
      // Not an absolute URL: it cannot be this site's, so fall through below.
    }
    if (!url.startsWith(prefix)) {
      if (fallback) {
        return fallback(input, init);
      }
      return new Response("Not found", { status: 404 });
    }
    const path = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]);
    const map = typeof files === "function" ? files() : files;
    if (!map.has(path)) {
      return new Response("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
    }
    const extension = path.slice(path.lastIndexOf("."));
    return new Response(map.get(path), {
      status: 200,
      headers: { "content-type": TYPES[extension] || "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
    });
  };
}
