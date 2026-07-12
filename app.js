/* ============================================================
   VitalSage landing — analyze any URL from a static page.

   GitHub Pages cannot run the Playwright engine, so the demo
   fetches real lab data from the Google PageSpeed API (CORS-
   enabled, no key required at low volume), then applies
   VitalSage's rule-based thresholds and renders the result in
   the same format as agent/analysis/src/report-generator.ts.

   One report is produced per selected network profile: the
   profile matching the lab run is real; the others are derived
   estimates and labeled as such.
   ============================================================ */

(() => {
  'use strict';

  const GITHUB = 'https://github.com/marinaageeva14/vitalsage';
  const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

  // Site-wide PageSpeed API key. Never committed to the repo: the deploy
  // workflow (.github/workflows/deploy-pages.yml) generates config.js from
  // the PSI_API_KEY repository secret at deploy time. The key must be
  // referrer-restricted to this site's domain in Google Cloud Console —
  // any key shipped to a browser is visible to visitors; the restriction
  // is what makes it useless anywhere else.
  // Visitors can still override with their own key via localStorage.
  const DEFAULT_PSI_KEY = window.VITALSAGE_CONFIG?.psiKey || '';

  /* ---------- profiles (mirror sdk/simulator profiles) ---------- */

  const NETWORK_ORDER = ['wifi', '4g', '3g', '2g', 'slow-2g'];
  const NETWORK_LABELS = { wifi: 'WiFi', '4g': '4G', '3g': '3G', '2g': '2G', 'slow-2g': 'Slow 2G' };

  // Loading-time multipliers relative to the lab baseline. The PSI
  // desktop run is lightly throttled (~wifi); the mobile run emulates
  // slow 4G on a mid-tier device (~4g).
  const FACTORS = {
    desktop: { wifi: 1, '4g': 1.9, '3g': 3.4, '2g': 6.5, 'slow-2g': 10 },
    mobile:  { wifi: 0.6, '4g': 1, '3g': 1.9, '2g': 3.8, 'slow-2g': 6 },
  };

  const DEVICE_LABELS = {
    desktop: 'Desktop · 1280×800',
    tablet:  'Tablet · 768×1024 (mobile emulation)',
    mobile:  'Mobile · 375×812',
  };

  /* ---------- CrUX thresholds (README: Metric rating thresholds) ---------- */

  const THRESHOLDS = {
    LCP:  [2500, 4000],
    FCP:  [1800, 3000],
    TTFB: [800, 1800],
    CLS:  [0.1, 0.25],
    INP:  [200, 500],
    TBT:  [300, 600],
  };

  const RATING_COLOR = { good: '#22c55e', 'needs-improvement': '#f59e0b', poor: '#ef4444' };
  const SEVERITY_COLOR = { critical: '#ef4444', warning: '#f59e0b', info: '#6b7280' };

  function rate(metric, value) {
    const [good, poor] = THRESHOLDS[metric];
    if (value <= good) return 'good';
    if (value <= poor) return 'needs-improvement';
    return 'poor';
  }

  /* ---------- PSI audit → VitalSage agent mapping ---------- */

  const AUDIT_MAP = {
    'prioritize-lcp-image':      { agent: 'lcp',           effort: 'low' },
    'lcp-lazy-loaded':           { agent: 'lcp',           effort: 'low' },
    'largest-contentful-paint-element': { agent: 'lcp',    effort: 'medium', minScore: 0.5 },
    'render-blocking-resources': { agent: 'render-block',  effort: 'medium' },
    'unused-css-rules':          { agent: 'render-block',  effort: 'medium' },
    'unused-javascript':         { agent: 'trace',         effort: 'high' },
    'bootup-time':               { agent: 'trace',         effort: 'high' },
    'mainthread-work-breakdown': { agent: 'trace',         effort: 'high' },
    'third-party-summary':       { agent: 'inp',           effort: 'medium' },
    'server-response-time':      { agent: 'ttfb',          effort: 'high' },
    'redirects':                 { agent: 'ttfb',          effort: 'low' },
    'uses-text-compression':     { agent: 'ttfb',          effort: 'low' },
    'modern-image-formats':      { agent: 'image',         effort: 'medium' },
    'uses-optimized-images':     { agent: 'image',         effort: 'low' },
    'uses-responsive-images':    { agent: 'image',         effort: 'medium' },
    'offscreen-images':          { agent: 'image',         effort: 'low' },
    'unsized-images':            { agent: 'cls',           effort: 'low' },
    'layout-shifts':             { agent: 'cls',           effort: 'medium' },
    'non-composited-animations': { agent: 'cls',           effort: 'medium' },
    'font-display':              { agent: 'font',          effort: 'low' },
    'uses-rel-preconnect':       { agent: 'resource-hint', effort: 'low' },
    'uses-rel-preload':          { agent: 'resource-hint', effort: 'low' },
  };

  /* ---------- tiny helpers ---------- */

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // PSI descriptions are markdown: keep text, remember the first link.
  function fromMarkdown(md) {
    let firstLink = null;
    const text = String(md ?? '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      if (!firstLink) firstLink = url;
      return label;
    });
    return { text, firstLink };
  }

  function fmtMs(v) { return `${Math.round(v).toLocaleString()}ms`; }

  /* ---------- config state ---------- */

  let device = 'desktop';
  const networks = new Set(NETWORK_ORDER);

  const deviceSeg = $('#device-seg');
  deviceSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    device = btn.dataset.device;
    deviceSeg.querySelectorAll('.seg-btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
  });

  const chipsEl = $('#network-chips');
  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.network;
    if (networks.has(id)) {
      if (networks.size === 1) return; // keep at least one profile
      networks.delete(id);
      chip.classList.remove('active');
    } else {
      networks.add(id);
      chip.classList.add('active');
    }
    const n = networks.size;
    $('#analyze-btn').textContent = `Run ${n} report${n === 1 ? '' : 's'}`;
  });

  /* ---------- modal plumbing ---------- */

  const overlay = $('#report-modal');
  const modalTabs = $('#modal-tabs');
  const modalBody = $('#modal-body');
  const modalSub = $('#modal-sub');

  function openModal() {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    overlay.hidden = true;
    document.body.style.overflow = '';
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  }
  $('#modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });

  let loadingTimer = null;

  function showLoading(url, count) {
    modalTabs.hidden = true;
    modalTabs.innerHTML = '';
    modalSub.textContent = url;
    const stages = [
      'Loading the page in Google’s lab environment…',
      'Collecting Core Web Vitals and main-thread activity…',
      'Running VitalSage rule-based agents…',
      `Deriving ${count} network profile report${count === 1 ? '' : 's'}…`,
    ];
    modalBody.innerHTML = `
      <div class="loading-wrap">
        <div class="spinner"></div>
        <div class="loading-status" id="loading-status">${esc(stages[0])}</div>
        <div class="loading-detail" id="loading-detail">Lab runs usually take 15–40 seconds. Elapsed: 0s</div>
      </div>`;
    const started = Date.now();
    let stage = 0;
    loadingTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const detail = $('#loading-detail');
      if (detail) detail.textContent = `Lab runs usually take 15–40 seconds. Elapsed: ${elapsed}s`;
      const next = Math.min(Math.floor(elapsed / 8), stages.length - 1);
      if (next !== stage) {
        stage = next;
        const status = $('#loading-status');
        if (status) status.textContent = stages[stage];
      }
    }, 1000);
  }

  function showError(url, err) {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    modalTabs.hidden = true;
    const isQuota = /quota|429|rate|api key/i.test(String(err));
    modalBody.innerHTML = `
      <div class="error-wrap">
        <h3>Could not analyze ${esc(url)}</h3>
        <p>${esc(err)}</p>
        ${isQuota
          ? `<p>${DEFAULT_PSI_KEY
               ? 'The PageSpeed API quota for this site is exhausted right now — try again in a minute.'
               : 'This is <b>not your quota</b> — keyless requests draw from one pool that Google shares across every keyless PageSpeed user on the internet, and it is usually exhausted. You can hit this error without ever having run a query.'}
             Paste your own <a class="learn-more" style="margin:0"
             href="https://developers.google.com/speed/docs/insights/v5/get-started#APIKey"
             target="_blank" rel="noopener">free PageSpeed API key</a> (25,000 queries/day) to get
             your own pool — it is stored only in this browser.</p>
             <div class="key-row">
               <input type="text" id="psi-key-input" placeholder="Paste your PageSpeed API key" spellcheck="false">
               <button type="button" class="btn btn-primary" id="psi-key-save">Save &amp; retry</button>
             </div>`
          : `<p>Common causes: the site blocks automated loading, the URL is unreachable, or the public
             PageSpeed quota was hit — waiting a minute and retrying usually helps.</p>`}
        <p style="margin-top:16px">You can always run the real thing locally:</p>
        <p><code>vitalsage trace --url ${esc(url)} --output report.html</code></p>
        <p style="margin-top:14px">
          <button type="button" class="btn btn-ghost" id="demo-report-btn">View a sample report</button>
        </p>
        <p><a class="learn-more" href="${GITHUB}#get-started" target="_blank" rel="noopener">Get started on GitHub →</a></p>
      </div>`;

    const saveBtn = $('#psi-key-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const key = $('#psi-key-input').value.trim();
        if (!key) return;
        localStorage.setItem(KEY_STORAGE, key);
        runAnalysis(url);
      });
    }
    $('#demo-report-btn').addEventListener('click', showDemoReport);
  }

  /* ---------- bundled sample report (when the shared quota is out) ---------- */

  const DEMO_BASE = {
    metrics: { LCP: 3480, FCP: 2100, TTFB: 920, CLS: 0.18, TBT: 480, INP: 310 },
    cpu: {
      scriptingTime: 1240, jsCompileTime: 310, renderingTime: 420,
      mainThreadWork: 2350, totalBlockingTime: 480, longTaskCount: 7,
      domNodes: 3120, requests: 84, transfer: 'Total size was 2.6 MB',
      speedIndex: 3900,
    },
    screenshot: null,
    finalUrl: 'https://demo.example — sample data',
    lighthouseVersion: 'sample',
    suggestions: [],
  };

  function showDemoReport() {
    const audits = {}; // no PSI audits — threshold rules below still fire
    DEMO_BASE.suggestions = buildSuggestions(audits, DEMO_BASE.metrics, DEMO_BASE.cpu);
    DEMO_BASE.suggestions.unshift({
      agent: 'lcp', severity: 'critical',
      title: 'LCP image is not prioritized',
      detail: 'The largest contentful paint element is an image loaded without fetchpriority="high" and discovered late in the document. Preloading it and raising its priority typically recovers 500–1200ms of LCP.',
      effort: 'low', confidence: 0.9, impact: 'reduces LCP by up to 1,200ms',
      learnMore: 'https://web.dev/articles/fetch-priority',
    }, {
      agent: 'font', severity: 'warning',
      title: 'Web fonts load without font-display',
      detail: 'Two @font-face declarations have no font-display strategy, causing invisible text (FOIT) while fonts download. Use font-display: swap and preload the primary font.',
      effort: 'low', confidence: 0.7, impact: 'improves FCP and reduces CLS',
      learnMore: 'https://web.dev/articles/font-display',
    });
    const selected = NETWORK_ORDER.filter((n) => networks.has(n));
    const strategy = device === 'desktop' ? 'desktop' : 'mobile';
    const profiles = deriveProfiles(DEMO_BASE, selected, strategy);
    renderReport(DEMO_BASE, profiles, 'https://demo.example (sample data — not a live measurement)');
  }

  /* ---------- PSI fetch + extraction ---------- */

  const KEY_STORAGE = 'vitalsage-psi-key';

  async function fetchPsi(url, strategy) {
    const params = new URLSearchParams({ url, strategy, category: 'performance' });
    const key = localStorage.getItem(KEY_STORAGE) || DEFAULT_PSI_KEY;
    if (key) params.set('key', key);
    const res = await fetch(`${PSI_ENDPOINT}?${params}`);
    if (!res.ok) {
      let msg = `PageSpeed API returned HTTP ${res.status}.`;
      try {
        const body = await res.json();
        if (body?.error?.message) msg = body.error.message;
      } catch { /* keep generic message */ }
      throw new Error(msg);
    }
    return res.json();
  }

  function num(audits, id) {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' ? v : null;
  }

  function extract(psi) {
    const lh = psi.lighthouseResult;
    if (!lh) throw new Error('The PageSpeed API response did not include lab data for this URL.');
    const audits = lh.audits || {};

    const metrics = {
      LCP:  num(audits, 'largest-contentful-paint'),
      FCP:  num(audits, 'first-contentful-paint'),
      TTFB: num(audits, 'server-response-time'),
      CLS:  num(audits, 'cumulative-layout-shift'),
      TBT:  num(audits, 'total-blocking-time'),
      INP:  psi.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
    };

    // Main-thread CPU breakdown (mirrors the trace panel of the CLI report)
    const groups = {};
    for (const item of audits['mainthread-work-breakdown']?.details?.items || []) {
      groups[item.group] = item.duration;
    }
    const cpu = {
      scriptingTime:  groups.scriptEvaluation || 0,
      jsCompileTime:  groups.scriptParseCompile || 0,
      renderingTime:  (groups.styleLayout || 0),
      mainThreadWork: Object.values(groups).reduce((a, b) => a + b, 0),
      totalBlockingTime: metrics.TBT || 0,
      longTaskCount: (audits['long-tasks']?.details?.items || []).length,
      domNodes: num(audits, 'dom-size') || 0,
      requests: (audits['network-requests']?.details?.items || []).length || null,
      transfer: audits['total-byte-weight']?.displayValue || null,
      speedIndex: num(audits, 'speed-index'),
    };

    const screenshot = audits['final-screenshot']?.details?.data || null;

    return {
      metrics,
      cpu,
      screenshot,
      finalUrl: lh.finalDisplayedUrl || lh.finalUrl || psi.id,
      fetchTime: lh.fetchTime,
      lighthouseVersion: lh.lighthouseVersion,
      suggestions: buildSuggestions(audits, metrics, cpu),
    };
  }

  /* ---------- suggestions: PSI audits + VitalSage threshold rules ---------- */

  function buildSuggestions(audits, metrics, cpu) {
    const out = [];

    for (const [id, meta] of Object.entries(AUDIT_MAP)) {
      const a = audits[id];
      if (!a || a.score === null || a.score === undefined) continue;
      if (a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'informative') continue;
      const cutoff = meta.minScore ?? 0.9;
      if (a.score >= cutoff) continue;

      const { text, firstLink } = fromMarkdown(a.description);
      const savings = a.details?.overallSavingsMs;
      out.push({
        agent: meta.agent,
        severity: a.score < 0.5 ? 'critical' : 'warning',
        title: a.title,
        detail: text,
        effort: meta.effort,
        confidence: a.score < 0.5 ? 0.9 : 0.7,
        impact: a.displayValue || (savings ? `potential savings of ${fmtMs(savings)}` : 'moderate'),
        learnMore: firstLink,
      });
    }

    // Threshold rules straight from the analysis engine's rulebook
    if (metrics.TTFB !== null && metrics.TTFB > 600) {
      out.push({
        agent: 'ttfb', severity: metrics.TTFB > 1800 ? 'critical' : 'warning',
        title: 'Slow server response is delaying every metric',
        detail: `The server took ${fmtMs(metrics.TTFB)} to produce the first byte (VitalSage flags > 600ms). TTFB is the floor under FCP and LCP — caching, a CDN, or faster server rendering pays off across the board.`,
        effort: 'high', confidence: 0.9, impact: `reduces LCP/FCP by up to ${fmtMs(metrics.TTFB - 200)}`,
        learnMore: 'https://web.dev/articles/ttfb',
      });
    }
    if (cpu.totalBlockingTime >= 300) {
      out.push({
        agent: 'trace', severity: cpu.totalBlockingTime >= 600 ? 'critical' : 'warning',
        title: 'Main thread blocked during load',
        detail: `Total Blocking Time is ${fmtMs(cpu.totalBlockingTime)} across ${cpu.longTaskCount} long task(s) (warning ≥ 300ms, critical ≥ 600ms). Long tasks delay interactivity — split work with scheduler.yield()/setTimeout, defer non-critical scripts, or move work to a worker.`,
        effort: 'high', confidence: 0.9, impact: 'directly improves INP and TBT',
        learnMore: 'https://web.dev/articles/tbt',
      });
    }
    if (cpu.scriptingTime >= 500) {
      out.push({
        agent: 'trace', severity: cpu.scriptingTime >= 1500 ? 'critical' : 'warning',
        title: 'Heavy JavaScript execution during load',
        detail: `${fmtMs(cpu.scriptingTime)} of main-thread JS execution (warning ≥ 500ms, critical ≥ 1500ms). Audit bundles for unused code and consider code-splitting the initial route.`,
        effort: 'high', confidence: 0.85, impact: 'reduces TBT and time to interactive',
        learnMore: 'https://web.dev/articles/optimize-long-tasks',
      });
    }
    if (cpu.domNodes >= 2500) {
      out.push({
        agent: 'trace', severity: cpu.domNodes >= 5000 ? 'critical' : 'warning',
        title: 'Very large DOM',
        detail: `${cpu.domNodes.toLocaleString()} DOM nodes (warning ≥ 2,500, critical ≥ 5,000). Large DOMs slow style recalculation and layout on every update — virtualize long lists and defer below-the-fold content.`,
        effort: 'medium', confidence: 0.85, impact: 'reduces rendering and style recalc time',
        learnMore: 'https://web.dev/articles/dom-size',
      });
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.confidence - a.confidence);
    return out;
  }

  /* ---------- per-network derived reports ---------- */

  function deriveProfiles(base, selected, strategy) {
    const baseline = strategy === 'desktop' ? 'wifi' : '4g';
    const factors = FACTORS[strategy];
    return selected.map((net) => {
      const f = factors[net] / factors[baseline];
      const m = base.metrics;
      const scale = (v) => (v === null ? null : v * f);
      // TTFB is RTT-dominated: scale with dampened weight.
      const ttfb = m.TTFB === null ? null : m.TTFB * (1 + (f - 1) * 0.7);
      return {
        network: net,
        estimated: net !== baseline,
        metrics: {
          LCP: scale(m.LCP), FCP: scale(m.FCP), TTFB: ttfb,
          CLS: m.CLS, TBT: m.TBT, INP: m.INP, // CPU/layout-bound: unchanged
        },
      };
    });
  }

  /* ---------- rendering (mirrors report-generator.ts markup) ---------- */

  function metricCard(name, value, estimated) {
    if (value === null) {
      return `<div class="dist-card">
        <div class="dist-metric">${name}</div>
        <div class="dist-p75 dim">–</div>
        <span class="dist-rating" style="background:#4b5563">no data</span>
      </div>`;
    }
    const rating = rate(name, value);
    const color = RATING_COLOR[rating];
    const str = name === 'CLS' ? value.toFixed(3) : fmtMs(value);
    return `<div class="dist-card">
      <div class="dist-metric">${name}</div>
      <div class="dist-p75" style="color:${color}">${str}</div>
      <span class="dist-rating" style="background:${color}">${rating}</span>
      ${estimated ? '<div class="dist-est">estimated</div>' : ''}
    </div>`;
  }

  function tracePanel(cpu) {
    const total = Math.max(cpu.mainThreadWork, 1);
    const cls = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'good');
    const color = (v, warn, crit) => (v >= crit ? '#ef4444' : v >= warn ? '#f59e0b' : '#22c55e');
    const bar = (label, ms, warn, crit) => `
      <div class="trace-bar-row">
        <span class="trace-bar-label">${label}</span>
        <div class="trace-bar-track"><div class="trace-bar-fill" style="width:${(Math.min(ms / total, 1) * 100).toFixed(1)}%;background:${color(ms, warn, crit)}"></div></div>
        <span class="trace-bar-value ${cls(ms, warn, crit)}">${fmtMs(ms)}</span>
      </div>`;
    const kv = (label, value, c = 'dim') =>
      `<div class="trace-kv"><span class="trace-kv-label">${label}</span><span class="trace-kv-value ${c}">${value}</span></div>`;

    return `<div class="trace-panel">
      <div class="trace-panel-title">Main Thread CPU Breakdown</div>
      <div class="trace-panel-caption">CPU time only — does not include network/idle wait · same on every network profile</div>
      ${bar('JS Execute', cpu.scriptingTime, 500, 1500)}
      ${bar('JS Compile', cpu.jsCompileTime, 200, 800)}
      ${bar('Rendering', cpu.renderingTime, 200, 800)}
      <div style="margin-top:12px">
        ${kv('Total Blocking Time', `${fmtMs(cpu.totalBlockingTime)} · ${cpu.longTaskCount} task(s)`, cls(cpu.totalBlockingTime, 300, 600))}
        ${kv('DOM Nodes', cpu.domNodes.toLocaleString(), cls(cpu.domNodes, 2500, 5000))}
        ${cpu.requests ? kv('Requests', String(cpu.requests)) : ''}
        ${cpu.transfer ? kv('Transfer Size', esc(cpu.transfer)) : ''}
        ${cpu.speedIndex !== null ? kv('Speed Index', fmtMs(cpu.speedIndex)) : ''}
      </div>
    </div>`;
  }

  function suggestionHtml(s) {
    const c = SEVERITY_COLOR[s.severity];
    return `<div class="suggestion" style="border-color:${c}">
      <div class="suggestion-header">
        <span class="severity-badge" style="background:${c}">${s.severity}</span>
        <span class="agent-badge">${esc(s.agent)}</span>
        <span class="suggestion-title">${esc(s.title)}</span>
      </div>
      <p class="suggestion-detail">${esc(s.detail)}</p>
      <div class="suggestion-meta">
        <span>effort: ${s.effort}</span>
        <span>confidence: ${Math.round(s.confidence * 100)}%</span>
        <span>impact: ${esc(s.impact)}</span>
      </div>
      ${s.learnMore ? `<a class="learn-more" href="${esc(s.learnMore)}" target="_blank" rel="noopener">Learn more →</a>` : ''}
    </div>`;
  }

  function renderProfile(base, profile, url) {
    const est = profile.estimated;
    const noteHtml = est
      ? `<div class="report-note">Metrics for <b>${NETWORK_LABELS[profile.network]}</b> are estimated from the
         lab baseline run. For real throttled runs across the full matrix, use
         <code>vitalsage simulate --networks ${profile.network}</code> from the
         <a href="${GITHUB}" target="_blank" rel="noopener">GitHub repo</a>.</div>`
      : `<div class="report-note">Baseline lab measurement (Lighthouse ${esc(base.lighthouseVersion || '')})
         via the Google PageSpeed API, analyzed with VitalSage thresholds.</div>`;

    const cards = ['LCP', 'FCP', 'TTFB', 'CLS', 'TBT', 'INP']
      .map((m) => metricCard(m, profile.metrics[m], est && ['LCP', 'FCP', 'TTFB'].includes(m)))
      .join('');

    const suggestions = base.suggestions.length
      ? `<div class="suggestions">${base.suggestions.map(suggestionHtml).join('')}</div>`
      : '<div class="no-suggestions">✓ No rule-based findings — this page passes VitalSage’s thresholds. Nice.</div>';

    return `
      ${noteHtml}
      <div class="route-meta">${esc(url)} · ${esc(DEVICE_LABELS[device])} · network: ${NETWORK_LABELS[profile.network]} · ${new Date().toLocaleString()}</div>
      <div class="distributions">${cards}</div>
      <div class="trace-layout">
        ${base.screenshot ? `<div class="screenshot-wrap"><img class="page-screenshot" src="${esc(base.screenshot)}" alt="Final page screenshot"></div>` : ''}
        ${tracePanel(base.cpu)}
      </div>
      <div class="suggestions-title">Suggestions (${base.suggestions.length})</div>
      ${suggestions}
      <div class="report-cta">
        <b>Want the full picture?</b> This demo is a single lab snapshot. The VitalSage CLI averages
        multiple real Playwright runs, captures a CDP flame chart with per-function timings, adds
        AI-powered root-cause suggestions — and <code>vitalsage fix</code> can apply and verify the
        fixes for you. <a href="${GITHUB}#get-started" target="_blank" rel="noopener">Run it from GitHub →</a>
      </div>`;
  }

  function renderReport(base, profiles, url) {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    modalSub.textContent = base.finalUrl || url;

    modalTabs.innerHTML = profiles.map((p, i) => `
      <button class="rtab${i === 0 ? ' active' : ''}" data-idx="${i}">
        ${NETWORK_LABELS[p.network]}
        <span class="rtab-note">${p.estimated ? 'estimated' : 'lab run'}</span>
      </button>`).join('');
    modalTabs.hidden = false;

    const show = (i) => {
      modalBody.innerHTML = renderProfile(base, profiles[i], url);
      modalBody.scrollTop = 0;
      modalTabs.querySelectorAll('.rtab').forEach((t, j) => t.classList.toggle('active', j === i));
    };
    modalTabs.onclick = (e) => {
      const tab = e.target.closest('.rtab');
      if (tab) show(Number(tab.dataset.idx));
    };
    show(0);
  }

  /* ---------- run + form submit ---------- */

  async function runAnalysis(url) {
    const selected = NETWORK_ORDER.filter((n) => networks.has(n));
    const strategy = device === 'desktop' ? 'desktop' : 'mobile';
    const btn = $('#analyze-btn');
    btn.disabled = true;

    openModal();
    showLoading(url, selected.length);

    try {
      const psi = await fetchPsi(url, strategy);
      const base = extract(psi);
      const profiles = deriveProfiles(base, selected, strategy);
      renderReport(base, profiles, url);
    } catch (err) {
      showError(url, err?.message || 'Unexpected error while fetching lab data.');
    } finally {
      btn.disabled = false;
    }
  }

  $('#analyze-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#url-input').value.trim();
    if (!raw) return;

    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).href;
    } catch {
      $('#url-input').setCustomValidity('Please enter a valid website address');
      $('#url-input').reportValidity();
      setTimeout(() => $('#url-input').setCustomValidity(''), 2000);
      return;
    }

    runAnalysis(url);
  });
})();
