/**
 * Shared schema + seed data used by both the introspection unit test and the
 * two-version e2e round-trip. Kept deliberately small but exercising the cases
 * that matter for a data-only migration: a serial/sequence, a foreign key
 * (insert ordering), and a timestamptz (value fidelity).
 */

export const SCHEMA_SQL = `
CREATE TABLE authors (
  id serial PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE books (
  id serial PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors(id),
  title text NOT NULL,
  published_at timestamptz
);
`;

export const SEED_SQL = `
INSERT INTO authors (name) VALUES ('Ursula'), ('Octavia');
INSERT INTO books (author_id, title, published_at) VALUES
  (1, 'A Wizard of Earthsea', '1968-01-01T00:00:00Z'),
  (2, 'Kindred', '1979-01-01T00:00:00Z');
`;
