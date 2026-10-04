import { listDocuments } from './documents.js';
import { crmForContext } from './crm.js';
import { leadsForContext } from './leads.js';

// Reads everything the coordinator needs to think, in one snapshot.
// Kept as plain data so it can be logged, tested and sent to the model as JSON.

// crm: a crmSnapshot() taken just before (the CRM is another system, so the caller fetches it and decides what a failure means).
export async function gatherContext(db, { timezone = 'Europe/Lisbon', now = new Date(), crm = null } = {}) {
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
    q(`SELECT id, body, acted_on, outcome, created_at FROM journal
        WHERE kind = 'suggestion' AND author = 'coordinator'
          AND created_at > now() - interval '21 days'
        ORDER BY created_at DESC`),
    q(`SELECT c.name AS client, t.happened_at, t.channel, t.summary
         FROM client_touchpoint t JOIN clients c ON c.id = t.client_id
        WHERE t.happened_at > now() - interval '30 days'
        ORDER BY t.happened_at DESC LIMIT 30`),
  ]);

  // Titles only: the full text is one chat tool call away, and it would crowd out the company state here.
  const documents = (await listDocuments(db, { bodies: false })).map((d) => ({ title: d.title, category: d.category, updated_at: d.updated_at }));
  // What Synaut did on its own lately, and what the owner undid. Missing until migration 006 runs
  // (the dashboard's chat can be deployed before that), so a missing table reads as none.
  const recentActions = await q(`SELECT kind, summary, reason, created_at, undone_at IS NOT NULL AS undone_by_owner
      FROM coordinator_action WHERE created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT 30`)
    .catch((err) => { if (err.code === '42P01') return []; throw err; });

  const leads = await leadsForContext(db);

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
    documents,                           // the company's contract templates, policies and checklists
    recentActions,                       // steps Synaut took on its own, last 14 days
    leads,                               // businesses the leads agent found, waiting for the owner
    ...(crm ? { crm: crmForContext(crm) } : {}),   // live from the company CRM: money, renewals, pipeline
  };
}
