import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Overlay from "./components/Overlay.jsx";
import "./styles/index.css";

// The focus HUD runs in its own transparent BrowserWindow loaded at
// index.html#overlay. Render the tiny <Overlay> there instead of the full app,
// and make the page background transparent so only the HUD pill paints.
const isOverlay = window.location.hash === "#overlay";
if (isOverlay) {
  document.documentElement.classList.add("overlay-mode");
  document.body.classList.add("overlay-mode");
}

createRoot(document.getElementById("root")).render(isOverlay ? <Overlay /> : <App />);
