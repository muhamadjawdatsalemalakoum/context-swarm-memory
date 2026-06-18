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

  /* ---------- image lightbox (charts / graphs) ---------- */
  (function setupLightbox() {
    var triggers = Array.prototype.slice.call(
      document.querySelectorAll("figure img")
    );
    if (!triggers.length) { return; }

    var overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.setAttribute("aria-hidden", "true");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Enlarged figure");
    overlay.innerHTML =
      '<button class="lightbox-close" type="button" aria-label="Close (Esc)">×</button>' +
      '<img class="lightbox-img" alt="">' +
      '<p class="lightbox-hint">Click anywhere or press Esc to close</p>';
    document.body.appendChild(overlay);

    var lbImg = overlay.querySelector(".lightbox-img");
    var closeBtn = overlay.querySelector(".lightbox-close");
    var lastTrigger = null;
    var isOpen = false;
    var resetTimer = null;

    function flipFrom(rect) {
      var last = lbImg.getBoundingClientRect();
      if (!last.width || !rect.width) { return null; }
      return (
        "translate(" +
        (rect.left + rect.width / 2 - (last.left + last.width / 2)) + "px," +
        (rect.top + rect.height / 2 - (last.top + last.height / 2)) + "px) " +
        "scale(" + rect.width / last.width + ")"
      );
    }

    function open(img) {
      if (isOpen) { return; }
      lastTrigger = img;
      isOpen = true;
      lbImg.src = img.currentSrc || img.src;
      lbImg.alt = img.alt || "";
      overlay.classList.add("is-open");
      overlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("lightbox-lock");

      if (!reduceMotion) {
        var first = img.getBoundingClientRect();
        requestAnimationFrame(function () {
          var t = flipFrom(first);
          if (!t) { return; }
          lbImg.style.transition = "none";
          lbImg.style.transform = t;
          lbImg.getBoundingClientRect(); // force reflow
          lbImg.style.transition = "";
          requestAnimationFrame(function () { lbImg.style.transform = ""; });
        });
      }
      closeBtn.focus();
    }

    function finishClose() {
      if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
      lbImg.removeEventListener("transitionend", finishClose);
      overlay.setAttribute("aria-hidden", "true");
      document.body.classList.remove("lightbox-lock");
      lbImg.style.transition = "";
      lbImg.style.transform = "";
      lbImg.removeAttribute("src");
      var returnTo = lastTrigger;
      lastTrigger = null;
      isOpen = false;
      if (returnTo && typeof returnTo.focus === "function") { returnTo.focus(); }
    }

    function close() {
      if (!isOpen) { return; }
      if (reduceMotion || !lastTrigger) {
        overlay.classList.remove("is-open");
        finishClose();
        return;
      }
      var t = flipFrom(lastTrigger.getBoundingClientRect());
      overlay.classList.remove("is-open"); // fade the backdrop + image out
      if (t) { lbImg.style.transform = t; }
      lbImg.addEventListener("transitionend", finishClose);
      resetTimer = setTimeout(finishClose, 440); // fallback if transitionend misses
    }

    triggers.forEach(function (img) {
      img.setAttribute("tabindex", "0");
      img.setAttribute("role", "button");
      img.addEventListener("click", function () { open(img); });
      img.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(img); }
      });
    });
    overlay.addEventListener("click", function (e) {
      if (e.target !== lbImg) { close(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) { close(); }
    });
  })();

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
