#!/usr/bin/env node
/* ============================================================
   tab-out-tree — Claude Code bridge

   A tiny localhost HTTP server that wraps `claude -p` so the
   extension can post a list of open tabs and get back semantic
   groupings. Uses the user's existing Claude Code auth (Max
   subscription if applicable) — no separate API key.

   Run:
       node bridge/claude-bridge.js
   ============================================================ */

'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT  = Number(process.env.TAB_OUT_TREE_PORT || 8787);
const MODEL = process.env.TAB_OUT_TREE_MODEL || 'haiku';
const ALLOW_ORIGIN = process.env.TAB_OUT_TREE_ORIGIN || '*';

const CLASSIFY_PROMPT = [
  'You classify browser tabs into semantic workspace groups.',
  '',
  'Respond with STRICT JSON only. No markdown code fences, no preamble, no trailing prose.',
  'Schema: {"groups":[{"name":"<1-3 word label>","tab_ids":[<int>,...]}]}',
  '',
  'Rules:',
  '- Produce 3 to 6 groups total.',
  '- Every tab id appears in exactly one group.',
  '- Group names describe what the user is doing (e.g. "faculty search", "longevity research", "shopping", "paper reading"), not the domain.',
  '- If a tab does not fit anywhere, put it in a group named "misc".',
  '- Prefer fewer, cleaner groups over many tiny ones.',
  ''
].join('\n');

const CLOSE_COMMAND_PROMPT = [
  'You help a user manage their browser tabs.',
  '',
  'The user will give you a natural-language command describing which tabs to close.',
  'You return the numeric ids of tabs that match their intent.',
  '',
  'Respond with STRICT JSON only. No markdown fences, no preamble:',
  '{"close_ids":[<int>,...],"reason":"<one short sentence, lowercase>"}',
  '',
  'Rules:',
  '- Only include tab ids that clearly match the command.',
  '- If the command is vague or matches nothing, return {"close_ids":[],"reason":"..."} explaining why.',
  '- The "reason" is what you would tell the user to justify the selection, one sentence.',
  '- Do not invent ids — only pick from the provided list.',
  ''
].join('\n');

function runClaude(fullPrompt) {
  return new Promise((resolve, reject) => {
    // Run from a neutral cwd so project CLAUDE.md files aren't loaded.
    const proc = spawn('claude', [
      '-p', fullPrompt,
      '--model', MODEL,
      '--output-format', 'json',
    ], {
      cwd: '/tmp',
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        const wrapper = JSON.parse(stdout);
        // claude -p --output-format json puts the model's text in `result`.
        const raw = (wrapper.result || '').trim();
        // Strip a possible ```json ... ``` fence defensively.
        const stripped = raw
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();
        const parsed = JSON.parse(stripped);
        parsed.meta = {
          cost_usd: wrapper.total_cost_usd,
          duration_ms: wrapper.duration_ms,
          cache_read: wrapper.usage && wrapper.usage.cache_read_input_tokens,
          cache_create: wrapper.usage && wrapper.usage.cache_creation_input_tokens,
          model: MODEL,
        };
        resolve(parsed);
      } catch (e) {
        reject(new Error(`parse error: ${e.message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, model: MODEL, port: PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/classify') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { tabs } = JSON.parse(body || '{}');
        if (!Array.isArray(tabs) || tabs.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'tabs[] required' }));
          return;
        }
        // Only send id, title, url — nothing else Claude needs.
        const clean = tabs.map(t => ({
          id: t.id,
          title: (t.title || '').slice(0, 180),
          url: (t.url || '').slice(0, 300),
        }));
        const t0 = Date.now();
        const prompt = `${CLASSIFY_PROMPT}\n\nTabs:\n${JSON.stringify(clean)}`;
        const result = await runClaude(prompt);
        const groups = result.groups || [];
        const elapsed = Date.now() - t0;
        console.log(`[classify] ${tabs.length} tabs -> ${groups.length} groups in ${elapsed}ms (cost $${(result.meta.cost_usd || 0).toFixed(4)})`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ groups, meta: result.meta }));
      } catch (e) {
        console.error('[classify] error:', e.message);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/close-command') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { tabs, command } = JSON.parse(body || '{}');
        if (!Array.isArray(tabs) || tabs.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'tabs[] required' }));
          return;
        }
        if (typeof command !== 'string' || !command.trim()) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'command required' }));
          return;
        }
        const clean = tabs.map(t => ({
          id: t.id,
          title: (t.title || '').slice(0, 180),
          url: (t.url || '').slice(0, 300),
        }));
        const t0 = Date.now();
        const prompt = [
          CLOSE_COMMAND_PROMPT,
          '',
          'Tabs:',
          JSON.stringify(clean),
          '',
          'Command:',
          command.trim(),
        ].join('\n');
        const raw = await runClaude(prompt);
        // Validate ids are actually present in the provided list — Claude
        // shouldn't invent ids, but hard-filter in case of hallucinated output.
        const validIds = new Set(clean.map(t => t.id));
        const filtered = (raw.close_ids || []).filter(id => validIds.has(id));
        const elapsed = Date.now() - t0;
        console.log(`[close-command] "${command.slice(0,60)}" -> ${filtered.length}/${tabs.length} in ${elapsed}ms (cost $${(raw.meta.cost_usd || 0).toFixed(4)})`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          close_ids: filtered,
          reason: raw.reason || '',
          meta: raw.meta,
        }));
      } catch (e) {
        console.error('[close-command] error:', e.message);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tab-out-tree claude bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`  model: ${MODEL}   (override with TAB_OUT_TREE_MODEL)`);
  console.log(`  POST /classify  {tabs: [{id,title,url}, ...]}`);
  console.log(`  GET  /health`);
});
