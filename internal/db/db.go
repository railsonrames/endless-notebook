package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// DB encapsula a conexão SQLite
type DB struct {
	conn *sql.DB
}

// New abre ou cria o banco de dados SQLite
func New(filepath string) (*DB, error) {
	conn, err := sql.Open("sqlite", filepath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// testa conexão
	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	db := &DB{conn: conn}

	// inicializa schema
	if err := db.init(); err != nil {
		return nil, fmt.Errorf("failed to initialize database: %w", err)
	}

	return db, nil
}

// Close fecha a conexão
func (d *DB) Close() error {
	return d.conn.Close()
}

// init cria as tabelas se não existirem
func (d *DB) init() error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS sessions (
		token TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id),
		expires_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS entries (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL REFERENCES users(id),
		created_at TEXT NOT NULL,   -- RFC3339 UTC
		started_at TEXT,            -- RFC3339 UTC; default = created_at
		ended_at TEXT,              -- RFC3339 UTC; nulo até marcar o fim
		raw_text TEXT NOT NULL,
		amount REAL
	);

	CREATE TABLE IF NOT EXISTS tags (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		entry_id INTEGER NOT NULL REFERENCES entries(id),
		tag TEXT NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_entries_user_created ON entries(user_id, created_at);
	CREATE INDEX IF NOT EXISTS idx_tags_entry_id ON tags(entry_id);
	CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
	`

	if _, err := d.conn.Exec(schema); err != nil {
		return err
	}

	return d.migrate()
}

// migrate aplica ajustes idempotentes a bancos criados antes das colunas de
// tempo e converte timestamps legados (hora local, "YYYYMMDDHHMM") para UTC.
func (d *DB) migrate() error {
	if err := d.ensureColumn("entries", "started_at", "TEXT"); err != nil {
		return err
	}
	if err := d.ensureColumn("entries", "ended_at", "TEXT"); err != nil {
		return err
	}
	return d.migrateLegacyTimestamps()
}

// ensureColumn adiciona a coluna se ainda não existir na tabela.
func (d *DB) ensureColumn(table, column, columnType string) error {
	rows, err := d.conn.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return fmt.Errorf("failed to inspect %s: %w", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			cid, notnull, pk int
			name, ctype      string
			dflt             sql.NullString
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	_, err = d.conn.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, columnType))
	return err
}

// migrateLegacyTimestamps reescreve created_at no formato "200601021504"
// (gravado em hora local do servidor) como RFC3339 em UTC, e semeia started_at.
func (d *DB) migrateLegacyTimestamps() error {
	const legacyGlob = "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]"
	rows, err := d.conn.Query(
		"SELECT id, created_at FROM entries WHERE length(created_at) = 12 AND created_at GLOB ?",
		legacyGlob,
	)
	if err != nil {
		return err
	}

	type legacyRow struct {
		id int64
		ts string
	}
	var pending []legacyRow
	for rows.Next() {
		var lr legacyRow
		if err := rows.Scan(&lr.id, &lr.ts); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, lr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, lr := range pending {
		t, err := time.ParseInLocation("200601021504", lr.ts, time.Local)
		if err != nil {
			continue
		}
		iso := t.UTC().Format(time.RFC3339)
		if _, err := d.conn.Exec(
			"UPDATE entries SET created_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
			iso, iso, lr.id,
		); err != nil {
			return err
		}
	}
	return nil
}

// GetConn retorna a conexão bruta para queries customizadas
func (d *DB) GetConn() *sql.DB {
	return d.conn
}
