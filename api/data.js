const JIRA_BASE = "https://mews.atlassian.net";

const PLAYERS = [
  { project: "POTW",  name: "William", color: "#38bdf8", jiraUrl: `${JIRA_BASE}/jira/core/projects/POTW` },
  { project: "TRAIN", name: "Eduardo", color: "#4ade80", jiraUrl: `${JIRA_BASE}/jira/core/projects/TRAIN/board` },
  { project: "POTE",  name: "Eloisa",  color: "#f472b6", jiraUrl: `${JIRA_BASE}/jira/core/projects/POTE/board` },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;

  if (!email || !token) {
    return res.status(500).json({ error: "Missing JIRA_EMAIL or JIRA_TOKEN environment variables" });
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const jql  = encodeURIComponent("project IN (POTW, TRAIN, POTE) ORDER BY project ASC, created ASC");
  const url  = `${JIRA_BASE}/rest/api/3/search?jql=${jql}&fields=summary,status&maxResults=200`;

  let jiraResp;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `Jira API returned HTTP ${response.status}`, detail: text });
    }

    jiraResp = await response.json();
  } catch (err) {
    return res.status(500).json({ error: "Failed to reach Jira API", detail: err.message });
  }

  // Bucket issues by project
  const byProject = {};
  for (const p of PLAYERS) byProject[p.project] = [];

  for (const issue of jiraResp.issues || []) {
    const projKey = issue.key.replace(/-\d+$/, "");
    if (!byProject[projKey]) continue;

    const summary    = issue.fields.summary;
    const weekMatch  = summary.match(/^\[([W0-9/]+)\]\s*/);
    const weekTag    = weekMatch ? weekMatch[1] : "Other";
    const cleanSumm  = summary.replace(/^\[[W0-9/]+\]\s*/, "");
    const catKey     = issue.fields.status?.statusCategory?.key;
    const bucket     = catKey === "done" ? "done" : catKey === "indeterminate" ? "inprogress" : "todo";

    byProject[projKey].push({
      key:     issue.key,
      summary: cleanSumm,
      week:    weekTag,
      status:  bucket,
      url:     `${JIRA_BASE}/browse/${issue.key}`,
    });
  }

  // Build per-player objects
  const players = PLAYERS.map((p) => {
    const tasks = byProject[p.project];
    return {
      name:    p.name,
      project: p.project,
      color:   p.color,
      jiraUrl: p.jiraUrl,
      tasks,
      stats: {
        done:       tasks.filter((t) => t.status === "done").length,
        inProgress: tasks.filter((t) => t.status === "inprogress").length,
        todo:       tasks.filter((t) => t.status === "todo").length,
        total:      tasks.length,
      },
    };
  });

  // Program-level aggregate stats
  const allTasks     = players.flatMap((p) => p.tasks);
  const programStart = new Date("2026-05-22");
  const today        = new Date(); today.setHours(0, 0, 0, 0);
  const daysIn       = Math.floor((today - programStart) / 86400000);
  const currentWeek  = Math.min(Math.max(Math.ceil((daysIn + 1) / 7), 1), 5);

  const weekTags = ["W1", "W1/W2", "W2", "W3", "W4", "W5", "Other"];
  const weeklyStats = {};
  for (const w of weekTags) {
    const wTasks = allTasks.filter((t) => t.week === w);
    if (wTasks.length > 0) {
      weeklyStats[w] = {
        total:      wTasks.length,
        done:       wTasks.filter((t) => t.status === "done").length,
        inProgress: wTasks.filter((t) => t.status === "inprogress").length,
      };
    }
  }

  return res.status(200).json({
    program: {
      startDate:   "2026-05-22",
      currentWeek,
      daysIn,
      totalTasks:  allTasks.length,
      totalDone:   allTasks.filter((t) => t.status === "done").length,
      totalInProg: allTasks.filter((t) => t.status === "inprogress").length,
      totalTodo:   allTasks.filter((t) => t.status === "todo").length,
      weeklyStats,
    },
    players,
    lastUpdated: new Date().toISOString(),
  });
}
