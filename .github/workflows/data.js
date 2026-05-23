const JIRA_BASE = 'https://mews.atlassian.net';

const PLAYERS = [
  { project: 'POTW',  name: 'William', color: '#38bdf8', jiraUrl: `${JIRA_BASE}/jira/core/projects/POTW` },
  { project: 'TRAIN', name: 'Eduardo', color: '#4ade80', jiraUrl: `${JIRA_BASE}/jira/core/projects/TRAIN/board` },
  { project: 'POTE',  name: 'Eloisa',  color: '#f472b6', jiraUrl: `${JIRA_BASE}/jira/core/projects/POTE/board` },
];

async function fetchJira(email, token) {
  const jql = 'project IN (POTW, TRAIN, POTE) ORDER BY project ASC, created ASC';
  const url = `${JIRA_BASE}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=200`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`Jira returned HTTP ${res.status}`);
  return res.json();
}

function processData(jiraData) {
  const byProject = Object.fromEntries(PLAYERS.map(p => [p.project, []]));

  for (const issue of jiraData.issues) {
    const projKey = issue.key.replace(/-\d+$/, '');
    if (!byProject[projKey]) continue;

    const summary    = issue.fields.summary;
    const weekMatch  = summary.match(/^\[([W\d/]+)\]\s*/);
    const weekTag    = weekMatch ? weekMatch[1] : 'Other';
    const cleanSumm  = summary.replace(/^\[[W\d/]+\]\s*/, '');
    const catKey     = issue.fields.status.statusCategory.key;
    const bucket     = catKey === 'done' ? 'done' : catKey === 'indeterminate' ? 'inprogress' : 'todo';

    byProject[projKey].push({
      key:     issue.key,
      summary: cleanSumm,
      week:    weekTag,
      status:  bucket,
      url:     `${JIRA_BASE}/browse/${issue.key}`,
    });
  }

  const players = PLAYERS.map(p => {
    const tasks = byProject[p.project];
    return {
      ...p,
      tasks,
      stats: {
        done:       tasks.filter(t => t.status === 'done').length,
        inProgress: tasks.filter(t => t.status === 'inprogress').length,
        todo:       tasks.filter(t => t.status === 'todo').length,
        total:      tasks.length,
      },
    };
  });

  // Program-level aggregate
  const allTasks   = players.flatMap(p => p.tasks);
  const startDate  = new Date('2026-05-22');
  const daysIn     = Math.max(0, Math.floor((Date.now() - startDate) / 86_400_000));
  const currentWeek = Math.min(Math.max(Math.ceil((daysIn + 1) / 7), 1), 5);

  const weeklyStats = {};
  for (const w of ['W1', 'W1/W2', 'W2', 'W3', 'W4', 'W5', 'Other']) {
    const wt = allTasks.filter(t => t.week === w);
    if (wt.length) weeklyStats[w] = {
      total:      wt.length,
      done:       wt.filter(t => t.status === 'done').length,
      inProgress: wt.filter(t => t.status === 'inprogress').length,
    };
  }

  return {
    program: {
      startDate: '2026-05-22',
      currentWeek,
      daysIn,
      totalTasks:  allTasks.length,
      totalDone:   allTasks.filter(t => t.status === 'done').length,
      totalInProg: allTasks.filter(t => t.status === 'inprogress').length,
      totalTodo:   allTasks.filter(t => t.status === 'todo').length,
      weeklyStats,
    },
    players,
    lastUpdated: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;

  if (!email || !token) {
    return res.status(500).json({ error: 'Missing JIRA_EMAIL or JIRA_TOKEN env vars' });
  }

  try {
    const jiraData = await fetchJira(email, token);
    const data     = processData(jiraData);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
