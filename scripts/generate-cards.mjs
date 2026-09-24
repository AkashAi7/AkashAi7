// Generates self-hosted SVG cards for the profile README so the page never
// depends on third-party card services that rate-limit or go offline.
import { mkdir, writeFile } from "node:fs/promises";

const LOGIN = process.env.PROFILE_LOGIN || "AkashAi7";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUT = new URL("../assets/", import.meta.url);

const FEATURED = [
  "stenographer-mode",
  "token-optimization-simulator",
  "CloudQuote",
  "copilot-billing-observatory",
  "jev-vs-llm-benchmark",
  "github-pixel-squad-flow",
];

// Vendored dependencies and forked upstream code (committed node_modules, venvs,
// bundled OSS apps) otherwise dominate byte counts and misrepresent the profile.
// Capping each repo's contribution per language measures breadth of use, not bulk.
const LANG_BYTES_CAP_PER_REPO = 350 * 1024;

const T = {
  bg: "#0D1117",
  border: "#21262D",
  title: "#58A6FF",
  accent: "#8957E6",
  text: "#C9D1D9",
  muted: "#8B949E",
  star: "#E3B341",
};

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));

function wrap(text, maxChars, maxLines) {
  const source = String(text || "");
  const words = source.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  let used = 0;
  for (const w of words) {
    if (!cur.length) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      used += cur.length;
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur);
    used += cur.length;
    cur = "";
  }
  if (lines.length === maxLines && (cur.length || used < source.replace(/\s+/g, " ").length - 1)) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s.,;:]+$/, "") + "\u2026";
  }
  return lines;
}

async function gql(query, variables, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "profile-card-generator",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status >= 500 || res.status === 429) throw new Error(`GraphQL HTTP ${res.status}`);
    if (!res.ok) throw Object.assign(new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`), { fatal: true });
    const json = await res.json();
    if (json.errors) throw Object.assign(new Error(`GraphQL: ${JSON.stringify(json.errors)}`), { fatal: true });
    return json.data;
  } catch (err) {
    if (err.fatal || attempt >= MAX_ATTEMPTS) throw err;
    const backoff = 1000 * 2 ** (attempt - 1);
    console.warn(`request failed (${err.message}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
    return gql(query, variables, attempt + 1);
  }
}

const REPO_PAGE = `
  repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      stargazerCount
      forkCount
      languages(first: 12, orderBy: { field: SIZE, direction: DESC }) {
        edges { size node { name color } }
      }
    }
  }`;

async function fetchAll() {
  const base = await gql(
    `query($login: String!, $cursor: String) {
      user(login: $login) {
        name
        followers { totalCount }
        contributionsCollection {
          totalCommitContributions
          restrictedContributionsCount
          totalPullRequestContributions
          totalPullRequestReviewContributions
        }
        ${REPO_PAGE}
      }
    }`,
    { login: LOGIN, cursor: null }
  );

  const user = base.user;
  const repos = [...user.repositories.nodes];
  let page = user.repositories.pageInfo;
  while (page.hasNextPage) {
    const next = await gql(
      `query($login: String!, $cursor: String) { user(login: $login) { ${REPO_PAGE} } }`,
      { login: LOGIN, cursor: page.endCursor }
    );
    repos.push(...next.user.repositories.nodes);
    page = next.user.repositories.pageInfo;
  }

  const selection = FEATURED.map(
    (r, i) => `f${i}: repository(owner: $login, name: "${r}") { name description stargazerCount forkCount primaryLanguage { name color } }`
  ).join("\n    ");
  const featured = await gql(`query($login: String!) { ${selection} }`, { login: LOGIN });

  return { user, repos, featured };
}

