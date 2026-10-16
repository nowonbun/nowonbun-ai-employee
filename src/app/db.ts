import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, string | number | null>;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, responsibility TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('manager','worker')), status TEXT NOT NULL DEFAULT 'active', org_id TEXT, supervisor_id TEXT, model TEXT NOT NULL, persona TEXT NOT NULL, skill_ids TEXT NOT NULL, cwd TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), label TEXT NOT NULL, codex_id TEXT UNIQUE, status TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, model TEXT NOT NULL, persona TEXT NOT NULL, skill_ids TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_current_session ON sessions(employee_id) WHERE is_current=1;
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, parent_id TEXT REFERENCES organizations(id), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS call_permissions (manager_id TEXT NOT NULL REFERENCES employees(id), worker_id TEXT NOT NULL REFERENCES employees(id), created_at INTEGER NOT NULL, PRIMARY KEY(manager_id,worker_id));
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, idem_key TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(actor,action,idem_key));
    CREATE TABLE IF NOT EXISTS work_orders (id TEXT PRIMARY KEY, manager_id TEXT NOT NULL REFERENCES employees(id), title TEXT NOT NULL, body TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, report TEXT, revision INTEGER NOT NULL DEFAULT 1, interview_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, work_order_id TEXT REFERENCES work_orders(id), parent_task_id TEXT REFERENCES tasks(id), manager_id TEXT NOT NULL REFERENCES employees(id), worker_id TEXT NOT NULL REFERENCES employees(id), title TEXT NOT NULL, goal TEXT NOT NULL, criteria_json TEXT NOT NULL, status TEXT NOT NULL, result TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_logs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), author_id TEXT NOT NULL REFERENCES employees(id), summary TEXT NOT NULL, completed TEXT NOT NULL, evidence TEXT NOT NULL, remaining TEXT NOT NULL, next_step TEXT NOT NULL, task_revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_processes (id TEXT PRIMARY KEY, work_order_id TEXT NOT NULL REFERENCES work_orders(id), manager_id TEXT NOT NULL REFERENCES employees(id), title TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL, deadline_minutes INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_cycles (id TEXT PRIMARY KEY, process_id TEXT NOT NULL REFERENCES work_processes(id), scheduled_at INTEGER NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, derived_task_ids TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(process_id,scheduled_at));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, ref_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, operation_id TEXT REFERENCES operations(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due_at);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), session_id TEXT NOT NULL REFERENCES sessions(id), employee_id TEXT NOT NULL REFERENCES employees(id), status TEXT NOT NULL, model TEXT NOT NULL, exit_code INTEGER, reason TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES runs(id), kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_session ON events(session_id,id);
    CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES employees(id), kind TEXT NOT NULL, ref_id TEXT NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules (manager_id TEXT PRIMARY KEY REFERENCES employees(id), cron TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL, prompt TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wake_events (id TEXT PRIMARY KEY, manager_id TEXT NOT NULL REFERENCES employees(id), scheduled_at INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(manager_id,scheduled_at,reason));
    CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, content TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS model_prices (model TEXT PRIMARY KEY, input_price REAL, cached_input_price REAL, output_price REAL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), session_id TEXT REFERENCES sessions(id), topic TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_messages (id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id), actor TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_tokens (token_hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS log_imports (source_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_policy_versions (revision INTEGER PRIMARY KEY, skills_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO ai_policy_versions VALUES (1,'[]',0);
    CREATE TABLE IF NOT EXISTS run_skill_snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id), policy_revision INTEGER NOT NULL, individual_revision INTEGER NOT NULL, skills_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_calls (sequence INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL UNIQUE, employee_id TEXT NOT NULL, tool TEXT NOT NULL, target_id TEXT, occurred_at INTEGER NOT NULL, status TEXT NOT NULL, duration_ms REAL, error_code TEXT);
    CREATE INDEX IF NOT EXISTS mcp_calls_period ON mcp_calls(occurred_at,sequence);
    CREATE TABLE IF NOT EXISTS observability_meta (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO observability_meta VALUES ('mcp', CAST(strftime('%s','now') AS INTEGER)*1000);
    CREATE TABLE IF NOT EXISTS resource_archives (resource TEXT NOT NULL, target_id TEXT NOT NULL, archived_at INTEGER NOT NULL, PRIMARY KEY(resource,target_id));
    CREATE TABLE IF NOT EXISTS maintenance_revisions (resource TEXT NOT NULL, target_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(resource,target_id));
    CREATE TABLE IF NOT EXISTS skill_versions (skill_id TEXT NOT NULL REFERENCES skills(id), version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(skill_id,version));
    INSERT OR IGNORE INTO skill_versions SELECT id,version,name,description,content,sha256,created_at FROM skills;
    CREATE TABLE IF NOT EXISTS persona_versions (persona_id TEXT NOT NULL REFERENCES personas(id), version INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(persona_id,version));
    INSERT OR IGNORE INTO persona_versions SELECT id,version,name,content,created_at FROM personas;
    CREATE TABLE IF NOT EXISTS admin_operations (id TEXT PRIMARY KEY, tool TEXT NOT NULL, idem_key TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tool,idem_key));
  `);
  const interviewColumns = db
    .prepare('PRAGMA table_info(interviews)')
    .all() as { name: string }[];
  if (!interviewColumns.some((column) => column.name === 'session_id'))
    db.exec(
      'ALTER TABLE interviews ADD COLUMN session_id TEXT REFERENCES sessions(id)'
    );
  return db;
}
