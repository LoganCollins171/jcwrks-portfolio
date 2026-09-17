// jc_wrks Portfolio Manager (jcwrks.com/admin).
// Talks to /api/admin (netlify/functions/admin.mjs). Plain JS, no build step.
(() => {
  "use strict";

  // ------------------------------------------------------------------ constants
  const API = "/api/admin";
  const SESSION_KEY = "jcwrks_admin_session";
  const PUBLISH_KEY = "jcwrks_admin_publish";
  const SEEN_KEY = "jcwrks_admin_seen_live_moments";
  const CELEBRATED_KEY = "jcwrks_admin_celebrated";
  const MAX_EDGE = 2000;
  const TARGET_BYTES = 2.5 * 1024 * 1024;
  const MAX_INPUT_BYTES = 80 * 1024 * 1024;
  const SEND_CONCURRENCY = 2;
  const SAVE_EVERY = 8;              // save to the gallery in chunks so a closed tab loses little
  // Automated browser tests shorten the waits (sessionStorage flag); real use never sets it.
  const FAST = (() => { try { return sessionStorage.getItem("jcwrks_admin_test_fast") === "1"; } catch { return false; } })();
  const POLL_MS = FAST ? 700 : 4000;
  const SLOW_MS = FAST ? 5000 : 4 * 60 * 1000;
  const STUCK_MS = FAST ? 9000 : 6 * 60 * 1000;
  const REFRESH_ON_FOCUS_MS = 20000;
  const SPORTS = ["basketball", "football", "soccer", "baseball", "softball", "hockey", "track"];

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const plural = (n, w, pl) => `${fmt(n)} ${n === 1 ? w : pl || w + "s"}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ------------------------------------------------------------------ state
  const S = {
    token: null,
    state: null,          // dashboard snapshot from the server
    deploy: null,         // { productionSha, liveCommit, live }
    view: null,           // "home" | "gallery"
    gallery: null,        // open gallery slug
    photos: [],           // saved draft order for the open gallery
    viewOrder: [],        // on-screen order (may be unsaved)
    tiles: new Map(),     // src -> tile element for the open gallery (reused so thumbnails never reload)
    tileCache: new Map(), // slug -> tiles Map, so reopening a gallery doesn't reload its thumbnails
    coverCache: new Map(),// url -> cover <img>
    selecting: false,
    selected: new Set(),
    busy: 0,              // saves in flight
    upload: null,         // current upload batch
    sortable: null,
    publish: null,        // { sha, startedAt, phase, expect }
    publishPhase: null,   // null | preparing | publishing | updating | verifying | done | slow | stuck | failed | mismatch
    pollTimer: null,
    knownDraft: null,
    knownProd: null,
    lastRefresh: 0,
    lastDone: 0,
    locks: new Set(),     // prevents double taps from running an action twice
    removedAt: new Map(), // "slug|src" -> { index, sha } from this session, so Put back returns to the exact spot
  };

  // ------------------------------------------------------------------ helpers
  function announce(text) {
    const a = $("announcer");
    a.textContent = "";
    setTimeout(() => { a.textContent = text; }, 30);
  }

  /** Run fn at most once at a time per key (double taps are ignored). */
  async function once(key, fn) {
    if (S.locks.has(key)) return;
    S.locks.add(key);
    try { return await fn(); } finally { S.locks.delete(key); }
  }

  const galleryPath = (slug) => (SPORTS.includes(slug) ? `/work/sports/${slug}/` : `/work/${slug}/`);
  const titleOf = (slug) => S.state?.galleries.find((g) => g.slug === slug)?.title || slug;

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (days === 0) return `Today, ${time}`;
    if (days === 1) return `Yesterday, ${time}`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  }

  // ------------------------------------------------------------------ session
  function loadSession() {
    const s = store.get(SESSION_KEY);
    return s && s.token && s.expires > Date.now() ? s.token : null;
  }
  function saveSession(token, expires) { S.token = token; store.set(SESSION_KEY, { token, expires }); }
  function clearSession() { S.token = null; store.set(SESSION_KEY, null); }

  // ------------------------------------------------------------------ api
  class ApiError extends Error {
    constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
  }

  async function api(op, body, { raw, headers = {} } = {}) {
    const init = { method: "POST", headers: { ...headers } };
    if (S.token) init.headers.authorization = `Bearer ${S.token}`;
    if (S.knownDraft) init.headers["x-known-draft"] = S.knownDraft;
    if (S.knownProd) init.headers["x-known-prod"] = S.knownProd;
    if (raw) init.body = raw;
    else { init.body = JSON.stringify(body || {}); init.headers["content-type"] = "application/json"; }

    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(`${API}?op=${encodeURIComponent(op)}`, init);
      } catch {
        throw new ApiError(0, "offline", "Couldn't connect. Check your internet connection. Nothing was lost.");
      }
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.ok && data && data.ok) {
        noteVersions(data);
        return data;
      }
      const err = data?.error || {};
      const code = err.code || `http_${res.status}`;
      if (code === "busy" && attempt < 3) { await sleep(700 * attempt); continue; }
      if (code === "signed_out") {
        clearSession();
        showLogin("You were signed out. Sign in again and pick up where you left off. Nothing was lost.");
      }
      const message = err.message || (res.status === 413
        ? "That photo was too large to send. Please try again."
        : "Something went wrong. Nothing was lost. Please try again.");
      throw new ApiError(res.status, code, message, { retryAfterSec: err.retryAfterSec });
    }
  }

  function noteVersions(data) {
    const st = data.snapshot?.state || (data.draftSha && data.galleries ? data : null);
    if (data.draftSha) S.knownDraft = data.draftSha;
    if (st?.draftSha) S.knownDraft = st.draftSha;
    if (data.productionSha) S.knownProd = data.productionSha;
    if (st?.productionSha) S.knownProd = st.productionSha;
  }

  /** Apply a write's snapshot (fresh state + gallery) without another round trip. */
  function applySnapshot(data) {
    const snap = data.snapshot;
    if (!snap) return;
    if (snap.state) setState(snap.state);
    if (snap.gallery && snap.gallery.gallery === S.gallery) setGallery(snap.gallery);
  }

  async function withBusy(fn) {
    S.busy++;
    refreshControls();
    try { return await fn(); }
    finally { S.busy--; S.lastDone = Date.now(); refreshControls(); }
  }

  // ------------------------------------------------------------------ views & routing
  function showOnly(id) {
    for (const v of ["loginView", "loadingView", "homeView", "galleryView"]) $(v).hidden = v !== id;
    $("statusPill").hidden = !(id === "homeView" || id === "galleryView");
    S.reveal?.();
  }

  function showLogin(message) {
    stopPolling();
    S.view = null;
    showOnly("loginView");
    hideAlert();
    $("loginMsg").textContent = message || "";
    $("pw").value = "";
    setTimeout(() => $("pw").focus(), 60);
  }

  function route() {
    const m = location.hash.match(/^#\/gallery\/([a-z]+)$/);
    return m ? { view: "gallery", slug: m[1] } : { view: "home" };
  }

  let ignoreHash = false;
  async function onHashChange() {
    if (ignoreHash) { ignoreHash = false; return; }
    if (!S.token || !S.state) return;
    const next = route();
    if (S.view === "gallery" && (next.view !== "gallery" || next.slug !== S.gallery)) {
      const okToLeave = await guardUnsavedOrder();
      if (!okToLeave) {
        ignoreHash = true;
        location.hash = `#/gallery/${S.gallery}`;
        return;
      }
      if (S.upload && S.upload.active) {
        ignoreHash = true;
        location.hash = `#/gallery/${S.gallery}`;
        toast("Photos are still uploading. You can switch galleries when they're saved.");
        return;
      }
    }
    await openRoute(next);
  }

  async function openRoute(r) {
    exitSelect();
    hideAlert();
    if (r.view === "gallery" && S.state.galleries.some((g) => g.slug === r.slug)) {
      S.view = "gallery";
      showOnly("galleryView");
      if (S.gallery !== r.slug) {
        S.gallery = r.slug;
        S.photos = [];
        S.viewOrder = [];
        S.photosLoaded = false;
        clearTiles(r.slug);
        $("uploadPanel").hidden = true;
        S.upload = null;
      }
      renderGalleryHead();
      renderGrid();
      window.scrollTo(0, 0);
      $("gTitle").focus?.({ preventScroll: true });
      try {
        setGallery(await api("gallery", { gallery: r.slug }));
      } catch (err) {
        if (err.code !== "signed_out") showAlert(`Couldn't open this gallery. ${err.message}`, { action: "Try again", onAction: () => openRoute(r) });
      }
    } else {
      S.view = "home";
      S.gallery = null;
      showOnly("homeView");
      renderHome();
      window.scrollTo(0, 0);
    }
    refreshControls();
  }

  // ------------------------------------------------------------------ alerts / toast
  function showAlert(text, { kind = "err", action, onAction } = {}) {
    const a = $("alert");
    a.className = "alert" + (kind === "warn" ? " warn" : "");
    $("alertText").textContent = text;
    const btn = $("alertAction");
    btn.hidden = !action;
    btn.textContent = action || "";
    btn.onclick = action ? () => { hideAlert(); onAction(); } : null;
    a.hidden = false;
    a.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function hideAlert() { $("alert").hidden = true; }

  let toastTimer;
  function toast(text, { action, onAction, ms = 5000 } = {}) {
    const t = $("toast");
    $("toastText").textContent = text;
    const btn = $("toastAction");
    btn.hidden = !action;
    btn.textContent = action || "";
    btn.onclick = action ? () => { t.hidden = true; onAction(); } : null;
    t.hidden = false;
    announce(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    layoutDock();
  }

  function layoutDock() {
    requestAnimationFrame(() => {
      const h = $("dock").getBoundingClientRect().height;
      document.documentElement.style.setProperty("--dock-h", `${Math.round(h)}px`);
    });
  }

  // ------------------------------------------------------------------ dialogs
  function openDialog(d) {
    if (d.open) return;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeDialog(d) {
    if (!d.open) return;
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  /**
   * Confirm dialog. Resolves "ok" | "alt" | "cancel".
   * body: string | Node, ok/alt/cancel labels, danger, checkText (must tick before OK).
   */
  function ask({ title, body, ok = "OK", alt, cancel = "Cancel", danger = false, checkText }) {
    return new Promise((resolve) => {
      const d = $("confirmDialog");
      if (d.open) return resolve("cancel");
      $("confirmTitle").textContent = title;
      const bodyEl = $("confirmBody");
      bodyEl.replaceChildren();
      if (typeof body === "string") {
        const p = document.createElement("p");
        p.className = "confirm-text";
        p.textContent = body;
        bodyEl.appendChild(p);
      } else if (body) {
        bodyEl.appendChild(body);
      }
      const okBtn = $("confirmOk");
      okBtn.textContent = ok;
      okBtn.className = "btn " + (danger ? "danger solid" : "primary");
      const altBtn = $("confirmAlt");
      altBtn.hidden = !alt;
      altBtn.textContent = alt || "";
      $("confirmCancel").textContent = cancel;
      const wrap = $("confirmCheckWrap");
      const check = $("confirmCheck");
      wrap.hidden = !checkText;
      check.checked = false;
      $("confirmCheckText").textContent = checkText || "";
      okBtn.disabled = !!checkText;
      check.onchange = () => { okBtn.disabled = !check.checked; };
      const done = (v) => {
        okBtn.onclick = altBtn.onclick = $("confirmCancel").onclick = null;
        d.oncancel = null;
        closeDialog(d);
        resolve(v);
      };
      okBtn.onclick = () => done("ok");
      altBtn.onclick = () => done("alt");
      $("confirmCancel").onclick = () => done("cancel");
      d.oncancel = (e) => { e.preventDefault(); done("cancel"); };
      openDialog(d);
      setTimeout(() => (checkText ? check : $("confirmTitle")).focus({ preventScroll: true }), 30);
    });
  }

  function parseWhole(text) {
    const t = String(text || "").replace(/[,\s]/g, "").replace(/^\+/, "");
    if (!/^\d{1,9}$/.test(t)) return null;
    return Number(t);
  }

  function askNumber({ title, help, okLabel, validate, confirmText }) {
    return new Promise((resolve) => {
      const d = $("numberDialog");
      if (d.open) return resolve(null);
      const input = $("numberInput");
      const okBtn = $("numberOk");
      const check = $("numberCheck");
      $("numberTitle").textContent = title;
      $("numberHelp").textContent = help;
      input.value = "";
      check.checked = false;
      let current = null;
      const update = () => {
        const n = parseWhole(input.value);
        const v = n === null ? { ok: false, preview: input.value.trim() ? "Enter a whole number, like 1,250" : "" } : validate(n);
        current = v.ok ? n : null;
        $("numberPreview").textContent = v.preview || "";
        const need = v.ok && confirmText ? confirmText(n) : null;
        $("numberCheckWrap").hidden = !need;
        if (need) $("numberCheckText").textContent = need;
        okBtn.textContent = v.ok ? okLabel(n) : "Save";
        okBtn.disabled = !v.ok || (!!need && !check.checked);
      };
      input.oninput = update;
      check.onchange = update;
      update();
      const done = (v) => {
        input.oninput = check.onchange = null;
        $("numberForm").onsubmit = null;
        $("numberCancel").onclick = null;
        d.oncancel = null;
        closeDialog(d);
        resolve(v);
      };
      $("numberForm").onsubmit = (e) => { e.preventDefault(); if (!okBtn.disabled && current !== null) done(current); };
      $("numberCancel").onclick = () => done(null);
      d.oncancel = (e) => { e.preventDefault(); done(null); };
      openDialog(d);
      setTimeout(() => input.focus(), 60);
    });
  }

  // ------------------------------------------------------------------ dashboard state
  function setState(st) {
    S.state = st;
    S.knownDraft = st.draftSha;
    S.knownProd = st.productionSha;
    S.lastRefresh = Date.now();
    if (S.view === "home") renderHome();
    if (S.view === "gallery") { renderGalleryHead(); renderRemoved(); }
    checkMilestoneOnLoad();
    refreshControls();
  }

  async function refreshState({ quiet = false } = {}) {
    try {
      const st = await api("state");
      if (st.renewedSession) saveSession(st.renewedSession.token, st.renewedSession.expires);
      S.deploy = st.deploy || null;
      setState(st);
      return st;
    } catch (err) {
      if (!quiet && err.code !== "signed_out") showAlert(`Couldn't refresh. ${err.message}`, { action: "Try again", onAction: () => refreshState() });
      throw err;
    }
  }

  function renderHome() {
    const st = S.state;
    if (!st) return;
    const { live, draft } = st.stats;
    $("mcValue").textContent = fmt(draft);
    $("mcLive").textContent = draft !== live
      ? `jcwrks.com shows ${fmt(live)} until you publish.`
      : "This is the number showing on jcwrks.com.";
    renderMilestone(draft, st.milestones || []);

    $("factPhotos").textContent = fmt(st.totalPhotos);
    $("factGalleries").textContent = `${st.galleries.filter((g) => g.count > 0).length} of ${st.galleries.length}`;
    const lp = st.lastPublished;
    if (lp && lp.date) {
      $("factPublished").textContent = formatDate(lp.date);
      const what = [...(lp.galleries || []), ...(lp.moments ? ["Moments Captured"] : [])];
      $("factPublishedLabel").textContent = what.length ? `last published · ${what.slice(0, 3).join(", ")}${what.length > 3 ? "…" : ""}` : "last published";
    } else {
      $("factPublished").textContent = "Not yet";
      $("factPublishedLabel").textContent = "last published";
    }

    const list = $("galleryList");
    const rows = [];
    const sorted = [...st.galleries].sort((a, b) => (b.count > 0) - (a.count > 0) || b.count - a.count || SPORTS.indexOf(a.slug) - SPORTS.indexOf(b.slug));
    for (const g of sorted) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "gallery-row" + (g.count ? "" : " is-empty");
      a.href = `#/gallery/${g.slug}`;
      if (g.cover) {
        const coverKey = `${g.slug}|${g.cover.sha || g.cover.url}`;
        let cover = S.coverCache.get(coverKey);
        if (!cover) {
          const img = document.createElement("img");
          img.className = "cover";
          img.alt = "";
          img.loading = "lazy";
          img.decoding = "async";
          img.src = g.cover.url;
          img.onerror = () => { if (img.src !== g.cover.fallbackUrl) img.src = g.cover.fallbackUrl; };
          S.coverCache.set(coverKey, img);
          cover = img;
        }
        a.appendChild(cover);
      }
      const scrim = document.createElement("span");
      scrim.className = "scrim";
      scrim.setAttribute("aria-hidden", "true");
      const meta = document.createElement("span");
      meta.className = "meta";
      const group = document.createElement("span");
      group.className = "group";
      group.textContent = SPORTS.includes(g.slug) ? "Sports" : "Gallery";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = g.title;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = g.count ? plural(g.count, "photo") : "Empty";
      meta.append(group, name, count);
      if (g.changed) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = "Not published yet";
        meta.appendChild(chip);
      }
      a.setAttribute("aria-label", `${g.title}, ${plural(g.count, "photo")}${g.changed ? ", has unpublished changes" : ""}`);
      a.append(scrim, meta);
      li.appendChild(a);
      rows.push(li);
    }
    list.replaceChildren(...rows);
    renderReview();
  }

  function renderMilestone(value, milestones) {
    const next = milestones.find((m) => m > value);
    const box = $("milestone");
    if (!next) { box.hidden = true; return; }
    const prev = [...milestones].reverse().find((m) => m <= value) || 0;
    const pct = Math.max(0, Math.min(100, ((value - prev) / (next - prev)) * 100));
    box.hidden = false;
    $("msFill").style.width = `${pct}%`;
    $("msText").textContent = `${fmt(next - value)} more until ${fmt(next)}`;
  }

  function renderReview() {
    const st = S.state;
    const c = st.changes;
    // While a publish is still reaching the website, "everything is live" isn't true yet.
    const inFlight = ["publishing", "updating", "verifying", "slow", "stuck", "mismatch"].includes(S.publishPhase);
    $("changesNone").hidden = c.hasChanges || inFlight;
    $("changesSome").hidden = !c.hasChanges;
    const items = [];
    for (const g of c.galleries) {
      if (g.housekeeping) continue;
      const box = document.createElement("div");
      box.className = "review-item";
      const h = document.createElement("h4");
      h.textContent = g.title;
      const ul = document.createElement("ul");
      const add = (text, cls) => { const li = document.createElement("li"); li.textContent = text; if (cls) li.className = cls; ul.appendChild(li); };
      if (g.added) add(`+ ${plural(g.added, "photo")}`, "plus");
      if (g.removed) add(`− ${plural(g.removed, "photo")}`, "minus");
      if (g.replaced) add(`${plural(g.replaced, "photo")} updated`);
      if (g.moved) add("Order changed");
      if (g.captions) add(`${plural(g.captions, "caption")} changed`);
      box.append(h, ul);
      items.push(box);
    }
    if (st.stats.draft !== st.stats.live) {
      const box = document.createElement("div");
      box.className = "review-item";
      const h = document.createElement("h4");
      h.textContent = "Moments Captured";
      const ul = document.createElement("ul");
      const li = document.createElement("li");
      li.textContent = `${fmt(st.stats.live)} → ${fmt(st.stats.draft)}`;
      ul.appendChild(li);
      box.append(h, ul);
      items.push(box);
    }
    if (c.hasChanges && !items.length) {
      const box = document.createElement("div");
      box.className = "review-item";
      box.textContent = "Behind-the-scenes gallery tidy-up (nothing visible changes).";
      items.push(box);
    }
    $("reviewList").replaceChildren(...items);
  }

  function reviewNode() {
    const wrap = document.createElement("div");
    wrap.className = "review";
    for (const n of $("reviewList").children) wrap.appendChild(n.cloneNode(true));
    const p = document.createElement("p");
    p.className = "confirm-text small";
    p.style.marginTop = "10px";
    p.textContent = "Your website updates in about a minute. Removed photos come off the site.";
    const frag = document.createElement("div");
    frag.append(wrap, p);
    return frag;
  }

  // ------------------------------------------------------------------ gallery
  function setGallery(g) {
    if (g.gallery !== S.gallery) return;
    S.photosLoaded = true;
    const wasDirty = orderDirty();
    const prevView = S.viewOrder;
    S.photos = g.photos;
    const valid = new Set(g.photos.map((p) => p.src));
    // Keep an unsaved on-screen order only if it still covers exactly the saved photos.
    S.viewOrder = wasDirty && prevView.length === g.photos.length && prevView.every((s) => valid.has(s)) ? prevView : g.photos.map((p) => p.src);
    for (const s of [...S.selected]) if (!valid.has(s)) S.selected.delete(s);
    renderGalleryHead();
    renderGrid();
    renderRemoved();
  }

  const photoBySrc = (src) => S.photos.find((p) => p.src === src);

  function orderDirty() {
    const saved = S.photos.map((p) => p.src);
    return saved.length === S.viewOrder.length && saved.some((s, i) => s !== S.viewOrder[i]);
  }

  function renderGalleryHead() {
    if (!S.gallery || !S.state) return;
    const g = S.state.galleries.find((x) => x.slug === S.gallery);
    $("gTitle").textContent = g ? g.title : S.gallery;
    $("gGroup").textContent = SPORTS.includes(S.gallery) ? "Sports" : "Gallery";
    const newCount = S.photos.filter((p) => p.isNew).length;
    const n = S.photos.length || g?.count || 0;
    $("gCount").textContent = `${plural(n, "photo")}${newCount ? ` · ${fmt(newCount)} not live yet` : ""}`;
    document.title = `${g ? g.title : "Gallery"} · jc_wrks Portfolio Manager`;
  }

  function clearTiles(nextSlug) {
    $("grid").replaceChildren();
    if (!S.tileCache.has(nextSlug)) S.tileCache.set(nextSlug, new Map());
    S.tiles = S.tileCache.get(nextSlug);
  }

  function makeTile(p) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.setAttribute("role", "button");
    tile.tabIndex = 0;
    tile.dataset.src = p.src;
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = p.url;
    img.onerror = () => {
      if (img.src !== p.fallbackUrl && p.fallbackUrl) img.src = p.fallbackUrl;
      else tile.classList.add("broken");
    };
    const num = document.createElement("span");
    num.className = "num";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Not live yet";
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.setAttribute("aria-hidden", "true");
    tile.append(img, num, badge, tick);
    tile.addEventListener("click", () => onTileActivate(tile.dataset.src));
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onTileActivate(tile.dataset.src); }
    });
    return tile;
  }

  function renderGrid() {
    const grid = $("grid");
    const order = S.viewOrder.filter((src) => photoBySrc(src));
    const keep = new Set(order);
    // Only prune once the real list has arrived (an early empty render must not throw away cached tiles).
    if (S.photosLoaded) for (const [src, el] of S.tiles) if (!keep.has(src)) { el.remove(); S.tiles.delete(src); }
    order.forEach((src, i) => {
      const p = photoBySrc(src);
      let tile = S.tiles.get(src);
      if (!tile) { tile = makeTile(p); S.tiles.set(src, tile); }
      const img = tile.firstChild;
      if (img.dataset.sha !== p.sha) {
        // Same name, different bytes (replaced): load the new picture.
        if (img.dataset.sha) img.src = p.url;
        img.dataset.sha = p.sha;
      }
      tile.querySelector(".num").textContent = i + 1;
      tile.querySelector(".badge").hidden = !p.isNew;
      tile.setAttribute("aria-label", `Photo ${i + 1} of ${order.length}${p.isNew ? ", not live yet" : ""}`);
      if (S.selecting) tile.setAttribute("aria-pressed", S.selected.has(src) ? "true" : "false");
      else tile.removeAttribute("aria-pressed");
      if (grid.children[i] !== tile) grid.insertBefore(tile, grid.children[i] || null);
    });
    grid.classList.toggle("selecting", S.selecting);
    $("emptyGallery").hidden = order.length > 0 || !S.photosLoaded;
    $("reorderHint").hidden = order.length < 2;
    $("reorderHint").textContent = S.selecting
      ? "Tap photos to select them."
      : "Press and hold a photo, then drag to change the order. Tap a photo for more options.";
    setupSortable();
    refreshControls();
  }

  function renderRemoved() {
    const panel = $("removedPanel");
    const g = S.state?.changes.galleries.find((x) => x.slug === S.gallery);
    const removed = g?.removedPhotos || [];
    panel.hidden = !removed.length;
    if (!removed.length) return;
    const items = removed.map((p) => {
      const box = document.createElement("div");
      box.className = "removed-item";
      const img = document.createElement("img");
      img.alt = "Removed photo";
      img.loading = "lazy";
      img.src = p.url;
      img.onerror = () => { if (img.src !== p.fallbackUrl) img.src = p.fallbackUrl; };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small";
      btn.textContent = "Put back";
      btn.onclick = () => restorePhotos([restoreItem(S.gallery, p.src)]);
      box.append(img, btn);
      return box;
    });
    $("removedStrip").replaceChildren(...items);
    $("restoreAll").hidden = removed.length < 2;
    $("restoreAll").onclick = () => restorePhotos(removed.map((p) => restoreItem(S.gallery, p.src)));
  }

  function setupSortable() {
    if (typeof Sortable === "undefined") return; // tap menu still reorders
    if (!S.sortable) {
      S.sortable = Sortable.create($("grid"), {
        animation: 160,
        delay: 260,
        delayOnTouchOnly: true,
        touchStartThreshold: 8,
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        onEnd: () => {
          S.viewOrder = [...$("grid").children].map((t) => t.dataset.src);
          renderGrid();
          if (orderDirty()) announce("Order changed. Tap Save order to keep it.");
        },
      });
    }
    S.sortable.option("disabled", S.selecting || isBlocked());
  }

  function moveInView(src, to) {
    const order = S.viewOrder.filter((s) => s !== src);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, src);
    S.viewOrder = order;
    renderGrid();
    const tile = S.tiles.get(src);
    tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    announce(`Moved to position ${order.indexOf(src) + 1}. Tap Save order to keep it.`);
  }

  function onTileActivate(src) {
    if (isBlocked()) return;
    if (S.selecting) {
      if (S.selected.has(src)) S.selected.delete(src); else S.selected.add(src);
      renderGrid();
      return;
    }
    openSheet(src);
  }

  let sheetSrc = null;
  function openSheet(src) {
    const p = photoBySrc(src);
    if (!p) return;
    sheetSrc = src;
    const img = $("sheetImg");
    img.src = p.url;
    img.onerror = () => { if (img.src !== p.fallbackUrl) img.src = p.fallbackUrl; };
    const idx = S.viewOrder.indexOf(src);
    const last = S.viewOrder.length - 1;
    $("sheetTitle").textContent = `Photo ${idx + 1} of ${S.viewOrder.length}${p.isNew ? " · not live yet" : ""}`;
    for (const b of document.querySelectorAll("[data-move]")) {
      const m = b.dataset.move;
      b.disabled = ((m === "first" || m === "up") && idx === 0) || ((m === "last" || m === "down") && idx === last);
    }
    $("moveToInput").value = "";
    $("moveToInput").placeholder = `1 to ${S.viewOrder.length}`;
    $("moveToForm").hidden = S.viewOrder.length < 3;
    openDialog($("photoSheet"));
  }

  async function saveOrder() {
    if (!orderDirty()) return;
    return once("saveOrder", () => withBusy(async () => {
      try {
        const r = await api("reorder", { gallery: S.gallery, order: S.viewOrder });
        S.photos = r.snapshot?.gallery?.photos || S.photos;
        S.viewOrder = S.photos.map((p) => p.src);
        applySnapshot(r);
        toast("Order saved. Not live until you publish.");
      } catch (err) {
        if (err.code !== "signed_out") showAlert(`Your new order wasn't saved. ${err.message}`, { action: "Try again", onAction: saveOrder });
      }
    }));
  }

  /** Resolves true when it's fine to continue (saved, discarded, or nothing to save). */
  async function guardUnsavedOrder() {
    if (!orderDirty()) return true;
    const choice = await ask({
      title: "Save your new order?",
      body: `You moved photos in ${titleOf(S.gallery)} but haven't saved the new order.`,
      ok: "Save order",
      alt: "Don't save",
      cancel: "Keep editing",
    });
    if (choice === "ok") { await saveOrder(); return !orderDirty(); }
    if (choice === "alt") { S.viewOrder = S.photos.map((p) => p.src); renderGrid(); return true; }
    return false;
  }

  function thumbsNode(srcs, text) {
    const box = document.createElement("div");
    const p = document.createElement("p");
    p.className = "confirm-text";
    p.textContent = text;
    const strip = document.createElement("div");
    strip.className = "confirm-thumbs";
    for (const src of srcs.slice(0, 7)) {
      const ph = photoBySrc(src);
      if (!ph) continue;
      const img = document.createElement("img");
      img.alt = "";
      img.src = ph.url;
      strip.appendChild(img);
    }
    if (srcs.length > 7) {
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = `+${srcs.length - 7}`;
      strip.appendChild(more);
    }
    box.append(strip, p);
    return box;
  }

  async function removePhotos(srcs) {
    if (!srcs.length) return;
    if (!(await guardUnsavedOrder())) return;
    const title = titleOf(S.gallery);
    const newOnes = srcs.filter((s) => photoBySrc(s)?.isNew).length;
    const n = srcs.length;
    let text = n === 1 ? "It stays on your live site until you publish." : "They stay on your live site until you publish.";
    if (newOnes === n) text = n === 1 ? "This photo isn't live yet, so it just won't be added." : "These photos aren't live yet, so they just won't be added.";
    text += " You can undo this.";
    const choice = await ask({
      title: n === 1 ? `Remove this photo from ${title}?` : `Remove ${fmt(n)} photos from ${title}?`,
      body: thumbsNode(srcs, text),
      ok: n === 1 ? "Remove photo" : `Remove ${fmt(n)} photos`,
      danger: true,
    });
    if (choice !== "ok") return;
    await once("remove", () => withBusy(async () => {
      const slug = S.gallery;
      try {
        const r = await api("remove", { gallery: slug, srcs });
        applySnapshot(r);
        exitSelect();
        const removed = r.removed || [];
        for (const x of removed) S.removedAt.set(`${slug}|${x.src}`, { index: x.index, sha: x.sha });
        toast(removed.length === 1 ? "Photo removed. Not live until you publish." : `${fmt(removed.length)} photos removed. Not live until you publish.`, {
          action: "Undo",
          ms: 12000,
          onAction: () => restorePhotos(removed.map(({ src, sha, index, alt }) => ({ src, sha, index, alt })), slug),
        });
      } catch (err) {
        if (err.code !== "signed_out") showAlert(`Nothing was removed. ${err.message}`, { action: "Try again", onAction: () => removePhotos(srcs) });
      }
    }));
  }

  function restoreItem(slug, src) {
    const known = S.removedAt.get(`${slug}|${src}`);
    return known ? { src, index: known.index, sha: known.sha } : { src };
  }

  async function restorePhotos(items, slug = S.gallery) {
    await once("restore", () => withBusy(async () => {
      try {
        const r = await api("restore", { gallery: slug, items });
        applySnapshot(r);
        const n = r.restored?.length || 0;
        if (r.failed?.length) showAlert(`${plural(r.failed.length, "photo")} couldn't be put back. You can upload ${r.failed.length === 1 ? "it" : "them"} again.`, { kind: "warn" });
        if (n) toast(n === 1 ? "Photo put back." : `${fmt(n)} photos put back.`);
      } catch (err) {
        if (err.code !== "signed_out") showAlert(`Couldn't put the photo back. ${err.message}`, { action: "Try again", onAction: () => restorePhotos(items, slug) });
      }
    }));
  }

  // selection
  function enterSelect() {
    if (isBlocked() || orderDirty()) return;
    S.selecting = true;
    S.selected.clear();
    renderGrid();
    announce("Select mode. Tap photos to select them.");
  }
  function exitSelect() {
    if (!S.selecting) return;
    S.selecting = false;
    S.selected.clear();
    renderGrid();
  }

  // ------------------------------------------------------------------ upload
  const isHeic = (file) => /hei[cf]/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");

  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      try { canvas.toBlob((b) => resolve(b), type, quality); } catch { resolve(null); }
    });
  }

  // Resize to <=2000px and encode: WebP when the browser can really make it,
  // otherwise JPEG (Safari). The server re-checks the real bytes either way.
  async function preparePhoto(file) {
    if (file.size > MAX_INPUT_BYTES) throw new Error("This file is too big to be a photo (over 80 MB).");
    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch {
      if (isHeic(file)) throw new Error("This browser can't open iPhone HEIC photos. Add it from Safari on your iPhone, or export it as JPG.");
      throw new Error("This file couldn't be opened as a photo. Please use a JPG.");
    }
    const { img, url } = decoded;
    const canvas = document.createElement("canvas");
    try {
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error("This photo couldn't be read. Please use a JPG.");
      const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
      canvas.width = Math.max(1, Math.round(w0 * scale));
      canvas.height = Math.max(1, Math.round(h0 * scale));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Tiny preview for the upload list (keeps memory low on big batches).
      const t = document.createElement("canvas");
      const ts = 80 / Math.max(canvas.width, canvas.height);
      t.width = Math.max(1, Math.round(canvas.width * ts));
      t.height = Math.max(1, Math.round(canvas.height * ts));
      t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
      const thumb = t.toDataURL("image/jpeg", 0.7);

      let blob = await canvasToBlob(canvas, "image/webp", 0.82);
      if (!blob || blob.type !== "image/webp" || blob.size > TARGET_BYTES) {
        blob = null;
        for (const q of [0.86, 0.76, 0.66, 0.55]) {
          const b = await canvasToBlob(canvas, "image/jpeg", q);
          if (b && b.type === "image/jpeg" && b.size <= TARGET_BYTES) { blob = b; break; }
        }
      }
      if (!blob) throw new Error("This photo couldn't be shrunk for the web. Try exporting it as a JPG.");
      return { blob, thumb };
    } finally {
      canvas.width = 0; canvas.height = 0;
      img.src = "";
      URL.revokeObjectURL(url);
    }
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { wakeLock = null; }
  }

  function startUpload(fileList) {
    const files = [...fileList].filter(Boolean);
    if (!files.length || !S.gallery) return;
    if (S.upload?.active) { toast("Wait for the current photos to finish, then add more."); return; }
    exitSelect();
    const slug = S.gallery;
    const u = {
      slug, title: titleOf(slug), active: true, savedCount: 0, offerCount: 0, saving: null,
      items: files.map((file, i) => ({ id: i, file, name: file.name || `photo-${i + 1}.jpg`, status: "queued", text: "Waiting", kind: "", receipt: null, thumb: null, el: null, rateWaits: 0 })),
    };
    S.upload = u;
    $("uploadPanel").hidden = false;
    $("momentsOffer").hidden = true;
    $("uploadTitle").textContent = `Adding ${plural(files.length, "photo")} to ${u.title}`;
    $("uploadList").replaceChildren(...u.items.map(rowFor));
    renderUploadSummary();
    runUpload(u, u.items);
  }

  function rowFor(it) {
    const li = document.createElement("li");
    const th = document.createElement("img");
    th.className = "thumb";
    th.alt = "";
    const meta = document.createElement("div");
    meta.className = "meta";
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = it.name;
    const st = document.createElement("div");
    st.className = "st";
    meta.append(nm, st);
    li.append(th, meta);
    it.el = { li, th, st };
    paintRow(it);
    return li;
  }

  function paintRow(it) {
    if (!it.el) return;
    it.el.st.textContent = it.text;
    it.el.st.className = "st " + (it.kind || "");
    if (it.thumb && it.el.th.src !== it.thumb) it.el.th.src = it.thumb;
  }

  function setItem(it, status, text, kind = "") {
    it.status = status; it.text = text; it.kind = kind;
    paintRow(it);
    renderUploadSummary();
  }

  function renderUploadSummary() {
    const u = S.upload;
    if (!u) return;
    const c = { saved: 0, dup: 0, failed: 0, retryable: 0, left: 0 };
    for (const it of u.items) {
      if (it.status === "saved") c.saved++;
      else if (it.status === "duplicate") c.dup++;
      else if (it.status === "failed") { c.failed++; if (!it.permanent) c.retryable++; }
      else c.left++;
    }
    const total = u.items.length;
    const bits = [`${fmt(c.saved)} saved`];
    if (c.dup) bits.push(`${fmt(c.dup)} already there`);
    if (c.failed) bits.push(`${fmt(c.failed)} failed`);
    if (c.left) bits.push(`${fmt(c.left)} to go`);
    $("uploadCounts").textContent = bits.join(" · ");
    $("uploadBar").style.width = `${Math.round(((total - c.left) / total) * 100)}%`;
    $("uploadActions").hidden = u.active;
    $("retryFailed").hidden = u.active || !c.retryable;
    const note = $("uploadNote");
    if (u.pausedUntil && u.pausedUntil > Date.now()) {
      note.className = "small warn";
      note.textContent = `Storage asked for a short break. Continuing in ${Math.ceil((u.pausedUntil - Date.now()) / 1000)}s. Nothing was lost.`;
    } else if (u.active) {
      note.className = "small";
      note.textContent = "Keep this page open until photos are saved.";
    } else {
      note.className = "small";
      note.textContent = c.retryable
        ? "Saved photos are safe. Failed ones weren't added. Try them again, or pick them again later."
        : c.failed
          ? "Saved photos are safe. The ones marked in red can't be used as they are (see why below)."
          : c.saved ? "All saved. They go live when you publish." : "";
    }
    refreshControls();
  }

  async function waitRateLimit(u, err) {
    const secs = Math.min(Math.max(Number(err.retryAfterSec) || 30, 5), 90);
    u.pausedUntil = Date.now() + secs * 1000;
    const tick = setInterval(renderUploadSummary, 1000);
    await sleep(secs * 1000);
    clearInterval(tick);
    u.pausedUntil = 0;
    renderUploadSummary();
  }

  async function runUpload(u, items) {
    u.active = true;
    keepAwake(true);
    renderUploadSummary();
    const prepared = [];   // { it, blob }
    let prepIndex = 0;
    let preparing = false;
    let sending = 0;
    const sent = [];       // items waiting to be saved

    const save = async (force) => {
      while (sent.length && (force || sent.length >= SAVE_EVERY)) {
        if (u.saving) { await u.saving; continue; }
        const chunk = sent.splice(0, Math.min(sent.length, 50));
        u.saving = saveChunk(u, chunk).finally(() => { u.saving = null; });
        await u.saving;
      }
    };

    await new Promise((resolveAll) => {
      const pump = () => {
        // Prepare ONE photo at a time (big camera files use lots of memory), and
        // never hold more than 2 prepared photos waiting to send.
        if (!preparing && prepIndex < items.length && prepared.length + sending < SEND_CONCURRENCY + 1) {
          const it = items[prepIndex++];
          preparing = true;
          setItem(it, "preparing", "Preparing…");
          preparePhoto(it.file).then(({ blob, thumb }) => {
            it.thumb = thumb;
            prepared.push({ it, blob });
            setItem(it, "ready", "Ready to send");
          }).catch((err) => {
            it.permanent = true; // this file can't be used as-is; retrying won't help
            setItem(it, "failed", err.message || "Couldn't prepare this photo.", "err");
          }).finally(() => { preparing = false; pump(); });
        }
        while (sending < SEND_CONCURRENCY && prepared.length) {
          const { it, blob } = prepared.shift();
          sending++;
          sendOne(u, it, blob).then((okSent) => {
            if (okSent) sent.push(it);
          }).finally(() => {
            sending--;
            save(false).finally(pump);
          });
        }
        if (!preparing && prepIndex >= items.length && !prepared.length && sending === 0) resolveAll();
      };
      pump();
    });

    await save(true);
    u.active = false;
    keepAwake(false);
    renderUploadSummary();
    finishBatch(u);
  }

  async function sendOne(u, it, blob) {
    for (;;) {
      try {
        setItem(it, "sending", "Sending…");
        const r = await api("upload", null, { raw: blob, headers: { "content-type": blob.type, "x-file-name": encodeURIComponent(it.name) } });
        it.receipt = r.receipt;
        setItem(it, "sent", "Sent, saving…");
        return true;
      } catch (err) {
        if (err.code === "rate_limited" && it.rateWaits < 4) { it.rateWaits++; await waitRateLimit(u, err); continue; }
        it.permanent = err.status === 422;
        setItem(it, "failed", err.code === "offline" ? "No connection. Try again when you're back online." : err.message, "err");
        return false;
      }
    }
  }

  async function saveChunk(u, chunk) {
    for (let tries = 0; ; tries++) {
      try {
        const r = await api("add", { gallery: u.slug, files: chunk.map((i) => i.receipt) });
        const added = new Set((r.added || []).map((a) => a.sha));
        for (const it of chunk) {
          if (added.has(it.receipt.sha)) { setItem(it, "saved", "Saved ✓ · not live yet", "ok"); u.savedCount++; }
          else setItem(it, "duplicate", "Already in this gallery, skipped", "warn");
        }
        u.offerCount += added.size;
        applySnapshot(r);
        return;
      } catch (err) {
        if (err.code === "rate_limited" && tries < 4) { await waitRateLimit(u, err); continue; }
        if ((err.code === "offline" || err.status >= 500) && tries < 2) { await sleep(2500 * (tries + 1)); continue; }
        for (const it of chunk) setItem(it, "failed", "Sent but not saved. Tap “Try failed photos again”.", "err");
        showAlert(`Some photos weren't saved to ${u.title}. ${err.message}`, { kind: "warn" });
        return;
      }
    }
  }

  function finishBatch(u) {
    const failed = u.items.filter((i) => i.status === "failed").length;
    if (u.offerCount > 0) {
      $("offerCount").textContent = fmt(u.offerCount);
      $("offerCheck").checked = false;
      $("offerBtn").disabled = true;
      $("momentsOffer").hidden = false;
    }
    if (u.savedCount) {
      toast(`${plural(u.savedCount, "photo")} saved to ${u.title}.${failed ? ` ${fmt(failed)} failed.` : ""} Not live until you publish.`, { ms: 7000 });
    } else if (failed) {
      announce("No photos were added. See the reasons in the list.");
    }
  }

  // ------------------------------------------------------------------ Moments Captured
  async function momentsAdd(prefill) {
    if (isBlocked()) return;
    return once("moments", async () => {
      const current = S.state.stats.draft;
      let amount = prefill;
      if (amount == null) {
        amount = await askNumber({
          title: "Add photos taken",
          help: `How many photos did you take? Added to your total of ${fmt(current)}.`,
          okLabel: (n) => `Add ${fmt(n)}`,
          validate: (n) => (n >= 1 && n <= 1000000
            ? { ok: true, preview: `${fmt(current)} → ${fmt(current + n)}` }
            : { ok: false, preview: "Enter a number from 1 to 1,000,000" }),
        });
      }
      if (amount == null) return;
      await withBusy(async () => {
        try {
          const r = await api("moments-add", { amount });
          applySnapshot(r);
          toast(`Moments Captured is now ${fmt(r.after)}. Not live until you publish.`);
        } catch (err) {
          if (err.code !== "signed_out") showAlert(`Moments Captured wasn't changed. ${err.message}`, { action: "Try again", onAction: () => momentsAdd(amount) });
        }
      });
    });
  }

  async function momentsSet() {
    if (isBlocked()) return;
    return once("moments", async () => {
      const current = S.state.stats.draft;
      const value = await askNumber({
        title: "Set exact total",
        help: `Replaces your total of ${fmt(current)}. Use this only to correct it.`,
        okLabel: (n) => `Set to ${fmt(n)}`,
        validate: (n) => {
          if (n > 100000000) return { ok: false, preview: "That number is too large" };
          if (n === current) return { ok: false, preview: "That's already your total" };
          const diff = n - current;
          return { ok: true, preview: `${fmt(current)} → ${fmt(n)} (${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff))})` };
        },
        confirmText: (n) => (n < current ? `Yes, lower my total by ${fmt(current - n)}` : `Yes, set my total to ${fmt(n)}`),
      });
      if (value == null) return;
      await withBusy(async () => {
        try {
          const r = await api("moments-set", { value, expected: current });
          applySnapshot(r);
          toast(`Moments Captured set to ${fmt(r.after)}. Not live until you publish.`);
        } catch (err) {
          if (err.code === "stale_total") refreshState({ quiet: true }).catch(() => {});
          if (err.code !== "signed_out") showAlert(`Moments Captured wasn't changed. ${err.message}`);
        }
      });
    });
  }

  // ------------------------------------------------------------------ milestones
  function crossed(from, to, milestones) {
    return [...milestones].reverse().find((m) => from < m && to >= m) || null;
  }

  function celebrate(m) {
    const done = store.get(CELEBRATED_KEY) || [];
    if (done.includes(m)) return;
    store.set(CELEBRATED_KEY, [...done, m]);

    // Same editorial reveal the portfolio uses for its own headlines: the number
    // and its label rise out of a masked line, and the number counts up to the
    // milestone. Title text stays one sentence for screen readers.
    const title = $("celebrateTitle");
    const numLine = document.createElement("span");
    numLine.className = "ms-line";
    const num = document.createElement("span");
    num.className = "ms-num";
    num.textContent = fmt(m);
    numLine.appendChild(num);
    const labLine = document.createElement("span");
    labLine.className = "ms-line";
    const lab = document.createElement("span");
    lab.className = "ms-lab";
    lab.textContent = "moments captured.";
    labLine.appendChild(lab);
    title.replaceChildren(numLine, document.createTextNode(" "), labLine);
    $("celebrateText").textContent = "Now live on jcwrks.com.";

    const card = $("celebrate");
    card.hidden = false;
    card.classList.remove("play");
    void card.offsetWidth;
    card.classList.add("play");
    countUp(num, m);
    announce(`Milestone: ${fmt(m)} moments captured.`);
  }

  /** Count a number up into place (the portfolio's footer counter, same feel). */
  function countUp(el, to) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = fmt(to); return; }
    const from = Math.max(0, to - Math.max(250, Math.round(to * 0.01)));
    const start = performance.now();
    const dur = 1500;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(from + (to - from) * eased));
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(to);
    };
    requestAnimationFrame(tick);
  }

  function checkMilestoneOnLoad() {
    const st = S.state;
    if (!st) return;
    const seen = store.get(SEEN_KEY);
    if (typeof seen === "number") {
      const m = crossed(seen, st.stats.live, st.milestones || []);
      if (m) celebrate(m);
    }
    store.set(SEEN_KEY, st.stats.live);
  }

  // ------------------------------------------------------------------ publish
  function setPublishUI(phase, { title, detail, kind = "", check = false, retry = false, dismiss = false } = {}) {
    S.publishPhase = phase;
    const box = $("publishStatus");
    box.hidden = !phase;
    if (phase) {
      box.className = "publish-status" + (kind ? " " + kind : "");
      $("pubTitle").textContent = title || "";
      $("pubDetail").textContent = detail || "";
      $("pubSpinner").hidden = !["preparing", "publishing", "updating", "verifying", "slow"].includes(phase);
      $("pubCheck").hidden = !check;
      $("pubRetry").hidden = !retry;
      $("pubDismiss").hidden = !dismiss;
      const steps = { preparing: ["active"], publishing: ["done", "active"], updating: ["done", "active"], slow: ["done", "active"], stuck: ["done", "failed"], verifying: ["done", "done", "active"], mismatch: ["done", "done", "failed"], done: ["done", "done", "done"], failed: ["failed"] }[phase] || [];
      [...$("pubSteps").children].forEach((li, i) => { li.className = steps[i] || ""; });
      $("pubSteps").hidden = phase === "failed" && !S.publish;
      announce(title);
    }
    if (S.state && S.view === "home") renderReview();
    refreshControls();
  }

  function savePublish(p) {
    S.publish = p;
    store.set(PUBLISH_KEY, p);
  }

  async function publish() {
    if (isBlocked()) return;
    return once("publish", async () => {
      if (S.view === "gallery" && !(await guardUnsavedOrder())) return;
      if (S.view !== "home") { location.hash = "#/"; await sleep(50); }
      setPublishUI("preparing", { title: "Preparing update…", detail: "Checking your latest changes." });
      let st;
      try {
        st = await refreshState({ quiet: true });
      } catch (err) {
        setPublishUI("failed", { title: "Couldn't get ready to publish", detail: `${err.message} Your changes are still saved.`, kind: "err", retry: true });
        return;
      }
      if (!st.changes.hasChanges) {
        setPublishUI(null);
        toast("Everything is already live.");
        return;
      }
      const choice = await ask({ title: "Ready to publish", body: reviewNode(), ok: "Publish changes" });
      if (choice !== "ok") { setPublishUI(null); return; }

      setPublishUI("publishing", { title: "Updating website…", detail: "Sending your changes." });
      const expect = {
        galleries: st.changes.galleries.filter((g) => !g.housekeeping).map((g) => ({ slug: g.slug, title: g.title, count: g.draftCount })),
        moments: st.stats.draft !== st.stats.live ? st.stats.draft : null,
        fromMoments: st.stats.live,
      };
      try {
        const r = await withBusy(() => api("publish", { draftSha: st.draftSha }));
        if (r.nothingToPublish) { setPublishUI(null); toast("Everything is already live."); return; }
        applySnapshot(r);
        savePublish({ sha: r.productionSha, startedAt: Date.now(), expect });
        pollPublish();
      } catch (err) {
        if (err.code === "stale_draft") {
          await refreshState({ quiet: true }).catch(() => {});
          setPublishUI("failed", { title: "Your changes were updated", detail: "Something changed (maybe on another device). Look over the list again, then publish.", kind: "warn", dismiss: true });
        } else if (err.code !== "signed_out") {
          setPublishUI("failed", { title: "Publish didn't go through", detail: `Your changes are still saved. Nothing was lost. ${err.code === "offline" ? "Check your connection, then try again." : ""}`, kind: "err", retry: true });
        }
      }
    });
  }

  function stopPolling() { clearTimeout(S.pollTimer); S.pollTimer = null; }

  async function pollPublish() {
    stopPolling();
    const p = S.publish;
    if (!p) return;
    const elapsed = Date.now() - p.startedAt;
    let live = false;
    try {
      const r = await api("publish-status", { productionSha: p.sha });
      live = r.live;
    } catch (err) {
      if (err.code === "signed_out") return;
    }
    if (S.publish !== p) return;
    if (live) return verifyLive(p);
    if (elapsed < SLOW_MS) {
      setPublishUI("updating", { title: "Updating website…", detail: "Your changes are saved. This usually takes about a minute." });
    } else if (elapsed < STUCK_MS) {
      setPublishUI("slow", { title: "Still updating…", detail: "Taking longer than usual. Your changes are saved, nothing was lost.", kind: "warn", check: true });
    } else {
      setPublishUI("stuck", { title: "Your website hasn't updated yet", detail: "Your changes are saved and nothing was lost. Tap Try again to restart the update.", kind: "warn", check: true, retry: true });
      return; // stop auto-polling; buttons take over
    }
    S.pollTimer = setTimeout(pollPublish, POLL_MS);
  }

  /** The build says the new version is live; confirm the pages really show it. */
  async function verifyLive(p) {
    setPublishUI("verifying", { title: "Verifying live site…", detail: "Checking your pages." });
    const exp = p.expect || { galleries: [] };
    let problems = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      problems = [];
      const bust = `?v=${Date.now()}`;
      await Promise.all([
        ...exp.galleries.map(async (g) => {
          try {
            const html = await (await fetch(galleryPath(g.slug) + bust, { cache: "no-store" })).text();
            const n = (html.match(/data-src="/g) || []).length;
            if (n !== g.count) problems.push(g.title);
          } catch { problems.push(g.title); }
        }),
        (async () => {
          if (!exp.moments) return;
          try {
            const html = await (await fetch("/" + bust, { cache: "no-store" })).text();
            if (!html.includes(`data-to="${exp.moments}"`)) problems.push("Moments Captured");
          } catch { problems.push("Moments Captured"); }
        })(),
      ]);
      if (!problems.length || S.publish !== p) break;
      await sleep(3000);
    }
    if (S.publish !== p) return;
    if (problems.length) {
      setPublishUI("mismatch", { title: "Your site updated, but something doesn't match yet", detail: `Still checking: ${problems.join(", ")}. Your changes are saved. Tap Check again in a minute.`, kind: "warn", check: true });
      return;
    }
    savePublish(null);
    setPublishUI("done", { title: "Published ✓", detail: "Your portfolio is live.", kind: "ok", dismiss: true });
    toast("Published ✓ Your portfolio is live.", { ms: 6000 });
    await refreshState({ quiet: true }).catch(() => {});
    if (S.gallery && S.view === "gallery") api("gallery", { gallery: S.gallery }).then(setGallery).catch(() => {});
    if (exp.moments != null) {
      const m = crossed(exp.fromMoments, exp.moments, S.state?.milestones || []);
      if (m) celebrate(m);
      store.set(SEEN_KEY, exp.moments);
    }
  }

  async function retryPublish() {
    return once("retryPublish", async () => {
      if (S.publishPhase === "failed" && !S.publish) return publish();
      try {
        const r = await withBusy(() => api("retry-publish"));
        if (r.alreadyLive) return verifyLive(S.publish || { sha: r.productionSha, startedAt: Date.now(), expect: null });
        savePublish({ ...(S.publish || {}), sha: r.productionSha, startedAt: Date.now() });
        pollPublish();
      } catch (err) {
        setPublishUI("stuck", { title: err.code === "too_soon" ? "Still updating…" : "Your website hasn't updated yet", detail: `${err.message} Your changes are saved.`, kind: "warn", check: true, retry: err.code !== "too_soon" });
      }
    });
  }

  async function discardAll() {
    if (isBlocked()) return;
    return once("discard", async () => {
      if (S.view === "gallery" && !(await guardUnsavedOrder())) return;
      const choice = await ask({
        title: "Throw away all unpublished changes?",
        body: "New photos that aren't live will be removed, removed photos come back, and Moments Captured goes back to what's on your site. This can't be undone.",
        ok: "Throw away changes",
        danger: true,
        checkText: "Yes, throw away my unpublished changes",
      });
      if (choice !== "ok") return;
      await withBusy(async () => {
        try {
          const r = await api("discard", { gallery: S.gallery || undefined });
          applySnapshot(r);
          toast("Unpublished changes thrown away. Everything matches your live site.");
        } catch (err) {
          if (err.code !== "signed_out") showAlert(`Nothing was thrown away. ${err.message}`);
        }
      });
    });
  }

  // ------------------------------------------------------------------ controls & status
  const isBlocked = () => S.busy > 0 || !!S.upload?.active;

  function refreshControls() {
    if (!S.state) return;
    const dirty = S.view === "gallery" && orderDirty();
    const blocked = isBlocked();
    const publishing = ["preparing", "publishing", "updating", "verifying", "slow"].includes(S.publishPhase);

    // gallery
    $("orderBar").hidden = !dirty || S.selecting;
    $("saveOrder").disabled = blocked;
    $("undoOrder").disabled = blocked;
    $("addBtn").disabled = blocked || dirty || S.selecting;
    $("selectBtn").disabled = blocked || dirty || (!S.selecting && S.photos.length === 0);
    $("selectBtn").textContent = S.selecting ? "Done" : "Select";
    $("selectBtn").setAttribute("aria-pressed", S.selecting ? "true" : "false");
    $("selectBar").hidden = !(S.view === "gallery" && S.selecting);
    $("selectCount").textContent = `${fmt(S.selected.size)} selected`;
    $("selectRemove").disabled = blocked || !S.selected.size;
    $("selectRemove").textContent = S.selected.size ? `Remove ${fmt(S.selected.size)}` : "Remove";
    $("selectAll").disabled = blocked;
    $("grid").classList.toggle("locked", blocked);
    if (S.sortable) S.sortable.option("disabled", S.selecting || blocked);

    // home
    $("mcAddBtn").disabled = blocked;
    $("mcSetBtn").disabled = blocked;
    $("publishBtn").disabled = blocked || publishing;
    $("publishBtn").textContent = S.upload?.active ? "Wait for photos to finish…" : publishing ? "Publishing…" : "Publish changes";
    $("discardBtn").disabled = blocked || publishing;

    renderPill(dirty, publishing);
    layoutDock();
  }

  function renderPill(dirty, publishing) {
    const pill = $("statusPill");
    let text, cls = "";
    const u = S.upload;
    if (u?.active) {
      const done = u.items.filter((i) => ["saved", "duplicate", "failed"].includes(i.status)).length;
      text = `Uploading ${fmt(Math.min(done + 1, u.items.length))} of ${fmt(u.items.length)}…`; cls = "busy";
    } else if (S.busy > 0) {
      text = "Saving…"; cls = "busy";
    } else if (publishing) {
      text = S.publishPhase === "verifying" ? "Verifying live site…" : S.publishPhase === "preparing" ? "Preparing…" : "Updating website…"; cls = "busy";
    } else if (S.publishPhase === "stuck" || S.publishPhase === "mismatch") {
      text = "Website not updated yet"; cls = "warn";
    } else if (S.publishPhase === "done" && !S.state.changes.hasChanges) {
      text = "Published ✓"; cls = "done";
    } else if (dirty) {
      text = "Order not saved"; cls = "warn";
    } else if (S.state.changes.hasChanges) {
      text = "Not published yet · Review"; cls = "pending";
    } else {
      text = "All changes live"; cls = "";
    }
    pill.className = "pill" + (cls ? " " + cls : "");
    $("statusText").textContent = text;
    pill.setAttribute("aria-label", `Status: ${text}. Go to publish.`);
  }

  // ------------------------------------------------------------------ boot
  async function enterApp() {
    showOnly("loadingView");
    try {
      await refreshState({ quiet: true });
    } catch (err) {
      if (err.code === "signed_out") return;
      showOnly("homeView");
      showAlert(`Couldn't load your portfolio. ${err.message}`, { action: "Try again", onAction: enterApp });
      return;
    }
    await openRoute(route());
    S.publish = store.get(PUBLISH_KEY);
    if (S.publish && S.publish.sha) {
      pollPublish();
    } else if (S.deploy && S.deploy.liveCommit && !S.deploy.live) {
      // Published from another device (or the site is rebuilding) and not live yet.
      savePublish({ sha: S.deploy.productionSha, startedAt: Date.now() - 60000, expect: null });
      pollPublish();
    }
  }

  function wire() {
    $("loginForm").addEventListener("submit", (e) => {
      e.preventDefault();
      once("login", async () => {
        const password = $("pw").value;
        if (!password) { $("loginMsg").textContent = "Enter your password."; return; }
        $("loginBtn").disabled = true;
        $("loginMsg").textContent = "";
        try {
          const r = await api("login", { password });
          saveSession(r.token, r.expires);
          $("pw").value = "";
          await enterApp();
        } catch (err) {
          $("loginMsg").textContent = err.message;
        } finally {
          $("loginBtn").disabled = false;
        }
      });
    });

    $("signOut").onclick = async () => {
      if (S.upload?.active) { toast("Photos are still uploading. Sign out when they're saved."); return; }
      if (S.view === "gallery" && !(await guardUnsavedOrder())) return;
      clearSession();
      savePublish(null);
      S.state = null;
      showLogin();
    };
    $("statusPill").onclick = async () => {
      if (S.view !== "home") {
        location.hash = "#/";
        await sleep(80);
      }
      if (S.view === "home") { $("publishCard").scrollIntoView({ behavior: "smooth", block: "start" }); $("publishCard").focus({ preventScroll: true }); }
    };
    window.addEventListener("hashchange", onHashChange);

    // gallery
    $("addBtn").onclick = () => $("fileInput").click();
    $("fileInput").addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length) startUpload(files);
      e.target.value = "";
    });
    const card = $("photosCard");
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    card.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; card.classList.add("dragging"); });
    card.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    card.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) card.classList.remove("dragging"); });
    card.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      card.classList.remove("dragging");
      if ($("addBtn").disabled) { toast("Finish what you're doing first, then drop the photos again."); return; }
      startUpload(e.dataTransfer.files);
    });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });

    $("retryFailed").onclick = () => {
      const u = S.upload;
      if (!u || u.active) return;
      const failed = u.items.filter((i) => i.status === "failed" && !i.permanent);
      if (!failed.length) return;
      for (const it of failed) { it.receipt = null; setItem(it, "queued", "Waiting"); }
      $("momentsOffer").hidden = true;
      u.offerCount = 0;
      runUpload(u, failed);
    };
    $("closeUpload").onclick = () => {
      if (S.upload?.active) return;
      S.upload = null;
      $("uploadPanel").hidden = true;
      $("uploadList").replaceChildren();
      refreshControls();
    };
    $("offerCheck").onchange = () => { $("offerBtn").disabled = !$("offerCheck").checked; };
    $("offerBtn").onclick = async () => {
      const n = S.upload?.offerCount || 0;
      if (!n || !$("offerCheck").checked) return;
      $("momentsOffer").hidden = true;
      S.upload.offerCount = 0;
      await momentsAdd(n);
    };

    $("saveOrder").onclick = saveOrder;
    $("undoOrder").onclick = () => { S.viewOrder = S.photos.map((p) => p.src); renderGrid(); announce("Order change undone."); };
    $("selectBtn").onclick = () => (S.selecting ? exitSelect() : enterSelect());
    $("selectAll").onclick = () => { S.photos.forEach((p) => S.selected.add(p.src)); renderGrid(); };
    $("selectClear").onclick = () => { S.selected.clear(); renderGrid(); };
    $("selectRemove").onclick = () => removePhotos(S.viewOrder.filter((s) => S.selected.has(s)));

    for (const b of document.querySelectorAll("[data-move]")) {
      b.onclick = () => {
        const src = sheetSrc;
        closeDialog($("photoSheet"));
        const at = S.viewOrder.indexOf(src);
        const to = { first: 0, last: S.viewOrder.length - 1, up: at - 1, down: at + 1 }[b.dataset.move];
        moveInView(src, to);
      };
    }
    $("moveToForm").onsubmit = (e) => {
      e.preventDefault();
      const n = parseWhole($("moveToInput").value);
      if (!n || n < 1 || n > S.viewOrder.length) { $("moveToInput").focus(); return; }
      const src = sheetSrc;
      closeDialog($("photoSheet"));
      moveInView(src, n - 1);
    };
    $("sheetRemove").onclick = () => { const src = sheetSrc; closeDialog($("photoSheet")); removePhotos([src]); };
    $("sheetClose").onclick = () => closeDialog($("photoSheet"));
    $("photoSheet").addEventListener("click", (e) => { if (e.target === $("photoSheet")) closeDialog($("photoSheet")); });

    // home
    $("mcAddBtn").onclick = () => momentsAdd();
    $("mcSetBtn").onclick = momentsSet;
    $("publishBtn").onclick = publish;
    $("discardBtn").onclick = discardAll;
    $("pubCheck").onclick = () => {
      if (!S.publish) return;
      if (S.publishPhase === "mismatch") return verifyLive(S.publish);
      pollPublish();
    };
    $("pubRetry").onclick = () => (S.publish ? retryPublish() : publish());
    $("pubDismiss").onclick = () => setPublishUI(null);
    $("alertClose").onclick = hideAlert;
    $("celebrateClose").onclick = () => { $("celebrate").hidden = true; };

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.selecting && !document.querySelector("dialog[open]")) exitSelect();
    });

    // Coming back to the tab (or the app on iPhone): quietly catch up with other devices.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !S.token || !S.state) return;
      if (isBlocked() || (S.view === "gallery" && orderDirty()) || document.querySelector("dialog[open]")) return;
      if (Date.now() - S.lastRefresh < REFRESH_ON_FOCUS_MS) return;
      refreshState({ quiet: true }).then(() => {
        if (S.view === "gallery" && S.gallery && !orderDirty() && !S.selecting) return api("gallery", { gallery: S.gallery }).then(setGallery);
      }).catch(() => {});
      if (S.publish && !S.pollTimer && S.publishPhase !== "stuck") pollPublish();
    });

    window.addEventListener("beforeunload", (e) => {
      if (S.upload?.active || (S.view === "gallery" && orderDirty()) || S.busy > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    window.addEventListener("resize", layoutDock);
  }

  /** The portfolio's nav behaviour: transparent at the top, frosted once you scroll. */
  function wireChrome() {
    const nav = document.querySelector("[data-nav]");
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // Sections rise in on first paint, like the portfolio's hero. They are revealed
    // immediately (with a small stagger), never parked invisible waiting to be
    // scrolled into view: everything below the fold must already be there.
    const reveal = () => {
      const els = document.querySelectorAll("[data-reveal]:not(.is-in)");
      if (!els.length) return;
      requestAnimationFrame(() => els.forEach((el) => el.classList.add("is-in")));
    };
    reveal();
    S.reveal = reveal;
  }

  wireChrome();
  wire();
  S.token = loadSession();
  if (S.token) enterApp(); else showLogin();
})();
