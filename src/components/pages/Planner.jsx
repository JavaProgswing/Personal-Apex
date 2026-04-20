// Planner has been retired. Its functionality is now on the Dashboard:
//   - "Today's plan" card (AI day plan powered by local Ollama)
//   - "Ask Apex ↗" header button (freeform chat drawer)
// This file is kept as a stub so any stray imports don't crash the bundle.
// App.jsx no longer references it; if you see this rendering, update your router.

import React from "react";

export default function PlannerRetired() {
  return (
    <div className="card">
      <div className="card-title">Planner moved</div>
      <p className="muted">Planning lives on the Dashboard now. Use "Plan my day" in the Today's plan card, or open "Ask Apex ↗" from the header.</p>
    </div>
  );
}
