-- Teacher Shen — IELTS Schema Migration
-- Run: wrangler d1 execute teacher-shain --file=ielts-schema.sql --remote
-- Safe to run on existing DB — uses CREATE TABLE IF NOT EXISTS

-- ── IELTS STUDENTS ────────────────────────────────────────────
-- Separate from regular students — IELTS-specific accounts
CREATE TABLE IF NOT EXISTS ielts_students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  name       TEXT NOT NULL,
  target_band REAL DEFAULT 6.5,  -- student's target band score
  exam_type  TEXT DEFAULT 'academic', -- 'academic' | 'general'
  created_at TEXT
);

-- ── IELTS EXAMS ───────────────────────────────────────────────
-- Mock exams — AI generated, teacher reviewed and published
CREATE TABLE IF NOT EXISTS ielts_exams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  exam_type   TEXT DEFAULT 'academic',  -- 'academic' | 'general'
  status      TEXT DEFAULT 'draft',     -- 'draft' | 'published'

  -- Listening section
  listening_audio_url  TEXT,            -- teacher uploads audio file
  listening_script     TEXT,            -- transcript of audio
  listening_questions  TEXT,            -- JSON array of questions

  -- Reading section
  reading_passage1     TEXT,            -- passage text
  reading_passage2     TEXT,
  reading_passage3     TEXT,
  reading_questions1   TEXT,            -- JSON array of questions
  reading_questions2   TEXT,
  reading_questions3   TEXT,

  -- Writing section
  writing_task1_prompt TEXT,            -- graph description or letter
  writing_task1_image  TEXT,            -- image URL for graph/chart
  writing_task2_prompt TEXT,            -- essay question

  -- Speaking section
  speaking_part1       TEXT,            -- JSON array of part 1 questions
  speaking_part2       TEXT,            -- cue card (JSON)
  speaking_part3       TEXT,            -- JSON array of part 3 questions

  -- Meta
  ai_generated         INTEGER DEFAULT 0,  -- 1 if AI created this
  created_at           TEXT,
  published_at         TEXT
);

-- ── IELTS SUBMISSIONS ─────────────────────────────────────────
-- One row per student per exam attempt
CREATE TABLE IF NOT EXISTS ielts_submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id     INTEGER REFERENCES ielts_exams(id),
  student_id  INTEGER REFERENCES ielts_students(id),
  status      TEXT DEFAULT 'in_progress', -- 'in_progress' | 'submitted' | 'reviewed'

  -- Listening answers
  listening_answers    TEXT,   -- JSON {q1: "answer", q2: "answer", ...}
  listening_score      REAL,   -- band 1-9
  listening_ai_score   REAL,
  listening_feedback   TEXT,

  -- Reading answers
  reading_answers      TEXT,   -- JSON
  reading_score        REAL,
  reading_ai_score     REAL,
  reading_feedback     TEXT,

  -- Writing answers
  writing_task1_answer TEXT,
  writing_task2_answer TEXT,
  writing_score        REAL,
  writing_ai_score     REAL,
  writing_ai_feedback  TEXT,   -- JSON with 4 criteria scores

  -- Speaking answers
  speaking_recording_url TEXT,
  speaking_transcript    TEXT,
  speaking_score         REAL,
  speaking_ai_score      REAL,
  speaking_ai_feedback   TEXT,  -- JSON with 4 criteria scores

  -- Overall
  overall_band         REAL,   -- teacher's final overall band
  teacher_notes        TEXT,
  started_at           TEXT,
  submitted_at         TEXT,
  reviewed_at          TEXT
);

-- ── IELTS BAND HISTORY ────────────────────────────────────────
-- Track band score progress over time per student
CREATE TABLE IF NOT EXISTS ielts_band_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER REFERENCES ielts_students(id),
  submission_id INTEGER REFERENCES ielts_submissions(id),
  listening    REAL,
  reading      REAL,
  writing      REAL,
  speaking     REAL,
  overall      REAL,
  recorded_at  TEXT
);

-- ── PHASE 3: EXAM PAIR SYSTEM ─────────────────────────────────
-- Add backup pair support to ielts_exams
-- Run: wrangler d1 execute teacher-shain --file=ielts-schema-v2.sql --remote
ALTER TABLE ielts_exams ADD COLUMN backup_pair_id INTEGER REFERENCES ielts_exams(id);
ALTER TABLE ielts_exams ADD COLUMN is_backup INTEGER DEFAULT 0; -- 1 = this is a backup exam

-- Add swap tracking to submissions
ALTER TABLE ielts_submissions ADD COLUMN original_exam_id INTEGER REFERENCES ielts_exams(id);
ALTER TABLE ielts_submissions ADD COLUMN swap_reason TEXT; -- 'audio_fail' | null
ALTER TABLE ielts_exams ADD COLUMN expires_at TEXT; -- date string YYYY-MM-DD, null = never expires
