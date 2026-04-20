// Apex — "Import people from links" service.
//
// Handles several URL shapes:
//   - Direct GitHub profile:  https://github.com/<user>
//   - Direct GitHub org:      https://github.com/orgs/<org>/people  (scrape members list)
//   - NextTechLab lab pages:  https://nexttechlab.in/labs/<lab>
//   - Arbitrary webpage:      extracts all github.com / linkedin.com anchors
//                             and tries to associate each with a nearby name.
//
// Preview returns a list of candidates { name, github_username, linkedin_url,
// source }; the UI lets the user de-select any before committing via import().

const cheerio = require('cheerio');
const db = require('./db.cjs');

// Baked-in preset URLs so the UI can show a "NextTechLab 4" one-click list.
const PRESETS = {
  'ntl:satoshi':  'https://nexttechlab.in/labs/satoshi',
  'ntl:norman':   'https://nexttechlab.in/labs/norman',
  'ntl:pausch':   'https://nexttechlab.in/labs/pausch',
  'ntl:mccarthy': 'https://nexttechlab.in/labs/mccarthy',
  'ntl:tesla':    'https://nexttechlab.in/labs/tesla',
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 apex-desktop' } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

// Extract a GH handle from anchors or raw text.
function ghHandleFromHref(href) {
  if (!href) return null;
  const m = href.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/?(?:$|\?|#)/i);
  if (!m) return null;
  const h = m[1];
  // Exclude things that look like paths, not users.
  if (['orgs', 'topics', 'features', 'pricing', 'marketplace', 'sponsors', 'collections', 'about', 'enterprise'].includes(h.toLowerCase())) return null;
  return h;
}
function liUrlFromHref(href) {
  if (!href) return null;
  return /^https?:\/\/(?:www\.)?linkedin\.com\/in\//i.test(href) ? href : null;
}

// Walk up from an anchor trying to find a name.
function nameForAnchor($, $a) {
  let $cur = $a;
  for (let i = 0; i < 6; i++) {
    $cur = $cur.parent();
    if ($cur.length === 0) break;
    const heading = $cur.find('h1, h2, h3, h4, h5, strong, b').first();
    if (heading.length) {
      const t = heading.text().trim();
      if (t && t.length < 80) return t;
    }
  }
  return null;
}

// Extract candidates from arbitrary HTML.
function extractFromHtml(html, sourceLabel) {
  const $ = cheerio.load(html);
  const byName = new Map();
  const add = (entry) => {
    const key = (entry.github_username || entry.linkedin_url || entry.name || '').toLowerCase();
    if (!key) return;
    const cur = byName.get(key) || { source: sourceLabel };
    byName.set(key, { ...cur, ...entry });
  };

  $('a[href]').each((_i, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const gh = ghHandleFromHref(href);
    const li = liUrlFromHref(href);
    if (!gh && !li) return;
    const name = nameForAnchor($, $a) || $a.text().trim() || gh || li;
    add({ name, github_username: gh || undefined, linkedin_url: li || undefined });
  });

  // De-dupe entries that resolved to the same GH user under multiple names
  const byGh = new Map();
  for (const c of byName.values()) {
    if (c.github_username) {
      const existing = byGh.get(c.github_username.toLowerCase());
      if (!existing || (!existing.linkedin_url && c.linkedin_url)) {
        byGh.set(c.github_username.toLowerCase(), c);
      }
    } else if (c.linkedin_url) {
      // keep LI-only entries as a separate list below
    }
  }
  const result = [...byGh.values()];
  // Append LI-only rows (no GH)
  for (const c of byName.values()) if (!c.github_username && c.linkedin_url) result.push(c);
  return result;
}

// Public previews
async function previewUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty URL' };

  // Case 1: direct github profile
  const profMatch = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/?$/i);
  if (profMatch) {
    return { ok: true, source: 'github', candidates: [{ name: profMatch[1], github_username: profMatch[1], source: 'github' }] };
  }

  // Case 2: github org member page
  const orgMatch = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/orgs\/([^/]+)\/people\/?$/i);
  if (orgMatch) {
    const html = await fetchHtml(trimmed);
    const cands = extractFromHtml(html, 'gh:org:' + orgMatch[1]);
    return { ok: true, source: 'gh-org', candidates: cands };
  }

  // Case 3: NextTechLab lab page
  if (/nexttechlab\.in\/labs\//i.test(trimmed)) {
    const html = await fetchHtml(trimmed);
    const lab = trimmed.split('/labs/')[1]?.replace(/\/$/, '') || 'ntl';
    const cands = extractFromHtml(html, 'ntl:' + lab);
    return { ok: true, source: 'ntl', lab, candidates: cands };
  }

  // Case 4: arbitrary web page
  const html = await fetchHtml(trimmed);
  const cands = extractFromHtml(html, 'link:' + new URL(trimmed).hostname);
  return { ok: true, source: 'generic', candidates: cands };
}

// Pull previews for all NTL preset labs in parallel.
async function previewNtl4() {
  const out = {};
  await Promise.all(
    Object.entries(PRESETS).map(async ([key, url]) => {
      try {
        const res = await previewUrl(url);
        out[key] = res;
      } catch (err) { out[key] = { ok: false, error: err.message }; }
    })
  );
  return out;
}

// Commit candidates to the people table.
function importCandidates(list) {
  const imported = [];
  for (const c of list || []) {
    if (!c.name && !c.github_username) continue;
    db.upsertPerson({
      name: c.name || c.github_username,
      github_username: c.github_username || null,
      linkedin_url: c.linkedin_url || null,
      source: c.source || 'link',
      tags: c.tags || [],
      notes: c.notes || null,
    });
    imported.push(c.github_username || c.name);
  }
  return { ok: true, count: imported.length, imported };
}

module.exports = { previewUrl, previewNtl4, importCandidates, PRESETS };
