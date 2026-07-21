// ==UserScript==
// @name         Chabad Sprint Risk Board (Board 5)
// @namespace    chabad-sprint-risk-board
// @version      2.4.1
// @description  In-Jira sprint risk board for board 5 (CHABADORG / SITES / COMMUNICATOR), incl. Daily Scrum mode, Dev/PM view, and linked pull requests (from Jira's Development panel). No local server, no API token, no Google Apps Script proxy — runs entirely in your browser using your existing Jira session. Your Customise-panel and theme preferences are saved across reloads.
// @author       you
// @match        https://chabad.atlassian.net/*
// @icon         https://chabad.atlassian.net/favicon.ico
// @updateURL    https://git-bk1/tfs/tfs_MainCollection/CDO/_apis/git/repositories/dev-tools/items?path=/userscripts/jira-risk-board/chabad-sprint-risk-board.user.js&versionDescriptor%5Bversion%5D=main
// @downloadURL  https://git-bk1/tfs/tfs_MainCollection/CDO/_apis/git/repositories/dev-tools/items?path=/userscripts/jira-risk-board/chabad-sprint-risk-board.user.js&versionDescriptor%5Bversion%5D=main
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ============================================================
 * WHAT CHANGED FROM THE ORIGINAL DISTRIBUTION
 * ------------------------------------------------------------
 * The original app had three moving pieces: a local Node server
 * (jira-board-server.js) or a Google Apps Script proxy (jira-board-proxy.gs)
 * that called Jira with an email + API token from board.secrets.js, and a
 * static HTML file (cdo-sites-comm-board.html) that fetched JSON from
 * whichever of those you ran.
 *
 * As a userscript, none of that is needed: this script is injected directly
 * into your already-logged-in chabad.atlassian.net tab, so it can call
 * Jira's REST API itself, same-origin, riding your normal session cookie.
 * There is no token to create, no server to start, and nothing to keep
 * private on disk.
 *
 * Structure:
 *   1. RB_CFG            — board id, risk-cutoff rules, custom-field IDs
 *                            (was board.config.js).
 *   2. Data layer         — the Jira-calling + timer-math functions, ported
 *                            from jira-board-server.js almost line-for-line,
 *                            including the recentUpdaters field (data-shape
 *                            parity with upstream — not wired into the UI
 *                            there yet either).
 *   3. RB_BOARD_HTML      — the original board UI (styles/markup/client JS,
 *                            including Daily Scrum mode and the Dev/PM view
 *                            switch) unchanged, except:
 *                              - its fetch(API_URL) call is replaced with a
 *                                postMessage request to this script, since
 *                                the UI now lives in a sandboxed iframe
 *                                rather than being the top-level page.
 *                              - it reads window.__RB_SAVED_PREFS__ (if the
 *                                host injected one) to restore Customise
 *                                panel / theme / view-mode choices.
 *   4. Host UI            — a small "Risk Board" launcher button, the
 *                            overlay/iframe/message-bridge plumbing, and
 *                            localStorage-backed preference persistence.
 *
 * PREFERENCES: Customise panel choices (card-detail + health-metric toggles
 * and order), night mode, and Dev/PM view are saved in this page's
 * localStorage and restored the next time the board is opened — including
 * after a full browser reload. Session-specific state (developer/tier
 * filters, search text, an open expanded card, an in-progress Daily Scrum)
 * is intentionally NOT saved; it resets each time the overlay is rebuilt,
 * same as re-opening a fresh tab in the original app.
 *
 * To point this at a different board/instance, edit RB_CFG.boardId and the
 * @match line above; the riskCutoffs/composite/fields values are your
 * board.config.js content, unchanged.
 * ============================================================ */

