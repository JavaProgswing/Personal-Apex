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

/**
 * Specialized scrapers for specific sites.
 */
const SPECIALIZED_SCRAPERS = [
  {
    name: "NextTechLab",
    match: (url, html) => /nexttechlab\.in\/labs\//i.test(url) || /nexttechlab\.io/i.test(url) || html.includes('labcard?name='),
    scrape: ($, html, url) => {
      const results = [];
      // PRIMARY: Extract from script tags (Next.js data layer)
      const seen = new Set();
      $('script').each((_, script) => {
        const text = $(script).html();
        if (!text || !text.includes('name:')) return;
        
        // Match objects that look like members: have _id, name, and either lab or regnumber
        const blockRegex = /\{_id:"[^"]+"[^}]*?name:"[^"]+"[^}]*\}/g;
        let blockMatch;
        while ((blockMatch = blockRegex.exec(text)) !== null) {
          const block = blockMatch[0];
          
          // Check if this is likely a member object (should have a lab or regnumber)
          if (!block.includes('lab:') && !block.includes('regnumber:')) continue;

          const name = (block.match(/name:"([^"]+)"/) || [])[1];
          const ghRaw = (block.match(/github:("([^"]+)"|null)/) || [])[2];
          const liRaw = (block.match(/linkedin:("([^"]+)"|null)/) || [])[2];
          const reg = (block.match(/regnumber:("([^"]+)"|null)/) || [])[2];
          const labId = (block.match(/lab:"([^"]+)"/) || [])[1];
          const role = (block.match(/role:"([^"]+)"/) || [])[1];
          
          const gh = ghRaw && ghRaw !== 'null' ? ghRaw : null;
          const li = liRaw && liRaw !== 'null' ? liRaw : null;
          const key = (gh || li || name || '').toLowerCase();
          if (!key || seen.has(key)) continue;

          if (name || gh || li) {
            results.push({
              name: name || gh || (li ? linkedinHandleFromUrl(li) : null),
              github_username: ghHandleFromHref(gh),
              linkedin_url: liUrlFromHref(li),
              notes: JSON.stringify({ registration: reg, role, lab: labId }),
              reg_number: reg,
              role,
              lab: labId,
              tags: [labId ? `lab:${labId}` : null, role].filter(Boolean)
            });
            seen.add(key);
          }
        }
      });

      // SECONDARY: Fallback to DOM for any uniquely identifiable cards missed by scripts
      if (results.length === 0) {
        $('.relative.group.rounded-xl').each((_, el) => {
          const $card = $(el);
          const $img = $card.find('img');
          const alt = $img.attr('alt');
          const imgSrc = $img.attr('src');
          
          let nameFromCard = $card.find('.text-lg.font-bold').text().trim() || null;
          if (alt && alt.toLowerCase().endsWith(' card')) {
            nameFromCard = alt.replace(/\s+card$/i, '').trim();
          }
          
          let reg = $card.find('.text-xs').text().trim() || null;
          let gh = null, li = null, role = null, lab = null;
          $card.find('a[href]').each((_, a) => {
            const href = $(a).attr('href');
            const ghHandle = ghHandleFromHref(href);
            const liUrl = liUrlFromHref(href);
            if (ghHandle) gh = ghHandle;
            if (liUrl) li = liUrl;
          });
          if (imgSrc && imgSrc.includes('/api/labcard')) {
            try {
              const imgUrl = imgSrc.replace(/&amp;/g, '&');
              const u = new URL(imgUrl, 'https://nexttechlab.in');
              nameFromCard = nameFromCard || u.searchParams.get('name');
              reg = reg || u.searchParams.get('regnumber');
              role = u.searchParams.get('role');
              lab = u.searchParams.get('lab');
            } catch (e) {}
          }
          const name = nameFromCard || gh || (li ? linkedinHandleFromUrl(li) : null);
          const key = (gh || li || name || '').toLowerCase();
          if (name && !seen.has(key)) {
            results.push({
              name,
              github_username: gh,
              linkedin_url: li,
              notes: JSON.stringify({ registration: reg, role, lab }),
              reg_number: reg,
              role,
              lab,
              tags: [lab ? `lab:${lab}` : null, role].filter(Boolean)
            });
            seen.add(key);
          }
        });
      }

      return results;
    }
  }
];

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

function linkedinHandleFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

const PERSON_ROLE_WORDS = new Set([
  "associate", "associates", "mentor", "mentors", "member", "members",
  "alumni", "alumnus", "lead", "leads", "head", "heads", "president",
  "vicepresident", "vice-president", "secretary", "treasurer",
  "founder", "cofounder", "co-founder", "faculty", "advisor", "advisors",
  "coordinator", "coordinators", "director", "intern", "interns",
  "contributor", "contributors", "maintainer", "maintainers",
  "student", "students", "staff", "team", "meettheteam",
  "syndicate", "syndicates", "github", "linkedin", "twitter",
  "website", "portfolio", "email", "mail", "resume"
]);

function looksLikeRoleName(name) {
  if (!name) return false;
  const normalised = String(name).trim().toLowerCase().replace(/[^a-z\s-]/g, "").replace(/\s+/g, "");
  if (!normalised) return false;
  return PERSON_ROLE_WORDS.has(normalised);
}

// Walk up from an anchor trying to find a name.
function nameForAnchor($, $a) {
  let $cur = $a;
  for (let i = 0; i < 6; i++) {
    $cur = $cur.parent();
    if ($cur.length === 0) break;
    
    let foundName = null;
    $cur.find('h1, h2, h3, h4, h5, strong, b').each((_, el) => {
      if (foundName) return;
      const t = $(el).text().trim();
      if (t && t.length < 80 && !looksLikeRoleName(t)) {
        foundName = t;
      }
    });
    if (foundName) return foundName;
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
    
    let name = nameForAnchor($, $a) || $a.text().trim() || gh || linkedinHandleFromUrl(li);
    if (looksLikeRoleName(name)) name = gh || linkedinHandleFromUrl(li);
    
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

  // Case 3: Specialized Scrapers (NextTechLab, etc.)
  const html = await fetchHtml(trimmed);
  const $ = cheerio.load(html);
  for (const scraper of SPECIALIZED_SCRAPERS) {
    if (scraper.match(trimmed, html)) {
      try {
        const cands = scraper.scrape($, html, trimmed);
        if (cands && cands.length > 0) {
          return { ok: true, source: scraper.name.toLowerCase(), candidates: cands };
        }
      } catch (err) {
        console.warn(`[scraper:${scraper.name}] failed:`, err.message);
      }
    }
  }

  // Case 4: arbitrary web page fallback
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
