/* Interfaccia della piattaforma: pagine, navigazione e azioni. */
(function () {
  'use strict';

  // Versione del sito: deve coincidere con data-v in index.html. Se Safari ha in
  // memoria una pagina principale vecchia, la ricarichiamo (una volta) aggirando la cache.
  var VERSION = '20261020a';
  if (document.documentElement.getAttribute('data-v') !== VERSION) {
    var tried = false;
    try { tried = sessionStorage.getItem('reload-v') === VERSION; sessionStorage.setItem('reload-v', VERSION); } catch (e) { /* ignora */ }
    if (!tried) {
      location.replace(location.pathname + '?v=' + VERSION + Date.now().toString(36) + location.hash);
      return;
    }
  }

  var CFG = window.APP_CONFIG;
  var Api = window.Api;
  var root = document.getElementById('app');
  var state = { user: null, since: null, favs: [], newCounts: {} };

  var KINDS = {
    pdf: { label: 'PDF', plural: 'PDF', icon: 'file-pdf' },
    image: { label: 'Immagine', plural: 'Immagini', icon: 'image' },
    audio: { label: 'Audio', plural: 'Audio', icon: 'audio' },
    video: { label: 'Video', plural: 'Video', icon: 'video' },
    document: { label: 'Documento', plural: 'Documenti', icon: 'doc' },
    other: { label: 'Archivio', plural: 'Altro', icon: 'archive' },
  };
  var MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  // ---- Utilità -----------------------------------------------------------------
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name) { return '<svg><use href="#i-' + name + '"/></svg>'; }
  function isAdmin() { return Boolean(state.user && state.user.role === 'admin'); }
  function bytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0).replace('.', ',') + ' ' + u[i];
  }
  function date(s) { if (!s) return '—'; var d = new Date(s); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function dateTime(s) {
    if (!s) return '—';
    var d = new Date(s);
    return date(s) + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function initials(name) {
    return String(name || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(function (p) { return p[0].toUpperCase(); }).join('');
  }
  function toast(text, type) {
    var box = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'flash flash-' + (type || 'success');
    el.setAttribute('role', 'status');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 4200);
    setTimeout(function () { el.remove(); }, 4700);
  }
  function fail(err) { toast(Api.friendlyError(err), 'error'); }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function parseHash() {
    var h = location.hash.replace(/^#/, '') || '/';
    var qi = h.indexOf('?');
    var path = qi >= 0 ? h.slice(0, qi) : h;
    var params = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
    return { path: path, params: params };
  }
  function qs(params) {
    var p = new URLSearchParams();
    Object.keys(params).forEach(function (k) { if (params[k]) p.set(k, params[k]); });
    var s = p.toString();
    return s ? '?' + s : '';
  }

  // ---- Struttura della pagina ------------------------------------------------------
  function shell(active, body) {
    var u = state.user;
    var nav = function (href, key, ic, label) {
      return '<a href="' + href + '" class="' + (active === key ? 'active' : '') + '">' + icon(ic) + label + '</a>';
    };
    return '' +
      (Api.demo ? '<div class="demo-bar">Modalità anteprima: i dati sono di esempio e restano solo su questo dispositivo.</div>' : '') +
      '<aside class="sidebar" id="sidebar">' +
        '<a class="brand" href="#/">' +
          '<svg class="brand-crest"><use href="#i-crest"/></svg>' +
          '<span class="brand-text"><strong>' + esc(CFG.platformName) + '</strong><small>' + esc(CFG.universityName) + '</small></span>' +
        '</a>' +
        '<nav class="nav">' +
          '<p class="nav-label">Didattica</p>' +
          nav('#/', 'home', 'home', 'Dashboard') +
          '<div class="nav-row">' + nav('#/corsi', 'courses', 'book', 'Corsi') +
            '<button class="nav-toggle' + (navCoursesOpen(active) ? ' open' : '') + '" type="button" data-action="toggle-nav-courses" aria-expanded="' + navCoursesOpen(active) + '" aria-label="Mostra gli anni di corso">' + icon('chevron') + '</button></div>' +
          '<div class="nav-tree' + (navCoursesOpen(active) ? ' open' : '') + '" aria-label="Anno di corso"><p class="nav-sub-label">Anno di corso</p>' +
            DEGREES.map(function (d) {
              return '<span class="nav-group">' + d.label + '</span>' + d.years.map(function (y) {
                var key = d.key + ':' + y;
                return '<a class="nav-leaf' + (active === 'courses' && currentPlace === key ? ' active' : '') + '" href="#/corsi?laurea=' + d.key + '&anno=' + y + '">' + y + '° anno</a>';
              }).join('');
            }).join('') + '</div>' +
          nav('#/cerca', 'search', 'search', 'Cerca materiali') +
          nav('#/miei', 'mine', 'upload', 'I miei caricamenti') +
          nav('#/classifica', 'ranking', 'trophy', 'Classifica') +
          '<p class="nav-label">Corso di studi</p>' +
          nav('#/rappresentanti', 'reps', 'users', 'Rappresentanti') +
          nav('#/professori', 'profs', 'user', 'Professori') +
          (isAdmin() ? '<p class="nav-label">Gestione</p>' + nav('#/admin', 'admin', 'shield', 'Amministrazione') : '') +
        '</nav>' +
        '<div class="sidebar-foot">' + icon('lock') + '<span>Accesso riservato agli account @' + esc(CFG.allowedDomain) + '</span></div>' +
      '</aside>' +
      '<div class="sidebar-backdrop" data-action="close-sidebar"></div>' +
      '<div class="main-wrap">' +
        '<header class="topbar">' +
          '<button class="icon-btn menu-btn" type="button" data-action="toggle-sidebar" aria-label="Apri menu">' + icon('menu') + '</button>' +
          '<form class="top-search" data-form="top-search" role="search">' + icon('search') +
            '<input type="search" name="q" placeholder="Cerca lezioni, dispense, registrazioni…" aria-label="Cerca" enterkeyhint="search">' +
          '</form>' +
          themeButton() +
          '<div class="user-menu">' +
            '<button class="user-btn" type="button" data-action="toggle-menu" aria-haspopup="true" aria-expanded="false">' +
              '<span class="avatar">' + esc(initials(u.name)) + '</span>' +
              '<span class="user-meta"><strong>' + esc(u.name) + '</strong><small>' + (isAdmin() ? 'Amministratore' : 'Studente') + '</small></span>' +
            '</button>' +
            '<div class="dropdown" role="menu">' +
              '<div class="dropdown-head"><strong>' + esc(u.name) + '</strong><small>' + esc(u.email) + '</small></div>' +
              '<a href="#/miei" role="menuitem">' + icon('upload') + 'I miei caricamenti</a>' +
              (isStandalone() ? '' : '<button type="button" role="menuitem" data-action="install-app">' + icon('phone') + 'Installa l\'app sul telefono</button>') +
              '<button type="button" role="menuitem" data-action="logout">' + icon('logout') + 'Esci</button>' +
            '</div>' +
          '</div>' +
        '</header>' +
        '<main id="main" class="content">' + body + '</main>' +
        '<footer class="footer"><span>' + esc(CFG.platformName) + ' · ' + esc(CFG.universityName) + '</span>' +
          credit() +
          '<span>' + esc(CFG.disclaimer || 'Materiali condivisi dagli studenti per uso didattico') + ' · <a href="privacy.html">Privacy</a></span></footer>' +
      '</div>';
  }

  // Pulsante modalità chiara/scura (l'icona mostra la modalità in cui si passa)
  function themeButton(extra) {
    var dark = window.Theme && window.Theme.current() === 'dark';
    var label = dark ? 'Passa alla modalità chiara' : 'Passa alla modalità scura';
    return '<button class="icon-btn theme-btn' + (extra ? ' ' + extra : '') + '" type="button" data-action="toggle-theme" title="' + label + '" aria-label="' + label + '">' +
      icon(dark ? 'sun' : 'moon') + '</button>';
  }
  function refreshThemeButtons() {
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      var tmp = document.createElement('div');
      tmp.innerHTML = themeButton(b.classList.contains('login-theme') ? 'login-theme' : '');
      b.replaceWith(tmp.firstChild);
    });
  }

  // File caricati da altri dopo la mia ultima visita
  function isNew(f) { return Boolean(state.since && f.created_at > state.since && f.uploaded_by !== state.user.id); }
  function isFav(id) { return state.favs.indexOf(Number(id)) >= 0; }
  // ids = tutti gli anni accademici del corso: la stellina è accesa se uno di essi è tra i preferiti
  function favButton(id, extra, ids) {
    ids = ids || [id];
    var on = ids.some(isFav);
    return '<button class="fav-btn' + (on ? ' on' : '') + (extra ? ' ' + extra : '') + '" type="button" data-action="toggle-fav" data-id="' + id + '" data-ids="' + ids.join(',') + '"' +
      ' aria-pressed="' + on + '" title="' + (on ? 'Togli dai preferiti' : 'Aggiungi ai preferiti') + '" aria-label="' + (on ? 'Togli dai preferiti' : 'Aggiungi ai preferiti') + '">' + icon('star') + '</button>';
  }
  function topFolder(f) { return f.folder ? String(f.folder).split(' / ')[0] : ''; }

  // Chi ha caricato il file: il profilo, oppure il nome dell'autore sul vecchio Drive finché non si iscrive
  function authorOf(f) { return f.uploader ? f.uploader.name : (f.author_name || 'utente rimosso'); }
  // Nome cliccabile: porta alla pagina con tutto ciò che quella persona ha pubblicato
  function authorLink(f) {
    if (f.uploaded_by && f.uploader) return '<a class="meta-link" href="#/utente/' + f.uploaded_by + '">' + esc(f.uploader.name) + '</a>';
    if (f.author_name) return '<a class="meta-link" href="#/autore?nome=' + encodeURIComponent(f.author_name) + '">' + esc(f.author_name) + '</a>';
    return esc(authorOf(f));
  }

  function credit() {
    return '<span class="credit">Fatto con <span class="heart" aria-label="amore">♥</span> da <strong>Aleksey Symonenko</strong></span>';
  }

  var currentPlace = '';
  // Lo stesso insegnamento esiste una volta per ogni anno accademico (una riga di "courses" per anno).
  // Nelle liste lo mostro una sola volta; l'anno accademico si sceglie dentro il corso.
  function groupKey(c) { return (c.degree || '') + '|' + String(c.name || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function byAA(a, b) { return (b.aa || '').localeCompare(a.aa || ''); } // dal più recente; senza anno in fondo
  function groupCourses(list) {
    var map = {}, out = [];
    list.forEach(function (c) {
      c.aa = Api.normAA(c.year);
      var k = groupKey(c);
      if (!map[k]) { map[k] = { key: k, members: [] }; out.push(map[k]); }
      map[k].members.push(c);
    });
    out.forEach(function (g) {
      g.members.sort(byAA);
      // si apre l'anno più recente che ha materiali
      var p = g.members.filter(function (c) { return c.file_count > 0; })[0] || g.members[0];
      g.primary = p;
      g.id = p.id; g.name = p.name; g.code = p.code; g.teacher = p.teacher; g.color = g.members[0].color;
      g.degree = p.degree; g.study_year = p.study_year;
      g.ids = g.members.map(function (c) { return c.id; });
      g.file_count = g.members.reduce(function (n, c) { return n + (c.file_count || 0); }, 0);
      g.new_count = g.members.reduce(function (n, c) { return n + (state.newCounts[c.id] || 0); }, 0);
    });
    return out;
  }
  function aaShort(aa) { return aa ? aa.slice(0, 5) + aa.slice(7) : ''; } // "2025/2026" → "2025/26"
  function navCoursesOpen(active) {
    var pref = null;
    try { pref = localStorage.getItem('nav-courses'); } catch (e) { /* ignora */ }
    return pref === null ? active === 'courses' : pref === '1';
  }
  // Corsi aperti di recente da questo utente: salvati sull'account (uguali su ogni
  // dispositivo); la copia locale serve solo se il database non è ancora aggiornato.
  function recentKey() { return 'recent-courses:' + (state.user ? state.user.id : ''); }
  function recentCourseIds() {
    try { return JSON.parse(localStorage.getItem(recentKey()) || '[]').map(Number).filter(Boolean); } catch (e) { return []; }
  }
  function rememberCourse(id) {
    id = Number(id);
    if (!id) return;
    var ids = [id].concat(recentCourseIds().filter(function (x) { return x !== id; })).slice(0, 12);
    try { localStorage.setItem(recentKey(), JSON.stringify(ids)); } catch (e) { /* ignora */ }
    Api.recordCourseVisit(id);
  }
  // Anno accademico in corso: da settembre si passa al successivo
  function currentAA() {
    var d = new Date();
    var y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
    return y + '/' + (y + 1);
  }
  function aaOptions(selected) {
    var start = Number(currentAA().slice(0, 4));
    var list = [];
    for (var y = start + 1; y >= start - 6; y--) list.push(y + '/' + (y + 1));
    if (selected && list.indexOf(selected) < 0) list.push(selected);
    return '<option value=""' + (!selected ? ' selected' : '') + '>Non indicato</option>' +
      list.map(function (v) { return '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + v + (v === currentAA() ? ' (in corso)' : '') + '</option>'; }).join('');
  }
  function render(active, body, title) {
    document.title = (title ? title + ' · ' : '') + CFG.platformName;
    root.innerHTML = shell(active, body);
    document.body.classList.remove('sidebar-open');
    root.querySelectorAll('[data-width]').forEach(function (el) { el.style.width = el.getAttribute('data-width') + '%'; });
    window.scrollTo(0, 0);
  }

  function loading(active) { render(active, '<div class="boot"><div class="spinner"></div></div>'); }

  function empty(ic, text, action) {
    return '<div class="empty">' + icon(ic) + '<p>' + text + '</p>' + (action || '') + '</div>';
  }

  // Collocazione dei corsi: laurea triennale (3 anni) e magistrale (2 anni)
  var DEGREES = [
    { key: 'triennale', label: 'Triennale', years: [1, 2, 3] },
    { key: 'magistrale', label: 'Magistrale', years: [1, 2] },
  ];
  function placementOf(c) { return c.degree && c.study_year ? c.degree + ':' + c.study_year : ''; }
  function placementLabel(v) {
    if (!v) return 'Da assegnare';
    var p = v.split(':');
    return (p[0] === 'magistrale' ? 'Magistrale' : 'Triennale') + ' · ' + p[1] + '° anno';
  }
  function placementOptions(selected) {
    var opts = [];
    DEGREES.forEach(function (d) {
      d.years.forEach(function (y) {
        var v = d.key + ':' + y;
        opts.push('<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + placementLabel(v) + '</option>');
      });
    });
    opts.push('<option value=""' + (!selected ? ' selected' : '') + '>Da assegnare</option>');
    return opts.join('');
  }
  // Menu "⋯" del corso (solo admin): modifica e spostamento in un altro anno
  function courseMenu(c, extraClass) {
    var here = placementOf(c);
    var ids = (c.ids || [c.id]).join(',');
    var places = [];
    DEGREES.forEach(function (d) { d.years.forEach(function (y) { places.push(d.key + ':' + y); }); });
    places.push('');
    return '<div class="course-menu ' + (extraClass || '') + '">' +
      '<button class="kebab" type="button" data-action="course-menu" aria-haspopup="true" aria-label="Opzioni del corso ' + esc(c.name) + '">' + icon('dots') + '</button>' +
      '<div class="course-menu-pop" role="menu">' +
        '<a role="menuitem" href="#/modifica-corso/' + c.id + '">' + icon('edit') + 'Modifica corso</a>' +
        '<p class="menu-label">Sposta in</p>' +
        places.map(function (v) {
          var cur = v === here;
          return '<button role="menuitem" type="button" class="' + (cur ? 'current' : '') + '"' + (cur ? ' disabled' : '') +
            ' data-action="move-course" data-id="' + c.id + '" data-ids="' + ids + '" data-place="' + v + '">' + icon(cur ? 'check' : 'folder') + placementLabel(v) + '</button>';
        }).join('') +
      '</div></div>';
  }
  // c = gruppo di corsi (tutti gli anni accademici dello stesso insegnamento)
  function courseItem(c) {
    return '<div class="course-item' + (isAdmin() ? ' has-menu' : '') + '">' + courseCard(c) + favButton(c.id, '', c.ids) + (isAdmin() ? courseMenu(c) : '') + '</div>';
  }
  // Senza menu ⋯ (dashboard)
  function courseTile(c) { return '<div class="course-item">' + courseCard(c) + favButton(c.id, '', c.ids) + '</div>'; }

  // Ordinamento dei file nella pagina del corso
  var ORDERS = {
    recenti: { label: 'Più recenti', sort: function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); } },
    aperti: { label: 'Più aperti', sort: function (a, b) { return (b.open_count || 0) - (a.open_count || 0) || String(b.created_at).localeCompare(String(a.created_at)); } },
    votati: { label: 'Più votati', sort: function (a, b) { return (b.vote_count || 0) - (a.vote_count || 0) || (b.open_count || 0) - (a.open_count || 0); } },
    nome: { label: 'Nome (A–Z)', sort: function (a, b) { return String(a.title).localeCompare(String(b.title), 'it', { numeric: true }); } },
  };
  var currentCourseFiles = []; // file del corso aperto (per l'avviso doppioni)

  var YEAR_PREVIEW = 6; // corsi visibili per anno di corso prima di "Mostra altri"

  function courseCard(c) {
    var aas = (c.members || [c]).map(function (m) { return m.aa; }).filter(Boolean);
    var when = aas.length > 1 ? aas.length + ' anni accademici' : aas.length ? 'A.A. ' + aaShort(aas[0]) : '';
    var fresh = c.members ? c.new_count : state.newCounts[c.id];
    return '<a class="course-card" href="#/corso/' + c.id + '">' +
      '<div class="course-cover cover-' + (c.color % 8) + '"><span class="course-code">' + esc(c.code || 'CORSO') + '</span>' +
      '<svg class="cover-ic"><use href="#i-book"/></svg></div>' +
      '<div class="course-info"><h3>' + esc(c.name) + '</h3>' +
      '<p class="muted">' + (c.teacher ? 'Prof. ' + esc(c.teacher) : 'Docente non indicato') + (when ? ' · ' + esc(when) : '') + '</p>' +
      '<div class="course-foot"><span>' + icon('folder') + c.file_count + ' ' + (c.file_count === 1 ? 'materiale' : 'materiali') + '</span>' +
        (fresh ? '<span class="badge-new">+' + fresh + ' nuov' + (fresh === 1 ? 'o' : 'i') + '</span>' : '') + '</div>' +
      '</div></a>';
  }

  function fileItem(f, withCourse, withAA) {
    var k = KINDS[f.kind] || KINDS.other;
    return '<li class="file-item">' +
      '<a class="file-thumb kind-' + f.kind + '" href="#/file/' + f.id + '" tabindex="-1" aria-hidden="true">' +
        (f.kind === 'image' && f.storage === 'supabase' ? '<img alt="" data-thumb="' + f.id + '">' : icon(k.icon)) + '</a>' +
      '<div class="file-body">' +
        '<a class="file-title" href="#/file/' + f.id + '">' + esc(f.title) + '</a>' + (isNew(f) ? '<span class="badge-new">Nuovo</span>' : '') +
        '<div class="file-meta"><span class="tag kind-' + f.kind + '">' + k.label + '</span>' +
          (withAA && f.aa ? '<span class="tag tag-aa">' + esc(aaShort(f.aa)) + '</span>' : '') +
          (withCourse && f.course ? '<a class="meta-link" href="#/corso/' + f.course.id + '">' + esc(f.course.name) + '</a><span class="dot">·</span>' : '') +
          (f.folder ? '<span class="meta-folder">' + icon('folder') + esc(f.folder) + '</span><span class="dot">·</span>' : '') +
          '<span>' + bytes(f.size) + '</span><span class="dot">·</span><span>' + date(f.created_at) + '</span>' +
          '<span class="dot">·</span><span>di ' + authorLink(f) + '</span>' +
          (f.vote_count ? '<span class="dot">·</span><span class="meta-votes" title="Votato utile">' + icon('thumb') + f.vote_count + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="file-actions">' +
        '<button class="icon-btn" type="button" data-action="download" data-id="' + f.id + '" title="Scarica" aria-label="Scarica ' + esc(f.title) + '">' + icon('download') + '</button>' +
        (isAdmin() ? '<button class="icon-btn danger" type="button" data-action="delete-file" data-id="' + f.id + '" title="Elimina" aria-label="Elimina ' + esc(f.title) + '">' + icon('trash') + '</button>' : '') +
      '</div></li>';
  }

  var fileCache = {};
  function fileList(files, withCourse, withAA) {
    files.forEach(function (f) { fileCache[f.id] = f; });
    return '<ul class="file-list">' + files.map(function (f) { return fileItem(f, withCourse, withAA); }).join('') + '</ul>';
  }
  // Miniature delle immagini caricate dopo il rendering (URL firmati temporanei)
  function loadThumbs() {
    root.querySelectorAll('img[data-thumb]').forEach(function (img) {
      var f = fileCache[img.getAttribute('data-thumb')];
      if (f) Api.fileUrl(f, false).then(function (url) { img.src = url; }).catch(function () {});
    });
  }

  // ---- Pagine -------------------------------------------------------------------------
  function loginPage(error) {
    document.title = 'Accesso · ' + CFG.platformName;
    root.innerHTML = '' +
      '<div class="login-grid">' +
        '<section class="login-hero"><div class="hero-pattern" aria-hidden="true"></div>' +
          '<a class="brand brand-lg" href="#/"><svg class="brand-crest"><use href="#i-crest"/></svg>' +
            '<span class="brand-text"><strong>' + esc(CFG.platformName) + '</strong><small>' + esc(CFG.universityName) + '</small></span></a>' +
          '<div class="hero-copy"><p class="eyebrow">Piattaforma didattica</p>' +
            '<h1>Tutti i materiali dei tuoi corsi, in un unico luogo.</h1>' +
            '<p class="lead">Dispense, slide, registrazioni delle lezioni e immagini condivise dagli studenti.</p>' +
            '<ul class="hero-features">' +
              '<li><span class="feat-ic">' + icon('file-pdf') + '</span>PDF e dispense consultabili direttamente nel browser</li>' +
              '<li><span class="feat-ic">' + icon('audio') + '</span>Registrazioni audio e video con player integrato</li>' +
              '<li><span class="feat-ic">' + icon('users') + '</span>Ogni studente può contribuire caricando materiale</li>' +
            '</ul></div>' +
          '<p class="hero-foot">' + esc(CFG.disclaimer || '') + ' · <a href="privacy.html">Informativa privacy</a><br>' + credit() + '</p>' +
        '</section>' +
        '<section class="login-panel">' + themeButton('login-theme') + '<div class="login-card">' +
          '<h2>Accedi</h2>' +
          '<p class="muted">Entra con il tuo account istituzionale <strong>@' + esc(CFG.allowedDomain) + '</strong>.</p>' +
          (error ? '<div class="flash flash-error">' + esc(error) + '</div>' : '') +
          (Api.demo ? '<div class="dev-banner"><strong>Modalità anteprima</strong>Il sito non è ancora collegato a Supabase: puoi provarlo con dati di esempio.</div>' : '') +
          '<button class="btn btn-primary btn-block btn-sso" type="button" data-action="login">' +
            '<svg class="google-g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>' +
            (Api.demo ? 'Entra in anteprima' : 'Accedi con l\'account @' + esc(CFG.allowedDomain)) +
          '</button>' +
          '<div class="privacy-note">' + icon('shield') + '<p><strong>La tua password resta a Google e all\'Ateneo.</strong>' +
            'Il login avviene sulla pagina ufficiale di Google: questo sito non vede né salva la tua password, ' +
            'riceve solo nome ed email istituzionale per verificare che tu sia uno studente.</p></div>' +
        '</div></section>' +
      '</div>';
  }

  async function dashboardPage() {
    loading('home');
    var res = await Promise.all([Api.stats(), Api.listCourses(), Api.listFiles({ limit: 8 }), Api.listFiles({ mine: true, limit: 300 }),
      Api.recentCourses().catch(function () { return null; })]);
    var stats = res[0], courses = res[1], recent = res[2], mine = res[3], visited = res[4] && res[4].length ? res[4] : recentCourseIds();
    // un riquadro per insegnamento, qualunque sia l'anno accademico preferito o aperto
    var groups = groupCourses(courses);
    var byId = {};
    groups.forEach(function (g) { g.members.forEach(function (c) { byId[c.id] = g; }); });
    var uniq = function (list) { return list.filter(function (g, i) { return g && list.indexOf(g) === i; }); };
    // prima i preferiti ⭐, poi i corsi aperti di recente
    var favCourses = uniq(state.favs.map(function (id) { return byId[id]; }));
    var top = favCourses.slice();
    uniq(visited.map(function (id) { return byId[id]; })).forEach(function (c) { if (top.length < 6 && top.indexOf(c) < 0) top.push(c); });
    var hasRecent = top.length > 0;
    // Se ne mancano, completiamo con i corsi con più materiali
    groups.slice().sort(function (a, b) { return b.file_count - a.file_count; }).forEach(function (c) {
      if (top.length < 6 && top.indexOf(c) < 0) top.push(c);
    });
    var first = String(state.user.name).split(' ')[0];
    render('home',
      '<section class="welcome"><div><p class="eyebrow">Bentornato/a</p><h1>' + esc(first) + ', cosa studiamo oggi?</h1>' +
        '<p class="muted">Consulta i materiali dei corsi o condividi i tuoi appunti con i colleghi.</p></div>' +
        '<div class="welcome-actions"><a class="btn btn-primary" href="#/corsi">' + icon('book') + 'Sfoglia i corsi</a>' +
        '<a class="btn btn-ghost" href="#/nuovo-corso">' + icon('plus') + 'Nuovo corso</a></div></section>' +
      '<section class="stats">' +
        stat('book', stats.courses, 'Corsi') + stat('folder', stats.files, 'Materiali') +
        stat('users', stats.users, 'Studenti iscritti') + stat('upload', mine.length, 'I tuoi contributi') +
      '</section>' +
      // corsi a tutta larghezza, sotto i caricamenti recenti
      '<div class="dash-stack">' +
        '<section class="panel"><div class="panel-head"><h2>' + (favCourses.length ? 'I tuoi corsi' : hasRecent ? 'Aperti di recente' : 'Corsi in evidenza') + '</h2><a class="link" href="#/corsi">Tutti i corsi →</a></div>' +
          (!favCourses.length ? '<p class="muted small dash-hint">' + icon('star') + 'Tocca la stellina su un corso per tenerlo sempre qui in cima.</p>' : '') +
          (top.length ? '<div class="course-grid dash-courses">' + top.map(courseTile).join('') + '</div>'
            : empty('book', 'Non ci sono ancora corsi.', '<a class="btn btn-primary" href="#/nuovo-corso">' + icon('plus') + 'Crea il primo corso</a>')) +
        '</section>' +
        '<section class="panel"><div class="panel-head"><h2>Caricati di recente</h2><a class="link" href="#/cerca">Cerca →</a></div>' +
          (recent.length ? fileList(recent, true) : empty('clock', 'Nessun materiale caricato finora.')) +
        '</section>' +
      '</div>', 'Dashboard');
    loadThumbs();
  }
  function stat(ic, n, label) {
    return '<div class="stat"><span class="stat-ic">' + icon(ic) + '</span><div><strong>' + esc(n) + '</strong><small>' + label + '</small></div></div>';
  }

  async function coursesPage(params) {
    currentPlace = '';
    loading('courses');
    var q = (params.get('q') || '').toLowerCase();
    // un riquadro per insegnamento: l'anno accademico si sceglie dentro il corso
    var all = groupCourses(await Api.listCourses());
    var unassigned = all.filter(function (c) { return !placementOf(c); });
    var onlyYear = Number(params.get('anno')) || 0;
    var view = params.get('laurea');
    if (['triennale', 'magistrale', 'da-assegnare'].indexOf(view) < 0) view = 'triennale';
    if (view === 'da-assegnare' && !unassigned.length) view = 'triennale';
    var count = function (deg) { return all.filter(function (c) { return c.degree === deg; }).length; };

    var head = '<div class="page-head"><div><p class="eyebrow">Catalogo</p><h1>Corsi</h1>' +
      '<p class="muted">Scegli un insegnamento: dentro trovi i materiali divisi per anno accademico.</p></div>' +
      '<a class="btn btn-primary" href="#/nuovo-corso' + (view !== 'da-assegnare' ? '?posto=' + view + ':' + (onlyYear || 1) : '') + '">' + icon('plus') + 'Nuovo corso</a></div>' +
      '<div class="courses-toolbar">' +
      '<form class="filter-bar" data-form="filter-courses"><div class="input-ic">' + icon('search') +
      '<input type="search" name="q" value="' + esc(params.get('q') || '') + '" placeholder="Cerca un corso per nome, codice o docente"></div>' +
      '<button class="btn btn-ghost" type="submit">Cerca</button></form></div>';

    var body;
    if (q) {
      var found = all.filter(function (g) {
        return g.members.some(function (c) { return [c.name, c.code, c.teacher].some(function (v) { return (v || '').toLowerCase().indexOf(q) >= 0; }); });
      });
      body = found.length
        ? '<p class="muted small results-count">' + found.length + ' cors' + (found.length === 1 ? 'o' : 'i') + ' trovat' + (found.length === 1 ? 'o' : 'i') + ' · <a href="#/corsi">mostra tutti</a></p>' +
          '<div class="course-grid">' + found.map(function (c) { return courseItem(c); }).join('') + '</div>'
        : '<div class="panel">' + empty('book', 'Nessun corso corrisponde alla ricerca.') + '</div>';
    } else if (!all.length) {
      body = '<div class="panel">' + empty('book', 'Non ci sono ancora corsi.',
        '<a class="btn btn-primary" href="#/nuovo-corso">' + icon('plus') + 'Crea un corso</a>') + '</div>';
    } else {
      var seg = '<nav class="degree-tabs" aria-label="Corso di laurea">' +
        DEGREES.map(function (d) {
          // l'anno di corso scelto resta passando da triennale a magistrale (se esiste anche lì)
          var keepYear = onlyYear && d.years.indexOf(onlyYear) >= 0 ? '&anno=' + onlyYear : '';
          return '<a href="#/corsi?laurea=' + d.key + keepYear + '" class="' + (view === d.key ? 'active' : '') + '">' +
            '<strong>Laurea ' + d.label + '</strong><span>' + count(d.key) + ' cors' + (count(d.key) === 1 ? 'o' : 'i') + '</span></a>';
        }).join('') +
        (unassigned.length ? '<a href="#/corsi?laurea=da-assegnare" class="unassigned ' + (view === 'da-assegnare' ? 'active' : '') + '"><strong>Da assegnare</strong><span>' + unassigned.length + '</span></a>' : '') +
        '</nav>';
      if (view === 'da-assegnare') {
        body = seg + '<section class="year-section"><div class="year-head"><h2>Corsi da assegnare</h2>' +
          (isAdmin() ? '<span class="muted small">Usa il menu ⋯ su ogni corso per spostarlo nell\'anno giusto</span>' : '') + '</div>' +
          '<div class="course-grid">' + unassigned.map(courseItem).join('') + '</div></section>';
      } else {
        var deg = DEGREES.filter(function (d) { return d.key === view; })[0];
        if (deg.years.indexOf(onlyYear) < 0) onlyYear = 0;
        currentPlace = onlyYear ? deg.key + ':' + onlyYear : '';
        var crumbs = '<nav class="crumbs" aria-label="Percorso">' +
          '<a href="#/corsi">Anno di corso</a><span>›</span>' +
          (onlyYear ? '<a href="#/corsi?laurea=' + deg.key + '">' + deg.label + '</a><span>›</span><strong>' + onlyYear + '° anno</strong>'
            : '<strong>' + deg.label + '</strong>') + '</nav>';
        body = seg + crumbs + deg.years.filter(function (y) { return !onlyYear || y === onlyYear; }).map(function (y) {
          // prima i corsi con più materiali; con tutti gli anni visibili, solo i primi 6 e gli altri a tendina
          var list = all.filter(function (c) { return c.degree === deg.key && Number(c.study_year) === y; })
            .sort(function (a, b) { return (b.file_count || 0) - (a.file_count || 0) || a.name.localeCompare(b.name); });
          var shown = onlyYear ? list : list.slice(0, YEAR_PREVIEW), rest = onlyYear ? [] : list.slice(YEAR_PREVIEW);
          return '<section class="year-section"><div class="year-head"><h2><span class="year-badge">' + y + '°</span> anno</h2>' +
            '<span class="muted small">' + list.length + ' cors' + (list.length === 1 ? 'o' : 'i') + '</span>' +
            '<a class="btn btn-ghost btn-sm year-add" href="#/nuovo-corso?posto=' + deg.key + ':' + y + '">' + icon('plus') + 'Aggiungi</a></div>' +
            (list.length ? '<div class="course-grid">' + shown.map(courseItem).join('') + '</div>' +
              (rest.length ? '<details class="year-more"><summary>' + icon('chevron') +
                '<span class="when-closed">Mostra altri ' + rest.length + ' cors' + (rest.length === 1 ? 'o' : 'i') + '</span><span class="when-open">Mostra meno</span></summary>' +
                '<div class="course-grid">' + rest.map(courseItem).join('') + '</div></details>' : '')
              : '<p class="year-empty muted small">Nessun corso in questo anno.</p>') + '</section>';
        }).join('');
      }
    }
    if (view !== 'triennale' && view !== 'magistrale') currentPlace = '';
    render('courses', head + body, 'Corsi');
  }

  async function courseFormPage(id, params) {
    var course = {};
    if (id) {
      if (!isAdmin()) return errorPage('Accesso negato', 'Solo gli amministratori possono modificare i corsi.');
      loading('courses');
      course = await Api.getCourse(id);
      if (!course) return errorPage('Non trovato', 'Il corso richiesto non esiste.');
    }
    var back = id ? '#/corso/' + id : '#/corsi';
    var field = function (label, name, max, ph, req) {
      return '<label>' + label + '<input type="text" name="' + name + '" maxlength="' + max + '" value="' + esc(course[name] || '') + '" placeholder="' + ph + '"' + (req ? ' required' : '') + '></label>';
    };
    render('courses',
      '<a class="back-link" href="' + back + '">' + icon('arrow-left') + 'Indietro</a>' +
      '<div class="panel form-panel"><h1>' + (id ? 'Modifica corso' : 'Nuovo corso') + '</h1>' +
        '<p class="muted">' + (id ? 'Aggiorna le informazioni dell\'insegnamento.' : 'Aggiungi un insegnamento per raccogliere i relativi materiali.') + '</p>' +
        '<form class="form" data-form="course" data-id="' + (id || '') + '">' +
          field('Nome dell\'insegnamento *', 'name', 140, 'Chimica Organica I', true) +
          '<label>Corso di laurea e anno *<select name="placement">' +
            placementOptions(id ? placementOf(course) : ((params && params.get('posto')) || '')) + '</select></label>' +
          '<div class="form-row">' + field('Codice', 'code', 30, 'CHI-201') +
            '<label>Anno accademico<select name="year">' +
              aaOptions(id ? (Api.normAA(course.year) || course.year || '') : ((params && (params.get('aa') || '').replace('-', '/')) || currentAA())) +
            '</select></label></div>' +
          field('Docente', 'teacher', 120, 'Nome Cognome') +
          '<label>Descrizione<textarea name="description" rows="4" maxlength="2000" placeholder="Programma, orari, note…">' + esc(course.description || '') + '</textarea></label>' +
          '<div class="form-actions"><a class="btn btn-ghost" href="' + back + '">Annulla</a>' +
          '<button class="btn btn-primary" type="submit">' + (id ? 'Salva modifiche' : 'Crea corso') + '</button></div>' +
        '</form></div>', id ? 'Modifica corso' : 'Nuovo corso');
  }

  async function coursePage(id, params) {
    loading('courses');
    var kind = KINDS[params.get('tipo')] ? params.get('tipo') : '';
    var q = params.get('q') || '';
    var folder = params.get('cartella') || '';
    var order = ORDERS[params.get('ordine')] ? params.get('ordine') : 'recenti';
    var everyAA = params.get('aa') === 'tutti';
    var res = await Promise.all([Api.getCourse(id), Api.listCourses().catch(function () { return []; })]);
    var course = res[0];
    if (!course) return errorPage('Non trovato', 'Il corso richiesto non esiste.');
    course.aa = Api.normAA(course.year);
    // gli altri anni accademici dello stesso insegnamento
    var group = groupCourses(res[1]).filter(function (g) { return g.ids.indexOf(Number(id)) >= 0; })[0] ||
      { members: [Object.assign({ file_count: 0 }, course)], ids: [Number(id)], color: course.color };
    var members = group.members;
    if (members.length < 2) everyAA = false;
    var lists = await Promise.all((everyAA ? members : [course]).map(function (c) { return Api.listFiles({ courseId: c.id }); }));
    var all = [].concat.apply([], lists);
    if (everyAA) {
      var aaOf = {};
      members.forEach(function (c) { aaOf[c.id] = c.aa; });
      all.forEach(function (f) { f.aa = aaOf[f.course_id] || ''; });
    }
    rememberCourse(id);
    currentCourseFiles = all;
    var counts = {}, folders = {};
    all.forEach(function (f) {
      counts[f.kind] = (counts[f.kind] || 0) + 1;
      var tf = topFolder(f) || '__none';
      folders[tf] = (folders[tf] || 0) + 1;
    });
    var ql = q.toLowerCase();
    var files = all.filter(function (f) {
      return (!kind || f.kind === kind) &&
        (!folder || (folder === '__none' ? !f.folder : topFolder(f) === folder)) &&
        (!ql || [f.title, f.description, f.original_name, f.folder].some(function (v) { return (v || '').toLowerCase().indexOf(ql) >= 0; }));
    }).sort(ORDERS[order].sort);
    var keep = { tipo: kind, q: q, cartella: folder, ordine: order === 'recenti' ? '' : order, aa: everyAA ? 'tutti' : '' };
    var link = function (change) { return '#/corso/' + id + qs(Object.assign({}, keep, change)); };
    var tab = function (k, label, n) {
      return '<a href="' + link({ tipo: k }) + '" class="' + (kind === k ? 'active' : '') + '">' + label + ' <span>' + n + '</span></a>';
    };
    // cartelle (dal vecchio Drive o scelte da chi carica) come filtri cliccabili
    var folderNames = Object.keys(folders).filter(function (k) { return k !== '__none'; }).sort(function (a, b) { return a.localeCompare(b); });
    var folderBar = folderNames.length ? '<nav class="folder-chips" aria-label="Cartelle">' +
      '<a href="' + link({ cartella: '' }) + '" class="' + (!folder ? 'active' : '') + '">' + icon('folder') + 'Tutte</a>' +
      folderNames.map(function (n) { return '<a href="' + link({ cartella: n }) + '" class="' + (folder === n ? 'active' : '') + '">' + esc(n) + ' <span>' + folders[n] + '</span></a>'; }).join('') +
      (folders.__none ? '<a href="' + link({ cartella: '__none' }) + '" class="' + (folder === '__none' ? 'active' : '') + '">Senza cartella <span>' + folders.__none + '</span></a>' : '') +
      '</nav>' : '';
    var sortSel = '<label class="sort-select">' + icon('sort') + '<select data-course-sort data-id="' + id + '" aria-label="Ordina">' +
      Object.keys(ORDERS).map(function (k) { return '<option value="' + k + '"' + (k === order ? ' selected' : '') + '>' + ORDERS[k].label + '</option>'; }).join('') +
      '</select></label>';
    var allFolders = all.map(function (f) { return f.folder; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).sort();
    // scelta dell'anno accademico (solo se il corso ne ha più di uno)
    var aaLabel = function (c) { return c.aa ? aaShort(c.aa) : 'Senza anno'; };
    var aaBar = members.length > 1 ? '<nav class="aa-tabs" aria-label="Anno accademico"><span class="aa-tabs-label">' + icon('clock') + 'Anno accademico</span>' +
      members.map(function (c) {
        var on = !everyAA && c.id === Number(id);
        return '<a href="#/corso/' + c.id + qs({ ordine: keep.ordine }) + '" class="' + (on ? 'active' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' +
          esc(aaLabel(c)) + (c.aa === currentAA() ? ' <em>in corso</em>' : '') + ' <span>' + (c.file_count || 0) + '</span></a>';
      }).join('') +
      '<a href="#/corso/' + id + qs({ aa: 'tutti', ordine: keep.ordine }) + '" class="' + (everyAA ? 'active' : '') + '">Tutti <span>' + group.file_count + '</span></a></nav>' : '';
    var heroAA = everyAA ? 'Tutti gli anni accademici' : course.aa ? 'A.A. ' + course.aa : (course.year ? 'A.A. ' + course.year : '');
    render('courses',
      '<a class="back-link" href="#/corsi' + (course.degree ? '?laurea=' + course.degree : (placementOf(course) ? '' : '?laurea=da-assegnare')) + '">' + icon('arrow-left') + 'Tutti i corsi</a>' +
      '<section class="course-hero cover-' + (group.color % 8) + '">' +
        '<div class="course-hero-body"><span class="course-code light">' + esc(course.code || 'CORSO') + (heroAA ? ' · ' + esc(heroAA) : '') + '</span>' +
          ' <span class="course-code light">' + esc(placementLabel(placementOf(course))) + '</span>' +
          '<h1>' + esc(course.name) + '</h1><p>' + (course.teacher ? 'Docente: Prof. ' + esc(course.teacher) : 'Docente non indicato') + '</p>' +
          (course.description ? '<p class="course-desc">' + esc(course.description) + '</p>' : '') + '</div>' +
        '<div class="course-hero-side"><div class="hero-count"><strong>' + all.length + '</strong><small>materiali</small></div>' +
          '<div class="hero-admin">' + favButton(id, 'fav-hero', group.ids) + '<a class="btn btn-light btn-sm" href="#upload" data-action="scroll-upload">' + icon('upload') + 'Carica</a>' +
          (isAdmin() ? '<a class="btn btn-light btn-sm" href="#/modifica-corso/' + id + '">' + icon('edit') + 'Modifica</a>' +
            (everyAA ? '' : '<button class="btn btn-light btn-sm danger" type="button" data-action="delete-course" data-id="' + id + '" data-name="' + esc(course.name + (members.length > 1 && course.aa ? ' (A.A. ' + course.aa + ')' : '')) + '" data-count="' + all.length + '">' + icon('trash') + 'Elimina</button>') : '') +
          '</div></div>' +
      '</section>' + aaBar +
      '<div class="course-layout">' +
        '<section class="panel"><div class="panel-head wrap"><nav class="tabs" aria-label="Filtra per tipo">' +
          tab('', 'Tutti', all.length) +
          Object.keys(KINDS).filter(function (k) { return counts[k]; }).map(function (k) { return tab(k, KINDS[k].plural, counts[k]); }).join('') +
          '</nav><div class="course-tools">' + sortSel + '<form class="inline-search" data-form="filter-course" data-id="' + id + '" data-kind="' + kind + '" data-folder="' + esc(folder) + '" data-order="' + keep.ordine + '" data-aa="' + keep.aa + '">' + icon('search') +
          '<input type="search" name="q" value="' + esc(q) + '" placeholder="Cerca nel corso"></form></div></div>' + folderBar +
          (files.length ? fileList(files, false, everyAA) : empty('folder', q || kind || folder ? 'Nessun materiale corrisponde ai filtri.' : 'Questo corso non ha ancora materiali. Sii il primo a contribuire!')) +
        '</section>' +
        uploadPanel(id, allFolders, folder !== '__none' ? folder : '', members, everyAA ? null : course) +
      '</div>', course.name);
    loadThumbs();
  }

  // members = anni accademici del corso; current = anno che si sta guardando (null = "Tutti")
  function uploadPanel(courseId, folders, preset, members, current) {
    folders = folders || [];
    members = members || [];
    // si può caricare in ogni anno esistente o nell'anno in corso (creato al primo caricamento)
    var hasNow = members.some(function (c) { return c.aa === currentAA(); });
    var pick = current ? current.id : (members.filter(function (c) { return c.aa === currentAA(); })[0] || {}).id || (members.length ? 'nuovo' : courseId);
    var opts = members.map(function (c) {
      return '<option value="' + c.id + '"' + (String(c.id) === String(pick) ? ' selected' : '') + '>' + (c.aa ? c.aa + (c.aa === currentAA() ? ' (in corso)' : '') : 'Senza anno accademico') + '</option>';
    });
    if (!hasNow && members.length) opts.unshift('<option value="nuovo"' + (pick === 'nuovo' ? ' selected' : '') + '>' + currentAA() + ' (in corso)</option>');
    var aaField = opts.length > 1
      ? '<label>Anno accademico<select name="aa" data-aa-upload>' + opts.join('') + '</select></label>'
      : '';
    return '<aside class="panel upload-panel" id="upload"><h2>' + icon('upload') + 'Carica materiale</h2>' +
      '<p class="muted small">PDF, immagini, audio, video e documenti. Max ' + CFG.maxUploadMb + ' MB per file.</p>' +
      '<form class="upload-form" data-form="upload" data-id="' + courseId + '">' + aaField +
        '<label class="dropzone" data-dropzone><input type="file" name="files" multiple accept="' + Api.acceptAttr + '" data-file-input>' +
          icon('upload') + '<strong>Tocca per scegliere i file</strong><span>oppure trascinali qui</span></label>' +
        '<ul class="selected-files" data-selected></ul>' +
        '<label>Titolo <small class="muted">(se carichi un solo file)</small><input type="text" name="title" maxlength="200" placeholder="Es. Lezione 3 – Equilibrio chimico"></label>' +
        '<label>Descrizione <small class="muted">(facoltativa)</small><textarea name="description" rows="3" maxlength="2000" placeholder="Argomenti trattati, data della lezione…"></textarea></label>' +
        '<label>Cartella <small class="muted">(facoltativa)</small><input type="text" name="folder" maxlength="120" list="folders-' + courseId + '" value="' + esc(preset || '') + '" placeholder="Es. Esercizi, Temi d\'esame, Registrazioni">' +
          '<datalist id="folders-' + courseId + '">' + folders.map(function (f) { return '<option value="' + esc(f) + '">'; }).join('') + '</datalist></label>' +
        '<div class="progress" data-progress hidden><div class="progress-bar" data-progress-bar></div><span data-progress-label></span></div>' +
        '<button class="btn btn-primary btn-block" type="submit">' + icon('upload') + 'Carica</button>' +
        '<p class="muted small center">I file caricati sono visibili a tutti gli studenti. Solo gli amministratori possono rimuoverli.</p>' +
      '</form></aside>';
  }

  async function filePage(id) {
    loading('courses');
    var f = await Api.getFile(id);
    if (!f) return errorPage('Non trovato', 'Il file richiesto non esiste.');
    fileCache[f.id] = f;
    rememberCourse(f.course_id);
    var k = KINDS[f.kind] || KINDS.other;
    var inline = ['pdf', 'image', 'audio', 'video'].indexOf(f.kind) >= 0;
    var url = inline ? await Api.fileUrl(f, false, true) : '';
    var mine = f.uploaded_by === state.user.id;
    var voted = mine ? false : (await Api.myVotes([f.id]).catch(function () { return []; })).indexOf(f.id) >= 0;
    var viewer;
    if (f.kind === 'pdf') viewer = '<iframe src="' + esc(url) + '" title="' + esc(f.title) + '"></iframe>';
    else if (f.kind === 'image') viewer = '<a href="' + esc(url) + '" target="_blank" rel="noopener"><img src="' + esc(url) + '" alt="' + esc(f.title) + '"></a>';
    else if (f.kind === 'audio') viewer = '<div class="audio-card"><div class="audio-art">' + icon('audio') + '</div><strong>' + esc(f.title) + '</strong><audio controls preload="metadata" src="' + esc(url) + '"></audio></div>';
    else if (f.kind === 'video') viewer = '<video controls playsinline preload="metadata" src="' + esc(url) + '"></video>';
    else viewer = '<div class="no-preview">' + icon(k.icon) + '<p>Anteprima non disponibile per questo formato.</p>' +
      '<button class="btn btn-primary" type="button" data-action="download" data-id="' + f.id + '">' + icon('download') + 'Scarica il file</button></div>';
    render('courses',
      '<a class="back-link" href="#/corso/' + f.course_id + '">' + icon('arrow-left') + esc(f.course ? f.course.name : 'Corso') + '</a>' +
      '<div class="file-layout">' +
        '<section class="panel viewer-panel"><div class="viewer kind-' + f.kind + '">' + viewer + '</div></section>' +
        '<aside class="panel file-details"><span class="tag kind-' + f.kind + '">' + k.label + '</span>' +
          '<h1>' + esc(f.title) + '</h1>' + (f.description ? '<p class="file-desc">' + esc(f.description) + '</p>' : '') +
          '<dl class="details">' +
            '<dt>Corso</dt><dd><a href="#/corso/' + f.course_id + '">' + esc(f.course ? f.course.name : '') + '</a></dd>' +
            '<dt>Cartella</dt><dd>' + (f.folder ? '<a href="#/corso/' + f.course_id + '?cartella=' + encodeURIComponent(topFolder(f)) + '">' + esc(f.folder) + '</a>' : '<span class="muted">nessuna</span>') +
              (mine || isAdmin() ? ' <button class="link-btn" type="button" data-action="set-folder" data-id="' + f.id + '" data-folder="' + esc(f.folder || '') + '">cambia</button>' : '') + '</dd>' +
            '<dt>Nome file</dt><dd class="break">' + esc(f.original_name) + '</dd>' +
            '<dt>Dimensione</dt><dd>' + bytes(f.size) + '</dd>' +
            '<dt>Caricato da</dt><dd>' + authorLink(f) + (!f.uploader && f.author_name ? ' <span class="muted small">(dal vecchio Drive, non ancora iscritto)</span>' : '') + '</dd>' +
            '<dt>Data</dt><dd>' + dateTime(f.created_at) + '</dd>' +
            '<dt>Aperture</dt><dd>' + (f.open_count || 0) + (f.last_opened_at ? ' · ultima ' + date(f.last_opened_at) : '') + '</dd>' +
          '</dl>' +
          (f.pinned ? '<p class="pin-note">' + icon('shield') + 'Protetto: non verrà mai eliminato in automatico.</p>' : '') +
          '<div class="stack">' +
            '<button class="btn btn-block vote-btn' + (voted ? ' on' : '') + '" type="button" data-action="vote" data-id="' + f.id + '"' + (mine ? ' disabled title="Non puoi votare i tuoi file"' : '') + '>' +
              icon('thumb') + '<span>' + (voted ? 'Ti è stato utile' : 'Utile') + '</span><strong data-vote-count>' + (f.vote_count || 0) + '</strong></button>' +
            '<button class="btn btn-primary btn-block" type="button" data-action="download" data-id="' + f.id + '">' + icon('download') + 'Scarica</button>' +
            (inline ? '<a class="btn btn-ghost btn-block" href="' + esc(url) + '" target="_blank" rel="noopener">Apri a schermo intero</a>' : '') +
            (f.uploaded_by !== state.user.id ? '<button class="btn btn-ghost btn-block btn-report" type="button" data-action="report" data-id="' + f.id + '">' + icon('flag') + 'Segnala contenuto inappropriato</button>' : '') +
            (isAdmin() && (f.storage === 'b2' || f.storage === 'r2') ? '<button class="btn btn-ghost btn-block" type="button" data-action="toggle-pin" data-id="' + f.id + '" data-pinned="' + (f.pinned ? '1' : '') + '">' +
              icon('shield') + (f.pinned ? 'Rimuovi protezione' : 'Proteggi dall\'eliminazione automatica') + '</button>' : '') +
            (isAdmin() ? '<button class="btn btn-danger btn-block" type="button" data-action="delete-file" data-id="' + f.id + '" data-back="#/corso/' + f.course_id + '">' + icon('trash') + 'Elimina materiale</button>' : '') +
          '</div></aside>' +
      '</div>', f.title);
  }

  async function searchPage(params) {
    var q = params.get('q') || '';
    var kind = KINDS[params.get('tipo')] ? params.get('tipo') : '';
    var files = [];
    if (q) { loading('search'); files = await Api.listFiles({ q: q, kind: kind, limit: 200 }); }
    render('search',
      '<div class="page-head"><div><p class="eyebrow">Ricerca</p><h1>Cerca materiali</h1>' +
        '<p class="muted">Cerca per titolo, descrizione o nome del file.</p></div></div>' +
      '<form class="filter-bar" data-form="search"><div class="input-ic grow">' + icon('search') +
        '<input type="search" name="q" value="' + esc(q) + '" placeholder="Es. stechiometria, lezione 5, laboratorio…" enterkeyhint="search"></div>' +
        '<select name="tipo" aria-label="Tipo di file"><option value="">Tutti i tipi</option>' +
        Object.keys(KINDS).map(function (k) { return '<option value="' + k + '"' + (kind === k ? ' selected' : '') + '>' + KINDS[k].plural + '</option>'; }).join('') +
        '</select><button class="btn btn-primary" type="submit">Cerca</button></form>' +
      '<section class="panel">' +
        (!q ? empty('search', 'Scrivi una parola chiave per iniziare.')
          : files.length ? '<p class="muted small results-count">' + files.length + ' risultat' + (files.length === 1 ? 'o' : 'i') + ' per «' + esc(q) + '»</p>' + fileList(files, true)
          : empty('search', 'Nessun risultato per «' + esc(q) + '».')) +
      '</section>', 'Ricerca');
    loadThumbs();
  }

  async function minePage() {
    loading('mine');
    var files = await Api.listFiles({ mine: true });
    render('mine',
      '<div class="page-head"><div><p class="eyebrow">Profilo</p><h1>I miei caricamenti</h1>' +
        '<p class="muted">Il materiale che hai condiviso. Per rimuovere un file chiedi a un amministratore.</p></div></div>' +
      '<section class="panel">' +
        (files.length ? fileList(files, true) : empty('upload', 'Non hai ancora caricato nessun file.', '<a class="btn btn-primary" href="#/corsi">' + icon('book') + 'Scegli un corso</a>')) +
      '</section>', 'I miei caricamenti');
    loadThumbs();
  }

  // Pagina di uno studente: lega, punti e tutto ciò che ha pubblicato
  async function userPage(id) {
    loading('');
    var res = await Promise.all([Api.getProfile(id), Api.listFiles({ uploader: id, limit: 500 }), ensureLeagues().then(function () { return Api.leaderboard(); })]);
    var p = res[0], files = res[1], board = res[2] || [];
    if (!p) return errorPage('Non trovato', 'Questo studente non esiste o non è più iscritto.');
    var L = window.Leagues;
    var row = board.filter(function (r) { return r.user_id === id; })[0];
    var lg = L.leagueFor(p.points || 0, row ? Number(row.rank_pos) : 0);
    var mine = state.user && state.user.id === id;
    render('', '<a class="back-link" href="#/classifica" data-action="go-back">' + icon('arrow-left') + 'Indietro</a>' +
      '<section class="panel profile-head">' + L.emblem(lg.tier.key, 88) +
        '<div><p class="eyebrow">' + (p.role === 'admin' ? 'Amministratore' : 'Studente') + (mine ? ' · sei tu' : '') + '</p>' +
        '<h1>' + esc(p.name) + '</h1>' +
        '<p class="muted"><strong>' + esc(lg.label) + '</strong> · ' + (p.points || 0) + ' punti · ' + files.length + ' file pubblicat' + (files.length === 1 ? 'o' : 'i') +
        (row ? ' · posizione #' + row.rank_pos : '') + '</p></div></section>' +
      '<section class="panel"><div class="panel-head"><h2>Materiali pubblicati</h2></div>' +
        (files.length ? fileList(files, true) : empty('folder', 'Nessun file pubblicato.')) + '</section>', p.name);
    loadThumbs();
  }

  // Autore del vecchio Drive non ancora iscritto: i suoi file (i punti arriveranno al primo accesso)
  async function authorPage(name) {
    loading('');
    var files = name ? await Api.listFiles({ authorName: name, limit: 500 }) : [];
    render('', '<a class="back-link" href="#/" data-action="go-back">' + icon('arrow-left') + 'Indietro</a>' +
      '<section class="panel profile-head"><span class="avatar lg">' + esc(initials(name || '?')) + '</span>' +
        '<div><p class="eyebrow">Dal vecchio Drive · non ancora iscritto</p><h1>' + esc(name || 'Autore') + '</h1>' +
        '<p class="muted">' + files.length + ' file pubblicat' + (files.length === 1 ? 'o' : 'i') + '. Quando accederà al sito riceverà i punti e comparirà in classifica.</p></div></section>' +
      '<section class="panel"><div class="panel-head"><h2>Materiali pubblicati</h2></div>' +
        (files.length ? fileList(files, true) : empty('folder', 'Nessun file trovato.')) + '</section>', name || 'Autore');
    loadThumbs();
  }

  var ACTION_LABELS = {
    primo_accesso: 'primo accesso', file_caricato: 'file caricato', file_eliminato: 'file eliminato',
    corso_creato: 'corso creato', corso_modificato: 'corso modificato', corso_eliminato: 'corso eliminato',
    ruolo_admin_assegnato: 'admin assegnato', ruolo_admin_revocato: 'admin revocato',
    file_eliminato_auto: 'eliminato in automatico', file_protetto: 'file protetto', file_non_protetto: 'protezione rimossa',
    utente_sospeso: 'utente sospeso', utente_riattivato: 'utente riattivato',
    file_importato: 'importato dal Drive', archivio_scompattato: 'ZIP scompattato', codice_servizio_generato: 'codice di servizio',
  };

  async function adminPage(params) {
    if (!isAdmin()) return errorPage('Accesso negato', 'Questa sezione è riservata agli amministratori.');
    loading('admin');
    var res = await Promise.all([Api.stats(), Api.listUsers(), Api.listAudit(), Api.usage().catch(function () { return null; }),
      Api.evictionPreview('b2').catch(function () { return []; }), Api.listReports().catch(function () { return []; }),
      Api.importStatus().catch(function () { return null; }), Api.adminStats().catch(function () { return null; })]);
    var stats = res[0], audit = res[2], usage = res[3], preview = res[4], reports = res[5], imp = res[6], astats = res[7];
    var previewR2 = usage && usage.r2 ? await Api.evictionPreview('r2').catch(function () { return []; }) : [];
    var q = (params.get('q') || '').toLowerCase();
    var users = res[1].filter(function (u) { return !q || (u.name + ' ' + u.email).toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || a.name.localeCompare(b.name); });
    render('admin',
      '<div class="page-head"><div><p class="eyebrow">Gestione piattaforma</p><h1>Amministrazione</h1>' +
        '<p class="muted">Gli amministratori possono modificare i corsi ed eliminare corsi e materiali.</p></div>' +
        '<button class="btn btn-ghost" type="button" data-action="start-tour">' + icon('flag') + 'Avvia il tour di benvenuto</button></div>' +
      '<section class="stats">' + stat('users', stats.users, 'Utenti') + stat('book', stats.courses, 'Corsi') +
        stat('folder', stats.files, 'Materiali') + stat('archive', bytes(stats.bytes), 'Spazio usato (totale)') + '</section>' +
      reportsPanel(reports) +
      (astats ? statsPanel(astats) : '') +
      (usage ? usagePanel(usage, preview, stats, previewR2) : '') +
      (imp ? importPanel(imp) : '') +
      '<section class="panel"><div class="panel-head wrap"><h2>Utenti e ruoli</h2>' +
        '<form class="inline-search" data-form="filter-users">' + icon('search') + '<input type="search" name="q" value="' + esc(params.get('q') || '') + '" placeholder="Cerca per nome o email"></form></div>' +
        '<p class="muted small">Gli studenti compaiono qui dopo il loro primo accesso.</p>' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>Utente</th><th>Ruolo</th><th>Caricamenti</th><th class="right">Azioni</th></tr></thead><tbody>' +
        users.map(function (u) {
          var admin = u.role === 'admin';
          var banned = Boolean(u.banned_at);
          var who = ' data-id="' + u.id + '" data-name="' + esc(u.name) + '"';
          var actions;
          if (banned) {
            actions = '<button class="btn btn-ghost btn-sm" type="button" data-action="unban"' + who + '>Riattiva</button>';
          } else if (admin) {
            actions = '<button class="btn btn-ghost btn-sm" type="button" data-action="set-role" data-role="student"' + who + '>Revoca admin</button>';
          } else {
            actions = '<button class="btn btn-primary btn-sm" type="button" data-action="set-role" data-role="admin"' + who + '>' + icon('shield') + 'Rendi admin</button>' +
              '<button class="btn btn-ghost btn-sm danger-text" type="button" data-action="ban"' + who + '>' + icon('ban') + 'Sospendi</button>';
          }
          return '<tr class="' + (banned ? 'is-banned' : '') + '"><td><div class="user-cell"><span class="avatar sm">' + esc(initials(u.name)) + '</span><div><strong>' + esc(u.name) + (u.id === state.user.id ? ' (tu)' : '') +
            '</strong><small>' + esc(u.email) + '</small>' + (banned ? '<small class="ban-reason">Sospeso: ' + esc(u.banned_reason || '') + '</small>' : '') + '</div></div></td>' +
            '<td>' + (banned ? '<span class="role role-banned">Sospeso</span>' : '<span class="role role-' + u.role + '">' + (admin ? 'Amministratore' : 'Studente') + '</span>') + '</td>' +
            '<td>' + (u.uploads || 0) + '</td><td class="right"><div class="row-actions">' + actions + '</div></td></tr>';
        }).join('') +
        (users.length ? '' : '<tr><td colspan="4" class="center muted">Nessun utente trovato.</td></tr>') +
        '</tbody></table></div></section>' +
      '<section class="panel"><div class="panel-head"><h2>Registro attività</h2></div><ul class="audit">' +
        (audit.length ? audit.map(function (a) {
          return '<li><span class="audit-action a-' + esc(a.action) + '">' + esc(ACTION_LABELS[a.action] || a.action) + '</span>' +
            '<span class="audit-text"><strong>' + esc(a.user ? a.user.name : 'Sistema') + '</strong>' + (a.details ? ' — ' + esc(a.details) : '') + '</span>' +
            '<time class="muted small">' + dateTime(a.created_at) + '</time></li>';
        }).join('') : '<li class="muted">Nessuna attività registrata.</li>') +
      '</ul></section>', 'Amministrazione');
  }

  // Statistiche d'uso (ultimi 7 giorni, file più aperti, corsi più usati nell'ultimo mese)
  function statsPanel(st) {
    var n = function (v) { return Number(v) || 0; };
    return '<section class="panel"><div class="panel-head"><h2>' + icon('trophy') + 'Statistiche</h2><span class="muted small">ultimi 7 giorni</span></div>' +
      '<ul class="import-stats">' +
        '<li><strong>' + n(st.active_7d) + '</strong><small>studenti attivi</small></li>' +
        '<li><strong>' + n(st.opens_7d) + '</strong><small>aperture di file</small></li>' +
        '<li><strong>' + n(st.uploads_7d) + '</strong><small>file caricati</small></li>' +
        '<li><strong>' + n(st.new_users_7d) + '</strong><small>nuovi iscritti</small></li>' +
      '</ul><div class="two-col stats-lists">' +
        '<div><h3 class="usage-sub">File più aperti</h3><ol class="evict-list">' + (st.top_files || []).map(function (f) {
          return '<li><a href="#/file/' + f.id + '">' + esc(f.title) + '</a><span class="muted small">' + esc(f.course) + ' · ' + n(f.open_count) + ' aperture' + (f.vote_count ? ' · ' + f.vote_count + ' 👍' : '') + '</span></li>';
        }).join('') + '</ol></div>' +
        '<div><h3 class="usage-sub">Corsi più usati (30 giorni)</h3><ol class="evict-list">' + ((st.top_courses || []).length ? st.top_courses.map(function (c) {
          return '<li><a href="#/corso/' + c.id + '">' + esc(c.name) + '</a><span class="muted small">' + (c.year ? esc(c.year) + ' · ' : '') + n(c.opens) + ' aperture</span></li>';
        }).join('') : '<li class="muted">Ancora nessuna apertura.</li>') + '</ol></div>' +
      '</div></section>';
  }

  function reportsPanel(reports) {
    if (!reports || !reports.length) return '';
    var byFile = {};
    reports.forEach(function (r) {
      if (!r.file) return;
      var g = byFile[r.file_id] = byFile[r.file_id] || { file: r.file, items: [] };
      g.items.push(r);
    });
    var groups = Object.keys(byFile).map(function (k) { return byFile[k]; })
      .sort(function (a, b) { return b.items.length - a.items.length; });
    return '<section class="panel reports"><div class="panel-head"><h2>' + icon('flag') + 'Segnalazioni</h2>' +
      '<span class="pill-count">' + groups.length + '</span></div><ul class="report-list">' +
      groups.map(function (g) {
        var f = g.file;
        return '<li><div class="report-main"><a href="#/file/' + f.id + '"><strong>' + esc(f.title) + '</strong></a>' +
          '<span class="muted small">caricato da ' + esc(f.uploader ? f.uploader.name : '—') + ' · ' + g.items.length + ' segnalazion' + (g.items.length === 1 ? 'e' : 'i') + '</span>' +
          '<ul class="report-reasons">' + g.items.slice(0, 3).map(function (r) {
            return '<li>«' + esc(r.reason) + '» <span class="muted small">— ' + esc(r.reporter ? r.reporter.name : '') + ', ' + date(r.created_at) + '</span></li>';
          }).join('') + '</ul></div>' +
          '<div class="row-actions">' +
            '<button class="btn btn-danger btn-sm" type="button" data-action="delete-file" data-id="' + f.id + '" data-back="#/admin">' + icon('trash') + 'Elimina file</button>' +
            (f.uploaded_by && f.uploaded_by !== state.user.id ? '<button class="btn btn-ghost btn-sm danger-text" type="button" data-action="ban" data-id="' + f.uploaded_by + '" data-name="' + esc(f.uploader ? f.uploader.name : 'l\'autore') + '">' + icon('ban') + 'Sospendi autore</button>' : '') +
            '<button class="btn btn-ghost btn-sm" type="button" data-action="dismiss-reports" data-id="' + f.id + '">Ignora</button>' +
          '</div></li>';
      }).join('') + '</ul></section>';
  }

  // Barra di spazio di un archivio, con i prossimi file che verrebbero eliminati
  function storageBlock(title, used, quota, preview, extra) {
    var exact = quota ? Math.min(100, (used / quota) * 100) : 0;
    var pct = Math.round(exact);
    var pctLabel = used > 0 && exact < 1 ? 'meno dell\'1%' : pct + '%';
    var level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
    return '<h3 class="usage-sub">' + title + '</h3>' +
      '<div class="usage-bar usage-' + level + '"><div data-width="' + (used > 0 ? Math.max(exact, 0.8).toFixed(2) : 0) + '"></div></div>' +
      '<p class="small"><strong>' + bytes(used) + '</strong> usati di ' + bytes(quota) + ' (' + pctLabel + ').' + (extra || '') + '</p>' +
      (preview && preview.length ? '<p class="muted small">Primi file che verrebbero eliminati:</p><ol class="evict-list">' +
        preview.map(function (p) {
          return '<li><a href="#/file/' + p.file_id + '">' + esc(p.file_title) + '</a><span class="muted small">' + bytes(p.bytes) + ' · ' +
            p.opens + ' apertur' + (Number(p.opens) === 1 ? 'a' : 'e') + ' · ultima attività ' + date(p.last_activity) + '</span></li>';
        }).join('') + '</ol>' : '');
  }

  function usagePanel(u, preview, stats, previewR2) {
    var external = u.where === 'Backblaze B2';
    var other = stats && external ? (stats.bytes || 0) - (stats.b2_bytes || 0) - (stats.r2_bytes || 0) : 0;
    var html = '<section class="panel usage"><div class="panel-head wrap"><h2>Spazio degli archivi</h2>' +
      (external ? '<button class="btn btn-ghost btn-sm" type="button" data-action="storage-check">' + icon('check') + 'Verifica archivi</button>' : '') +
      '</div><div data-check-box></div>';
    if (!external) {
      return html + storageBlock(esc(u.where), u.used, u.quota, preview, ' Quando lo spazio finisce, i caricamenti vengono bloccati: nessun costo.') + '</section>';
    }
    html += storageBlock(u.r2 ? 'Documenti · Backblaze B2' : 'Backblaze B2', u.used, u.quota, preview,
      other > 0 ? ' Altri <strong>' + bytes(other) + '</strong> sono sull\'archivio di Supabase (file caricati prima di B2, limite 1 GB).' : '');
    if (u.r2) html += storageBlock('Registrazioni audio e video · Cloudflare R2', u.r2.used, u.r2.quota, previewR2);
    return html + '<p class="small muted">Quando un archivio è pieno e serve spazio per un nuovo file, vengono eliminati in automatico ' +
      'solo i file meno aperti di quell\'archivio: per i documenti si contano le aperture dell\'ultimo anno e mezzo, ' +
      'per le registrazioni dell\'ultimo anno. Mai eliminati i file caricati da meno di 14 giorni, quelli importati dal Drive ' +
      'nei primi 6 mesi e quelli protetti 📌.</p></section>';
  }

  function importPanel(st) {
    var n = function (v) { return Number(v) || 0; };
    return '<section class="panel import"><div class="panel-head wrap"><h2>' + icon('upload') + 'Importazione dal vecchio Drive</h2>' +
        // solo il proprietario del sito (il database rifiuta comunque gli altri)
        (st.is_owner ? '<button class="btn btn-ghost btn-sm" type="button" data-action="new-service-token">' + icon('lock') + (st.has_token ? 'Genera un nuovo codice' : 'Genera il codice di servizio') + '</button>' : '') + '</div>' +
      '<div data-token-box></div>' +
      (n(st.imported) || n(st.processing)
        ? '<ul class="import-stats">' +
            '<li><strong>' + n(st.imported) + '</strong><small>file importati</small></li>' +
            '<li><strong>' + n(st.imported_b2) + '</strong><small>documenti (Backblaze)</small></li>' +
            '<li><strong>' + n(st.imported_r2) + '</strong><small>registrazioni (Cloudflare)</small></li>' +
            '<li><strong>' + n(st.processing) + '</strong><small>in attesa di compressione</small></li>' +
            '<li><strong>' + n(st.authors) + '</strong><small>autori (' + n(st.authors_waiting) + ' non ancora iscritti)</small></li>' +
          '</ul>' + (st.last ? '<p class="muted small">Ultimo file importato: ' + dateTime(st.last) + '</p>' : '')
        : '<p class="muted small">Nessun file importato finora. Il codice di servizio serve allo script Google che trasferisce il Drive ' +
          'e al robot di GitHub che comprime le registrazioni.</p>') +
      (st.errors && st.errors.length ? '<p class="small"><strong>File non elaborati:</strong></p><ul class="report-reasons">' +
        st.errors.map(function (e) { return '<li><a href="#/file/' + e.id + '">' + esc(e.title) + '</a> <span class="muted small">— ' + esc(e.error) + '</span></li>'; }).join('') + '</ul>' : '') +
      '</section>';
  }

  function ensureLeagues() {
    if (window.Leagues) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = 'js/leagues.js?v=' + VERSION;
      sc.onload = function () { resolve(); };
      sc.onerror = function () { reject(new Error('Impossibile caricare la classifica: ricarica la pagina.')); };
      document.head.appendChild(sc);
    });
  }

  async function rankingPage() {
    loading('ranking');
    await ensureLeagues();
    var list = await Api.leaderboard();
    var L = window.Leagues;
    list.forEach(function (r) { r.league = L.leagueFor(r.points, Number(r.rank_pos)); });
    var meIdx = list.findIndex(function (r) { return r.user_id === state.user.id; });
    var me = meIdx >= 0 ? list[meIdx] : { points: 0, upload_count: 0, rank_pos: list.length + 1, league: L.leagueFor(0) };
    var lg = me.league;
    var podium = list.slice(0, 3);
    var order = [1, 0, 2].filter(function (i) { return podium[i]; });

    var heroCard = '<section class="rank-hero tier-' + lg.tier.key + '">' +
      '<div class="rank-hero-emblem">' + L.emblem(lg.tier.key, 132) + '</div>' +
      '<div class="rank-hero-body"><p class="eyebrow">La tua lega</p><h1>' + esc(lg.label) + '</h1>' +
        '<p class="rank-hero-meta"><strong>' + me.points + '</strong> punti · <strong>' + (me.upload_count || 0) + '</strong> file caricati · posizione <strong>#' + me.rank_pos + '</strong> su ' + Math.max(list.length, 1) + '</p>' +
        (lg.next ? '<div class="rank-progress"><div data-width="' + Math.round(lg.progress * 100) + '"></div></div>' +
          '<p class="small">Mancano <strong>' + lg.next.missing + ' punti</strong> per <strong>' + esc(lg.next.label) + '</strong></p>'
          : '<p class="small">Sei ai vertici: ' + (lg.tier.key === 'sfidante' ? 'nessuno ha più punti di te! 👑' : 'scala la classifica per diventare Sfidante.') + '</p>') +
      '</div></section>';

    var tiersStrip = '<section class="panel"><div class="panel-head"><h2>Le leghe</h2><span class="muted small">soglie in punti</span></div><div class="tiers-strip">' +
      L.TIERS.map(function (t) {
        var req = t.key === 'granmaestro' ? 'top 5' : t.key === 'sfidante' ? 'n° 1' : t.min + '+';
        return '<div class="tier-chip' + (t.key === lg.tier.key ? ' current' : '') + '">' + L.emblem(t.key, 56) + '<strong>' + t.name + '</strong><small>' + req + '</small></div>';
      }).join('') + '</div></section>';

    var podiumHtml = podium.length ? '<section class="podium">' + order.map(function (i) {
      var r = podium[i];
      return '<div class="podium-place place-' + (i + 1) + '">' + L.emblem(r.league.tier.key, i === 0 ? 92 : 72) +
        '<span class="podium-rank">' + (i + 1) + '</span><a class="podium-name" href="#/utente/' + r.user_id + '"><strong>' + esc(r.name) + '</strong></a>' +
        '<small>' + esc(r.league.label) + ' · ' + r.points + ' pt</small></div>';
    }).join('') + '</section>' : '';

    var table = '<section class="panel"><div class="panel-head"><h2>Classifica generale</h2></div>' +
      (list.length ? '<div class="table-wrap"><table class="table rank-table"><thead><tr><th>#</th><th>Studente</th><th>Lega</th><th class="right">File</th><th class="right">Punti</th></tr></thead><tbody>' +
        list.map(function (r) {
          return '<tr class="' + (r.user_id === state.user.id ? 'is-me' : '') + '"><td class="rank-pos">' + r.rank_pos + '</td>' +
            '<td><a class="user-cell user-link" href="#/utente/' + r.user_id + '"><span class="avatar sm">' + esc(initials(r.name)) + '</span><strong>' + esc(r.name) + (r.user_id === state.user.id ? ' (tu)' : '') + '</strong></a></td>' +
            '<td><div class="league-cell">' + L.emblem(r.league.tier.key, 32) + '<span>' + esc(r.league.label) + '</span></div></td>' +
            '<td class="right">' + (r.upload_count || 0) + '</td><td class="right"><strong>' + r.points + '</strong></td></tr>';
        }).join('') + '</tbody></table></div>' : empty('trophy', 'Ancora nessun punteggio: carica il primo file!')) + '</section>';

    var rules = '<section class="panel rules"><h2>Come si guadagnano i punti</h2><ul>' +
      '<li><strong>+10</strong> per ogni file caricato (fino a 10 file al giorno)</li>' +
      '<li><strong>+5</strong> quando un altro studente apre un tuo file (una volta per ogni studente)</li>' +
      '<li><strong>+1</strong> per ogni file di altri che apri per la prima volta (fino a 5 punti al giorno)</li>' +
      '<li>Chi aveva caricato file sul vecchio Drive riceve i punti (anche delle aperture) al primo accesso</li>' +
      '<li><strong>−10</strong> se un amministratore elimina un tuo file</li>' +
      '<li>La pulizia automatica dello spazio e l\'eliminazione di un corso non tolgono punti</li></ul></section>';

    render('ranking', heroCard + podiumHtml + '<div class="two-col rank-cols"><div>' + table + '</div><div>' + tiersStrip + rules + '</div></div>', 'Classifica');
  }

  function bannedPage(reason, email) {
    document.title = 'Account sospeso · ' + CFG.platformName;
    root.innerHTML = '<div class="banned-page"><div class="panel banned-card">' + icon('ban') +
      '<h1>Account sospeso</h1><p>L\'account <strong>' + esc(email || '') + '</strong> è stato sospeso dagli amministratori di ' + esc(CFG.platformName) + '.</p>' +
      (reason ? '<p class="ban-box"><strong>Motivo:</strong> ' + esc(reason) + '</p>' : '') +
      '<p class="muted small">Se pensi che si tratti di un errore, contatta i rappresentanti degli studenti.</p>' +
      '<button class="btn btn-ghost" type="button" data-action="logout">' + icon('logout') + 'Esci</button></div></div>';
  }

  var INFO_SECTIONS = [
    { key: 'matricole', title: 'Link utili per le matricole', icon: 'users' },
    { key: 'siti', title: 'Siti utili', icon: 'link' },
    { key: 'app', title: 'Applicazioni utili', icon: 'phone' },
    { key: 'sicurezza', title: 'Corso della sicurezza', icon: 'shield' },
    { key: 'esami', title: 'Esami scoglio', icon: 'alert' },
    { key: 'rappresentanza', title: 'Vuoi fare il rappresentante?', icon: 'flag' },
  ];
  var infoCache = { reps: [], links: [] };

  async function repsPage() {
    loading('reps');
    var res;
    try { res = await Promise.all([Api.listRepresentatives(), Api.listInfoLinks()]); }
    catch (err) {
      return errorPage('Pagina non ancora pronta', 'Un amministratore deve aggiornare il database (setup.sql) per attivare questa pagina.');
    }
    var reps = infoCache.reps = res[0];
    var links = infoCache.links = res[1];
    var admin = isAdmin();
    var safeUrl = function (u) { return /^https:\/\//.test(u || '') ? u : ''; };
    var digits = function (p) { return String(p || '').replace(/[^\d+]/g, ''); };

    var repCards = reps.map(function (r) {
      var tel = digits(r.phone);
      return '<article class="rep-card"><span class="avatar rep-avatar">' + esc(initials(r.name)) + '</span>' +
        '<div class="rep-body"><h3>' + esc(r.name) + '</h3>' + (r.role_label ? '<p class="muted small">' + esc(r.role_label) + '</p>' : '') +
        '<div class="rep-contacts">' +
          (r.email ? '<a href="mailto:' + esc(r.email) + '">' + icon('mail') + esc(r.email) + '</a>' : '') +
          (tel ? '<a href="tel:' + esc(tel) + '">' + icon('phone') + esc(r.phone) + '</a>' +
            '<a class="wa" href="https://wa.me/' + esc(tel.replace(/^\+/, '')) + '" target="_blank" rel="noopener">' + icon('chat') + 'WhatsApp</a>' : '') +
        '</div></div>' +
        (admin ? '<div class="item-tools"><button class="icon-btn" type="button" data-action="edit-rep" data-id="' + r.id + '" aria-label="Modifica">' + icon('edit') + '</button>' +
          '<button class="icon-btn danger" type="button" data-action="delete-rep" data-id="' + r.id + '" aria-label="Elimina">' + icon('trash') + '</button></div>' : '') +
        '</article>';
    }).join('');

    var sections = INFO_SECTIONS.map(function (sec) {
      var items = links.filter(function (l) { return l.section === sec.key; });
      if (!items.length && !admin) return '';
      return '<section class="panel info-section"><div class="panel-head"><h2>' + icon(sec.icon) + esc(sec.title) + '</h2>' +
        (admin ? '<button class="btn btn-ghost btn-sm" type="button" data-action="edit-link" data-section="' + sec.key + '">' + icon('plus') + 'Aggiungi</button>' : '') + '</div>' +
        (items.length ? '<ul class="info-list">' + items.map(function (l) {
          var url = safeUrl(l.url);
          var inner = '<strong>' + esc(l.label) + '</strong>' + (l.detail ? '<span class="muted small">' + esc(l.detail) + '</span>' : '');
          return '<li>' + (url ? '<a class="info-item" href="' + esc(url) + '" target="_blank" rel="noopener">' + inner + icon('link') + '</a>' : '<div class="info-item">' + inner + '</div>') +
            (admin ? '<div class="item-tools"><button class="icon-btn" type="button" data-action="edit-link" data-id="' + l.id + '" aria-label="Modifica">' + icon('edit') + '</button>' +
              '<button class="icon-btn danger" type="button" data-action="delete-link" data-id="' + l.id + '" aria-label="Elimina">' + icon('trash') + '</button></div>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="muted small">Nessun elemento.</p>') + '</section>';
    }).join('');

    render('reps',
      '<section class="reps-hero"><div><p class="eyebrow">Scienze e Tecnologie Chimiche</p><h1>I tuoi rappresentanti</h1>' +
        '<p>Siamo studenti come te: portiamo la voce del corso negli organi dell\'Università. Scrivici per dubbi, problemi o proposte!</p></div>' +
        '<svg class="reps-hero-ic"><use href="#i-users"/></svg></section>' +
      '<section class="panel"><div class="panel-head"><h2>Chi siamo</h2>' +
        (admin ? '<button class="btn btn-ghost btn-sm" type="button" data-action="edit-rep">' + icon('plus') + 'Aggiungi rappresentante</button>' : '') + '</div>' +
        (reps.length ? '<div class="rep-grid">' + repCards + '</div>'
          : '<p class="muted">' + (admin ? 'Nessun rappresentante inserito: usa "Aggiungi rappresentante".' : 'I contatti dei rappresentanti saranno pubblicati presto.') + '</p>') +
      '</section>' +
      '<div class="info-grid">' + sections + '</div>' +
      '<section class="panel made-by">' + icon('heart') + '<div><h2>Chi ha fatto questo sito</h2><p><strong>' + esc(CFG.platformName) +
        '</strong> è stato realizzato con affetto da <strong>Aleksey Symonenko</strong>, rappresentante del corso, per tutti gli studenti di Scienze e Tecnologie Chimiche.</p></div></section>',
      'Rappresentanti');
  }

  var profCache = [];
  async function profsPage() {
    profDept = '';
    loading('profs');
    var list;
    try { list = profCache = await Api.listProfessors(); }
    catch (err) {
      return errorPage('Pagina non ancora pronta', 'Un amministratore deve aggiornare il database (setup.sql) per attivare questa pagina.');
    }
    var admin = isAdmin();
    var lines = function (t) { return String(t || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); };
    var depts = list.map(function (p) { return p.department; }).filter(function (d, i, a) { return d && a.indexOf(d) === i; }).sort();
    var letter = '';
    var rows = list.map(function (p) {
      var roles = lines(p.positions), courses = lines(p.courses);
      var head = '';
      var l = (p.last_name || '?').replace(/^d'/i, '').charAt(0).toUpperCase();
      if (l !== letter) { letter = l; head = '<li class="prof-letter" data-letter>' + esc(l) + '</li>'; }
      var search = [p.last_name, p.first_name, p.email, p.department, p.research_group, p.research_area, p.positions, p.courses, p.education].join(' ').toLowerCase();
      var dd = function (label, value) { return value ? '<dt>' + label + '</dt><dd>' + value + '</dd>' : ''; };
      return head + '<li class="prof-item" data-dept="' + esc(p.department || '') + '" data-search="' + esc(search) + '"><details class="prof-row">' +
        '<summary><span class="avatar sm">' + esc(initials(p.first_name + ' ' + p.last_name)) + '</span>' +
          '<span class="prof-name"><strong>' + esc(p.last_name) + '</strong> ' + esc(p.first_name) + '</span>' +
          '<span class="prof-role muted small">' + esc(roles[0] || '') + '</span>' +
          (p.department ? '<span class="pill">' + esc(p.department) + '</span>' : '') +
          '<span class="prof-count muted small">' + courses.length + ' cors' + (courses.length === 1 ? 'o' : 'i') + '</span>' +
          icon('chevron') + '</summary>' +
        '<div class="prof-details"><dl>' +
          dd('Email', p.email ? '<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' : '') +
          dd('Ruoli', roles.length ? roles.map(esc).join('<br>') : '') +
          dd('Insegna', courses.length ? '<ul class="chips">' + courses.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' : '') +
          dd('Ambito di ricerca', esc(p.research_area || '')) +
          dd('Gruppo di ricerca', esc(p.research_group || '')) +
          dd('Dipartimento', esc(p.department || '')) +
          dd('Formazione', esc(p.education || '')) +
        '</dl>' +
        (admin ? '<div class="item-tools"><button class="btn btn-ghost btn-sm" type="button" data-action="edit-prof" data-id="' + p.id + '">' + icon('edit') + 'Modifica</button>' +
          '<button class="btn btn-ghost btn-sm danger-text" type="button" data-action="delete-prof" data-id="' + p.id + '">' + icon('trash') + 'Elimina</button></div>' : '') +
        '</div></details></li>';
    }).join('');
    render('profs',
      '<div class="page-head"><div><p class="eyebrow">Scienze e Tecnologie Chimiche</p><h1>Professori</h1>' +
        '<p class="muted">' + list.length + ' docenti. Tocca un nome per vedere corsi, ricerca e contatti.</p></div>' +
        (admin ? '<button class="btn btn-primary" type="button" data-action="edit-prof">' + icon('plus') + 'Aggiungi docente</button>' : '') + '</div>' +
      '<div class="prof-toolbar"><div class="input-ic grow">' + icon('search') +
        '<input type="search" data-prof-search placeholder="Cerca per nome, corso, ricerca o gruppo… (es. analitica)"></div></div>' +
      (depts.length ? '<div class="prof-depts" role="group" aria-label="Dipartimento"><button type="button" class="chip-btn active" data-action="prof-dept" data-dept="">Tutti</button>' +
        depts.map(function (d) { return '<button type="button" class="chip-btn" data-action="prof-dept" data-dept="' + esc(d) + '">' + esc(d) + '</button>'; }).join('') + '</div>' : '') +
      '<section class="panel prof-panel">' + (list.length ? '<ul class="prof-list">' + rows + '</ul><p class="muted small prof-none" hidden>Nessun docente corrisponde alla ricerca.</p>'
        : '<p class="muted">Nessun docente inserito.</p>') + '</section>',
      'Professori');
  }
  var profDept = '';
  function filterProfs() {
    var input = document.querySelector('[data-prof-search]');
    var q = input ? input.value.trim().toLowerCase() : '';
    var shown = 0;
    document.querySelectorAll('.prof-item').forEach(function (li) {
      var ok = (!profDept || li.getAttribute('data-dept') === profDept) && (!q || li.getAttribute('data-search').indexOf(q) >= 0);
      li.hidden = !ok;
      if (ok) shown++;
    });
    // nasconde le lettere senza docenti visibili
    document.querySelectorAll('.prof-letter').forEach(function (h) {
      var n = h.nextElementSibling, any = false;
      while (n && !n.classList.contains('prof-letter')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
      h.hidden = !any;
    });
    var none = document.querySelector('.prof-none');
    if (none) none.hidden = shown > 0;
  }
  function textarea(label, name, value, hint) {
    return '<label>' + label + (hint ? ' <small class="muted">' + hint + '</small>' : '') +
      '<textarea name="' + name + '" rows="3">' + esc(value || '') + '</textarea></label>';
  }

  // Piccolo modulo in finestra sovrapposta (per le modifiche degli admin)
  var modalSubmit = null;
  function openModal(title, fieldsHtml, onSubmit) {
    closeModal();
    modalSubmit = onSubmit;
    var wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = '<form class="modal panel form" data-form="modal" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2>' + fieldsHtml +
      '<div class="form-actions"><button class="btn btn-ghost" type="button" data-action="close-modal">Annulla</button>' +
      '<button class="btn btn-primary" type="submit">Salva</button></div></form>';
    document.body.appendChild(wrap);
    var first = wrap.querySelector('input, select, textarea');
    if (first) first.focus();
  }
  function closeModal() {
    var m = document.querySelector('.modal-backdrop');
    if (m) m.remove();
    modalSubmit = null;
  }
  function input(label, name, value, attrs) {
    return '<label>' + label + '<input type="text" name="' + name + '" value="' + esc(value || '') + '" ' + (attrs || '') + '></label>';
  }

  function errorPage(title, message) {
    render('', '<div class="panel error-card"><span class="error-code">!</span><h1>' + esc(title) + '</h1><p class="muted">' + esc(message) + '</p>' +
      '<a class="btn btn-primary" href="#/">' + icon('home') + 'Torna alla dashboard</a></div>', title);
  }

  // ---- Navigazione ------------------------------------------------------------------
  async function route() {
    if (!state.user) return loginPage();
    var h = parseHash();
    var m;
    try {
      if (h.path === '/') await dashboardPage();
      else if (h.path === '/corsi') await coursesPage(h.params);
      else if (h.path === '/nuovo-corso') await courseFormPage(null, h.params);
      else if ((m = /^\/modifica-corso\/(\d+)$/.exec(h.path))) await courseFormPage(Number(m[1]));
      else if ((m = /^\/corso\/(\d+)$/.exec(h.path))) await coursePage(Number(m[1]), h.params);
      else if ((m = /^\/file\/(\d+)$/.exec(h.path))) await filePage(Number(m[1]));
      else if (h.path === '/cerca') await searchPage(h.params);
      else if (h.path === '/miei') await minePage();
      else if ((m = /^\/utente\/([0-9a-f-]{36}|u-[\w-]+)$/.exec(h.path))) await userPage(m[1]);
      else if (h.path === '/autore') await authorPage(h.params.get('nome') || '');
      else if (h.path === '/classifica') await rankingPage();
      else if (h.path === '/rappresentanti') await repsPage();
      else if (h.path === '/professori') await profsPage();
      else if (h.path === '/admin') await adminPage(h.params);
      else errorPage('Pagina non trovata', 'La pagina che cerchi non esiste.');
    } catch (err) {
      errorPage('Si è verificato un problema', Api.friendlyError(err));
    }
  }

  // ---- Azioni ------------------------------------------------------------------------
  async function download(id) {
    var f = fileCache[id] || await Api.getFile(Number(id));
    var url = await Api.fileUrl(f, true, true);
    var a = document.createElement('a');
    a.href = url;
    a.download = f.original_name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function handleAction(el) {
    var action = el.getAttribute('data-action');
    var id = el.getAttribute('data-id');
    switch (action) {
      case 'toggle-theme': window.Theme.toggle(); refreshThemeButtons(); return;
      case 'toggle-sidebar': document.body.classList.toggle('sidebar-open'); return;
      case 'close-sidebar': document.body.classList.remove('sidebar-open'); return;
      case 'toggle-menu': {
        var menu = el.closest('.user-menu');
        el.setAttribute('aria-expanded', String(menu.classList.toggle('open')));
        return;
      }
      case 'scroll-upload': document.getElementById('upload').scrollIntoView({ behavior: 'smooth' }); return;
      case 'login': rememberTarget(); return Api.signIn().catch(fail);
      case 'logout':
        await Api.signOut();
        state.user = null;
        location.hash = '#/';
        return loginPage();
      case 'download': return download(id).catch(fail);
      case 'delete-file': {
        var f = fileCache[id];
        if (!confirm('Eliminare definitivamente «' + (f ? f.title : 'questo file') + '»?')) return;
        el.disabled = true;
        try {
          await Api.deleteFile(f || await Api.getFile(Number(id)));
          toast('File eliminato.');
          var back = el.getAttribute('data-back');
          if (back) go(back); else route();
        } catch (err) { el.disabled = false; fail(err); }
        return;
      }
      case 'delete-course': {
        var name = el.getAttribute('data-name');
        if (!confirm('Eliminare il corso «' + name + '» e TUTTI i suoi ' + el.getAttribute('data-count') + ' materiali? L\'operazione è irreversibile.')) return;
        el.disabled = true;
        try { await Api.deleteCourse(Number(id)); toast('Corso «' + name + '» eliminato.'); go('#/corsi'); }
        catch (err) { el.disabled = false; fail(err); }
        return;
      }
      case 'report': {
        var why = prompt('Perché segnali questo file? (es. contenuto pornografico, offensivo, non didattico, violazione del diritto d\'autore)');
        if (why === null) return;
        if (!why.trim()) return toast('Scrivi il motivo della segnalazione.', 'error');
        try { await Api.reportFile(Number(id), why.trim()); toast('Grazie! Gli amministratori controlleranno il file.'); }
        catch (err) { fail(err); }
        return;
      }
      case 'dismiss-reports': {
        try { await Api.dismissReports(Number(id)); toast('Segnalazioni archiviate.'); route(); } catch (err) { fail(err); }
        return;
      }
      case 'ban': {
        var name = el.getAttribute('data-name');
        var reason = prompt('Motivo della sospensione di ' + name + ' (verrà mostrato all\'utente):');
        if (reason === null) return;
        if (!reason.trim()) return toast('Indica il motivo della sospensione.', 'error');
        el.disabled = true;
        try {
          await Api.banUser(id, reason.trim());
          toast(name + ' è stato sospeso.');
          var userFiles = await Api.listUserFiles(id);
          if (userFiles.length && confirm('Eliminare anche tutti i ' + userFiles.length + ' file caricati da ' + name + '?')) {
            for (var k = 0; k < userFiles.length; k++) await Api.deleteFile(userFiles[k]);
            toast(userFiles.length + ' file eliminati.');
          }
          route();
        } catch (err) { el.disabled = false; fail(err); }
        return;
      }
      case 'new-service-token': {
        if (!confirm('Generare un nuovo codice di servizio? Il codice precedente smetterà di funzionare (script Google e robot vanno aggiornati).')) return;
        el.disabled = true;
        try {
          var code = await Api.newServiceToken();
          var box = document.querySelector('[data-token-box]');
          box.innerHTML = '<div class="token-box"><p class="small"><strong>Codice di servizio</strong> — copialo ora: non verrà più mostrato. ' +
            'Incollalo nello script Google (riga CODICE) e nei Secrets di GitHub (SERVICE_TOKEN). Non condividerlo con nessuno.</p>' +
            '<input type="text" readonly value="' + esc(code) + '" data-token-value>' +
            '<button class="btn btn-primary btn-sm" type="button" data-action="copy-token">' + icon('check') + 'Copia</button></div>';
        } catch (err) { fail(err); }
        el.disabled = false;
        return;
      }
      case 'storage-check': {
        el.disabled = true;
        var cbox = document.querySelector('[data-check-box]');
        cbox.innerHTML = '<p class="muted small">Verifica in corso…</p>';
        try {
          var chk = await Api.storageCheck();
          cbox.innerHTML = '<ul class="check-list">' + chk.results.map(function (r) {
            return '<li class="' + (r.ok ? 'ok' : 'bad') + '">' + icon(r.ok ? 'check' : 'alert') + '<div><strong>' + esc(r.message) + '</strong>' +
              (r.steps && r.steps.length ? '<small class="muted">' + r.steps.map(function (st) { return esc(st.step) + ': ' + esc(st.detail); }).join(' · ') + '</small>' : '') +
              '</div></li>';
          }).join('') + '</ul>';
        } catch (err) { cbox.innerHTML = ''; fail(err); }
        el.disabled = false;
        return;
      }
      case 'start-tour': startTour(); return;
      case 'install-app': installApp(); return;
      case 'toggle-fav': {
        var cid = Number(id);
        var favIds = (el.getAttribute('data-ids') || id).split(',').map(Number);
        var on = !favIds.some(isFav);
        el.disabled = true;
        try {
          if (on) await Api.setFavorite(cid, true);
          else await Promise.all(favIds.filter(isFav).map(function (x) { return Api.setFavorite(x, false); }));
          state.favs = on ? state.favs.concat([cid]) : state.favs.filter(function (x) { return favIds.indexOf(x) < 0; });
          document.querySelectorAll('.fav-btn').forEach(function (b) {
            var mine = (b.getAttribute('data-ids') || b.getAttribute('data-id')).split(',').map(Number);
            if (!mine.some(function (x) { return favIds.indexOf(x) >= 0; })) return;
            b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
            b.title = on ? 'Togli dai preferiti' : 'Aggiungi ai preferiti';
            b.classList.remove('pop'); void b.offsetWidth; if (on) b.classList.add('pop');
          });
          toast(on ? '⭐ Aggiunto ai tuoi corsi: lo trovi in cima alla dashboard.' : 'Tolto dai preferiti.');
        } catch (err) { fail(err); }
        el.disabled = false;
        return;
      }
      case 'vote': {
        el.disabled = true;
        try {
          var v = await Api.toggleVote(Number(id));
          el.classList.toggle('on', v.voted);
          el.querySelector('span').textContent = v.voted ? 'Ti è stato utile' : 'Utile';
          el.querySelector('[data-vote-count]').textContent = v.count;
          if (fileCache[id]) fileCache[id].vote_count = v.count;
          if (v.voted) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
        } catch (err) { fail(err); }
        el.disabled = false;
        return;
      }
      case 'set-folder': {
        var nf = prompt('Cartella del file (lascia vuoto per nessuna):', el.getAttribute('data-folder') || '');
        if (nf === null) return;
        try { await Api.setFolder(Number(id), nf); toast('Cartella aggiornata.'); route(); } catch (err) { fail(err); }
        return;
      }
      case 'go-back': {
        if (history.length > 1) history.back(); else go('#/');
        return;
      }
      case 'copy-token': {
        var field = document.querySelector('[data-token-value]');
        field.select();
        try { await navigator.clipboard.writeText(field.value); toast('Codice copiato.'); }
        catch (e) { document.execCommand('copy'); toast('Codice copiato.'); }
        return;
      }
      case 'unban': {
        el.disabled = true;
        try { await Api.unbanUser(id); toast(el.getAttribute('data-name') + ' è stato riattivato.'); route(); }
        catch (err) { el.disabled = false; fail(err); }
        return;
      }
      case 'toggle-nav-courses': {
        var tree = document.querySelector('.nav-tree');
        var open = !tree.classList.contains('open');
        tree.classList.toggle('open', open);
        el.classList.toggle('open', open);
        el.setAttribute('aria-expanded', String(open));
        try { localStorage.setItem('nav-courses', open ? '1' : '0'); } catch (e) { /* ignora */ }
        return;
      }
      case 'course-menu': {
        var box = el.closest('.course-menu');
        var wasOpen = box.classList.contains('open');
        document.querySelectorAll('.course-menu.open').forEach(function (m) { m.classList.remove('open'); });
        if (!wasOpen) box.classList.add('open');
        return;
      }
      case 'move-course': {
        var place = el.getAttribute('data-place');
        el.closest('.course-menu').classList.remove('open');
        var moveIds = (el.getAttribute('data-ids') || id).split(',').map(Number);
        try {
          for (var mi = 0; mi < moveIds.length; mi++) await Api.moveCourse(moveIds[mi], place); // tutti gli anni accademici
          toast('Corso spostato in: ' + placementLabel(place) + '.'); route();
        }
        catch (err) { fail(err); }
        return;
      }
      case 'close-modal': closeModal(); return;
      case 'edit-rep': {
        var r = infoCache.reps.find(function (x) { return String(x.id) === id; }) || {};
        openModal(r.id ? 'Modifica rappresentante' : 'Nuovo rappresentante',
          '<input type="hidden" name="id" value="' + esc(r.id || '') + '">' +
          input('Nome e cognome *', 'name', r.name, 'required maxlength="120"') +
          input('Ruolo / anno', 'role_label', r.role_label, 'maxlength="120" placeholder="es. 3° anno Triennale"') +
          input('Email', 'email', r.email, 'maxlength="200" placeholder="nome.cognome@campus.unimib.it"') +
          input('Telefono', 'phone', r.phone, 'maxlength="40" placeholder="+39 …"') +
          input('Ordine', 'sort_order', r.sort_order != null ? r.sort_order : infoCache.reps.length + 1, 'inputmode="numeric"'),
          function (data) { return Api.saveRepresentative(data); });
        return;
      }
      case 'delete-rep': {
        if (!confirm('Eliminare questo rappresentante?')) return;
        try { await Api.deleteRepresentative(Number(id)); toast('Rappresentante eliminato.'); route(); } catch (err) { fail(err); }
        return;
      }
      case 'edit-link': {
        var l = infoCache.links.find(function (x) { return String(x.id) === id; }) || { section: el.getAttribute('data-section') };
        openModal(l.id ? 'Modifica elemento' : 'Nuovo elemento',
          '<input type="hidden" name="id" value="' + esc(l.id || '') + '">' +
          '<label>Sezione<select name="section">' + INFO_SECTIONS.map(function (sx) {
            return '<option value="' + sx.key + '"' + (sx.key === l.section ? ' selected' : '') + '>' + esc(sx.title) + '</option>';
          }).join('') + '</select></label>' +
          input('Titolo *', 'label', l.label, 'required maxlength="200"') +
          input('Descrizione', 'detail', l.detail, 'maxlength="300"') +
          input('Link (https://…)', 'url', l.url, 'maxlength="500" placeholder="https://"') +
          input('Ordine', 'sort_order', l.sort_order != null ? l.sort_order : 99, 'inputmode="numeric"'),
          function (data) { return Api.saveInfoLink(data); });
        return;
      }
      case 'delete-link': {
        if (!confirm('Eliminare questo elemento?')) return;
        try { await Api.deleteInfoLink(Number(id)); toast('Elemento eliminato.'); route(); } catch (err) { fail(err); }
        return;
      }
      case 'prof-dept': {
        profDept = el.getAttribute('data-dept');
        document.querySelectorAll('.chip-btn[data-action="prof-dept"]').forEach(function (b) { b.classList.toggle('active', b === el); });
        filterProfs();
        return;
      }
      case 'edit-prof': {
        var pr = profCache.find(function (x) { return String(x.id) === id; }) || {};
        openModal(pr.id ? 'Modifica docente' : 'Nuovo docente',
          '<input type="hidden" name="id" value="' + esc(pr.id || '') + '">' +
          '<div class="form-row">' + input('Cognome *', 'last_name', pr.last_name, 'required maxlength="80"') + input('Nome *', 'first_name', pr.first_name, 'required maxlength="80"') + '</div>' +
          input('Email', 'email', pr.email, 'maxlength="200"') +
          input('Dipartimento', 'department', pr.department, 'maxlength="120"') +
          textarea('Ruoli', 'positions', pr.positions, '(uno per riga)') +
          textarea('Corsi in cui insegna', 'courses', pr.courses, '(uno per riga)') +
          textarea('Ambito di ricerca', 'research_area', pr.research_area) +
          input('Gruppo di ricerca', 'research_group', pr.research_group, 'maxlength="300"') +
          input('Formazione', 'education', pr.education, 'maxlength="200"'),
          function (data) { return Api.saveProfessor(data); });
        return;
      }
      case 'delete-prof': {
        if (!confirm('Eliminare questo docente dall\'elenco?')) return;
        try { await Api.deleteProfessor(Number(id)); toast('Docente eliminato.'); route(); } catch (err) { fail(err); }
        return;
      }
      case 'toggle-pin': {
        var pin = !el.getAttribute('data-pinned');
        el.disabled = true;
        try {
          await Api.setPinned(Number(id), pin);
          toast(pin ? 'File protetto: non verrà eliminato in automatico.' : 'Protezione rimossa.');
          route();
        } catch (err) { el.disabled = false; fail(err); }
        return;
      }
      case 'set-role': {
        var role = el.getAttribute('data-role');
        var who = el.getAttribute('data-name');
        if (role === 'student' && !confirm('Revocare il ruolo di amministratore a ' + who + '?')) return;
        el.disabled = true;
        try {
          await Api.setRole(id, role);
          toast(role === 'admin' ? who + ' ora è amministratore.' : who + ' non è più amministratore.');
          var me = await Api.refreshMe();
          if (me && me.user) state.user = me.user;
          go(isAdmin() ? '#/admin' : '#/');
        } catch (err) { el.disabled = false; fail(err); }
      }
    }
  }

  async function handleForm(form) {
    var type = form.getAttribute('data-form');
    var data = Object.fromEntries(new FormData(form).entries());
    switch (type) {
      case 'top-search':
      case 'search':
        return go('#/cerca' + qs({ q: (data.q || '').trim(), tipo: data.tipo }));
      case 'filter-courses': return go('#/corsi' + qs({ q: data.q }));
      case 'filter-users': return go('#/admin' + qs({ q: data.q }));
      case 'filter-course':
        return go('#/corso/' + form.getAttribute('data-id') + qs({ tipo: form.getAttribute('data-kind'), q: data.q, cartella: form.getAttribute('data-folder'), ordine: form.getAttribute('data-order'), aa: form.getAttribute('data-aa') }));
      case 'course': {
        var id = Number(form.getAttribute('data-id')) || null;
        if (!String(data.name || '').trim()) return toast('Il nome del corso è obbligatorio.', 'error');
        var btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          var existing = groupCourses(await Api.listCourses().catch(function () { return []; }));
          var degreeOf = (data.placement || '').split(':')[0];
          if (id) {
            // nome, codice e collocazione valgono per tutti gli anni accademici del corso (docente e descrizione no)
            var siblings = (existing.filter(function (g) { return g.ids.indexOf(id) >= 0; })[0] || { members: [] }).members
              .filter(function (c) { return c.id !== id; });
            await Api.updateCourse(id, data);
            for (var si = 0; si < siblings.length; si++) {
              var sib = siblings[si];
              await Api.updateCourse(sib.id, { name: data.name, code: data.code, placement: data.placement, year: sib.year, teacher: sib.teacher, description: sib.description });
            }
            toast('Corso aggiornato.'); go('#/corso/' + id);
          } else {
            // stesso insegnamento e stesso anno accademico già presenti: apro quello invece di creare un doppione
            var key = groupKey({ name: data.name, degree: degreeOf });
            var same = existing.filter(function (g) { return g.key === key; })[0];
            var dupAA = same && same.members.filter(function (c) { return c.aa === Api.normAA(data.year) || (!c.aa && !data.year); })[0];
            if (dupAA) { toast('Il corso «' + dupAA.name + '» esiste già per questo anno accademico: eccolo.', 'info'); return go('#/corso/' + dupAA.id); }
            var newId = await Api.createCourse(data);
            toast(same ? 'Aggiunto l\'anno accademico ' + (Api.normAA(data.year) || '') + ' al corso «' + same.name + '».' : 'Corso «' + data.name.trim() + '» creato.');
            go('#/corso/' + newId);
          }
        } catch (err) { btn.disabled = false; fail(err); }
        return;
      }
      case 'upload': return upload(form);
      case 'modal': {
        if (!modalSubmit) return closeModal();
        var save = form.querySelector('button[type=submit]');
        save.disabled = true;
        try { await modalSubmit(data); closeModal(); toast('Salvato.'); route(); }
        catch (err) { save.disabled = false; fail(err); }
        return;
      }
    }
  }

  async function upload(form) {
    var input = form.querySelector('[data-file-input]');
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return toast('Scegli almeno un file.', 'error');
    var bad = files.filter(function (f) { return !Api.typeFor(f.name); });
    if (bad.length) return toast('Formato non ammesso: ' + bad.map(function (f) { return f.name; }).join(', '), 'error');
    var big = files.filter(function (f) { return f.size > CFG.maxUploadMb * 1024 * 1024; });
    if (big.length) return toast('Supera il limite di ' + CFG.maxUploadMb + ' MB: ' + big.map(function (f) { return f.name; }).join(', '), 'error');

    var pageId = Number(form.getAttribute('data-id'));
    var courseId = form.aa && form.aa.value !== 'nuovo' ? Number(form.aa.value) : pageId;
    var newAA = form.aa && form.aa.value === 'nuovo';
    // avviso doppioni: stesso nome e stessa dimensione di un file già nel corso
    var dup = files.filter(function (f) {
      return currentCourseFiles.some(function (x) { return x.original_name === f.name && Number(x.size) === f.size; });
    });
    if (dup.length && !confirm((dup.length === 1 ? '«' + dup[0].name + '» è già presente' : dup.length + ' file sono già presenti') +
        ' in questo corso (stesso nome e dimensione).\n\nCaricare lo stesso? Premi Annulla per saltare ' + (dup.length === 1 ? 'il doppione.' : 'i doppioni.'))) {
      files = files.filter(function (f) { return dup.indexOf(f) < 0; });
      if (!files.length) return toast('Nessun file caricato: erano tutti già presenti.', 'info');
    }
    var folder = form.folder ? form.folder.value : '';
    var title = files.length === 1 ? form.title.value : '';
    var description = form.description.value;
    var btn = form.querySelector('button[type=submit]');
    var progress = form.querySelector('[data-progress]');
    var bar = form.querySelector('[data-progress-bar]');
    var label = form.querySelector('[data-progress-label]');
    btn.disabled = true;
    progress.hidden = false;
    var done = 0;
    var evicted = [];
    try {
      if (newAA) {
        // primo materiale dell'anno in corso: creo l'anno accademico copiando i dati del corso
        var base = await Api.getCourse(pageId);
        courseId = await Api.createCourse({
          name: base.name, code: base.code, teacher: base.teacher, description: '', year: currentAA(),
          placement: base.degree && base.study_year ? base.degree + ':' + base.study_year : '',
        });
      }
      for (var i = 0; i < files.length; i++) {
        var prefix = files.length > 1 ? 'File ' + (i + 1) + ' di ' + files.length + ' · ' : '';
        label.textContent = prefix + '0%';
        bar.style.width = Math.round((i / files.length) * 100) + '%';
        var result = await Api.uploadFile(courseId, files[i], { title: title, description: description, folder: folder }, function (p) {
          bar.style.width = Math.round(((i + p) / files.length) * 100) + '%';
          label.textContent = prefix + (p < 1 ? Math.round(p * 100) + '%' : 'Salvataggio…');
        });
        if (result && result.evicted) evicted = evicted.concat(result.evicted);
        done++;
        bar.style.width = Math.round((done / files.length) * 100) + '%';
      }
      toast(done === 1 ? 'File caricato con successo.' : done + ' file caricati con successo.');
      if (evicted.length) {
        toast('Per fare spazio ' + (evicted.length === 1 ? 'è stato rimosso 1 file poco usato' : 'sono stati rimossi ' + evicted.length + ' file poco usati') +
          ': ' + evicted.join(', '), 'info');
      }
      if (courseId !== pageId) go('#/corso/' + courseId); else route();
    } catch (err) {
      fail(err);
      if (done) { toast(done + ' file caricati prima dell\'errore.'); if (courseId !== pageId) go('#/corso/' + courseId); else route(); return; }
      // anno accademico appena creato ma rimasto vuoto: lo tolgo per non lasciare corsi vuoti
      if (newAA && courseId !== pageId) Api.deleteCourse(courseId).catch(function () {});
      btn.disabled = false;
      progress.hidden = true;
    }
  }

  function showSelected(input) {
    var list = input.closest('form').querySelector('[data-selected]');
    list.innerHTML = Array.prototype.map.call(input.files, function (f) {
      var ok = Api.typeFor(f.name) && f.size <= CFG.maxUploadMb * 1024 * 1024;
      return '<li class="' + (ok ? '' : 'bad') + '"><span>' + esc(f.name) + '</span><span class="muted">' +
        (ok ? bytes(f.size) : (Api.typeFor(f.name) ? 'troppo grande' : 'formato non ammesso')) + '</span></li>';
    }).join('');
  }

  // ---- Eventi globali ----------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    var menu = document.querySelector('.user-menu.open');
    if (menu && !e.target.closest('.user-menu')) menu.classList.remove('open');
    if (!e.target.closest('.course-menu')) document.querySelectorAll('.course-menu.open').forEach(function (m) { m.classList.remove('open'); });
    if (e.target.classList && e.target.classList.contains('modal-backdrop')) closeModal();
    if (!el) return;
    if (el.tagName === 'A') e.preventDefault();
    handleAction(el);
  });
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    handleForm(form);
  });
  document.addEventListener('input', function (e) {
    if (e.target.matches('[data-prof-search]')) filterProfs();
  });
  document.addEventListener('change', function (e) {
    if (e.target.matches('[data-file-input]')) showSelected(e.target);
    if (e.target.matches('select[data-course-sort]')) {
      var hp = parseHash().params;
      hp.set('ordine', e.target.value === 'recenti' ? '' : e.target.value);
      var obj = {}; hp.forEach(function (v, k) { obj[k] = v; });
      go('#/corso/' + e.target.getAttribute('data-id') + qs(obj));
    }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var zone = e.target.closest && e.target.closest('[data-dropzone]');
      if (zone) { e.preventDefault(); zone.classList.add('drag'); }
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var zone = e.target.closest && e.target.closest('[data-dropzone]');
      if (!zone) return;
      zone.classList.remove('drag');
      if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files.length) {
        e.preventDefault();
        var input = zone.querySelector('input');
        input.files = e.dataTransfer.files;
        showSelected(input);
      }
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeModal();
      document.querySelectorAll('.course-menu.open').forEach(function (m) { m.classList.remove('open'); });
      document.body.classList.remove('sidebar-open');
      var menu = document.querySelector('.user-menu.open');
      if (menu) menu.classList.remove('open');
    }
  });
  if (window.Theme) window.Theme.onChange = refreshThemeButtons;
  window.addEventListener('hashchange', function () {
    if (location.hash === '#upload') return; // ancora interna della pagina corso
    route();
  });

  // App sul telefono: Android/Chrome propone l'installazione; su iPhone/iPad si usa "Aggiungi alla schermata Home"
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; });
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function infoModal(title, html) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = '<div class="modal panel" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2>' + html +
      '<div class="form-actions"><button class="btn btn-primary" type="button" data-action="close-modal">Ho capito</button></div></div>';
    document.body.appendChild(wrap);
  }
  async function installApp() {
    if (installPrompt) {
      installPrompt.prompt();
      var choice = await installPrompt.userChoice.catch(function () { return null; });
      installPrompt = null;
      if (choice && choice.outcome === 'accepted') toast('App installata: la trovi tra le app del telefono.');
      return;
    }
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    infoModal('Installa l\'app', ios
      ? '<ol class="install-steps"><li>Apri il sito con <strong>Safari</strong>.</li><li>Tocca il pulsante <strong>Condividi</strong> (il quadrato con la freccia in su).</li>' +
        '<li>Scegli <strong>Aggiungi alla schermata Home</strong> e poi <strong>Aggiungi</strong>.</li></ol>' +
        '<p class="muted small">L\'icona compare tra le tue app: si apre a schermo intero, come un\'app vera. La prima volta accedi di nuovo con l\'account @' + esc(CFG.allowedDomain) + '.</p>'
      : '<ol class="install-steps"><li>Apri il sito con <strong>Chrome</strong>.</li><li>Tocca il menu <strong>⋮</strong> in alto a destra.</li>' +
        '<li>Scegli <strong>Installa app</strong> (oppure <strong>Aggiungi a schermata Home</strong>).</li></ol>' +
        '<p class="muted small">L\'icona compare tra le tue app e si apre a schermo intero.</p>');
  }

  // Tour di benvenuto al primo accesso dell'account
  function startTour() {
    if (!window.Tour || window.Tour.running() || !state.user) return;
    window.Tour.start({ name: state.user.name, onDone: function () { Api.tourDone(); } });
  }
  // Dati personali: ultima visita (badge "Nuovo") e corsi preferiti
  async function loadPersonal() {
    var since = await Api.visit().catch(function () { return null; });
    if (!since) { // database non aggiornato: ricordo l'ultima visita su questo dispositivo
      try {
        var key = 'last-visit:' + state.user.id, raw = JSON.parse(localStorage.getItem(key) || 'null');
        var now = new Date().toISOString();
        if (!raw || Date.now() - Date.parse(raw.seen) > 3600000) raw = { prev: raw ? raw.seen : now, seen: now }; else raw.seen = now;
        localStorage.setItem(key, JSON.stringify(raw));
        since = raw.prev;
      } catch (e) { since = null; }
    }
    state.since = since;
    var r = await Promise.all([Api.listFavorites().catch(function () { return []; }), Api.newCounts(since).catch(function () { return {}; })]);
    state.favs = r[0].map(Number);
    state.newCounts = r[1];
  }

  // Link aperto senza accesso (es. un corso ricevuto in chat): dopo il login con Google si torna lì.
  // Il ritorno da Google perde la parte "#/..." dell'indirizzo, quindi la ricordo sul dispositivo per 15 minuti.
  var TARGET_KEY = 'after-login';
  function rememberTarget() {
    var h = location.hash;
    try {
      if (h && h !== '#/' && h.indexOf('#/') === 0) localStorage.setItem(TARGET_KEY, JSON.stringify({ hash: h, at: Date.now() }));
      else localStorage.removeItem(TARGET_KEY);
    } catch (e) { /* ignora */ }
  }
  function restoreTarget() {
    try {
      var saved = JSON.parse(localStorage.getItem(TARGET_KEY) || 'null');
      localStorage.removeItem(TARGET_KEY);
      if (saved && /^#\/[^\s]*$/.test(saved.hash) && Date.now() - saved.at < 15 * 60000 && (location.hash || '#/') === '#/') {
        history.replaceState(null, '', location.pathname + location.search + saved.hash);
      }
    } catch (e) { /* ignora */ }
  }

  function maybeTour() {
    Api.tourPending().then(function (pending) { if (pending) setTimeout(startTour, 700); }, function () {});
  }

  // ---- Avvio -------------------------------------------------------------------------
  Api.init().then(function (res) {
    if (res && res.user) {
      state.user = res.user;
      restoreTarget();
      return loadPersonal().catch(function () {}).then(route).then(maybeTour);
    }
    if (res && res.error === 'domain') {
      return loginPage('L\'account ' + (res.email || '') + ' non è un account @' + CFG.allowedDomain + '. Esci da Google e accedi con l\'account universitario.');
    }
    if (res && res.error === 'banned') return bannedPage(res.reason, res.email);
    if (res && res.error === 'profile') return loginPage('Profilo non trovato. Riprova tra qualche secondo o contatta un amministratore.');
    loginPage();
  }).catch(function (err) {
    loginPage(Api.friendlyError(err));
  });
})();
