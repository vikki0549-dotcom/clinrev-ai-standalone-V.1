-- ClinRev standalone: core schema. Applied automatically at server start
-- (server/db.js runs every db/migrations/*.sql not yet in schema_migrations,
-- in filename order, each in its own transaction under an advisory lock).

-- Monotonic version counter shared by all documents. A delete also consumes a
-- version so clients can order "deleted" vs "re-created" events correctly.
CREATE SEQUENCE IF NOT EXISTS doc_version_seq;

-- Firestore-like document store. path alternates collection/doc segments,
-- e.g. 'encounters/abc', 'data/users/u_x/mfa_jane'.
CREATE TABLE IF NOT EXISTS documents (
  path        text PRIMARY KEY,
  collection  text NOT NULL,          -- parent collection path ('encounters', 'data/users/u_x')
  doc_id      text NOT NULL,          -- last path segment
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS documents_collection_idx ON documents (collection, doc_id);

-- People who have signed in through the identity provider.
CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,       -- 'u_' + 22 chars, derived from issuer|sub
  issuer      text NOT NULL,
  subject     text NOT NULL,
  email       text,
  name        text,
  first_login timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- Append-only audit trail (HIPAA 164.312(b)). Records who touched which record
-- and how; never the record contents.
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    text,
  email      text,
  action     text NOT NULL,           -- read | list | create | set | update | delete | ai | login | logout | denied ...
  path       text,
  ip         text,
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_path_idx ON audit_log (path);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, at);

-- Make the audit log append-only even for the application role.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Sessions (connect-pg-simple schema).
CREATE TABLE IF NOT EXISTS session (
  sid    varchar NOT NULL PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
