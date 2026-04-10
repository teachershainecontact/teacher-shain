-- Teacher Shen — D1 Schema
-- Run: wrangler d1 execute teacher-shain --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT UNIQUE NOT NULL,
  password  TEXT NOT NULL,
  name      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'student',
  class_id  INTEGER REFERENCES classes(id)
);

CREATE TABLE IF NOT EXISTS classes (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  color TEXT DEFAULT '#2D6BE4'
);

CREATE TABLE IF NOT EXISTS homework (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id     INTEGER REFERENCES classes(id),
  title        TEXT,
  instructions TEXT,
  audio_url    TEXT,
  hw_type      TEXT DEFAULT 'audio', -- 'audio' | 'written' | 'both'
  created_at   TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  homework_id    INTEGER REFERENCES homework(id),
  student_id     INTEGER REFERENCES users(id),
  status         TEXT DEFAULT 'pending',
  recording_url  TEXT,
  written_answer TEXT,
  feedback       TEXT,
  feedback_url   TEXT,
  score          INTEGER,
  ai_transcript  TEXT,
  ai_score       INTEGER,
  ai_feedback    TEXT,
  ai_writing     TEXT,
  submitted_at   TEXT,
  created_at     TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  text             TEXT NOT NULL,
  language         TEXT DEFAULT 'en',
  duration_minutes REAL,
  created_at       TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id               INTEGER PRIMARY KEY DEFAULT 1,
  classin_url      TEXT,
  next_class_time  TEXT,
  next_class_info  TEXT,
  items            TEXT
);

-- Migration: add new columns if they don't exist (safe to run on existing DB)
-- Run these manually if you already have data:
-- ALTER TABLE homework ADD COLUMN hw_type TEXT DEFAULT 'audio';
-- ALTER TABLE submissions ADD COLUMN written_answer TEXT;
-- ALTER TABLE submissions ADD COLUMN ai_writing TEXT;

-- Default teacher account
INSERT OR IGNORE INTO users (username, password, name, role)
VALUES ('teacher', 'changeme123', 'Teacher Shen', 'teacher');
