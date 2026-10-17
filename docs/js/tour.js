/* Tour di benvenuto: al primo accesso di un account (e su richiesta da Amministrazione).
 * Un "riflettore" animato si sposta sulle parti del sito con un fumetto che le spiega.
 * Si salta in ogni momento (pulsante "Salta" o tasto Esc). */
(function () {
  'use strict';

  // Passi del tour: target = elementi da evidenziare (vuoto = finestra al centro)
  var STEPS = [
    {
      welcome: true,
      emoji: '👋',
      title: function (name) { return 'Benvenuto/a, ' + name + '!'; },
      text: 'Qui gli studenti di Chimica condividono appunti, dispense e registrazioni delle lezioni. Ti mostro il sito in 30 secondi.',
      next: 'Inizia il tour',
    },
    {
      target: ['.sidebar .nav a[href^="#/corsi"]'],
      sidebar: true,
      emoji: '📚',
      title: 'Corsi',
      text: 'Tutti gli insegnamenti, divisi per laurea, anno di corso e anno accademico. Apri un corso per vedere i materiali.',
    },
    {
      target: ['.top-search'],
      emoji: '🔎',
      title: 'Cerca',
      text: 'Scrivi un argomento o il nome di un file e trovi subito lezioni, dispense e registrazioni.',
    },
    {
      target: ['.sidebar .nav a[href="#/miei"]'],
      sidebar: true,
      emoji: '⬆️',
      title: 'Carica i tuoi appunti',
      text: 'Dentro ogni corso trovi il riquadro «Carica materiale». Qui ritrovi tutto quello che hai condiviso.',
    },
    {
      target: ['.sidebar .nav a[href="#/classifica"]'],
      sidebar: true,
      emoji: '🏆',
      title: 'Classifica',
      text: '+10 punti per ogni file, +5 quando un compagno apre un tuo file. Sali di lega, da Ferro a Sfidante!',
    },
    {
      target: ['.sidebar .nav a[href="#/rappresentanti"]', '.sidebar .nav a[href="#/professori"]'],
      sidebar: true,
      emoji: '🤝',
      title: 'Corso di studi',
      text: 'Contatti dei rappresentanti, link utili e informazioni sui professori.',
    },
    {
      final: true,
      emoji: '🎓',
      title: 'Tutto pronto!',
      text: 'Buono studio. Se ti va, contribuisci anche tu: ogni appunto condiviso aiuta qualcuno.',
      next: 'Inizia a esplorare',
    },
  ];

  var el = {};
  var state = null;
  var narrow = function () { return window.matchMedia('(max-width: 900px)').matches; };

  function build() {
    var root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML =
      '<div class="tour-shade"></div>' +
      '<div class="tour-spot" aria-hidden="true"><span class="tour-ring"></span></div>' +
      '<div class="tour-card" role="dialog" aria-modal="true" aria-live="polite">' +
        '<button class="tour-skip" type="button" data-tour="skip">Salta</button>' +
        '<div class="tour-emoji" aria-hidden="true"></div>' +
        '<h2 class="tour-title"></h2><p class="tour-text"></p>' +
        '<div class="tour-foot"><div class="tour-dots"></div>' +
          '<div class="tour-btns"><button class="btn btn-ghost btn-sm" type="button" data-tour="back">Indietro</button>' +
          '<button class="btn btn-primary btn-sm" type="button" data-tour="next">Avanti</button></div></div>' +
      '</div>' +
      '<div class="tour-confetti" aria-hidden="true"></div>';
    document.body.appendChild(root);
    el = {
      root: root, shade: root.querySelector('.tour-shade'), spot: root.querySelector('.tour-spot'),
      card: root.querySelector('.tour-card'), emoji: root.querySelector('.tour-emoji'),
      title: root.querySelector('.tour-title'), text: root.querySelector('.tour-text'),
      dots: root.querySelector('.tour-dots'), back: root.querySelector('[data-tour="back"]'),
      next: root.querySelector('[data-tour="next"]'), confetti: root.querySelector('.tour-confetti'),
    };
    el.dots.innerHTML = STEPS.map(function () { return '<span></span>'; }).join('');
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tour]');
      if (!b) return;
      var a = b.getAttribute('data-tour');
      if (a === 'skip') finish(false);
      else if (a === 'back') go(state.i - 1);
      else if (a === 'next') { if (state.i >= STEPS.length - 1) finish(true); else go(state.i + 1); }
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    requestAnimationFrame(function () { root.classList.add('on'); });
  }

  function onResize() { place(false); }

  function onKey(e) {
    if (!state) return;
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'ArrowRight') { if (state.i < STEPS.length - 1) go(state.i + 1); }
    else if (e.key === 'ArrowLeft') { if (state.i > 0) go(state.i - 1); }
  }

  // Rettangolo che contiene tutti gli elementi del passo (null se non visibili)
  function targetRect(step) {
    if (!step.target) return null;
    var rects = step.target.map(function (sel) { return document.querySelector(sel); })
      .filter(Boolean).map(function (n) { return n.getBoundingClientRect(); })
      .filter(function (r) { return r.width > 0 && r.height > 0; });
    if (!rects.length) return null;
    var top = Math.min.apply(null, rects.map(function (r) { return r.top; }));
    var left = Math.min.apply(null, rects.map(function (r) { return r.left; }));
    var bottom = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
    var right = Math.max.apply(null, rects.map(function (r) { return r.right; }));
    return { top: top, left: left, width: right - left, height: bottom - top, bottom: bottom, right: right };
  }

  function go(i) {
    if (i < 0 || i >= STEPS.length) return;
    var step = STEPS[i];
    var first = state.i === -1;
    state.i = i;
    // su telefono la barra laterale è nascosta: la apro per i passi che la riguardano
    if (narrow()) document.body.classList.toggle('sidebar-open', Boolean(step.sidebar));
    // 1) il fumetto svanisce dov'è; 2) cambio contenuto e posizione; 3) ricompare nel posto nuovo
    el.card.classList.remove('show');
    if (!step.target) el.spot.classList.remove('show');
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      // passaggio tra finestra centrale e fumetto: il fumetto è invisibile, lo sposto di colpo
      jump(el.card, function () {
        el.root.classList.toggle('centered', !step.target);
        el.root.classList.toggle('is-welcome', Boolean(step.welcome));
        if (!step.target) { el.card.style.top = el.card.style.left = ''; el.card.setAttribute('data-side', 'center'); }
      });
      el.emoji.textContent = step.emoji || '';
      el.title.textContent = typeof step.title === 'function' ? step.title(state.name) : step.title;
      el.text.textContent = step.text;
      el.next.textContent = step.next || 'Avanti';
      el.back.hidden = i === 0 || step.final;
      el.dots.querySelectorAll('span').forEach(function (d, k) { d.className = k === i ? 'on' : k < i ? 'done' : ''; });
      place(true);
      requestAnimationFrame(function () {
        el.card.classList.add('show');
        el.next.focus({ preventScroll: true });
      });
      if (step.final) burst();
    }, first ? 0 : (narrow() && step.sidebar ? 300 : 230));
  }

  // Sposta un elemento senza animazione (es. il riflettore che riappare: niente "volo" dall'angolo)
  function jump(node, apply) {
    node.classList.add('no-anim');
    apply();
    void node.offsetWidth;
    node.classList.remove('no-anim');
  }

  // Posiziona riflettore e fumetto accanto all'elemento evidenziato
  function place(entering) {
    if (!state || state.i < 0) return;
    var step = STEPS[state.i];
    var r = targetRect(step);
    var pad = 8;
    if (!r) {
      el.spot.classList.remove('show');
      el.card.style.top = el.card.style.left = '';
      el.card.setAttribute('data-side', 'center');
      return;
    }
    var geo = function () {
      el.spot.style.top = (r.top - pad) + 'px';
      el.spot.style.left = (r.left - pad) + 'px';
      el.spot.style.width = (r.width + pad * 2) + 'px';
      el.spot.style.height = (r.height + pad * 2) + 'px';
    };
    // se il riflettore era spento compare direttamente sull'elemento; se era acceso scivola fin lì
    if (!el.spot.classList.contains('show')) { jump(el.spot, geo); el.spot.classList.add('show'); } else geo();

    var cw = el.card.offsetWidth, ch = el.card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, gap = 18;
    var top, left, side;
    if (narrow()) { // su telefono il fumetto sta in basso (o in alto se l'elemento è in basso)
      left = (vw - cw) / 2;
      side = r.top > vh / 2 ? 'top' : 'bottom';
      top = side === 'top' ? 16 : vh - ch - 16;
    } else if (r.right + gap + cw < vw) { // a destra (voci della barra laterale)
      side = 'right';
      left = r.right + gap;
      top = Math.min(Math.max(16, r.top + r.height / 2 - ch / 2), vh - ch - 16);
    } else { // sotto (barra di ricerca)
      side = 'below';
      left = Math.min(Math.max(16, r.left), vw - cw - 16);
      top = Math.min(r.bottom + gap, vh - ch - 16);
    }
    var pos = function () {
      el.card.style.top = Math.round(top) + 'px';
      el.card.style.left = Math.round(left) + 'px';
      el.card.setAttribute('data-side', side);
    };
    if (entering) jump(el.card, pos); else pos();
  }

  function burst() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var colors = ['c1', 'c2', 'c3', 'c4', 'c5'];
    var html = '';
    for (var k = 0; k < 36; k++) html += '<i class="' + colors[k % 5] + ' p' + (k % 12) + '"></i>';
    el.confetti.innerHTML = html;
    el.confetti.querySelectorAll('i').forEach(function (n) {
      n.style.left = (5 + Math.random() * 90) + '%';
      n.style.animationDelay = (Math.random() * 0.35) + 's';
    });
  }

  function finish(completed) {
    if (!state) return;
    var done = state.onDone;
    state = null;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    if (narrow()) document.body.classList.remove('sidebar-open');
    el.root.classList.remove('on');
    setTimeout(function () { if (el.root) el.root.remove(); el = {}; }, 350);
    if (done) done(completed);
  }

  window.Tour = {
    start: function (opts) {
      if (state) return;
      opts = opts || {};
      state = { i: -1, name: String(opts.name || '').split(' ')[0] || 'studente', onDone: opts.onDone };
      build();
      go(0);
    },
    running: function () { return Boolean(state); },
  };
})();
