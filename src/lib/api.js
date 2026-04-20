// Thin wrapper around window.apex (exposed by preload).
// Makes it easy to mock in tests and keeps import paths clean.
export const api = typeof window !== "undefined" ? window.apex : null;
export default api;
