/* ============================================================
   tab-out-tree — Natural-language tab commands

   Opens with ":" (or "." as a one-handed alternative).
   Flow:
     1. User types a command like "close all shopping tabs".
     2. Enter -> ask Claude (via bridge) which tabs match.
     3. Preview: matching tabs light up, others dim, hint shows
        reason + "Enter to close, Esc to cancel".
     4. Enter again -> close the matching tabs.
   ============================================================ */

(function () {
  'use strict';

  const BRIDGE_BASE = 'http://127.0.0.1:8787';

  // Simple state machine: 'idle' -> 'typing' -> 'preview' -> 'idle'
  let state = 'idle';
  let pendingIds = [];
  let pendingReason = '';

  const bar    = document.getElementById('command-bar');
  const input  = document.getElementById('command-input');
  const hint   = document.getElementById('command-hint');

  function open() {
    if (!bar || !input) return;
    state = 'typing';
    bar.style.display = '';
    bar.classList.add('visible');
    hint.textContent = '';
    input.value = '';
    // Focus on next tick so any keydown that triggered us isn't typed in.
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  function close() {
    state = 'idle';
    pendingIds = [];
    pendingReason = '';
    input.value = '';
    hint.textContent = '';
    bar.classList.remove('visible');
    bar.style.display = 'none';
    input.blur();
    clearPreview();
    // Give focus back to the keyboard trap so hint nav keeps working.
    const trap = document.getElementById('focus-trap');
    if (trap) trap.focus({ preventScroll: true });
  }

  function setHint(text, kind) {
    hint.textContent = text;
    hint.dataset.kind = kind || '';
  }

  /* -------- Preview: highlight matching tabs, dim everything else -------- */
  function applyPreview(ids) {
    const set = new Set(ids);
    const chips = document.querySelectorAll(
      '.missions .page-chip[data-action="focus-tab"]'
    );
    chips.forEach(chip => {
      const url = chip.dataset.tabUrl;
      const tab = (typeof openTabs !== 'undefined' ? openTabs : []).find(t => t.url === url);
      const isMatch = tab && set.has(tab.id);
      chip.classList.toggle('cmd-match', isMatch);
      chip.classList.toggle('cmd-miss', !isMatch);
    });
  }
  function clearPreview() {
    document.querySelectorAll('.cmd-match, .cmd-miss').forEach(el => {
      el.classList.remove('cmd-match', 'cmd-miss');
    });
  }

  /* -------- Bridge call -------- */
  async function runCloseCommand(command) {
    const tabs = (typeof openTabs !== 'undefined' ? openTabs : [])
      .filter(t => t && t.id != null && t.url)
      .map(t => ({ id: t.id, title: t.title || '', url: t.url }));

    if (tabs.length === 0) {
      setHint('no tabs', 'warn');
      return null;
    }

    setHint('thinking…', 'loading');
    try {
      const res = await fetch(`${BRIDGE_BASE}/close-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs, command }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`${res.status} ${t.slice(0, 120)}`);
      }
      const data = await res.json();
      return data;
    } catch (e) {
      const msg = String(e).includes('Failed to fetch')
        ? 'bridge offline'
        : (e.message || String(e)).slice(0, 120);
      setHint(msg, 'error');
      return null;
    }
  }

  async function doClose(ids) {
    if (!ids || ids.length === 0) return;
    try {
      await chrome.tabs.remove(ids);
      if (typeof window.fetchOpenTabs === 'function') await window.fetchOpenTabs();
    } catch (e) {
      console.error('[command] tabs.remove failed', e);
    }
  }

  /* -------- Input event handling -------- */
  input && input.addEventListener('keydown', async (e) => {
    // Don't let these keys bubble to the global keydown handler.
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (state === 'typing') {
        const cmd = input.value.trim();
        if (!cmd) { close(); return; }
        const result = await runCloseCommand(cmd);
        if (!result) return;  // stays in typing; user can edit + retry

        const ids = result.close_ids || [];
        pendingIds = ids;
        pendingReason = result.reason || '';

        if (ids.length === 0) {
          setHint(`no match · ${pendingReason || 'nothing to close'} · Esc`, 'warn');
          return;
        }

        applyPreview(ids);
        state = 'preview';
        const costBit = result.meta
          ? ` · $${(result.meta.cost_usd || 0).toFixed(3)}`
          : '';
        setHint(
          `close ${ids.length} · ${pendingReason}${costBit} · Enter confirm / Esc cancel`,
          'confirm'
        );
        return;
      }

      if (state === 'preview') {
        await doClose(pendingIds);
        close();
        return;
      }
    }

    // While in preview state, any edit takes us back to typing (Claude rerun).
    if (state === 'preview' && e.key.length === 1) {
      state = 'typing';
      clearPreview();
      setHint('', '');
    }
  });

  /* -------- Expose openers -------- */
  window.openCommandBar = open;
  window.closeCommandBar = close;
})();
