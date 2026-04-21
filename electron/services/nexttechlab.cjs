// Apex — NextTechLab scraper. Fetches lab member pages and pulls out
// GitHub / LinkedIn handles together with nearby text (typically the name).
// Resilient to DOM changes because it doesn't rely on specific CSS selectors —
// it grabs all anchor tags pointing to github.com / linkedin.com and tries to
// identify the person they belong to by walking up the DOM.

const cheerio = require("cheerio");

const LABS = ["satoshi", "norman", "pausch", "mccarthy", "tesla"];

function urlFor(lab) {
  return `https://nexttechlab.in/labs/${lab}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 apex-desktop" },
  });
  if (!res.ok) throw new Error(`NextTechLab ${url} returned ${res.status}`);
  return res.text();
}

// Role/title strings that frequently appear as <h4>/<h5> next to anchors on
// nexttechlab.in and get mistaken for a person's name. Skip these when walking
// up the DOM.
const ROLE_WORDS = new Set([
  "associate", "associates", "mentor", "mentors", "member", "members",
  "alumni", "alumnus", "lead", "leads", "head", "heads", "president",
  "vicepresident", "vice-president", "secretary", "treasurer",
  "founder", "cofounder", "co-founder", "faculty", "advisor",
  "coordinator", "coordinators", "director", "intern", "interns",
  "contributor", "contributors", "maintainer", "maintainers",
  "student", "students", "staff",
]);

function looksLikeRole(text) {
  const cleaned = text.trim().toLowerCase().replace(/[^a-z\s-]/g, "").trim();
  if (!cleaned) return false;
  // Short single-word titles are almost always roles.
  if (!cleaned.includes(" ") && ROLE_WORDS.has(cleaned.replace(/\s|-/g, ""))) return true;
  // Two-word role phrases like "vice president", "lab lead", etc.
  const parts = cleaned.split(/\s+/);
  if (parts.length === 2 && (ROLE_WORDS.has(parts[0]) || ROLE_WORDS.has(parts[1]))) return true;
  return false;
}

function looksLikeName(text) {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (looksLikeRole(t)) return false;
  // A real name typically has a capitalised first letter and doesn't contain
  // URL-y characters or slashes.
  if (/[\/@#]/.test(t)) return false;
  // Must contain at least one letter
  if (!/[A-Za-z]/.test(t)) return false;
  return true;
}

// Given an anchor, walk up looking for a container that also contains a
// plausible "name" element. Prefer name-shaped headings over role-shaped ones
// (e.g. skip an <h4>associate</h4> in favour of the <h3>Full Name</h3> in the
// same card).
function nameForAnchor($, $a) {
  let $cur = $a;
  for (let i = 0; i < 6; i++) {
    $cur = $cur.parent();
    if ($cur.length === 0) break;
    const candidates = $cur.find("h1, h2, h3, h4, h5, strong, b")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t && t.length > 0 && t.length < 80);
    // Prefer a name-like candidate; fall back to the first non-role candidate;
    // only in the final, desperate case return a role-looking one.
    const nameLike = candidates.find(looksLikeName);
    if (nameLike) return nameLike;
    const nonRole = candidates.find((t) => !looksLikeRole(t));
    if (nonRole) return nonRole;
  }
  // Fallback: short text of closest parent with non-empty content, stripped of hrefs.
  $cur = $a.parent();
  for (let i = 0; i < 4; i++) {
    if (!$cur || $cur.length === 0) break;
    const txt = $cur
      .clone()
      .find("a, script, style")
      .remove()
      .end()
      .text()
      .trim();
    if (txt && txt.length > 1 && txt.length < 120) {
      const first = txt.split(/\n+/)[0].trim();
      if (looksLikeName(first)) return first;
    }
    $cur = $cur.parent();
  }
  return null;
}

function extractGithubUsername(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const reserved = new Set([
      "about",
      "pricing",
      "features",
      "enterprise",
      "orgs",
      "topics",
    ]);
    if (reserved.has(parts[0].toLowerCase())) return null;
    return parts[0];
  } catch {
    return null;
  }
}

function extractLinkedinUrl(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("linkedin.com")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function scrapeLab(lab) {
  const url = urlFor(lab);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // collect by github username (most reliable identity across scrapes)
  const byGithub = new Map();
  // members with only linkedin
  const liOnly = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const gh = extractGithubUsername(href);
    const li = extractLinkedinUrl(href);
    if (!gh && !li) return;

    const name = nameForAnchor($, $(el)) || (gh ? gh : "(unknown)");

    if (gh) {
      const prev = byGithub.get(gh);
      if (!prev) {
        byGithub.set(gh, {
          name,
          github_username: gh,
          linkedin_url: null,
          source: `ntl:${lab}`,
          tags: [`lab:${lab}`],
        });
      } else if (prev.name === "(unknown)" || prev.name === gh) {
        prev.name = name;
      }
      // Try to also attach a linkedin found in the same card
      const $card = $(el).closest("div, li, article, section");
      $card.find('a[href*="linkedin.com"]').each((_, li2) => {
        const liUrl = extractLinkedinUrl($(li2).attr("href"));
        if (liUrl) byGithub.get(gh).linkedin_url = liUrl;
      });
    } else if (li) {
      liOnly.push({
        name,
        linkedin_url: li,
        source: `ntl:${lab}`,
        tags: [`lab:${lab}`],
      });
    }
  });

  return { lab, url, members: [...byGithub.values(), ...liOnly] };
}

async function scrapeAll() {
  const out = {};
  for (const lab of LABS) {
    try {
      out[lab] = await scrapeLab(lab);
    } catch (err) {
      out[lab] = { lab, error: err.message, members: [] };
    }
  }
  return out;
}

module.exports = { LABS, scrapeLab, scrapeAll };
