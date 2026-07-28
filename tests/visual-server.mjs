import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const port = Number(process.env.PAGEPACK_TEST_PORT || 41731);

const mockChrome = `<script>
(() => {
  const paid = new URLSearchParams(location.search).get('plan') === 'pro';
  const journeyMode = new URLSearchParams(location.search).get('journey') === '1';
  const slow = new URLSearchParams(location.search).get('slow') === '1';
  const packs = [
    { id: 'pack_1', title: 'A practical guide to offline-first reading', rootUrl: 'https://example.com/guide', savedAt: Date.now() - 7200000, folderId: null, sortOrder: 0, stats: { pages: 6, bytes: 2840000, failed: 0 }, pages: Array.from({ length: 6 }, (_, index) => ({ title: index ? 'Related field note ' + index : 'A practical guide to offline-first reading', url: 'https://example.com/guide/' + (index || '') })) },
    { id: 'pack_2', title: 'Design systems field notes', rootUrl: 'https://example.com/design', savedAt: Date.now() - 86400000, folderId: 'folder_research', sortOrder: 0, stats: { pages: 12, bytes: 8300000, failed: 0 }, pages: [] }
  ];
  const folders = [{ id: 'folder_research', name: 'Research', createdAt: Date.now() - 100000, sortOrder: 0 }];
  const journeys = journeyMode ? [{
    id: 'journey_test', state: 'recording', rootUrl: 'https://example.com/start', title: 'Example journey',
    pageCount: 3, savedCount: 1, queuedCount: 2, pendingCount: 2, failedCount: 0, message: '1 saved · 2 waiting',
    pageTitles: [
      { title: 'Starting page', url: 'https://example.com/start', state: 'saved' },
      { title: 'A page being saved', url: 'https://example.com/second', state: 'queued' },
      { title: 'Another page waiting', url: 'https://example.com/third', state: 'queued' }
    ]
  }] : [];
  const reply = (callback, value) => slow ? setTimeout(() => callback(value), 900) : callback(value);
  window.chrome = {
    runtime: {
      lastError: null,
      getURL: path => '/' + path,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        window.__lastRuntimeMessage = message;
        if (message.type === 'LIST_LIBRARY') reply(callback, { packs, folders, captures: [], journeys });
        else if (message.type === 'GET_MONETIZATION') reply(callback, { state: { entitlement: { paid }, usage: { pages: 9 }, remaining: paid ? null : 16, pricing: { freePagesPerMonth: 25, currency: 'CAD', monthlyPrice: 'CAD $1.99/month', yearlyPrice: 'CAD $9.99/year' }, payment: { configured: true, plans: [{ unitAmountCents: 199, currency: 'cad', interval: 'month' }, { unitAmountCents: 999, currency: 'cad', interval: 'year' }] } } });
        else if (message.type === 'DELETE_PACK') {
          const index = packs.findIndex(pack => pack.id === message.id);
          if (index >= 0) packs.splice(index, 1);
          reply(callback, { ok: true });
        }
        else if (message.type === 'REMOVE_PACK_PAGE') reply(callback, { ok: true });
        else if (message.type === 'GET_CAPTURE_PREFERENCES') reply(callback, { preferences: { depth: 0, runScripts: true, folderId: null } });
        else if (message.type === 'SEARCH_LIBRARY') reply(callback, { packIds: [] });
        else if (message.type === 'GET_PACK_ISSUES') reply(callback, { issues: [] });
        else reply(callback, { ok: true, accepted: true, requestId: 'capture_test' });
      }
    },
    tabs: {
      query(_query, callback) { callback([{ id: 1, url: 'https://example.com/article', title: 'Example article' }]); },
      create() {}
    }
  };
})();
</script>`;

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const requestedPath = url.pathname === "/" ? "/popup.html" : url.pathname;
    const filePath = normalize(join(root, requestedPath));
    if (!filePath.startsWith(root)) throw new Error("Invalid path");
    let body = await readFile(filePath);
    if (requestedPath === "/popup.html") {
      body = Buffer.from(body.toString().replace('<script type="module" src="popup.js"></script>', `${mockChrome}<script type="module" src="popup.js"></script>`));
    }
    response.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`PagePack visual test server: http://127.0.0.1:${port}/popup.html`));
