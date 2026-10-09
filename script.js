(() => {
  const header = document.querySelector('.site-header');
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  const mobileQuery = window.matchMedia('(max-width: 1020px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Footer year ----------
  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- Header border after scrolling ----------
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---------- Mobile navigation ----------
  const setNav = (open) => {
    nav.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Chiudi il menu' : 'Apri il menu');
  };

  navToggle.addEventListener('click', () => {
    setNav(!nav.classList.contains('open'));
  });

  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setNav(false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setNav(false);
  });

  // Close the mobile menu if the window grows to desktop width
  mobileQuery.addEventListener('change', (e) => {
    if (!e.matches) setNav(false);
  });

  // ---------- Highlight the section currently in view ----------
  const navLinks = [...nav.querySelectorAll('a[href^="#"]')];
  const linkFor = (id) => navLinks.find((a) => a.getAttribute('href') === `#${id}`);

  if ('IntersectionObserver' in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((a) => a.classList.remove('is-current'));
        const link = linkFor(entry.target.id);
        if (link) link.classList.add('is-current');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });

    navLinks
      .map((a) => document.getElementById(a.getAttribute('href').slice(1)))
      .filter(Boolean)
      .forEach((section) => sectionObserver.observe(section));
  }

  // ---------- Reveal on scroll ----------
  const revealEls = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window && !reduceMotion) {
    const revealObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -50px 0px' });

    revealEls.forEach((el) => revealObserver.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  }

  // ---------- Archive filter ----------
  const filters = document.querySelectorAll('.filter');
  const archiveCards = document.querySelectorAll('.archive-card');

  filters.forEach((button) => {
    button.addEventListener('click', () => {
      const category = button.dataset.filter;

      filters.forEach((b) => {
        const active = b === button;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });

      archiveCards.forEach((card) => {
        const show = category === 'all' || card.dataset.category === category;
        card.hidden = !show;
      });
    });
  });

  // ---------- Archive teaser: poem counts per collection ----------
  // The numbers in the HTML are a fallback; the real ones come from the archive index.
  const countEls = document.querySelectorAll('[data-collection-count]');
  if (countEls.length) {
    fetch('data/poesie/index.json')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.status))))
      .then((index) => {
        countEls.forEach((node) => {
          const total = index.poems.filter((p) => p.collection === node.dataset.collectionCount && p.contentAvailable !== false).length;
          if (total) node.textContent = total;
        });
      })
      .catch(() => {}); // keep the fallback numbers
  }

  // ---------- Decorative QR code ----------
  // Builds a 21×21 module grid with the three finder patterns and a seeded
  // pseudo-random body, so the example looks the same on every load.
  const qrContainer = document.getElementById('qr-code');

  if (qrContainer) {
    const size = 21;
    let seed = 20260101;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const inFinder = (r, c) =>
      (r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8);

    const isFinderModule = (r, c) => {
      const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
      return corners.some(([row, col]) => {
        const dr = r - row;
        const dc = c - col;
        if (dr < 0 || dc < 0 || dr > 6 || dc > 6) return false;
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        return ring || core;
      });
    };

    const fragment = document.createDocumentFragment();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = document.createElement('i');
        const on = inFinder(r, c) ? isFinderModule(r, c) : random() > 0.52;
        if (on) cell.classList.add('on');
        fragment.appendChild(cell);
      }
    }
    qrContainer.appendChild(fragment);
  }

  // ---------- Contact form (front-end validation only) ----------
  const form = document.getElementById('contact-form');
  const status = form.querySelector('.form-status');
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const isFieldValid = (field) => {
    if (field.type === 'checkbox') return field.checked;
    const value = field.value.trim();
    if (field.required && value === '') return false;
    if (field.type === 'email') return emailPattern.test(value);
    return true;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    let allValid = true;
    form.querySelectorAll('[required]').forEach((field) => {
      const ok = isFieldValid(field);
      field.classList.toggle('invalid', !ok);
      field.setAttribute('aria-invalid', String(!ok));
      if (!ok) allValid = false;
    });

    status.classList.remove('success');

    if (!allValid) {
      status.textContent = 'Controlla i campi evidenziati: servono tutti i dati richiesti e un’email valida.';
      return;
    }

    status.classList.add('success');
    status.textContent = 'Grazie! Il tuo messaggio è stato ricevuto. Ti risponderemo presto.';
    form.reset();
  });

  form.querySelectorAll('input, select, textarea').forEach((field) => {
    field.addEventListener('input', () => field.classList.remove('invalid'));
    field.addEventListener('change', () => field.classList.remove('invalid'));
  });
})();
