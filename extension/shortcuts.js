/* ============================================================
   Tab Out — Keyboard navigation (StartTree-style)
   ============================================================
   - Home-row chord hints (f, j, d, k, s, l, a, ;) that scale to chords
     (fj, fk, …) when you have more tabs than single letters.
   - Type the chord -> jumps to that tab (activates it + focuses window).
   - Shift+<hint> (any letter of the chord) -> close that tab.
   - Prefixes:
       s<hint>   save-for-later that tab
       g<hint>   activate group (first tab in the card)
   - Other keys:
       / | f     focus archive / search field (native browser behavior)
       ?         toggle help overlay
       Esc       reset buffer / close help
       r         reload tab list
   ============================================================ */

(() => {
  // Letters used to build hints. `s` and `g` are reserved as mode prefixes
  // (save / group-jump) so they're excluded; `x` is too but isn't a hint
  // letter anyway.
  const HINT_KEYS = 'fjdkla;we'.split('');
  let hints = new Map();        // hint string -> { el, action, groupEl }
  let buffer = '';
  let mode = null;              // null | 'save' | 'group'
  let closeIntent = false;      // set when Shift was used on any hint letter
  let bufTimeout = null;

  const keybuf = document.getElementById('keybuf');
  const trap = document.getElementById('focus-trap');

  /* -------- Focus stealing (copied from StartTree) -------- */
  const focusTrap = () => trap && trap.focus({ preventScroll: true });
  focusTrap();
  document.addEventListener('DOMContentLoaded', focusTrap);
  window.addEventListener('load', () => {
    focusTrap();
    for (let ms = 0; ms <= 1000; ms += 10) setTimeout(focusTrap, ms);
  });
  const t0 = Date.now();
  (function rafFocus() {
    if (Date.now() - t0 < 1000) {
      focusTrap();
      requestAnimationFrame(rafFocus);
    }
  })();
  let firstWindowFocus = true;
  window.addEventListener('focus', () => {
    if (firstWindowFocus) {
      focusTrap();
      setTimeout(() => { firstWindowFocus = false; }, 1500);
    }
  });
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      setTimeout(() => chrome.runtime.sendMessage('steal-focus'), 100);
      setTimeout(() => chrome.runtime.sendMessage('steal-focus'), 300);
      setTimeout(() => chrome.runtime.sendMessage('steal-focus'), 600);
    }
  } catch {}

  /* -------- Hint generation --------

     Given `count` targets, produce `count` short unique strings using only
     HINT_KEYS characters. Singles first, then chords.                    */
  function generateHints(count) {
    if (count <= HINT_KEYS.length) return HINT_KEYS.slice(0, count);
    const out = [];
    // Use a subset as chord-prefix so the first N tabs still get single keys.
    const singles = HINT_KEYS.length;
    const primary = HINT_KEYS.slice(0, Math.ceil(count / singles));
    for (const a of primary) {
      for (const b of HINT_KEYS) {
        out.push(a + b);
        if (out.length >= count) return out;
      }
    }
    return out;
  }

  /* -------- Hint mounting --------

     Clears any existing `.hint` DOM nodes, then walks the current tab
     listing in visual order and assigns a hint to each `page-chip` (tab
     row) and each `mission-card` (group-level). Stored in the `hints` Map
     keyed by the hint string.                                            */
  let isRebuilding = false;
  function rebuildHints() {
    // Guard against the observer-fires-during-rebuild loop.
    isRebuilding = true;
    // Drop all previous hints from the DOM + reset classes.
    document.querySelectorAll('.hint').forEach(h => h.remove());
    document.querySelectorAll('.hint-active, .hint-dim').forEach(el => {
      el.classList.remove('hint-active', 'hint-dim');
    });
    hints.clear();

    // Individual tab rows inside missions and the deferred list.
    const tabEls = Array.from(document.querySelectorAll(
      '.missions .page-chip[data-action="focus-tab"], ' +
      '.deferred-list .deferred-item a.deferred-title'
    ));
    const tabHints = generateHints(tabEls.length);
    tabEls.forEach((el, i) => {
      const hint = tabHints[i];
      mountHint(el, hint, 'tab');
      hints.set(hint, { el, action: 'tab' });
    });

    // Group-level hints — first targetable chip inside each mission-card,
    // exposed under the `g` prefix so power users can jump to a whole group.
    const cards = Array.from(document.querySelectorAll('.mission-card'));
    const groupHints = generateHints(cards.length);
    cards.forEach((card, i) => {
      const firstChip = card.querySelector('.page-chip[data-action="focus-tab"]');
      if (!firstChip) return;
      const hint = groupHints[i];
      const nameEl = card.querySelector('.mission-name');
      if (nameEl) mountHint(nameEl, hint, 'group', /*prepend=*/true);
      hints.set('g' + hint, { el: firstChip, action: 'group', card });
    });

    // Release the guard on the next microtask so the flush mutations
    // triggered by our own inserts don't schedule another rebuild.
    queueMicrotask(() => { isRebuilding = false; });
  }

  function mountHint(el, key, kind, prepend = false) {
    const span = document.createElement('span');
    span.className = 'hint';
    span.dataset.hintFor = kind;
    span.textContent = key;
    if (prepend || kind === 'group') {
      el.insertBefore(span, el.firstChild);
    } else {
      el.insertBefore(span, el.firstChild);
    }
  }

  /* -------- Buffer + dim/active states -------- */
  function resetBuffer() {
    buffer = '';
    mode = null;
    closeIntent = false;
    clearTimeout(bufTimeout);
    keybuf.classList.remove('visible');
    keybuf.textContent = '';
    document.querySelectorAll('.hint').forEach(h => h.classList.remove('active', 'dim'));
    document.querySelectorAll('.hint-active, .hint-dim').forEach(el => {
      el.classList.remove('hint-active', 'hint-dim');
    });
  }

  function showKeybuf(html) {
    keybuf.innerHTML = html;
    keybuf.classList.add('visible');
  }

  function applyDimming(matchingHints) {
    const matchSet = new Set(matchingHints);
    document.querySelectorAll('.hint').forEach(h => {
      const key = (mode ? mode[0] : '') + h.textContent;
      // For non-mode nav, the hint's own key must match the buffer prefix.
      const hintKey = h.textContent;
      const isMatch = mode
        ? matchSet.has(mode[0] + hintKey)
        : matchSet.has(hintKey);
      h.classList.toggle('active', isMatch);
      h.classList.toggle('dim', !isMatch);

      // Mirror on the hosting row
      const row = h.closest('.page-chip') || h.closest('.mission-card') || h.closest('.deferred-item');
      if (row) {
        row.classList.toggle('hint-active', isMatch);
        row.classList.toggle('hint-dim', !isMatch);
      }
    });
  }

  /* -------- Hint dispatch --------

     Walks up from the anchor element (chip or link) to find the real target
     and triggers the right action — click for tab focus/save/close so that
     app.js's existing delegated handler does the work.                    */
  function trigger(hintObj, action) {
    const el = hintObj.el;
    if (!el) return;
    if (action === 'tab' || action === 'group') {
      // Synthesize a click so app.js's data-action="focus-tab" handler fires.
      el.click();
    } else if (action === 'close') {
      const closeBtn = el.querySelector('.chip-close, [data-action="close-single-tab"]');
      if (closeBtn) closeBtn.click();
    } else if (action === 'save') {
      const saveBtn = el.querySelector('.chip-save, [data-action="defer-single-tab"]');
      if (saveBtn) saveBtn.click();
    }
  }

  /* -------- Help overlay -------- */
  function toggleHelp() {
    const existing = document.getElementById('help-overlay');
    if (existing) {
      existing.classList.toggle('visible');
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'help-overlay';
    overlay.className = 'visible';
    overlay.innerHTML = `
      <div class="help-panel">
        <h3>keyboard shortcuts</h3>
        <dl>
          <dt>&lt;hint&gt;</dt><dd>jump to that tab</dd>
          <dt>Shift+&lt;hint&gt;</dt><dd>close tab</dd>
          <dt>g&lt;hint&gt;</dt><dd>jump to first tab in group</dd>
          <dt>s&lt;hint&gt;</dt><dd>save tab for later</dd>
          <dt>c</dt><dd>classify tabs with Claude</dd>
          <dt>/</dt><dd>focus archive search</dd>
          <dt>r</dt><dd>reload tab list</dd>
          <dt>?</dt><dd>toggle this help</dd>
          <dt>Esc</dt><dd>reset / close help</dd>
        </dl>
        <div class="help-hint">hints regenerate whenever tabs change — press any key to restart</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('visible');
    });
  }

  /* -------- Keydown handler -------- */
  document.addEventListener('keydown', (e) => {
    // Ignore if user is in a real input (archive search, etc.) — but the
    // focus-trap is an <input> too, so skip that one.
    const ae = document.activeElement;
    const inRealInput = ae
      && ae.id !== 'focus-trap'
      && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (inRealInput) {
      if (e.key === 'Escape') { ae.blur(); resetBuffer(); focusTrap(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
      const help = document.getElementById('help-overlay');
      if (help && help.classList.contains('visible')) {
        help.classList.remove('visible');
      } else {
        resetBuffer();
      }
      focusTrap();
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      toggleHelp();
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      const search = document.getElementById('archiveSearch');
      if (search) { search.focus(); return; }
    }

    if (e.key === 'r' && !buffer && !mode) {
      // Trigger the refresh — tab-out exposes this via a manual function
      e.preventDefault();
      if (typeof window.fetchOpenTabs === 'function') window.fetchOpenTabs();
      showKeybuf('<span class="prompt-arrow">~ λ</span> reload');
      clearTimeout(bufTimeout);
      bufTimeout = setTimeout(resetBuffer, 500);
      return;
    }

    if (e.key === 'c' && !buffer && !mode) {
      // Ask Claude (via the local bridge) to classify the current tabs.
      e.preventDefault();
      if (typeof window.classifyAndRender === 'function') {
        window.classifyAndRender();
      }
      return;
    }

    const key = e.key.toLowerCase();
    if (!/^[a-z;]$/.test(key)) return;
    e.preventDefault();

    const isHintLetter = HINT_KEYS.includes(key);

    // Mode prefix handling (only if buffer is empty): s = save, g = group.
    // Mode prefixes are non-hint letters so they never clash with a hint.
    if (!mode && buffer === '' && !isHintLetter) {
      if (key === 's') { mode = 'save';  showKeybuf(modeLabel()); return; }
      if (key === 'g') { mode = 'group'; showKeybuf(modeLabel()); return; }
    }

    // Shift on any hint letter during the chord = close intent.
    if (e.shiftKey && isHintLetter) closeIntent = true;

    buffer += key;

    // Resolve matches with the mode prefix attached.
    const effectiveKey = mode === 'group' ? 'g' + buffer : buffer;
    const exact = hints.get(effectiveKey);
    const possible = [...hints.keys()].filter(k => {
      if (mode === 'group') return k.startsWith('g' + buffer);
      return !k.startsWith('g') && k.startsWith(buffer);
    });
    const longer = possible.filter(k => k !== effectiveKey);

    // No match at all -> flash and reset
    if (possible.length === 0) {
      showKeybuf(`${modeLabel()} ${buffer}<span class="no-match">?</span>`);
      clearTimeout(bufTimeout);
      bufTimeout = setTimeout(resetBuffer, 500);
      return;
    }

    // Dim non-matching hints.
    applyDimming(possible.map(k => mode === 'group' ? k.slice(1) : k));

    // Resolve final action: close beats mode beats tab.
    const finalAction = () => closeIntent ? 'close' : (mode || 'tab');

    // Exact match with no longer alternatives -> trigger immediately.
    if (exact && longer.length === 0) {
      trigger(exact, finalAction());
      resetBuffer();
      return;
    }

    // Exact match but longer alternatives exist -> brief delay, then fire.
    if (exact) {
      showKeybuf(`${modeLabel()} ${buffer}_`);
      clearTimeout(bufTimeout);
      bufTimeout = setTimeout(() => {
        trigger(exact, finalAction());
        resetBuffer();
      }, 350);
      return;
    }

    showKeybuf(`${modeLabel()} ${buffer}_`);
    clearTimeout(bufTimeout);
    bufTimeout = setTimeout(resetBuffer, 1800);
  });

  function modeLabel() {
    const label = closeIntent ? 'close' : mode;
    const tag = label
      ? `<span class="mode-tag">${label}</span>`
      : '';
    return `${tag}<span class="prompt-arrow">~ λ</span> `;
  }

  /* -------- Rebuild whenever the tab DOM changes --------

     tab-out re-renders open tabs on chrome.tabs events, so we watch the
     .missions container (and the deferred list) for mutations and rebuild
     hints on the next frame.                                              */
  let rebuildPending = false;
  function scheduleRebuild() {
    if (rebuildPending || isRebuilding) return;
    rebuildPending = true;
    requestAnimationFrame(() => {
      rebuildPending = false;
      rebuildHints();
    });
  }

  const roots = ['openTabsMissions', 'deferredList'];
  const observer = new MutationObserver((muts) => {
    if (isRebuilding) return;
    // Ignore mutations that only add/remove .hint nodes (our own work).
    const realChange = muts.some(m => {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return nodes.some(n => !(n.nodeType === 1 && n.classList && n.classList.contains('hint')));
    });
    if (realChange) scheduleRebuild();
  });
  function attachObserver() {
    roots.forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { childList: true, subtree: true });
    });
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    attachObserver();
    scheduleRebuild();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      attachObserver();
      scheduleRebuild();
    });
  }

  // Re-focus trap when user clicks anywhere that isn't an input.
  document.addEventListener('click', (e) => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    resetBuffer();
    focusTrap();
  });
})();
