// prettyAppName — turn raw Android package ids & desktop process names into
// human labels.
//
// Examples:
//   com.instagram.android              → Instagram
//   com.ninjakiwi.bloonstdbattles2     → Bloons TD Battles 2
//   com.whatsapp                       → WhatsApp
//   com.google.android.youtube         → YouTube
//   com.spotify.music                  → Spotify
//   com.android.chrome                 → Chrome
//   Code.exe / Code                    → VS Code
//   chrome.exe                         → Chrome
//
// This only runs in the renderer for display; keep it pure & dependency-free.

/* eslint-disable no-useless-escape */

// Known Android packages (exact match wins over heuristics).
const ANDROID_MAP = {
  "com.instagram.android": "Instagram",
  "com.instagram.barcelona": "Threads",
  "com.whatsapp": "WhatsApp",
  "com.whatsapp.w4b": "WhatsApp Business",
  "com.facebook.katana": "Facebook",
  "com.facebook.orca": "Messenger",
  "com.facebook.lite": "Facebook Lite",
  "com.twitter.android": "X (Twitter)",
  "com.zhiliaoapp.musically": "TikTok",
  "com.google.android.youtube": "YouTube",
  "com.google.android.apps.youtube.music": "YouTube Music",
  "com.google.android.gm": "Gmail",
  "com.google.android.googlequicksearchbox": "Google",
  "com.google.android.apps.maps": "Maps",
  "com.google.android.apps.photos": "Photos",
  "com.google.android.apps.docs": "Drive",
  "com.google.android.apps.tachyon": "Google Meet",
  "com.google.android.calendar": "Calendar",
  "com.google.android.keep": "Keep",
  "com.google.android.apps.messaging": "Messages",
  "com.google.android.dialer": "Phone",
  "com.google.android.contacts": "Contacts",
  "com.google.android.deskclock": "Clock",
  "com.google.android.apps.nbu.files": "Files",
  "com.google.android.apps.wellbeing": "Digital Wellbeing",
  "com.google.android.gms": "Play Services",
  "com.google.android.apps.chromecast.app": "Google Home",
  "com.android.chrome": "Chrome",
  "com.android.vending": "Play Store",
  "com.android.settings": "Settings",
  "com.android.systemui": "System UI",
  "com.microsoft.teams": "Teams",
  "com.microsoft.office.outlook": "Outlook",
  "com.microsoft.office.word": "Word",
  "com.microsoft.office.excel": "Excel",
  "com.microsoft.office.powerpoint": "PowerPoint",
  "com.microsoft.office.onenote": "OneNote",
  "com.microsoft.skydrive": "OneDrive",
  "com.microsoft.bing": "Bing",
  "com.microsoft.copilot": "Copilot",
  "com.spotify.music": "Spotify",
  "com.apple.android.music": "Apple Music",
  "com.amazon.mShop.android.shopping": "Amazon",
  "in.amazon.mShop.android.shopping": "Amazon",
  "com.amazon.avod.thirdpartyclient": "Prime Video",
  "com.netflix.mediaclient": "Netflix",
  "com.disney.disneyplus": "Disney+",
  "in.startv.hotstar": "Hotstar",
  "com.google.android.apps.tasks": "Tasks",
  "com.google.android.apps.fitness": "Fit",
  "com.strava": "Strava",
  "com.reddit.frontpage": "Reddit",
  "com.linkedin.android": "LinkedIn",
  "com.Slack": "Slack",
  "com.slack": "Slack",
  "com.discord": "Discord",
  "com.zhihu.android": "Zhihu",
  "com.snapchat.android": "Snapchat",
  "com.telegram.messenger": "Telegram",
  "org.telegram.messenger": "Telegram",
  "com.github.android": "GitHub",
  "com.openai.chatgpt": "ChatGPT",
  "com.anthropic.claude": "Claude",
  "ai.perplexity.app.android": "Perplexity",
  "com.google.android.apps.bard": "Gemini",
  "com.notion.id": "Notion",
  "com.google.android.apps.searchlite": "Google Go",
  "com.swiggy.android": "Swiggy",
  "in.swiggy.android": "Swiggy",
  "com.zomato.app": "Zomato",
  "in.zomato.app": "Zomato",
  "com.ubercab": "Uber",
  "com.olacabs.customer": "Ola",
  "com.paytmmoney": "Paytm Money",
  "net.one97.paytm": "Paytm",
  "com.phonepe.app": "PhonePe",
  "com.google.android.apps.nbu.paisa.user": "Google Pay",
  "com.ninjakiwi.bloonstdbattles2": "Bloons TD Battles 2",
  "com.ninjakiwi.bloonstd6": "Bloons TD 6",
  "com.ninjakiwi.bloonstd5": "Bloons TD 5",
  "com.supercell.brawlstars": "Brawl Stars",
  "com.supercell.clashofclans": "Clash of Clans",
  "com.supercell.clashroyale": "Clash Royale",
  "com.mojang.minecraftpe": "Minecraft",
  // Launcher packages — every OEM ships a different one, all just "Launcher".
  "com.miui.home": "Launcher",
  "com.miui.personalassistant": "Launcher",
  "com.mi.android.globallauncher": "Launcher",
  "com.google.android.apps.nexuslauncher": "Launcher",
  "com.sec.android.app.launcher": "Launcher",
  "com.oneplus.launcher": "Launcher",
  "com.oppo.launcher": "Launcher",
  "com.android.launcher": "Launcher",
  "com.android.launcher3": "Launcher",
  "com.nothing.launcher": "Launcher",
  "com.realme.launcher": "Launcher",
  "com.huawei.android.launcher": "Launcher",
  // System dialer variants
  "com.samsung.android.dialer": "Phone",
  "com.android.dialer": "Phone",
  "com.xiaomi.mircs": "Messages",
  "com.roblox.client": "Roblox",
  "com.pubg.imobile": "BGMI",
  "com.tencent.ig": "PUBG Mobile",
  "com.activision.callofduty.shooter": "Call of Duty Mobile",
  "com.ea.gp.fifamobile": "FIFA Mobile",
};

