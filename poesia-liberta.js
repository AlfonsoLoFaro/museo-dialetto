/* =========================================================
   «A mia figlia Libertà» – page behaviour

   - header / mobile menu / reveal-on-scroll (same behaviour as script.js)
   - narration audio, shared by the page button and the AR button
   - opening and closing the AR layer; all the 3D work lives in
     ar-liberta.js, which is only downloaded when AR is started.
   ========================================================= */

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================
   Header, menu, reveal
   ========================================================= */
(() => {
  const header = document.querySelector('.site-header');
  const navToggle = document.querySelector('.nav-toggle');
  const nav = $('site-nav');
  const mobileQuery = window.matchMedia('(max-width: 1020px)');

  $('year').textContent = new Date().getFullYear();

  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const setNav = (open) => {
    nav.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Chiudi il menu' : 'Apri il menu');
  };
  navToggle.addEventListener('click', () => setNav(!nav.classList.contains('open')));
  nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setNav(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });
  mobileQuery.addEventListener('change', (e) => { if (!e.matches) setNav(false); });

  const revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -50px 0px' });
    revealEls.forEach((el) => observer.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  }
})();

/* =========================================================
   Elements
   ========================================================= */
const audio = $('poem-audio');
const listenBtn = $('listen-btn');
const listenLabel = listenBtn.querySelector('.btn-label');
const audioStatus = $('audio-status');

const ar = $('ar');
const arBtn = $('ar-btn');
const arStage = $('ar-stage');
const arReticle = $('ar-reticle');
const arHint = $('ar-hint');
const arAudio = $('ar-audio');
const arAudioLabel = arAudio.querySelector('.ar-audio-label');
const arLoading = $('ar-loading');
const arLoadingText = $('ar-loading-text');
const arFallback = $('ar-fallback');
const arFallbackTitle = $('ar-fallback-title');
const arFallbackText = $('ar-fallback-text');
const arRetry = $('ar-retry');

/* =========================================================
   Audio narration
   One <audio> element, two buttons kept in sync.
   ========================================================= */
let hint = '';            // current AR hint (restored after a temporary message)
let hintTimer = 0;

const setHint = (text) => {
  hint = text;
  clearTimeout(hintTimer);
  arHint.textContent = text;
};

/** Show a message on the page and, if AR is open, briefly on the AR hint too. */
const notify = (text) => {
  audioStatus.textContent = text;
  if (!ar.hidden) {
    arHint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { arHint.textContent = hint; }, 4000);
  }
};

const renderAudio = () => {
  const playing = !audio.paused;
  const resuming = !playing && audio.currentTime > 0 && !audio.ended;

  listenBtn.setAttribute('aria-pressed', String(playing));
  listenLabel.textContent = playing ? 'Metti in pausa' : resuming ? 'Riprendi l’ascolto' : 'Ascolta la poesia';

  arAudio.setAttribute('aria-pressed', String(playing));
  arAudioLabel.textContent = playing ? 'Pausa' : resuming ? 'Riprendi' : 'Ascolta la poesia';
};

const toggleAudio = async () => {
  if (!audio.paused) {
    audio.pause();
    return;
  }
  try {
    await audio.play();
  } catch (err) {
    // AbortError = paused while it was still starting: not a problem.
    if (err && err.name !== 'AbortError') {
      notify('La registrazione audio non è ancora disponibile.');
    }
  }
};

['play', 'pause', 'ended'].forEach((type) => audio.addEventListener(type, renderAudio));
audio.addEventListener('play', () => { audioStatus.textContent = ''; });
audio.addEventListener('error', () => notify('La registrazione audio non è ancora disponibile.'));
listenBtn.addEventListener('click', toggleAudio);
arAudio.addEventListener('click', toggleAudio);
renderAudio();

/* =========================================================
   AR layer
   ========================================================= */
let arModule = null;      // ar-liberta.js, loaded on first use
let arOpen = false;
let arLive = false;       // camera running and scanning
let arRun = 0;           // bumped on every start / close so late results can be ignored

/** Friendly text for each error code thrown by ar-liberta.js. */
const AR_ERRORS = {
  denied: {
    title: 'Fotocamera non autorizzata',
    text: 'Per vivere l’esperienza in realtà aumentata serve la fotocamera. Consenti l’accesso per questo sito dal lucchetto accanto all’indirizzo (o dalle impostazioni del browser), poi tocca «Riprova». Puoi sempre leggere e ascoltare la poesia.',
  },
  'no-camera': {
    title: 'Nessuna fotocamera trovata',
    text: 'Questo dispositivo non sembra avere una fotocamera disponibile. Prova da uno smartphone o da un tablet: la poesia resta disponibile da leggere e ascoltare.',
  },
  'camera-error': {
    title: 'Fotocamera non disponibile',
    text: 'Non riusciamo ad aprire la fotocamera: potrebbe essere in uso da un’altra app. Chiudila e tocca «Riprova».',
  },
  insecure: {
    title: 'Connessione non sicura',
    text: 'La fotocamera funziona solo su pagine protette (indirizzo che inizia con https://). Apri il sito dall’indirizzo sicuro.',
  },
  unsupported: {
    title: 'Browser non compatibile',
    text: 'Questo browser non permette di usare la fotocamera. Prova con una versione recente di Safari, Chrome o Firefox.',
  },
  'target-missing': {
    title: 'Immagine di riferimento non trovata',
    text: 'I file dell’esperienza non sono ancora stati caricati. Riprova più tardi.',
  },
  network: {
    title: 'Connessione assente',
    text: 'Non riusciamo a raggiungere il server. Controlla la connessione e tocca «Riprova».',
  },
  load: {
    title: 'Impossibile caricare l’esperienza',
    text: 'Le librerie per la realtà aumentata non si sono caricate. Controlla la connessione, ricarica la pagina e riprova.',
  },
  fallback: {
    title: 'Qualcosa non ha funzionato',
    text: 'Non è stato possibile avviare la realtà aumentata su questo dispositivo. Tocca «Riprova» oppure torna alla poesia.',
  },
};

