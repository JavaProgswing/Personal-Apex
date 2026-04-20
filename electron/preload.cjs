// Apex — preload script. Exposes a safe, typed-ish API to the renderer.

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
// Subscribe to main-process events; returns an unsubscribe fn.
const on = (channel, handler) => {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("apex", {
  settings: {
    get: (key) => invoke("settings:get", key),
    set: (key, value) => invoke("settings:set", key, value),
    all: () => invoke("settings:all"),
    pickDirectory: () => invoke("dialog:pickDirectory"),
    pickFile: (filters) => invoke("dialog:pickFile", filters),
  },
  tasks: {
    list: (filter) => invoke("tasks:list", filter),
    create: (t) => invoke("tasks:create", t),
    update: (id, patch) => invoke("tasks:update", id, patch),
    delete: (id) => invoke("tasks:delete", id),
    toggle: (id) => invoke("tasks:toggle", id),
    today: () => invoke("tasks:today"),
    upcoming: (days) => invoke("tasks:upcoming", days),
    completedOn: (d) => invoke("tasks:completedOn", d),
  },
  checkins: {
    today: () => invoke("checkins:today"),
    upsert: (p) => invoke("checkins:upsert", p),
    last: (days) => invoke("checkins:last", days),
  },
  streak: {
    status: () => invoke("streak:status"),
  },
  goals: {
    list: () => invoke("goals:list"),
    upsert: (g) => invoke("goals:upsert", g),
    delete: (id) => invoke("goals:delete", id),
    incrementProgress: (id, by) => invoke("goals:incrementProgress", id, by),
    resetWeek: () => invoke("goals:resetWeek"),
  },
  schedule: {
    today: () => invoke("schedule:today"),
    upcoming: (days) => invoke("schedule:upcoming", days),
    list: () => invoke("schedule:list"),
    forDayOrder: (d) => invoke("schedule:forDayOrder", d),
    upsert: (row) => invoke("schedule:upsert", row),
    delete: (id) => invoke("schedule:delete", id),
    replaceAll: (rows) => invoke("schedule:replaceAll", rows),
    resyncFromAcademia: (folder) => invoke("schedule:resyncFromAcademia", folder),
    parseJson: (p) => invoke("schedule:parseJson", p),
    setDayOrderForDate: (iso, d) => invoke("schedule:setDayOrderForDate", iso, d),
  },
  // kept for backwards-compat; UI should use schedule.*
  timetable: {
    load: (folder) => invoke("timetable:load", folder),
    today: () => invoke("timetable:today"),
  },
  ollama: {
    listModels: () => invoke("ollama:listModels"),
    plan: (ctx) => invoke("ollama:plan", ctx),
    chat: (p) => invoke("ollama:chat", p),
    burnoutSuggest: (ctx) => invoke("ollama:burnoutSuggest", ctx),
    burnoutCheck: (ctx) => invoke("ollama:burnoutCheck", ctx),
    eveningReview: (ctx) => invoke("ollama:eveningReview", ctx),
  },
  burnout: {
    latestReport: () => invoke("burnout:latestReport"),
  },
  github: {
    fetchUser: (u) => invoke("github:fetchUser", u),
    fetchRepos: (u) => invoke("github:fetchRepos", u),
    fetchLanguages: (fn) => invoke("github:fetchLanguages", fn),
    rateLimit: () => invoke("github:rateLimit"),
  },
  people: {
    list: (f) => invoke("people:list", f),
    upsert: (p) => invoke("people:upsert", p),
    delete: (id) => invoke("people:delete", id),
    repos: (id) => invoke("people:repos", id),
    sync: (id) => invoke("people:sync", id),
    syncAll: () => invoke("people:syncAll"),
    onSyncProgress: (h) => on("people:syncProgress", h),
  },
  cp: {
    fetchPerson: (id) => invoke("cp:fetchPerson", id),
    fetchAll: () => invoke("cp:fetchAll"),
    stats: (id) => invoke("cp:stats", id),
    submissions: (id, limit) => invoke("cp:submissions", id, limit),
    self: () => invoke("cp:self"),
    selfCached: () => invoke("cp:selfCached"),
    leaderboard: (platform) => invoke("cp:leaderboard", platform),
    onProgress: (h) => on("cp:progress", h),
  },
  ntl: {
    scrape: (lab) => invoke("ntl:scrape", lab),
    scrapeAll: () => invoke("ntl:scrapeAll"),
    import: (members) => invoke("ntl:import", members),
  },
  interests: {
    list: () => invoke("interests:list"),
    upsert: (i) => invoke("interests:upsert", i),
    delete: (id) => invoke("interests:delete", id),
  },
  backup: {
    export: () => invoke("backup:export"),
    import: () => invoke("backup:import"),
    info: () => invoke("backup:info"),
  },
  activity: {
    add: (e) => invoke("activity:add", e),
    list: (opts) => invoke("activity:list", opts),
    delete: (id) => invoke("activity:delete", id),
    todayTotals: () => invoke("activity:todayTotals"),
    weekTotals: () => invoke("activity:weekTotals"),
    recentPushes: (opts) => invoke("activity:recentPushes", opts),
    totalsOn: (d) => invoke("activity:totalsOn", d),
    trend: (days) => invoke("activity:trend", days),
    topApps: (d, limit) => invoke("activity:topApps", d, limit),
    feed: (opts) => invoke("activity:feed", opts),
  },
  tracker: {
    start: () => invoke("tracker:start"),
    stop: () => invoke("tracker:stop"),
    status: () => invoke("tracker:status"),
    categorize: (app, category) => invoke("tracker:categorize", app, category),
    onNudge: (h) => on("activity:nudge", h),
    onSessionEnded: (h) => on("activity:sessionEnded", h),
  },
  wellbeing: {
    devices: () => invoke("wellbeing:devices"),
    syncNow: () => invoke("wellbeing:syncNow"),
  },
  calendar: {
    parse: (p) => invoke("calendar:parse", p),
    sync: (p) => invoke("calendar:sync", p),
    list: (limit) => invoke("calendar:list", limit),
  },
  import: {
    preview: (url) => invoke("import:preview", url),
    previewNtl4: () => invoke("import:previewNtl4"),
    commit: (list) => invoke("import:commit", list),
  },
  repo: {
    detail: (repoId) => invoke("repo:detail", repoId),
    summarize: (args) => invoke("repo:summarize", args),
    listByPerson: (personId) => invoke("repo:listByPerson", personId),
  },
  ext: {
    open: (url) => invoke("ext:open", url),
    openSpotify: () => invoke("ext:openSpotify"),
  },
});
