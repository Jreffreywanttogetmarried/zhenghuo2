CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleting')),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS browser_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_public_key text, label text, last_seen_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id uuid REFERENCES browser_installations(id) ON DELETE SET NULL, tab_id bigint, origin text,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','paused')),
  last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation', archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL, goal text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('explore','plan','execute')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_confirmation','paused','completed','failed','stopped','blocked')),
  current_run_id uuid, last_error text, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_user_recent_idx ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','system')), content text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, workflow_id text UNIQUE,
  status text NOT NULL DEFAULT 'queued', checkpoint jsonb NOT NULL DEFAULT '{}', retry_count integer NOT NULL DEFAULT 0,
  termination_reason text, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_runs_task_idx ON task_runs(task_id, created_at DESC);
CREATE TABLE IF NOT EXISTS run_events (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id uuid REFERENCES task_runs(id) ON DELETE SET NULL,
  action_id text, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, action_id, event_type)
);
CREATE INDEX IF NOT EXISTS run_events_task_idx ON run_events(task_id, created_at);
CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, action_id text NOT NULL, action jsonb NOT NULL,
  risk text NOT NULL CHECK (risk IN ('medium','high')), decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','expired')),
  decided_at timestamptz, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals(user_id, expires_at) WHERE decision = 'pending';
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL, original_name text NOT NULL, mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 52428800), object_key text NOT NULL UNIQUE, sha256 text NOT NULL,
  scan_status text NOT NULL DEFAULT 'pending', parse_status text NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending','processing','ready','failed','deleted')),
  retention_expires_at timestamptz NOT NULL, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_retention_idx ON files(retention_expires_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS file_chunks (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE, chunk_index integer NOT NULL, page_number integer,
  location jsonb NOT NULL DEFAULT '{}', content text NOT NULL, embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(file_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS file_chunks_file_idx ON file_chunks(file_id, chunk_index);
CREATE TABLE IF NOT EXISTS observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id uuid REFERENCES task_runs(id) ON DELETE SET NULL,
  page_version text NOT NULL, origin text NOT NULL, title text, snapshot_object_key text, screenshot_object_key text,
  content_sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS observations_task_idx ON observations(task_id, created_at DESC);
CREATE TABLE IF NOT EXISTS model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL, run_id uuid REFERENCES task_runs(id) ON DELETE SET NULL,
  provider text NOT NULL, model text NOT NULL, latency_ms integer, input_tokens integer, output_tokens integer,
  request_summary jsonb NOT NULL DEFAULT '{}', response_summary jsonb NOT NULL DEFAULT '{}', error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE SET NULL, actor_type text NOT NULL, actor_id text,
  event_type text NOT NULL, resource_type text, resource_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events(user_id, created_at DESC);

-- The API must set app.user_id inside each transaction before accessing tenant tables.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_isolation ON users;
CREATE POLICY user_isolation ON users USING (id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.user_id', true), '')::uuid);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['browser_installations','browser_sessions','conversations','messages','tasks','task_runs','run_events','approvals','files','file_chunks','observations','model_calls','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