// Desktop process name overrides.
const DESKTOP_MAP = {
  "code": "VS Code",
  "code.exe": "VS Code",
  "code - insiders": "VS Code Insiders",
  "cursor": "Cursor",
  "cursor.exe": "Cursor",
  "chrome": "Chrome",
  "chrome.exe": "Chrome",
  "brave": "Brave",
  "brave.exe": "Brave",
  "firefox": "Firefox",
  "firefox.exe": "Firefox",
  "msedge": "Edge",
  "msedge.exe": "Edge",
  "explorer": "File Explorer",
  "explorer.exe": "File Explorer",
  "notepad": "Notepad",
  "notepad.exe": "Notepad",
  "notepad++": "Notepad++",
  "notepad++.exe": "Notepad++",
  "powershell": "PowerShell",
  "powershell.exe": "PowerShell",
  "pwsh": "PowerShell",
  "pwsh.exe": "PowerShell",
  "windowsterminal": "Terminal",
  "windowsterminal.exe": "Terminal",
  "devenv": "Visual Studio",
  "devenv.exe": "Visual Studio",
  "discord": "Discord",
  "discord.exe": "Discord",
  "spotify": "Spotify",
  "spotify.exe": "Spotify",
  "whatsapp": "WhatsApp",
  "whatsapp.exe": "WhatsApp",
  "slack": "Slack",
  "slack.exe": "Slack",
  "teams": "Teams",
  "teams.exe": "Teams",
  "ms-teams": "Teams",
  "ms-teams.exe": "Teams",
  "outlook": "Outlook",
  "outlook.exe": "Outlook",
  "winword": "Word",
  "winword.exe": "Word",
  "excel": "Excel",
  "excel.exe": "Excel",
  "powerpnt": "PowerPoint",
  "powerpnt.exe": "PowerPoint",
  "acrord32": "Acrobat Reader",
  "acrord32.exe": "Acrobat Reader",
  "steam": "Steam",
  "steam.exe": "Steam",
  "figma": "Figma",
  "figma.exe": "Figma",
  "idea64": "IntelliJ IDEA",
  "idea64.exe": "IntelliJ IDEA",
  "pycharm64": "PyCharm",
  "pycharm64.exe": "PyCharm",
  "webstorm64": "WebStorm",
  "webstorm64.exe": "WebStorm",
};

