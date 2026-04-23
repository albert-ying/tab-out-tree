/* ============================================================
   tab-out-tree — Claude-powered tab classification

   Talks to the local claude-bridge daemon (bridge/claude-bridge.js)
   and renders a second "> classified" row of cross-domain mission
   cards above the normal domain grouping. Triggered by pressing `c`
   on the new tab page.
   ============================================================ */

(function () {
  'use strict';

  const BRIDGE_BASE = 'http://127.0.0.1:8787';
  let inFlight = false;

  async function classifyAndRender() {
    if (inFlight) return;
    if (!Array.isArray(openTabs) || openTabs.length === 0) {
      showStatus('no tabs to classify', 'warn');
      return;
    }

    inFlight = true;
    setLoading(true);

    try {
      const payload = openTabs
        .filter(t => t && t.id != null && t.url)
        .map(t => ({ id: t.id, title: t.title || '', url: t.url }));

      const res = await fetch(`${BRIDGE_BASE}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs: payload }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`bridge ${res.status}: ${text.slice(0, 200)}`);
      }
      const { groups, meta } = await res.json();
      renderClassifiedSection(groups, meta);
    } catch (e) {
      console.error('[classify]', e);
      const friendly = String(e).includes('Failed to fetch')
        ? 'bridge offline — run: node bridge/claude-bridge.js'
        : String(e.message || e);
      showStatus(friendly, 'error');
    } finally {
      inFlight = false;
      setLoading(false);
    }
  }

  /* -------- Render --------

     We render into #classifiedSection, which is a fresh section above
     the normal #openTabsSection. Each mission card contains clickable
     chips that reuse the same data-action="focus-tab" contract as the
     domain cards, so app.js's existing click handler + shortcuts.js's
     hint generator both pick them up automatically.                  */
  function renderClassifiedSection(groups, meta) {
    const section = ensureSection();
    const container = section.querySelector('.missions');
    container.innerHTML = '';

    const byId = new Map((openTabs || []).map(t => [t.id, t]));
    let tabCount = 0;

    for (const g of groups) {
      const tabs = (g.tab_ids || [])
        .map(id => byId.get(id))
        .filter(Boolean);
      if (tabs.length === 0) continue;
      tabCount += tabs.length;
      container.appendChild(renderMissionCard(g.name || 'misc', tabs));
    }

    section.querySelector('.section-count').textContent =
      `${groups.length} group${groups.length !== 1 ? 's' : ''} · ${tabCount} tab${tabCount !== 1 ? 's' : ''}`;

    section.style.display = '';
    const sub = meta
      ? `${(meta.duration_ms / 1000).toFixed(1)}s · $${(meta.cost_usd || 0).toFixed(3)}`
      : '';
    showStatus(`classified · ${sub}`, 'ok');
  }

  function renderMissionCard(name, tabs) {
    const card = document.createElement('div');
    card.className = 'mission-card semantic-mission';

    const top = document.createElement('div');
    top.className = 'mission-top';
    const nameEl = document.createElement('div');
    nameEl.className = 'mission-name';
    nameEl.textContent = name;
    top.appendChild(nameEl);

    const badge = document.createElement('span');
    badge.className = 'open-tabs-badge';
    badge.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;
    top.appendChild(badge);

    // Close-whole-section button (X).
    const closeAll = document.createElement('button');
    closeAll.className = 'mission-close-all';
    closeAll.title = `close all ${tabs.length} tabs in "${name}"`;
    closeAll.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>';
    closeAll.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ids = tabs.map(t => t.id).filter(id => id != null);
      if (ids.length === 0) return;
      try {
        await chrome.tabs.remove(ids);
        if (typeof window.fetchOpenTabs === 'function') await window.fetchOpenTabs();
        // Remove the card from the classified row.
        card.remove();
        // If that was the last card, hide the section.
        const section = document.getElementById('classifiedSection');
        if (section && !section.querySelector('.mission-card')) {
          section.style.display = 'none';
        }
        showStatus(`closed ${ids.length} in "${name}"`, 'ok');
      } catch (err) {
        console.error('[classify] close-all failed', err);
        showStatus('close failed', 'error');
      }
    });
    top.appendChild(closeAll);

    const pages = document.createElement('div');
    pages.className = 'mission-pages';
    for (const t of tabs) {
      pages.appendChild(renderChip(t));
    }

    card.appendChild(top);
    card.appendChild(pages);
    return card;
  }

  function renderChip(tab) {
    const safeTitle = escapeAttr(tab.title || tab.url);
    const safeUrl   = escapeAttr(tab.url);
    const favicon   = faviconUrl(tab.url);

    const chip = document.createElement('div');
    chip.className = 'page-chip clickable';
    chip.dataset.action  = 'focus-tab';
    chip.dataset.tabUrl  = tab.url;
    chip.title = safeTitle;

    chip.innerHTML = `
      <img class="chip-favicon" src="${favicon}" alt="">
      <span class="chip-text">${escapeHtml(tab.title || tab.url)}</span>
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>`;
    const img = chip.querySelector('img.chip-favicon');
    if (img) img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    return chip;
  }

  function faviconUrl(url) {
    try {
      const host = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
    } catch {
      return '';
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* -------- Section scaffolding -------- */
  function ensureSection() {
    let section = document.getElementById('classifiedSection');
    if (section) return section;

    section = document.createElement('div');
    section.id = 'classifiedSection';
    section.className = 'active-section classified-section';
    section.style.display = 'none';
    section.innerHTML = `
      <div class="section-header">
        <h2>classified</h2>
        <div class="section-line"></div>
        <div class="section-count"></div>
        <button class="classified-close" title="clear classification">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="missions" id="classifiedMissions"></div>`;

    // Insert above the normal #openTabsSection inside its parent column.
    const openSection = document.getElementById('openTabsSection');
    if (openSection && openSection.parentNode) {
      openSection.parentNode.insertBefore(section, openSection);
    } else {
      (document.getElementById('dashboardColumns') || document.body).prepend(section);
    }

    section.querySelector('.classified-close').addEventListener('click', () => {
      section.style.display = 'none';
      section.querySelector('.missions').innerHTML = '';
      showStatus('classification cleared', 'ok');
    });

    return section;
  }

  /* -------- Status + loading -------- */
  function setLoading(on) {
    const section = ensureSection();
    section.classList.toggle('is-loading', !!on);
    if (on) {
      section.style.display = '';
      section.querySelector('.section-count').textContent = 'classifying…';
    }
  }

  function showStatus(msg, kind) {
    const keybuf = document.getElementById('keybuf');
    if (!keybuf) return;
    const colorClass = kind === 'error' ? 'no-match' : '';
    keybuf.innerHTML = `<span class="prompt-arrow">~ λ</span> <span class="${colorClass}">${escapeHtml(msg)}</span>`;
    keybuf.classList.add('visible');
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      keybuf.classList.remove('visible');
      keybuf.textContent = '';
    }, kind === 'error' ? 3500 : 1600);
  }

  /* -------- Expose -------- */
  window.classifyAndRender = classifyAndRender;
})();
