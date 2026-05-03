import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

// 14-day sparkline of sleep / clarity / dread / energy. Pure SVG, no chart lib.
//
// v0.3 — date axis, week-over-week delta per metric, insight callout,
// sparse-data fallback that still shows the latest value, click any sparkline
// to swap to a single-metric detail view.
const METRICS = [
  { key: "sleep",   label: "Sleep",   color: "#9bc4d6", positive: true  }, // soft sky
  { key: "clarity", label: "Clarity", color: "#7fc8a9", positive: true  }, // sage
  { key: "energy",  label: "Energy",  color: "#e8a23a", positive: true  }, // honey amber
  { key: "dread",   label: "Dread",   color: "#c4493b", positive: false }, // oxide red
];

export default function MoodTrend() {
  const [series, setSeries] = useState(null); // null = loading, [] = empty
  const [focus, setFocus] = useState(null);   // metric key shown in detail
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = (await api.checkins.last(14)) || [];
        if (!cancelled) setSeries(rows);
      } catch {
        if (!cancelled) setSeries([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Compute derived values unconditionally so hook order is stable.
  const ordered = useMemo(() => (series || []).slice().reverse(), [series]);
  const insight = useMemo(() => buildInsight(ordered, METRICS), [ordered]);

  if (series === null) {
    return (
      <div className="card">
        <div className="card-title">Mood trend · 14d</div>
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (!series.length) {
    return (
      <div className="card">
        <div className="card-title">Mood trend · 14d</div>
        <div className="muted">
          No check-ins yet. Fill one on the Dashboard — trends appear after two
          days.
        </div>
      </div>
    );
  }

  const metrics = METRICS;
  const startLabel = fmtDay(ordered[0]?.day);
  const endLabel   = fmtDay(ordered[ordered.length - 1]?.day);

  if (focus) {
    const m = metrics.find((x) => x.key === focus);
    return (
      <div className="card mood-trend">
        <div className="row between" style={{ alignItems: "center" }}>
          <div className="card-title" style={{ margin: 0 }}>
            {m.label} · last {ordered.length}d
          </div>
          <button className="ghost small" onClick={() => setFocus(null)}>
            ← all metrics
          </button>
        </div>
        <BigSpark
          values={ordered.map((r) => r[m.key])}
          days={ordered.map((r) => r.day)}
          color={m.color}
        />
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {startLabel} → {endLabel}
        </div>
      </div>
    );
  }

  return (
    <div className="card mood-trend">
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>
            Mood trend · 14d
          </div>
          <small className="muted">
            {startLabel} → {endLabel} · {ordered.length} day{ordered.length === 1 ? "" : "s"} logged
          </small>
        </div>
      </div>

      {insight && (
        <div className="mood-insight" style={{
          marginTop: 10,
          padding: "8px 12px",
          background: "var(--bg-elev-2)",
          borderLeft: `3px solid ${insight.color}`,
          borderRadius: 6,
          fontSize: 13,
        }}>
          {insight.text}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {metrics.map((m) => {
          const values = ordered.map((r) => r[m.key]);
          const last  = lastValid(values);
          const delta = weekDelta(ordered, m.key, m.positive);
          return (
            <div
              key={m.key}
              role="button"
              tabIndex={0}
              onClick={() => setFocus(m.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setFocus(m.key); }}
              style={{
                display: "grid",
                gridTemplateColumns: "84px 1fr 78px",
                alignItems: "center",
                gap: 10,
                margin: "10px 0",
                cursor: "pointer",
                padding: "4px 4px",
                borderRadius: 6,
              }}
              className="mood-row"
              title={`Click to focus on ${m.label}`}
            >
              <div className="muted" style={{ fontSize: 12 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: m.color, marginRight: 6 }} />
                {m.label}
              </div>
              <Spark values={values} color={m.color} />
              <div style={{ textAlign: "right", fontSize: 12, lineHeight: 1.2 }}>
                <div style={{ color: "var(--text)", fontWeight: 500 }}>
                  {last == null ? "—" : last.toFixed(1)}
                  <span className="muted" style={{ fontSize: 10 }}> /10</span>
                </div>
                {delta && (
                  <div style={{ color: delta.color, fontSize: 11 }}>
                    {delta.label}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtDay(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(+dt)) return d;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (typeof arr[i] === "number") return arr[i];
  return null;
}

function avg(arr) {
  const clean = arr.filter((v) => typeof v === "number");
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

// Compare last 7 days vs the previous 7. Returns { label, color } or null.
function weekDelta(rows, key, positive) {
  if (rows.length < 4) return null;
  const recent = rows.slice(-7).map((r) => r[key]);
  const prior  = rows.slice(0, Math.max(0, rows.length - 7)).map((r) => r[key]);
  const a = avg(recent);
  const b = avg(prior);
  if (a == null || b == null) return null;
  const d = a - b;
  if (Math.abs(d) < 0.25) return { label: "→ stable", color: "var(--text-dim)" };
  const better = positive ? d > 0 : d < 0;
  const arrow  = d > 0 ? "↑" : "↓";
  return {
    label: `${arrow} ${Math.abs(d).toFixed(1)}`,
    color: better ? "var(--productive, #7FD99E)" : "var(--distraction, #E8806B)",
  };
}

// Pick the single most striking change to surface as an insight. Pure helper
// (no hooks) so the parent can call it inside its own useMemo.
function buildInsight(rows, metrics) {
  if (!rows || rows.length < 4) return null;
  let best = null;
  for (const m of metrics) {
    const d = weekDelta(rows, m.key, m.positive);
    if (!d) continue;
    const num = parseFloat(d.label.replace(/[^\d.]/g, "")) || 0;
    if (num < 0.5) continue;
    if (!best || num > best.num) best = { ...m, delta: d, num };
  }
  if (!best) return null;
  const direction = best.delta.label.startsWith("↑") ? "up" : "down";
  const goodish = best.delta.color.includes("productive") || best.delta.color.includes("7FD99E");
  return {
    color: best.color,
    text: goodish
      ? `${best.label} is trending ${direction} this week — keep doing what you're doing.`
      : `${best.label} dipped this week. Worth a look.`,
  };
}

function Spark({ values, color }) {
  const W = 260, H = 36, pad = 3;
  const vs = values.map((v) => (typeof v === "number" ? v : null));
  const valid = vs.filter((v) => v != null);

  if (valid.length === 0) {
    return <div style={{ height: H, color: "var(--text-faint)", fontSize: 11, lineHeight: H + "px" }}>no data</div>;
  }
  if (valid.length === 1) {
    // Single-day case: show a horizontal pip + value text.
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} stroke="var(--border)" strokeDasharray="2 3" />
        <circle cx={W - pad - 8} cy={H / 2} r="3" fill={color} />
      </svg>
    );
  }

  const min = 1, max = 10;
  const step = (W - pad * 2) / (vs.length - 1);
  const points = [];
  vs.forEach((v, i) => {
    if (v == null) return;
    const x = pad + i * step;
    const y = H - pad - ((v - min) / (max - min)) * (H - pad * 2);
    points.push([x, y]);
  });
  const d = points.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const fill = points.length
    ? `${d} L${points[points.length - 1][0]},${H - pad} L${points[0][0]},${H - pad} Z`
    : "";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={fill} fill={color} opacity="0.14" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === points.length - 1 ? 2.4 : 1.4} fill={color} />
      ))}
    </svg>
  );
}

// Larger, labeled chart for the focused-metric view.
function BigSpark({ values, days, color }) {
  const W = 600, H = 140, padX = 30, padTop = 10, padBot = 24;
  const vs = values.map((v) => (typeof v === "number" ? v : null));
  const valid = vs.filter((v) => v != null);
  if (!valid.length) return <div className="muted">No data</div>;
  const min = 1, max = 10;
  const step = vs.length > 1 ? (W - padX * 2) / (vs.length - 1) : 0;
  const ys = (v) => H - padBot - ((v - min) / (max - min)) * (H - padTop - padBot);
  const points = [];
  vs.forEach((v, i) => {
    if (v == null) return;
    points.push([padX + i * step, ys(v), v, days[i]]);
  });
  const d = points.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const fill = `${d} L${points[points.length - 1][0]},${H - padBot} L${points[0][0]},${H - padBot} Z`;
  // Y gridlines at 3 / 5 / 8
  const grid = [3, 5, 8];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ marginTop: 10 }}>
      {grid.map((g) => (
        <g key={g}>
          <line x1={padX} x2={W - padX} y1={ys(g)} y2={ys(g)} stroke="var(--border)" strokeDasharray="2 3" />
          <text x={4} y={ys(g) + 3} fontSize="10" fill="var(--text-dim)">{g}</text>
        </g>
      ))}
      <path d={fill} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map(([x, y, v, day], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="2.6" fill={color} />
          <title>{`${day}: ${v}`}</title>
        </g>
      ))}
      {/* X axis labels — first, middle, last */}
      {[0, Math.floor(points.length / 2), points.length - 1].filter((i, idx, arr) => arr.indexOf(i) === idx).map((i) => (
        <text key={i} x={points[i][0]} y={H - 6} fontSize="10" fill="var(--text-dim)" textAnchor="middle">
          {fmtDay(points[i][3])}
        </text>
      ))}
    </svg>
  );
}