function card(width, height, inner, gradId) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${T.title}"/>
      <stop offset="100%" stop-color="${T.accent}"/>
    </linearGradient>
  </defs>
  <style>
    .fade { opacity: 0; animation: fadeIn .6s ease-out forwards; }
    @keyframes fadeIn { to { opacity: 1; } }
    @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    .bar { transform-origin: left center; animation: grow .9s cubic-bezier(.3,.6,.4,1) forwards; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${T.bg}" stroke="${T.border}"/>
  <rect x="1" y="1" width="4" height="${height - 2}" fill="url(#${gradId})"/>
${inner}
</svg>`;
}

function repoCard(repo, key) {
  const W = 420;
  const H = 132;
  const desc = wrap(repo.description || "No description provided.", 52, 2);
  const lang = repo.primaryLanguage;

  const parts = [];
  let x = 22;
  if (lang) {
    parts.push(
      `<circle cx="${x + 5}" cy="${H - 24}" r="5.5" fill="${lang.color || T.muted}"/>` +
        `<text x="${x + 16}" y="${H - 20}" fill="${T.text}" font-size="11.5">${esc(lang.name)}</text>`
    );
    x += 24 + lang.name.length * 6.6;
  }
  const starTxt = kfmt(repo.stargazerCount);
  parts.push(
    `<path transform="translate(${x}, ${H - 31}) scale(0.82)" fill="${T.star}" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>` +
      `<text x="${x + 18}" y="${H - 20}" fill="${T.text}" font-size="11.5">${starTxt}</text>`
  );
  x += 30 + starTxt.length * 6.6;
  parts.push(
    `<path transform="translate(${x}, ${H - 31}) scale(0.82)" fill="${T.muted}" d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/>` +
      `<text x="${x + 18}" y="${H - 20}" fill="${T.text}" font-size="11.5">${kfmt(repo.forkCount)}</text>`
  );

  const inner = `  <g class="fade" style="animation-delay:.05s">
    <path transform="translate(20, 18) scale(0.95)" fill="${T.title}" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/>
    <text x="42" y="31" fill="${T.title}" font-size="15.5" font-weight="600">${esc(repo.name)}</text>
  </g>
  <g class="fade" style="animation-delay:.15s">
${desc.map((l, i) => `    <text x="21" y="${60 + i * 18}" fill="${T.muted}" font-size="12">${esc(l)}</text>`).join("\n")}
  </g>
  <g class="fade" style="animation-delay:.25s">${parts.join("")}</g>`;

  return card(W, H, inner, `g${key}`);
}

function statsCard(user, repos) {
  const W = 450;
  const H = 205;
  const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);
  const c = user.contributionsCollection;
  const commits = c.totalCommitContributions + c.restrictedContributionsCount;

  const rows = [
    ["Total Stars Earned", stars, "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"],
    ["Commits (last year)", commits, "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"],
    ["Public Repositories", user.repositories.totalCount, "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Z"],
    ["Pull Requests", c.totalPullRequestContributions, "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z"],
    ["Code Reviews", c.totalPullRequestReviewContributions, "M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 14H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 15.543V14H1.75A1.75 1.75 0 0 1 0 12.25v-9.5C0 1.784.784 1 1.75 1Z"],
    ["Followers", user.followers.totalCount, "M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5Z"],
  ];

  const inner = `  <g class="fade">
    <text x="22" y="32" fill="${T.title}" font-size="17" font-weight="700">${esc(user.name || LOGIN)} \u2014 GitHub Stats</text>
    <rect x="22" y="41" width="70" height="3" rx="1.5" fill="url(#gstats)"/>
  </g>
${rows
  .map(
    ([label, value, path], i) => `  <g class="fade" style="animation-delay:${(0.1 + i * 0.07).toFixed(2)}s">
    <path transform="translate(23, ${63 + i * 23}) scale(0.78)" fill="${T.accent}" d="${path}"/>
    <text x="44" y="${74 + i * 23}" fill="${T.text}" font-size="12.5">${esc(label)}</text>
    <text x="${W - 22}" y="${74 + i * 23}" fill="${T.title}" font-size="13.5" font-weight="700" text-anchor="end">${kfmt(value)}</text>
  </g>`
  )
  .join("\n")}`;

  return card(W, H, inner, "gstats");
}

function langsCard(repos) {
  const W = 450;
  const totals = new Map();
  for (const r of repos) {
    for (const e of r.languages?.edges || []) {
      const cur = totals.get(e.node.name) || { size: 0, color: e.node.color };
      cur.size += Math.min(e.size, LANG_BYTES_CAP_PER_REPO);
      totals.set(e.node.name, cur);
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
  const sum = sorted.reduce((a, [, v]) => a + v.size, 0) || 1;
  const items = sorted.map(([name, v]) => ({ name, color: v.color || T.muted, pct: (v.size / sum) * 100 }));

  const perCol = Math.max(1, Math.ceil(items.length / 2));
  const H = 80 + perCol * 22;
  const barW = W - 44;

  let offset = 0;
  const bar = items
    .map((it, i) => {
      const w = Math.max((it.pct / 100) * barW, 2);
      const seg = `    <rect class="bar" style="animation-delay:${(0.15 + i * 0.06).toFixed(2)}s" x="${(22 + offset).toFixed(1)}" y="46" width="${w.toFixed(1)}" height="10" fill="${it.color}"/>`;
      offset += w;
      return seg;
    })
    .join("\n");

  const legend = items
    .map((it, i) => {
      const col = i < perCol ? 0 : 1;
      const row = i % perCol;
      const x = 22 + col * ((W - 44) / 2);
      const y = 84 + row * 22;
      return `  <g class="fade" style="animation-delay:${(0.25 + i * 0.05).toFixed(2)}s">
    <circle cx="${x + 5}" cy="${y - 4}" r="5.5" fill="${it.color}"/>
    <text x="${x + 17}" y="${y}" fill="${T.text}" font-size="12">${esc(it.name)}</text>
    <text x="${(x + 17 + it.name.length * 7 + 8).toFixed(1)}" y="${y}" fill="${T.muted}" font-size="11.5">${it.pct.toFixed(1)}%</text>
  </g>`;
    })
    .join("\n");

  const inner = `  <g class="fade">
    <text x="22" y="32" fill="${T.title}" font-size="17" font-weight="700">Most Used Languages</text>
  </g>
  <clipPath id="clipbar"><rect x="22" y="46" width="${barW}" height="10" rx="5"/></clipPath>
  <g clip-path="url(#clipbar)">
    <rect x="22" y="46" width="${barW}" height="10" rx="5" fill="${T.border}"/>
${bar}
  </g>
${legend}`;

  return card(W, H, inner, "glangs");
}

async function main() {
  if (!TOKEN) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  await mkdir(OUT, { recursive: true });

  const { user, repos, featured } = await fetchAll();

  await writeFile(new URL("stats.svg", OUT), statsCard(user, repos), "utf8");
  await writeFile(new URL("top-langs.svg", OUT), langsCard(repos), "utf8");
  console.log(`wrote stats.svg + top-langs.svg (${repos.length} repos scanned)`);

  for (let i = 0; i < FEATURED.length; i++) {
    const repo = featured[`f${i}`];
    if (!repo) {
      console.warn(`skipped ${FEATURED[i]} (not found)`);
      continue;
    }
    await writeFile(new URL(`repo-${FEATURED[i]}.svg`, OUT), repoCard(repo, i), "utf8");
    console.log(`wrote repo-${FEATURED[i]}.svg`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
