// Reads everything the coordinator needs to think, in one snapshot.
// Kept as plain data so it can be logged, tested and sent to the model as JSON.

export async function gatherContext(db, { timezone = 'Europe/Lisbon', now = new Date() } = {}) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;

  const [
    config, projects, goingCold, initiatives, needsApproval,
    overdue, openTasksByProject, clientWatch, clients, journal, recentSuggestions, recentContacts,
  ] = await Promise.all([
    q(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`),
    q(`SELECT name, description, markets::text[] AS markets, phase, github_repo,
              last_activity_at, target_date
         FROM projects WHERE phase <> 'closed' ORDER BY name`),
    q(`SELECT name, phase, last_activity_at FROM v_projects_going_cold`),
    q(`SELECT i.title, i.status, i.objective, i.expected_result, p.name AS project,
              i.created_at, i.created_by_agent
         FROM initiatives i LEFT JOIN projects p ON p.id = i.project_id
        WHERE i.status NOT IN ('done', 'dropped') ORDER BY i.created_at`),
    q(`SELECT title, step_count, created_at FROM v_needs_approval`),
    q(`SELECT title, due_date, project FROM v_overdue_tasks`),
    q(`SELECT COALESCE(p.name, '(no project)') AS project, count(*)::int AS open_tasks
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.state NOT IN ('done', 'cancelled')
        GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT name, market, status, last_contact_at, next_contact_due, flag FROM v_client_watch`),
    q(`SELECT name, market, sector, status, last_contact_at, next_contact_due, lost_reason
         FROM clients ORDER BY status, name`),
    q(`SELECT kind, author, body, acted_on, outcome, created_at
         FROM journal ORDER BY created_at DESC LIMIT 40`),
    q(`SELECT body, acted_on, outcome, created_at FROM journal
        WHERE kind = 'suggestion' AND author = 'coordinator'
          AND created_at > now() - interval '21 days'
        ORDER BY created_at DESC`),
    q(`SELECT c.name AS client, t.happened_at, t.channel, t.summary
         FROM client_touchpoint t JOIN clients c ON c.id = t.client_id
        WHERE t.happened_at > now() - interval '30 days'
        ORDER BY t.happened_at DESC LIMIT 30`),
  ]);

  const today = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(now);

  return {
    today,
    config,
    projects,
    goingCold,
    initiatives,
    needsApproval,
    overdue,
    openTasksByProject,
    clientWatch,
    clients,
    journal: journal.reverse(),          // oldest first reads more naturally
    recentSuggestions,
    recentContacts,                      // logged client touchpoints, last 30 days
  };
}
