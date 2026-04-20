// DEPRECATED — interests were merged into Tasks (filter by "Interests" tab).
// Kept only because the file system doesn't allow deletion here.
import React from "react";
export default function Interests() {
  return (
    <div className="card">
      <h2>Interests moved</h2>
      <p className="muted">
        Interests are now a tab inside <strong>Tasks</strong>. Open Tasks and
        click the <em>Interests</em> tab.
      </p>
    </div>
  );
}
