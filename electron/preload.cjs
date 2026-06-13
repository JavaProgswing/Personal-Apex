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
    delete: (key) => invoke("settings:delete", key),
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
    habitStreak: (id) => invoke("tasks:habitStreak", id),
    habitStreaksFor: (ids) => invoke("tasks:habitStreaksFor", ids),
    today: () => invoke("tasks:today"),
    upcoming: (days) => invoke("tasks:upcoming", days),
    completedOn: (d) => invoke("tasks:completedOn", d),
  },
  checkins: {
    today: () => invoke("checkins:today"),
    upsert: (p) => invoke("checkins:upsert", p),
    last: (days) => invoke("checkins:last", days),
  },
  dayNotes: {
    get: (date) => invoke("dayNotes:get", date),
    upsert: (p) => invoke("dayNotes:upsert", p),
    list: (limit) => invoke("dayNotes:list", limit),
    delete: (date) => invoke("dayNotes:delete", date),
    summarize: (p) => invoke("dayNotes:summarize", p),
    hasPasscode: () => invoke("dayNotes:hasPasscode"),
    setPasscode: (passcode) => invoke("dayNotes:setPasscode", { passcode }),
    unlock: (passcode) => invoke("dayNotes:unlock", { passcode }),
    lock: () => invoke("dayNotes:lock"),
    isUnlocked: () => invoke("dayNotes:isUnlocked"),
    clearPasscode: (passcode) => invoke("dayNotes:clearPasscode", { passcode }),
    resetWithRecovery: (recoveryCode, newPasscode) =>
      invoke("dayNotes:resetWithRecovery", { recoveryCode, newPasscode }),
    resetPasscode: () => invoke("dayNotes:resetPasscode", { confirm: "DELETE" }),
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
    clearAll: () => invoke("schedule:clearAll"),
    resyncFromAcademia: (folder) => invoke("schedule:resyncFromAcademia", folder),
    parseJson: (p) => invoke("schedule:parseJson", p),
    setDayOrderForDate: (iso, d) => invoke("schedule:setDayOrderForDate", iso, d),
    pickImages: () => invoke("schedule:pickImages"),
    parseImages: (payload) => invoke("schedule:parseImages", payload),
    importImageRows: (rows) => invoke("schedule:importImageRows", rows),
    overridesForDate: (iso) => invoke("schedule:overridesForDate", iso),
    setOverride: (iso, classId, patch) => invoke("schedule:setOverride", iso, classId, patch),
    addExtraClass: (iso, payload) => invoke("schedule:addExtraClass", iso, payload),
    clearOverride: (iso, classId) => invoke("schedule:clearOverride", iso, classId),
    deleteOverrideById: (id) => invoke("schedule:deleteOverrideById", id),
  },
  timer: {
    active: () => invoke("timer:active"),
    start: (p) => invoke("timer:start", p),
    extend: (mins) => invoke("timer:extend", mins),
    stop: () => invoke("timer:stop"),
    cancel: () => invoke("timer:cancel"),
    onUpdate: (h) => on("timer:update", h),
  },
  zen: {
    active: () => invoke("zen:active"),
    start: (p) => invoke("zen:start", p),
    extend: (mins) => invoke("zen:extend", mins),
    stop: (reason) => invoke("zen:stop", reason),
    history: (limit) => invoke("zen:history", limit),
    onUpdate: (h) => on("zen:update", h),
    onViolation: (h) => on("zen:violation", h),
  },
  routine: {
    state: () => invoke("routine:state"),
    saveConfig: (patch) => invoke("routine:saveConfig", patch),
    mark: (kind, payload) => invoke("routine:mark", kind, payload),
    dismissNudge: (kind) => invoke("routine:dismissNudge", kind),
    approveCloseReason: (payload) => invoke("routine:approveCloseReason", payload),
    syncNow: () => invoke("routine:syncNow"),
    createPairingCode: (payload) => invoke("routine:createPairingCode", payload),
    pairDesktop: (payload) => invoke("routine:pairDesktop", payload),
    listDevices: () => invoke("routine:listDevices"),
    revokeDevice: (id) => invoke("routine:revokeDevice", id),
    onCloseBlocked: (h) => on("routine:closeBlocked", h),
    onNudge: (h) => on("routine:nudge", h),
  },
  srm: {
    saveCreds: (creds) => invoke("srm:saveCreds", creds),
    clearCreds: () => invoke("srm:clearCreds"),
    hasCreds: () => invoke("srm:hasCreds"),
    syncNow: (opts) => invoke("srm:syncNow", opts),
    openLoginWindow: () => invoke("srm:openLoginWindow"),
    logout: () => invoke("srm:logout"),
    diagnose: () => invoke("srm:diagnose"),
    // Rebuild classes from cached student data with the current srm.batch setting.
    // Call this immediately when the user changes the batch dropdown — no network.
    rebuildBatch: () => invoke("srm:rebuildBatch"),
    // Listen for the background auto-sync event emitted on startup.
    onSynced: (h) => on("srm:synced", h),
  },
  courseMaterials: {
    list: (opts) => invoke("courseMaterials:list", opts),
    context: (opts) => invoke("courseMaterials:context", opts),
    upsert: (p) => invoke("courseMaterials:upsert", p),
    delete: (id) => invoke("courseMaterials:delete", id),
    setAi: (id, on) => invoke("courseMaterials:setAi", id, on),
    knownCourses: () => invoke("courseMaterials:knownCourses"),
    readFile: (p) => invoke("courseMaterials:readFile", p),
  },
  notifier: {
    status: () => invoke("notifier:status"),
    setEnabled: (on) => invoke("notifier:setEnabled", on),
    setLeads: (opts) => invoke("notifier:setLeads", opts),
    setHour: (key, h) => invoke("notifier:setHour", key, h),
    setKindEnabled: (kind, on) => invoke("notifier:setKindEnabled", kind, on),
    test: () => invoke("notifier:test"),
    onNavGoto: (h) => on("nav:goto", h),
  },
  shortcuts: {
    onQuickCapture: (h) => on("quick-capture:open", h),
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
    // Streaming multi-turn chat. `onToken` is called with { delta } chunks as
    // they arrive, then { done, ok, content, ... }. The returned promise
    // resolves with the final result. Abort with chatStreamAbort(streamId).
    chatStream: (payload, onToken) => {
      const id = payload.streamId;
      const channel = `ollama:stream:${id}`;
      const handler = (_e, msg) => { try { onToken && onToken(msg); } catch {} };
      ipcRenderer.on(channel, handler);
      return invoke("ollama:chatStream", payload).finally(() =>
        ipcRenderer.removeListener(channel, handler),
      );
    },
    chatStreamAbort: (streamId) => invoke("ollama:chatStreamAbort", streamId),
    burnoutSuggest: (ctx) => invoke("ollama:burnoutSuggest", ctx),
    recommend: (opts) => invoke("ollama:recommend", opts),
    burnoutCheck: (ctx) => invoke("ollama:burnoutCheck", ctx),
    eveningReview: (ctx) => invoke("ollama:eveningReview", ctx),
    extractTasks: (opts) => invoke("ollama:extractTasks", opts),
    extractFromFile: (opts) => invoke("apex:extractFromFile", opts),
    best: () => invoke("ollama:best"),
    start: () => invoke("ollama:start"),
    ping: () => invoke("ollama:ping"),
  },
  burnout: {
    latestReport: () => invoke("burnout:latestReport"),
    recent: (days) => invoke("burnout:recent", days || 7),
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
    deleteBulk: (ids) => invoke("people:deleteBulk", ids),
    deleteAll: () => invoke("people:deleteAll"),
    findDuplicates: () => invoke("people:findDuplicates"),
    merge: (args) => invoke("people:merge", args),
    repos: (id) => invoke("people:repos", id),
    sync: (id) => invoke("people:sync", id),
    syncAll: (opts) => invoke("people:syncAll", opts),
    onSyncProgress: (h) => on("people:syncProgress", h),
    heatStrips: (ids, days) => invoke("people:heatStrips", ids, days),
  },
  sync: {
    // Singleton sync-state cache from main. Lets the UI re-paint an
    // in-flight sync after a tab switch instead of losing the UI for an
    // active job. Returns { gh, cp, srm } each with { active, ... }.
    status: () => invoke("sync:status"),
  },
  window: {
    applyStartup: () => invoke("window:applyStartup"),
    startupStatus: () => invoke("window:startupStatus"),
  },
  cp: {
    fetchPerson: (id) => invoke("cp:fetchPerson", id),
    fetchAll: (opts) => invoke("cp:fetchAll", opts),
    stats: (id) => invoke("cp:stats", id),
    submissions: (id, limit) => invoke("cp:submissions", id, limit),
    self: () => invoke("cp:self"),
    selfCached: () => invoke("cp:selfCached"),
    leaderboard: (platform, opts) => invoke("cp:leaderboard", platform, opts),
    summarize: (args) => invoke("cp:summarize", args),
    onProgress: (h) => on("cp:progress", h),
    fetchSrmLeaderboard: () => invoke("cp:fetchSrmLeaderboard"),
    syncSrmLeaderboard: () => invoke("cp:syncSrmLeaderboard"),
    srmLeaderboardLastSync: () => invoke("cp:srmLeaderboardLastSync"),
    onSrmLeaderboardProgress: (h) => on("cp:srmLeaderboardProgress", h),
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
    addManual: (p) => invoke("activity:addManual", p),
    list: (opts) => invoke("activity:list", opts),
    delete: (id) => invoke("activity:delete", id),
    todayTotals: () => invoke("activity:todayTotals"),
    weekTotals: () => invoke("activity:weekTotals"),
    recentPushes: (opts) => invoke("activity:recentPushes", opts),
    totalsOn: (d) => invoke("activity:totalsOn", d),
    trend: (days) => invoke("activity:trend", days),
    topApps: (d, limit) => invoke("activity:topApps", d, limit),
    focusBlocks: (d, limit) => invoke("activity:focusBlocks", d, limit),
    daySummary: (d) => invoke("activity:daySummary", d),
    feed: (opts) => invoke("activity:feed", opts),
    buckets: (d) => invoke("activity:buckets", d),
    clearAll: () => invoke("activity:clearAll"),
    // Currently open/focused windows — Zen's app picker seeds from these.
    openApps: () => invoke("tracker:openApps"),
    // Fired by main whenever a cloud pull writes fresh phone rows.
    onRefresh: (h) => on("activity:refresh", h),
    openApps: () => invoke("activity:openApps"),
  },
  leisure: {
    active: () => invoke("leisure:active"),
    start: (opts) => invoke("leisure:start", opts),
    extend: (mins) => invoke("leisure:extend", mins),
    stop: () => invoke("leisure:stop"),
    recent: (opts) => invoke("leisure:recent", opts),
  },
  tracker: {
    start: () => invoke("tracker:start"),
    stop: () => invoke("tracker:stop"),
    status: () => invoke("tracker:status"),
    openApps: () => invoke("tracker:openApps"),
    categorize: (app, category) => invoke("tracker:categorize", app, category),
    onNudge: (h) => on("activity:nudge", h),
    onSessionEnded: (h) => on("activity:sessionEnded", h),
  },
  wellbeing: {
    devices: () => invoke("wellbeing:devices"),
    diagnose: () => invoke("wellbeing:diagnose"),
    syncNow: () => invoke("wellbeing:syncNow"),
    // Cloud (no-USB) phone-usage sync via the shared sync API.
    cloudStatus: () => invoke("wellbeing:cloudStatus"),
    pullCloud: (opts) => invoke("wellbeing:pullCloud", opts),
    setCloudAuto: (on) => invoke("wellbeing:setCloudAuto", on),
  },
  battery: {
    supported: () => invoke("battery:supported"),
    run: (duration) => invoke("battery:run", duration),
    latest: () => invoke("battery:latest"),
    syncToActivity: (duration) => invoke("battery:syncToActivity", duration),
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
    searchLocal: (q, limit) => invoke("repo:searchLocal", q, limit),
    searchPublic: (q, opts) => invoke("repo:searchPublic", q, opts),
    summarizeAll: (opts) => invoke("repo:summarizeAll", opts),
    summarizeStats: () => invoke("repo:summarizeStats"),
    onSummarizeProgress: (h) => on("repo:summarizeProgress", h),
    recentCommits: (args) => invoke("repo:recentCommits", args),
    summarizeRecentChanges: (args) => invoke("repo:summarizeRecentChanges", args),
    chat: (args) => invoke("repo:chat", args),
    // Walkthrough + compare
    tree: (fullName) => invoke("repo:tree", fullName),
    fileContent: (args) => invoke("repo:fileContent", args),
    walkthrough: (args) => invoke("repo:walkthrough", args),
    walkthroughRecap: (args) => invoke("repo:walkthroughRecap", args),
    similarToMine: (args) => invoke("repo:similarToMine", args),
    compareWithMine: (args) => invoke("repo:compareWithMine", args),
  },
  commit: {
    detail: (args) => invoke("commit:detail", args),
    chat: (args) => invoke("commit:chat", args),
  },
  ext: {
    open: (url) => invoke("ext:open", url),
    openSpotify: () => invoke("ext:openSpotify"),
  },
  spotify: {
    connect: () => invoke("spotify:connect"),
    disconnect: () => invoke("spotify:disconnect"),
    status: () => invoke("spotify:status"),
    nowPlaying: () => invoke("spotify:nowPlaying"),
    play: (uri) => invoke("spotify:play", uri),
    pause: () => invoke("spotify:pause"),
    next: () => invoke("spotify:next"),
    previous: () => invoke("spotify:previous"),
    myPlaylists: (limit) => invoke("spotify:myPlaylists", limit),
    searchPlaylists: (q, limit) => invoke("spotify:searchPlaylists", q, limit),
    setFocusPlaylist: (p) => invoke("spotify:setFocusPlaylist", p),
    setAutoPlayFocus: (on) => invoke("spotify:setAutoPlayFocus", on),
    setClientId: (id) => invoke("spotify:setClientId", id),
    playFocusPlaylist: () => invoke("spotify:playFocusPlaylist"),
    devices: () => invoke("spotify:devices"),
    // expanded controls
    setShuffle: (on) => invoke("spotify:setShuffle", on),
    setRepeat: (state) => invoke("spotify:setRepeat", state),
    setVolume: (v) => invoke("spotify:setVolume", v),
    seek: (ms) => invoke("spotify:seek", ms),
    transferTo: (id, startPlaying) =>
      invoke("spotify:transferTo", id, startPlaying),
    queue: (uri) => invoke("spotify:queue", uri),
    recent: (n) => invoke("spotify:recent", n),
    topTracks: (n) => invoke("spotify:topTracks", n),
    likedSongs: (n) => invoke("spotify:likedSongs", n),
    isTrackSaved: (uri) => invoke("spotify:isTrackSaved", uri),
    saveTrack: (uri) => invoke("spotify:saveTrack", uri),
    unsaveTrack: (uri) => invoke("spotify:unsaveTrack", uri),
    // Playlist Manager
    exportSyncLiked:          (opts) => invoke("spotify:exportSyncLiked", opts),
    sortPlaylist:             (opts) => invoke("spotify:sortPlaylist", opts),
    audioDashboard:           (opts) => invoke("spotify:audioDashboard", opts),
    detectPlaylistDuplicates: (opts) => invoke("spotify:detectPlaylistDuplicates", opts),
    removeExactDuplicates:    (opts) => invoke("spotify:removeExactDuplicates", opts),
    applyMoodArc:             (opts) => invoke("spotify:applyMoodArc", opts),
    backupPlaylist:           (opts) => invoke("spotify:backupPlaylist", opts),
    listBackups:              ()     => invoke("spotify:listBackups"),
    restorePlaylist:          (opts) => invoke("spotify:restorePlaylist", opts),
    smartFilter:              (opts) => invoke("spotify:smartFilter", opts),
    crossPlaylistDupes:       ()     => invoke("spotify:crossPlaylistDupes"),
    mergePlaylists:           (opts) => invoke("spotify:mergePlaylists", opts),
    timeMachine:              (opts) => invoke("spotify:timeMachine", opts),
    createFocusPlaylist:      (opts) => invoke("spotify:createFocusPlaylist", opts),
    // Progress event (long-running ops stream updates via this)
    onProgress: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on("spotify:progress", handler);
      return () => ipcRenderer.removeListener("spotify:progress", handler);
    },
  },
});
