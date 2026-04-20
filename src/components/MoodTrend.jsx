import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

// 14-day sparkline of sleep / clarity / dread / energy. Pure SVG, no chart lib.
export default function MoodTrend() {
  const [series, setSeries] = useState([]);
  useEffect(() => {
    (async () => setSeries(await api.checkins.last(14)))();
  }, []);

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

  const ordered = [...series].reverse(); // oldest -> newest
  const metrics = [
    { key: "sleep", label: "Sleep", color: "#7c7cff" },
    { key: "clarity", label: "Clarity", color: "#4ecdc4" },
    { key: "energy", label: "Energy", color: "#7aa9ff" },
    { key: "dread", label: "Dread", color: "#ef6b5a" },
  ];

  return (
    <div className="card">
      <div className="row between">
        <div className="card-title" style={{ margin: 0 }}>
          Mood trend · 14d
        </div>
        <small className="hint">{ordered.length} day(s) logged</small>
      </div>
      <div style={{ marginTop: 12 }}>
        {metrics.map((m) => (
          <div
            key={m.key}
            style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr 40px",
              alignItems: "center",
              gap: 10,
              margin: "8px 0",
            }}
          >
            <div className="muted" style={{ fontSize: 12 }}>
              {m.label}
            </div>
            <Spark values={ordered.map((r) => r[m.key])} color={m.color} />
            <div className="muted" style={{ textAlign: "right", fontSize: 12 }}>
              {avg(ordered.map((r) => r[m.key])).toFixed(1)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function avg(arr) {
  const clean = arr.filter((v) => typeof v === "number");
  if (!clean.length) return 0;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function Spark({ values, color }) {
  const W = 280,
    H = 36,
    pad = 2;
  const vs = values.filter((v) => typeof v === "number");
  if (vs.length < 2)
    return (
      <div
        style={{
          height: H,
          color: "var(--text-faint)",
          fontSize: 11,
          lineHeight: H + "px",
        }}
      >
        need 2+ days
      </div>
    );
  const min = 1,
    max = 10;
  const step = (W - pad * 2) / (vs.length - 1);
  const points = vs.map((v, i) => {
    const x = pad + i * step;
    const y = H - pad - ((v - min) / (max - min)) * (H - pad * 2);
    return [x, y];
  });
  const d = points
    .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
    .join(" ");
  const fill = points.length
    ? `${d} L${points[points.length - 1][0]},${H - pad} L${points[0][0]},${H - pad} Z`
    : "";
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
    >
      <path d={fill} fill={color} opacity="0.12" />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.6" fill={color} />
      ))}
    </svg>
  );
}