/** Elements outside the AR layer: made inert while it is open (no focus, no clicks, hidden from screen readers). */
const pageSections = () => [...document.body.children].filter((el) => el !== ar && el.tagName !== 'SCRIPT');

/* --- The three full-screen states: loading, live camera, fallback --- */
const showLoading = (text) => {
  arLive = false;
  arFallback.hidden = true;
  arLoading.classList.remove('is-done');
  arLoadingText.textContent = text;
};

const showLive = () => {
  arLive = true;
  arFallback.hidden = true;
  arLoading.classList.add('is-done');         // fades out the loading screen
  arReticle.classList.remove('is-hidden');
  setHint('Inquadra l’immagine di riferimento');
};

const showFallback = (code) => {
  arLive = false;
  const message = AR_ERRORS[code] || AR_ERRORS.fallback;
  arFallbackTitle.textContent = message.title;
  arFallbackText.textContent = message.text;
  arLoading.classList.add('is-done');
  arFallback.hidden = false;
  arRetry.focus();
};

/* --- Open / start --- */
const openAR = () => {
  if (arOpen) return;
  arOpen = true;

  audio.pause();                              // narration restarts from the AR button
  arAudio.hidden = true;                      // appears once the image is recognised
  setHint('');

  // One history entry, so the phone's Back button closes AR instead of leaving the page.
  history.pushState({ ar: true }, '', '#ar');

  ar.hidden = false;
  document.documentElement.classList.add('ar-open');
  pageSections().forEach((el) => { el.inert = true; });
  $('ar-close').focus();

  startSession();
};

const startSession = async () => {
  const run = ++arRun;
  showLoading('Sto preparando la fotocamera…');

  try {
    if (!arModule) {
      try {
        arModule = await import('./ar-liberta.js');   // downloads Three.js + MindAR
      } catch (err) {
        console.error('[AR] could not load the AR libraries', err);
        throw { code: 'load' };
      }
    }
    if (run !== arRun) return;

    await arModule.startAR({
      stage: arStage,
      targetSrc: ar.dataset.target,
      pictureSrc: ar.dataset.image,

      // Content of the floating panel: read from the page, so the text is edited in one place only.
      title: $('poem-title').textContent.trim(),
      author: 'Michele Pane',
      excerpt: readLines($('poem-excerpt')),
      footer: `${$('meta-place').textContent.trim()} · ${$('meta-date').textContent.trim()}`,

      onPhase: (phase) => {
        if (run !== arRun) return;
        if (phase === 'camera') showLoading('Consenti l’accesso alla fotocamera quando il browser lo chiede.');
        if (phase === 'loading') showLoading('Preparo il riconoscimento dell’immagine…');
        if (phase === 'scanning') showLive();
      },
      onFound: () => {                         // image recognised
        arReticle.classList.add('is-hidden');
        arAudio.hidden = false;
        setHint('');
      },
      onLost: () => {                          // image lost: the audio button stays
        arReticle.classList.remove('is-hidden');
        setHint('Immagine persa: inquadrala di nuovo');
      },
    });
  } catch (err) {
    if (run !== arRun) return;                 // closed in the meantime
    console.error('[AR]', err);
    showFallback(err && err.code);
  }
};

/* --- Close --- */
const teardownAR = () => {
  if (!arOpen) return;
  arOpen = false;
  arLive = false;
  resumeOnShow = false;
  arRun++;                                     // ignore anything still in flight

  if (arModule) arModule.stopAR();             // releases the camera
  audio.pause();

  ar.hidden = true;
  document.documentElement.classList.remove('ar-open');
  pageSections().forEach((el) => { el.inert = false; });
  arBtn.focus();
};

/** Close through the history so the "#ar" entry is removed too. */
const closeAR = () => {
  if (history.state && history.state.ar) history.back();   // → popstate → teardownAR
  else teardownAR();
};

window.addEventListener('popstate', () => { if (arOpen) teardownAR(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && arOpen) closeAR(); });

arBtn.addEventListener('click', openAR);
$('ar-close').addEventListener('click', closeAR);
$('ar-back').addEventListener('click', closeAR);
arRetry.addEventListener('click', startSession);

// Tab hidden or app switched while the camera is live: release the camera,
// and restart it when the visitor comes back. (Ignored during start-up, because
// some browsers fire this event around the permission dialog.)
let resumeOnShow = false;
document.addEventListener('visibilitychange', () => {
  if (!arOpen) return;
  if (document.hidden && arLive) {
    arLive = false;
    resumeOnShow = true;
    arModule.stopAR();
  } else if (!document.hidden && resumeOnShow) {
    resumeOnShow = false;
    startSession();
  }
});

/* =========================================================
   Helpers
   ========================================================= */

/** Text of an element split into lines at each <br>. */
function readLines(el) {
  const lines = [''];
  el.childNodes.forEach((node) => {
    if (node.nodeName === 'BR') lines.push('');
    else lines[lines.length - 1] += node.textContent;
  });
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
