// Liga o sistema de FVs ao Firebase (login Google + Firestore).
// O app usa a mesma interface que usava no Claude: claude.use("db" | "user" | "assets" | "downloads").
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, orderBy, limit, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, FieldPath, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const gate = (html) => { $("#gate").classList.remove("hidden"); $("#gate-body").innerHTML = html; };
const hideGate = () => $("#gate").classList.add("hidden");

const cfg = window.FIREBASE_CONFIG || {};
if (!cfg.apiKey || String(cfg.apiKey).startsWith("COLE")) {
  gate(`<p><b>Falta configurar o Firebase.</b></p><p>Abra o arquivo <b>firebase-config.js</b> e cole a configuração do seu projeto, como explicado no LEIA-ME.</p>`);
  throw new Error("firebase-config.js não preenchido");
}
const ADMINS = (window.ADMIN_EMAILS || []).map(e => String(e).trim().toLowerCase());

const app = initializeApp(cfg);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { fs = initializeFirestore(app, {}); }

/* ---------- erros de escrita -> mesmo formato que o app já trata ---------- */
const mapErr = e => {
  const c = e && e.code;
  if (c === "permission-denied") return { code: "invalid_argument", message: e.message };
  if (c === "resource-exhausted") return { code: "quota_exceeded", message: e.message };
  if (c === "not-found") return { code: "not_found", message: e.message };
  return { code: "unavailable", message: (e && e.message) || "" };
};
const report = e => { const m = mapErr(e); if (m.code === "not_found") return; console.warn("Firestore:", e); window.__onWriteError && window.__onWriteError(m); };

/* ---------- banco (Firestore) ---------- */
const isPlain = v => v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function flatten(obj, prefix = [], out = []) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (isPlain(v) && Object.keys(v).length) flatten(v, prefix.concat(k), out);
    else out.push([new FieldPath(...prefix, k), v === undefined ? null : v]);
  }
  return out;
}
const snapDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
const snapQuery = qs => ({ docs: qs.docs.map(d => ({ id: d.id, exists: true, data: () => d.data(), metadata: d.metadata })), size: qs.size, empty: qs.empty, metadata: qs.metadata, docChanges: () => [] });

function wrapDoc(path) {
  const ref = doc(fs, path);
  return {
    id: ref.id, path,
    get: async () => snapDoc(await getDoc(ref)),
    // Escritas não esperam o servidor: funcionam offline e sincronizam quando o sinal voltar.
    set: data => { setDoc(ref, data).catch(report); return Promise.resolve(); },
    update: data => {
      const pairs = flatten(data); if (!pairs.length) return Promise.resolve();
      const args = pairs.flat(); updateDoc(ref, ...args).catch(report); return Promise.resolve();
    },
    delete: () => { deleteDoc(ref).catch(report); return Promise.resolve(); },
    onSnapshot: (next, err) => onSnapshot(ref, s => next(snapDoc(s)), e => { err && err(mapErr(e)); }),
    collection: sub => wrapQuery(`${path}/${sub}`)
  };
}
function wrapQuery(path, cons = []) {
  const q = () => query(collection(fs, path), ...cons);
  return {
    path,
    orderBy: (f, dir = "asc") => wrapQuery(path, cons.concat(orderBy(f, dir))),
    limit: n => wrapQuery(path, cons.concat(limit(n))),
    where: () => wrapQuery(path, cons),
    get: async () => snapQuery(await getDocs(q())),
    onSnapshot: (next, err) => onSnapshot(q(), s => next(snapQuery(s)), e => { err && err(mapErr(e)); }),
    doc: id => wrapDoc(`${path}/${id || Math.random().toString(36).slice(2)}`)
  };
}
const dbApi = { doc: p => wrapDoc(p), collection: p => wrapQuery(p) };

