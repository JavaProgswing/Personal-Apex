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

// Given an anchor, walk up looking for a container that also contains a
// plausible "name" element (a heading or a short text sibling).
function nameForAnchor($, $a) {
  let $cur = $a;
  for (let i = 0; i < 6; i++) {
    $cur = $cur.parent();
    if ($cur.length === 0) break;
    // Headings first
    const heading = $cur.find("h1, h2, h3, h4, h5, strong, b").first();
    if (
      heading.length &&
      heading.text().trim().length > 0 &&
      heading.text().trim().length < 80
    ) {
      return heading.text().trim();
    }
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
    if (txt && txt.length > 1 && txt.length < 120)
      return txt.split(/\n+/)[0].trim();
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
