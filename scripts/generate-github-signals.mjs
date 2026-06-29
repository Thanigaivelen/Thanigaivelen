import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const username = process.env.GITHUB_USERNAME ?? "Thanigaivelen";
const token = process.env.GITHUB_TOKEN;
const since = process.env.GITHUB_SINCE ?? "2021-09-04";
const outputFile = resolve(repoRoot, process.env.GITHUB_SIGNALS_OUTPUT ?? "github-signals.svg");
const useSampleData = process.env.GITHUB_SIGNALS_SAMPLE === "1";

async function main() {
  const payload = useSampleData
    ? buildSamplePayload({ username, since })
    : await fetchGitHubSignals({ username, token, since });

  const stats = buildStats(payload, since);
  const svg = renderSvg(stats);

  await writeFile(outputFile, svg, "utf8");
  console.log(`Updated ${outputFile} for ${username}`);
}

async function fetchGitHubSignals({ username, token, since }) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required unless GITHUB_SIGNALS_SAMPLE=1 is set.");
  }

  const query = `
    query GitHubSignals($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        login
        name
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-signals-generator",
    },
    body: JSON.stringify({
      query,
      variables: {
        login: username,
        from: `${since}T00:00:00Z`,
        to: new Date().toISOString(),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}.`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data?.user) {
    throw new Error(`GitHub user "${username}" was not found.`);
  }

  return payload.data;
}

function buildSamplePayload({ username, since }) {
  const start = new Date(`${since}T00:00:00Z`);
  const today = new Date();
  const days = [];
  const longestRun = { start: "2025-12-12", end: "2025-12-18", count: 7 };
  const latestRun = { start: currentIsoDate(today), end: currentIsoDate(today), count: 1 };
  let totalContributions = 0;

  for (let current = new Date(start); current <= today; current.setUTCDate(current.getUTCDate() + 1)) {
    const date = currentIsoDate(current);
    let contributionCount = 0;

    if (isDateInRange(date, longestRun.start, longestRun.end)) {
      contributionCount = 4;
    } else if (isDateInRange(date, latestRun.start, latestRun.end)) {
      contributionCount = 3;
    } else if (current.getUTCDate() % 11 === 0) {
      contributionCount = 2;
    } else if (current.getUTCDay() === 2 && current.getUTCMonth() % 2 === 0) {
      contributionCount = 1;
    }

    totalContributions += contributionCount;
    days.push({
      contributionCount,
      date,
    });
  }

  if (totalContributions < 1904) {
    const gap = 1904 - totalContributions;
    days[0].contributionCount += gap;
    totalContributions += gap;
  }

  return {
    user: {
      login: username,
      name: username,
      contributionsCollection: {
        contributionCalendar: {
          totalContributions,
          weeks: chunkDaysIntoWeeks(days),
        },
      },
    },
  };
}

function chunkDaysIntoWeeks(days) {
  const weeks = [];

  for (let index = 0; index < days.length; index += 7) {
    weeks.push({
      contributionDays: days.slice(index, index + 7),
    });
  }

  return weeks;
}

function buildStats(payload, since) {
  const user = payload.user;
  const calendar = user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  const activeRun = getLatestRun(days);
  const bestRun = getLongestRun(days);
  const updatedAt = new Date();

  return {
    username: user.name || user.login,
    totalContributions: calendar.totalContributions,
    since,
    activeRun,
    bestRun,
    updatedAt,
  };
}

function getLatestRun(days) {
  let latestIndex = -1;

  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].contributionCount > 0) {
      latestIndex = index;
      break;
    }
  }

  if (latestIndex === -1) {
    return {
      length: 0,
      start: null,
      end: null,
      label: "No recent active run",
      range: "No contributions in this window",
    };
  }

  let startIndex = latestIndex;

  while (startIndex > 0 && days[startIndex - 1].contributionCount > 0) {
    startIndex -= 1;
  }

  const start = days[startIndex].date;
  const end = days[latestIndex].date;
  const length = latestIndex - startIndex + 1;

  return {
    length,
    start,
    end,
    label: length === 1 ? "Latest active day" : "Most recent streak window",
    range: formatRange(start, end),
  };
}

