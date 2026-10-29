-- ===== מסד נתונים: החברה =====

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  default_time TEXT NOT NULL DEFAULT '20:30',
  reminder_days_before INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  host_member_id INTEGER,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  topics TEXT,
  notes TEXT,
  original_time TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  wants_swap INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  member_id INTEGER,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  event_id INTEGER,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_events_account_date ON events(account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, date);

INSERT INTO accounts (id, name, default_time, reminder_days_before)
SELECT 1, 'החברה', '20:30', 3
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = 1);

INSERT INTO members (account_id, name, email, role)
SELECT 1, 'אביגדור כהן', NULL, 'member'
WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = 'אביגדור כהן');

INSERT INTO members (account_id, name, email, role)
SELECT 1, 'לייבי ליכטנשטיין', 'l0556726433@gmail.com', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = 'לייבי ליכטנשטיין');

INSERT INTO members (account_id, name, email, role)
SELECT 1, 'מנחם ליצמן', NULL, 'member'
WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = 'מנחם ליצמן');

INSERT INTO members (account_id, name, email, role)
SELECT 1, 'יענקי קליין', NULL, 'member'
WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = 'יענקי קליין');

INSERT INTO members (account_id, name, email, role)
SELECT 1, 'שעיה שוירץ', NULL, 'member'
WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = 'שעיה שוירץ');