// Common concatenated tokens found in Android app leaf names, ordered so
// longer / more specific tokens match first.
const TOKENS = [
  "battles", "battle", "bloons", "minecraft", "shooter",
  "messenger", "messaging", "mobile", "tablet",
  "android", "ios", "lite", "plus", "pro",
  "music", "video", "photos", "photo", "player", "audio", "radio",
  "premium", "free", "beta", "client",
  "tdbattles", "coc", "cod", "fifa", "madden",
  "shop", "shopping", "store",
  "maps", "navigation",
  "calendar", "clock", "alarm", "weather", "stocks",
  "mail", "gmail", "inbox", "outlook",
  "drive", "files", "docs", "sheets", "slides",
  "keep", "notes", "tasks",
  "meet", "chat", "call", "calls",
  "browser", "search",
  "instagram", "facebook", "twitter", "snapchat", "telegram", "whatsapp",
  "tiktok", "reddit", "linkedin", "youtube", "netflix", "spotify",
  "swiggy", "zomato", "uber", "paytm", "phonepe", "googlepay",
  "chatgpt", "claude", "gemini", "copilot", "perplexity",
  "tower", "defense",
  "brawl", "stars", "clash", "royale", "legends", "league",
  "launcher", "dialer", "gallery", "camera",
];

// Literal display-name overrides — when the tracker stores a pre-capitalised
// leaf (e.g. "Brawlstars" or "Bloonstdbattles2") without the full package id,
// these shortcut the splitter for common cases.
const DISPLAY_MAP = {
  "brawlstars":       "Brawl Stars",
  "bloonstdbattles":  "Bloons TD Battles",
  "bloonstdbattles2": "Bloons TD Battles 2",
  "bloonstd6":        "Bloons TD 6",
  "bloonstd5":        "Bloons TD 5",
  "clashofclans":     "Clash of Clans",
  "clashroyale":      "Clash Royale",
  "pubgmobile":       "PUBG Mobile",
  "launcher":         "Launcher",
  "nexuslauncher":    "Launcher",
  "trebuchet":        "Launcher",
  "dialer":           "Phone",
  "phone":            "Phone",
  "contacts":         "Contacts",
  "systemui":         "System UI",
  "files":            "Files",
  "camera":           "Camera",
  "gallery":          "Gallery",
  "messaging":        "Messages",
  "messages":         "Messages",
  "clock":            "Clock",
  "calculator":       "Calculator",
  "settings":         "Settings",
  "chrome":           "Chrome",
};

// Words that should render in a specific case even when we title-case.
const SPECIAL_CASE = {
  "tiktok": "TikTok",
  "youtube": "YouTube",
  "whatsapp": "WhatsApp",
  "facetime": "FaceTime",
  "icloud": "iCloud",
  "ios": "iOS",
  "iphone": "iPhone",
  "ipad": "iPad",
  "macos": "macOS",
  "chatgpt": "ChatGPT",
  "openai": "OpenAI",
  "ebay": "eBay",
  "paypal": "PayPal",
  "paytm": "Paytm",
  "phonepe": "PhonePe",
  "googlepay": "Google Pay",
  "linkedin": "LinkedIn",
  "github": "GitHub",
  "vscode": "VS Code",
  "bgmi": "BGMI",
  "pubg": "PUBG",
  "cod": "COD",
  "fifa": "FIFA",
  "td": "TD",
  "tv": "TV",
  "hd": "HD",
  "ai": "AI",
  "2k": "2K",
};

/**
 * Greedy left-to-right split of a lowercase run into tokens from the vocab.
 * Falls back to splitting on digit boundaries + capitalising the remainder.
 */
function splitLower(run) {
  if (!run) return [];
  const out = [];
  let i = 0;
  while (i < run.length) {
    // find longest matching token starting at i
    let matched = "";
    for (const t of TOKENS) {
      if (t.length > matched.length && run.startsWith(t, i)) matched = t;
    }
    if (matched) {
      out.push(matched);
      i += matched.length;
      continue;
    }
    // no dict match → consume letters until a digit boundary or end
    let j = i;
    while (j < run.length && /[a-z]/.test(run[j])) j++;
    // if nothing consumed, take one char to avoid infinite loop
    if (j === i) j = i + 1;
    out.push(run.slice(i, j));
    i = j;
  }
  return out;
}