(function () {
  "use strict";

  /* ============================================================
   * DATA LAYER — ported from jira-board-server.js.
   * Runs in the page context Tampermonkey injects into (i.e. the real
   * chabad.atlassian.net tab), so every fetch() below rides on your normal
   * logged-in session cookies. No email, no API token, no Node server,
   * no Google Apps Script proxy — nothing to configure except RB_CFG below.
   * ============================================================ */

  const RB_CFG = {
    // ── Board settings (rarely change) ──────────────────────────────
    boardId: "5",                      // Chabad.org/Sites/Communicator
    inProgressStatus: "In Progress",   // cycle + in-column start counting at the first entry into this status

    // ── Risk cutoff rules ────────────────────────────────────────────
    // Each metric is a list of rules, checked TOP TO BOTTOM — first match wins.
    // Identical shape/semantics to board.config.js's riskCutoffs — see the
    // original README for the full explanation of columns/sizes/warn/risk.
    riskCutoffs: {
      idle: [
        { column:"Blocked",       size:"none", warn:24,   risk:72 },
        { column:"Blocked",       size:1,      warn:24,   risk:72 },
        { column:"Blocked",       size:2,      warn:24,   risk:72 },
        { column:"Blocked",       size:3,      warn:24,   risk:72 },
        { column:"Blocked",       size:5,      warn:24,   risk:72 },
        { column:"Blocked",       size:8,      warn:24,   risk:72 },
        { column:"Blocked",       size:13,     warn:24,   risk:72 },
        { column:"Blocked",       size:20,     warn:24,   risk:72 },
        { column:"Blocked",                    warn:24,   risk:72 },

        { column:"To Do",         size:"none", warn:16,   risk:48 },
        { column:"To Do",         size:1,      warn:16,   risk:48 },
        { column:"To Do",         size:2,      warn:16,   risk:48 },
        { column:"To Do",         size:3,      warn:16,   risk:48 },
        { column:"To Do",         size:5,      warn:16,   risk:48 },
        { column:"To Do",         size:8,      warn:16,   risk:48 },
        { column:"To Do",         size:13,     warn:16,   risk:48 },
        { column:"To Do",         size:20,     warn:16,   risk:48 },
        { column:"To Do",                      warn:16,   risk:48 },

        { column:"In Progress",   size:"none", warn:4,    risk:9 },
        { column:"In Progress",   size:1,      warn:4,    risk:9 },
        { column:"In Progress",   size:2,      warn:4,    risk:9 },
        { column:"In Progress",   size:3,      warn:4,    risk:9 },
        { column:"In Progress",   size:5,      warn:4,    risk:9 },
        { column:"In Progress",   size:8,      warn:4,    risk:9 },
        { column:"In Progress",   size:13,     warn:4,    risk:9 },
        { column:"In Progress",   size:20,     warn:4,    risk:9 },
        { column:"In Progress",                warn:4,    risk:9 },

        { column:"Code Review 1", size:"none", warn:2,    risk:4 },
        { column:"Code Review 1", size:1,      warn:2,    risk:4 },
        { column:"Code Review 1", size:2,      warn:2,    risk:4 },
        { column:"Code Review 1", size:3,      warn:2,    risk:4 },
        { column:"Code Review 1", size:5,      warn:2,    risk:4 },
        { column:"Code Review 1", size:8,      warn:2,    risk:4 },
        { column:"Code Review 1", size:13,     warn:2,    risk:4 },
        { column:"Code Review 1", size:20,     warn:2,    risk:4 },
        { column:"Code Review 1",              warn:2,    risk:4 },

        { column:"Code Review 2", size:"none", warn:3,    risk:6 },
        { column:"Code Review 2", size:1,      warn:3,    risk:6 },
        { column:"Code Review 2", size:2,      warn:3,    risk:6 },
        { column:"Code Review 2", size:3,      warn:3,    risk:6 },
        { column:"Code Review 2", size:5,      warn:3,    risk:6 },
        { column:"Code Review 2", size:8,      warn:3,    risk:6 },
        { column:"Code Review 2", size:13,     warn:3,    risk:6 },
        { column:"Code Review 2", size:20,     warn:3,    risk:6 },
        { column:"Code Review 2",              warn:3,    risk:6 },

        { column:"Pending QA",    size:"none", warn:4,    risk:8 },
        { column:"Pending QA",    size:1,      warn:4,    risk:8 },
        { column:"Pending QA",    size:2,      warn:4,    risk:8 },
        { column:"Pending QA",    size:3,      warn:4,    risk:8 },
        { column:"Pending QA",    size:5,      warn:4,    risk:8 },
        { column:"Pending QA",    size:8,      warn:4,    risk:8 },
        { column:"Pending QA",    size:13,     warn:4,    risk:8 },
        { column:"Pending QA",    size:20,     warn:4,    risk:8 },
        { column:"Pending QA",                 warn:4,    risk:8 },

        { column:"Done",          size:"none", warn:48,   risk:120 },
        { column:"Done",          size:1,      warn:48,   risk:120 },
        { column:"Done",          size:2,      warn:48,   risk:120 },
        { column:"Done",          size:3,      warn:48,   risk:120 },
        { column:"Done",          size:5,      warn:48,   risk:120 },
        { column:"Done",          size:8,      warn:48,   risk:120 },
        { column:"Done",          size:13,     warn:48,   risk:120 },
        { column:"Done",          size:20,     warn:48,   risk:120 },
        { column:"Done",                       warn:48,   risk:120 },

        { default:true,                        warn:24,   risk:72 },
      ],

      cycle: [
        { size:"none",  warn:19, risk:32 },
        { size:1,       warn:6,  risk:12 },
        { size:2,       warn:8,  risk:15 },
        { size:3,       warn:12, risk:20 },
        { size:5,       warn:19, risk:32 },
        { size:8,       warn:24, risk:38 },
        { size:13,      warn:32, risk:50 },
        { size:20,      warn:44, risk:65 },
        { default:true, warn:19, risk:32 },
      ],

      timeInColumn: [
        { column:"Blocked",       size:"none", warn:24,   risk:72 },
        { column:"Blocked",       size:1,      warn:24,   risk:72 },
        { column:"Blocked",       size:2,      warn:24,   risk:72 },
        { column:"Blocked",       size:3,      warn:24,   risk:72 },
        { column:"Blocked",       size:5,      warn:24,   risk:72 },
        { column:"Blocked",       size:8,      warn:24,   risk:72 },
        { column:"Blocked",       size:13,     warn:24,   risk:72 },
        { column:"Blocked",       size:20,     warn:24,   risk:72 },
        { column:"Blocked",                    warn:24,   risk:72 },

        { column:"To Do",         size:"none", warn:16,   risk:48 },
        { column:"To Do",         size:1,      warn:16,   risk:48 },
        { column:"To Do",         size:2,      warn:16,   risk:48 },
        { column:"To Do",         size:3,      warn:16,   risk:48 },
        { column:"To Do",         size:5,      warn:16,   risk:48 },
        { column:"To Do",         size:8,      warn:16,   risk:48 },
        { column:"To Do",         size:13,     warn:16,   risk:48 },
        { column:"To Do",         size:20,     warn:16,   risk:48 },
        { column:"To Do",                      warn:16,   risk:48 },

        { column:"In Progress",   size:"none", warn:6,    risk:12 },
        { column:"In Progress",   size:1,      warn:1,    risk:2 },
        { column:"In Progress",   size:2,      warn:1,    risk:2 },
        { column:"In Progress",   size:3,      warn:3,    risk:6 },
        { column:"In Progress",   size:5,      warn:5,    risk:9 },
        { column:"In Progress",   size:8,      warn:9,    risk:14 },
        { column:"In Progress",   size:13,     warn:23,   risk:32 },
        { column:"In Progress",   size:20,     warn:36,   risk:48 },
        { column:"In Progress",                warn:6,    risk:12 },

        { column:"Code Review 1", size:"none", warn:4,    risk:8 },
        { column:"Code Review 1", size:1,      warn:1,    risk:2 },
        { column:"Code Review 1", size:2,      warn:1,    risk:3 },
        { column:"Code Review 1", size:3,      warn:2,    risk:4 },
        { column:"Code Review 1", size:5,      warn:4,    risk:8 },
        { column:"Code Review 1", size:8,      warn:6,    risk:12 },
        { column:"Code Review 1", size:13,     warn:10,   risk:18 },
        { column:"Code Review 1", size:20,     warn:14,   risk:24 },
        { column:"Code Review 1",              warn:4,    risk:8 },

        { column:"Code Review 2", size:"none", warn:5,    risk:10 },
        { column:"Code Review 2", size:1,      warn:2,    risk:3 },
        { column:"Code Review 2", size:2,      warn:2,    risk:4 },
        { column:"Code Review 2", size:3,      warn:3,    risk:5 },
        { column:"Code Review 2", size:5,      warn:5,    risk:10 },
        { column:"Code Review 2", size:8,      warn:7,    risk:14 },
        { column:"Code Review 2", size:13,     warn:12,   risk:20 },
        { column:"Code Review 2", size:20,     warn:16,   risk:28 },
        { column:"Code Review 2",              warn:5,    risk:10 },

        { column:"Pending QA",    size:"none", warn:6,    risk:12 },
        { column:"Pending QA",    size:1,      warn:2,    risk:4 },
        { column:"Pending QA",    size:2,      warn:3,    risk:5 },
        { column:"Pending QA",    size:3,      warn:4,    risk:7 },
        { column:"Pending QA",    size:5,      warn:6,    risk:12 },
        { column:"Pending QA",    size:8,      warn:9,    risk:16 },
        { column:"Pending QA",    size:13,     warn:14,   risk:24 },
        { column:"Pending QA",    size:20,     warn:20,   risk:32 },
        { column:"Pending QA",                 warn:6,    risk:12 },

        { column:"Done",          size:"none", warn:100,  risk:250 },
        { column:"Done",          size:1,      warn:100,  risk:250 },
        { column:"Done",          size:2,      warn:100,  risk:250 },
        { column:"Done",          size:3,      warn:100,  risk:250 },
        { column:"Done",          size:5,      warn:100,  risk:250 },
        { column:"Done",          size:8,      warn:100,  risk:250 },
        { column:"Done",          size:13,     warn:100,  risk:250 },
        { column:"Done",          size:20,     warn:100,  risk:250 },
        { column:"Done",                       warn:100,  risk:250 },

        { default:true,                        warn:72,   risk:168 },
      ],
    },

    // ── Composite risk metric ────────────────────────────────────────
    composite: {
      p: 2,
      weights: {
        rejections:    1,
        blocked:       1,
        unassignedWip: 1,
        idle:          1,
        timeInColumn:  1,
        cycle:         1,
      },
    },

    // ── Development panel (pull requests) ───────────────────────────
    // PRs linked to each issue come from Jira's own (undocumented) dev-status
    // API — the same source the issue's "Development" panel renders from. No
    // Azure DevOps credentials, PAT, or repo config needed: it rides your Jira
    // session cookie just like every other call here. Was board.config.js →
    // devStatus.
    //   enabled:false turns the feature off; the board behaves as before (the
    //     `prs` array is simply never attached, so the PR count + section vanish).
    //   applicationType: "" auto-discovers the integration type per issue
    //     (recommended); set it (e.g. "stash", "bitbucket") only to OVERRIDE
    //     discovery on instances where the summary endpoint is restricted.
    // Cost: ~1 extra Jira call per PR-less ticket, ~2 per ticket-with-PRs, per refresh.
    devStatus: {
      enabled:         true,
      applicationType: "",      // empty = auto-discover (recommended)
      debug:           false,
    },

    // ── Instance-specific custom-field IDs (rarely change) ──────────
    fields: {
      storyPoints:          "customfield_10004",
      storyPointEstimate:   "customfield_12143",
      codeReviewRejections: "customfield_12526",
      flagged:              "customfield_10002",
      implementor:          "customfield_12178",
      codeReviewer:         "customfield_12525",
      retrospectivePoints:  "customfield_12149",
    },
  };

  const RB_F = RB_CFG.fields || {};
  const RB_FIELDS = ["summary","status","issuetype","assignee","created","parent","issuelinks",
    RB_F.storyPoints, RB_F.storyPointEstimate, RB_F.codeReviewRejections, RB_F.flagged,
    RB_F.implementor, RB_F.codeReviewer, RB_F.retrospectivePoints].filter(Boolean);

  // Same-origin call, using the browser's own Jira session cookie — no auth
  // header, no token. `p` is a path like "/rest/agile/1.0/board/5".
  async function rbJira(p) {
    const res = await fetch(p, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  const rbAgile = p => rbJira("/rest/agile/1.0" + p);

  /* ── Work-hours clock: Mon–Thu 09:00–18:00, Fri 09:00–13:00, America/New_York. ── */
  const RB_TZ = "America/New_York";
  const _rbDtf = new Intl.DateTimeFormat("en-US", { timeZone: RB_TZ, hourCycle: "h23",
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function rbNyParts(ms) { const o = {}; for (const p of _rbDtf.formatToParts(ms)) o[p.type] = p.value;
    let h = +o.hour; if (h === 24) h = 0; return { wd: o.weekday, y: +o.year, mo: +o.month, d: +o.day, h, mi: +o.minute, s: +o.second }; }
  function rbOffsetMs(ms) { const p = rbNyParts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms; }
  function rbNyWallToUtc(y, mo, d, hh, mm) { const guess = Date.UTC(y, mo - 1, d, hh, mm, 0); return guess - rbOffsetMs(guess); }
  const RB_WORK = { Mon: [9, 18], Tue: [9, 18], Wed: [9, 18], Thu: [9, 18], Fri: [9, 13] };
  function rbWorkMs(start, end) {
    if (!(end > start)) return 0;
    let total = 0;
    const sp = rbNyParts(start);
    let cursor = rbNyWallToUtc(sp.y, sp.mo, sp.d, 0, 0);
    for (let i = 0; i < 800 && cursor < end; i++) {
      const cp = rbNyParts(cursor + 12 * 3600000);
      const w = RB_WORK[cp.wd];
      if (w) {
        const openU = rbNyWallToUtc(cp.y, cp.mo, cp.d, w[0], 0);
        const closeU = rbNyWallToUtc(cp.y, cp.mo, cp.d, w[1], 0);
        const lo = Math.max(start, openU), hi = Math.min(end, closeU);
        if (hi > lo) total += (hi - lo);
      }
      const np = rbNyParts(cursor + 26 * 3600000);
      cursor = rbNyWallToUtc(np.y, np.mo, np.d, 0, 0);
    }
    return total;
  }

  const RB_FIELDS_PAGE = p => "fields=" + encodeURIComponent(RB_FIELDS.join(",")) + p;
  async function rbPageAgile(p) {
    let out = [], startAt = 0, total = 1;
    while (startAt < total) {
      const sep = p.includes("?") ? "&" : "?";
      const res = await rbJira("/rest/agile/1.0" + p + sep + RB_FIELDS_PAGE("&startAt=" + startAt + "&maxResults=50"));
      (res.issues || []).forEach(it => out.push(it));
      total = typeof res.total === "number" ? res.total : out.length;
      startAt += 50;
      if (!res.issues || res.issues.length === 0) break;
    }
    return out;
  }

  async function rbFetchHistory(issueId) {
    let status = [], assignee = [], events = [], startAt = 0, total = 1;
    while (startAt < total) {
      const res = await rbJira(`/rest/api/3/issue/${issueId}/changelog?startAt=${startAt}&maxResults=100`);
      (res.values || []).forEach(h => {
        // One changelog entry = one edit by one author at one time (may touch
        // several fields). Record it once for "who updated this, and when".
        const author = h.author && (h.author.displayName || h.author.name);
        if (author && h.created) events.push({ at: h.created, author });
        (h.items || []).forEach(item => {
          if (item.field === "status") status.push({ at: h.created, fromId: String(item.from), fromName: item.fromString, toId: String(item.to), toName: item.toString });
          else if (item.field === "assignee") assignee.push({ at: h.created, from: item.fromString || null, to: item.toString || null });
        });
      });
      total = typeof res.total === "number" ? res.total : status.length + assignee.length;
      startAt += 100;
      if (!res.values || res.values.length === 0) break;
    }
    return { status, assignee, events };
  }

  // Display names of people who made any change to the issue within `windowMs`
  // before `nowMs` (default 24h). Feeds the board's "hide old work" scrum filter.
  function rbRecentUpdaters(events, nowMs, windowMs) {
    nowMs = nowMs || Date.now();
    windowMs = windowMs || 24 * 3.6e6;
    const cutoff = nowMs - windowMs;
    const seen = new Set();
    (events || []).forEach(e => { const t = Date.parse(e.at); if (t >= cutoff && e.author) seen.add(e.author); });
    return [...seen];
  }

  /* ── Development panel (pull requests) ──────────────────────────────
     Ported from jira-board-server.js. The ONLY change from the server version
     is the transport: the server sent an `Authorization: Basic` header via its
     jira() helper; here rbJira() rides the browser's logged-in Jira session
     cookie instead (same same-origin fetch every other call in this file uses).
     Everything else — the summary→detail dev-status dance, normalizePR's field
     mapping, the dedupe, the swallow-errors-and-return-[] contract — is
     line-for-line the same. Purely read-only: no Azure calls, no writes. */
  const RB_DS = RB_CFG.devStatus || {};
  const RB_DS_ENABLED = RB_DS.enabled !== false;      // on unless explicitly disabled
  const RB_DS_APPTYPE = RB_DS.applicationType || "";  // optional OVERRIDE; empty = auto-discover
  const RB_DS_DEBUG   = RB_DS.debug === true;

  function rbNormalizePR(pr, instanceName) {
    const rawStatus = String(pr.status || "").toUpperCase();
    const state = rawStatus === "MERGED" ? "merged"
                : rawStatus === "DECLINED" || rawStatus === "ABANDONED" ? "declined"
                : "active";   // OPEN and anything unrecognized shows as active
    const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
    return {
      id: String(pr.id != null ? pr.id : "").replace(/^#/, ""),
      title: pr.name || "",
      url: pr.url || "",
      state,
      repo: pr.repositoryName || (pr.repository && pr.repository.name) || instanceName || "",
      author: (pr.author && pr.author.name) || "",
      updated: pr.lastUpdate || pr.lastUpdated || null,
      source: (pr.source && (pr.source.branch || pr.source.name)) || null,
      target: (pr.destination && (pr.destination.branch || pr.destination.name)) || null,
      approvals: reviewers.filter(r => r && (r.approved === true || String(r.approvalStatus).toUpperCase() === "APPROVED")).length,
      reviewers: reviewers.length,
    };
  }
  async function rbFetchPullRequests(issueId, issueKey) {
    if (!RB_DS_ENABLED) return undefined;   // feature off → omit `prs` entirely
    try {
      // Which integration(s) hold PR data for this issue? The summary endpoint is
      // the authoritative source of the applicationType value — you can't reliably
      // guess it (Jira uses "stash" for Bitbucket, etc.). A configured
      // RB_DS_APPTYPE overrides discovery for instances where summary is restricted.
      let types;
      if (RB_DS_APPTYPE) {
        types = [RB_DS_APPTYPE];
      } else {
        const sum = await rbJira(`/rest/dev-status/latest/issue/summary?issueId=${encodeURIComponent(issueId)}`);
        const prSum = sum && sum.summary && sum.summary.pullrequest;
        types = prSum && prSum.byInstanceType ? Object.keys(prSum.byInstanceType) : [];
        if (RB_DS_DEBUG) console.log(`[dev-status] ${issueKey || issueId}: summary types = [${types.join(", ") || "none"}]`);
        if (!types.length) return [];   // no PRs linked to this issue
      }

      const out = [];
      for (const t of types) {
        const q = `?issueId=${encodeURIComponent(issueId)}&applicationType=${encodeURIComponent(t)}&dataType=pullrequest`;
        const res = await rbJira("/rest/dev-status/latest/issue/detail" + q);
        (res.detail || []).forEach(d => {
          const inst = d._instance && d._instance.name;
          (d.pullRequests || []).forEach(pr => out.push(rbNormalizePR(pr, inst)));
        });
      }
      // Dedupe (a PR can appear under more than one instance); prefer PR url, else id.
      const seen = new Set(), uniq = [];
      for (const pr of out) { const k = pr.url || pr.id; if (k && seen.has(k)) continue; if (k) seen.add(k); uniq.push(pr); }
      if (RB_DS_DEBUG) console.log(`[dev-status] ${issueKey || issueId}: ${uniq.length} PR(s)`);
      return uniq;
    } catch (e) {
      if (RB_DS_DEBUG) console.log(`[dev-status] ${issueKey || issueId}: ERROR ${e.message}`);
      return [];   // reachable-but-failed → empty list, board still renders
    }
  }

  async function rbFetchDoneStatusIds() {
    const arr = await rbJira("/rest/api/3/status");
    const s = new Set();
    (arr || []).forEach(st => { if (st.statusCategory && st.statusCategory.key === "done") s.add(String(st.id)); });
    return s;
  }

  function rbReduceTimers(created, statusChanges, assigneeAt, currentStatusId, currentStatusName, statusToColumn, doneIds, inProgressName, nowMs, doneColStatusIds) {
    nowMs = nowMs || Date.now();
    const t0 = Date.parse(created);
    const changes = statusChanges.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let segs = [], prevT = t0;
    let prevId = changes.length ? changes[0].fromId : currentStatusId;
    let prevName = changes.length ? changes[0].fromName : currentStatusName;
    for (const c of changes) { const ct = Date.parse(c.at); segs.push({ id: prevId, name: prevName, start: prevT, end: ct }); prevT = ct; prevId = c.toId; prevName = c.toName; }
    segs.push({ id: prevId, name: prevName, start: prevT, end: nowMs });

    // The board treats its LAST column as Done (by position). Time INSIDE Done
    // never counts toward any metric, but Done is a PAUSE, not a permanent stop:
    // if the ticket is pulled back out of Done into a working column the clocks
    // resume (only the Done interval is excluded). A ticket CURRENTLY in Done is
    // frozen at the moment it last entered Done.
    const inBoardDone = s => !!(doneColStatusIds && doneColStatusIds.has(String(s.id)));
    const lastSeg = segs[segs.length - 1];
    const sittingInDone = !!lastSeg && inBoardDone(lastSeg);
    const clockEnd = sittingInDone ? lastSeg.start : nowMs;
    segs = segs
      .map(s => ({ ...s, end: Math.min(s.end, clockEnd) }))
      .filter(s => s.end > s.start && !inBoardDone(s));

    let anchor = segs.length ? segs[segs.length - 1].start : t0;
    for (const a of (assigneeAt || [])) { const t = Date.parse(a); if (t > anchor && t <= clockEnd) anchor = t; }
    const idleHours = rbWorkMs(anchor, clockEnd) / 3.6e6;

    let firstIP = null;
    for (const s of segs) if (s.name === inProgressName) { firstIP = s.start; break; }
    const started = firstIP != null;

    // In-column: while sitting in Done, use the last non-Done column; else live.
    let curCol = statusToColumn[String(currentStatusId)] || currentStatusName;
    if (sittingInDone && segs.length) curCol = statusToColumn[String(segs[segs.length - 1].id)] || segs[segs.length - 1].name;
    let ticHours = null, cycleHours = null;
    if (started) {
      let tic = 0, cyc = 0;
      for (const s of segs) {
        const from = Math.max(s.start, firstIP);
        if (s.end <= from) continue;
        const w = rbWorkMs(from, s.end);
        if ((statusToColumn[String(s.id)] || s.name) === curCol) tic += w;
        if (!doneIds.has(String(s.id))) cyc += w;
      }
      ticHours = tic / 3.6e6; cycleHours = cyc / 3.6e6;
    }
    return { idleHours, timeInColumnHours: started ? ticHours : null, cycleHours: started ? cycleHours : null, started };
  }

  function rbWorkMsWithin(from, to, intervals) {
    let t = 0;
    for (const iv of intervals) {
      const lo = Math.max(from, iv.start), hi = Math.min(to, iv.end);
      if (hi > lo) t += rbWorkMs(lo, hi);
    }
    return t;
  }

  function rbBuildSegments(created, statusChanges, assigneeChanges, currentStatusId, currentStatusName, currentAssignee, statusToColumn, doneIds, inProgressName, nowMs, doneColStatusIds) {
    nowMs = nowMs || Date.now();
    const t0 = Date.parse(created);

    const changes = statusChanges.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let segs = [], prevT = t0;
    let prevId = changes.length ? changes[0].fromId : currentStatusId;
    let prevName = changes.length ? changes[0].fromName : currentStatusName;
    for (const c of changes) { const ct = Date.parse(c.at); segs.push({ id: prevId, name: prevName, start: prevT, end: ct }); prevT = ct; prevId = c.toId; prevName = c.toName; }
    segs.push({ id: prevId, name: prevName, start: prevT, end: nowMs });

    // Flow: a Done visit is a PAUSE that renders as a ✓ stub (zero cycle height)
    // with a neutral grey connector. The line "hits" Done and, if the ticket is
    // later pulled back into a working column, picks up on exit. Time inside Done
    // never counts. Done segments are KEPT (as stubs), not dropped, so both
    // "sitting in Done" (line ends on the stub) and "re-opened" render correctly.
    const inBoardDone = s => !!(doneColStatusIds && doneColStatusIds.has(String(s.id)));
    const isDoneSeg = s => doneIds.has(String(s.id)) || inBoardDone(s);
    segs = segs.filter(s => s.end > s.start);

    let firstIP = null;
    for (const s of segs) if (s.name === inProgressName) { firstIP = s.start; break; }
    if (firstIP == null) {
      return { columnTotals: [], flow: { createdAt: created, startedAt: null, columnSegs: [], assigneeSegs: [], totalHours: 0 } };
    }

    const cycleIntervals = [];
    for (const s of segs) {
      if (isDoneSeg(s)) continue;
      const from = Math.max(s.start, firstIP);
      if (s.end > from) cycleIntervals.push({ start: from, end: s.end });
    }

    const colOf = s => statusToColumn[String(s.id)] || s.name;
    const colSegs = [];
    for (const s of segs) {
      const from = Math.max(s.start, firstIP);
      if (s.end <= from) continue;
      const col = colOf(s), dc = isDoneSeg(s);
      const last = colSegs[colSegs.length - 1];
      if (last && last.column === col && last.doneCat === dc) { last.toMs = s.end; last.status = s.name; }
      else colSegs.push({ column: col, status: s.name, fromMs: from, toMs: s.end, doneCat: dc });
    }
    const totals = {}, visits = {}, order = [];
    for (const cs of colSegs) {
      cs.hours = rbWorkMsWithin(cs.fromMs, cs.toMs, cycleIntervals) / 3.6e6;
      if (!(cs.column in totals)) { totals[cs.column] = 0; visits[cs.column] = 0; order.push(cs.column); }
      totals[cs.column] += rbWorkMs(cs.fromMs, cs.toMs) / 3.6e6;
      visits[cs.column]++;
    }
    const columnTotals = order.map(c => ({ column: c, hours: totals[c], visits: visits[c] }));

    const ach = (assigneeChanges || []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let aSegs = [], aPrevT = t0;
    let aPrev = ach.length ? ach[0].from : (currentAssignee || null);
    for (const c of ach) { const ct = Date.parse(c.at); aSegs.push({ assignee: aPrev, start: aPrevT, end: ct }); aPrevT = ct; aPrev = c.to; }
    aSegs.push({ assignee: aPrev, start: aPrevT, end: nowMs });
    const assigneeSegs = [];
    for (const s of aSegs) {
      const from = Math.max(s.start, firstIP);
      if (s.end <= from) continue;
      const last = assigneeSegs[assigneeSegs.length - 1];
      if (last && last.assignee === s.assignee) { last.toMs = s.end; }
      else assigneeSegs.push({ assignee: s.assignee, fromMs: from, toMs: s.end });
    }
    for (const s of assigneeSegs) s.hours = rbWorkMsWithin(s.fromMs, s.toMs, cycleIntervals) / 3.6e6;

    const totalHours = rbWorkMsWithin(firstIP, nowMs, cycleIntervals) / 3.6e6;
    return {
      columnTotals,
      flow: { createdAt: created, startedAt: new Date(firstIP).toISOString(), columnSegs: colSegs, assigneeSegs, totalHours }
    };
  }

  async function rbMapIssue(it, statusToColumn, firstCol, doneIds, doneColStatusIds) {
    const f = it.fields || {}, st = f.status || {};
    let statusId = String(st.id || ""), statusName = st.name || "";
    const a = f.assignee;
    let assigneeName = a ? a.displayName : null;
    let avatarUrl = a && a.avatarUrls ? a.avatarUrls["32x32"] : null;
    const pts = f[RB_F.storyPoints] != null ? f[RB_F.storyPoints] : f[RB_F.storyPointEstimate];

    // PRs come from Jira's dev-status data; fetch concurrently with the changelog.
    const [hist, prs] = await Promise.all([
      rbFetchHistory(it.id),
      rbFetchPullRequests(it.id, it.key),
    ]);
    const statusHist = hist.status, assigneeHist = hist.assignee;
    const isDone = !!(st.statusCategory && st.statusCategory.key === "done");
    const column = statusToColumn[statusId] || statusName;

    let blockedBy = [];
    (f.issuelinks || []).forEach(l => {
      if (l.inwardIssue && l.type && l.type.name === "Blocks") {
        const bs = l.inwardIssue.fields && l.inwardIssue.fields.status;
        const bStatusId = bs && bs.id != null ? String(bs.id) : null;
        const cat = bs && bs.statusCategory;
        const inDoneCol = bStatusId != null && doneColStatusIds && doneColStatusIds.has(bStatusId);
        const catDone = cat && cat.key === "done";
        if (!inDoneCol && !catDone) blockedBy.push(l.inwardIssue.key);
      }
    });
    const flagged = !!f[RB_F.flagged];
    const blocked = flagged || blockedBy.length > 0;

    const assigneeAt = assigneeHist.map(x => x.at);
    const tm = rbReduceTimers(f.created, statusHist, assigneeAt, statusId, statusName, statusToColumn, doneIds, RB_CFG.inProgressStatus, null, doneColStatusIds);
    const seg = rbBuildSegments(f.created, statusHist, assigneeHist, statusId, statusName, assigneeName, statusToColumn, doneIds, RB_CFG.inProgressStatus, null, doneColStatusIds);
    const userName = id => (f[id] && f[id].displayName) || null;
    return {
      key: it.key, status: statusName, column,
      type: f.issuetype ? f.issuetype.name : "", assignee: assigneeName,
      avatarUrl, summary: f.summary || "",
      points: pts != null ? pts : null, parentKey: f.parent ? f.parent.key : null,
      implementor: userName(RB_F.implementor), codeReviewer: userName(RB_F.codeReviewer),
      retrospectivePoints: f[RB_F.retrospectivePoints] != null ? f[RB_F.retrospectivePoints] : null,
      rejections: f[RB_F.codeReviewRejections] != null ? f[RB_F.codeReviewRejections] : null,
      blocked, blockedByOpen: blockedBy,
      unassignedInProgress: assigneeName == null && column !== firstCol && !isDone,
      done: isDone,
      idleHours: tm.idleHours, timeInColumnHours: tm.timeInColumnHours, cycleHours: tm.cycleHours, started: tm.started,
      columnTotals: seg.columnTotals, flow: seg.flow,
      // Who touched this ticket in the last 24h. Not wired into the UI yet
      // (mirrors the upstream server, which added the field ahead of a
      // planned "hide old work" scrum filter) — kept for data-shape parity.
      recentUpdaters: rbRecentUpdaters(hist.events, Date.now()),
      ...(prs !== undefined ? { prs } : {})   // present only when dev-status is enabled
    };
  }

  async function rbFetchBoardMaps() {
    const conf = await rbAgile(`/board/${RB_CFG.boardId}/configuration`);
    const cols = (conf.columnConfig && conf.columnConfig.columns) || [];
    const columnNames = cols.map(c => c.name);
    const statusToColumn = {};
    cols.forEach(c => (c.statuses || []).forEach(s => { statusToColumn[String(s.id)] = c.name; }));
    const firstCol = columnNames[0] || null;
    const doneColName = columnNames.length ? columnNames[columnNames.length - 1] : null;
    const doneColStatusIds = new Set();
    cols.forEach(c => { if (c.name === doneColName) (c.statuses || []).forEach(s => doneColStatusIds.add(String(s.id))); });
    const doneIds = await rbFetchDoneStatusIds();
    return { columnNames, statusToColumn, firstCol, doneColStatusIds, doneIds };
  }

  async function rbBuildBoard() {
    const { columnNames, statusToColumn, firstCol, doneColStatusIds, doneIds } = await rbFetchBoardMaps();

    const board = await rbAgile(`/board/${RB_CFG.boardId}`);
    let raw = [];
    if (board.type === "scrum") {
      const sprints = await rbAgile(`/board/${RB_CFG.boardId}/sprint?state=active`);
      for (const sp of (sprints.values || [])) raw = raw.concat(await rbPageAgile(`/board/${RB_CFG.boardId}/sprint/${sp.id}/issue`));
    } else {
      raw = await rbPageAgile(`/board/${RB_CFG.boardId}/issue`);
    }
    const issues = await Promise.all(raw.map(it => rbMapIssue(it, statusToColumn, firstCol, doneIds, doneColStatusIds)));
    return { columns: columnNames, issues, riskCutoffs: RB_CFG.riskCutoffs || null, composite: RB_CFG.composite || null };
  }

  const RB_BOARD_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Chabad.org / Sites / Communicator \u2014 Sprint Board</title>\n<style>\n  :root {\n    --bg:#f4f5f7; --column-bg:#f1f2f4; --card-bg:#fff;\n    --ink:#172b4d; --subtle:#5e6c84; --link:#0052cc; --border:#dfe1e6;\n    --ok:#36b37e; --warn:#ffab00; --risk:#ff5630; --none:#a5adba;\n    --shadow:0 1px 1px rgba(9,30,66,.25),0 0 1px rgba(9,30,66,.13);\n    --hover:#f1f2f4; --card-hover:#fafbfc; --zone-border:#ebecf0;\n    --pill-bg:#ebecf0; --avatar-bg:#dfe1e6; --overlay:rgba(9,30,66,.48);\n    --done-seg:#ebecf0;\n    color-scheme:light;\n  }\n  html[data-theme=\"dark\"] {\n    --bg:#161a1f; --column-bg:#1c2129; --card-bg:#22272e;\n    --ink:#c7d1dc; --subtle:#8c99a8; --link:#579dff; --border:#323a45;\n    --ok:#4bce97; --warn:#e2b203; --risk:#f87462; --none:#6b7684;\n    --shadow:0 1px 2px rgba(0,0,0,.4),0 0 1px rgba(0,0,0,.3);\n    --hover:#2a313a; --card-hover:#2a313a; --zone-border:#323a45;\n    --pill-bg:#2a313a; --avatar-bg:#3a434f; --overlay:rgba(0,0,0,.62);\n    --done-seg:#2a313a;\n    color-scheme:dark;\n  }\n  *{box-sizing:border-box;margin:0;padding:0}\n  html,body{height:100%}\n  body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\n       background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;\n       display:flex;flex-direction:column;overflow:hidden}\n  header.board-head,#panel,.summary,.devbar{flex:0 0 auto}\n  header.board-head{padding:18px 24px 8px}\n  .title-row{display:flex;align-items:center;gap:12px}\n  h1{font-size:22px;font-weight:600;letter-spacing:-.01em;flex:1 1 auto}\n  .meta{font-size:12px;color:var(--subtle);margin-top:6px}\n  button.tool{display:inline-flex;align-items:center;justify-content:center;height:34px;\n    border:1px solid var(--border);background:var(--card-bg);border-radius:6px;cursor:pointer;color:var(--subtle);\n    transition:background .12s,color .12s;font-size:13px;gap:6px;padding:0 12px}\n  button.tool:hover{background:var(--hover);color:var(--ink)}\n  .search-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto}\n  .search-wrap .search-ico{position:absolute;left:9px;width:15px;height:15px;color:var(--subtle);pointer-events:none}\n  #search{height:34px;border:1px solid var(--border);background:var(--card-bg);color:var(--ink);\n    border-radius:6px;font-size:13px;font-family:inherit;padding:0 10px 0 30px;width:190px;transition:width .12s,border-color .12s}\n  #search:focus{outline:none;border-color:var(--link);width:240px}\n  #search::placeholder{color:var(--subtle)}\n  #refresh{width:34px;padding:0;flex:0 0 auto}\n  #refresh svg{width:17px;height:17px}\n  #refresh.spinning svg{animation:spin .8s linear infinite}\n  @keyframes spin{to{transform:rotate(360deg)}}\n  #customise{width:34px;padding:0;flex:0 0 auto}\n  #customise svg{width:18px;height:18px}\n  #customise[aria-expanded=\"true\"]{background:var(--hover);color:var(--ink)}\n  /* view-mode switch (Dev / PM) inside the customise panel */\n  .modeswitch{display:flex;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden;width:max-content}\n  .modeswitch button{border:none;background:var(--card-bg);color:var(--subtle);cursor:pointer;\n    font-family:inherit;font-size:13px;padding:6px 16px;transition:background .12s,color .12s}\n  .modeswitch button+button{border-left:1px solid var(--border)}\n  .modeswitch button:hover{background:var(--hover);color:var(--ink)}\n  .modeswitch button.active{background:var(--link);color:#fff}\n  .panel-col .modehint{font-size:12px;color:var(--subtle);margin-top:8px;line-height:1.5}\n  .modeblock+.panel-grid{margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}\n\n  /* customise panel */\n  #panel{display:none;margin:10px 24px 0;border:1px solid var(--border);background:var(--card-bg);border-radius:8px;padding:14px 16px}\n  #panel.open{display:block}\n  .panel-grid{display:flex;gap:32px;flex-wrap:wrap}\n  .panel-col{min-width:240px;flex:1 1 240px}\n  .panel-col h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);margin-bottom:10px;font-weight:700}\n  .opt{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px}\n  .opt input[type=checkbox]{width:15px;height:15px;accent-color:var(--link);cursor:pointer}\n  .opt .lbl{flex:1 1 auto;cursor:pointer}\n  .opt .ord{display:flex;gap:2px}\n  .opt .ord button{width:22px;height:22px;border:1px solid var(--border);background:var(--card-bg);border-radius:4px;\n    cursor:pointer;color:var(--subtle);font-size:11px;line-height:1;padding:0}\n  .opt .ord button:hover{background:var(--hover);color:var(--ink)}\n  .opt .ord button:disabled{opacity:.3;cursor:default}\n  .opt .sortbadge{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:var(--link);\n    border:1px solid var(--link);border-radius:3px;padding:1px 4px}\n  .sortline{font-size:12px;color:var(--subtle);margin-top:12px;border-top:1px solid var(--border);padding-top:10px}\n  .sortline b{color:var(--ink)}\n\n  .board{display:flex;gap:5px;padding:16px 24px 24px;overflow-x:auto;overflow-y:hidden;align-items:flex-start;flex:1 1 auto;min-height:0}\n  .column{flex:0 0 262px;background:var(--column-bg);border-radius:4px;padding:6px;display:flex;flex-direction:column;max-height:100%}\n  .column-head{display:flex;align-items:center;gap:8px;padding:6px 6px 10px;text-transform:uppercase;\n    font-size:11.5px;font-weight:600;letter-spacing:.04em;color:var(--subtle)}\n  .cards{display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:2px}\n  .card{background:var(--card-bg);border-radius:3px;box-shadow:var(--shadow);padding:9px 9px 8px;border:2px solid transparent;cursor:pointer}\n  .card:hover{background:var(--card-hover)}\n  .card .summary{font-size:14px;line-height:1.36;margin-bottom:9px}\n  .card .foot{display:flex;align-items:center;justify-content:space-between;gap:8px}\n  .card .id-wrap{display:inline-flex;align-items:center;gap:6px}\n  .card .key{font-size:13px;font-weight:600;color:var(--link);text-decoration:none}\n  .card .key:hover{text-decoration:underline}\n  .type-ico{width:16px;height:16px;border-radius:3px;flex:0 0 auto;display:inline-block}\n  .avatar{width:24px;height:24px;border-radius:50%;flex:0 0 auto;object-fit:cover;background:var(--avatar-bg)}\n  .avatar.initials{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700}\n\n  /* zone 2 (info) and zone 3 (health) */\n  .zone{margin-top:9px;padding-top:8px;border-top:1px solid var(--zone-border)}\n  .zone-info{font-size:12px;line-height:1.5;color:var(--ink)}\n  .zone-info .k{color:var(--subtle)}\n  .zone-info .klead{display:inline-block;min-width:62px}\n  .zone-info .pair{margin-right:4px}\n  .zone-info .avatar{width:18px;height:18px;vertical-align:middle;margin:0 4px -1px 2px}\n  .zone-info .withav{vertical-align:middle}\n  .zone-info .pairline+.pairline{margin-top:1px}\n  /* -- expanded-card pull requests -- */\n  .xprs{margin-top:16px;padding-top:14px;border-top:1px solid var(--zone-border)}\n  .xprs-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;font-weight:600;color:var(--ink)}\n  .xprs-head .n{color:var(--none);font-weight:400}\n  .xprs-empty{font-size:12.5px;color:var(--subtle);font-style:italic}\n  .pr{border:1px solid var(--border);border-radius:6px;padding:9px 11px}\n  .pr+.pr{margin-top:8px}\n  .pr.declined{opacity:.62}\n  .pr-top{display:flex;align-items:center;gap:9px}\n  .pr-pill{flex:0 0 auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--pill-bg);color:var(--subtle);white-space:nowrap}\n  .pr-pill.active{background:rgba(0,82,204,.12);color:var(--link)}\n  .pr-pill.merged{background:rgba(54,179,126,.16);color:var(--ok)}\n  html[data-theme=\"dark\"] .pr-pill.active{background:rgba(87,157,255,.16)}\n  html[data-theme=\"dark\"] .pr-pill.merged{background:rgba(75,206,151,.18)}\n  .pr-title{color:var(--link);text-decoration:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}\n  .pr-title:hover{text-decoration:underline}\n  .pr-repo{margin-left:auto;flex:0 0 auto;font-size:11.5px;color:var(--none);display:inline-flex;align-items:center;gap:4px}\n  .pr-meta{font-size:11.5px;color:var(--subtle);margin-top:6px}\n  .pr-rev{font-size:11.5px;margin-top:5px;color:var(--none)}\n  .pr-rev .ok{color:var(--ok)}\n  .xprs .health-divider{margin:8px 0 0}\n  .xprs .health-more{opacity:1}\n  .xprs .health-more.open{display:block;margin-top:8px}\n\n  .status-line{margin:-2px 0 8px}\n  .status-pill{display:inline-block;font-size:10.5px;color:var(--subtle);background:var(--pill-bg);\n    border-radius:3px;padding:1px 7px;letter-spacing:.02em;white-space:nowrap}\n  .zone-health{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px}\n  .metric{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}\n  .metric .dot,.xtile .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--none)}\n  .metric .dot.ok,.xtile .dot.ok{background:var(--ok)} .metric .dot.warn,.xtile .dot.warn{background:var(--warn)}\n  .metric .dot.risk,.xtile .dot.risk{background:var(--risk)} .metric .dot.none,.xtile .dot.none{background:var(--none)}\n  .metric .ml{color:var(--subtle)} .metric .mv{color:var(--ink);font-weight:600}\n  .metric.pending .mv{color:var(--none);font-weight:400;font-style:italic}\n\n  .summary{margin:10px 24px 0;display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;font-size:12.5px}\n  .sum-tiers{display:flex;gap:8px;align-items:center;flex-wrap:wrap}\n  .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:var(--card-bg);\n    border-radius:14px;padding:4px 11px;cursor:pointer;color:var(--ink);font-size:12.5px;font-family:inherit}\n  .chip:hover{background:var(--hover)}\n  .chip.active{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink) inset}\n  .chip.nodata{cursor:default;color:var(--subtle)}\n  .chip.clear{color:var(--subtle)}\n  .chip .dot{width:9px;height:9px;border-radius:50%}\n  .chip .dot.risk{background:var(--risk)} .chip .dot.warn{background:var(--warn)}\n  .chip .dot.ok{background:var(--ok)} .chip .dot.none{background:var(--none)}\n  .sum-drv{color:var(--subtle);display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n  .sum-drv .drv-label{color:var(--subtle)}\n  .drv{border:none;background:none;cursor:pointer;color:var(--link);font-size:12.5px;padding:0;font-family:inherit}\n  .drv:hover{text-decoration:underline}\n  .drv b{color:var(--ink)}\n  .sum-drv .sep{color:var(--border)}\n  .sum-empty{color:var(--subtle)}\n  .devbar{margin:8px 24px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12.5px}\n  .devbar .bar-label{color:var(--subtle)}\n  .devbar .chip .avatar{width:18px;height:18px}\n  .devbar .chip .avatar.initials{font-size:8px}\n  .devbar .chip.active{background:var(--hover)}\n  .empty{font-size:13px;color:var(--subtle);padding:8px;font-style:italic}\n  /* \u2500\u2500 expanded card (modal) \u2500\u2500 */\n  #overlay{position:fixed;inset:0;background:var(--overlay);display:none;z-index:60;\n    align-items:flex-start;justify-content:center;padding:5vh 16px;overflow-y:auto}\n  #overlay.open{display:flex}\n  .xdialog{background:var(--card-bg);border-radius:8px;box-shadow:0 8px 28px rgba(9,30,66,.35);\n    width:100%;max-width:680px;max-height:90vh;overflow-y:auto;padding:18px 20px 16px}\n  .xhead{display:flex;align-items:flex-start;gap:10px}\n  .xtitles{flex:1 1 auto;min-width:0}\n  .xkeyline{display:flex;align-items:center;gap:7px}\n  .xsummary{font-size:16px;font-weight:600;line-height:1.35;margin-top:3px}\n  .xsub{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;font-size:12px;color:var(--subtle)}\n  .xclose{width:30px;height:30px;padding:0;flex:0 0 auto;font-size:15px}\n  .xinfo{margin-top:12px;font-size:12.5px;display:flex;flex-wrap:wrap;align-items:center;gap:3px 16px}\n  .xinfo>span{display:inline-flex;align-items:center;gap:4px}\n  .xinfo .k{color:var(--subtle)}\n  .xinfo .avatar{width:18px;height:18px}\n  .xinfo .avatar.initials{font-size:8px}\n  .xtiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:14px}\n  .xtile{background:var(--column-bg);border-radius:6px;padding:9px 11px}\n  .xtile .tl{font-size:11.5px;color:var(--subtle);display:flex;align-items:center;gap:6px}\n  .xtile .tv{font-size:14.5px;font-weight:600;margin-top:2px}\n  .xtile .tv.pending{color:var(--none);font-weight:400;font-style:italic}\n  .xtile .tt{font-size:10.5px;color:var(--none);margin-top:2px}\n  .xtabs{display:flex;gap:18px;border-bottom:1px solid var(--border);margin-top:16px}\n  .xtab{border:none;background:none;cursor:pointer;font-size:13px;color:var(--subtle);\n    padding:8px 2px;border-bottom:2px solid transparent;font-family:inherit;margin-bottom:-1px}\n  .xtab:hover{color:var(--ink)}\n  .xtab.on{color:var(--ink);border-bottom-color:var(--link);font-weight:600}\n  .xpane{padding:14px 2px 2px}\n  .xnote{font-size:11.5px;color:var(--none);margin-top:10px;line-height:1.5}\n  .xempty{font-size:13px;color:var(--subtle);font-style:italic;padding:14px 2px}\n  .cbar-grid{display:grid;grid-template-columns:126px minmax(0,1fr) 96px;gap:7px 10px;align-items:center;font-size:12px}\n  .cbar-grid .cn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .cbar{height:15px;border-radius:3px;min-width:2px}\n  select.tool{height:34px;border:1px solid var(--border);background:var(--card-bg);color:var(--ink);\n    border-radius:6px;font-size:13px;padding:0 8px;cursor:pointer;font-family:inherit;max-width:260px}\n\n  /* \u2500\u2500 expanded-card shared bits \u2500\u2500 */\n  .cbar.plain{background:var(--link);opacity:.75}\n  .colgrid .num,.mbar-grid .num,.tkrow .pts,.tkrow .cyc{font-variant-numeric:tabular-nums}\n  .secnote{font-size:11px;color:var(--none);margin-top:10px;line-height:1.5}\n  @media (max-width:600px){.board{padding:12px}.column{flex-basis:260px}}\n\n  /* \u2500\u2500 Daily Scrum Mode \u2500\u2500 */\n  html[data-scrum=\"on\"] #meta,\n  html[data-scrum=\"on\"] #customise,\n  html[data-scrum=\"on\"] #summary,\n  html[data-scrum=\"on\"] #dailyScrum { display:none !important; }\n\n  .card.scrum-followup{background-color:#FBF4EA;color:#0b0b0b}\n  .card.scrum-followup .summary,.card.scrum-followup .status-line,\n  .card.scrum-followup .foot,.card.scrum-followup .zone{color:#0b0b0b}\n  html[data-theme=\"dark\"] .card.scrum-followup{background-color:#332816;color:#f5f0e6}\n  html[data-theme=\"dark\"] .card.scrum-followup .summary,html[data-theme=\"dark\"] .card.scrum-followup .status-line,\n  html[data-theme=\"dark\"] .card.scrum-followup .foot,html[data-theme=\"dark\"] .card.scrum-followup .zone{color:#f5f0e6}\n  .card.scrum-followup .zone-info .k{color:#633806}\n  .card.scrum-followup .status-pill{color:#412402;background:#F6DCA9}\n  html[data-theme=\"dark\"] .card.scrum-followup .zone-info .k{color:#FAC775}\n  html[data-theme=\"dark\"] .card.scrum-followup .status-pill{color:#FAEEDA;background:#633806}\n  .card.scrum-followup .metric .ml,.card.scrum-followup .health-divider-label{color:#633806}\n  .card.scrum-followup .metric .mv{color:#0b0b0b}\n  html[data-theme=\"dark\"] .card.scrum-followup .metric .ml,html[data-theme=\"dark\"] .card.scrum-followup .health-divider-label{color:#FAC775}\n  html[data-theme=\"dark\"] .card.scrum-followup .metric .mv{color:#f5f0e6}\n  .scrum-followup-pill{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:600;\n    background:#BA7517;color:#ffffff;border-radius:12px;padding:2px 8px;margin-bottom:4px}\n  html[data-theme=\"dark\"] .scrum-followup-pill{background:#EF9F27;color:#412402}\n\n  .health-divider{display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer}\n  .health-divider hr{flex:1;border:none;border-top:1px solid var(--zone-border);margin:0}\n  .health-divider-label{font-size:11px;color:var(--subtle);white-space:nowrap;display:inline-flex;align-items:center;gap:3px}\n  .health-more{display:none;flex-wrap:wrap;gap:4px 12px;margin-top:6px;opacity:.6}\n  .health-more.open{display:flex}\n\n  .standup-bar{margin:8px 24px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12.5px}\n  .standup-chip{cursor:pointer;display:inline-flex;align-items:center;gap:4px;\n    border-radius:20px;padding:3px 10px;border:1px solid transparent;font-weight:500}\n  .standup-chip.st-done{color:var(--ok);background:rgba(54,179,126,.13);border-color:rgba(54,179,126,.42)}\n  .standup-chip.st-skipped{color:var(--warn);background:rgba(255,171,0,.15);border-color:rgba(255,171,0,.5)}\n  .standup-chip.st-pending{color:var(--subtle);background:var(--pill-bg)}\n  .standup-chip.st-current{color:var(--link);border:2px solid var(--link);\n    font-weight:600;background:rgba(0,82,204,.08)}\n  html[data-theme=\"dark\"] .standup-chip.st-current{background:rgba(87,157,255,.1)}\n  html[data-theme=\"dark\"] .standup-chip.st-done{background:rgba(75,206,151,.16);border-color:rgba(75,206,151,.4)}\n  html[data-theme=\"dark\"] .standup-chip.st-skipped{background:rgba(226,178,3,.17);border-color:rgba(226,178,3,.5)}\n  .standup-chip.viewing{outline:2px dashed var(--link);outline-offset:2px}\n  /* Keep the facilitator controls (checkboxes + Skip/Next/Exit) together as one\n     right-justified group. margin-left:auto pushes the whole group to the right\n     edge; if it can't fit beside the member chips it wraps to the next line as a\n     block (still right-justified) rather than scattering item by item. */\n  .standup-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;\n    justify-content:flex-end;margin-left:auto}\n  .scrum-timer{font-family:monospace;font-size:11px;margin-left:4px}\n  .scrum-timer.over-time{color:var(--risk)}\n  .standup-chip.st-current.over-time{border-color:var(--risk)}\n  #scrumNext{background:var(--ink);color:var(--card-bg);font-weight:600}\n  #scrumNext:hover{opacity:.85}\n  #exitScrum{color:var(--subtle)}\n</style>\n</head>\n<body>\n  <header class=\"board-head\">\n    <div class=\"title-row\">\n      <button id=\"refresh\" class=\"tool\" title=\"Refresh board\" aria-label=\"Refresh board\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n          <path d=\"M21 12a9 9 0 1 1-2.64-6.36\"/><path d=\"M21 3v6h-6\"/></svg>\n      </button>\n      <h1>Chabad.org / Sites / Communicator \u2014 Sprint Board</h1>\n      <span id=\"searchWrap\" class=\"search-wrap\">\n        <svg class=\"search-ico\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M21 21l-4.3-4.3\"/></svg>\n        <input type=\"search\" id=\"search\" placeholder=\"Search titles &amp; IDs\" aria-label=\"Search ticket titles and IDs\" autocomplete=\"off\">\n      </span>\n      <button id=\"theme\" class=\"tool\" title=\"Toggle night mode\" aria-label=\"Toggle night mode\">\ud83c\udf19</button>\n      <button id=\"dailyScrum\" class=\"tool\" title=\"Start daily scrum\">\u25b6 Daily Scrum</button>\n      <button id=\"customise\" class=\"tool\" aria-expanded=\"false\" title=\"Customise board\" aria-label=\"Customise board\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n          <circle cx=\"12\" cy=\"12\" r=\"3\"/>\n          <path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\"/></svg>\n      </button>\n    </div>\n    <div class=\"meta\" id=\"meta\"></div>\n  </header>\n\n  <section id=\"panel\" aria-label=\"Board customisation\"></section>\n  <section id=\"summary\" class=\"summary\" aria-label=\"Sprint risk summary\"></section>\n  <section id=\"devbar\" class=\"devbar\" aria-label=\"Developer filter\"></section>\n  <main class=\"board\" id=\"board\"></main>\n\n  <div id=\"overlay\" aria-hidden=\"true\">\n    <div class=\"xdialog\" id=\"xdialog\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Expanded ticket\"></div>\n  </div>\n\n<script>\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 CONFIG \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  // This board runs inside an iframe injected by the userscript. There is no\n  // server/proxy URL to fetch \u2014 the userscript's page context (which holds\n  // your real Jira session) does the actual Jira REST calls and hands the\n  // result to this iframe over postMessage. See refreshData below.\n  const BROWSE_BASE = parent.location.origin + \"/browse/\";\n  let LIVE = false;   // flips true once the first postMessage payload arrives\n\n  /* default left-to-right workflow order (replaced by the proxy's real columns when live) */\n  let COLUMNS = [\"Open\",\"In Progress\",\"Awaiting Documentation\",\"Ready for Testing\",\"Pending Code Review\",\n                 \"Awaiting Review Fixes\",\"Pending Code Review 1\",\"In Review 1\",\"Closed\"];\n\n  // The board's last configured column is treated as \"Done\" for metric purposes.\n  // This is deliberately based on column position (this board's own layout),\n  // not Jira's own status-category flag \u2014 a column like \"Done\" can contain\n  // statuses (e.g. \"Ready to deploy\") that Jira itself hasn't marked done,\n  // but that are visually finished work on THIS board.\n  function isDoneColumn(rec){\n    return COLUMNS.length>0 && rec && rec.column===COLUMNS[COLUMNS.length-1];\n  }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 RISK BANDS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  const REJ  = {warn:2,  risk:4};        // code-review rejections (count)\n  const COMP = {warn:0.7, risk:1.0};     // composite: 1.0 = \"at the risk line\"\n\n  // Composite settings (power p + per-metric weights) come from board.config.js\n  // via the live payload; this default is used in snapshot mode. p=1 \u2192 weighted\n  // average, higher p \u2192 the worst metric increasingly dominates.\n  let COMPOSITE = { p:2, weights:{} };\n\n  // riskCutoffs (idle / cycle / timeInColumn rule tables) come from\n  // board.config.js via the server/proxy payload on live refresh. In\n  // snapshot mode (no server) this stays null and every lookup falls\n  // through to the hardcoded floor below \u2014 never a null threshold.\n  let RISK_CUTOFFS = null;\n\n  const FIB_BUCKETS = [1,2,3,5,8,13,20];\n  function sizeBucket(points){\n    if(points==null) return \"none\";\n    for(const b of FIB_BUCKETS) if(points<=b) return b;\n    return FIB_BUCKETS[FIB_BUCKETS.length-1];   // overflow: clamp to the top bucket\n  }\n  // Absolute code-level floor. Guarantees a real {warn,risk} even if config\n  // is missing, malformed, or every matching rule still has null values.\n  const HARD_FALLBACK = { idle:{warn:24,risk:72}, cycle:{warn:160,risk:240}, timeInColumn:{warn:24,risk:56} };\n  function resolveCutoff(metric, column, points){\n    const rules = (RISK_CUTOFFS && RISK_CUTOFFS[metric]) || [];\n    const bucket = sizeBucket(points);\n    const specificity = r => (r.column!==undefined?1:0) + (r.size!==undefined?1:0);\n    const matches = r => (r.column===undefined || r.column===column) && (r.size===undefined || r.size===bucket);\n    // Most specific matching rule first (column+size beats column-only beats\n    // size-only beats neither), independent of how rules are ordered in\n    // config; a rule only counts if it actually has real warn/risk numbers.\n    const candidates = rules.filter(r=>!r.default && matches(r)).sort((a,b)=>specificity(b)-specificity(a));\n    for(const r of candidates){ if(r.warn!=null && r.risk!=null) return {warn:r.warn, risk:r.risk}; }\n    const def = rules.find(r=>r.default);\n    if(def && def.warn!=null && def.risk!=null) return {warn:def.warn, risk:def.risk};\n    return HARD_FALLBACK[metric] || {warn:24,risk:72};\n  }\n\n  const clamp=x=>Math.max(0,Math.min(1,x));\n  const tband=(v,t)=> v>=t.risk?'risk':v>=t.warn?'warn':'ok';\n  const round1=v=>Math.round(v*10)/10;\n  // A \"day\" here means one 8-hour WORK day (not a 24-hour calendar day) \u2014 matches\n  // the work-hours-only clock these metrics are already measured in.\n  const HOURS_PER_WORKDAY = 8;\n  function fmtWorkHM(h){ if(h==null)return null;\n    const minsPerDay = HOURS_PER_WORKDAY*60;\n    let mins=Math.round(h*60);\n    const D=Math.floor(mins/minsPerDay); mins-=D*minsPerDay;\n    const H=Math.floor(mins/60), M=mins%60;\n    if(D>0) return D+'d '+H+'h '+String(M).padStart(2,'0')+'m';\n    if(H>0) return H+'h '+String(M).padStart(2,'0')+'m';\n    return M+'m'; }\n  function fmtDate(iso){ if(!iso)return null;\n    return new Date(iso+'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}); }\n  const has=v=> v!=null && v!=='' && !(Array.isArray(v)&&v.length===0);\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 REGISTRY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n     One declarative entry per attribute/metric drives the panel, the card\n     zones, and the sort. Add a feature = add an entry. */\n  const INFO_ATTRS = [\n    {id:'points',       label:'Points',        get:r=>r.points,              format:v=>String(round1(v))},\n    {id:'implementor',  label:'Developer',   get:r=>r.implementor,         format:v=>`${avatar(v)}<span class=\"withav\">${esc(v)}</span>`, own:true, html:true},\n    {id:'codeReviewer', label:'Reviewer 1', get:r=>r.codeReviewer,        format:v=>`${avatar(v)}<span class=\"withav\">${esc(v)}</span>`, own:true, html:true},\n    {id:'retroPoints',  label:'Retro points',  get:r=>r.retrospectivePoints, format:v=>String(v)},\n    {id:'parent',       label:'Parent',        get:r=>r.parentKey,           format:v=>v, own:true},\n  ];\n  const INFO_DEFAULT = ['points','implementor','codeReviewer','retroPoints'];\n\n  /* Health metrics. score()\u21920..1 risk (null = no data, excluded from composite).\n     sortVal()\u2192magnitude for sorting. band()\u2192colour tier. */\n  const HEALTH = {\n    rejections:{ label:'Rejections',\n      get:r=>r.rejections||0, pending:()=>false,\n      sortVal:v=>v, score:v=> v/REJ.risk,\n      band:v=> v>0?tband(v,REJ):'ok', format:v=>String(v) },\n    blocked:{ label:'Blocked',\n      get:r=>!!r.blocked, pending:()=>false,\n      sortVal:v=>v?1:0, score:v=>v?1:0, band:v=>v?'risk':'ok', format:v=>v?'Yes':'No' },\n    idle:{ label:'Last movement',\n      get:r=>r.idleHours,\n      pending:(v,r)=> isDoneColumn(r) || (r&&r.started===false) || v==null,\n      sortVal:(v,r)=> (isDoneColumn(r)||(r&&r.started===false))?-1:(v==null?-1:v),\n      score:(v,r)=>{ if(isDoneColumn(r)||(r&&r.started===false)||v==null)return null; const c=resolveCutoff('idle',r.column,r.points); return v/c.risk; },\n      band:(v,r)=>{ if(isDoneColumn(r)||(r&&r.started===false)||v==null)return 'none'; const c=resolveCutoff('idle',r.column,r.points); return tband(v,c); },\n      format:(v,r)=> (r&&r.started===false)?'not started':(v==null?'\u2014':fmtWorkHM(v)) },\n    timeInColumn:{ label:'In column',\n      get:r=>r.timeInColumnHours,\n      pending:(v,r)=> isDoneColumn(r) || (r&&r.started===false) || v==null,\n      sortVal:(v,r)=> (isDoneColumn(r)||(r&&r.started===false))?-1:(v==null?-1:v),\n      score:(v,r)=>{ if(isDoneColumn(r)||(r&&r.started===false)||v==null)return null; const c=resolveCutoff('timeInColumn',r.column,r.points); return v/c.risk; },\n      band:(v,r)=>{ if(isDoneColumn(r)||(r&&r.started===false)||v==null)return 'none'; const c=resolveCutoff('timeInColumn',r.column,r.points); return tband(v,c); },\n      format:(v,r)=> (r&&r.started===false)?'not started':(v==null?'\u2014':fmtWorkHM(v)) },\n    cycle:{ label:'Cycle',\n      get:r=>r.cycleHours,\n      pending:(v,r)=> (r&&r.started===false) || v==null,\n      sortVal:(v,r)=> (r&&r.started===false)?-1:(v==null?-1:v),\n      score:(v,r)=>{ if((r&&r.started===false)||v==null)return null; const c=resolveCutoff('cycle',r.column,r.points); return v/c.risk; },\n      band:(v,r)=>{ if((r&&r.started===false)||v==null)return 'none'; const c=resolveCutoff('cycle',r.column,r.points); return tband(v,c); },\n      format:(v,r)=> (r&&r.started===false)?'not started':(v==null?'\u2014':fmtWorkHM(v)) },\n    composite:{ label:'Score', isComposite:true,\n      pending:()=>false, sortVal:s=>s==null?-1:s*100,\n      band:s=>s==null?'none':tband(s,COMP),\n      format:s=>s==null?'\u2014':String(Math.round(s*100)) },\n  };\n  const HEALTH_DEFAULT_ORDER = ['composite','blocked','idle','timeInColumn','cycle','rejections'];\n  const HEALTH_DEFAULT_ON    = ['rejections','blocked','idle','timeInColumn','cycle','composite'];\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 STATE (persisted in the URL) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  let state = { info:new Set(INFO_DEFAULT),\n                order:HEALTH_DEFAULT_ORDER.slice(),\n                on:new Set(HEALTH_DEFAULT_ON),\n                filterTier:null,\n                filterDevs:new Set(), // developer filter: selected names (multi-select, OR)\n                filterUnassigned:false, // \"Show unassigned tickets\" (ORs with filterDevs)\n                search:'',            // text search over ticket titles and IDs\n                card:null,            // expanded ticket key (modal open when set)\n                ctab:'cols',          // active tab in the expanded view: 'cols' | 'flow'\n                theme:'light',        // 'light' | 'dark' (night mode)\n                mode:'dev',           // 'dev' | 'pm' \u2014 Dev mode hides health settings & the risk summary\n                scrum:false };        // daily scrum mode on/off\n\n  /* Per-mode selections. Dev and PM each keep their OWN card-detail, health\n     metric on/off, health order and tier filter, so tuning one mode never\n     changes what you see in the other. state.{info,order,on,filterTier} always\n     mirror the ACTIVE mode; modeSel holds the other mode's snapshot. */\n  const MODE_SEL_KEYS = ['info','order','on','filterTier'];\n  const modeSel = {\n    dev: { info:new Set(INFO_DEFAULT), order:HEALTH_DEFAULT_ORDER.slice(), on:new Set(HEALTH_DEFAULT_ON), filterTier:null },\n    pm:  { info:new Set(INFO_DEFAULT), order:HEALTH_DEFAULT_ORDER.slice(), on:new Set(HEALTH_DEFAULT_ON), filterTier:null },\n  };\n  function captureModeSel(m){ const d={}; MODE_SEL_KEYS.forEach(k=>{ const v=state[k]; d[k]=(v instanceof Set)?new Set(v):(Array.isArray(v)?v.slice():v); }); modeSel[m]=d; }\n  function applyModeSel(m){ const d=modeSel[m]; MODE_SEL_KEYS.forEach(k=>{ const v=d[k]; state[k]=(v instanceof Set)?new Set(v):(Array.isArray(v)?v.slice():v); }); }\n\n  /* In-memory scrum session (not URL-persisted \u2014 it's a live ceremony) */\n  let scrumSession = null;\n\n  /* Which cards have their \"N healthy\" section expanded, keyed by ticket. Kept\n     across renders so a silent auto-refresh repaint (fires on every click + every\n     2 min) doesn't snap the dropdown shut mid-read. render() rebuilds the cards\n     from scratch and zoneHealth re-applies .open from this set. */\n  const healthOpen = new Set();\n\n  // Durable preferences (Customise panel choices, night mode, dev/pm view)\n  // are saved by the userscript's host page across reloads \u2014 see the\n  // __RB_SAVED_PREFS__ bootstrap script the host injects right after <body>.\n  // Session/view-specific bits (filters, search, open card, scrum) stay\n  // URL-only, same as before, since they don't make sense to \"remember\".\n  (function applySavedPrefs(){\n    const saved = (typeof window.__RB_SAVED_PREFS__ !== 'undefined') ? window.__RB_SAVED_PREFS__ : null;\n    if(!saved) return;\n    if(saved.theme==='dark'||saved.theme==='light') state.theme=saved.theme;\n    if(saved.mode==='dev'||saved.mode==='pm') state.mode=saved.mode;\n    // Per-mode selections. New shape: saved.modeSel = {dev:{...}, pm:{...}}.\n    // Old shape (single shared info/order/on) is read into BOTH modes so a\n    // previously-saved view isn't lost on upgrade.\n    const loadInto=(slot,src)=>{\n      if(!src) return;\n      if(Array.isArray(src.info)) slot.info=new Set(src.info.filter(x=>INFO_ATTRS.some(a=>a.id===x)));\n      if(Array.isArray(src.order)){ const ord=src.order.filter(x=>HEALTH[x]); HEALTH_DEFAULT_ORDER.forEach(id=>{ if(!ord.includes(id)) ord.push(id); }); slot.order=ord; }\n      if(Array.isArray(src.on)) slot.on=new Set(src.on.filter(x=>HEALTH[x]));\n    };\n    if(saved.modeSel && (saved.modeSel.dev || saved.modeSel.pm)){\n      loadInto(modeSel.dev, saved.modeSel.dev);\n      loadInto(modeSel.pm,  saved.modeSel.pm);\n    } else {\n      loadInto(modeSel.dev, saved);\n      loadInto(modeSel.pm,  saved);\n    }\n    applyModeSel(state.mode);   // active view mirrors the current mode\n  })();\n  function saveDurablePrefs(){\n    try{\n      captureModeSel(state.mode);   // fold the live view back into its mode slot\n      const dump=m=>({ info:[...modeSel[m].info], order:modeSel[m].order.slice(), on:[...modeSel[m].on] });\n      parent.postMessage({source:'risk-board', type:'rb-prefs', prefs:{\n        modeSel:{ dev:dump('dev'), pm:dump('pm') },\n        theme:state.theme, mode:state.mode\n      }}, '*');\n    }catch(e){ /* no-op outside the userscript's iframe */ }\n  }\n\n  function readState(){\n    try{\n      const q=new URLSearchParams(location.search);\n      // Per-mode selections. Dev uses the legacy unsuffixed keys (so old shared\n      // URLs still open as before); PM uses *_pm keys. If a mode's keys are\n      // absent, that mode keeps its defaults \u2014 and PM, on a legacy URL with only\n      // unsuffixed keys, inherits them once so a shared PM view isn't lost.\n      const loadSel=(m,suf,inherit)=>{\n        const d=modeSel[m];\n        const gi=k=>q.has(k+suf)?q.get(k+suf):(inherit&&q.has(k)?q.get(k):null);\n        const info=gi('info'); if(info!=null) d.info=new Set(info.split(',').filter(Boolean));\n        const ho=gi('horder'); if(ho!=null){ const ord=ho.split(',').filter(x=>HEALTH[x]); HEALTH_DEFAULT_ORDER.forEach(id=>{ if(!ord.includes(id)) ord.push(id); }); d.order=ord; }\n        const hon=gi('hon'); if(hon!=null) d.on=new Set(hon.split(',').filter(x=>HEALTH[x]));\n        const tier=gi('tier'); if(tier!=null) d.filterTier=tier||null;\n      };\n      loadSel('dev','',false);\n      loadSel('pm','_pm',true);\n      if(q.has('mode')) state.mode=(q.get('mode')==='pm')?'pm':'dev';\n      applyModeSel(state.mode);   // active view mirrors the current mode\n      if(q.has('devs')) state.filterDevs=decodeDevs(q.get('devs'));\n      if(q.has('unassigned')) state.filterUnassigned=q.get('unassigned')==='1';\n      if(q.has('q')) state.search=q.get('q')||'';\n      if(q.has('card')) state.card=q.get('card')||null;\n      if(q.has('ctab')) state.ctab=(q.get('ctab')==='flow')?'flow':'cols';\n      if(q.has('theme')) state.theme=(q.get('theme')==='dark')?'dark':'light';\n      if(q.has('scrum')) state.scrum=q.get('scrum')==='1';\n    }catch(e){ /* opaque-origin frame: fall back to defaults */ }\n  }\n  function writeState(){\n    // Persist to the URL for shareable views. Sandboxed previews have an opaque\n    // origin where replaceState throws \u2014 swallow it so toggles still re-render.\n    try{\n      const q=new URLSearchParams(location.search);\n      captureModeSel(state.mode);   // fold the live view back into its mode slot\n      const writeSel=(m,suf)=>{\n        const d=modeSel[m];\n        q.set('info'+suf,[...d.info].join(','));\n        q.set('horder'+suf,d.order.join(','));\n        q.set('hon'+suf,[...d.on].join(','));\n        if(d.filterTier) q.set('tier'+suf,d.filterTier); else q.delete('tier'+suf);\n      };\n      writeSel('dev','');\n      writeSel('pm','_pm');\n      if(state.filterDevs.size) q.set('devs',encodeDevs(state.filterDevs)); else q.delete('devs');\n      if(state.filterUnassigned) q.set('unassigned','1'); else q.delete('unassigned');\n      if(state.search.trim()) q.set('q',state.search); else q.delete('q');\n      if(state.card){ q.set('card',state.card); q.set('ctab',state.ctab); }\n      else { q.delete('card'); q.delete('ctab'); }\n      if(state.theme==='dark') q.set('theme','dark'); else q.delete('theme');\n      if(state.mode==='pm') q.set('mode','pm'); else q.delete('mode');\n      if(state.scrum) q.set('scrum','1'); else q.delete('scrum');\n      history.replaceState(null,'', location.pathname+'?'+q.toString());\n    }catch(e){ /* no-op: URL persistence unavailable in this context */ }\n    saveDurablePrefs();\n  }\n\n  /* composite = weighted power mean of the OTHER enabled metrics' scores.\n     Each score is value/risk (1.0 = at the risk line), so size/column\n     sensitivity is already baked in. p and weights come from config. */\n  function compositeScore(rec){\n    if(isDoneColumn(rec)) return null;   // Done work is never scored \u2014 keeps focus on in-flight tickets\n    const cfg = COMPOSITE || {};\n    const p = (cfg.p && cfg.p > 0) ? cfg.p : 1;\n    const weights = cfg.weights || {};\n    let wsum=0, acc=0, any=false;\n    state.order.forEach(id=>{\n      if(id==='composite' || !state.on.has(id)) return;\n      const m=HEALTH[id]; const s=m.score(m.get(rec),rec);\n      if(s==null) return;\n      const w = weights[id]!=null ? weights[id] : 1;\n      if(w<=0) return;\n      any=true; wsum+=w; acc += w * Math.pow(Math.max(0,s), p);\n    });\n    if(!any || wsum===0) return null;\n    return Math.pow(acc/wsum, 1/p);\n  }\n  function metricValue(id,rec){               // \u2192 {raw, band, text, pending, sortVal, score}\n    const m=HEALTH[id];\n    if(m.isComposite){ const s=compositeScore(rec);\n      return {band:m.band(s),text:m.format(s),pending:false,sortVal:m.sortVal(s),score:s}; }\n    const raw=m.get(rec);\n    // Done-column cards never register a risk/warn band on ANY metric \u2014 a\n    // ticket is finished, so it's excluded from scoring, sorting weight, tier\n    // classification, and driver counts, though its raw value still displays\n    // (same \"keep showing, stop flagging\" treatment Idle/In-column already get).\n    if(isDoneColumn(rec)) return {band:'none', text:m.format(raw,rec), pending:true, sortVal:-1, score:null};\n    return {band:m.band(raw,rec),text:m.format(raw,rec),pending:m.pending(raw,rec),\n            sortVal:m.sortVal(raw,rec),score:m.score?m.score(raw,rec):null};\n  }\n  function sortMetricId(){ return state.order.find(id=>state.on.has(id)) || null; }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 DATA \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  // Fallback avatar-URL lookup \u2014 not needed for live data (each issue's real\n  // avatarUrl comes straight from the Jira API), kept empty here.\n  const AVATAR_URLS = {};\n  const TYPE_STYLE={\n    \"Story\":{bg:\"#65ba43\",g:\"bookmark\"},\"Task\":{bg:\"#4bade8\",g:\"check\"},\"Bug\":{bg:\"#e5493a\",g:\"dot\"},\n    \"Sub-task\":{bg:\"#4bade8\",g:\"subtask\"},\"New Feature\":{bg:\"#2684ff\",g:\"plus\"},\"Improvement\":{bg:\"#65ba43\",g:\"up\"}\n  };\n  let ISSUES = [];   // populated live via the host postMessage bridge\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 RENDER HELPERS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  const esc=s=>String(s).replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\").replace(/\"/g,\"&quot;\");\n  function typeIcon(t){\n    const s=TYPE_STYLE[t]||{bg:\"#8993a4\",g:\"dot\"};\n    const g={bookmark:'<path d=\"M5 3h6v9l-3-2-3 2z\" fill=\"#fff\"/>',\n      check:'<path d=\"M4.5 8.2l2 2 4-4.4\" stroke=\"#fff\" stroke-width=\"1.6\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',\n      dot:'<circle cx=\"8\" cy=\"8\" r=\"3\" fill=\"#fff\"/>',\n      subtask:'<rect x=\"4\" y=\"4\" width=\"5\" height=\"5\" fill=\"#fff\"/><rect x=\"8\" y=\"8\" width=\"4\" height=\"4\" fill=\"#fff\" opacity=\".8\"/>',\n      plus:'<path d=\"M8 4.5v7M4.5 8h7\" stroke=\"#fff\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>',\n      up:'<path d=\"M8 11.5V5M5 7.5L8 4.5l3 3\" stroke=\"#fff\" stroke-width=\"1.5\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>'}[s.g];\n    return `<svg class=\"type-ico\" viewBox=\"0 0 16 16\" style=\"background:${s.bg}\" title=\"${esc(t)}\">${g}</svg>`;\n  }\n  const PALETTE=[\"#0052cc\",\"#00857a\",\"#5243aa\",\"#bf2600\",\"#974f0c\",\"#206b3b\",\"#cf4499\"];\n  function colorFor(n){let h=0;for(let i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))>>>0;return PALETTE[h%PALETTE.length];}\n  function initials(n){const p=n.trim().split(/\\s+/);return((p[0]?.[0]||\"\")+(p[1]?.[0]||\"\")).toUpperCase();}\n  function avatar(n){\n    if(!n) return `<span class=\"avatar initials\" style=\"background:var(--none)\" title=\"Unassigned\">\u2013</span>`;\n    const ini=`<span class=\"avatar initials\" style=\"background:${colorFor(n)}\" title=\"${esc(n)}\">${esc(initials(n))}</span>`;\n    const url=AVATAR_URLS[n]; if(!url) return ini;\n    // The onerror fallback lives inside a double-quoted attribute, so any double\n    // quotes in the fallback HTML (e.g. the title=\"\") must be entity-encoded or\n    // they close the attribute early and leak the tail (`\">`) as visible text.\n    const iniAttr=ini.replace(/'/g,\"\\\\'\").replace(/\"/g,'&quot;');\n    return `<img class=\"avatar\" src=\"${url}\" alt=\"${esc(n)}\" title=\"${esc(n)}\" referrerpolicy=\"no-referrer\" onerror=\"this.outerHTML='${iniAttr}'\">`;\n  }\n\n  function zoneInfo(rec){\n    const inline=[], own=[];\n    INFO_ATTRS.forEach(a=>{ if(!state.info.has(a.id))return;\n      const v=a.get(rec); if(!has(v))return;\n      const ownHtml=`<span class=\"k klead\">${esc(a.label)}:</span> ${a.html?a.format(v,rec):esc(a.format(v,rec))}`;\n      const html=`<span class=\"k\">${esc(a.label)}:</span> ${a.html?a.format(v,rec):esc(a.format(v,rec))}`;\n      if(a.own) own.push(`<div class=\"pairline\">${ownHtml}</div>`);\n      else inline.push(`<span class=\"pair\">${html}</span>`); });\n    // PR count \u2014 always pinned as the LAST line of the card's details (0 when the\n    // ticket has none yet). Omitted only when PR data isn't present at all\n    // (dev-status enrichment off / frozen snapshot), same rule as the modal.\n    const prLine = rec.prs!==undefined\n      ? `<div class=\"pairline\"><span class=\"k klead\">PRs:</span> ${rec.prs.length}</div>`\n      : '';\n    if(!inline.length && !own.length && !prLine) return '';\n    let body='';\n    if(inline.length) body+=`<div class=\"pairline\">${inline.join('<span class=\"k\"> \u00b7 </span>')}</div>`;\n    body+=own.join('');\n    body+=prLine;\n    return `<div class=\"zone zone-info\">${body}</div>`;\n  }\n  function zoneHealth(rec){\n    let enabled=state.order.filter(id=>state.on.has(id));\n    // Dev mode still SORTS by Score (see sortMetricId), but the Score itself is\n    // hidden from the card's health chips. Every OTHER metric shows \u2014 they all\n    // matter for judging a ticket's risk.\n    if(state.mode==='dev') enabled=enabled.filter(id=>id!=='composite');\n    if(!enabled.length) return '';\n\n    function chipHtml(id){\n      const m=HEALTH[id]; const mv=metricValue(id,rec);\n      const cls=mv.pending?'metric pending':'metric';\n      const tip = id==='blocked' && rec.blockedByOpen && rec.blockedByOpen.length\n        ? ` title=\"blocked by ${esc(rec.blockedByOpen.join(', '))}\"` : '';\n      return `<span class=\"${cls}\"${tip}><span class=\"dot ${mv.band}\"></span>`\n           + `<span class=\"ml\">${esc(m.label)}</span> <span class=\"mv\">${esc(mv.text)}</span></span>`;\n    }\n\n    if(state.scrum || state.mode==='dev'){\n      const firing=[], healthy=[];\n      enabled.forEach(id=>{\n        const mv=metricValue(id,rec);\n        if(mv.band==='risk'||mv.band==='warn') firing.push(chipHtml(id));\n        else healthy.push(chipHtml(id));\n      });\n      let html='<div class=\"zone zone-health\">';\n      if(firing.length) html+=`<div style=\"display:flex;flex-wrap:wrap;gap:4px 12px\">${firing.join('')}</div>`;\n      if(healthy.length){\n        const isOpen=healthOpen.has(rec.key);\n        html+=`<div class=\"health-divider\" data-key=\"${esc(rec.key)}\" onclick=\"event.stopPropagation();toggleHealthMore(this)\">`;\n        html+=`<hr><span class=\"health-divider-label\"><span class=\"hd-chev\">${isOpen?'\u25be':'\u25b8'}</span> ${healthy.length} healthy</span><hr>`;\n        html+=`</div>`;\n        html+=`<div class=\"health-more${isOpen?' open':''}\">${healthy.join('')}</div>`;\n      }\n      html+='</div>';\n      return html;\n    }\n\n    const chips=enabled.map(id=>chipHtml(id)).join('');\n    return `<div class=\"zone zone-health\">${chips}</div>`;\n  }\n  /* Toggle a card's collapsible \"N healthy\" section AND remember the choice in\n     healthOpen, so the next render() (e.g. a silent auto-refresh) restores it\n     instead of collapsing it. Referenced from the divider's inline onclick. */\n  function toggleHealthMore(divider){\n    const key=divider.getAttribute('data-key');\n    const more=divider.nextElementSibling;\n    if(!more) return;\n    const open=more.classList.toggle('open');\n    const chev=divider.querySelector('.hd-chev'); if(chev) chev.textContent=open?'\u25be':'\u25b8';\n    if(open) healthOpen.add(key); else healthOpen.delete(key);\n  }\n  function sortBorderColor(rec){\n    const id=sortMetricId(); if(!id) return 'transparent';\n    const b=metricValue(id,rec).band;          // outline reflects the SORTED metric only\n    return b==='risk'?'var(--risk)':b==='warn'?'var(--warn)':'transparent';\n  }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 DEVELOPER FILTER \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n     Pure, DOM-free logic (unit-tested in test-dev-filter.js via the markers).\n     A \"developer\" (for the chip roster) is anyone appearing as assignee,\n     implementor, or code reviewer on any ticket currently on the board \u2014 so\n     everyone involved is selectable. But SELECTING a developer shows only their\n     OWN work: tickets they're the assignee or the Developer (implementor) on.\n     Review duties (Reviewer 1 / code reviewer) are intentionally NOT matched \u2014\n     same rule as daily-scrum go-around. Selections are a multi-select combined\n     with OR. The \"Show unassigned\" option ORs in tickets whose assignee is empty.\n     With nothing selected the filter is off. */\n  //DEV_FILTER_START\n  const DEV_ROLES=['assignee','implementor','codeReviewer'];   // roster/chip list: everyone involved\n  const DEV_FILTER_ROLES=['assignee','implementor'];           // match: own work only, not review duties\n  function collectDevelopers(issues){\n    const s=new Set();\n    (issues||[]).forEach(r=>DEV_ROLES.forEach(k=>{ const v=r&&r[k]; if(v) s.add(v); }));\n    return [...s].sort((a,b)=>a.localeCompare(b));\n  }\n  function devFilterActive(devSet,showUnassigned){\n    return !!showUnassigned || !!(devSet && devSet.size>0);\n  }\n  function devFilterMatches(rec,devSet,showUnassigned){\n    if(!devFilterActive(devSet,showUnassigned)) return true;          // filter off \u2192 everything shows\n    if(showUnassigned && !(rec&&rec.assignee)) return true;           // OR: unassigned tickets\n    if(devSet) for(const d of devSet){                                // OR across selected developers,\n      if(rec&&DEV_FILTER_ROLES.some(k=>rec[k]===d)) return true;      // assignee OR Developer only (not Reviewer 1)\n    }\n    return false;\n  }\n  function encodeDevs(devSet){ return [...devSet].map(encodeURIComponent).join(','); }\n  function decodeDevs(s){ return new Set(String(s||'').split(',').filter(Boolean).map(decodeURIComponent)); }\n  //DEV_FILTER_END\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 SCRUM ENGINE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n     Pure, DOM-free logic (unit-tested in test-scrum.js via the markers).\n     Drives the daily-scrum go-around-the-circle ceremony. */\n  //SCRUM_ENGINE_START\n  function scrumShuffle(names){\n    const a=names.slice();\n    for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]; }\n    return a;\n  }\n  function scrumAdvance(order,current,done,skipped,action){\n    if(action==='next'){\n      if(current){ done.add(current); skipped.delete(current); }\n    } else if(action==='skip'){\n      if(current){ skipped.add(current); }\n    } else if(action && action.jump){\n      if(done.has(action.jump)) return {current:current};   // already done \u2192 no-op\n      return {current:action.jump};\n    }\n    // find next: scan order from after current, wrapping, first not-done\n    const ci=current?order.indexOf(current):-1;\n    for(let k=1;k<=order.length;k++){\n      const name=order[(ci+k)%order.length];\n      if(!done.has(name)) return {current:name};\n    }\n    return {current:null};   // everyone done\n  }\n  function scrumMemberStatus(name,current,done,skipped){\n    if(name===current) return 'current';\n    if(done.has(name)) return 'done';\n    if(skipped.has(name)) return 'skipped';\n    return 'pending';\n  }\n  /* \"Hide old work\" filter. In scrum mode the sharer only wants the Done-column\n     tickets THEY moved recently \u2014 not the whole team's finished backlog. A ticket\n     counts as \"theirs, recently\" when the focused member appears in the ticket's\n     rec.recentUpdaters \u2014 the display names the server derived from the Jira\n     changelog for changes made in the last 24h (see mapIssue). Pure/testable:\n     `isDone` and `hideOld` are passed in so COLUMNS/DOM stay out of here. */\n  function scrumRecentlyUpdatedBy(rec,name){\n    const u=rec&&rec.recentUpdaters;\n    return Array.isArray(u)&&u.indexOf(name)!==-1;\n  }\n  function scrumHideOldWork(rec,member,isDone,hideOld){\n    if(!hideOld||!isDone) return false;          // filter off, or not Done \u2192 never hidden\n    return !scrumRecentlyUpdatedBy(rec,member);  // Done + not touched by this member in 24h \u2192 hide\n  }\n  /* Scrum go-around filter. Unlike the board's developer filter (which ORs across\n     assignee / implementor / codeReviewer), the standup surfaces only the sharer's\n     OWN work: tickets they're assigned or are the Developer (implementor) on. Review\n     duties (Reviewer 1 / codeReviewer) are intentionally excluded \u2014 you report on\n     what you're driving, not what you're reviewing. `showUnassigned` ORs in tickets\n     with no sprint assignee (the follow-up candidates). */\n  const SCRUM_DEV_ROLES=['assignee','implementor'];\n  function scrumDevFilterMatches(rec,name,showUnassigned){\n    if(showUnassigned && !(rec&&rec.assignee)) return true;    // OR: unassigned tickets\n    return !!(rec && SCRUM_DEV_ROLES.some(k=>rec[k]===name));   // assignee OR Developer only\n  }\n  //SCRUM_ENGINE_END\n\n  function devFilterOn(){ return devFilterActive(state.filterDevs,state.filterUnassigned); }\n  function searchOn(){ return !!state.search.trim(); }\n  function searchMatches(rec){\n    const q=state.search.trim().toLowerCase();\n    if(!q) return true;\n    return (rec.summary||'').toLowerCase().includes(q)   // ticket title\n        || (rec.key||'').toLowerCase().includes(q);      // ticket ID\n  }\n  function devVisibleIssues(){ return ISSUES.filter(r=>devFilterMatches(r,state.filterDevs,state.filterUnassigned)); }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 RISK SUMMARY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  // A card's overall tier = worst band across its enabled, non-pending metrics.\n  const RANK={ok:1,warn:2,risk:3};\n  function cardTier(rec){\n    let worst=null;\n    state.order.forEach(id=>{\n      if(!state.on.has(id)) return;\n      const mv=metricValue(id,rec);\n      if(mv.pending || mv.band==='none') return;\n      if(worst===null || RANK[mv.band]>RANK[worst]) worst=mv.band;\n    });\n    return worst; // null | 'ok' | 'warn' | 'risk'\n  }\n  function tierCounts(){\n    const c={risk:0,warn:0,ok:0,nodata:0};\n    devVisibleIssues().forEach(r=>{ const t=cardTier(r); if(t===null) c.nodata++; else c[t]++; });\n    return c;\n  }\n  function drivers(){   // enabled metrics currently firing at risk level, with counts\n    const vis=devVisibleIssues();\n    return state.order.filter(id=>state.on.has(id)).map(id=>{\n      let n=0; vis.forEach(r=>{ const mv=metricValue(id,r); if(!mv.pending && mv.band==='risk') n++; });\n      return {id, label:HEALTH[id].label, n};\n    }).filter(d=>d.n>0);\n  }\n  function buildSummary(){\n    const el=document.getElementById('summary');\n    if(state.mode==='dev'){ el.innerHTML=''; return; }   // Dev mode hides the risk/warn/healthy tiers + Drivers\n    if(!state.order.some(id=>state.on.has(id))){\n      el.innerHTML=`<span class=\"sum-empty\">Enable a health metric to see sprint risk.</span>`; return;\n    }\n    const c=tierCounts();\n    const chip=(tier,label)=>`<button class=\"chip ${state.filterTier===tier?'active':''}\" data-tier=\"${tier}\">`\n      +`<span class=\"dot ${tier}\"></span>${c[tier]} ${label}</button>`;\n    const nodata = c.nodata?`<span class=\"chip nodata\"><span class=\"dot none\"></span>${c.nodata} no data</span>`:'';\n    const clear = state.filterTier?`<button class=\"chip clear\" data-tier=\"\">Clear filter \u2715</button>`:'';\n    const drv=drivers();\n    const drvHtml = drv.length\n      ? `<span class=\"drv-label\">Drivers:</span> `+drv.map(d=>`<button class=\"drv\" data-drv=\"${d.id}\">${esc(d.label)} <b>${d.n}</b></button>`).join('<span class=\"sep\">\u00b7</span>')\n      : `<span class=\"drv-label\">No risk-level signals firing.</span>`;\n    el.innerHTML=`<div class=\"sum-tiers\">${chip('risk','at risk')}${chip('warn','warning')}${chip('ok','healthy')}${nodata}${clear}</div><div class=\"sum-drv\">${drvHtml}</div>`;\n    el.querySelectorAll('[data-tier]').forEach(b=>b.onclick=()=>{\n      const t=b.getAttribute('data-tier');\n      state.filterTier = (t==='') ? null : (state.filterTier===t?null:t);\n      writeState(); render();\n    });\n    el.querySelectorAll('[data-drv]').forEach(b=>b.onclick=()=>{\n      const id=b.getAttribute('data-drv');\n      state.order=[id, ...state.order.filter(x=>x!==id)]; state.on.add(id);   // pivot sort to this metric\n      writeState(); buildPanel(); render();\n    });\n  }\n\n  /* Developer filter bar: one chip per developer with a ticket on the board\n     (any role), plus \"Unassigned\" and a Clear chip. Chips toggle \u2014 clicking\n     several selects several (OR). Selected names missing from the current\n     data (e.g. after a refresh, or via a shared link) still get a chip so\n     they stay deselectable. */\n  function buildDevBar(){\n    const el=document.getElementById('devbar'); if(!el) return;\n    if(!ISSUES.length && !devFilterOn()){ el.innerHTML=''; return; }\n    const devs=collectDevelopers(ISSUES);\n    state.filterDevs.forEach(d=>{ if(!devs.includes(d)) devs.push(d); });\n    devs.sort((a,b)=>a.localeCompare(b));\n    const chips=devs.map(d=>{\n      const on=state.filterDevs.has(d);\n      return `<button class=\"chip dev ${on?'active':''}\" data-dev=\"${esc(d)}\" aria-pressed=\"${on}\"`\n        +` title=\"Show tickets where ${esc(d)} is the assignee, implementor, or code reviewer\">`\n        +`${esc(d)}</button>`;\n    }).join('');\n    const un=`<button class=\"chip ${state.filterUnassigned?'active':''}\" id=\"devUnassigned\" aria-pressed=\"${state.filterUnassigned}\"`\n      +` title=\"Also show tickets with no assignee\">Unassigned</button>`;\n    const clear=devFilterOn()?`<button class=\"chip clear\" id=\"devClear\">Clear \u2715</button>`:'';\n    el.innerHTML=`<span class=\"bar-label\">Developers:</span>${chips}${un}${clear}`;\n    el.querySelectorAll('[data-dev]').forEach(b=>b.onclick=()=>{\n      const d=b.getAttribute('data-dev');\n      if(state.filterDevs.has(d)) state.filterDevs.delete(d); else state.filterDevs.add(d);\n      writeState(); render();\n    });\n    const ub=el.querySelector('#devUnassigned');\n    if(ub) ub.onclick=()=>{ state.filterUnassigned=!state.filterUnassigned; writeState(); render(); };\n    const cb=el.querySelector('#devClear');\n    if(cb) cb.onclick=()=>{ state.filterDevs.clear(); state.filterUnassigned=false; writeState(); render(); };\n  }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 DAILY SCRUM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  /* The per-dev standup timer counts DOWN from 1:00. Once it reaches zero it\n     flips to a red, negative \"over\" count so the facilitator can see how far\n     past their minute a dev has gone. */\n  function scrumTimerText(elapsed){\n    const remaining=60-elapsed;                 // seconds left (goes negative once over)\n    const over=remaining<=0;\n    const abs=Math.abs(remaining);\n    const sign=remaining<0?'-':'';\n    return {text:sign+Math.floor(abs/60)+':'+String(abs%60).padStart(2,'0'), over};\n  }\n  function buildStandupBar(){\n    const el=document.getElementById('devbar'); if(!el) return;\n    if(!scrumSession){ el.innerHTML=''; return; }\n    const svgCheck='<svg style=\"width:13px;height:13px;vertical-align:-1px\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"/></svg>';\n    const svgClock='<svg style=\"width:13px;height:13px;vertical-align:-1px\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/></svg>';\n    const chips=scrumSession.order.map(name=>{\n      const st=scrumMemberStatus(name,scrumSession.current,scrumSession.done,scrumSession.skipped);\n      let timerHtml='';\n      if(st==='current'&&scrumSession.timerStart){\n        const elapsed=Math.floor((Date.now()-scrumSession.timerStart)/1000);\n        const t=scrumTimerText(elapsed);\n        timerHtml=`<span class=\"scrum-timer${t.over?' over-time':''}\">${t.text}</span>`;\n      }\n      const prefix=st==='done'?svgCheck+' ':st==='skipped'?svgClock+' ':'';\n      const overClass=st==='current'&&scrumSession.timerStart&&(Date.now()-scrumSession.timerStart>=60000)?' over-time':'';\n      const viewingClass=scrumSession.viewing===name?' viewing':'';\n      return `<span class=\"standup-chip st-${st}${overClass}${viewingClass}\" data-scrum-member=\"${esc(name)}\">`\n        +`${prefix}${esc(name)}${timerHtml}</span>`;\n    }).join('');\n    const allDone=!scrumSession.current;\n    const unChk=scrumSession.includeUnassigned?'checked':'';\n    const hoChk=scrumSession.hideOld?'checked':'';\n    const endHtml=allDone\n      ?`<span class=\"chip\" style=\"color:var(--ok);font-weight:600\">\u2713 Standup complete</span>`\n      :`<button class=\"chip\" id=\"scrumSkip\">Skip</button>`\n       +`<button class=\"chip\" id=\"scrumNext\">Next \u2192</button>`;\n    el.innerHTML=`<span class=\"bar-label\">Standup</span>${chips}`\n      +`<div class=\"standup-controls\">`\n      +`<label class=\"chip\" style=\"gap:5px;cursor:pointer\" title=\"Hide Done tickets you didn't update in the last 24h\">`\n      +`<input type=\"checkbox\" id=\"scrumHideOld\" ${hoChk} style=\"width:14px;height:14px;accent-color:var(--link)\"> Hide old work</label>`\n      +`<label class=\"chip\" style=\"gap:5px;cursor:pointer\">`\n      +`<input type=\"checkbox\" id=\"scrumUnassigned\" ${unChk} style=\"width:14px;height:14px;accent-color:var(--link)\"> Unassigned</label>`\n      +endHtml\n      +`<button class=\"chip\" id=\"exitScrum\">Exit scrum</button>`\n      +`</div>`;\n    // wire\n    el.querySelectorAll('[data-scrum-member]').forEach(b=>b.onclick=()=>scrumJump(b.getAttribute('data-scrum-member')));\n    const sk=el.querySelector('#scrumSkip'); if(sk) sk.onclick=()=>scrumAction('skip');\n    const nx=el.querySelector('#scrumNext'); if(nx) nx.onclick=()=>scrumAction('next');\n    const un=el.querySelector('#scrumUnassigned');\n    if(un) un.onchange=()=>{ scrumSession.includeUnassigned=un.checked; render(); };\n    const ho=el.querySelector('#scrumHideOld');\n    if(ho) ho.onchange=()=>{ scrumSession.hideOld=ho.checked; render(); };\n    const ex=el.querySelector('#exitScrum'); if(ex) ex.onclick=exitScrum;\n  }\n\n  function enterScrum(){\n    const devs=collectDevelopers(ISSUES);\n    if(!devs.length) return;\n    state.scrum=true;\n    state.filterDevs.clear(); state.filterUnassigned=false; state.filterTier=null;\n    document.documentElement.setAttribute('data-scrum','on');\n    /* close the customise panel if it's open */\n    const p=document.getElementById('panel'); if(p) p.classList.remove('open');\n    const cb=document.getElementById('customise'); if(cb){ cb.setAttribute('aria-expanded','false'); }\n    scrumSession={\n      order:scrumShuffle(devs),\n      current:null,\n      viewing:null,\n      done:new Set(),\n      skipped:new Set(),\n      includeUnassigned:true,\n      hideOld:true,\n      timerStart:null,\n      timerInterval:null\n    };\n    scrumSession.current=scrumSession.order[0];\n    scrumSession.timerStart=Date.now();\n    scrumSession.timerInterval=setInterval(tickTimer,1000);\n    writeState(); render();\n  }\n  function exitScrum(){\n    state.scrum=false;\n    document.documentElement.removeAttribute('data-scrum');\n    if(scrumSession&&scrumSession.timerInterval) clearInterval(scrumSession.timerInterval);\n    scrumSession=null;\n    state.filterDevs.clear(); state.filterUnassigned=false;\n    writeState(); render();\n  }\n  function scrumAction(action){\n    if(!scrumSession||!scrumSession.current) return;\n    scrumSession.viewing=null;\n    const result=scrumAdvance(scrumSession.order,scrumSession.current,\n      scrumSession.done,scrumSession.skipped,action);\n    scrumSession.current=result.current;\n    clearInterval(scrumSession.timerInterval);\n    if(scrumSession.current){\n      scrumSession.timerStart=Date.now();\n      scrumSession.timerInterval=setInterval(tickTimer,1000);\n    } else { scrumSession.timerStart=null; }\n    render();\n  }\n  function scrumJump(name){\n    if(!scrumSession) return;\n    const st=scrumMemberStatus(name,scrumSession.current,scrumSession.done,scrumSession.skipped);\n    /* A dev who already shared: don't restart their turn \u2014 just re-highlight their\n       tickets on the board (toggle). The current sharer's timer keeps running. */\n    if(st==='done'){\n      scrumSession.viewing = (scrumSession.viewing===name) ? null : name;\n      render();\n      return;\n    }\n    /* Jumping to anyone else takes the turn \u2014 clear any peek first. */\n    scrumSession.viewing=null;\n    const result=scrumAdvance(scrumSession.order,scrumSession.current,\n      scrumSession.done,scrumSession.skipped,{jump:name});\n    if(result.current!==scrumSession.current){\n      scrumSession.current=result.current;\n      clearInterval(scrumSession.timerInterval);\n      scrumSession.timerStart=Date.now();\n      scrumSession.timerInterval=setInterval(tickTimer,1000);\n    }\n    render();\n  }\n  function tickTimer(){\n    const el=document.querySelector('.scrum-timer');\n    if(!el||!scrumSession||!scrumSession.timerStart) return;\n    const elapsed=Math.floor((Date.now()-scrumSession.timerStart)/1000);\n    const t=scrumTimerText(elapsed);\n    el.textContent=t.text;\n    if(t.over){\n      el.classList.add('over-time');\n      const chip=document.querySelector('.standup-chip.st-current');\n      if(chip) chip.classList.add('over-time');\n    }\n  }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 EXPANDED CARD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n     Click a card \u2192 modal with the full metric rundown (every metric, with the\n     ticket's own resolved warn/risk thresholds) + tabbed visualizations:\n     per-column time bars and a column/assignee flow timeline. The two tabs\n     need `columnTotals`/`flow` from the live payload; the snapshot shows a\n     placeholder there while the rundown still works. */\n  function fmtTs(ms){ return new Date(ms).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }\n  function cutoffCaption(id,rec){\n    if(id==='rejections') return 'warn \u2265 '+REJ.warn+' \u00b7 risk \u2265 '+REJ.risk;\n    if(id==='composite') return 'warn \u2265 '+Math.round(COMP.warn*100)+' \u00b7 risk \u2265 '+Math.round(COMP.risk*100);\n    if(id==='blocked') return (rec.blockedByOpen&&rec.blockedByOpen.length)?('by '+esc(rec.blockedByOpen.join(', '))):'risk when \u201cYes\u201d';\n    const c=resolveCutoff(id,rec.column,rec.points);   // idle / timeInColumn / cycle\n    return 'warn \u2265 '+fmtWorkHM(c.warn)+' \u00b7 risk \u2265 '+fmtWorkHM(c.risk);\n  }\n  // Top contributors to the composite (same enabled set + weights + power the\n  // composite itself uses), for the \"drivers:\" caption on its tile.\n  function compositeDrivers(rec){\n    const cfg=COMPOSITE||{}; const p=(cfg.p&&cfg.p>0)?cfg.p:1; const w=cfg.weights||{};\n    const parts=[];\n    state.order.forEach(id=>{\n      if(id==='composite'||!state.on.has(id)) return;\n      const m=HEALTH[id]; const s=m.score(m.get(rec),rec); if(s==null) return;\n      const wi=w[id]!=null?w[id]:1; if(wi<=0) return;\n      parts.push({label:m.label, c:wi*Math.pow(Math.max(0,s),p)});\n    });\n    parts.sort((a,b)=>b.c-a.c);\n    return parts.filter(x=>x.c>0).slice(0,2).map(x=>x.label);\n  }\n\n  function openCard(key){\n    state.card=key; writeState(); renderModal();\n    const o=document.getElementById('overlay');\n    o.classList.add('open'); o.setAttribute('aria-hidden','false');\n    const x=document.getElementById('xclose'); if(x) x.focus();\n  }\n  function closeCard(){\n    state.card=null; writeState();\n    const o=document.getElementById('overlay');\n    o.classList.remove('open'); o.setAttribute('aria-hidden','true');\n  }\n\n  function paneColumns(rec){\n    if(!rec.flow) return `<div class=\"xempty\">Timeline data comes with live data only \u2014 open the board through the local server and hit Refresh.</div>`;\n    if(rec.started===false || !rec.flow.startedAt) return `<div class=\"xempty\">Not started \u2014 column timers begin when the ticket first enters \u201cIn Progress\u201d.</div>`;\n    const done=isDoneColumn(rec);\n    const totals={},visits={};\n    (rec.columnTotals||[]).forEach(t=>{totals[t.column]=t.hours;visits[t.column]=t.visits;});\n    const rows=COLUMNS.slice();\n    (rec.columnTotals||[]).forEach(t=>{ if(rows.indexOf(t.column)<0) rows.push(t.column); });\n    const max=Math.max(0.001, ...Object.keys(totals).map(k=>totals[k]));\n    const body=rows.map(col=>{\n      const h=totals[col];\n      const cur = col===(rec.column||rec.status);\n      const st='white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'\n        +(cur?'font-weight:600;':'')+((h==null&&!cur)?'color:var(--none);':'');\n      const name=`<span class=\"cn\" style=\"${st}\" title=\"${esc(col)}\">${esc(col)}${cur?' \u25c2':''}</span>`;\n      if(h==null) return name+`<div></div><span style=\"color:var(--none)\">\u2014</span>`;\n      const band = done?null:tband(h,resolveCutoff('timeInColumn',col,rec.points));\n      const color = done?'var(--none)':(band==='risk'?'var(--risk)':band==='warn'?'var(--warn)':'var(--ok)');\n      const pct=Math.max(1.4, h/max*100);\n      const vis = visits[col]>1?` <span style=\"color:var(--none)\">(${visits[col]}\u00d7)</span>`:'';\n      return name+`<div><div class=\"cbar\" style=\"width:${pct}%;background:${color}\"></div></div>`\n        +`<span>${fmtWorkHM(h)}${vis}</span>`;\n    }).join('');\n    return `<div class=\"cbar-grid\">${body}</div>`\n      +`<div class=\"xnote\">Work-hours only (Mon\u2013Thu 9\u201318, Fri 9\u201313) \u00b7 all visits summed since first \u201cIn Progress\u201d${histFrozen()?', cut off at sprint close':''} \u00b7 `\n      +(done?'banding off \u2014 ticket is done':'bar colour = that column\u2019s own in-column band')\n      +` \u00b7 cycle total ${fmtWorkHM(rec.cycleHours)||'\u2014'}</div>`;\n  }\n\n  //FLOW_GEOM_START\n  /* \u2500\u2500 Flow tab: vertical-journey geometry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n     Pure and DOM-free: everything between the FLOW_GEOM markers takes plain\n     data in and returns plain data out, so it is unit-testable from Node\n     (see test-flow.js). Rendering happens in paneFlow below.\n\n     The journey runs top\u2192bottom on the CYCLE work-hours axis (same basis as\n     the old horizontal Flow): board columns are vertical lanes, the line\n     steps between lanes at each transition, and every stretch between two\n     idle-resetting events (a status move OR an assignee change) is coloured\n     on a gradient that starts at the healthy colour, reaches the warn colour\n     exactly at that column's idle `warn` cutoff and the risk colour at its\n     idle `risk` cutoff. */\n  const FLOW_TZ=\"America/New_York\";\n  const _fDtf=new Intl.DateTimeFormat(\"en-US\",{timeZone:FLOW_TZ,hourCycle:\"h23\",\n    weekday:\"short\",year:\"numeric\",month:\"2-digit\",day:\"2-digit\",\n    hour:\"2-digit\",minute:\"2-digit\",second:\"2-digit\"});\n  function flowNyParts(ms){const o={};for(const p of _fDtf.formatToParts(ms))o[p.type]=p.value;\n    let h=+o.hour;if(h===24)h=0;return{wd:o.weekday,y:+o.year,mo:+o.month,d:+o.day,h,mi:+o.minute,s:+o.second};}\n  function flowOffsetMs(ms){const p=flowNyParts(ms);return Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi,p.s)-ms;}\n  function flowWallToUtc(y,mo,d,hh,mm){const g=Date.UTC(y,mo-1,d,hh,mm,0);return g-flowOffsetMs(g);}\n  const FLOW_WORK={Mon:[9,18],Tue:[9,18],Wed:[9,18],Thu:[9,18],Fri:[9,13]};\n  function flowWorkMs(start,end){   // same algorithm as the server's workMs\n    if(!(end>start))return 0;\n    let total=0;const sp=flowNyParts(start);\n    let cursor=flowWallToUtc(sp.y,sp.mo,sp.d,0,0);\n    for(let i=0;i<800&&cursor<end;i++){\n      const cp=flowNyParts(cursor+12*3600000), w=FLOW_WORK[cp.wd];\n      if(w){\n        const openU=flowWallToUtc(cp.y,cp.mo,cp.d,w[0],0), closeU=flowWallToUtc(cp.y,cp.mo,cp.d,w[1],0);\n        const lo=Math.max(start,openU), hi=Math.min(end,closeU);\n        if(hi>lo)total+=(hi-lo);\n      }\n      const np=flowNyParts(cursor+26*3600000);\n      cursor=flowWallToUtc(np.y,np.mo,np.d,0,0);\n    }\n    return total;\n  }\n  function mixHex(a,b,f){\n    f=Math.max(0,Math.min(1,f));\n    const pa=[1,3,5].map(i=>parseInt(a.slice(i,i+2),16));\n    const pb=[1,3,5].map(i=>parseInt(b.slice(i,i+2),16));\n    return \"#\"+pa.map((v,i)=>Math.round(v+(pb[i]-v)*f).toString(16).padStart(2,\"0\")).join(\"\");\n  }\n  /* Gradient stops for one idle stretch of `hours` length: healthy at its\n     start, warn colour exactly at the warn cutoff, risk colour exactly at the\n     risk cutoff; a stretch ending between thresholds ends on the proportional\n     in-between colour. Returns the end colour so the outgoing jog can fade\n     from it back to healthy. */\n  function idleStops(hours,cut,C){\n    if(!(hours>0)||!cut||cut.warn==null||cut.risk==null) return {stops:[{o:0,c:C.ok}],endColor:C.ok};\n    const stops=[{o:0,c:C.ok}];let end;\n    if(cut.warn>=hours){ end=mixHex(C.ok,C.warn,hours/cut.warn); stops.push({o:1,c:end}); }\n    else{\n      stops.push({o:cut.warn/hours,c:C.warn});\n      if(cut.risk>=hours){ end=mixHex(C.warn,C.risk,(hours-cut.warn)/Math.max(cut.risk-cut.warn,1e-9)); stops.push({o:1,c:end}); }\n      else{ stops.push({o:cut.risk/hours,c:C.risk}); end=C.risk; }\n    }\n    return {stops,endColor:end};\n  }\n  function flowFmtNy(ms,withDate){const p=flowNyParts(ms);\n    return p.wd+(withDate?(\" \"+p.mo+\"/\"+p.d):\"\")+\" \"+p.h+\":\"+String(p.mi).padStart(2,\"0\");}\n\n  function buildFlowGeometry(rec, columns, cutoffFor, colors, opt){\n    const o=opt||{}, C=colors;\n    const fl=rec&&rec.flow;\n    if(!fl||!fl.startedAt) return null;\n    const segs=fl.columnSegs||[];\n    if(!segs.length||!segs.some(s=>!s.doneCat)) return null;\n\n    // Lanes: the board's columns in board order, plus any historical column\n    // the ticket visited that isn't on the board any more.\n    const cols=columns.slice();\n    segs.forEach(s=>{ if(cols.indexOf(s.column)<0) cols.push(s.column); });\n    const width=o.width||636, axisW=o.axisW||94, rightPad=o.rightPad||10;\n    const laneW=Math.max(o.laneMin||54, Math.min(o.laneMax||112, (width-axisW-rightPad)/cols.length));\n    const svgW=Math.max(width, Math.ceil(axisW+laneW*cols.length+rightPad));\n    const laneX=i=>axisW+laneW*(i+0.5);\n    const laneOf=name=>{const i=cols.indexOf(name);return laneX(i<0?0:i);};\n\n    const total=Math.max(fl.totalHours||0,0.01);\n    const bodyH=Math.max(o.minBodyH||170, Math.min(o.maxBodyH||860, total*(o.pxPerHour||11)));\n    const scale=bodyH/total;\n    const headerH=o.headerH||40, topPad=o.topPad||28;\n    const y0=headerH+topPad, Y=h=>y0+h*scale;\n\n    // Cumulative cycle-hours through the segment list (done stubs add 0).\n    let cum=0;\n    const chain=segs.map(s=>{const top=cum; cum+=(s.doneCat?0:(s.hours||0)); return {seg:s,topH:top,botH:cum};});\n    const cycleHoursAt=t=>{\n      let h=0;\n      for(const e of chain){ if(e.seg.doneCat) continue;\n        if(t<=e.seg.fromMs) break;\n        h+=flowWorkMs(e.seg.fromMs, Math.min(t,e.seg.toMs))/3.6e6;\n        if(t<=e.seg.toMs) break;\n      }\n      return h;\n    };\n    const laneAtTime=t=>{\n      let x=laneOf(segs[0].column);\n      for(const e of chain){ if(t>=e.seg.fromMs) x=laneOf(e.seg.column); else break; }\n      return x;\n    };\n    const aSegs=fl.assigneeSegs||[];\n    const assigneeAt=t=>{let cur=null;for(const a of aSegs){if(a.fromMs<=t)cur=a.assignee;else break;}return cur;};\n    const avatars=aSegs.map(a=>({x:laneAtTime(a.fromMs), y:Y(cycleHoursAt(a.fromMs)), name:a.assignee||null, t:a.fromMs}));\n    const aChanges=aSegs.slice(1).map(a=>a.fromMs);\n\n    const R=o.cornerR!=null?o.cornerR:10;\n    const startX=laneOf(cols[0]);\n    const stretches=[], jogs=[], stubs=[];\n    let nowMarker=null, startJog=null;\n    // The walked line's previous exit: lane x, edge offset (corner radius or\n    // stub radius) and the colour the line left that element with.\n    let prev={x:startX, edge:5, color:C.ok, start:true};\n\n    chain.forEach((e,ci)=>{\n      const s=e.seg, x=laneOf(s.column);\n      const yT=Y(e.topH), yB=Y(e.botH), Hpx=Math.max(yB-yT,0);\n      const lastEl=ci===chain.length-1;\n      const dxIn=x-prev.x, dirIn=Math.sign(dxIn);\n\n      if(s.doneCat){   // zero height on the cycle axis \u2192 \u2713 stub on its lane\n        const rStub=9;\n        if(dirIn!==0){\n          const nc=C.none||C.ok;\n          const j={x1:prev.x+dirIn*prev.edge, x2:x-dirIn*rStub, y:yT, from:nc, to:nc};\n          if(prev.start) startJog=j; else jogs.push(j);\n        }\n        stubs.push({x, y:yT, column:s.column, status:s.status, t:s.fromMs});\n        prev={x, edge:rStub, color:C.ok, start:false};\n        return;\n      }\n\n      // Split the visit into idle stretches at assignee-change moments.\n      const cuts=aChanges.filter(t=>t>s.fromMs&&t<s.toMs).sort((a,b)=>a-b);\n      const bounds=[s.fromMs].concat(cuts,[s.toMs]);\n      const parts=[];let hCur=e.topH;\n      for(let j=0;j<bounds.length-1;j++){\n        const f=bounds[j], t=bounds[j+1], hh=flowWorkMs(f,t)/3.6e6;\n        parts.push({fromMs:f, toMs:t, hours:hh, yA:Y(hCur), yB:Y(hCur+hh)});\n        hCur+=hh;\n      }\n      parts[parts.length-1].yB=yB;   // absorb float drift into the last part\n\n      const nextX=lastEl?null:laneOf(chain[ci+1].seg.column);\n      const dxOut=nextX==null?0:nextX-x, dirOut=Math.sign(dxOut);\n      const firstPx=parts[0].yB-parts[0].yA, lastPx=parts[parts.length-1].yB-parts[parts.length-1].yA;\n      const rIn = dirIn? Math.max(0,Math.min(R,Math.abs(dxIn)/2,Hpx/2,firstPx)) : 0;\n      const rOut= dirOut?Math.max(0,Math.min(R,Math.abs(dxOut)/2,Hpx/2,lastPx)) : 0;\n\n      if(dirIn!==0){\n        const nc=C.none||C.ok;\n        const j={x1:prev.x+dirIn*prev.edge, x2:x-dirIn*rIn, y:yT, from:nc, to:nc};\n        if(prev.start) startJog=j; else jogs.push(j);\n      }\n\n      const X=x.toFixed(1);\n      let endColor=C.ok;\n      parts.forEach((p,j)=>{\n        const isF=j===0, isL=j===parts.length-1;\n        const gr=idleStops(p.hours, cutoffFor(s.column), C);\n        endColor=gr.endColor;\n        const vBot=isL? Math.max(yB-rOut,p.yA) : p.yB;\n        let d;\n        if(isF&&rIn>0){\n          d=`M ${(x-dirIn*rIn).toFixed(1)} ${yT.toFixed(1)} Q ${X} ${yT.toFixed(1)} ${X} ${(yT+rIn).toFixed(1)}`;\n          if(vBot>yT+rIn) d+=` L ${X} ${vBot.toFixed(1)}`;\n        } else {\n          d=`M ${X} ${p.yA.toFixed(1)} L ${X} ${Math.max(vBot,p.yA).toFixed(1)}`;\n        }\n        if(isL&&rOut>0) d+=` Q ${X} ${yB.toFixed(1)} ${(x+dirOut*rOut).toFixed(1)} ${yB.toFixed(1)}`;\n        stretches.push({d, x, yA:p.yA, yB:p.yB,\n          grad:{y1:p.yA, y2:Math.max(p.yB,p.yA+0.01), stops:gr.stops}, endColor:gr.endColor,\n          column:s.column, status:s.status, assignee:assigneeAt(p.fromMs),\n          fromMs:p.fromMs, toMs:p.toMs, hours:p.hours,\n          isLast:lastEl&&isL, avatarAtTop:false});\n      });\n      if(lastEl) nowMarker={x, y:yB, color:endColor};\n      prev={x, edge:rOut, color:endColor, start:false};\n    });\n    stretches.forEach(st=>{ st.avatarAtTop=avatars.some(a=>Math.abs(a.x-st.x)<1&&Math.abs(a.y-st.yA)<12); });\n\n    // Time ruler: the start moment, then 9 am and 1 pm of every workday\n    // mapped through the cycle clock, then the end moment. Ticks that land on\n    // the same y (nights, weekends, done-status gaps) are deduped, preferring\n    // the 9 am (day-boundary) tick.\n    const tStart=Date.parse(fl.startedAt);\n    const lastE=chain[chain.length-1];\n    const tEnd=lastE.seg.doneCat? lastE.seg.fromMs : lastE.seg.toMs;\n    const withDate=(tEnd-tStart)>6*864e5;\n    const yEnd=Y(total), cand=[];\n    {\n      const sp=flowNyParts(tStart);\n      let cursor=flowWallToUtc(sp.y,sp.mo,sp.d,0,0);\n      for(let i=0;i<400&&cursor<tEnd;i++){\n        const cp=flowNyParts(cursor+12*3600000);\n        if(FLOW_WORK[cp.wd]){\n          for(const hh of [9,13]){\n            const tt=flowWallToUtc(cp.y,cp.mo,cp.d,hh,0);\n            if(tt>tStart+60000&&tt<tEnd-60000)\n              cand.push({t:tt, y:Y(cycleHoursAt(tt)), major:hh===9,\n                label: hh===9? (cp.wd+(withDate?(\" \"+cp.mo+\"/\"+cp.d):\"\")+\" 9 am\") : \"1 pm\"});\n          }\n        }\n        const np=flowNyParts(cursor+26*3600000);\n        cursor=flowWallToUtc(np.y,np.mo,np.d,0,0);\n      }\n    }\n    const ticks=[];\n    for(const tk of cand){\n      if(tk.y-y0<14||yEnd-tk.y<14) continue;\n      const last=ticks[ticks.length-1];\n      if(last&&tk.y-last.y<13){ if(tk.major&&!last.major) ticks[ticks.length-1]=tk; continue; }\n      ticks.push(tk);\n    }\n\n    return { svgW, height:Math.ceil(yEnd+30), laneW, headerH, axisW, y0, yEnd, scale,\n      cols:cols.map((n,i)=>({name:n,x:laneX(i)})),\n      startDot:{x:startX,y:Y(0)}, startJog, jogs, stretches, stubs, avatars, nowMarker, ticks,\n      startLabel:flowFmtNy(tStart,withDate), endLabel:flowFmtNy(tEnd,withDate),\n      totalHours:fl.totalHours };\n  }\n  //FLOW_GEOM_END\n\n  /* Gradient colours must match the active theme, and the theme can flip\n     while a card is open \u2014 applyTheme re-renders the modal for that reason. */\n  function flowThemeColors(){\n    let ok=\"#36b37e\",warn=\"#ffab00\",risk=\"#ff5630\",none=\"#a5adba\";\n    try{\n      const cs=getComputedStyle(document.documentElement);\n      ok=(cs.getPropertyValue(\"--ok\")||\"\").trim()||ok;\n      warn=(cs.getPropertyValue(\"--warn\")||\"\").trim()||warn;\n      risk=(cs.getPropertyValue(\"--risk\")||\"\").trim()||risk;\n      none=(cs.getPropertyValue(\"--none\")||\"\").trim()||none;\n    }catch(e){}\n    return {ok,warn,risk,none};\n  }\n  function flowHeaderLines(name,laneW){\n    const maxC=Math.max(4,Math.floor((laneW-6)/5.6));\n    const cut=s=>s.length>maxC?s.slice(0,Math.max(1,maxC-1))+\"\u2026\":s;\n    const words=String(name).split(/\\s+/);\n    let l1=\"\",i=0;\n    for(;i<words.length;i++){const t=l1?l1+\" \"+words[i]:words[i]; if(t.length<=maxC||!l1)l1=t; else break;}\n    const l2=words.slice(i).join(\" \");\n    return l2?[cut(l1),cut(l2)]:[cut(l1)];\n  }\n  function paneFlow(rec){\n    if(!rec.flow) return `<div class=\"xempty\">Timeline data comes with live data only \u2014 open the board through the local server and hit Refresh.</div>`;\n    const fl=rec.flow;\n    if(rec.started===false || !fl.startedAt) return `<div class=\"xempty\">Not started \u2014 the flow begins when the ticket first enters \u201cIn Progress\u201d.</div>`;\n    const C=flowThemeColors(), endWord=histFrozen()?'sprint close':'now';\n    const g=buildFlowGeometry(rec, COLUMNS, col=>resolveCutoff('idle',col,rec.points), C, {width:636});\n    if(!g) return `<div class=\"xempty\">No in-flight history to draw \u2014 every recorded stay is in a Done-category status.</div>`;\n    const P=n=>n.toFixed(1);\n    const defs=[], back=[], paths=[], hits=[], marks=[], txt=[];\n\n    // column headers + lane guides\n    g.cols.forEach(c=>{\n      const lines=flowHeaderLines(c.name,g.laneW);\n      const tsp=lines.map((l,i)=>`<tspan x=\"${P(c.x)}\" dy=\"${i?12:0}\">${esc(l)}</tspan>`).join(\"\");\n      txt.push(`<text x=\"${P(c.x)}\" y=\"${lines.length>1?15:24}\" text-anchor=\"middle\" font-size=\"10.5\" style=\"fill:var(--subtle);font-weight:600;letter-spacing:.02em\">${tsp}<title>${esc(c.name)}</title></text>`);\n      back.push(`<line x1=\"${P(c.x)}\" y1=\"${g.headerH}\" x2=\"${P(c.x)}\" y2=\"${P(g.yEnd+12)}\" style=\"stroke:var(--none)\" opacity=\".4\" stroke-dasharray=\"2 4\"/>`);\n    });\n\n    // time ruler\n    const tickLn=(y,long)=>back.push(`<line x1=\"${g.axisW-(long?12:8)}\" y1=\"${P(y)}\" x2=\"${g.axisW-3}\" y2=\"${P(y)}\" style=\"stroke:var(--none)\"/>`);\n    const tickTx=(y,label,strong,dim)=>txt.push(`<text x=\"${g.axisW-16}\" y=\"${P(y+3.5)}\" text-anchor=\"end\" font-size=\"11\" style=\"fill:var(--${strong?'ink':'subtle'})${strong?';font-weight:600':''}${dim?';opacity:.8':''}\">${esc(label)}</text>`);\n    tickLn(g.y0,true); tickTx(g.y0,g.startLabel,true);\n    g.ticks.forEach(tk=>{ tickLn(tk.y,tk.major); tickTx(tk.y,tk.label,false,!tk.major); });\n    tickLn(g.yEnd,true); tickTx(g.yEnd,g.endLabel,true);\n\n    // journey line: idle-gradient stretches + fade-back-to-green jogs\n    g.stretches.forEach((s,i)=>{\n      defs.push(`<linearGradient id=\"fg${i}\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"${P(s.grad.y1)}\" x2=\"0\" y2=\"${P(s.grad.y2)}\">`\n        +s.grad.stops.map(st=>`<stop offset=\"${st.o.toFixed(4)}\" stop-color=\"${st.c}\"/>`).join(\"\")+`</linearGradient>`);\n      paths.push(`<path d=\"${s.d}\" fill=\"none\" stroke=\"url(#fg${i})\" stroke-width=\"3\" stroke-linecap=\"round\"/>`);\n      const tip=`${s.column} (${s.status}) \u00b7 ${s.assignee||'Unassigned'} \u2014 ${fmtTs(s.fromMs)} \u2192 ${s.isLast?endWord:fmtTs(s.toMs)} \u00b7 ${fmtWorkHM(s.hours)} work`;\n      hits.push(`<path d=\"${s.d}\" fill=\"none\" stroke=\"#000\" stroke-opacity=\"0\" stroke-width=\"16\" pointer-events=\"stroke\"><title>${esc(tip)}</title></path>`);\n    });\n    const jogLine=(j,i)=>{\n      if(j.from===j.to) return paths.push(`<line x1=\"${P(j.x1)}\" y1=\"${P(j.y)}\" x2=\"${P(j.x2)}\" y2=\"${P(j.y)}\" stroke=\"${j.to}\" stroke-width=\"3\" stroke-linecap=\"round\"/>`);\n      defs.push(`<linearGradient id=\"fj${i}\" gradientUnits=\"userSpaceOnUse\" x1=\"${P(j.x1)}\" y1=\"0\" x2=\"${P(j.x2)}\" y2=\"0\"><stop offset=\"0\" stop-color=\"${j.from}\"/><stop offset=\"1\" stop-color=\"${j.to}\"/></linearGradient>`);\n      paths.push(`<line x1=\"${P(j.x1)}\" y1=\"${P(j.y)}\" x2=\"${P(j.x2)}\" y2=\"${P(j.y)}\" stroke=\"url(#fj${i})\" stroke-width=\"3\" stroke-linecap=\"round\"/>`);\n    };\n    if(g.startJog) jogLine(g.startJog,\"s\");\n    g.jogs.forEach(jogLine);\n\n    // markers: start dot, done stubs, \"now\", assignee avatars\n    marks.push(`<circle cx=\"${P(g.startDot.x)}\" cy=\"${P(g.startDot.y)}\" r=\"4\" fill=\"${C.ok}\"/>`);\n    g.stubs.forEach(st=>{\n      marks.push(`<g><circle cx=\"${P(st.x)}\" cy=\"${P(st.y)}\" r=\"9\" fill=\"${C.ok}\"/>`\n        +`<text x=\"${P(st.x)}\" y=\"${P(st.y+3.5)}\" text-anchor=\"middle\" font-size=\"10\" fill=\"#fff\">\u2713</text>`\n        +`<title>${esc(st.column+' ('+st.status+') \u2014 entered '+fmtTs(st.t))}</title></g>`);\n    });\n    if(g.nowMarker){\n      marks.push(`<circle cx=\"${P(g.nowMarker.x)}\" cy=\"${P(g.nowMarker.y)}\" r=\"4\" fill=\"${g.nowMarker.color}\"/>`);\n      txt.push(`<text x=\"${P(g.nowMarker.x+11)}\" y=\"${P(g.nowMarker.y+4)}\" font-size=\"11\" style=\"fill:var(--subtle);font-style:italic\">${histFrozen()?'close':'now'}</text>`);\n    }\n    g.stretches.forEach(s=>{   // duration beside each long-enough stretch\n      const h=s.yB-s.yA;\n      if(h<26||s.hours<=0||(s.avatarAtTop&&h<46)) return;\n      const left=s.x>g.svgW-130;\n      txt.push(`<text x=\"${P(s.x+(left?-16:16))}\" y=\"${P((s.yA+s.yB)/2+4)}\" text-anchor=\"${left?'end':'start'}\" font-size=\"11\" style=\"fill:var(--subtle)\">${esc(fmtWorkHM(s.hours))}</text>`);\n    });\n    g.avatars.forEach(a=>{\n      const nm=a.name, left=a.x>g.svgW-140;\n      const short=nm? nm.trim().split(/\\s+/).map((w,i)=>i===0?w:(w[0]||\"\").toUpperCase()+\".\").join(\" \") : \"Unassigned\";\n      const tip=(nm||\"Unassigned\")+\" \u2014 from \"+fmtTs(a.t);\n      if(nm){\n        marks.push(`<g><circle cx=\"${P(a.x)}\" cy=\"${P(a.y)}\" r=\"11\" fill=\"${colorFor(nm)}\" style=\"stroke:var(--card-bg)\" stroke-width=\"2\"/>`\n          +`<text x=\"${P(a.x)}\" y=\"${P(a.y+3.5)}\" text-anchor=\"middle\" font-size=\"9.5\" font-weight=\"700\" fill=\"#fff\">${esc(initials(nm))}</text>`\n          +`<title>${esc(tip)}</title></g>`);\n      }else{\n        marks.push(`<g><circle cx=\"${P(a.x)}\" cy=\"${P(a.y)}\" r=\"11\" style=\"fill:var(--card-bg);stroke:var(--none)\" stroke-width=\"1.5\" stroke-dasharray=\"3 2\"/>`\n          +`<text x=\"${P(a.x)}\" y=\"${P(a.y+4)}\" text-anchor=\"middle\" font-size=\"11\" style=\"fill:var(--none)\">\u2013</text>`\n          +`<title>${esc(tip)}</title></g>`);\n      }\n      // Name label intentionally omitted next to the avatar; the identity is\n      // still available via the circle's hover tooltip (<title> above).\n    });\n\n    const svg=`<svg viewBox=\"0 0 ${g.svgW} ${g.height}\" style=\"width:100%;height:auto;display:block\" xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" aria-label=\"Ticket journey: columns over time\">`\n      +`<defs>${defs.join(\"\")}</defs>${back.join(\"\")}${paths.join(\"\")}${hits.join(\"\")}${marks.join(\"\")}${txt.join(\"\")}</svg>`;\n    return `<div class=\"xnote\" style=\"margin:0 0 6px\">Created ${fmtTs(Date.parse(fl.createdAt))} \u00b7 first entered \u201cIn Progress\u201d ${fmtTs(Date.parse(fl.startedAt))}</div>`\n      +svg\n      +`<div class=\"xnote\">Line colour = the idle clock against each column's own idle cutoffs \u2014 it resets to green at every move or handoff, reaches amber at the warn line and red at the risk line \u00b7 circles mark assignee changes \u00b7 vertical distance = work-hours on the cycle clock (Mon\u2013Thu 9\u201318, Fri 9\u201313; time in Done collapses to the \u2713) \u00b7 hover the line for exact times \u00b7 cycle total ${fmtWorkHM(fl.totalHours)}${histFrozen()?' (to sprint close)':''}.</div>`;\n  }\n\n\n  // Short date for a full ISO timestamp (dev-status PR dates carry a time part).\n  function fmtPRDate(iso){\n    if(!iso) return '';\n    const d=new Date(iso); if(isNaN(d.getTime())) return '';\n    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});\n  }\n  // Which cards have their 'N declined' PR fold open. Kept across renders so a\n  // silent auto-refresh repaint doesn't snap it shut mid-read -- mirrors the\n  // healthOpen / toggleHealthMore pattern used by the health-metrics section.\n  const prDeclinedOpen = new Set();\n  function togglePRDeclined(divider){\n    const key=divider.getAttribute('data-key');\n    const more=divider.nextElementSibling;\n    if(!more) return;\n    const open=more.classList.toggle('open');\n    const chev=divider.querySelector('.hd-chev'); if(chev) chev.textContent=open?'\u25be':'\u25b8';\n    if(open) prDeclinedOpen.add(key); else prDeclinedOpen.delete(key);\n  }\n  // Pull-request section for the expanded card. rec.prs is set by the server's\n  // dev-status enrichment: undefined -> feature off / frozen snapshot (omit the\n  // section entirely); [] -> enabled but none linked.\n  function zonePRs(rec){\n    const prs=rec.prs;\n    if(prs===undefined) return '';\n    const rank={active:0,merged:1,declined:2};\n    const sorted=prs.slice().sort((a,b)=>{\n      const o=(rank[a.state]??9)-(rank[b.state]??9);\n      if(o) return o;\n      return (Date.parse(b.updated)||0)-(Date.parse(a.updated)||0);\n    });\n    const live=sorted.filter(p=>p.state!=='declined');\n    const declined=sorted.filter(p=>p.state==='declined');\n    const head=`<div class=\"xprs-head\">Pull requests <span class=\"n\">\u00b7 ${live.length}</span></div>`;\n    if(!prs.length)\n      return `<div class=\"xprs\">${head}<div class=\"xprs-empty\">No pull requests reference ${esc(rec.key)}.</div></div>`;\n    const row=p=>{\n      const label=p.state==='merged'?'Merged':p.state==='declined'?'Declined':'Active';\n      const dateWord=p.state==='merged'?'merged':p.state==='declined'?'closed':'updated';\n      const idTitle=`${p.id?'!'+esc(p.id)+'  ':''}${esc(p.title)}`;\n      const link=p.url\n        ? `<a class=\"pr-title\" href=\"${esc(p.url)}\" target=\"_blank\" rel=\"noopener\">${idTitle}</a>`\n        : `<span class=\"pr-title\">${idTitle}</span>`;\n      const repo=p.repo?`<span class=\"pr-repo\">${esc(p.repo)}</span>`:'';\n      const branch=(p.source||p.target)?` \u00b7 ${esc(p.source||'?')} \u2192 ${esc(p.target||'?')}`:'';\n      const when=p.updated?` \u00b7 ${dateWord} ${esc(fmtPRDate(p.updated))}`:'';\n      const meta=`<div class=\"pr-meta\">${esc(p.author||'\u2014')}${branch}${when}</div>`;\n      let rev='';\n      if(p.reviewers){\n        const okTxt=p.approvals>0?`<span class=\"ok\">\u2714 ${p.approvals} approved</span>`:'';\n        const pend=p.reviewers-p.approvals;\n        const pendTxt=pend>0?`${okTxt?' \u00b7 ':''}${pend} pending`:'';\n        const bodyTxt=(okTxt||pendTxt)?okTxt+pendTxt:`${p.reviewers} reviewer${p.reviewers>1?'s':''}`;\n        rev=`<div class=\"pr-rev\">${bodyTxt}</div>`;\n      }\n      return `<div class=\"pr ${p.state}\"><div class=\"pr-top\">`\n        +`<span class=\"pr-pill ${p.state}\">${label}</span>${link}${repo}</div>${meta}${rev}</div>`;\n    };\n    let body=live.map(row).join('') || `<div class=\"xprs-empty\">No open pull requests.</div>`;\n    if(declined.length){\n      const dOpen=prDeclinedOpen.has(rec.key);\n      body+=`<div class=\"health-divider\" data-key=\"${esc(rec.key)}\" onclick=\"event.stopPropagation();togglePRDeclined(this)\">`\n        +`<hr><span class=\"health-divider-label\"><span class=\"hd-chev\">${dOpen?'\u25be':'\u25b8'}</span> ${declined.length} declined</span><hr></div>`\n        +`<div class=\"health-more${dOpen?' open':''}\">${declined.map(row).join('')}</div>`;\n    }\n    return `<div class=\"xprs\">${head}${body}</div>`;\n  }\n\n  function renderModal(){\n    if(!state.card) return;\n    const box=document.getElementById('xdialog');\n    const closeBtn=`<button class=\"tool xclose\" id=\"xclose\" title=\"Close\" aria-label=\"Close\">\u2715</button>`;\n    const rec=modalRecords().find(i=>i.key===state.card);\n    if(!rec){\n      box.innerHTML=`<div class=\"xhead\"><div class=\"xtitles\"><div class=\"xsummary\">${esc(state.card)}</div></div>${closeBtn}</div>`\n        +`<div class=\"xempty\">${histFrozen()?'This ticket is not in the selected sprint.':'This ticket is not in the current board data (it may have left the sprint).'}</div>`;\n      wireModal(); return;\n    }\n    const head=`<div class=\"xhead\"><div class=\"xtitles\">`\n      +`<div class=\"xkeyline\">${typeIcon(rec.type)}<a class=\"key\" href=\"${BROWSE_BASE+rec.key}\" target=\"_blank\" rel=\"noopener\">${esc(rec.key)}</a></div>`\n      +`<div class=\"xsummary\">${esc(rec.summary)}</div>`\n      +`<div class=\"xsub\"><span class=\"status-pill\">${esc(rec.status)}</span>${avatar(rec.assignee)}<span>${esc(rec.assignee||'Unassigned')}</span></div>`\n      +`</div>${closeBtn}</div>`;\n    // Details strip: the expanded view always shows every info attribute,\n    // regardless of the board's Customise toggles.\n    const infoParts=INFO_ATTRS.map(a=>{\n      const v=a.get(rec); if(!has(v)) return '';\n      const val = a.id==='parent'\n        ? `<a class=\"key\" href=\"${BROWSE_BASE+esc(String(v))}\" target=\"_blank\" rel=\"noopener\">${esc(String(v))}</a>`\n        : (a.html ? a.format(v,rec) : esc(a.format(v,rec)));\n      return `<span><span class=\"k\">${esc(a.label)}:</span> ${val}</span>`;\n    }).filter(Boolean);\n    // PR count in the details strip \u2014 0 when a ticket has none yet. Omitted only\n    // when PR data isn't present at all (feature off / frozen snapshot).\n    if(rec.prs!==undefined) infoParts.push(`<span><span class=\"k\">PRs:</span> ${rec.prs.length}</span>`);\n    const info=infoParts.join('');\n    // Dev mode hides the health-metric tiles entirely \u2014 just details, PRs, and\n    // the visualisations at the bottom.\n    const tiles=state.mode==='dev' ? '' : HEALTH_DEFAULT_ORDER.map(id=>{\n      const m=HEALTH[id], mv=metricValue(id,rec);\n      let cap=cutoffCaption(id,rec);\n      if(id==='composite'){ const d=compositeDrivers(rec); if(d.length&&mv.score!=null) cap+=' \u00b7 drivers: '+esc(d.join(', ')); }\n      return `<div class=\"xtile\"><div class=\"tl\"><span class=\"dot ${mv.band}\"></span>${esc(m.label)}</div>`\n        +`<div class=\"tv ${mv.pending?'pending':''}\">${esc(mv.text)}</div><div class=\"tt\">${cap}</div></div>`;\n    }).join('');\n    const tabs=`<div class=\"xtabs\" role=\"tablist\">`\n      +`<button class=\"xtab ${state.ctab==='cols'?'on':''}\" data-xtab=\"cols\" role=\"tab\" aria-selected=\"${state.ctab==='cols'}\">Time in columns</button>`\n      +`<button class=\"xtab ${state.ctab==='flow'?'on':''}\" data-xtab=\"flow\" role=\"tab\" aria-selected=\"${state.ctab==='flow'}\">Flow</button></div>`;\n    const pane=`<div class=\"xpane\">${state.ctab==='flow'?paneFlow(rec):paneColumns(rec)}</div>`;\n    const frozen = histFrozen()\n      ? `<div class=\"frozen\">\ud83d\udd58 Snapshot as of sprint close \u2014 ${esc(histCloseLabel())}. Timers stopped there; nothing after close is counted.</div>` : '';\n    box.innerHTML=head+(info?`<div class=\"xinfo\">${info}</div>`:'')+frozen+zonePRs(rec)+(tiles?`<div class=\"xtiles\">${tiles}</div>`:'')+tabs+pane;\n    wireModal();\n  }\n  function wireModal(){\n    const box=document.getElementById('xdialog');\n    const x=box.querySelector('#xclose'); if(x) x.onclick=closeCard;\n    box.querySelectorAll('[data-xtab]').forEach(b=>b.onclick=()=>{\n      state.ctab=b.getAttribute('data-xtab'); writeState(); renderModal();\n    });\n  }\n\n  function render(){\n    const board=document.getElementById('board'); board.innerHTML='';\n    const sortId=sortMetricId();\n    const scrumFocus=(state.scrum&&scrumSession)?(scrumSession.viewing||scrumSession.current):null;\n    const inScrum=!!scrumFocus;\n    COLUMNS.forEach(col=>{\n      let items=ISSUES.filter(i=>(i.column||i.status)===col);\n      /* scrum mode: filter to the focused member's tickets \u2014 the current sharer,\n         or a previously-shared dev the facilitator clicked to re-inspect. */\n      if(inScrum){\n        items=items.filter(r=>scrumDevFilterMatches(r,scrumFocus,scrumSession.includeUnassigned));\n        /* Hide old work: drop Done-column tickets the focused member didn't\n           touch in the last 24h (checkbox default-on). */\n        items=items.filter(r=>!scrumHideOldWork(r,scrumFocus,isDoneColumn(r),scrumSession.hideOld));\n      } else if(devFilterOn()){\n        items=items.filter(r=>devFilterMatches(r,state.filterDevs,state.filterUnassigned));\n      }\n      if(searchOn()){ items=items.filter(searchMatches); }\n      if(state.filterTier){ items=items.filter(r=>cardTier(r)===state.filterTier); }\n      if(sortId){\n        items=items.slice().sort((a,b)=>{\n          const d=metricValue(sortId,b).sortVal-metricValue(sortId,a).sortVal;\n          return d!==0?d:a.key.localeCompare(b.key);\n        });\n      }\n      const sec=document.createElement('section'); sec.className='column';\n      sec.innerHTML=`<div class=\"column-head\"><span>${esc(col)}</span><span>${items.length}</span></div><div class=\"cards\"></div>`;\n      const cards=sec.querySelector('.cards');\n      if(!items.length){ cards.innerHTML='<div class=\"empty\">No issues</div>'; }\n      else items.forEach(rec=>{\n        const isFollowUp=!!rec.implementor && !rec.assignee && !isDoneColumn(rec);\n        const card=document.createElement('div'); card.className='card'+(isFollowUp?' scrum-followup':'');\n        card.style.borderColor=sortBorderColor(rec);   // keep the normal risk/warn outline, even on follow-ups\n        const followUpPill=isFollowUp\n          ?`<div><span class=\"scrum-followup-pill\">\u21a9 follow up \u00b7 unassigned</span></div>`:'';\n        card.innerHTML=`<div class=\"summary\">${esc(rec.summary)}</div>`\n          +`<div class=\"status-line\"><span class=\"status-pill\">${esc(rec.status)}</span></div>`\n          +followUpPill\n          +`<div class=\"foot\"><span class=\"id-wrap\">${typeIcon(rec.type)}`\n          +`<a class=\"key\" href=\"${BROWSE_BASE+rec.key}\" target=\"_blank\" rel=\"noopener\">${esc(rec.key)}</a></span>${avatar(rec.assignee)}</div>`\n          +zoneInfo(rec)+zoneHealth(rec);\n        card.tabIndex=0;\n        card.setAttribute('role','button');\n        card.setAttribute('aria-label','Expand '+rec.key);\n        card.addEventListener('click',ev=>{ if(ev.target.closest('a')||ev.target.closest('.health-divider'))return; openCard(rec.key); });\n        card.addEventListener('keydown',ev=>{\n          if((ev.key==='Enter'||ev.key===' ')&&!ev.target.closest('a')){ ev.preventDefault(); openCard(rec.key); }\n        });\n        cards.appendChild(card);\n      });\n      board.appendChild(sec);\n    });\n    const sid=sortMetricId();\n    {\n      const shown = ISSUES.filter(r=>\n        (!devFilterOn()||devFilterMatches(r,state.filterDevs,state.filterUnassigned)) && (!searchOn()||searchMatches(r))).length;\n      const issueCount = (devFilterOn()||searchOn())\n        ? `${shown} of ${ISSUES.length} issues${searchOn()?' (search)':' (developer filter)'}`\n        : `${ISSUES.length} issues`;\n      document.getElementById('meta').textContent =\n        `${issueCount} \u00b7 last updated ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`\n        + (LIVE?' \u00b7 live':' \u00b7 loading\u2026');\n    }\n    if(state.scrum){\n      document.getElementById('summary').innerHTML='';\n      buildStandupBar();\n    } else {\n      buildSummary();\n      buildDevBar();\n    }\n    if(state.card) renderModal();   // keep an open expanded card in sync with fresh data\n  }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 PANEL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  function buildPanel(){\n    const sortId=sortMetricId();\n    const infoRows=INFO_ATTRS.map(a=>`\n      <label class=\"opt\"><input type=\"checkbox\" data-info=\"${a.id}\" ${state.info.has(a.id)?'checked':''}>\n      <span class=\"lbl\">${esc(a.label)}</span></label>`).join('');\n    const healthRows=state.order.map((id,idx)=>{\n      const m=HEALTH[id]; const on=state.on.has(id); const isSort=id===sortId;\n      return `<div class=\"opt\">\n        <input type=\"checkbox\" data-health=\"${id}\" ${on?'checked':''}>\n        <span class=\"lbl\">${esc(m.label)}${m.isComposite?' <span class=\"k\">(of the rest)</span>':''}</span>\n        ${isSort?'<span class=\"sortbadge\">sort</span>':''}\n        <span class=\"ord\">\n          <button data-up=\"${id}\" ${idx===0?'disabled':''} title=\"Move up\">\u25b2</button>\n          <button data-down=\"${id}\" ${idx===state.order.length-1?'disabled':''} title=\"Move down\">\u25bc</button>\n        </span></div>`;\n    }).join('');\n    const sortLabel=sortId?HEALTH[sortId].label:null;\n    const sortLine = sortLabel\n      ? `Cards in each column are sorted by <b>${esc(sortLabel)}</b> \u2014 highest risk on top. Reorder to change the sort key.`\n      : `No health metric enabled, so columns keep Jira's order. Toggle one to sort by risk.`;\n    const dev = state.mode==='dev';\n    const modeCol=`\n      <div class=\"panel-col modeblock\"><h2>View mode</h2>\n        <div class=\"modeswitch\" role=\"group\" aria-label=\"View mode\">\n          <button data-mode=\"dev\" class=\"${dev?'active':''}\" aria-pressed=\"${dev}\">Dev mode</button>\n          <button data-mode=\"pm\" class=\"${!dev?'active':''}\" aria-pressed=\"${!dev}\">PM mode</button>\n        </div>\n        <div class=\"modehint\">${dev\n          ? 'Dev mode keeps the board focused on the work \u2014 health metrics and the risk summary are hidden.'\n          : 'PM mode adds the risk summary and lets you tune card details and health metrics.'}</div>\n      </div>`;\n    const pmGrid = dev ? '' : `\n      <div class=\"panel-grid\">\n        <div class=\"panel-col\"><h2>Card details</h2>${infoRows}</div>\n        <div class=\"panel-col\"><h2>Health metrics \u2014 drag order sets the sort</h2>${healthRows}\n          <div class=\"sortline\">${sortLine}</div></div>\n      </div>`;\n    document.getElementById('panel').innerHTML=modeCol+pmGrid;\n    wirePanel();\n  }\n  function wirePanel(){\n    const p=document.getElementById('panel');\n    p.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{\n      const m=b.getAttribute('data-mode')==='pm'?'pm':'dev';\n      if(m===state.mode) return;\n      captureModeSel(state.mode);   // remember this mode's selections\n      state.mode=m; applyModeSel(m); // restore the target mode's selections\n      writeState(); buildPanel(); render();\n    });\n    p.querySelectorAll('[data-info]').forEach(cb=>cb.onchange=()=>{\n      const id=cb.getAttribute('data-info'); cb.checked?state.info.add(id):state.info.delete(id);\n      writeState(); render(); });\n    p.querySelectorAll('[data-health]').forEach(cb=>cb.onchange=()=>{\n      const id=cb.getAttribute('data-health'); cb.checked?state.on.add(id):state.on.delete(id);\n      writeState(); buildPanel(); render(); });\n    p.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>move(b.getAttribute('data-up'),-1));\n    p.querySelectorAll('[data-down]').forEach(b=>b.onclick=()=>move(b.getAttribute('data-down'),1));\n  }\n  function move(id,dir){\n    const i=state.order.indexOf(id), j=i+dir;\n    if(j<0||j>=state.order.length) return;\n    [state.order[i],state.order[j]]=[state.order[j],state.order[i]];\n    writeState(); buildPanel(); render();\n  }\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 REFRESH (manual + on load + silent auto) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n  const btn=document.getElementById('refresh');\n  let refreshing=false;   // in-flight guard: never let two fetches overlap\n\n  /* Silent refresh must not disturb what the user is looking at, so we snapshot\n     scroll positions before the re-render and put them back afterwards. */\n  function captureScroll(){\n    const board=document.getElementById('board'); const cols={};\n    board.querySelectorAll('.column').forEach(sec=>{\n      const name=sec.querySelector('.column-head span'); const cards=sec.querySelector('.cards');\n      if(name&&cards) cols[name.textContent]=cards.scrollTop;\n    });\n    return {x:board.scrollLeft, cols};\n  }\n  function restoreScroll(s){\n    const board=document.getElementById('board'); board.scrollLeft=s.x;\n    board.querySelectorAll('.column').forEach(sec=>{\n      const name=sec.querySelector('.column-head span'); const cards=sec.querySelector('.cards');\n      if(name&&cards&&s.cols[name.textContent]!=null) cards.scrollTop=s.cols[name.textContent];\n    });\n  }\n\n  /* Data no longer comes from fetch(API_URL) \u2014 this board lives in a sandboxed\n     iframe. We post {rb-refresh} up to the userscript's page context (which holds\n     the real Jira session and does the REST calls) and wait for its {rb-data}\n     reply. Everything else (in-flight guard, silent mode, scroll preservation,\n     scrum-sync) is unchanged from the local-server build. */\n  function refreshData(opts){\n    const initial = !!(opts && opts.initial);\n    const silent  = !!(opts && opts.silent);   // background poll / on-click: no spinner, no status text, no scroll jump\n    if(refreshing) return Promise.resolve();     // a request is already running \u2014 let it finish\n    refreshing=true;\n    if(!silent) btn.classList.add('spinning');\n    if(initial) document.getElementById('meta').textContent = 'Loading live data\u2026';\n    const scroll = silent ? captureScroll() : null;\n    return new Promise((resolve)=>{\n      function onMsg(e){\n        const d=e.data;\n        if(!d || d.source!=='risk-board-host' || d.type!=='rb-data') return;\n        window.removeEventListener('message', onMsg);\n        let ok=true;\n        if(d.error){\n          ok=false; console.error('Board refresh failed:', d.error);\n          /* A silent poll never surfaces its own failure \u2014 it just keeps the last\n             good board on screen and tries again on the next tick/click. */\n          if(!silent) document.getElementById('meta').textContent = LIVE\n            ? 'Refresh failed \u2014 '+d.error+' (showing last data)'\n            : 'Live refresh failed \u2014 '+d.error;\n        } else {\n          LIVE=true;\n          const data=d.payload||{};\n          if(Array.isArray(data.issues)) ISSUES=data.issues;\n          if(Array.isArray(data.columns)&&data.columns.length) COLUMNS=data.columns;\n          if(data.riskCutoffs) RISK_CUTOFFS=data.riskCutoffs;\n          if(data.composite) COMPOSITE=data.composite;\n        }\n        /* On a failed silent poll there is no new data, so leave the board\n           completely untouched (no repaint, no timestamp change). */\n        if(ok || !silent){\n          /* keep scrum session in sync with refreshed data */\n          if(state.scrum && scrumSession){\n            const newDevs=collectDevelopers(ISSUES);\n            newDevs.forEach(dv=>{ if(!scrumSession.order.includes(dv)) scrumSession.order.push(dv); });\n            if(scrumSession.viewing && !newDevs.includes(scrumSession.viewing)) scrumSession.viewing=null;\n            if(scrumSession.current && !newDevs.includes(scrumSession.current)) scrumAction('next');\n          }\n          render();\n          if(scroll) restoreScroll(scroll);\n        }\n        if(!silent) setTimeout(()=>btn.classList.remove('spinning'),400);\n        refreshing=false;\n        resolve();\n      }\n      window.addEventListener('message', onMsg);\n      parent.postMessage({source:'risk-board', type:'rb-refresh', initial}, '*');\n    });\n  }\n  btn.addEventListener('click',()=>refreshData());\n\n  /* Silent auto-refresh: every 2 minutes, and on any click anywhere on the page.\n     Both go through refreshData({silent:true}) so nothing visible happens until\n     fresh data has actually arrived. The in-flight guard coalesces click bursts. */\n  const AUTO_REFRESH_MS = 120000;   // 2 minutes\n  function autoRefresh(){ refreshData({silent:true}); }\n  setInterval(autoRefresh, AUTO_REFRESH_MS);\n  document.addEventListener('click', e=>{\n    if(e.target.closest('#refresh')) return;   // let the manual button do its own visible (spinning) refresh\n    autoRefresh();\n  }, true);   // capture phase \u2192 fires for every click, even those handled by cards/buttons\n\n  /* night mode: reflect state on <html>, toggle from the header button */\n  function applyTheme(){\n    document.documentElement.setAttribute('data-theme', state.theme);\n    const t=document.getElementById('theme');\n    if(t){ const dark=state.theme==='dark';\n      t.textContent = dark?'\u2600\ufe0f':'\ud83c\udf19';\n      t.title = dark?'Switch to day mode':'Switch to night mode';\n      t.setAttribute('aria-label', t.title); }\n    if(state.card) renderModal();   // Flow-tab gradients bake in theme colours at render time\n  }\n  document.getElementById('theme').addEventListener('click',()=>{\n    state.theme = state.theme==='dark'?'light':'dark';\n    writeState(); applyTheme();\n  });\n\n  /* text search over ticket titles + IDs (board view) */\n  const searchEl=document.getElementById('search');\n  searchEl.value=state.search;\n  searchEl.addEventListener('input',()=>{ state.search=searchEl.value; writeState(); render(); });\n\n  /* customise toggle */\n  const cust=document.getElementById('customise');\n  cust.addEventListener('click',()=>{ const p=document.getElementById('panel');\n    const open=p.classList.toggle('open'); cust.setAttribute('aria-expanded',open); });\n\n  /* daily scrum toggle */\n  document.getElementById('dailyScrum').addEventListener('click',()=>{\n    if(state.scrum) exitScrum(); else enterScrum();\n  });\n\n  /* expanded-card close paths: backdrop click + Esc */\n  const overlayEl=document.getElementById('overlay');\n  overlayEl.addEventListener('click',e=>{ if(e.target===overlayEl) closeCard(); });\n  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ if(state.card) closeCard(); } });\n\n  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 modal helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n     History and trends views were removed from this distribution; the board is\n     the only view. These stubs keep the shared expanded-card modal code (which\n     was written to also serve the frozen sprint-history view) working: on the\n     board, cards are never frozen and always come from the live ISSUES set. */\n  function histFrozen(){ return false; }\n  function modalRecords(){ return ISSUES; }\n  function histCloseLabel(){ return ''; }\n\n  /* init */\n  readState(); applyTheme(); buildPanel();\n  if(state.card){ overlayEl.classList.add('open'); overlayEl.setAttribute('aria-hidden','false'); }  // deep link: ?card=KEY\n  refreshData({initial:true}).then(()=>{ if(state.scrum&&!scrumSession) enterScrum(); });\n</script>\n</body>\n</html>\n";

  /* ============================================================
   * HOST UI — floating launcher + full-screen overlay iframe.
   * The iframe's srcdoc is the entire board app (styles + markup + client
   * script), byte-identical to cdo-sites-comm-board.html except that its
   * "fetch a data URL" step is replaced by postMessage calls into this
   * page, which is where rbBuildBoard() (above) actually talks to Jira.
   *
   * Preferences (Customise panel choices, night mode, Dev/PM view) are
   * saved here in this page's localStorage — the iframe has no durable
   * storage of its own across reloads — and re-injected into the iframe
   * the next time it's built, so a browser refresh doesn't reset them.
   * Session-only state (filters, search, open card, scrum) intentionally
   * isn't saved; it still round-trips through the iframe's own URL as
   * before, just scoped to that iframe's lifetime.
   * ============================================================ */

  const RB_PREFS_KEY = "rb-prefs";

  function rbLoadPrefs() {
    try {
      const raw = localStorage.getItem(RB_PREFS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function rbSavePrefs(prefs) {
    try { localStorage.setItem(RB_PREFS_KEY, JSON.stringify(prefs || {})); } catch (e) {}
  }

  let rbIframe = null, rbOverlay = null;

  function rbOpenBoard() {
    if (!rbOverlay) rbBuildOverlay();
    rbOverlay.style.display = "flex";
  }
  function rbCloseBoard() {
    if (rbOverlay) rbOverlay.style.display = "none";
  }

  function rbBuildOverlay() {
    rbOverlay = document.createElement("div");
    rbOverlay.id = "rb-overlay-host";
    Object.assign(rbOverlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483000",
      background: "rgba(0,0,0,0.001)",   // effectively transparent; iframe paints its own bg
      display: "flex", flexDirection: "column",
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕ Close risk board";
    Object.assign(closeBtn.style, {
      position: "fixed", bottom: "20px", right: "20px", zIndex: "2147483001",
      font: "13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      fontWeight: "600", padding: "10px 16px", borderRadius: "999px",
      border: "2px solid #de350b", background: "#f4f5f7", color: "#172b4d", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(9,30,66,.35)",
    });
    closeBtn.onclick = rbCloseBoard;
    rbOverlay.appendChild(closeBtn);

    rbIframe = document.createElement("iframe");
    Object.assign(rbIframe.style, { flex: "1 1 auto", border: "none", width: "100%", height: "100%" });
    rbIframe.setAttribute("title", "Sprint Risk Board");

    // Bootstrap the iframe with previously-saved preferences by injecting a
    // tiny script right after <body>, before the board's own script block
    // runs its state initialization further down the same document.
    const savedPrefs = rbLoadPrefs();
    const bootstrap = "<script>window.__RB_SAVED_PREFS__ = " + JSON.stringify(savedPrefs || null) + ";<\/script>";
    rbIframe.srcdoc = RB_BOARD_HTML.replace("<body>", "<body>" + bootstrap);

    rbOverlay.appendChild(rbIframe);
    document.body.appendChild(rbOverlay);

    // Esc closes the overlay too (in addition to the iframe's own Esc
    // handling, which only closes the expanded-card modal inside it).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && rbOverlay && rbOverlay.style.display !== "none") rbCloseBoard();
    });
  }

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d.source !== "risk-board" || !rbIframe || e.source !== rbIframe.contentWindow) return;
    if (d.type === "rb-refresh") {
      try {
        const payload = await rbBuildBoard();
        rbIframe.contentWindow.postMessage({ source: "risk-board-host", type: "rb-data", payload }, "*");
      } catch (err) {
        rbIframe.contentWindow.postMessage({ source: "risk-board-host", type: "rb-data", error: String(err && err.message || err) }, "*");
      }
    } else if (d.type === "rb-prefs") {
      rbSavePrefs(d.prefs);
    }
  });

  function rbInjectLauncher() {
    const btn = document.createElement("button");
    btn.id = "rb-launcher";
    btn.textContent = "🎯 Risk Board";
    Object.assign(btn.style, {
      position: "fixed", bottom: "20px", right: "20px", zIndex: "2147483000",
      font: "13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      fontWeight: "600", padding: "10px 16px", borderRadius: "999px",
      border: "none", background: "#0052cc", color: "#fff", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(9,30,66,.35)",
    });
    btn.onclick = rbOpenBoard;
    document.body.appendChild(btn);
  }

  if (document.body) rbInjectLauncher();
  else document.addEventListener("DOMContentLoaded", rbInjectLauncher);

})();