/* ---------- arquivos e fotos (guardados no Firestore, sem precisar do Storage pago) ---------- */
const MAX_B64 = 900 * 1024; // documento do Firestore aceita até ~1 MB
const toDataURL = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(blob); });
async function shrinkImage(blob) {
  let url = await toDataURL(blob);
  if (url.length <= MAX_B64) return url;
  const bmp = await createImageBitmap(blob);
  for (const [max, q] of [[1600, .75], [1400, .7], [1200, .65], [1000, .6], [800, .55]]) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    url = c.toDataURL("image/jpeg", q);
    if (url.length <= MAX_B64) return url;
  }
  throw { code: "too_large" };
}
const blobCache = new Map();
const assetsApi = {
  upload: async blob => {
    let data;
    if (blob.type && blob.type.startsWith("image/")) data = await shrinkImage(blob);
    else { data = await toDataURL(blob); if (data.length > MAX_B64) throw { code: "too_large" }; }
    const id = "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    blobCache.set(id, data);
    setDoc(doc(fs, "blobs", id), { data, type: blob.type || "", size: blob.size || 0, by: auth.currentUser.uid, at: new Date().toISOString() }).catch(e => { blobCache.delete(id); report(e); });
    return { id, url: "", sizeBytes: blob.size, contentType: blob.type };
  },
  delete: async id => { blobCache.delete(id); deleteDoc(doc(fs, "blobs", id)).catch(() => {}); },
  list: async () => ({ assets: [] })
};
async function blobData(id) {
  if (blobCache.has(id)) return blobCache.get(id);
  const s = await getDoc(doc(fs, "blobs", id));
  const d = s.exists() ? s.data().data : "";
  if (d) blobCache.set(id, d);
  return d;
}

/* ---------- download de arquivos (PDF, backup) ---------- */
const downloadsApi = {
  save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { status: "saved" };
  }
};

/* ---------- backup ---------- */
const SUBS = ["pda", "obs", "photos", "docs", "log"];
async function exportAll({ files = true, onProgress = () => {} } = {}) {
  const out = { app: "fvs-da-obra", version: 1, exportedAt: new Date().toISOString(), docs: {} };
  const put = (p, d) => { out.docs[p] = d; };
  for (const c of ["templates", "folders", "users", "library"]) {
    onProgress(`Lendo ${c}…`);
    (await getDocs(collection(fs, c))).forEach(d => put(`${c}/${d.id}`, d.data()));
  }
  for (const p of ["config/access"]) { const s = await getDoc(doc(fs, p)); if (s.exists()) put(p, s.data()); }
  const fvSnap = await getDocs(collection(fs, "fvs")); let i = 0;
  for (const f of fvSnap.docs) {
    onProgress(`Lendo FVs… ${++i}/${fvSnap.size}`);
    put(`fvs/${f.id}`, f.data());
    for (const sub of SUBS) (await getDocs(collection(fs, "fvs", f.id, sub))).forEach(d => put(`fvs/${f.id}/${sub}/${d.id}`, d.data()));
  }
  if (files) { onProgress("Lendo fotos e arquivos…"); (await getDocs(collection(fs, "blobs"))).forEach(d => put(`blobs/${d.id}`, d.data())); }
  return out;
}
async function importAll(json, onProgress = () => {}) {
  const entries = Object.entries(json.docs || {}).filter(([p]) => p.split("/").length % 2 === 0);
  let batch = writeBatch(fs), n = 0, bytes = 0, done = 0;
  const flush = async () => { if (!n) return; await batch.commit(); done += n; onProgress(`Importando… ${done}/${entries.length}`); batch = writeBatch(fs); n = 0; bytes = 0; };
  for (const [p, d] of entries) {
    const size = JSON.stringify(d).length;
    if (n >= 400 || bytes + size > 8 * 1024 * 1024) await flush();
    batch.set(doc(fs, p), d); n++; bytes += size;
  }
  await flush();
}

