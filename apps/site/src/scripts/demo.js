// Overnight inbox demo: 23:41 customer e-mail → 23:42 draft → 08:05 approved.
// The markup already shows the final state; this only animates towards it.
(function () {
  var demo = document.querySelector('.demo');
  if (!demo || !('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var clock = demo.querySelector('[data-clock]');
  var day = demo.querySelector('[data-day]');
  var toggle = demo.querySelector('[data-toggle]');
  var timers = [];
  var frame = 0;
  var running = false;
  var paused = false;
  var visible = false;

  var START = 23 * 60 + 41; // 23:41
  var DRAFT = START + 1; // 23:42
  var MORNING = 24 * 60 + 8 * 60 + 5; // 08:05 next day

  function fmt(min) {
    var m = ((Math.round(min) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function at(ms, fn) {
    timers.push(setTimeout(fn, ms));
  }
  function step(s) {
    demo.setAttribute('data-step', String(s));
  }
  function fastForward(ms) {
    var t0 = performance.now();
    function tick(now) {
      var p = Math.min(1, (now - t0) / ms);
      var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease in-out
      clock.textContent = fmt(DRAFT + (MORNING - DRAFT) * e);
      if (p > 0.45) day.textContent = 'Thursday morning';
      if (p < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }

  function run() {
    // Back to night instantly: no transition on the reset.
    demo.classList.add('is-resetting');
    step(0);
    void demo.offsetWidth;
    demo.classList.remove('is-resetting');
    clock.textContent = fmt(START);
    day.textContent = 'Wednesday night';
    at(500, function () {
      step(1);
    });
    at(1700, function () {
      step(2);
    });
    at(2100, function () {
      clock.textContent = fmt(DRAFT);
    });
    at(3100, function () {
      step(3);
    });
    at(4500, function () {
      step(5);
    });
    at(6000, function () {
      step(7);
      fastForward(2200);
    });
    at(8500, function () {
      step(8);
    });
    at(13000, function () {
      step(9);
    });
    at(13900, run);
  }
  function start() {
    if (running || paused || !visible || document.hidden) return;
    running = true;
    demo.classList.add('is-live');
    run();
  }
  function stop() {
    running = false;
    timers.forEach(clearTimeout);
    timers = [];
    cancelAnimationFrame(frame);
    demo.classList.remove('is-live');
    step('done');
    clock.textContent = fmt(MORNING);
    day.textContent = 'Thursday morning';
  }

  new IntersectionObserver(
    function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start();
      else stop();
    },
    { threshold: 0.35 },
  ).observe(demo);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  toggle.hidden = false;
  toggle.setAttribute('aria-label', 'Pause animation');
  toggle.addEventListener('click', function () {
    paused = !paused;
    toggle.textContent = paused ? 'Play' : 'Pause';
    toggle.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
    if (paused) stop();
    else start();
  });
})();
