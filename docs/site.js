/* Context Swarm Memory — progressive enhancement only.
   Everything on this page is fully readable with JavaScript disabled:
   numbers are pre-rendered, reveals only hide content under html.js,
   and all motion respects prefers-reduced-motion. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- sticky header state ---------- */
  var header = document.querySelector("[data-header]");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- mobile nav ---------- */
  var toggle = document.querySelector("[data-nav-toggle]");
  var nav = document.querySelector("[data-nav]");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      nav.classList.toggle("is-open", !open);
    });
    nav.addEventListener("click", function (event) {
      if (event.target instanceof HTMLAnchorElement) {
        toggle.setAttribute("aria-expanded", "false");
        nav.classList.remove("is-open");
      }
    });
  }

  /* ---------- count-up numbers ---------- */
  function animateCount(el) {
    if (el.dataset.counted) { return; }
    el.dataset.counted = "1";
    var target = parseFloat(el.getAttribute("data-count"));
    if (!isFinite(target)) { return; }
    var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var final = el.textContent; // pre-rendered truth; restored at the end
    var duration = 1400;
    var start = null;

    function frame(now) {
      if (start === null) { start = now; }
      var t = Math.min((now - start) / duration, 1);
      var eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      if (t < 1) {
        el.textContent = (target * eased).toFixed(decimals);
        requestAnimationFrame(frame);
      } else {
        el.textContent = final;
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- scroll reveals ---------- */
  var revealables = Array.prototype.slice.call(
    document.querySelectorAll("[data-reveal]")
  );

  function revealNow(el) {
    el.classList.add("in-view");
    if (!reduceMotion) {
      Array.prototype.forEach.call(
        el.querySelectorAll("[data-count]"),
        animateCount
      );
    }
  }

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealables.forEach(function (el) { el.classList.add("in-view"); });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          revealNow(entry.target);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -36px 0px" }
  );

  revealables.forEach(function (el) { observer.observe(el); });
})();
