import React, { useEffect, useState } from "react";
import api from "../lib/api.js";
import { todayISO } from "../lib/date.js";

// Manual time entry + today's totals. The v0.2 desktop tracker will
// write into the same table automatically.
export default function TimeLog() {
  const [entries, setEntries] = useState([]);
  const [totals, setTotals] = useState({
    productive: 0,
    distraction: 0,
    neutral: 0,
    total: 0,
  });
  const [form, setForm] = useState({
    app_name: "",
    category: "productive",
    minutes: 30,
    note: "",
  });

  async function reload() {
    const [e, t] = await Promise.all([
      api.activity.list({ days: 3 }),
      api.activity.todayTotals(),
    ]);
    setEntries(e);
    setTotals(t);
  }
  useEffect(() => {
    reload();
  }, []);

  async function add() {
    if (!form.minutes || form.minutes <= 0) return;
    await api.activity.add({ ...form, date: todayISO() });
    setForm({ ...form, app_name: "", minutes: 30, note: "" });
    reload();
  }
  async function remove(id) {
    await api.activity.delete(id);
    reload();
  }

  const pProd = totals.total ? (totals.productive / totals.total) * 100 : 0;
  const pDist = totals.total ? (totals.distraction / totals.total) * 100 : 0;

  return (
    <div className="card">
      <div className="row between">
        <div className="card-title" style={{ margin: 0 }}>
          Today&apos;s time
        </div>
        <div className="row" style={{ gap: 14 }}>
          <span className="pill teal">Productive {totals.productive}m</span>
          <span className="pill rose">Distraction {totals.distraction}m</span>
          <span className="pill gray">Neutral {totals.neutral}m</span>
        </div>
      </div>

      {totals.total > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `${pProd}% ${pDist}% 1fr`,
            height: 8,
            borderRadius: 999,
            overflow: "hidden",
            marginTop: 10,
            background: "var(--bg-elev-2)",
          }}
        >
          <div style={{ background: "var(--ok)" }} />
          <div style={{ background: "var(--bad)" }} />
          <div />
        </div>
      )}

      <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="What (e.g. LC practice, YouTube)"
          value={form.app_name}
          onChange={(e) => setForm({ ...form, app_name: e.target.value })}
          style={{ flex: "1 1 200px" }}
        />
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          style={{ width: 150 }}
        >
          <option value="productive">productive</option>
          <option value="distraction">distraction</option>
          <option value="neutral">neutral</option>
        </select>
        <input
          type="number"
          min={5}
          step={5}
          value={form.minutes}
          onChange={(e) => setForm({ ...form, minutes: +e.target.value })}
          style={{ width: 90 }}
        />
        <button className="primary" onClick={add}>
          + Log
        </button>
      </div>

      {entries.length > 0 && (
        <>
          <hr className="soft" />
          <div className="section-label">Recent entries</div>
          {entries.slice(0, 6).map((e) => (
            <div key={e.id} className="todo-row">
              <div style={{ flex: 1 }}>
                <div className="title">{e.app_name || "(untitled)"}</div>
                <div className="sub">
                  {e.date} ·{" "}
                  <span
                    className={
                      "pill " +
                      (e.category === "productive"
                        ? "teal"
                        : e.category === "distraction"
                          ? "rose"
                          : "gray")
                    }
                  >
                    {e.category}
                  </span>{" "}
                  · {e.minutes}m{e.note && <> · {e.note}</>}
                </div>
              </div>
              <button className="ghost" onClick={() => remove(e.id)}>
                ✕
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
