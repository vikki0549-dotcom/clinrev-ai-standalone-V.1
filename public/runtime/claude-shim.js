/*
 * claude-shim.js — drop-in replacement for the Claude artifact runtime.
 *
 * Provides window.claude.use(name) for the capabilities the ClinRev page uses:
 *   "db"        Firestore-like document store with live snapshots (server: /api/db/*, /api/events)
 *   "user"      signed-in user (OIDC) and user directory (/api/session, /api/users/*)
 *   "sample"    Claude AI calls (/api/ai, /api/ai/stream)
 *   "downloads" browser file downloads (client side only)
 *
 * Real-time design: ONE EventSource per page receives every change the user is
 * allowed to read (the server filters by access rule); this file routes them to
 * the matching doc/collection listeners. No per-subscription server state, so it
 * works behind a load balancer with several app instances. On reconnect (or a
 * server "resync" hint) every live subscription is re-fetched.
 */
(function () {
  "use strict";
  if (window.claude && window.claude.use) return;

  /* ------------------------------------------------------------ helpers */
  var clone = typeof structuredClone === "function"
    ? function (v) { return v == null ? v : structuredClone(v); }
    : function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };

  function err(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  var redirecting = false;
  function toLogin() {
    if (redirecting) return;
    redirecting = true;
    var rt = location.pathname + location.search + location.hash;
    location.assign("/auth/login?returnTo=" + encodeURIComponent(rt));
  }

  var sessionP = null;
  function session(force) {
    if (!sessionP || force) {
      sessionP = fetch("/api/session", { credentials: "same-origin", headers: { "X-Activity": "passive" } })
        .then(function (r) {
          if (r.status === 401) { toLogin(); throw err("unauthenticated", "Your session ended. Sign in again."); }
          if (!r.ok) throw err("unavailable", "The workspace could not be reached.");
          return r.json();
        })
        .catch(function (e) { sessionP = null; throw e; });
    }
    return sessionP;
  }

  // JSON request helper. opts: {passive, signal, raw}
  function api(method, url, body, opts, retried) {
    opts = opts || {};
    var p = method === "GET" ? Promise.resolve(null) : session();
    return p.then(function (s) {
      var headers = { "X-Activity": opts.passive ? "passive" : "active" };
      if (s) headers["X-CSRF-Token"] = s.csrf;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return fetch(url, {
        method: method,
        credentials: "same-origin",
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opts.signal,
      });
    }).then(function (r) {
      if (r.status === 401) { toLogin(); throw err("unauthenticated", "Your session ended. Sign in again."); }
      if (opts.raw && r.ok) return r;
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (_) {}
        if (r.ok) return j;
        var code = (j && j.code) || (r.status === 429 ? "rate_limited" : r.status === 413 ? "prompt_too_large" : "http_" + r.status);
        if (code === "csrf" && !retried) {
          return session(true).then(function () { return api(method, url, body, opts, true); });
        }
        throw err(code, (j && j.message) || "Request failed (" + r.status + ").", { status: r.status });
      });
    }, function (e) {
      if (e && e.name === "AbortError") throw err("aborted", "Request cancelled.", { name: "AbortError" });
      if (e && e.code) throw e;
      throw err("network", "The connection to the server was interrupted. Check your connection and try again.");
    });
  }

  /* ------------------------------------------------------- activity ping */
  // Keeps the server's idle timer (HIPAA automatic logoff) tied to real user input.
  var lastPing = 0;
  function activity() {
    var now = Date.now();
    if (now - lastPing < 60000) return;
    lastPing = now;
    api("POST", "/api/session/ping", {}).catch(function () {});
  }
  ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"].forEach(function (t) {
    window.addEventListener(t, activity, { passive: true, capture: true });
  });

  /* ------------------------------------------------------------ db store */
  var docSubs = new Map(); // path -> {listeners:Set<{next,error}>, loaded, state:{exists,data,version}}
  var colSubs = new Map(); // path -> {listeners:Set, loaded, docs:Map<id,{data,version}>, tomb:Map<id,version>}
  var pending = new Set();
  var flushQueued = false;

  function docSnapshot(path, st) {
    var id = path.split("/").pop();
    var data = st && st.exists ? st.data : undefined;
    return {
      id: id,
      exists: !!(st && st.exists),
      ref: makeDocRef(path),
      data: function () { return data === undefined ? undefined : clone(data); },
    };
  }
  function colSnapshot(path, sub) {
    var docs = [];
    var ids = Array.from(sub.docs.keys()).sort();
    ids.forEach(function (id) {
      var d = sub.docs.get(id).data;
      docs.push({ id: id, exists: true, ref: makeDocRef(path + "/" + id), data: function () { return clone(d); } });
    });
    return {
      docs: docs, size: docs.length, empty: docs.length === 0,
      forEach: function (f) { docs.forEach(f); },
    };
  }

  function queue(kind, path) {
    pending.add(kind + "\u0000" + path);
    if (flushQueued) return;
    flushQueued = true;
    setTimeout(flush, 0);
  }
  function flush() {
    flushQueued = false;
    var items = Array.from(pending);
    pending.clear();
    items.forEach(function (k) {
      var i = k.indexOf("\u0000"), kind = k.slice(0, i), path = k.slice(i + 1);
      var sub = kind === "d" ? docSubs.get(path) : colSubs.get(path);
      if (!sub || !sub.loaded) return;
      var snap = kind === "d" ? docSnapshot(path, sub.state) : colSnapshot(path, sub);
      sub.listeners.forEach(function (l) { try { l.next(snap); } catch (e) { console.error(e); } });
    });
  }

  // Applies one document state (from a fetch, a write result or a change event).
  function applyDoc(path, exists, data, version) {
    var segs = path.split("/");
    var id = segs.pop();
    var col = segs.join("/");
    var ds = docSubs.get(path);
    if (ds && ds.loaded && !(ds.state.version >= version)) {
      ds.state = { exists: exists, data: exists ? data : null, version: version };
      queue("d", path);
    }
    var cs = colSubs.get(col);
    if (cs && cs.loaded) {
      var cur = cs.docs.get(id);
      var curV = cur ? cur.version : (cs.tomb.get(id) || 0);
      if (!(curV >= version)) {
        if (exists) { cs.docs.set(id, { data: data, version: version }); cs.tomb.delete(id); }
        else { cs.docs.delete(id); cs.tomb.set(id, version); }
        queue("c", col);
      }
    }
  }

  function loadDoc(path, passive) {
    var sub = docSubs.get(path);
    return api("GET", "/api/db/doc?path=" + encodeURIComponent(path), undefined, { passive: passive }).then(function (d) {
      sub = docSubs.get(path);
      if (!sub) return;
      var v = d.version || 0;
      if (!sub.loaded || !(sub.state.version > v)) sub.state = { exists: d.exists, data: d.exists ? d.data : null, version: v };
      sub.loaded = true;
      queue("d", path);
    });
  }
  function loadCol(path, passive) {
    return api("GET", "/api/db/collection?path=" + encodeURIComponent(path), undefined, { passive: passive }).then(function (r) {
      var sub = colSubs.get(path);
      if (!sub) return;
      var fresh = new Map();
      (r.docs || []).forEach(function (d) { fresh.set(d.id, { data: d.data, version: d.version || 0 }); });
      if (sub.loaded) {
        // Keep anything newer that arrived over the stream during the fetch.
        var asOf = r.asOf || 0;
        sub.docs.forEach(function (cur, id) {
          var f = fresh.get(id);
          if ((f && cur.version > f.version) || (!f && cur.version > asOf)) fresh.set(id, cur);
        });
        sub.tomb.forEach(function (v, id) { var f = fresh.get(id); if (f && v > f.version) fresh.delete(id); });
      }
      sub.docs = fresh;
      sub.tomb = new Map();
      sub.loaded = true;
      queue("c", path);
    });
  }

  /* ----------------------------------------------- shared event stream */
  var es = null, esReady = null, esReadyResolve = null, backoff = 1000, everConnected = false, reconnectTimer = null;
  function ensureStream() {
    if (es) return esReady;
    esReady = new Promise(function (res) { esReadyResolve = res; });
    // Don't block a first load forever if the stream is slow; snapshots still load.
    setTimeout(function () { if (esReadyResolve) esReadyResolve(); }, 4000);
    es = new EventSource("/api/events", { withCredentials: true });
    es.addEventListener("hello", function () {
      backoff = 1000;
      var first = !everConnected;
      everConnected = true;
      if (esReadyResolve) { esReadyResolve(); esReadyResolve = null; }
      if (!first) resyncAll();
    });
    es.addEventListener("change", function (ev) {
      try {
        var m = JSON.parse(ev.data);
        applyDoc(m.path, m.exists, m.data, m.version);
      } catch (e) { console.error(e); }
    });
    es.addEventListener("resync", function () { resyncAll(); });
    es.addEventListener("expired", function () { closeStream(); toLogin(); });
    es.onerror = function () {
      // Take over reconnection so a 401 (signed out) is detected and backoff applies.
      closeStream();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function () {
        session(true).then(function () { if (hasSubs()) ensureStream(); }, function () {
          if (!redirecting) { reconnectTimer = setTimeout(function () { if (hasSubs()) ensureStream(); }, backoff); }
        });
      }, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    return esReady;
  }
  function closeStream() { if (es) { try { es.close(); } catch (_) {} } es = null; }
  function hasSubs() { return docSubs.size + colSubs.size > 0; }
  function resyncAll() {
    docSubs.forEach(function (s, p) { if (s.loaded) loadDoc(p, true).catch(function () {}); });
    colSubs.forEach(function (s, p) { if (s.loaded) loadCol(p, true).catch(function () {}); });
  }
  window.addEventListener("online", function () { if (!es && hasSubs()) { backoff = 1000; ensureStream(); } });

  function subscribe(map, kind, path, next, error) {
    var l = { next: typeof next === "function" ? next : function () {}, error: typeof error === "function" ? error : null };
    var sub = map.get(path);
    var isNew = !sub;
    if (isNew) {
      sub = kind === "d" ? { listeners: new Set(), loaded: false, state: null } : { listeners: new Set(), loaded: false, docs: new Map(), tomb: new Map() };
      map.set(path, sub);
    }
    sub.listeners.add(l);
    if (sub.loaded) {
      var s = kind === "d" ? docSnapshot(path, sub.state) : colSnapshot(path, sub);
      setTimeout(function () { if (sub.listeners.has(l)) l.next(s); }, 0);
    } else if (isNew) {
      ensureStream().then(function () { return kind === "d" ? loadDoc(path) : loadCol(path); }).catch(function (e) {
        var cur = map.get(path);
        if (cur === sub) map.delete(path);
        sub.listeners.forEach(function (x) { if (x.error) try { x.error(e); } catch (_) {} else console.warn(e); });
      });
    }
    return function unsubscribe() {
      sub.listeners.delete(l);
      if (!sub.listeners.size && map.get(path) === sub) map.delete(path);
      if (!hasSubs()) closeStream();
    };
  }

  /* -------------------------------------------------------- refs */
  function makeDocRef(path) {
    return {
      id: path.split("/").pop(),
      path: path,
      get: function () {
        return api("GET", "/api/db/doc?path=" + encodeURIComponent(path)).then(function (d) {
          return docSnapshot(path, { exists: d.exists, data: d.data });
        });
      },
      set: function (obj) {
        return api("POST", "/api/db/doc", { op: "set", path: path, data: obj }).then(function (r) {
          applyDoc(path, true, stripDeletes(clone(obj)), r.version);
        });
      },
      update: function (patch) {
        return api("POST", "/api/db/doc", { op: "update", path: path, data: patch }).then(function (r) {
          var base = currentData(path);
          if (base) {
            var d = clone(base);
            Object.keys(patch).forEach(function (k) { if (isDel(patch[k])) delete d[k]; else d[k] = clone(patch[k]); });
            applyDoc(path, true, d, r.version);
          }
        });
      },
      delete: function () {
        return api("POST", "/api/db/doc", { op: "delete", path: path }).then(function (r) {
          applyDoc(path, false, null, r.version);
        });
      },
      onSnapshot: function (next, error) {
        if (next && typeof next === "object") { error = next.error; next = next.next; }
        return subscribe(docSubs, "d", path, next, error);
      },
      collection: function (sub) { return makeColRef(path + "/" + sub); },
    };
  }
  function makeColRef(path) {
    return {
      id: path.split("/").pop(),
      path: path,
      doc: function (id) { return makeDocRef(path + "/" + (id || randomId())); },
      add: function (obj) {
        return api("POST", "/api/db/add", { path: path, data: obj }).then(function (r) {
          applyDoc(path + "/" + r.id, true, stripDeletes(clone(obj)), r.version);
          return makeDocRef(path + "/" + r.id);
        });
      },
      get: function () {
        return api("GET", "/api/db/collection?path=" + encodeURIComponent(path)).then(function (r) {
          var sub = { docs: new Map() };
          (r.docs || []).forEach(function (d) { sub.docs.set(d.id, { data: d.data, version: d.version }); });
          return colSnapshot(path, sub);
        });
      },
      onSnapshot: function (next, error) {
        if (next && typeof next === "object") { error = next.error; next = next.next; }
        return subscribe(colSubs, "c", path, next, error);
      },
    };
  }
  function isDel(v) { return v && typeof v === "object" && v.__delete__ === true; }
  function stripDeletes(o) { if (o && typeof o === "object") Object.keys(o).forEach(function (k) { if (isDel(o[k])) delete o[k]; }); return o; }
  function currentData(path) {
    var ds = docSubs.get(path);
    if (ds && ds.loaded && ds.state.exists) return ds.state.data;
    var segs = path.split("/"), id = segs.pop(), cs = colSubs.get(segs.join("/"));
    if (cs && cs.loaded && cs.docs.has(id)) return cs.docs.get(id).data;
    return null;
  }
  function randomId() {
    var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", b = new Uint8Array(20), s = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < b.length; i++) s += a[b[i] % 62];
    return s;
  }
  function normPath(p) { return String(p || "").replace(/^\/+|\/+$/g, ""); }

  var db = {
    doc: function (p) { return makeDocRef(normPath(p)); },
    collection: function (p) { return makeColRef(normPath(p)); },
  };

  /* -------------------------------------------------------------- user */
  var user = {
    me: function () { return session().then(function (s) { return { id: s.user.id, name: s.user.name, email: s.user.email }; }); },
    id: function () { return session().then(function (s) { return s.user.id; }); },
    isOwner: function () { return session().then(function (s) { return !!s.isOwner; }); },
    canEdit: function () { return session().then(function (s) { return !!s.canEdit; }); },
    profiles: function (ids) { return api("POST", "/api/users/profiles", { ids: Array.isArray(ids) ? ids : [] }, { passive: true }); },
    search: function (q) { return api("GET", "/api/users/search?q=" + encodeURIComponent(q || "")); },
  };

  /* ------------------------------------------------------------ sample */
  function blobToBase64(b) {
    return b.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), s = "", CH = 0x8000;
      for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(s);
    });
  }
  function prepImages(images) {
    if (!images || !images.length) return Promise.resolve([]);
    return Promise.all(Array.prototype.map.call(images, function (b) {
      if (typeof b === "string") return { mediaType: "image/jpeg", data: b.replace(/^data:[^,]*,/, "") };
      return blobToBase64(b).then(function (data) { return { mediaType: b.type || "image/jpeg", data: data }; });
    }));
  }
  function aiBody(prompt, opts) {
    return prepImages(opts.images).then(function (imgs) {
      return { prompt: String(prompt), modelTier: opts.modelTier === "quick" ? "quick" : "default", images: imgs, maxTokens: opts.maxTokens };
    });
  }

  function streamCall(prompt, opts) {
    var text = "";
    return aiBody(prompt, opts).then(function (body) {
      return api("POST", "/api/ai/stream", body, { signal: opts.signal, raw: true });
    }).then(function (r) {
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", done = false, final = null;
      function handle(frame) {
        var line = frame.split("\n").filter(function (l) { return l.indexOf("data:") === 0; }).map(function (l) { return l.slice(5).trim(); }).join("");
        if (!line) return;
        var m = JSON.parse(line);
        if (m.type === "text") { text += m.delta; if (opts.onText) try { opts.onText({ text: text }); } catch (e) { console.error(e); } }
        else if (m.type === "done") { final = typeof m.text === "string" ? m.text : text; }
        else if (m.type === "error") throw err(m.code || "ai_error", m.message);
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.value) buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
          if (x.done) {
            if (buf.trim()) handle(buf);
            if (final === null) throw err("network", "The AI reply was cut off. Try again.");
            return { text: final };
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (e && (e.name === "AbortError" || (opts.signal && opts.signal.aborted))) throw err("aborted", "Request cancelled.", { name: "AbortError" });
      if (e && !e.code) throw err("network", "The connection to the server was interrupted. Try again.");
      throw e;
    });
  }

  function sample(prompt, opts) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) return Promise.reject(err("aborted", "Request cancelled.", { name: "AbortError" }));
    if (typeof opts.onText === "function") return streamCall(prompt, opts);
    return aiBody(prompt, opts).then(function (body) {
      return api("POST", "/api/ai", body, { signal: opts.signal });
    }).then(function (r) { return { text: r.text || "" }; });
  }

  // Finds the first complete JSON object/array in model text (handles code
  // fences, prose around the JSON, and braces inside strings).
  function extractJson(text) {
    var t = String(text || "").trim();
    try { return JSON.parse(t); } catch (_) {}
    var fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch (_) {} }
    for (var start = 0; start < t.length; start++) {
      var c0 = t[start];
      if (c0 !== "{" && c0 !== "[") continue;
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < t.length; i++) {
        var c = t[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(t.slice(start, i + 1)); } catch (_) { break; }
          }
        }
      }
    }
    throw err("invalid_json", "The AI reply could not be read. Try again.");
  }
  sample.json = function (prompt, opts) {
    var o = {};
    for (var k in opts || {}) if (k !== "onText") o[k] = opts[k];
    return sample(prompt, o).then(function (r) { return extractJson(r.text); });
  };
  var limitsP = null;
  sample.limits = function () {
    if (!limitsP) limitsP = api("GET", "/api/ai/limits", undefined, { passive: true }).catch(function (e) { limitsP = null; throw e; });
    return limitsP;
  };

  /* --------------------------------------------------------- downloads */
  var MIME = {
    csv: "text/csv", txt: "text/plain", json: "application/json", html: "text/html", xml: "application/xml",
    pdf: "application/pdf", edi: "application/edi-x12", x12: "application/edi-x12", "837": "application/edi-x12",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  var downloads = {
    save: function (o) {
      o = o || {};
      var name = String(o.filename || "download").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_");
      var ext = (name.split(".").pop() || "").toLowerCase();
      var type = o.mimeType || MIME[ext] || "application/octet-stream";
      var d = o.data, blob;
      if (d instanceof Blob) blob = d;
      else if (typeof d === "string") blob = new Blob([d], { type: type + (/^text\//.test(type) ? ";charset=utf-8" : "") });
      else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) blob = new Blob([d], { type: type });
      else blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name; a.rel = "noopener"; a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 30000);
      return Promise.resolve({ ok: true });
    },
  };

  /* -------------------------------------------------------------- use() */
  var caps = { db: db, user: user, sample: sample, downloads: downloads };
  window.claude = {
    standalone: true,
    use: function (name) {
      if (!Object.prototype.hasOwnProperty.call(caps, name)) return Promise.reject(err("unsupported", "Capability not available: " + name));
      // Confirm the session first so a signed-out page goes to sign-in.
      return session().then(function () { return caps[name]; });
    },
  };
})();
