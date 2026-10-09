/* =========================================================
   Shared page shell for the archive pages (poesie.html, poesia.html)

   Same behaviour as the header part of script.js: footer year,
   header border on scroll, mobile menu, reveal-on-scroll.
   (script.js itself belongs to the home page: it also drives
   the contact form and the QR example, which do not exist here.)
   ========================================================= */
(() => {
  const header = document.querySelector('.site-header');
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  const mobileQuery = window.matchMedia('(max-width: 1020px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

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

  // Reveal on scroll. Content added later by the page scripts calls window.revealNew().
  let observer = null;
  if ('IntersectionObserver' in window && !reduceMotion) {
    observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -50px 0px' });
  }

  window.revealNew = (root = document) => {
    root.querySelectorAll('.reveal:not(.is-visible)').forEach((el) => {
      if (observer) observer.observe(el);
      else el.classList.add('is-visible');
    });
  };
  window.revealNew();
})();
