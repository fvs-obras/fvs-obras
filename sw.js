// Sistema de FVs: guarda o site no aparelho para abrir mesmo sem internet.
// Os dados (FVs, fotos etc.) ficam no banco local do Firebase e sincronizam sozinhos quando o sinal volta.
const V = "fvs-site-v1";
const SITE = ["./", "index.html", "fb-adapter.js", "firebase-config.js", "dicionario-ptbr.txt"];
const LIBS = /gstatic\.com\/firebasejs\/|cdnjs\.cloudflare\.com\/ajax\/libs\/|cdn\.jsdelivr\.net\/npm\/pdfjs-dist|fonts\.googleapis\.com\/css|fonts\.gstatic\.com\//;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SITE.map(u => c.add(new Request(u, {cache: "reload"})).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Páginas e scripts do próprio site: busca a versão nova; se a internet falhar ou demorar, usa a guardada.
async function networkFirst(req) {
  const c = await caches.open(V);
  const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; });
  const slow = new Promise(ok => setTimeout(ok, 4000));
  try {
    const r = await Promise.race([net, slow.then(() => null)]);
    if (r) return r;
  } catch {}
  const hit = await c.match(req, {ignoreSearch: req.mode === "navigate"}) || (req.mode === "navigate" ? await c.match("index.html") : null);
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}
// Bibliotecas externas e o dicionário: usa a guardada e atualiza em segundo plano.
async function cacheFirst(req) {
  const c = await caches.open(V), hit = await c.match(req);
  const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === self.location.origin) {
    if (r.mode === "navigate" || /\.(html|js)$/.test(u.pathname) || u.pathname.endsWith("/")) e.respondWith(networkFirst(r));
    else if (/\.(txt|png|jpg|svg|ico|json)$/.test(u.pathname) && !/dados-iniciais|backup/.test(u.pathname)) e.respondWith(cacheFirst(r));
    return;
  }
  if (LIBS.test(r.url)) e.respondWith(cacheFirst(r));
  // O tráfego do Firebase (login e banco) não passa por aqui.
});