function titleCaseWord(w) {
  if (!w) return w;
  if (SPECIAL_CASE[w.toLowerCase()]) return SPECIAL_CASE[w.toLowerCase()];
  if (/^\d+$/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * Split a leaf segment (e.g. "bloonstdbattles2" or "flight-tracker") into
 * display words. Handles:
 *   - camelCase / PascalCase boundaries
 *   - digit boundaries (foo2 → foo 2)
 *   - concatenated lowercase runs via TOKENS dictionary
 *   - dashes / underscores / dots as separators
 */
function splitLeaf(leaf) {
  if (!leaf) return [];
  // Break on non-alphanumeric first.
  const pieces = leaf.split(/[\s\-_.]+/).filter(Boolean);
  const words = [];
  for (const p of pieces) {
    // Insert separators at camelCase & digit boundaries.
    const decamel = p
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .replace(/(\d)([A-Za-z])/g, "$1 $2");
    for (const frag of decamel.split(/\s+/).filter(Boolean)) {
      // If it's a long lowercase run, try dictionary split.
      if (/^[a-z]{6,}$/.test(frag)) {
        const parts = splitLower(frag);
        words.push(...parts);
      } else {
        words.push(frag);
      }
    }
  }
  return words.map(titleCaseWord);
}

// Vendor prefixes we strip when discovering the "leaf" of a package id.
const VENDOR_DROP = new Set([
  "com", "org", "net", "io", "app", "in", "co", "uk", "us", "de",
  "android", "ios", "mobile", "apps", "app",
  "google", "apple", "microsoft", "amazon", "meta", "facebook", "samsung",
]);

/**
 * Pick the "most meaningful" segment out of a package id like
 *   com.google.android.youtube → youtube
 *   com.ninjakiwi.bloonstdbattles2 → bloonstdbattles2
 *   com.whatsapp → whatsapp
 *   ai.perplexity.app.android → perplexity
 */
function leafOf(pkg) {
  const segs = pkg.split(".").filter(Boolean);
  if (segs.length === 0) return pkg;
  // scan from the right, keeping the first non-droppable segment
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i].toLowerCase();
    if (!VENDOR_DROP.has(s)) return segs[i];
  }
  return segs[segs.length - 1];
}

export function prettyAppName(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";

  // Desktop direct hits.
  const lowered = s.toLowerCase();
  if (DESKTOP_MAP[lowered]) return DESKTOP_MAP[lowered];

  // Android direct hits.
  if (ANDROID_MAP[s]) return ANDROID_MAP[s];
  if (ANDROID_MAP[lowered]) return ANDROID_MAP[lowered];

  // Bare-leaf display overrides (e.g. the tracker sometimes stores
  // "Brawlstars" or "Bloonstdbattles2" without the full package id).
  if (DISPLAY_MAP[lowered]) return DISPLAY_MAP[lowered];

  // Looks like a package id (com.foo.bar) → pick the leaf & split.
  const isPkg = /\./.test(s) && /^[a-zA-Z0-9._]+$/.test(s);
  if (isPkg) {
    const leaf = leafOf(s);
    const leafLower = leaf.toLowerCase();
    if (DISPLAY_MAP[leafLower]) return DISPLAY_MAP[leafLower];
    const words = splitLeaf(leaf);
    if (words.length) return words.join(" ");
  }

  // Desktop exe/path.
  if (/\.(exe|app|dmg)$/i.test(s)) {
    const base = s.replace(/\.[a-z]+$/i, "");
    const baseLower = base.toLowerCase();
    if (DESKTOP_MAP[baseLower]) return DESKTOP_MAP[baseLower];
    if (DISPLAY_MAP[baseLower]) return DISPLAY_MAP[baseLower];
    return splitLeaf(base).join(" ") || base;
  }

  // Otherwise: treat as a title and polish it lightly.
  // Try DISPLAY_MAP once more after stripping non-alphanumerics (e.g. the
  // tracker may pass "Brawl Stars" or "brawl_stars" as-is).
  const compact = lowered.replace(/[^a-z0-9]/g, "");
  if (DISPLAY_MAP[compact]) return DISPLAY_MAP[compact];

  const words = splitLeaf(s);
  if (words.length) return words.join(" ");
  return s;
}

export default prettyAppName;
