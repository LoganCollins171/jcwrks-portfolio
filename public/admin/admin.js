// jc_wrks Portfolio Manager (jcwrks.com/admin).
// Talks to /api/admin (netlify/functions/admin.mjs). Plain JS, no build step.
(() => {
  "use strict";

  const API = "/api/admin";
  const SESSION_KEY = "jcwrks_admin_session";
  const PUBLISH_KEY = "jcwrks_admin_publish";
  const MAX_EDGE = 2000;
  const TARGET_BYTES = 2.5 * 1024 * 1024;
  const MAX_INPUT_BYTES = 80 * 1024 * 1024;
  const UPLOAD_CONCURRENCY = 2;
  const POLL_MS = 5000;
  const SLOW_MS = 4 * 60 * 1000;
  const RETRY_OFFER_MS = 6 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? "" : "s"}`;

  const S = {
    token: null,
    state: null,        // last /state response
    gallery: null,      // slug
    photos: [],         // saved draft order
    viewOrder: [],      // what's on screen (may be unsaved)
    busy: 0,            // operations in flight
    uploading: false,
    upload: null,       // current batch
    sortable: null,
    publish: null,      // { sha, startedAt }
    pollTimer: null,
    urlBySha: new Map(),
    knownDraft: null,
    knownProd: null,
  };

  // ---------------------------------------------------------------- session

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (s && s.token && s.expires > Date.now()) return s.token;
    } catch {}
    return null;
  }
  function saveSession(token, expires) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token, expires })); } catch {}
  }
  function clearSession() {
    S.token = null;
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  // ---------------------------------------------------------------- api

  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  async function api(op, body, { raw, headers = {}, retryBusy = true } = {}) {
    const init = { method: "POST", headers: { ...headers } };
    if (S.token) init.headers.authorization = `Bearer ${S.token}`;
    if (S.knownDraft) init.headers["x-known-draft"] = S.knownDraft;
    if (S.knownProd) init.headers["x-known-prod"] = S.knownProd;
    if (raw) { init.body = raw; }
    else { init.body = JSON.stringify(body || {}); init.headers["content-type"] = "application/json"; }

    let res;
    try {
      res = await fetch(`${API}?op=${encodeURIComponent(op)}`, init);
    } catch {
      throw new ApiError(0, "offline", "Couldn't connect. Check your internet connection and try again.");
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok && data && data.ok) {
      // Remember the newest versions we've seen so a lagging read can't show older state.
      if (data.draftSha) S.knownDraft = data.draftSha;
      if (data.productionSha) S.knownProd = data.productionSha;
      return data;
    }

    const code = data?.error?.code || `http_${res.status}`;
    let message = data?.error?.message;
    if (!message) {
      message = res.status === 413
        ? "That photo was too large to send. Please try again."
        : "Something went wrong. Nothing was lost. Please try again.";
    }
    if (code === "signed_out") { clearSession(); showLogin("You've been signed out. Please sign in again."); }
    if (code === "busy" && retryBusy) {
      await new Promise((r) => setTimeout(r, 900));
      return api(op, body, { raw, headers, retryBusy: false });
    }
    throw new ApiError(res.status, code, message);
  }

  async function withBusy(fn) {
    S.busy++;
    refreshControls();
    try { return await fn(); }
    finally { S.busy--; refreshControls(); }
  }

  // ---------------------------------------------------------------- views

  function show(view) {
    for (const id of ["loginView", "loadingView", "appView"]) $(id).hidden = id !== view;
    $("signOut").hidden = view !== "appView";
  }

  function showLogin(message) {
    stopPolling();
    show("loginView");
    $("loginMsg").textContent = message || "";
    $("pw").value = "";
    setTimeout(() => $("pw").focus(), 50);
  }

  let bannerTimer;
  function banner(message, kind = "ok", sticky = false) {
    const b = $("banner");
    b.textContent = message;
    b.className = "banner" + (kind === "err" ? " err" : "");
    b.hidden = false;
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = setTimeout(() => { b.hidden = true; }, kind === "err" ? 12000 : 6000);
    if (kind === "err") b.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---------------------------------------------------------------- dialogs

  function openDialog(d) {
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeDialog(d) {
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  function confirmBox({ title, text, ok = "OK", danger = false, image, checkText }) {
    return new Promise((resolve) => {
      const d = $("confirmDialog");
      $("confirmTitle").textContent = title;
      $("confirmText").textContent = text || "";
      const img = $("confirmImg");
      img.hidden = !image;
      if (image) img.src = image;
      const okBtn = $("confirmOk");
      okBtn.textContent = ok;
      okBtn.className = "btn " + (danger ? "danger solid" : "primary");
      const wrap = $("confirmCheckWrap");
      const check = $("confirmCheck");
      wrap.hidden = !checkText;
      check.checked = false;
      $("confirmCheckText").textContent = checkText || "";
      okBtn.disabled = !!checkText;
      check.onchange = () => { okBtn.disabled = !check.checked; };
      const done = (v) => { closeDialog(d); okBtn.onclick = null; $("confirmCancel").onclick = null; d.oncancel = null; resolve(v); };
      okBtn.onclick = () => done(true);
      $("confirmCancel").onclick = () => done(false);
      d.oncancel = (e) => { e.preventDefault(); done(false); };
      openDialog(d);
    });
  }

  function parseWhole(text) {
    const t = String(text || "").replace(/[,\s]/g, "").replace(/^\+/, "");
    if (!/^\d{1,9}$/.test(t)) return null;
    return Number(t);
  }

  // ---------------------------------------------------------------- state

  async function loadState() {
    const s = await api("state");
    S.state = s;
    renderGalleries();
    renderMoments();
    renderChanges();
    return s;
  }

  function renderGalleries() {
    const sel = $("gallery");
    const current = S.gallery || sel.value || "basketball";
    const groups = { Sports: ["basketball", "football", "soccer", "baseball", "softball", "hockey", "track"], Other: ["portraits", "landscape", "cars", "graphics"] };
    const bySlug = new Map(S.state.galleries.map((g) => [g.slug, g]));
    sel.innerHTML = "";
    for (const [label, slugs] of Object.entries(groups)) {
      const og = document.createElement("optgroup");
      og.label = label;
      for (const slug of slugs) {
        const g = bySlug.get(slug);
        if (!g) continue;
        const o = document.createElement("option");
        o.value = slug;
        o.textContent = `${g.title} (${g.count})`;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = current;
  }

  function renderMoments() {
    const { live, draft } = S.state.stats;
    $("momentsValue").textContent = fmt(draft);
    $("momentsLive").textContent = draft !== live ? `On your site now: ${fmt(live)} (updates when you publish)` : "";
  }

  function renderChanges() {
    const c = S.state.changes;
    $("changesNone").hidden = c.hasChanges;
    $("changesSome").hidden = !c.hasChanges;
    const list = $("changesList");
    list.innerHTML = "";
    for (const line of c.lines) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }
    const removed = $("removedList");
    removed.innerHTML = "";
    for (const g of c.galleries) {
      for (const p of g.removedPhotos || []) {
        const row = document.createElement("div");
        row.className = "removed-row";
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.src = p.url;
        img.onerror = () => { if (img.src !== p.fallbackUrl) img.src = p.fallbackUrl; };
        const label = document.createElement("span");
        label.textContent = `Removed from ${g.title}`;
        const btn = document.createElement("button");
        btn.className = "btn small";
        btn.type = "button";
        btn.textContent = "Undo";
        btn.onclick = () => restorePhoto(g.slug, p.src);
        row.append(img, label, btn);
        removed.appendChild(row);
      }
    }
    refreshControls();
  }

  // ---------------------------------------------------------------- gallery

  async function loadGallery(slug) {
    S.gallery = slug;
    const g = await api("gallery", { gallery: slug });
    if (S.gallery !== slug) return; // switched away meanwhile
    S.photos = g.photos;
    S.viewOrder = g.photos.map((p) => p.src);
    renderGrid();
  }

  function photoBySrc(src) { return S.photos.find((p) => p.src === src); }

  function orderDirty() {
    const saved = S.photos.map((p) => p.src);
    return saved.length !== S.viewOrder.length || saved.some((s, i) => s !== S.viewOrder[i]);
  }

  function renderGrid() {
    const grid = $("grid");
    grid.innerHTML = "";
    S.viewOrder.forEach((src, i) => {
      const p = photoBySrc(src);
      if (!p) return;
      const tile = document.createElement("div");
      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.className = "tile";
      tile.dataset.src = src;
      tile.setAttribute("aria-label", `Photo ${i + 1}: ${p.name}`);
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = S.urlBySha.get(p.sha) || p.url;
      img.onerror = () => {
        if (img.src !== p.fallbackUrl) img.src = p.fallbackUrl;
        else tile.classList.add("broken");
      };
      img.onload = () => { if (p.sha && !S.urlBySha.has(p.sha)) S.urlBySha.set(p.sha, img.src); };
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = i + 1;
      tile.append(img, num);
      if (p.isNew) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Not live yet";
        tile.appendChild(badge);
      }
      tile.addEventListener("click", () => openSheet(src));
      tile.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(src); } });
      grid.appendChild(tile);
    });
    $("emptyGallery").hidden = S.viewOrder.length > 0;
    $("reorderHint").hidden = S.viewOrder.length < 2;
    $("photoCount").textContent = S.viewOrder.length ? plural(S.viewOrder.length, "photo") : "";
    setupSortable();
    refreshControls();
  }

  function renumber() {
    [...$("grid").children].forEach((tile, i) => {
      const n = tile.querySelector(".num");
      if (n) n.textContent = i + 1;
    });
  }

  function setupSortable() {
    if (S.sortable) { S.sortable.destroy(); S.sortable = null; }
    if (typeof Sortable === "undefined") return; // arrows in the photo menu still work
    S.sortable = Sortable.create($("grid"), {
      animation: 160,
      delay: 220,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      ghostClass: "ghost",
      chosenClass: "chosen",
      forceFallback: false,
      onEnd: () => {
        S.viewOrder = [...$("grid").children].map((t) => t.dataset.src);
        renumber();
        refreshControls();
      },
    });
  }

  function moveInView(src, where) {
    const order = S.viewOrder.filter((s) => s !== src);
    const at = S.viewOrder.indexOf(src);
    let to = at;
    if (where === "first") to = 0;
    if (where === "last") to = order.length;
    if (where === "up") to = Math.max(0, at - 1);
    if (where === "down") to = Math.min(order.length, at + 1);
    order.splice(to, 0, src);
    S.viewOrder = order;
    renderGrid();
  }

  // photo options sheet
  let sheetSrc = null;
  function openSheet(src) {
    if (S.busy || S.uploading) return;
    const p = photoBySrc(src);
    if (!p) return;
    sheetSrc = src;
    const img = $("sheetImg");
    img.src = S.urlBySha.get(p.sha) || p.url;
    img.onerror = () => { if (img.src !== p.fallbackUrl) img.src = p.fallbackUrl; };
    const idx = S.viewOrder.indexOf(src);
    $("sheetTitle").textContent = `Photo ${idx + 1} of ${S.viewOrder.length}${p.isNew ? " · not live yet" : ""}`;
    for (const b of document.querySelectorAll("[data-move]")) {
      const m = b.dataset.move;
      b.disabled = ((m === "first" || m === "up") && idx === 0) || ((m === "last" || m === "down") && idx === S.viewOrder.length - 1);
    }
    openDialog($("photoSheet"));
  }

  async function saveOrder() {
    if (!orderDirty()) return;
    await withBusy(async () => {
      try {
        await api("reorder", { gallery: S.gallery, order: S.viewOrder });
        await Promise.all([loadGallery(S.gallery), loadState()]);
        banner("Order saved. It goes live when you publish.");
      } catch (err) {
        banner(`Couldn't save the order. ${err.message}`, "err");
      }
    });
  }

  async function guardUnsavedOrder() {
    if (!orderDirty()) return true;
    const save = await confirmBox({ title: "Save your new order?", text: "You moved photos but haven't saved the new order yet.", ok: "Save order" });
    if (save) { await saveOrder(); return !orderDirty(); }
    S.viewOrder = S.photos.map((p) => p.src);
    renderGrid();
    return true;
  }

  async function removePhoto(src) {
    const p = photoBySrc(src);
    if (!p) return;
    const title = S.state.galleries.find((g) => g.slug === S.gallery)?.title || "this gallery";
    const yes = await confirmBox({
      title: `Remove this photo from ${title}?`,
      text: p.isNew
        ? "This photo isn't on your live site yet, so it simply won't be added."
        : "It stays on your live site until you publish. You can undo this any time before publishing.",
      ok: "Remove photo",
      danger: true,
      image: S.urlBySha.get(p.sha) || p.url,
    });
    if (!yes) return;
    await withBusy(async () => {
      try {
        await api("remove", { gallery: S.gallery, src });
        await Promise.all([loadGallery(S.gallery), loadState()]);
        banner("Photo removed. Your site updates when you publish.");
      } catch (err) {
        banner(`Couldn't remove the photo. ${err.message}`, "err");
      }
    });
  }

  async function restorePhoto(slug, src) {
    await withBusy(async () => {
      try {
        await api("restore", { gallery: slug, src });
        await Promise.all([slug === S.gallery ? loadGallery(slug) : null, loadState()]);
        banner("Photo put back.");
      } catch (err) {
        banner(`Couldn't put the photo back. ${err.message}`, "err");
      }
    });
  }

  // ---------------------------------------------------------------- upload

  function isHeic(file) {
    return /hei[cf]/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
  }

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

  // Resize to <=2000px and encode. WebP where the browser can really make it,
  // otherwise JPEG (Safari). The server re-checks the real bytes either way.
  async function preparePhoto(file) {
    if (file.size > MAX_INPUT_BYTES) throw new Error("This file is too big to be a photo (over 80 MB).");
    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch {
      if (isHeic(file)) {
        throw new Error("This browser can't open iPhone HEIC photos. Add it from Safari on your iPhone, or export it as JPG first.");
      }
      throw new Error("This file couldn't be opened as a photo. Please use a JPG.");
    }
    const { img, url } = decoded;
    try {
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error("This photo couldn't be read. Please use a JPG.");
      const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);

      let blob = await canvasToBlob(canvas, "image/webp", 0.82);
      if (!blob || blob.type !== "image/webp" || blob.size > TARGET_BYTES) {
        blob = null;
        for (const q of [0.86, 0.76, 0.66, 0.55]) {
          const b = await canvasToBlob(canvas, "image/jpeg", q);
          if (b && b.type === "image/jpeg" && b.size <= TARGET_BYTES) { blob = b; break; }
        }
      }
      canvas.width = 0; canvas.height = 0; // free memory on iPhone
      if (!blob) throw new Error("This photo couldn't be shrunk for the web. Try exporting it as a JPG.");
      return { blob, width: w, height: h };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function startUpload(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    const slug = S.gallery;
    const title = S.state.galleries.find((g) => g.slug === slug)?.title || slug;
    S.upload = {
      slug, title,
      items: list.map((file, i) => ({
        id: i, file, name: file.name || `photo-${i + 1}.jpg`,
        preview: null, status: "waiting", text: "Waiting", receipt: null, kind: "",
      })),
      offerCount: 0,
    };
    $("uploadPanel").hidden = false;
    $("momentsOffer").hidden = true;
    $("uploadTitle").textContent = `Adding photos to ${title}`;
    renderUpload();
    runUpload(S.upload.items);
  }

  function renderUpload() {
    const u = S.upload;
    if (!u) return;
    const ul = $("uploadList");
    ul.innerHTML = "";
    for (const it of u.items) {
      const li = document.createElement("li");
      const th = document.createElement("img");
      th.className = "thumb";
      th.alt = "";
      if (it.preview) th.src = it.preview;
      const meta = document.createElement("div");
      meta.className = "meta";
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = it.name;
      const st = document.createElement("div");
      st.className = "st " + (it.kind || "");
      st.textContent = it.text;
      meta.append(nm, st);
      li.append(th, meta);
      ul.appendChild(li);
    }
    const done = u.items.filter((i) => i.status === "added").length;
    const failed = u.items.filter((i) => i.status === "failed").length;
    const total = u.items.length;
    $("uploadProgress").textContent = S.uploading
      ? `${u.items.filter((i) => ["sent", "added", "failed", "duplicate"].includes(i.status)).length} of ${total}`
      : `${done} added${failed ? `, ${failed} failed` : ""}`;
    $("uploadActions").hidden = S.uploading;
    $("retryFailed").hidden = S.uploading || !failed;
    $("saveAgain").hidden = S.uploading || !u.items.some((i) => i.status === "sent");
  }

  function setItem(it, status, text, kind = "") {
    it.status = status; it.text = text; it.kind = kind;
    renderUpload();
  }

  async function runUpload(items) {
    const u = S.upload;
    S.uploading = true;
    refreshControls();
    try {
      // 1) prepare + send each photo (2 at a time)
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const it = items[next++];
          try {
            setItem(it, "preparing", "Preparing…");
            const { blob } = await preparePhoto(it.file);
            if (!it.preview) it.preview = URL.createObjectURL(blob);
            setItem(it, "sending", "Sending…");
            const r = await api("upload", null, {
              raw: blob,
              headers: { "content-type": blob.type, "x-file-name": encodeURIComponent(it.name) },
            });
            it.receipt = r.receipt;
            setItem(it, "sent", "Sent, saving to gallery…");
          } catch (err) {
            if (err.code === "signed_out") throw err;
            setItem(it, "failed", err.message || "Failed", "err");
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, worker));

      // 2) save every sent photo to the gallery in ONE change
      await saveSent(u);
    } finally {
      S.uploading = false;
      renderUpload();
      refreshControls();
    }
  }

  async function saveSent(u) {
    const sent = u.items.filter((i) => i.status === "sent" && i.receipt);
    if (!sent.length) {
      if (u.items.every((i) => i.status === "failed")) banner("None of those photos could be added. See the reasons below.", "err");
      return;
    }
    try {
      const r = await api("add", { gallery: u.slug, files: sent.map((i) => i.receipt) });
      const addedShas = new Set(r.added.map((a) => a.sha));
      const skippedShas = new Set(r.skipped.map((s) => s.sha));
      for (const it of sent) {
        if (addedShas.has(it.receipt.sha)) setItem(it, "added", "Added ✓ (not live until you publish)", "ok");
        else if (skippedShas.has(it.receipt.sha)) setItem(it, "duplicate", "Already in this gallery, skipped", "warn");
      }
      const n = r.added.length;
      if (n) {
        u.offerCount += n;
        $("offerCount").textContent = fmt(u.offerCount);
        $("offerCheck").checked = false;
        $("offerBtn").disabled = true;
        $("momentsOffer").hidden = false;
      }
      const failed = u.items.filter((i) => i.status === "failed").length;
      banner(`${plural(n, "photo")} added to ${u.title}.${failed ? ` ${plural(failed, "photo")} couldn't be added.` : ""} Publish when you're ready.`, failed ? "err" : "ok");
      await Promise.all([u.slug === S.gallery ? loadGallery(u.slug) : null, loadState()]);
    } catch (err) {
      if (err.code === "signed_out") throw err;
      for (const it of sent) setItem(it, "sent", "Sent but not saved yet. Tap “Save photos again”.", "warn");
      banner(`Photos were sent but not saved to the gallery. ${err.message}`, "err");
    }
  }

  // ---------------------------------------------------------------- moments

  function numberDialog({ title, help, okLabel, preview, validate, confirmText }) {
    return new Promise((resolve) => {
      const d = $("numberDialog");
      const input = $("numberInput");
      const okBtn = $("numberOk");
      const check = $("numberCheck");
      $("numberTitle").textContent = title;
      $("numberHelp").textContent = help;
      $("numberMsg").textContent = "";
      input.value = "";
      check.checked = false;
      const update = () => {
        const n = parseWhole(input.value);
        const v = n === null ? { ok: false, preview: input.value.trim() ? "Enter a whole number, like 1,250" : "" } : validate(n);
        $("numberPreview").textContent = v.preview || "";
        const needCheck = v.ok && confirmText && confirmText(n);
        $("numberCheckWrap").hidden = !needCheck;
        if (needCheck) $("numberCheckText").textContent = needCheck;
        okBtn.textContent = v.ok ? okLabel(n) : "Save";
        okBtn.disabled = !v.ok || (needCheck && !check.checked);
      };
      input.oninput = update;
      check.onchange = update;
      update();
      const done = (v) => { closeDialog(d); input.oninput = null; okBtn.onclick = null; d.oncancel = null; resolve(v); };
      okBtn.onclick = () => done(parseWhole(input.value));
      $("numberCancel").onclick = () => done(null);
      d.oncancel = (e) => { e.preventDefault(); done(null); };
      openDialog(d);
      setTimeout(() => input.focus(), 60);
    });
  }

  async function momentsAdd(prefill) {
    const current = S.state.stats.draft;
    let amount = prefill;
    if (amount == null) {
      amount = await numberDialog({
        title: "Add photos taken",
        help: `How many photos did you take? This is added to your total of ${fmt(current)}.`,
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
        await loadState();
        banner(`Moments Captured is now ${fmt(r.after)}. It updates on your site when you publish.`);
      } catch (err) {
        banner(`Couldn't update Moments Captured. ${err.message}`, "err");
      }
    });
  }

  async function momentsSet() {
    const current = S.state.stats.draft;
    const value = await numberDialog({
      title: "Set exact total",
      help: `Replace your total (${fmt(current)}) with a new number. Use this only to correct it.`,
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
        await loadState();
        banner(`Moments Captured set to ${fmt(r.after)}. It updates on your site when you publish.`);
      } catch (err) {
        await loadState().catch(() => {});
        banner(`Couldn't set Moments Captured. ${err.message}`, "err");
      }
    });
  }

  // ---------------------------------------------------------------- publish

  function setPublishStatus(kind, title, detail, { spinner = false, check = false, retry = false, dismiss = false } = {}) {
    const box = $("publishStatus");
    box.hidden = false;
    box.className = "publish-status" + (kind ? " " + kind : "");
    $("pubTitle").textContent = title;
    $("pubDetail").textContent = detail || "";
    $("pubSpinner").hidden = !spinner;
    $("pubCheck").hidden = !check;
    $("pubRetry").hidden = !retry;
    $("pubDismiss").hidden = !dismiss;
  }

  function savePublish(p) {
    S.publish = p;
    try { p ? localStorage.setItem(PUBLISH_KEY, JSON.stringify(p)) : localStorage.removeItem(PUBLISH_KEY); } catch {}
  }

  async function publish() {
    if (!(await guardUnsavedOrder())) return;
    const s = await loadState();
    if (!s.changes.hasChanges) { banner("Everything is already up to date."); return; }
    const yes = await confirmBox({
      title: "Publish these changes?",
      text: s.changes.lines.join("\n"),
      ok: "Publish changes",
    });
    if (!yes) return;
    await withBusy(async () => {
      setPublishStatus("", "Publishing…", "Sending your changes.", { spinner: true });
      try {
        const r = await api("publish", { draftSha: s.draftSha });
        if (r.nothingToPublish) {
          $("publishStatus").hidden = true;
          banner("Everything is already up to date.");
          await loadState();
          return;
        }
        savePublish({ sha: r.productionSha, startedAt: Date.now() });
        await loadState().catch(() => {});
        pollPublish();
      } catch (err) {
        if (err.code === "stale_draft") {
          await loadState().catch(() => {});
          setPublishStatus("warn", "Please review again", err.message, { dismiss: true });
        } else {
          setPublishStatus("err", "Publish didn't go through", `${err.message} Your changes are still saved here.`, { dismiss: true });
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
    if (live) {
      savePublish(null);
      setPublishStatus("ok", "Published ✓", "Your changes are live on jcwrks.com.", { dismiss: true });
      loadState().catch(() => {});
      return;
    }
    if (elapsed < SLOW_MS) {
      setPublishStatus("", "Updating your live site…", "This usually takes 1 to 2 minutes. You can leave this page open or come back later.", { spinner: true });
    } else if (elapsed < RETRY_OFFER_MS) {
      setPublishStatus("warn", "Still updating…", "This is taking longer than usual. Your changes are saved, nothing is lost.", { spinner: true, check: true });
    } else {
      setPublishStatus("warn", "Your site hasn't updated yet", "Your changes are saved. Tap “Try publishing again”. If it still doesn't update after that, tell Logan.", { check: true, retry: true });
      return; // stop auto-polling; buttons take over
    }
    S.pollTimer = setTimeout(pollPublish, POLL_MS);
  }

  async function retryPublish() {
    await withBusy(async () => {
      try {
        const r = await api("retry-publish");
        if (r.alreadyLive) {
          savePublish(null);
          setPublishStatus("ok", "Published ✓", "Your changes are live on jcwrks.com.", { dismiss: true });
          return;
        }
        savePublish({ sha: r.productionSha, startedAt: Date.now() });
        pollPublish();
      } catch (err) {
        setPublishStatus("warn", "Not yet", err.message, { check: true, retry: err.code !== "too_soon" });
      }
    });
  }

  async function discardAll() {
    if (!(await guardUnsavedOrder())) return;
    const yes = await confirmBox({
      title: "Throw away all unpublished changes?",
      text: "New photos that aren't live yet will be removed, removed photos come back, and Moments Captured goes back to what's on your site. This can't be undone.",
      ok: "Throw away changes",
      danger: true,
      checkText: "Yes, throw away my unpublished changes",
    });
    if (!yes) return;
    await withBusy(async () => {
      try {
        await api("discard");
        await Promise.all([loadGallery(S.gallery), loadState()]);
        banner("Unpublished changes thrown away. Your manager now matches your live site.");
      } catch (err) {
        banner(`Couldn't throw away changes. ${err.message}`, "err");
      }
    });
  }

  // ---------------------------------------------------------------- controls

  function refreshControls() {
    const dirty = orderDirty();
    const blocked = S.busy > 0 || S.uploading;
    const publishing = !!S.publish;
    $("orderBar").hidden = !dirty;
    $("saveOrder").disabled = blocked;
    $("undoOrder").disabled = blocked;
    $("addBtn").disabled = blocked || dirty;
    $("gallery").disabled = blocked;
    $("momentsAddBtn").disabled = blocked;
    $("momentsSetBtn").disabled = blocked;
    $("publishBtn").disabled = blocked || dirty || publishing;
    $("publishBtn").textContent = S.uploading ? "Wait for photos to finish…" : dirty ? "Save your order first" : publishing ? "Publishing…" : "Publish changes";
    $("discardBtn").disabled = blocked || publishing;
    $("grid").classList.toggle("locked", blocked);
    if (S.sortable) S.sortable.option("disabled", blocked);
  }

  // ---------------------------------------------------------------- boot

  async function enterApp() {
    show("loadingView");
    try {
      await loadState();
      await loadGallery($("gallery").value || "basketball");
      show("appView");
      try { S.publish = JSON.parse(localStorage.getItem(PUBLISH_KEY) || "null"); } catch { S.publish = null; }
      if (S.publish) {
        pollPublish();
      } else if (S.state.deploy && S.state.deploy.liveCommit && !S.state.deploy.live) {
        // Something was published (maybe from another device) and isn't live yet.
        savePublish({ sha: S.state.deploy.productionSha, startedAt: Date.now() - 60000 });
        pollPublish();
      }
      refreshControls();
    } catch (err) {
      if (err.code === "signed_out") return;
      show("appView");
      banner(`Couldn't load your portfolio. ${err.message}`, "err", true);
    }
  }

  function wire() {
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = $("pw").value;
      if (!password) { $("loginMsg").textContent = "Enter your password."; return; }
      $("loginBtn").disabled = true;
      $("loginMsg").textContent = "";
      try {
        const r = await api("login", { password });
        S.token = r.token;
        saveSession(r.token, r.expires);
        $("pw").value = "";
        await enterApp();
      } catch (err) {
        $("loginMsg").textContent = err.message;
      } finally {
        $("loginBtn").disabled = false;
      }
    });

    $("signOut").onclick = () => { clearSession(); savePublish(null); showLogin(); };

    $("gallery").addEventListener("change", async (e) => {
      const next = e.target.value;
      if (!(await guardUnsavedOrder())) { e.target.value = S.gallery; return; }
      await withBusy(async () => {
        try { await loadGallery(next); } catch (err) { banner(`Couldn't open that gallery. ${err.message}`, "err"); }
      });
    });

    $("addBtn").onclick = () => $("fileInput").click();
    $("fileInput").addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length) startUpload(files);
      e.target.value = "";
    });
    $("retryFailed").onclick = () => {
      const failed = S.upload.items.filter((i) => i.status === "failed");
      for (const it of failed) setItem(it, "waiting", "Waiting");
      runUpload(failed);
    };
    $("saveAgain").onclick = async () => {
      S.uploading = true; refreshControls(); renderUpload();
      try { await saveSent(S.upload); } finally { S.uploading = false; renderUpload(); refreshControls(); }
    };
    $("closeUpload").onclick = () => {
      if (S.upload && S.upload.items.some((i) => i.status === "sent")) {
        banner("Some photos were sent but not saved. Tap “Save photos again” first.", "err");
        return;
      }
      for (const it of S.upload?.items || []) if (it.preview) URL.revokeObjectURL(it.preview);
      S.upload = null;
      $("uploadPanel").hidden = true;
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
    $("undoOrder").onclick = () => { S.viewOrder = S.photos.map((p) => p.src); renderGrid(); };

    for (const b of document.querySelectorAll("[data-move]")) {
      b.onclick = () => { const src = sheetSrc; closeDialog($("photoSheet")); moveInView(src, b.dataset.move); };
    }
    $("sheetRemove").onclick = async () => {
      const src = sheetSrc;
      closeDialog($("photoSheet"));
      if (!(await guardUnsavedOrder())) return;
      removePhoto(src);
    };
    $("sheetClose").onclick = () => closeDialog($("photoSheet"));
    $("photoSheet").addEventListener("click", (e) => { if (e.target === $("photoSheet")) closeDialog($("photoSheet")); });

    $("momentsAddBtn").onclick = () => momentsAdd();
    $("momentsSetBtn").onclick = momentsSet;
    $("publishBtn").onclick = publish;
    $("discardBtn").onclick = discardAll;
    $("pubCheck").onclick = () => { if (S.publish) pollPublish(); };
    $("pubRetry").onclick = retryPublish;
    $("pubDismiss").onclick = () => { $("publishStatus").hidden = true; };

    window.addEventListener("beforeunload", (e) => {
      if (S.uploading || orderDirty() || (S.upload && S.upload.items.some((i) => i.status === "sent"))) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  wire();
  S.token = loadSession();
  if (S.token) enterApp(); else showLogin();
})();
