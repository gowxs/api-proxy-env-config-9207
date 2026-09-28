// Sections fade up as they scroll into view. Only what starts below the fold
// is hidden (the first screen and the LCP element are never touched), nothing
// is hidden without IntersectionObserver, and nothing moves with reduced motion.
(function () {
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var items = document.querySelectorAll('[data-reveal], main > section > .wrap > *');
  var fold = window.innerHeight;
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.remove('is-hidden');
        io.unobserve(e.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (var i = 0; i < items.length; i++) {
    var el = items[i];
    if (el.getBoundingClientRect().top < fold) continue;
    el.classList.add('reveal', 'is-hidden');
    io.observe(el);
  }
})();
// The header turns to glass once the page scrolls under it.
(function () {
  var header = document.querySelector('.site-header');
  if (!header) return;
  var on = false;
  function update() {
    var next = window.scrollY > 8;
    if (next !== on) header.classList.toggle('is-scrolled', (on = next));
  }
  update();
  window.addEventListener('scroll', update, { passive: true });
})();
