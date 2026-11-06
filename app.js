/* Caderno de Clínica — app offline-first.
 * As notas ficam no aparelho (IndexedDB). Com login, sincronizam com o Supabase:
 * envia o que mudou aqui e puxa o que mudou lá (inclusive o que o Claude anotou).
 */
(function () {
  "use strict";

  // ---------- áreas ----------
  var AREAS = [
    { id: "cardio",    nome: "Cardiologia",               c: "#c62839" },
    { id: "pneumo",    nome: "Pneumologia",               c: "#2b86c5" },
    { id: "nefro",     nome: "Nefrologia e DHE",          c: "#c9850a" },
    { id: "gastro",    nome: "Gastro e Hepato",           c: "#7a9a1a" },
    { id: "endocrino", nome: "Endocrinologia",            c: "#d1561b" },
    { id: "hemato",    nome: "Hematologia",               c: "#9c1f5c" },
    { id: "onco",      nome: "Oncologia",                 c: "#6b4bb8" },
    { id: "infecto",   nome: "Infectologia",              c: "#1d8a6e" },
    { id: "reumato",   nome: "Reumatologia",              c: "#b0479b" },
    { id: "neuro",     nome: "Neurologia",                c: "#3a5bd0" },
    { id: "uti",       nome: "Terapia intensiva",         c: "#d0312d" },
    { id: "geria",     nome: "Geriatria e paliativos",    c: "#7d6a55" },
    { id: "farmaco",   nome: "Farmacologia e prescrição", c: "#0f8fa1" },
    { id: "rotina",    nome: "Rotina e procedimentos",    c: "#5f6b78" },
    { id: "outros",    nome: "Outros",                    c: "#8a8f96" }
  ];
  var AREA_BY_ID = {};
  AREAS.forEach(function (a) { AREA_BY_ID[a.id] = a; });
  function areaOf(id) { return AREA_BY_ID[id] || AREA_BY_ID.outros; }

  function $(id) { return document.getElementById(id); }
  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function ms(iso) { var t = Date.parse(iso); return isNaN(t) ? 0 : t; }

  // ---------- armazenamento local ----------
  var store = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!("indexedDB" in window)) { reject(new Error("sem IndexedDB")); return; }
        var r = indexedDB.open("caderno", 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          if (!d.objectStoreNames.contains("notas")) d.createObjectStore("notas", { keyPath: "id" });
          if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
        };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
      return dbp;
    }
    function tx(name, mode, fn) {
      return open().then(function (d) {
        return new Promise(function (resolve, reject) {
          var t = d.transaction(name, mode), s = t.objectStore(name), out;
          var req = fn(s);
          if (req) req.onsuccess = function () { out = req.result; };
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error); };
        });
      });
    }
    // reserva em localStorage se o IndexedDB falhar
    var LS = "caderno-notas-reserva";
    function lsAll() { return lsGet(LS, []); }
    return {
      all: function () { return tx("notas", "readonly", function (s) { return s.getAll(); }).catch(function () { return lsAll(); }); },
      putMany: function (arr) {
        return tx("notas", "readwrite", function (s) { arr.forEach(function (n) { s.put(n); }); }).catch(function () {
          var map = {}; lsAll().forEach(function (n) { map[n.id] = n; }); arr.forEach(function (n) { map[n.id] = n; });
          lsSet(LS, Object.keys(map).map(function (k) { return map[k]; }));
        });
      },
      getMeta: function (k) { return tx("meta", "readonly", function (s) { return s.get(k); }).catch(function () { return lsGet("caderno-meta-" + k, null); }); },
      setMeta: function (k, v) { return tx("meta", "readwrite", function (s) { s.put(v, k); }).catch(function () { lsSet("caderno-meta-" + k, v); }); }
    };
  })();

  // ---------- estado ----------
  var state = { notes: new Map(), filter: "todas", q: "", editingId: null, confirmId: null };
  var sb = null, session = null, syncing = false, lastError = null, lastSyncAt = null, syncTimer = null;

  function cleanNote(d) {
    var tags = Array.isArray(d.tags) ? d.tags : (typeof d.tags === "string" ? d.tags.split(",") : []);
    var now = new Date().toISOString();
    return {
      id: String(d.id),
      area: AREA_BY_ID[d.area] ? d.area : "outros",
      titulo: String(d.titulo || "").slice(0, 300),
      texto: String(d.texto || "").slice(0, 20000),
      fonte: String(d.fonte || "").slice(0, 500),
      tags: tags.map(function (t) { return String(t).trim().replace(/^#/, ""); }).filter(Boolean).slice(0, 20),
      origem: d.origem === "claude" ? "claude" : "manual",
      apagado: !!d.apagado,
      criado: d.criado || now,
      atualizado: d.atualizado || d.criado || now,
      dirty: !!d.dirty
    };
  }
  function visibleNotes() {
    var arr = [];
    state.notes.forEach(function (n) { if (!n.apagado) arr.push(n); });
    return arr.sort(function (a, b) { return ms(b.criado) - ms(a.criado); });
  }
  function pendingCount() { var c = 0; state.notes.forEach(function (n) { if (n.dirty) c++; }); return c; }

  // ---------- texto ----------
  function norm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  function highlight(html, terms) {
    if (!terms.length) return html;
    return html.replace(/(<[^>]+>)|([^<]+)/g, function (m, tag, text) {
      if (tag) return tag;
      var nt = norm(text), out = "", i = 0;
      while (i < text.length) {
        var best = -1, len = 0;
        terms.forEach(function (t) { var p = nt.indexOf(t, i); if (p !== -1 && (best === -1 || p < best)) { best = p; len = t.length; } });
        if (best === -1) { out += text.slice(i); break; }
        out += text.slice(i, best) + "<mark>" + text.slice(best, best + len) + "</mark>";
        i = best + len;
      }
      return out;
    });
  }
  function fmtText(s, terms) { return highlight(esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"), terms); }
  function fmtDate(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Fortaleza" });
  }
  function fmtDateTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Fortaleza" });
  }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2300);
  }

  // ---------- render ----------
  function matches(n, terms) {
    if (!terms.length) return true;
    var hay = norm([n.titulo, n.texto, n.fonte, n.tags.join(" "), n.tags.map(function (t) { return "#" + t; }).join(" "), areaOf(n.area).nome].join(" "));
    return terms.every(function (t) { return hay.indexOf(t) !== -1; });
  }
  function renderTabs(list) {
    var counts = {}; list.forEach(function (n) { counts[n.area] = (counts[n.area] || 0) + 1; });
    var html = '<button class="tab" type="button" data-area="todas" aria-pressed="' + (state.filter === "todas") + '">Todas <span class="n">' + list.length + "</span></button>";
    AREAS.forEach(function (a) {
      html += '<button class="tab" type="button" data-area="' + a.id + '" style="--c:' + a.c + '" aria-pressed="' + (state.filter === a.id) + '">' +
        esc(a.nome) + ' <span class="n">' + (counts[a.id] || 0) + "</span></button>";
    });
    $("tabs").innerHTML = html;
  }
  function noteHTML(n, terms) {
    var a = areaOf(n.area);
    var tags = n.tags.map(function (t) { return '<button type="button" class="tagchip" data-tag="' + esc(t) + '">#' + esc(t) + "</button>"; }).join("");
    var confirming = state.confirmId === n.id;
    return '<article class="note" style="--c:' + a.c + '" data-id="' + esc(n.id) + '">' +
      '<div class="meta"><span class="area">' + esc(a.nome) + "</span><span>" + fmtDate(n.criado) + "</span>" +
      (n.origem === "claude" ? '<span class="via">via Claude</span>' : "") +
      (n.dirty && session ? '<span class="pend">a enviar</span>' : "") + "</div>" +
      (n.titulo ? "<h3>" + highlight(esc(n.titulo), terms) + "</h3>" : "") +
      (n.texto ? '<div class="txt">' + fmtText(n.texto, terms) + "</div>" : "") +
      (n.fonte ? '<div class="src">Fonte: ' + highlight(esc(n.fonte), terms) + "</div>" : "") +
      (tags ? '<div class="tags">' + tags + "</div>" : "") +
      (confirming
        ? '<div class="confirm">Excluir esta anotação? <button class="btn danger" type="button" data-act="del-yes">Excluir</button><button class="btn" type="button" data-act="del-no">Manter</button></div>'
        : '<div class="tools"><button class="btn ghost" type="button" data-act="copy">Copiar</button><button class="btn ghost" type="button" data-act="edit">Editar</button><button class="btn ghost" type="button" data-act="del">Excluir</button></div>') +
      "</article>";
  }
  function render() {
    var list = visibleNotes();
    renderTabs(list);
    var terms = norm(state.q).split(/\s+/).filter(Boolean);
    var shown = list.filter(function (n) { return (state.filter === "todas" || n.area === state.filter) && matches(n, terms); });
    $("listTitle").textContent = state.filter === "todas" ? "Todas as áreas" : areaOf(state.filter).nome;
    $("count").textContent = shown.length + (shown.length === 1 ? " anotação" : " anotações");
    var areas = new Set(list.map(function (n) { return n.area; })).size;
    $("sub").textContent = list.length
      ? list.length + (list.length === 1 ? " pérola" : " pérolas") + " em " + areas + (areas === 1 ? " área." : " áreas.")
      : "Pérolas da enfermaria, por área.";
    var box = $("notes");
    if (!shown.length) {
      box.innerHTML = list.length
        ? '<div class="empty"><strong>Nada encontrado.</strong>Tente outro termo ou volte para "Todas".</div>'
        : '<div class="empty"><strong>O caderno está vazio.</strong>Toque em "Nova anotação", ou peça ao Claude: "anota no caderno".</div>';
    } else {
      box.innerHTML = shown.map(function (n) { return noteHTML(n, terms); }).join("");
    }
    updateStatus();
  }

  function updateStatus() {
    var s = $("status"), pend = pendingCount(), text, kind = "";
    if (!sb) { text = "só neste aparelho"; }
    else if (!session) { text = "entrar para sincronizar"; kind = "warn"; }
    else if (syncing) { text = "sincronizando…"; }
    else if (lastError && lastError.auth) { text = "entre de novo"; kind = "warn"; }
    else if (!navigator.onLine || (lastError && lastError.net)) { text = pend ? "offline · " + pend + " a enviar" : "offline"; kind = "warn"; }
    else if (lastError) { text = "erro ao sincronizar"; kind = "warn"; }
    else if (pend) { text = pend + " a enviar"; kind = "warn"; }
    else { text = "sincronizado"; kind = "ok"; }
    s.textContent = text; s.className = "status" + (kind ? " " + kind : "");
    $("lastSync").textContent = lastSyncAt ? "Última sincronização: " + fmtDateTime(lastSyncAt) + (pend ? " · " + pend + " a enviar" : "") : "Ainda não sincronizou neste aparelho.";
  }

  // ---------- rotas por área ----------
  function applyHash() {
    var h = (location.hash || "").slice(1);
    state.filter = AREA_BY_ID[h] ? h : "todas";
    if (!state.editingId) $("f-area").value = state.filter === "todas" ? "cardio" : state.filter;
    render();
  }
  window.addEventListener("hashchange", applyHash);

  // ---------- eventos da lista ----------
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".tab"); if (!b) return;
    var a = b.getAttribute("data-area");
    if (a === "todas") { history.replaceState(null, "", location.pathname + location.search); applyHash(); }
    else location.hash = a;
  });
  var qTimer;
  $("q").addEventListener("input", function (e) { clearTimeout(qTimer); qTimer = setTimeout(function () { state.q = e.target.value; render(); }, 120); });

  $("notes").addEventListener("click", function (e) {
    var tag = e.target.closest(".tagchip");
    if (tag) { var v = "#" + tag.getAttribute("data-tag"); $("q").value = v; state.q = v; render(); return; }
    var btn = e.target.closest("[data-act]"); if (!btn) return;
    var id = btn.closest(".note").getAttribute("data-id");
    var n = state.notes.get(id); if (!n) return;
    var act = btn.getAttribute("data-act");
    if (act === "copy") copyText(noteToText(n));
    else if (act === "edit") startEdit(n);
    else if (act === "del") { state.confirmId = id; render(); }
    else if (act === "del-no") { state.confirmId = null; render(); }
    else if (act === "del-yes") { state.confirmId = null; removeNote(n); }
  });

  // ---------- formulário ----------
  function fillAreaSelect() {
    $("f-area").innerHTML = AREAS.map(function (a) { return '<option value="' + a.id + '">' + esc(a.nome) + "</option>"; }).join("");
  }
  function startEdit(n) {
    state.editingId = n.id;
    $("f-area").value = n.area; $("f-titulo").value = n.titulo; $("f-texto").value = n.texto;
    $("f-fonte").value = n.fonte; $("f-tags").value = n.tags.join(", ");
    $("composerTitle").textContent = "Editar anotação"; $("saveBtn").textContent = "Salvar alterações";
    $("cancelEdit").hidden = false; $("composer").open = true;
    $("composer").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    $("f-texto").focus();
  }
  function resetForm() {
    state.editingId = null;
    $("f-titulo").value = ""; $("f-texto").value = ""; $("f-fonte").value = ""; $("f-tags").value = "";
    $("composerTitle").textContent = "Nova anotação"; $("saveBtn").textContent = "Salvar no caderno";
    $("cancelEdit").hidden = true; $("formmsg").textContent = ""; $("formmsg").className = "formmsg";
    lsSet("caderno-rascunho", null);
  }
  $("cancelEdit").addEventListener("click", function () { resetForm(); $("f-area").value = state.filter === "todas" ? "cardio" : state.filter; });
  ["f-area", "f-titulo", "f-texto", "f-fonte", "f-tags"].forEach(function (id) {
    $(id).addEventListener("input", function () {
      if (state.editingId) return;
      lsSet("caderno-rascunho", { area: $("f-area").value, titulo: $("f-titulo").value, texto: $("f-texto").value, fonte: $("f-fonte").value, tags: $("f-tags").value });
    });
  });
  function newId() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, "0"); };
    return "n-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + "-" + Math.random().toString(36).slice(2, 6);
  }
  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var texto = $("f-texto").value.trim(), titulo = $("f-titulo").value.trim();
    if (!texto && !titulo) { $("formmsg").textContent = "Escreva a anotação antes de salvar."; $("formmsg").className = "formmsg err"; $("f-texto").focus(); return; }
    var now = new Date().toISOString();
    var old = state.editingId ? state.notes.get(state.editingId) : null;
    var n = cleanNote({
      id: old ? old.id : newId(), area: $("f-area").value, titulo: titulo, texto: texto,
      fonte: $("f-fonte").value.trim(), tags: $("f-tags").value,
      origem: old ? old.origem : "manual", criado: old ? old.criado : now, atualizado: now, dirty: true
    });
    resetForm();
    saveLocal([n]).then(function () { toast(old ? "Anotação atualizada." : "Salva no caderno."); scheduleSync(600); });
  });
  function removeNote(n) {
    var d = cleanNote(Object.assign({}, n, { apagado: true, atualizado: new Date().toISOString(), dirty: true }));
    saveLocal([d]).then(function () { toast("Anotação excluída."); scheduleSync(600); });
  }
  function saveLocal(arr) {
    arr.forEach(function (n) { state.notes.set(n.id, n); });
    render();
    return store.putMany(arr);
  }

  // ---------- sincronização ----------
  function timeoutFetch(input, init) {
    init = init || {};
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 15000);
    if (init.signal) init.signal.addEventListener("abort", function () { ctl.abort(); });
    return fetch(input, Object.assign({}, init, { signal: ctl.signal })).finally(function () { clearTimeout(t); });
  }
  function classify(err) {
    var msg = String((err && (err.message || err.error_description)) || err || "");
    var status = err && (err.status || err.code);
    var e = { message: msg };
    if (/fetch|network|abort|load failed|timed? ?out/i.test(msg) || err instanceof TypeError) e.net = true;
    else if (status === 401 || status === "PGRST301" || /jwt|token/i.test(msg)) e.auth = true;
    return e;
  }
  function toRow(n) {
    return { id: n.id, area: n.area, titulo: n.titulo, texto: n.texto, fonte: n.fonte, tags: n.tags, origem: n.origem, apagado: n.apagado, criado: n.criado, atualizado: n.atualizado };
  }
  function scheduleSync(delay) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, delay || 0); }

  function sync() {
    if (!sb || !session || syncing) { updateStatus(); return Promise.resolve(); }
    if (!navigator.onLine) { lastError = { net: true }; updateStatus(); return Promise.resolve(); }
    syncing = true; updateStatus();
    var sent = [];
    state.notes.forEach(function (n) { if (n.dirty) sent.push({ id: n.id, atualizado: n.atualizado, row: toRow(n) }); });

    var push = sent.length
      ? sb.from("notas").upsert(sent.map(function (s) { return s.row; }), { onConflict: "id" }).then(function (r) {
          if (r.error) throw r.error;
          var cleaned = [];
          sent.forEach(function (s) {
            var cur = state.notes.get(s.id);
            if (cur && cur.atualizado === s.atualizado) { cur = Object.assign({}, cur, { dirty: false }); state.notes.set(cur.id, cur); cleaned.push(cur); }
          });
          return store.putMany(cleaned);
        })
      : Promise.resolve();

    return push
      .then(function () { return store.getMeta("lastPull"); })
      .then(function (since) { return pull(since || "1970-01-01T00:00:00Z"); })
      .then(function () {
        lastError = null; lastSyncAt = new Date().toISOString();
        return store.setMeta("lastSyncAt", lastSyncAt);
      })
      .catch(function (err) { lastError = classify(err); })
      .then(function () { syncing = false; render(); });
  }
  function pull(since) {
    return sb.from("notas").select("id,area,titulo,texto,fonte,tags,origem,apagado,criado,atualizado,sincronizado")
      .gt("sincronizado", since).order("sincronizado", { ascending: true }).limit(500)
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [], changed = [];
        rows.forEach(function (row) {
          var local = state.notes.get(row.id);
          if (local && local.dirty && ms(local.atualizado) > ms(row.atualizado)) return; // a versão daqui é mais nova: será enviada
          var n = cleanNote(Object.assign({}, row, { dirty: false }));
          state.notes.set(n.id, n); changed.push(n);
        });
        var p = store.putMany(changed);
        if (!rows.length) return p;
        var next = rows[rows.length - 1].sincronizado;
        return p.then(function () { return store.setMeta("lastPull", next); }).then(function () {
          return rows.length === 500 ? pull(next) : null;
        });
      });
  }

  // ---------- conta ----------
  function setupSupabase() {
    var cfg = window.CADERNO_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase || !window.supabase.createClient) {
      $("cfgMsg").textContent = "A sincronização ainda não foi configurada neste app. As notas ficam salvas só neste aparelho.";
      $("loginForm").hidden = true;
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "caderno-auth" },
      global: { fetch: timeoutFetch }
    });
    sb.auth.onAuthStateChange(function (event, s) {
      var had = !!session; session = s || null;
      showAccount();
      if (session && (!had || event === "SIGNED_IN")) scheduleSync(0);
      updateStatus();
    });
    sb.auth.getSession().then(function (r) { session = (r && r.data && r.data.session) || null; showAccount(); if (session) scheduleSync(0); updateStatus(); });
  }
  function showAccount() {
    var inn = !!session;
    $("accountIn").hidden = !inn; $("accountOut").hidden = inn;
    if (inn) $("whoami").textContent = (session.user && session.user.email) || "";
  }
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault(); if (!sb) return;
    var email = $("l-email").value.trim(), senha = $("l-senha").value;
    if (!email || !senha) { $("loginMsg").textContent = "Preencha e-mail e senha."; return; }
    $("loginMsg").textContent = "Entrando…";
    sb.auth.signInWithPassword({ email: email, password: senha }).then(function (r) {
      if (r.error) { $("loginMsg").textContent = /invalid/i.test(r.error.message) ? "E-mail ou senha incorretos." : /confirm/i.test(r.error.message) ? "Confirme o e-mail pelo link que o Supabase enviou." : "Não consegui entrar: " + r.error.message; return; }
      $("loginMsg").textContent = ""; $("l-senha").value = ""; toast("Conectado. Sincronizando…");
    }, function () { $("loginMsg").textContent = "Sem conexão com o servidor. Tente fora da rede do hospital."; });
  });
  $("signupBtn").addEventListener("click", function () {
    if (!sb) return;
    var email = $("l-email").value.trim(), senha = $("l-senha").value;
    if (!email || senha.length < 8) { $("loginMsg").textContent = "Use um e-mail e uma senha de pelo menos 8 caracteres."; return; }
    $("loginMsg").textContent = "Criando conta…";
    sb.auth.signUp({ email: email, password: senha, options: { emailRedirectTo: location.href.split("#")[0] } }).then(function (r) {
      if (r.error) { $("loginMsg").textContent = "Não consegui criar: " + r.error.message; return; }
      $("loginMsg").textContent = r.data && r.data.session ? "Conta criada e conectada." : "Conta criada. Abra o link que chegou no seu e-mail e depois entre aqui.";
    }, function () { $("loginMsg").textContent = "Sem conexão com o servidor."; });
  });
  $("logoutBtn").addEventListener("click", function () {
    if (!sb) return;
    if (pendingCount() && !$("logoutBtn").dataset.sure) { $("logoutBtn").dataset.sure = "1"; $("logoutBtn").textContent = "Há notas a enviar. Sair mesmo?"; return; }
    delete $("logoutBtn").dataset.sure; $("logoutBtn").textContent = "Sair";
    sb.auth.signOut().finally(function () { session = null; showAccount(); updateStatus(); });
  });
  $("syncNow").addEventListener("click", function () { sync().then(function () { toast(lastError ? (lastError.net ? "Sem conexão com o servidor." : "Erro ao sincronizar.") : "Sincronizado."); }); });

  // ---------- painel ----------
  var dlg = $("settings");
  function openSettings() { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); }
  $("openSettings").addEventListener("click", openSettings);
  $("status").addEventListener("click", function () { if (session && !syncing) sync(); else openSettings(); });
  $("closeSettings").addEventListener("click", function () { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); });
  dlg.addEventListener("click", function (e) { if (e.target === dlg && dlg.close) dlg.close(); });

  // ---------- backup ----------
  function noteToText(n) { return ((n.titulo ? n.titulo + "\n" : "") + n.texto + (n.fonte ? "\nFonte: " + n.fonte : "")).trim(); }
  function toMarkdown() {
    var list = visibleNotes();
    var out = "# Caderno de Clínica\n\nExportado em " + new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }) + " · " + list.length + " anotações.\n";
    AREAS.forEach(function (a) {
      var items = list.filter(function (n) { return n.area === a.id; });
      if (!items.length) return;
      out += "\n## " + a.nome + "\n";
      items.forEach(function (n) {
        out += "\n### " + (n.titulo || n.texto.split("\n")[0].slice(0, 80)) + "\n\n" + n.texto + "\n";
        if (n.fonte) out += "\n_Fonte: " + n.fonte + "_\n";
        if (n.tags.length) out += "\n" + n.tags.map(function (t) { return "#" + t; }).join(" ") + "\n";
        out += "\n" + fmtDate(n.criado) + "\n";
      });
    });
    return out;
  }
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(function () { toast("Copiado."); }, function () { toast("Não consegui copiar."); });
    else toast("Não consegui copiar.");
  }
  $("copyAllBtn").addEventListener("click", function () { copyText(toMarkdown()); });
  $("exportBtn").addEventListener("click", function () {
    var name = "caderno-clinica-" + new Date().toISOString().slice(0, 10) + ".md";
    var blob = new Blob([toMarkdown()], { type: "text/markdown" });
    try {
      var file = new File([blob], name, { type: "text/markdown" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: "Caderno de Clínica" }).catch(function () {});
        return;
      }
    } catch (e) {}
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  });

  // ---------- instalação ----------
  var standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone && !lsGet("caderno-instalar-ok", false)) $("installBanner").hidden = false;
  $("dismissInstall").addEventListener("click", function () { $("installBanner").hidden = true; lsSet("caderno-instalar-ok", true); });
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  // ---------- gatilhos de sincronização ----------
  window.addEventListener("online", function () { lastError = null; scheduleSync(500); });
  window.addEventListener("offline", function () { updateStatus(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") scheduleSync(300); });
  setInterval(function () { if (document.visibilityState === "visible") sync(); }, 5 * 60 * 1000);

  // ---------- início ----------
  fillAreaSelect();
  var draft = lsGet("caderno-rascunho", null);
  store.all().then(function (arr) {
    (arr || []).forEach(function (n) { if (n && n.id) state.notes.set(n.id, cleanNote(n)); });
    return store.getMeta("lastSyncAt");
  }).then(function (t) { lastSyncAt = t || null; }).catch(function () {}).then(function () {
    applyHash();
    if (draft && (draft.texto || draft.titulo)) {
      if (AREA_BY_ID[draft.area]) $("f-area").value = draft.area;
      $("f-titulo").value = draft.titulo || ""; $("f-texto").value = draft.texto || "";
      $("f-fonte").value = draft.fonte || ""; $("f-tags").value = draft.tags || "";
      $("composer").open = true; $("formmsg").textContent = "Rascunho recuperado.";
    }
    setupSupabase();
  });
})();
