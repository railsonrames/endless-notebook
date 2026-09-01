package db

import (
	"database/sql"
	"fmt"

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
		created_at TEXT NOT NULL,
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

	_, err := d.conn.Exec(schema)
	return err
}

// GetConn retorna a conexão bruta para queries customizadas
func (d *DB) GetConn() *sql.DB {
	return d.conn
}
