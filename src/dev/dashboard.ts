export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tend — Household Routine Intelligence</title>
  <meta name="description" content="Tend dashboard for explainable household routine deviations.">
  <style>
    :root {
      --bg: #f4f7fb;
      --surface: #ffffff;
      --surface-muted: #f8fafc;
      --text: #172033;
      --muted: #647084;
      --line: #dfe6ef;
      --accent: #2f6fed;
      --accent-2: #5a7dff;
      --good: #18895f;
      --good-bg: #eaf8f1;
      --warn: #aa6a08;
      --warn-bg: #fff6df;
      --alert: #bc4a3e;
      --alert-bg: #fff0ee;
      --shadow: 0 20px 55px rgba(23, 32, 51, 0.08);
      --radius: 18px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(90,125,255,.09), transparent 34%),
        var(--bg);
    }

    button, select { font: inherit; }

    .app {
      max-width: 1320px;
      margin: 0 auto;
      padding: 28px 22px 48px;
    }

    .topbar {
      display: flex;
      gap: 18px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 22px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .logo {
      width: 48px;
      height: 48px;
      border-radius: 15px;
      display: grid;
      place-items: center;
      color: white;
      font-weight: 800;
      letter-spacing: .02em;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 12px 24px rgba(47, 111, 237, .23);
    }

    .brand h1 {
      font-size: 23px;
      margin: 0;
      letter-spacing: -.03em;
    }

    .brand p {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .select, .btn {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--text);
      border-radius: 12px;
      height: 42px;
      padding: 0 14px;
      cursor: pointer;
      transition: .18s ease;
    }

    .btn {
      font-weight: 700;
    }

    .btn:hover, .select:hover {
      border-color: #b9c8dc;
      transform: translateY(-1px);
    }

    .hero {
      background: linear-gradient(135deg, #13213e 0%, #1c2f54 58%, #27486e 100%);
      color: white;
      padding: 24px;
      border-radius: 24px;
      box-shadow: var(--shadow);
      margin-bottom: 18px;
    }

    .hero-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
    }

    .hero h2 {
      margin: 0 0 8px;
      font-size: clamp(26px, 4vw, 37px);
      line-height: 1.06;
      letter-spacing: -.035em;
      max-width: 720px;
    }

    .hero p {
      margin: 0;
      color: rgba(255,255,255,.78);
      max-width: 700px;
      line-height: 1.6;
      font-size: 14px;
    }

    .provider {
      border: 1px solid rgba(255,255,255,.17);
      background: rgba(255,255,255,.08);
      padding: 10px 13px;
      border-radius: 12px;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .08em;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0,1fr));
      gap: 16px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: 0 8px 24px rgba(23,32,51,.045);
      overflow: hidden;
    }

    .card-pad { padding: 18px; }

    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }

    .kicker {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
      font-weight: 800;
      margin-bottom: 7px;
    }

    .metric {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -.04em;
      margin: 0;
    }

    .metric-sub {
      margin: 6px 0 0;
      font-size: 13px;
      color: var(--muted);
    }

    .severity {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 8px 11px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
    }

    .severity.NORMAL { color: var(--good); background: var(--good-bg); }
    .severity.LOW { color: var(--warn); background: var(--warn-bg); }
    .severity.MODERATE, .severity.HIGH { color: var(--alert); background: var(--alert-bg); }

    .score {
      display: flex;
      align-items: center;
      gap: 18px;
    }

    .score-ring {
      width: 92px;
      height: 92px;
      border-radius: 50%;
      padding: 8px;
      background: conic-gradient(var(--accent) calc(var(--score-pct) * 1%), #e9eef5 0);
      flex: 0 0 auto;
    }

    .score-ring-inner {
      width: 100%;
      height: 100%;
      background: white;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-size: 18px;
      font-weight: 800;
    }

    .signal-list { display: grid; gap: 12px; margin-top: 8px; }

    .signal {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
    }

    .signal-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .bar {
      height: 7px;
      background: #edf1f6;
      border-radius: 999px;
      overflow: hidden;
    }

    .bar > span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      width: var(--value);
    }

    .signal-value {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }

    .explanation {
      font-size: 18px;
      line-height: 1.55;
      letter-spacing: -.015em;
      margin: 8px 0 14px;
    }

    .recommendation {
      display: inline-flex;
      padding: 9px 12px;
      border-radius: 12px;
      background: var(--surface-muted);
      color: var(--text);
      border: 1px solid var(--line);
      font-size: 12px;
      font-weight: 800;
    }

    .evidence {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    .evidence-item {
      border: 1px solid var(--line);
      background: var(--surface-muted);
      border-radius: 13px;
      padding: 12px;
    }

    .evidence-item strong {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
    }

    .evidence-item p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }

    .events {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .events th, .events td {
      text-align: left;
      padding: 11px 10px;
      border-bottom: 1px solid var(--line);
    }

    .events th {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }

    .events td {
      vertical-align: top;
    }

    .source-tag {
      display: inline-flex;
      padding: 5px 8px;
      border-radius: 999px;
      background: #eef3ff;
      color: #3959a7;
      font-weight: 700;
    }

    .feedback {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .feedback .btn {
      width: 100%;
    }

    .btn-primary {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }

    .btn-primary:hover { background: #255fd2; border-color: #255fd2; }

    .notice {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
      margin-top: 11px;
    }

    .footer {
      padding: 16px 4px 0;
      color: var(--muted);
      font-size: 11px;
      text-align: center;
    }

    .empty {
      color: var(--muted);
      padding: 18px 0;
      text-align: center;
      font-size: 13px;
    }

    .loading {
      opacity: .7;
      pointer-events: none;
    }

    @media (max-width: 1050px) {
      .span-3, .span-4, .span-5, .span-7, .span-8 { grid-column: span 6; }
      .span-12 { grid-column: span 12; }
    }

    @media (max-width: 720px) {
      .app { padding: 18px 12px 34px; }
      .topbar, .hero-row { flex-direction: column; align-items: stretch; }
      .toolbar { justify-content: flex-start; }
      .span-3, .span-4, .span-5, .span-7, .span-8, .span-12 { grid-column: span 12; }
      .feedback { grid-template-columns: 1fr; }
      .events { min-width: 640px; }
      .events-wrap { overflow-x: auto; }
    }

    /* Final-release visual refinement: calm, readable, mobile-first. */
    :root {
      --bg: #f5f6f3; --surface: #fff; --surface-muted: #f7f8f5;
      --text: #202923; --muted: #66736a; --line: #e1e7e0;
      --accent: #27745b; --accent-2: #69a58a; --good: #26724f;
      --good-bg: #eaf5ed; --warn: #95651d; --warn-bg: #fbf2df;
      --alert: #a8423c; --alert-bg: #f9ecea;
      --shadow: 0 12px 32px rgba(25,43,32,.055); --radius: 18px;
    }
    body { background: var(--bg); letter-spacing: -.005em; }
    .app { max-width: 1180px; padding: 30px 24px 42px; }
    .topbar { margin-bottom: 24px; }
    .logo { background: #244d3b; border-radius: 14px; box-shadow: none; }
    .brand h1 { font-size: 25px; letter-spacing: -.04em; }
    .select, .btn { border-radius: 10px; height: 44px; }
    .btn { font-weight: 650; }
    .btn:hover, .select:hover { transform: none; border-color: #aebdb2; }
    .btn-primary, .btn-primary:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
    .hero { background: #eaf1eb; color: var(--text); border: 1px solid #dce7dd; box-shadow: none; padding: 28px; border-radius: 20px; margin-bottom: 20px; }
    .hero .kicker { color: #617466 !important; }
    .hero h2 { max-width: 760px; font-size: clamp(25px,3.2vw,34px); line-height: 1.16; }
    .hero p { color: #5c6b60; }
    .provider { background: #fff; color: #345b45; border: 1px solid #d7e3d8; letter-spacing: .025em; text-transform: none; white-space: normal; line-height: 1.4; }
    .card { border-color: var(--line); box-shadow: 0 3px 14px rgba(25,43,32,.025); border-radius: 16px; }
    .card-pad { padding: 20px; }
    .kicker { letter-spacing: .075em; font-size: 10px; }
    .metric { font-size: 30px; }
    .metric-sub { line-height: 1.5; }
    .score-ring { background: conic-gradient(var(--accent) calc(var(--score-pct) * 1%), #e6ece6 0); }
    .bar { background: #edf1ed; }
    .bar > span { background: var(--accent); }
    .explanation { font-size: 17px; line-height: 1.6; }
    .recommendation { background: #f1f5f0; border-color: #dce6dc; font-weight: 650; line-height: 1.45; }
    .evidence-item { background: #fafbf9; border-radius: 11px; }
    .events { font-size: 12px; }
    .events th { letter-spacing: .055em; }
    .source-tag { background: #edf4ef; color: #345d46; white-space: nowrap; }
    .feedback .btn { min-height: 44px; }
    .notice { font-size: 12px; line-height: 1.55; }
    .footer { font-size: 12px; line-height: 1.6; }
    @media (max-width: 720px) {
      .app { padding: 16px 12px 28px; }
      .topbar { gap: 14px; }
      .toolbar { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }
      .toolbar .select { grid-column: 1 / -1; width: 100%; }
      .toolbar .btn { width: 100%; padding: 0 12px; }
      .hero { padding: 20px 18px; border-radius: 16px; }
      .hero-row { gap: 14px; }
      .hero h2 { font-size: 25px; line-height: 1.2; }
      .provider { align-self: flex-start; max-width: 100%; }
      .grid { gap: 12px; }
      .card-pad { padding: 16px; }
      .metric { font-size: 28px; }
      .score { align-items: flex-start; gap: 14px; }
      .score-ring { width: 76px; height: 76px; padding: 7px; }
      .score-ring-inner { font-size: 15px; }
      .events { min-width: 0; table-layout: fixed; }
      .events th, .events td { padding: 9px 6px; overflow-wrap: anywhere; }
      .events th:nth-child(2), .events td:nth-child(2), .events th:nth-child(4), .events td:nth-child(4) { display: none; }
      .events th:nth-child(1), .events td:nth-child(1) { width: 25%; }
      .events th:nth-child(3), .events td:nth-child(3) { width: 75%; }
      .feedback { grid-template-columns: 1fr 1fr; gap: 8px; }
      .feedback .btn { white-space: normal; height: auto; min-height: 44px; padding: 8px; }
    }

  </style>
</head>
<body>
  <main class="app" id="app">
    <header class="topbar">
      <div class="brand">
        <div class="logo">T</div>
        <div>
          <h1>Tend</h1>
          <p>Explainable household routine intelligence</p>
        </div>
      </div>
      <div class="toolbar">
        <select id="scenario" class="select" aria-label="Scenario">
          <option value="deviation_missing">Deviation — missing activity</option>
          <option value="normal">Normal routine</option>
          <option value="variable_normal">Variable but normal</option>
          <option value="sequence_deviation">Deviation — sequence change</option>
        </select>
        <button id="apply" class="btn btn-primary">Run scenario</button>
        <button id="refresh" class="btn">Refresh</button>
      </div>
    </header>

    <section class="hero">
      <div class="hero-row">
        <div>
          <div class="kicker" style="color:#617466">Household overview · local demo</div>
          <h2 id="heroTitle">Today's activity is being compared with the household's learned routine.</h2>
          <p id="heroSub">Loading Tend's local development data…</p>
        </div>
        <div class="provider" id="provider">Provider: loading</div>
      </div>
    </section>

    <section class="grid">
      <article class="card span-3">
        <div class="card-pad">
          <div class="kicker">Baseline confidence</div>
          <p class="metric" id="confidence">—</p>
          <p class="metric-sub" id="baselineMeta">How much history supports this baseline</p>
        </div>
      </article>

      <article class="card span-3">
        <div class="card-pad">
          <div class="kicker">Deviation severity</div>
          <div id="severity"></div>
          <p class="metric-sub" id="severityMeta">Confidence in this assessment</p>
        </div>
      </article>

      <article class="card span-3">
        <div class="card-pad">
          <div class="kicker">Deviation score</div>
          <p class="metric" id="score">—</p>
          <p class="metric-sub">Calculated by Tend's rules</p>
        </div>
      </article>

      <article class="card span-3">
        <div class="card-pad">
          <div class="kicker">Recent events</div>
          <p class="metric" id="eventCount">—</p>
          <p class="metric-sub">Activity records used in the demo</p>
        </div>
      </article>

      <article class="card span-5">
        <div class="card-pad">
          <div class="kicker">What contributed to the result?</div>
          <div class="score">
            <div class="score-ring" id="scoreRing" style="--score-pct:0">
              <div class="score-ring-inner" id="scoreRingValue">0</div>
            </div>
            <div>
              <div class="signal-list">
                <div class="signal">
                  <div>
                    <div class="signal-title">Presence</div>
                    <div class="bar"><span id="presenceBar" style="--value:0%"></span></div>
                  </div>
                  <div class="signal-value" id="presenceValue">0.00</div>
                </div>
                <div class="signal">
                  <div>
                    <div class="signal-title">Timing</div>
                    <div class="bar"><span id="timingBar" style="--value:0%"></span></div>
                  </div>
                  <div class="signal-value" id="timingValue">0.00</div>
                </div>
                <div class="signal">
                  <div>
                    <div class="signal-title">Sequence</div>
                    <div class="bar"><span id="sequenceBar" style="--value:0%"></span></div>
                  </div>
                  <div class="signal-value" id="sequenceValue">0.00</div>
                </div>
              </div>
            </div>
          </div>
          <div class="notice">Tend calculates the result first. The optional language model can explain it, but cannot change the score or severity.</div>
        </div>
      </article>

      <article class="card span-7">
        <div class="card-pad">
          <div class="kicker">Why this result?</div>
          <p class="explanation" id="explanation">Loading explanation…</p>
          <div class="recommendation" id="recommendation">—</div>
          <div class="kicker" style="margin-top:18px">Evidence</div>
          <div class="evidence" id="evidence"></div>
        </div>
      </article>

      <article class="card span-7">
        <div class="card-pad">
          <div class="kicker">Recent activity (demo data)</div>
          <div class="events-wrap">
            <table class="events">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Zone</th>
                  <th>Event</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody id="events"></tbody>
            </table>
          </div>
        </div>
      </article>

      <article class="card span-5">
        <div class="card-pad">
          <div class="kicker">Caregiver feedback</div>
          <div class="feedback">
            <button class="btn btn-primary" data-feedback="expected">Expected</button>
            <button class="btn" data-feedback="keep_watching">Keep watching</button>
            <button class="btn" data-feedback="not_useful">Not useful</button>
            <button class="btn" data-feedback="unusual">Unusual</button>
          </div>
          <div class="notice">Your feedback is recorded in this local demo and can adjust signal sensitivity.</div>
          <div class="kicker" style="margin-top:20px">Demo household</div>
          <div id="household" style="font-size:14px;font-weight:700">—</div>
          <div class="notice" id="updated">—</div>
        </div>
      </article>
    </section>

    <div class="footer">
      Tend · Local demonstration environment · Activity is simulated, not live household data.
    </div>
  </main>

  <script>
    (function () {
      const byId = (id) => document.getElementById(id);
      const app = byId("app");

      function number(value) {
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      }

      function pct(value, max) {
        if (!max || max <= 0) return 0;
        return Math.max(0, Math.min(100, (value / max) * 100));
      }

      function formatTime(iso) {
        try {
          return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        } catch (_) {
          return iso;
        }
      }

      function escapeHtml(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      function evidenceText(item) {
        const bits = [];
        if (item.expectedWindow) bits.push("Expected " + item.expectedWindow);
        if (typeof item.observed === "boolean") bits.push(item.observed ? "Observed" : "Not observed");
        if (typeof item.observed === "string") bits.push("Observed: " + item.observed);
        if (typeof item.minutesPastWindow === "number") bits.push(item.minutesPastWindow + " min past window");
        bits.push("Confidence " + Math.round(number(item.confidence) * 100) + "%");
        return bits.join(" · ");
      }

      function render(data) {
        const deviation = data.deviation || {};
        const baseline = data.baseline || {};
        const reasoning = data.reasoning || {};
        const events = Array.isArray(data.recentEvents) ? data.recentEvents : [];
        const evidence = Array.isArray(deviation.evidence) ? deviation.evidence : [];

        const severity = String(deviation.severity || "NORMAL");
        const score = number(deviation.compositeScore);

        byId("heroTitle").textContent =
          severity === "NORMAL"
            ? "Today's activity is consistent with the household's learned routine."
            : "Today's activity differs from the household's recent routine.";

        byId("heroSub").textContent =
          "Scenario: " + String(data.scenario || "unknown").replace(/_/g, " ") +
          " · Demo date " + String(data.todayIso || "").slice(0, 10) +
          " · Simulated household";

        byId("provider").textContent =
          (data.reasoningProvider === "bedrock" ? "Explanation: Amazon Bedrock" : "Explanation: built-in template");

        byId("confidence").textContent =
          Math.round(number(baseline.confidence) * 100) + "%";

        byId("baselineMeta").textContent =
          String(baseline.daysObserved || 0) + " days observed · " +
          String(baseline.windowDays || 0) + "-day window";

        byId("severity").innerHTML =
          '<span class="severity ' + escapeHtml(severity) + '"><span>●</span>' +
          escapeHtml(severity) + "</span>";

        byId("severityMeta").textContent =
          "Result confidence " + Math.round(number(deviation.confidence) * 100) + "%";

        byId("score").textContent = score.toFixed(2);
        byId("eventCount").textContent = String(events.length);

        const ringPct = pct(score, 4);
        byId("scoreRing").style.setProperty("--score-pct", String(ringPct));
        byId("scoreRingValue").textContent = score.toFixed(2);

        const presence = number(deviation.presenceDeviation);
        const timing = number(deviation.timingDeviation);
        const sequence = number(deviation.sequenceDeviation);

        byId("presenceValue").textContent = presence.toFixed(2);
        byId("timingValue").textContent = timing.toFixed(2);
        byId("sequenceValue").textContent = sequence.toFixed(2);

        byId("presenceBar").style.setProperty("--value", pct(presence, 4) + "%");
        byId("timingBar").style.setProperty("--value", pct(timing, 4) + "%");
        byId("sequenceBar").style.setProperty("--value", pct(sequence, 1) + "%");

        byId("explanation").textContent =
          reasoning.explanation || "No explanation is available.";

        byId("recommendation").textContent =
          reasoning.recommendedWording || "No recommendation";

        byId("evidence").innerHTML = evidence.length
          ? evidence.map(function (item) {
              return '<div class="evidence-item">' +
                '<strong>' + escapeHtml(item.signal || "evidence") + '</strong>' +
                '<p>' + escapeHtml(evidenceText(item)) + '</p>' +
              '</div>';
            }).join("")
          : '<div class="empty">No deviation evidence was generated for this scenario.</div>';

        byId("events").innerHTML = events.length
          ? events.slice(-12).reverse().map(function (event) {
              const zone = event.zoneId || event.deviceId || "—";
              const eventType = [event.eventType, event.subType].filter(Boolean).join(" / ").replace(/_/g, " ");
              return "<tr>" +
                "<td>" + escapeHtml(formatTime(event.occurredAt)) + "</td>" +
                "<td>" + escapeHtml(zone) + "</td>" +
                "<td>" + escapeHtml(eventType || "event") + "</td>" +
                '<td><span class="source-tag">' + escapeHtml(event.source === "dev_simulator" ? "Demo simulator" : (event.source || "unknown").replace(/_/g, " ")) + "</span></td>" +
              "</tr>";
            }).join("")
          : '<tr><td colspan="4" class="empty">No events available.</td></tr>';

        byId("household").textContent = baseline.householdId || "unknown";
        byId("updated").textContent =
          "Last event folded into baseline: " + (baseline.lastUpdatedAt ? formatTime(baseline.lastUpdatedAt) : "—");
      }

      async function load() {
        app.classList.add("loading");
        try {
          const response = await fetch("/demo", { cache: "no-store" });
          if (!response.ok) throw new Error("Unable to load /demo");
          const data = await response.json();
          render(data);
          const selected = data.scenario;
          if (selected) byId("scenario").value = selected;
        } catch (error) {
          byId("heroTitle").textContent = "Tend dashboard could not load the demo state.";
          byId("heroSub").textContent = error && error.message ? error.message : "Unknown error";
        } finally {
          app.classList.remove("loading");
        }
      }

      async function runScenario() {
        const scenario = byId("scenario").value;
        app.classList.add("loading");
        try {
          const response = await fetch("/scenario", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario: scenario })
          });
          if (!response.ok) throw new Error("Scenario request failed");
          render(await response.json());
        } catch (error) {
          alert(error && error.message ? error.message : "Scenario request failed");
        } finally {
          app.classList.remove("loading");
        }
      }

      async function sendFeedback(feedbackType) {
        app.classList.add("loading");
        try {
          const dataResponse = await fetch("/demo", { cache: "no-store" });
          const data = await dataResponse.json();
          const signals = data.deviation && Array.isArray(data.deviation.evidence)
            ? data.deviation.evidence.map(function (item) { return item.signal; })
            : [];

          const response = await fetch("/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              feedbackType: feedbackType,
              signals: signals
            })
          });

          if (!response.ok) throw new Error("Feedback request failed");
          await load();
        } catch (error) {
          alert(error && error.message ? error.message : "Feedback request failed");
        } finally {
          app.classList.remove("loading");
        }
      }

      byId("apply").addEventListener("click", runScenario);
      byId("refresh").addEventListener("click", load);

      Array.from(document.querySelectorAll("[data-feedback]")).forEach(function (button) {
        button.addEventListener("click", function () {
          sendFeedback(button.getAttribute("data-feedback"));
        });
      });

      load();
    }());
  </script>
</body>
</html>`;