function getLongestRun(days) {
  let best = { length: 0, start: null, end: null };
  let runStartIndex = null;

  for (let index = 0; index < days.length; index += 1) {
    const isActive = days[index].contributionCount > 0;

    if (isActive && runStartIndex === null) {
      runStartIndex = index;
    }

    if (!isActive && runStartIndex !== null) {
      const candidate = buildRun(days, runStartIndex, index - 1);

      if (candidate.length > best.length) {
        best = candidate;
      }

      runStartIndex = null;
    }
  }

  if (runStartIndex !== null) {
    const candidate = buildRun(days, runStartIndex, days.length - 1);

    if (candidate.length > best.length) {
      best = candidate;
    }
  }

  if (!best.start || !best.end) {
    return {
      length: 0,
      start: null,
      end: null,
      label: "No streak recorded",
      range: "No contributions in this window",
    };
  }

  return {
    ...best,
    label: best.length === 1 ? "Single-day peak" : "Strongest streak on record",
    range: formatRange(best.start, best.end),
  };
}

function buildRun(days, startIndex, endIndex) {
  return {
    length: endIndex - startIndex + 1,
    start: days[startIndex].date,
    end: days[endIndex].date,
  };
}

function renderSvg(stats) {
  const totalContributions = Number(stats.totalContributions).toLocaleString("en-US");
  const updatedLabel = formatDate(stats.updatedAt);
  const sinceLabel = formatDate(stats.since);
  const activeValue = String(stats.activeRun.length);
  const bestValue = String(stats.bestRun.length);
  const username = escapeXml(stats.username);

  return `<svg width="1200" height="360" viewBox="0 0 1200 360" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="34" y1="24" x2="1168" y2="338" gradientUnits="userSpaceOnUse">
      <stop stop-color="#07111D"/>
      <stop offset="0.55" stop-color="#0B1220"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
    <filter id="softGlow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="14" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="cardShadow" x="-20%" y="-30%" width="140%" height="180%">
      <feDropShadow dx="0" dy="16" stdDeviation="16" flood-color="#020617" flood-opacity="0.38"/>
    </filter>
    <style>
      .eyebrow { font: 700 11px 'Segoe UI', Arial, sans-serif; fill: #53D4FF; letter-spacing: 2.6px; }
      .title { font: 700 30px 'Segoe UI', Arial, sans-serif; fill: #F8FAFC; letter-spacing: 0.2px; }
      .subtitle { font: 500 14px 'Segoe UI', Arial, sans-serif; fill: #94A3B8; }
      .status { font: 600 12px 'Segoe UI', Arial, sans-serif; fill: #20C997; letter-spacing: 1.6px; }
      .card { fill: rgba(8,17,29,0.88); stroke: rgba(148,163,184,0.18); stroke-width: 1; }
      .label { font: 600 12px 'Segoe UI', Arial, sans-serif; fill: #7DD3FC; letter-spacing: 2px; }
      .value { font: 700 44px 'Segoe UI', Arial, sans-serif; fill: #F8FAFC; }
      .caption { font: 600 18px 'Segoe UI', Arial, sans-serif; fill: #E2E8F0; }
      .meta { font: 500 14px 'Segoe UI', Arial, sans-serif; fill: #94A3B8; }
      .fine { font: 600 12px 'Segoe UI', Arial, sans-serif; fill: #20C997; letter-spacing: 1.6px; }
      .line { stroke: rgba(83,212,255,0.28); stroke-width: 2; fill: none; }
      .lineWarm { stroke: rgba(124,155,255,0.34); stroke-width: 2; fill: none; }
      .lineMint { stroke: rgba(32,201,151,0.32); stroke-width: 2; fill: none; }
    </style>
    <path id="cardPathA" d="M 154 246 C 202 226 244 236 290 214 C 330 196 364 208 410 182"/>
    <path id="cardPathB" d="M 454 246 C 498 204 554 258 612 190 C 638 160 672 174 710 150"/>
    <path id="cardPathC" d="M 754 246 C 790 232 842 236 888 206 C 932 178 980 182 1038 146"/>
  </defs>

  <rect width="1200" height="360" rx="28" fill="url(#bg)"/>
  <circle cx="184" cy="56" r="2.6" fill="#53D4FF"/>
  <circle cx="1038" cy="74" r="2.2" fill="#20C997"/>
  <circle cx="1092" cy="300" r="2.4" fill="#7C9BFF"/>
  <circle cx="110" cy="294" r="2.1" fill="#20C997"/>

  <g>
    <text x="74" y="54" class="eyebrow">PROFILE SIGNALS</text>
    <text x="74" y="92" class="title">GitHub Signals</text>
    <text x="74" y="118" class="subtitle">Auto-generated from ${username}'s public GitHub activity</text>
    <text x="928" y="54" class="status">UPDATED ${escapeXml(updatedLabel.toUpperCase())}</text>
  </g>

  <g filter="url(#cardShadow)">
    <rect x="74" y="148" width="326" height="156" rx="22" class="card"/>
    <rect x="437" y="148" width="326" height="156" rx="22" class="card"/>
    <rect x="800" y="148" width="326" height="156" rx="22" class="card"/>
  </g>

  <g>
    <text x="104" y="182" class="label">TOTAL CONTRIBUTIONS</text>
    <text x="104" y="234" class="value">${escapeXml(totalContributions)}</text>
    <text x="104" y="262" class="caption">Built over time, not as a vanity metric</text>
    <text x="104" y="286" class="meta">Since ${escapeXml(sinceLabel)}</text>
    <text x="104" y="304" class="fine">CONSISTENT OUTPUT</text>
    <path d="M 154 246 C 202 226 244 236 290 214 C 330 196 364 208 410 182" class="line"/>
    <circle r="5" fill="#53D4FF" filter="url(#softGlow)">
      <animateMotion dur="7s" repeatCount="indefinite">
        <mpath href="#cardPathA"/>
      </animateMotion>
    </circle>
  </g>

  <g>
    <text x="467" y="182" class="label">ACTIVE RUN</text>
    <text x="467" y="234" class="value">${escapeXml(activeValue)}</text>
    <text x="467" y="262" class="caption">${escapeXml(stats.activeRun.label)}</text>
    <text x="467" y="286" class="meta">${escapeXml(stats.activeRun.range)}</text>
    <text x="467" y="304" class="fine">LATEST MOMENTUM</text>
    <path d="M 454 246 C 498 204 554 258 612 190 C 638 160 672 174 710 150" class="lineWarm"/>
    <circle r="5" fill="#7C9BFF" filter="url(#softGlow)">
      <animateMotion dur="5.5s" repeatCount="indefinite">
        <mpath href="#cardPathB"/>
      </animateMotion>
    </circle>
  </g>

  <g>
    <text x="830" y="182" class="label">BEST RUN</text>
    <text x="830" y="234" class="value">${escapeXml(bestValue)}</text>
    <text x="830" y="262" class="caption">${escapeXml(stats.bestRun.label)}</text>
    <text x="830" y="286" class="meta">${escapeXml(stats.bestRun.range)}</text>
    <text x="830" y="304" class="fine">STRONGEST WINDOW</text>
    <path d="M 754 246 C 790 232 842 236 888 206 C 932 178 980 182 1038 146" class="lineMint"/>
    <circle r="5" fill="#20C997" filter="url(#softGlow)">
      <animateMotion dur="6.4s" repeatCount="indefinite">
        <mpath href="#cardPathC"/>
      </animateMotion>
    </circle>
  </g>
</svg>
`;
}

function formatRange(start, end) {
  if (!start || !end) {
    return "No activity range available";
  }

  if (start === end) {
    return formatDate(start);
  }

  return `${formatDate(start)} - ${formatDate(end)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function currentIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function isDateInRange(date, start, end) {
  return date >= start && date <= end;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
