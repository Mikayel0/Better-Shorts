/**
 * Better Shorts - YouTube Scroll Stabilizer Content Script
 *
 * Problem: When the browser window height changes, YouTube's CSS scroll-snap
 * AND YouTube's own JavaScript scroll handlers re-snap to a different video.
 *
 * Solution: We LOCK the scroll container during resize by:
 *   1. Capturing the active short element BEFORE the resize
 *   2. Disabling scroll-snap CSS
 *   3. Intercepting scroll events in the CAPTURE phase and calling
 *      stopImmediatePropagation() — this prevents YouTube's own JS
 *      from seeing or reacting to scroll changes
 *   4. Running a rAF loop that continuously forces the correct scrollTop
 *   5. After resize settles, doing a final correction and unlocking
 */

(function () {
  'use strict';

  // ── Safe chrome.* wrapper (avoids "Extension context invalidated") ──
  function safeStorage(method, ...args) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.id) {
        chrome.storage.local[method](...args);
      }
    } catch (e) {
      // Extension was reloaded — silently ignore
    }
  }

  function safeStorageOnChanged(cb) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.id) {
        chrome.storage.onChanged.addListener(cb);
      }
    } catch (e) { /* ignored */ }
  }

  // ── State ──────────────────────────────────────────────────────────
  let scrollContainer = null;
  let trackedShort = null;
  let trackedIndex = -1;           // Index among sibling renderers
  let resizeObserver = null;
  let mutationObserver = null;
  let isActive = false;
  let isLocked = false;
  let resizeSettleTimer = null;
  let rafHandle = null;
  let lastWindowHeight = window.innerHeight;
  let correctionsDuringLock = 0;
  let wasPlayingOnHide = false;
  let pausedVideoRef = null;       // Direct ref to the video we paused
  let cachedAutoPause = false;     // Cached so visibilitychange can act synchronously

  // ── Logging ────────────────────────────────────────────────────────
  const DEBUG = false; // set true to enable console logging
  function log(...args) {
    if (DEBUG) console.log('[BetterShorts]', ...args);
  }

  // ── Find the scroll container ──────────────────────────────────────
  function findScrollContainer() {
    const renderer = document.querySelector('ytd-reel-video-renderer');
    if (!renderer) return null;

    // Walk up from the renderer to find the scrollable/snapping ancestor
    let el = renderer.parentElement;
    while (el && el !== document.documentElement) {
      // Check if this element is actually scrollable
      if (el.scrollHeight > el.clientHeight + 10) {
        const s = getComputedStyle(el);
        const snapping = s.scrollSnapType && s.scrollSnapType !== 'none';
        const scrollable = s.overflowY === 'scroll' || s.overflowY === 'auto' || s.overflowY === 'overlay';
        if (snapping || scrollable) {
          log('Found scroll container via walk-up:', el.tagName, el.id, el.className);
          return el;
        }
      }
      el = el.parentElement;
    }

    // Fallback: any ancestor with scrollHeight > clientHeight
    el = renderer.parentElement;
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 50) {
        log('Found scroll container via fallback:', el.tagName, el.id, el.className);
        return el;
      }
      el = el.parentElement;
    }

    return null;
  }

  // ── Get the currently-active short ─────────────────────────────────
  function getActiveShort() {
    for (const el of document.querySelectorAll('ytd-reel-video-renderer[is-active]')) {
      if (el.offsetParent !== null) return el;
    }
    for (const el of document.querySelectorAll('ytd-reel-video-renderer[active]')) {
      if (el.offsetParent !== null) return el;
    }
    for (const el of document.querySelectorAll('ytd-reel-video-renderer')) {
      const v = el.querySelector('video');
      if (v && !v.paused && el.offsetParent !== null) return el;
    }
    return null;
  }

  // ── Get index of a short among its siblings ────────────────────────
  function getShortIndex(shortEl) {
    if (!shortEl || !scrollContainer) return -1;
    const all = scrollContainer.querySelectorAll('ytd-reel-video-renderer');
    for (let i = 0; i < all.length; i++) {
      if (all[i] === shortEl) return i;
    }
    return -1;
  }

  // ── Get short by index ─────────────────────────────────────────────
  function getShortByIndex(idx) {
    if (idx < 0 || !scrollContainer) return null;
    const all = scrollContainer.querySelectorAll('ytd-reel-video-renderer');
    return idx < all.length ? all[idx] : null;
  }

  // ── Calculate where scrollTop should be for a short element ────────
  // Uses getBoundingClientRect — reliable regardless of CSS positioning
  function getTargetScrollTop(shortEl) {
    if (!shortEl || !scrollContainer) return null;
    const containerRect = scrollContainer.getBoundingClientRect();
    const shortRect = shortEl.getBoundingClientRect();
    // Current visual offset of the short from the container top
    const visualOffset = shortRect.top - containerRect.top;
    // The scrollTop that would put this short at the container's top edge
    return scrollContainer.scrollTop + visualOffset;
  }

  // ── The scroll guard: intercepts ALL scroll events during lock ─────
  // Runs in CAPTURE phase and stops propagation so YouTube's handlers
  // never see the scroll event we caused by setting scrollTop
  function scrollGuardCapture(e) {
    if (!isLocked) return;
    e.stopImmediatePropagation();
  }

  // ── Force the scroll position to the tracked short ─────────────────
  function forcePosition() {
    if (!scrollContainer) return;

    // Resolve the target element
    let target = trackedShort;
    if (!target || !document.body.contains(target)) {
      // Element was recycled — recover by index
      target = getShortByIndex(trackedIndex);
      if (target) trackedShort = target;
    }
    if (!target) return;

    const desiredTop = getTargetScrollTop(target);
    if (desiredTop === null) return;

    if (Math.abs(scrollContainer.scrollTop - desiredTop) > 1) {
      scrollContainer.scrollTop = desiredTop;
      correctionsDuringLock++;
      log('Forced scrollTop →', desiredTop);
    }
  }

  // ── rAF correction loop ────────────────────────────────────────────
  function startCorrectionLoop() {
    if (rafHandle) return;
    function tick() {
      if (!isLocked) { rafHandle = null; return; }
      forcePosition();
      rafHandle = requestAnimationFrame(tick);
    }
    rafHandle = requestAnimationFrame(tick);
  }

  function stopCorrectionLoop() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  // ── LOCK ───────────────────────────────────────────────────────────
  function lock() {
    if (isLocked) return;
    if (!scrollContainer) return;

    // Capture who we're tracking BEFORE any layout shift
    const current = getActiveShort();
    if (current) {
      trackedShort = current;
      trackedIndex = getShortIndex(current);
    }
    if (!trackedShort) return;

    log('LOCK — tracked index:', trackedIndex, 'element:', trackedShort);

    isLocked = true;
    correctionsDuringLock = 0;

    // Disable scroll-snap
    scrollContainer.style.setProperty('scroll-snap-type', 'none', 'important');
    scrollContainer.style.setProperty('scroll-behavior', 'auto', 'important');

    // CRITICAL: Capture-phase listener that blocks YouTube's scroll handlers
    scrollContainer.addEventListener('scroll', scrollGuardCapture, true);

    // Start continuous correction loop
    startCorrectionLoop();

    // Immediate correction
    forcePosition();
  }

  // ── UNLOCK ─────────────────────────────────────────────────────────
  function unlock() {
    if (!isLocked) return;
    log('UNLOCK — made', correctionsDuringLock, 'corrections');

    // Final positioning before re-enabling snap
    forcePosition();

    isLocked = false;
    stopCorrectionLoop();

    if (scrollContainer) {
      scrollContainer.removeEventListener('scroll', scrollGuardCapture, true);
      scrollContainer.style.removeProperty('scroll-snap-type');
      scrollContainer.style.removeProperty('scroll-behavior');
    }

    // After snap re-enables, the browser might snap-correct; catch it
    setTimeout(() => {
      if (!isLocked && trackedShort && scrollContainer) {
        // Briefly re-lock to do one final correction after snap settles
        const containerRect = scrollContainer.getBoundingClientRect();
        const shortRect = trackedShort.getBoundingClientRect
          ? trackedShort.getBoundingClientRect()
          : null;
        if (shortRect) {
          const offset = shortRect.top - containerRect.top;
          if (Math.abs(offset) > 2) {
            scrollContainer.style.setProperty('scroll-snap-type', 'none', 'important');
            scrollContainer.scrollTop += offset;
            // Re-enable snap after a tick
            requestAnimationFrame(() => {
              scrollContainer.style.removeProperty('scroll-snap-type');
            });
          }
        }
      }
    }, 100);

  }

  // ── Resize handler ────────────────────────────────────────────────
  function onResize() {
    if (!isActive) return;

    const newHeight = window.innerHeight;
    const heightChanged = newHeight !== lastWindowHeight;
    lastWindowHeight = newHeight;

    if (!heightChanged && !isLocked) return;

    lock();

    // Reset settle timer
    if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
    resizeSettleTimer = setTimeout(() => { unlock(); }, 800);
  }

  // ── Track active short during normal usage ─────────────────────────
  function observeActiveChanges() {
    if (!scrollContainer) return;
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver(() => {
      if (isLocked) return;
      const a = getActiveShort();
      if (a) {
        trackedShort = a;
        trackedIndex = getShortIndex(a);
        log('Active short changed → index', trackedIndex);
      }
    });

    mutationObserver.observe(scrollContainer, {
      attributes: true,
      attributeFilter: ['is-active', 'active'],
      subtree: true,
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────
  function start() {
    if (isActive) return;

    function tryInit() {
      scrollContainer = findScrollContainer();
      if (!scrollContainer) {
        setTimeout(tryInit, 400);
        return;
      }

      isActive = true;
      trackedShort = getActiveShort();
      trackedIndex = trackedShort ? getShortIndex(trackedShort) : -1;
      lastWindowHeight = window.innerHeight;
      log('INIT — container:', scrollContainer,
          'tracked:', trackedShort, 'index:', trackedIndex);

      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(scrollContainer);

      window.addEventListener('resize', onResize);
      document.addEventListener('fullscreenchange', onResize);

      observeActiveChanges();
    }

    const existing = document.querySelector('ytd-reel-video-renderer');
    if (existing) {
      tryInit();
    } else {
      const mo = new MutationObserver((_, obs) => {
        if (document.querySelector('ytd-reel-video-renderer')) {
          obs.disconnect();
          tryInit();
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 15000);
    }
  }

  function stop() {
    if (!isActive) return;
    isActive = false;
    if (isLocked) unlock();

    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    if (resizeSettleTimer) { clearTimeout(resizeSettleTimer); resizeSettleTimer = null; }

    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onResize);

    scrollContainer = null;
    trackedShort = null;
    trackedIndex = -1;
  }

  // ── SPA navigation ────────────────────────────────────────────────
  function onNavigate() {
    if (window.location.pathname.startsWith('/shorts')) {
      safeStorage('get', ['enabled'], (r) => {
        if (r && r.enabled === false) { stop(); return; }
        start();
      });
    } else {
      stop();
    }
  }

  window.addEventListener('yt-navigate-finish', onNavigate);

  // ── Auto Pause / Resume on tab switch ──────────────────────────────
  // IMPORTANT: Must act synchronously — chrome.storage.get is async and
  // by the time the callback fires, Chrome has already paused the video
  // for background tabs, making video.paused unreliable.
  // We cache the autoPause setting and update it via storage listener.
  safeStorage('get', ['autoPause'], (r) => {
    cachedAutoPause = !!(r && r.autoPause);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isActive) onResize();

      // Synchronous — no async storage call
      if (cachedAutoPause && window.location.pathname.startsWith('/shorts')) {
        const activeShort = getActiveShort();
        const video = activeShort ? activeShort.querySelector('video') : null;
        if (video && !video.paused) {
          video.pause();
          pausedVideoRef = video;
          wasPlayingOnHide = true;
          log('Auto Pause — paused video on tab hide');
        } else {
          wasPlayingOnHide = false;
          pausedVideoRef = null;
        }
      }
    } else if (document.visibilityState === 'visible') {
      if (isActive) onResize();

      if (cachedAutoPause && wasPlayingOnHide && pausedVideoRef) {
        // Keep a local ref and reset state immediately
        const videoToResume = pausedVideoRef;
        wasPlayingOnHide = false;
        pausedVideoRef = null;

        // YouTube's own visibility handler will try to control the video.
        // We fire multiple delayed play() calls to ensure we win the race.
        const tryPlay = (delay) => {
          setTimeout(() => {
            if (videoToResume && document.body.contains(videoToResume) && videoToResume.paused) {
              videoToResume.play().catch(() => {});
            }
          }, delay);
        };
        tryPlay(50);
        tryPlay(200);
        tryPlay(500);
        log('Auto Resume — scheduled resume attempts');
      } else {
        wasPlayingOnHide = false;
        pausedVideoRef = null;
      }
    }
  });

  safeStorageOnChanged((changes) => {
    if (changes.enabled) {
      if (changes.enabled.newValue === false) stop();
      else if (window.location.pathname.startsWith('/shorts')) start();
    }
    if (changes.autoPause) {
      cachedAutoPause = !!changes.autoPause.newValue;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onNavigate);
  } else {
    onNavigate();
  }
})();