/* ---------- login e permissões ---------- */
let accessDoc = null, role = "none", current = null;
async function readAccess() {
  const s = await getDoc(doc(fs, "config/access"));
  accessDoc = s.exists() ? s.data() : null;
  return accessDoc;
}
function computeRole(email) {
  const e = String(email || "").toLowerCase();
  if (ADMINS.includes(e)) return "admin";
  const a = accessDoc || {};
  if ((a.editors || []).map(x => x.toLowerCase()).includes(e)) return "editor";
  if ((a.viewers || []).map(x => x.toLowerCase()).includes(e)) return "viewer";
  return "none";
}
const profileCache = new Map();
const userApi = {
  id: async () => current.uid,
  isOwner: () => role === "admin",
  canEdit: () => role === "admin" || role === "editor",
  can: name => name === "data.write" ? (role === "admin" || role === "editor") : null,
  me: async () => ({ name: current.displayName || current.email, email: current.email }),
  profiles: async ids => {
    const out = {};
    await Promise.all(ids.map(async id => {
      if (!profileCache.has(id)) { try { const s = await getDoc(doc(fs, "users", id)); profileCache.set(id, s.exists() ? s.data() : {}); } catch { profileCache.set(id, {}); } }
      const p = profileCache.get(id) || {};
      out[id] = { id, name: p.name || "" };
    }));
    return out;
  }
};

window.__fb = {
  accessExists: () => !!accessDoc,
  getAccess: async () => ({ editors: [], viewers: [], ...(await readAccess() || {}) }),
  setAccess: async acc => { await setDoc(doc(fs, "config/access"), { editors: acc.editors || [], viewers: acc.viewers || [], updatedAt: new Date().toISOString(), updatedBy: current.email }); accessDoc = acc; },
  exportAll, importAll, blobData,
  signOut: () => signOut(auth).then(() => location.reload())
};

const googleBtn = `<button class="gbtn" type="button" id="g-login"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Entrar com Google</button>`;
function showLogin(msg) {
  gate(`<p>Entre com a sua conta Google para ver e preencher as fichas de verificação.</p>${googleBtn}${msg ? `<p style="color:var(--bad)">${esc(msg)}</p>` : ""}`);
  $("#g-login").onclick = async () => {
    const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { try { await signInWithRedirect(auth, provider); } catch (e2) { showLogin("Não foi possível abrir o login. Tente em outro navegador."); } }
      else if (e && e.code === "auth/unauthorized-domain") showLogin("Este endereço ainda não foi autorizado no Firebase (Authentication → Configurações → Domínios autorizados).");
      else if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") showLogin("Não foi possível entrar. Tente de novo.");
    }
  };
}
function userBox(u) {
  const b = $("#userbox"); if (!b) return;
  b.innerHTML = `${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : ""}<span>${esc((u.displayName || u.email || "").split(" ")[0])}</span><button type="button" id="g-logout">Sair</button>`;
  $("#g-logout").onclick = () => window.__fb.signOut();
}

getRedirectResult(auth).catch(() => {});
let resolved = false;
onAuthStateChanged(auth, async u => {
  if (!u) { if (resolved) location.reload(); else showLogin(); return; }
  current = u;
  gate(`<p>Entrando como <b>${esc(u.email)}</b>…</p>`);
  setDoc(doc(fs, "users", u.uid), { name: u.displayName || u.email, email: u.email, photo: u.photoURL || "", lastSeen: new Date().toISOString() }, { merge: true }).catch(() => {});
  try { await readAccess(); } catch { accessDoc = null; }
  role = computeRole(u.email);
  if (role === "none") {
    gate(`<p>O e-mail <b>${esc(u.email)}</b> ainda não tem acesso ao sistema.</p><p>Peça ao administrador para liberar seu e-mail na tela <b>Equipe</b>.</p><button class="gbtn" type="button" id="g-other">Entrar com outra conta</button>`);
    $("#g-other").onclick = () => window.__fb.signOut();
    return;
  }
  userBox(u); hideGate();
  if (!resolved) { resolved = true; window.__fbResolve({ db: dbApi, user: userApi, assets: role === "viewer" ? null : assetsApi, downloads: downloadsApi }); }
});
