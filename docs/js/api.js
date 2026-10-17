/*
 * Accesso ai dati. Due implementazioni con la stessa interfaccia:
 *  - SupabaseApi: quella reale (login Google, database e archivio file su Supabase)
 *  - DemoApi:     anteprima senza configurazione, dati in memoria sul dispositivo
 * I permessi veri sono imposti dal database (supabase/setup.sql): l'interfaccia
 * nasconde i pulsanti, ma non è l'unica protezione.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};

  // Formati ammessi: il tipo MIME è deciso dall'estensione, non dal browser.
  var TYPES = {
    pdf: ['application/pdf', 'pdf'],
    jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'], png: ['image/png', 'image'],
    gif: ['image/gif', 'image'], webp: ['image/webp', 'image'], avif: ['image/avif', 'image'],
    mp3: ['audio/mpeg', 'audio'], m4a: ['audio/mp4', 'audio'], aac: ['audio/aac', 'audio'],
    wav: ['audio/wav', 'audio'], ogg: ['audio/ogg', 'audio'], oga: ['audio/ogg', 'audio'],
    opus: ['audio/opus', 'audio'], flac: ['audio/flac', 'audio'],
    mp4: ['video/mp4', 'video'], webm: ['video/webm', 'video'], mov: ['video/quicktime', 'video'],
    doc: ['application/msword', 'document'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
    ppt: ['application/vnd.ms-powerpoint', 'document'],
    pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document'],
    xls: ['application/vnd.ms-excel', 'document'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document'],
    odt: ['application/vnd.oasis.opendocument.text', 'document'],
    odp: ['application/vnd.oasis.opendocument.presentation', 'document'],
    ods: ['application/vnd.oasis.opendocument.spreadsheet', 'document'],
    txt: ['text/plain', 'document'], md: ['text/plain', 'document'],
    zip: ['application/zip', 'other'],
    cif: ['application/octet-stream', 'other'], mryx: ['application/octet-stream', 'other'],
  };
  // File che stanno sugli archivi esterni (Backblaze B2 o Cloudflare R2), gestiti dalla funzione
  function external(f) { return f.storage === 'b2' || f.storage === 'r2'; }

  function typeFor(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    var ext = m ? m[1].toLowerCase() : '';
    var t = TYPES[ext];
    return t ? { ext: ext, mime: t[0], kind: t[1] } : null;
  }

  function emailAllowed(email) {
    return typeof email === 'string' && email.toLowerCase().endsWith('@' + CFG.allowedDomain);
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, '').slice(0, 200) || name; }
  function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
  // Anno accademico in forma standard "2026/2027" (accetta "2026-27", "26/27", "2026"...)
  function normAA(v) {
    var m = /(\d{4}|\d{2})\s*[\/\-–]\s*(\d{4}|\d{2})/.exec(String(v || ''));
    var start = m ? Number(m[1]) : Number((/(?:^|\D)(\d{4})(?:\D|$)/.exec(String(v || '')) || [])[1]);
    if (!start) return '';
    if (start < 100) start += 2000;
    if (start < 1990 || start > 2100) return '';
    return start + '/' + (start + 1);
  }

  // "triennale:2" → { degree: 'triennale', study_year: 2 }; "" → da assegnare
  function parsePlacement(v) {
    var m = /^(triennale|magistrale):([1-3])$/.exec(v || '');
    if (!m || (m[1] === 'magistrale' && m[2] === '3')) return { degree: null, study_year: null };
    return { degree: m[1], study_year: Number(m[2]) };
  }
  function courseFields(d) {
    var f = {
      name: clean(d.name, 140), code: clean(d.code, 30) || null, teacher: clean(d.teacher, 120) || null,
      year: normAA(d.year) || clean(d.year, 30) || null, description: clean(d.description, 2000) || null,
    };
    if ('placement' in d) Object.assign(f, parsePlacement(d.placement));
    return f;
  }
  // Per i filtri di ricerca di PostgREST: tolgo i caratteri con significato speciale.
  function safeQuery(q) { return clean(q, 100).replace(/[%*,()\\."':]/g, ' ').trim(); }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  function friendlyError(err) {
    var msg = (err && (err.message || err.error_description || err.error)) || String(err);
    if (/row-level security|permission denied|not authorized|Unauthorized/i.test(msg)) return 'Non hai i permessi per questa operazione.';
    if (/exceeded the maximum allowed size|Payload too large|413/i.test(msg)) return 'File troppo grande: il limite è ' + CFG.maxUploadMb + ' MB.';
    if (/mime type .* is not supported|invalid_mime_type/i.test(msg)) return 'Formato di file non ammesso.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Connessione assente o instabile. Riprova.';
    return msg;
  }

  // ===========================================================================
  //  Supabase (versione reale)
  // ===========================================================================
  function SupabaseApi() {
    var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    var BUCKET = 'materiali';
    var FILE_SELECT = '*, course:courses(id, name, color), uploader:profiles!uploaded_by(name)';
    var USE_B2 = CFG.storage === 'b2';
    var me = null;
    var urlCache = {};

    // Chiamata alla funzione "b2" su Supabase (archivio Backblaze B2)
    async function b2(body) {
      var session = (await sb.auth.getSession()).data.session;
      if (!session) throw new Error('Sessione scaduta: accedi di nuovo.');
      var res;
      try {
        res = await fetch(CFG.supabaseUrl + '/functions/v1/' + encodeURIComponent(CFG.b2FunctionName || 'b2'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: CFG.supabaseAnonKey },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new Error(navigator.onLine === false ? 'Connessione assente. Riprova.'
          : 'Impossibile contattare l\'archivio (funzione "b2" su Supabase non raggiungibile: controlla che esista con questo nome e che "Verify JWT" sia disattivato).');
      }
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 404) throw new Error('Archivio B2 non ancora installato (funzione "' + (CFG.b2FunctionName || 'b2') + '" mancante su Supabase).');
      if (!res.ok) throw new Error(data.error || 'Errore dell\'archivio (' + res.status + ').');
      return data;
    }

    // Caricamento diretto su B2 con barra di avanzamento
    function putWithProgress(url, file, contentType, onProgress) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error('Caricamento non riuscito (errore ' + xhr.status + ').'));
        };
        xhr.onerror = function () { reject(new Error('Caricamento interrotto: controlla la connessione e riprova.')); };
        xhr.send(file);
      });
    }

    function check(res) {
      if (res.error) throw new Error(friendlyError(res.error));
      return res.data;
    }

    async function loadMe(session) {
      if (!session) { me = null; return null; }
      var email = session.user.email || '';
      if (!emailAllowed(email)) {
        await sb.auth.signOut();
        me = null;
        return { error: 'domain', email: email };
      }
      var res = await sb.from('profiles').select('id, email, name, role, created_at').eq('id', session.user.id).maybeSingle();
      if (res.error || !res.data) {
        // Profilo non visibile: account sospeso?
        var st = await sb.rpc('my_status');
        if (st.data && st.data.banned) return { error: 'banned', reason: st.data.reason, email: email };
        return { error: 'profile' };
      }
      me = res.data;
      return { user: me };
    }

    return {
      demo: false,
      typeFor: typeFor,

      async init() {
        var res = await sb.auth.getSession();
        // Rimuove ?code=... dall'indirizzo dopo il ritorno da Google
        if (/[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
        return loadMe(res.data.session);
      },

      async refreshMe() {
        var res = await sb.auth.getSession();
        return loadMe(res.data.session);
      },

      async signIn() {
        var res = await sb.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: location.origin + location.pathname,
            queryParams: { hd: CFG.allowedDomain, prompt: 'select_account' },
          },
        });
        check(res);
      },

      async signOut() { await sb.auth.signOut(); me = null; },

      async stats() { return check(await sb.rpc('stats')) || { courses: 0, files: 0, users: 0, bytes: 0 }; },

      async listCourses() {
        var rows = check(await sb.from('courses').select('*, files(count)').order('name'));
        return rows.map(function (c) {
          c.file_count = c.files && c.files[0] ? c.files[0].count : 0;
          delete c.files;
          return c;
        });
      },

      async getCourse(id) {
        return check(await sb.from('courses').select('*').eq('id', id).maybeSingle());
      },

      async createCourse(data) {
        var f = courseFields(data);
        if (!f.degree) { delete f.degree; delete f.study_year; }
        return check(await sb.from('courses').insert(f).select('id').single()).id;
      },

      async moveCourse(id, placement) {
        var rows = check(await sb.from('courses').update(parsePlacement(placement)).eq('id', id).select('id'));
        if (!rows.length) throw new Error('Non hai i permessi per questa operazione.');
      },

      async updateCourse(id, data) {
        var rows = check(await sb.from('courses').update(courseFields(data)).eq('id', id).select('id'));
        if (!rows.length) throw new Error('Non hai i permessi per questa operazione.');
      },

      async deleteCourse(id) {
        var files = check(await sb.from('files').select('storage_path, storage').eq('course_id', id));
        if (files.some(external)) await b2({ action: 'delete-course-files', courseId: id });
        files = files.filter(function (f) { return !external(f); });
        for (var i = 0; i < files.length; i += 100) {
          check(await sb.storage.from(BUCKET).remove(files.slice(i, i + 100).map(function (f) { return f.storage_path; })));
        }
        var rows = check(await sb.from('courses').delete().eq('id', id).select('id'));
        if (!rows.length) throw new Error('Non hai i permessi per questa operazione.');
      },

      async listFiles(opts) {
        opts = opts || {};
        var q = sb.from('files').select(FILE_SELECT).order('created_at', { ascending: false });
        if (opts.courseId) q = q.eq('course_id', opts.courseId);
        if (opts.kind) q = q.eq('kind', opts.kind);
        if (opts.mine && me) q = q.eq('uploaded_by', me.id);
        if (opts.uploader) q = q.eq('uploaded_by', opts.uploader);
        if (opts.authorName) q = q.is('uploaded_by', null).eq('author_name', opts.authorName);
        var s = opts.q ? safeQuery(opts.q) : '';
        if (s) q = q.or('title.ilike.*' + s + '*,description.ilike.*' + s + '*,original_name.ilike.*' + s + '*');
        q = q.limit(opts.limit || 300);
        return check(await q);
      },

      async getFile(id) {
        return check(await sb.from('files').select(FILE_SELECT).eq('id', id).maybeSingle());
      },

      // Profilo pubblico di uno studente (solo dati visibili a tutti)
      async getProfile(id) {
        return check(await sb.from('profiles').select('id, name, role, points, upload_count, created_at').eq('id', id).maybeSingle());
      },

      async uploadFile(courseId, file, meta, onProgress) {
        var t = typeFor(file.name);
        if (!t) throw new Error('Formato non ammesso: ' + file.name);
        if (file.size > CFG.maxUploadMb * 1024 * 1024) throw new Error('«' + file.name + '» supera il limite di ' + CFG.maxUploadMb + ' MB.');
        if (USE_B2) {
          var up = await b2({ action: 'upload', name: file.name, size: file.size });
          try {
            await putWithProgress(up.url, file, up.contentType, onProgress);
          } catch (e) {
            if (up.store === 'r2' && /interrotto/.test(e.message)) {
              throw new Error('Cloudflare ha rifiutato il caricamento della registrazione. Un amministratore può controllare con «Verifica archivi» in Amministrazione.');
            }
            throw e;
          }
          var done = await b2({
            action: 'confirm', key: up.key, name: file.name, courseId: courseId, store: up.store,
            title: clean(meta.title, 200), description: clean(meta.description, 2000),
          });
          if (meta.folder) await this.setFolder(done.id, meta.folder).catch(function () {});
          return { id: done.id, evicted: up.evicted || [] };
        }
        var path = me.id + '/' + uuid() + '.' + t.ext;
        check(await sb.storage.from(BUCKET).upload(path, file, { contentType: t.mime, upsert: false, cacheControl: '3600' }));
        var newId = { evicted: [], id: check(await sb.from('files').insert({
          course_id: courseId,
          title: clean(meta.title, 200) || baseName(file.name),
          description: clean(meta.description, 2000) || null,
          original_name: file.name.slice(0, 255),
          storage_path: path,
          mime: t.mime,
          kind: t.kind,
          size: file.size,
        }).select('id').single()).id };
        if (meta.folder) await this.setFolder(newId.id, meta.folder).catch(function () {});
        return newId;
      },

      async fileUrl(file, download, count) {
        // Conta un'apertura (al massimo una al giorno per studente, lo decide il database)
        if (count) sb.rpc('record_file_open', { fid: file.id }).then(function () {}, function () {});
        if (external(file)) {
          var ck = file.id + (download ? ':d' : ':v');
          var hit = urlCache[ck];
          if (hit && hit.until > Date.now()) return hit.url;
          var r = await b2({ action: 'url', id: file.id, download: Boolean(download) });
          urlCache[ck] = { url: r.url, until: Date.now() + (r.expires - 300) * 1000 };
          return r.url;
        }
        var res = await sb.storage.from(BUCKET).createSignedUrl(file.storage_path, 3600, download ? { download: file.original_name } : undefined);
        return check(res).signedUrl;
      },

      async deleteFile(file) {
        if (external(file)) { await b2({ action: 'delete', id: file.id }); return; }
        check(await sb.storage.from(BUCKET).remove([file.storage_path]));
        var rows = check(await sb.from('files').delete().eq('id', file.id).select('id'));
        if (!rows.length) throw new Error('Non hai i permessi per questa operazione.');
      },

      async listUsers() {
        return (check(await sb.rpc('admin_users')) || []).map(function (u) { u.uploads = u.upload_count; return u; });
      },

      async leaderboard() { return check(await sb.rpc('leaderboard')) || []; },
      // Corsi aperti di recente (salvati sull'account). null se il database non è ancora aggiornato.
      async recentCourses() {
        var res = await sb.rpc('my_recent_courses');
        return res.error ? null : (res.data || []).map(function (r) { return Number(typeof r === 'object' ? r.my_recent_courses : r); });
      },
      recordCourseVisit(courseId) { sb.rpc('record_course_visit', { cid: Number(courseId) }).then(function () {}, function () {}); },
      async banUser(userId, reason) { check(await sb.rpc('ban_user', { target: userId, reason: reason })); },
      async unbanUser(userId) { check(await sb.rpc('unban_user', { target: userId })); },
      async reportFile(fileId, reason) {
        var res = await sb.from('reports').insert({ file_id: fileId, reason: clean(reason, 300) });
        if (res.error && /duplicate|unique/i.test(res.error.message)) throw new Error('Hai già segnalato questo file.');
        check(res);
      },
      async listReports() {
        return check(await sb.from('reports')
          .select('id, reason, created_at, file_id, file:files(id, title, uploaded_by, uploader:profiles!uploaded_by(name)), reporter:profiles!user_id(name)')
          .order('created_at', { ascending: false }).limit(200)) || [];
      },
      async dismissReports(fileId) { check(await sb.from('reports').delete().eq('file_id', fileId)); },

      // Pagina Rappresentanti
      async listRepresentatives() { return check(await sb.from('representatives').select('*').order('sort_order').order('name')) || []; },
      async listInfoLinks() { return check(await sb.from('info_links').select('*').order('sort_order').order('id')) || []; },
      async saveRepresentative(r) {
        var row = { name: clean(r.name, 120), role_label: clean(r.role_label, 120) || null, email: clean(r.email, 200) || null,
          phone: clean(r.phone, 40) || null, sort_order: Number(r.sort_order) || 0 };
        if (r.id) check(await sb.from('representatives').update(row).eq('id', r.id).select('id'));
        else check(await sb.from('representatives').insert(row).select('id'));
      },
      async deleteRepresentative(id) { check(await sb.from('representatives').delete().eq('id', id)); },
      async saveInfoLink(l) {
        var row = { section: l.section, label: clean(l.label, 200), detail: clean(l.detail, 300) || null,
          url: clean(l.url, 500) || null, sort_order: Number(l.sort_order) || 0 };
        if (row.url && !/^https:\/\//.test(row.url)) throw new Error('Il link deve iniziare con https://');
        if (l.id) check(await sb.from('info_links').update(row).eq('id', l.id).select('id'));
        else check(await sb.from('info_links').insert(row).select('id'));
      },
      async deleteInfoLink(id) { check(await sb.from('info_links').delete().eq('id', id)); },

      // Pagina Professori
      async listProfessors() { return check(await sb.from('professors').select('*').order('last_name').order('first_name')) || []; },
      async saveProfessor(d) {
        var row = {
          last_name: clean(d.last_name, 80), first_name: clean(d.first_name, 80), email: clean(d.email, 200) || null,
          department: clean(d.department, 120) || null, research_group: clean(d.research_group, 300) || null,
          research_area: clean(d.research_area, 500) || null, positions: clean(d.positions, 1000) || null,
          courses: clean(d.courses, 3000) || null, education: clean(d.education, 200) || null,
        };
        if (d.id) check(await sb.from('professors').update(row).eq('id', d.id).select('id'));
        else check(await sb.from('professors').insert(row).select('id'));
      },
      async deleteProfessor(id) { check(await sb.from('professors').delete().eq('id', id)); },
      async listUserFiles(userId) {
        return check(await sb.from('files').select('id, title, storage, storage_path').eq('uploaded_by', userId).limit(1000)) || [];
      },

      async setRole(userId, role) { check(await sb.rpc('set_role', { target: userId, new_role: role })); },

      async setPinned(fileId, value) { check(await sb.rpc('set_pinned', { fid: fileId, value: Boolean(value) })); },

      // Prossimi file eliminabili in automatico, per archivio ('b2' documenti, 'r2' registrazioni)
      async evictionPreview(store) {
        if (!USE_B2) return [];
        var res = await sb.rpc('storage_eviction_preview', { st: store || 'b2', lim: 5 });
        if (res.error && store !== 'r2') return check(await sb.rpc('b2_eviction_preview', { lim: 5 })) || []; // database non aggiornato
        return check(res) || [];
      },

      // Spazio usato rispetto al limite dell'archivio in uso (r2: Cloudflare, se configurato)
      async usage() {
        if (USE_B2) {
          var u = await b2({ action: 'usage' });
          return { used: u.used, quota: u.quota, where: 'Backblaze B2', r2: u.r2 || null };
        }
        var st = await this.stats();
        return { used: st.bytes - (st.b2_bytes || 0), quota: 1024 * 1024 * 1024, where: 'Supabase' };
      },

      async storageCheck() { return b2({ action: 'storage-check' }); },

      // Ultima visita: i file caricati dopo questa data sono "Nuovi" (null se il database non è aggiornato)
      async visit() {
        var res = await sb.rpc('visit');
        return res.error ? null : res.data;
      },
      // Numero di file nuovi per corso (escludendo i miei)
      async newCounts(since) {
        if (!since || !me) return {};
        var res = await sb.from('files').select('course_id').gt('created_at', since)
          .or('uploaded_by.is.null,uploaded_by.neq.' + me.id).limit(2000);
        var out = {};
        (res.data || []).forEach(function (r) { out[r.course_id] = (out[r.course_id] || 0) + 1; });
        return out;
      },
      // Corsi preferiti ⭐
      async listFavorites() {
        var res = await sb.from('course_favorites').select('course_id').order('created_at');
        return res.error ? [] : res.data.map(function (r) { return r.course_id; });
      },
      async setFavorite(courseId, on) {
        if (on) check(await sb.from('course_favorites').insert({ course_id: courseId }));
        else check(await sb.from('course_favorites').delete().eq('course_id', courseId));
      },
      // Voti "Utile 👍"
      async toggleVote(fileId) { return check(await sb.rpc('toggle_vote', { fid: fileId })); },
      async myVotes(ids) {
        if (!ids.length) return [];
        var res = await sb.rpc('my_votes', { ids: ids });
        return res.error ? [] : (res.data || []).map(function (r) { return Number(typeof r === 'object' ? r.my_votes : r); });
      },
      async setFolder(fileId, name) { check(await sb.rpc('set_folder', { fid: fileId, name: clean(name, 120) })); },
      async adminStats() {
        var res = await sb.rpc('admin_stats');
        return res.error ? null : res.data;
      },

      // Tour di benvenuto: true se l'account non l'ha ancora visto (null se il database non è aggiornato)
      async tourPending() {
        var res = await sb.rpc('tour_pending');
        return res.error ? null : Boolean(res.data);
      },
      tourDone() { sb.rpc('tour_done').then(function () {}, function () {}); },

      // Importazione dal vecchio Drive (null se il database non è ancora aggiornato)
      async importStatus() {
        var res = await sb.rpc('import_status');
        return res.error ? null : res.data;
      },
      async newServiceToken() { return check(await sb.rpc('new_service_token')); },

      async listAudit() {
        return check(await sb.from('audit_log').select('*, user:profiles(name)').order('id', { ascending: false }).limit(40));
      },
    };
  }

  // ===========================================================================
  //  Anteprima (nessuna configurazione): dati di esempio in memoria
  // ===========================================================================
  function DemoApi() {
    var now = Date.now();
    var iso = function (minsAgo) { return new Date(now - minsAgo * 60000).toISOString(); };
    var me = null;
    var seq = 100;
    var users = [
      { id: 'u-demo', email: 'tu@' + CFG.allowedDomain, name: 'Studente Anteprima', role: 'admin', created_at: iso(5000) },
      { id: 'u-2', email: 'g.bianchi@' + CFG.allowedDomain, name: 'Giulia Bianchi', role: 'student', created_at: iso(4000) },
      { id: 'u-3', email: 'l.ferrari@' + CFG.allowedDomain, name: 'Luca Ferrari', role: 'student', created_at: iso(3000) },
    ];
    var courses = [
      { id: 1, name: 'Chimica Generale e Inorganica', code: 'CHI-101', teacher: 'Rossi', year: '2026/2027', color: 0, degree: 'triennale', study_year: 1, description: 'Struttura atomica, legame chimico, stechiometria, equilibri in soluzione.' },
      { id: 2, name: 'Chimica Organica I', code: 'CHI-201', teacher: 'Colombo', year: '2026/2027', color: 2, degree: 'triennale', study_year: 2, description: 'Gruppi funzionali, stereochimica, meccanismi di reazione.' },
      { id: 3, name: 'Chimica Analitica', code: 'CHI-210', teacher: 'Ricci', year: '2026/2027', color: 1, degree: 'triennale', study_year: 2, description: 'Analisi quantitativa, titolazioni, metodi strumentali.' },
      { id: 4, name: 'Chimica Fisica Avanzata', code: 'CHI-520', teacher: 'Marino', year: '2026/2027', color: 3, degree: 'magistrale', study_year: 1, description: 'Termodinamica statistica e spettroscopia.' },
      { id: 5, name: 'Matematica', code: 'MAT-101', teacher: 'Greco', year: '2025-26', color: 4, degree: null, study_year: null, description: '' },
    ];
    var files = [];
    var blobs = {};
    var audit = [];
    var reports = [];
    // Dati di esempio (fittizi) per l'anteprima
    var reps = [
      { id: 901, name: 'Mario Rossi', role_label: '3° anno Triennale', email: 'm.rossi@' + CFG.allowedDomain, phone: '+39 000 0000000', sort_order: 1 },
      { id: 902, name: 'Giulia Bianchi', role_label: '2° anno Magistrale', email: 'g.bianchi@' + CFG.allowedDomain, phone: null, sort_order: 2 },
    ];
    // Docenti fittizi per l'anteprima
    var profs = [
      { id: 921, last_name: 'Bianchi', first_name: 'Anna', email: 'anna.bianchi@example.org', department: 'Scienza dei materiali', research_group: 'Gruppo Esempio: Bianchi, Verdi', research_area: 'Sintesi di materiali per l\'energia', positions: 'Professore ordinario\nDirettrice del laboratorio', courses: 'Chimica generale\nChimica inorganica 1', education: 'Chimica' },
      { id: 922, last_name: 'Verdi', first_name: 'Paolo', email: 'paolo.verdi@example.org', department: 'DISAT', research_group: null, research_area: 'Chimica analitica ambientale', positions: 'Professore associato', courses: 'Chimica analitica\nChimica analitica strumentale', education: 'Chimica, Scienze ambientali' },
      { id: 923, last_name: 'Neri', first_name: 'Sara', email: 'sara.neri@example.org', department: 'Biotecnologie e bioscienze', research_group: 'Lab Esempio: Neri', research_area: 'Studi con NMR', positions: 'Ricercatore a tempo determinato', courses: 'Chimica organica 2', education: 'Biotecnologie' },
    ];
    var links = [
      { id: 911, section: 'matricole', label: 'Gruppo WhatsApp delle matricole', detail: 'Link di esempio', url: 'https://example.com/' },
      { id: 912, section: 'siti', label: 'e-Learning di Ateneo', detail: 'Corsi e materiali dei docenti', url: 'https://elearning.unimib.it/' },
      { id: 913, section: 'app', label: 'BicoccApp', detail: 'L\'app ufficiale dell\'Ateneo', url: 'https://play.google.com/store/apps/details?id=it.bicoccapp.unimib&hl=it' },
      { id: 914, section: 'esami', label: 'Chimica Generale', detail: 'Primo anno · 14 CFU', url: null },
      { id: 915, section: 'rappresentanza', label: 'Come fare il rappresentante?', detail: 'Tutte le informazioni', url: 'https://linktr.ee/splunimib' },
    ];

    function pdfBlob(title) {
      var text = 'BT /F1 26 Tf 60 760 Td (' + title.replace(/[()\\]/g, '') + ') Tj ET';
      var src = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
        '4 0 obj<</Length ' + text.length + '>>stream\n' + text + '\nendstream endobj\n' +
        '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
      return new Blob([src], { type: 'application/pdf' });
    }
    function wavBlob() {
      var rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / rate) * 6000 * (1 - i / n), true);
      return new Blob([buf], { type: 'audio/wav' });
    }
    function imgBlob() {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><defs><linearGradient id="g" x1="0" x2="1">' +
        '<stop offset="0" stop-color="#1d4e89"/><stop offset="1" stop-color="#34977a"/></linearGradient></defs>' +
        '<rect width="640" height="400" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="5" opacity=".9">' +
        '<polygon points="320,120 390,160 390,240 320,280 250,240 250,160"/><line x1="390" y1="160" x2="470" y2="115"/>' +
        '<line x1="250" y1="240" x2="170" y2="285"/></g><text x="320" y="360" font-family="Arial" font-size="28" fill="#fff" text-anchor="middle">Anello benzenico</text></svg>';
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas'); c.width = 640; c.height = 400;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(resolve, 'image/png');
        };
        img.onerror = function () { resolve(new Blob([svg], { type: 'image/png' })); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }
    var favorites = [];
    var votes = {};
    function addFile(courseId, name, blob, title, uploader, minsAgo, description) {
      var t = typeFor(name);
      var id = ++seq;
      blobs[id] = blob;
      files.push({
        id: id, course_id: courseId, title: title || baseName(name), description: description || null,
        original_name: name, storage_path: 'demo/' + id, mime: t.mime, kind: t.kind, size: blob.size,
        uploaded_by: uploader, created_at: iso(minsAgo || 0),
      });
      return id;
    }
    function withRefs(f) {
      var c = courses.find(function (x) { return x.id === f.course_id; }) || {};
      var u = users.find(function (x) { return x.id === f.uploaded_by; });
      return Object.assign({}, f, { course: { id: c.id, name: c.name, color: c.color }, uploader: u ? { name: u.name } : null });
    }
    function log(action, details) { audit.unshift({ id: ++seq, action: action, details: details, created_at: iso(0), user: me ? { name: me.name } : null }); }
    function requireAdmin() { if (!me || me.role !== 'admin') throw new Error('Non hai i permessi per questa operazione.'); }
    var wait = function () { return new Promise(function (r) { setTimeout(r, 120); }); };

    var seeded = (async function () {
      addFile(1, 'Lezione 01 - Struttura atomica.pdf', pdfBlob('Lezione 1 - Struttura atomica'), null, 'u-2', 3000);
      addFile(1, 'Esercizi stechiometria.pdf', pdfBlob('Esercizi di stechiometria'), 'Esercizi di stechiometria (con soluzioni)', 'u-3', 2000, 'Raccolta di esercizi svolti in aula.');
      addFile(1, 'Registrazione lezione 3.wav', wavBlob(), 'Registrazione – Lezione 3: legame covalente', 'u-2', 900);
      addFile(2, 'Benzene.png', await imgBlob(), 'Schema anello benzenico', 'u-3', 600);
      addFile(2, 'Appunti stereochimica.pdf', pdfBlob('Appunti di stereochimica'), null, 'u-2', 120);
      addFile(3, 'Titolazioni acido-base.pdf', pdfBlob('Titolazioni acido-base'), null, 'u-3', 60);
      // cartelle di esempio nel primo corso
      files[0].folder = 'Lezioni'; files[1].folder = 'Esercizi'; files[2].folder = 'Registrazioni';
    })();

    return {
      demo: true,
      typeFor: typeFor,
      async init() {
        await seeded;
        try { if (sessionStorage.getItem('demo-login')) me = users[0]; } catch (e) { /* storage non disponibile */ }
        return me ? { user: me } : null;
      },
      async refreshMe() { return me ? { user: me } : null; },
      async signIn() {
        me = users[0];
        try { sessionStorage.setItem('demo-login', '1'); } catch (e) { /* ignora */ }
        location.hash = '#/';
        location.reload();
      },
      async signOut() { me = null; try { sessionStorage.removeItem('demo-login'); } catch (e) { /* ignora */ } },
      async stats() {
        await wait();
        return { courses: courses.length, files: files.length, users: users.length, bytes: files.reduce(function (a, f) { return a + f.size; }, 0) };
      },
      async listCourses() {
        await wait();
        return courses.map(function (c) {
          return Object.assign({}, c, { file_count: files.filter(function (f) { return f.course_id === c.id; }).length });
        }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      },
      async getCourse(id) { return courses.find(function (c) { return c.id === id; }) || null; },
      async createCourse(data) {
        var c = Object.assign({ id: ++seq, color: courses.length % 8, created_at: iso(0) }, courseFields(data));
        if (!c.name) throw new Error('Il nome del corso è obbligatorio.');
        courses.push(c); log('corso_creato', c.name);
        return c.id;
      },
      async moveCourse(id, placement) {
        requireAdmin();
        Object.assign(courses.find(function (c) { return c.id === id; }), parsePlacement(placement));
        log('corso_modificato', 'spostato');
      },
      async updateCourse(id, data) {
        requireAdmin();
        Object.assign(courses.find(function (c) { return c.id === id; }), courseFields(data));
        log('corso_modificato', data.name);
      },
      async deleteCourse(id) {
        requireAdmin();
        var c = courses.find(function (x) { return x.id === id; });
        files = files.filter(function (f) { return f.course_id !== id; });
        courses = courses.filter(function (x) { return x.id !== id; });
        log('corso_eliminato', c && c.name);
      },
      async listFiles(opts) {
        opts = opts || {};
        await wait();
        var s = opts.q ? clean(opts.q, 100).toLowerCase() : '';
        return files.filter(function (f) {
          if (opts.courseId && f.course_id !== opts.courseId) return false;
          if (opts.kind && f.kind !== opts.kind) return false;
          if (opts.mine && (!me || f.uploaded_by !== me.id)) return false;
          if (opts.uploader && f.uploaded_by !== opts.uploader) return false;
          if (opts.authorName && (f.uploaded_by || f.author_name !== opts.authorName)) return false;
          if (s && ![f.title, f.description, f.original_name].some(function (v) { return (v || '').toLowerCase().indexOf(s) >= 0; })) return false;
          return true;
        }).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); }).slice(0, opts.limit || 300).map(withRefs);
      },
      async getFile(id) { var f = files.find(function (x) { return x.id === id; }); return f ? withRefs(f) : null; },
      async getProfile(id) {
        var u = users.find(function (x) { return x.id === id; });
        if (!u) return null;
        var n = files.filter(function (f) { return f.uploaded_by === id; }).length;
        return { id: u.id, name: u.name, role: u.role, points: n * 10, upload_count: n, created_at: u.created_at };
      },
      async uploadFile(courseId, file, meta, onProgress) {
        var t = typeFor(file.name);
        if (!t) throw new Error('Formato non ammesso: ' + file.name);
        if (file.size > CFG.maxUploadMb * 1024 * 1024) throw new Error('«' + file.name + '» supera il limite di ' + CFG.maxUploadMb + ' MB.');
        if (onProgress) onProgress(0.5);
        await wait();
        var id = addFile(courseId, file.name, file, clean(meta.title, 200), me.id, 0, clean(meta.description, 2000));
        if (meta.folder) files[files.length - 1].folder = clean(meta.folder, 120);
        log('file_caricato', file.name);
        return { id: id, evicted: [] };
      },
      async fileUrl(file) { return URL.createObjectURL(blobs[file.id]); },
      async setPinned(fileId, value) {
        requireAdmin();
        var f = files.find(function (x) { return x.id === fileId; });
        if (f) f.pinned = Boolean(value);
      },
      async evictionPreview() { return []; },
      async usage() {
        var sum = function (rec) { return files.filter(function (f) { return rec === (f.kind === 'audio' || f.kind === 'video'); }).reduce(function (a, f) { return a + f.size; }, 0); };
        return { used: sum(false), quota: 10200547328, where: 'anteprima', r2: { used: sum(true), quota: 10200547328 } };
      },
      async tourPending() {
        try { return !localStorage.getItem('tour-done-' + (me && me.id)); } catch (e) { return false; }
      },
      tourDone() { try { localStorage.setItem('tour-done-' + (me && me.id), '1'); } catch (e) { /* ignora */ } },
      async visit() { return iso(1500); },
      async newCounts(since) {
        var out = {};
        files.forEach(function (f) { if (f.created_at > since && f.uploaded_by !== (me && me.id)) out[f.course_id] = (out[f.course_id] || 0) + 1; });
        return out;
      },
      async listFavorites() { return favorites.slice(); },
      async setFavorite(courseId, on) {
        favorites = favorites.filter(function (x) { return x !== courseId; });
        if (on) favorites.push(courseId);
      },
      async toggleVote(fileId) {
        var f = files.find(function (x) { return x.id === fileId; });
        if (f.uploaded_by === me.id) throw new Error('Non puoi votare i tuoi file');
        var on = !votes[fileId];
        votes[fileId] = on;
        f.vote_count = Math.max(0, (f.vote_count || 0) + (on ? 1 : -1));
        return { voted: on, count: f.vote_count };
      },
      async myVotes(ids) { return ids.filter(function (id) { return votes[id]; }); },
      async setFolder(fileId, name) {
        var f = files.find(function (x) { return x.id === fileId; });
        if (f) f.folder = clean(name, 120) || null;
      },
      async adminStats() {
        var top = files.slice(0, 5).map(function (f) { var c = courses.find(function (x) { return x.id === f.course_id; }); return { id: f.id, title: f.title, open_count: 3, vote_count: f.vote_count || 0, course: c ? c.name : '' }; });
        return { active_7d: users.length, opens_7d: 12, uploads_7d: files.length, new_users_7d: 1, top_files: top,
          top_courses: courses.slice(0, 4).map(function (c, i) { return { id: c.id, name: c.name, year: c.year, opens: 9 - i * 2 }; }) };
      },
      async storageCheck() {
        return { origin: location.origin, results: [{ store: 'b2', ok: true, steps: [], message: 'Anteprima: nessun archivio reale da verificare.' }] };
      },
      async importStatus() {
        return { has_token: false, is_owner: true, imported: 0, imported_b2: 0, imported_r2: 0, processing: 0, authors: 0, authors_waiting: 0, errors: [], last: null };
      },
      async newServiceToken() {
        requireAdmin();
        return 'anteprima-' + uuid().replace(/-/g, '') + uuid().replace(/-/g, '').slice(0, 22);
      },
      async deleteFile(file) {
        requireAdmin();
        files = files.filter(function (f) { return f.id !== file.id; });
        log('file_eliminato', file.original_name);
      },
      async listUsers() {
        return users.map(function (u) {
          return Object.assign({}, u, { uploads: files.filter(function (f) { return f.uploaded_by === u.id; }).length });
        });
      },
      async recentCourses() { return null; }, // anteprima: memoria del dispositivo
      recordCourseVisit() {},
      async leaderboard() {
        var list = users.filter(function (u) { return !u.banned_at; }).map(function (u, i) {
          var n = files.filter(function (f) { return f.uploaded_by === u.id; }).length;
          return { user_id: u.id, name: u.name, role: u.role, upload_count: n, points: n * 10 + [140, 75, 30][i] };
        }).sort(function (a, b) { return b.points - a.points; });
        list.forEach(function (r, i) { r.rank_pos = i + 1; });
        return list;
      },
      async banUser(userId, reason) {
        requireAdmin();
        var u = users.find(function (x) { return x.id === userId; });
        if (u.role === 'admin') throw new Error('Prima revoca il ruolo di amministratore');
        u.banned_at = new Date().toISOString(); u.banned_reason = reason;
        log('utente_sospeso', u.email + ': ' + reason);
      },
      async unbanUser(userId) {
        requireAdmin();
        var u = users.find(function (x) { return x.id === userId; });
        u.banned_at = null; u.banned_reason = null;
        log('utente_riattivato', u.email);
      },
      async reportFile(fileId, reason) {
        if (reports.some(function (r) { return r.file_id === fileId && r.user_id === me.id; })) throw new Error('Hai già segnalato questo file.');
        reports.push({ id: ++seq, file_id: fileId, user_id: me.id, reason: reason, created_at: iso(0) });
      },
      async listReports() {
        return reports.map(function (r) {
          var f = files.find(function (x) { return x.id === r.file_id; });
          var up = f && users.find(function (x) { return x.id === f.uploaded_by; });
          return Object.assign({}, r, { file: f ? { id: f.id, title: f.title, uploaded_by: f.uploaded_by, uploader: up ? { name: up.name } : null } : null, reporter: { name: me.name } });
        }).filter(function (r) { return r.file; });
      },
      async dismissReports(fileId) { reports = reports.filter(function (r) { return r.file_id !== fileId; }); },
      async listRepresentatives() { return reps.slice().sort(function (a, b) { return a.sort_order - b.sort_order; }); },
      async listInfoLinks() { return links.slice(); },
      async saveRepresentative(r) {
        requireAdmin();
        if (r.id) Object.assign(reps.find(function (x) { return x.id === Number(r.id); }), r, { id: Number(r.id) });
        else reps.push(Object.assign({}, r, { id: ++seq, sort_order: Number(r.sort_order) || reps.length + 1 }));
      },
      async deleteRepresentative(id) { requireAdmin(); reps = reps.filter(function (x) { return x.id !== id; }); },
      async saveInfoLink(l) {
        requireAdmin();
        if (l.url && !/^https:\/\//.test(l.url)) throw new Error('Il link deve iniziare con https://');
        if (l.id) Object.assign(links.find(function (x) { return x.id === Number(l.id); }), l, { id: Number(l.id) });
        else links.push(Object.assign({}, l, { id: ++seq }));
      },
      async deleteInfoLink(id) { requireAdmin(); links = links.filter(function (x) { return x.id !== id; }); },
      async listProfessors() { return profs.slice().sort(function (a, b) { return a.last_name.localeCompare(b.last_name); }); },
      async saveProfessor(d) {
        requireAdmin();
        if (d.id) Object.assign(profs.find(function (x) { return x.id === Number(d.id); }), d, { id: Number(d.id) });
        else profs.push(Object.assign({}, d, { id: ++seq }));
      },
      async deleteProfessor(id) { requireAdmin(); profs = profs.filter(function (x) { return x.id !== id; }); },
      async listUserFiles(userId) { return files.filter(function (f) { return f.uploaded_by === userId; }); },
      async setRole(userId, role) {
        requireAdmin();
        var u = users.find(function (x) { return x.id === userId; });
        if (role === 'student' && u.role === 'admin' && users.filter(function (x) { return x.role === 'admin'; }).length <= 1) {
          throw new Error('Deve rimanere almeno un amministratore');
        }
        u.role = role;
        log(role === 'admin' ? 'ruolo_admin_assegnato' : 'ruolo_admin_revocato', u.email);
      },
      async listAudit() { return audit.slice(0, 40); },
    };
  }

  var configured = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  window.Api = configured ? SupabaseApi() : DemoApi();
  window.Api.typeFor = typeFor;
  window.Api.friendlyError = friendlyError;
  window.Api.normAA = normAA;
  window.Api.acceptAttr = Object.keys(TYPES).map(function (e) { return '.' + e; }).join(',');
})();
