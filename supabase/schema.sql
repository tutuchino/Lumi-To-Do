-- ============================================================
-- Lumi Todo — Supabase schema
-- Run this in Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================

-- 1) AI usage counter (used by Edge Function to enforce daily free-tier limit)
CREATE TABLE IF NOT EXISTS ai_usage_log (
  date DATE PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Cloud-synced tasks (optional; front-end currently uses localStorage,
--    you can later add sync. Columns include AI auto-tag fields.)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) DEFAULT auth.uid(),
  title TEXT NOT NULL,
  category_id TEXT,
  priority TEXT DEFAULT 'mid',
  amount NUMERIC,
  currency TEXT DEFAULT 'USD',
  is_backlog BOOLEAN DEFAULT false,
  date DATE,
  time TIME,
  repeat TEXT DEFAULT 'none',
  reminders JSONB DEFAULT '[]',
  subtasks JSONB DEFAULT '[]',
  tags JSONB DEFAULT '[]',
  ai_note TEXT DEFAULT '',
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own tasks" ON tasks FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 3) Journals (cloud copy; front-end still writes to localStorage first)
CREATE TABLE IF NOT EXISTS journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) DEFAULT auth.uid(),
  date DATE NOT NULL,
  content TEXT DEFAULT '',
  ai_tags JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, date)
);
ALTER TABLE journals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own journals" ON journals FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Done. No need to seed data.
-- ============================================================
