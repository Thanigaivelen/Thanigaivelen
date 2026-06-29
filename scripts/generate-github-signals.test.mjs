import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

const scratchOutput = new URL("./github-signals.test-output.svg", import.meta.url);

test("fetchGitHubSignals splits multi-year ranges into API-safe windows", async () => {
  process.env.GITHUB_SIGNALS_SAMPLE = "1";
  process.env.GITHUB_SIGNALS_OUTPUT = "scripts/github-signals.test-output.svg";

  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.variables);

    return {
      ok: true,
      async json() {
        return {
          data: {
            user: {
              login: body.variables.login,
              name: body.variables.login,
              contributionsCollection: {
                contributionCalendar: {
                  totalContributions: 1,
                  weeks: [
                    {
                      contributionDays: [
                        {
                          contributionCount: 1,
                          date: body.variables.from.slice(0, 10),
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        };
      },
    };
  };

  try {
    const module = await import(`./generate-github-signals.mjs?test=${Date.now()}`);
    const payload = await module.fetchGitHubSignals({
      username: "Thanigaivelen",
      token: "test-token",
      since: "2021-09-04",
      until: "2026-06-29T00:00:00.000Z",
    });

    assert.ok(calls.length > 1, "expected multiple GraphQL requests for a multi-year range");
    assert.equal(payload.user.contributionsCollection.contributionCalendar.totalContributions, calls.length);

    for (const call of calls) {
      const from = new Date(call.from);
      const to = new Date(call.to);
      const spanInDays = Math.floor((to - from) / 86400000) + 1;
      assert.ok(spanInDays <= 366, `window exceeded GitHub's one-year limit: ${spanInDays} days`);
    }
  } finally {
    global.fetch = originalFetch;
    delete process.env.GITHUB_SIGNALS_SAMPLE;
    delete process.env.GITHUB_SIGNALS_OUTPUT;
    await rm(scratchOutput, { force: true });
  }
});
