package entry

import (
	"database/sql"
	"fmt"
)

// Repository gerencia persistência de entries
type Repository struct {
	db *sql.DB
}

// NewRepository cria um novo repositório
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// Save persiste uma entry no banco para um usuário
func (r *Repository) Save(userID int64, e *Entry) (int64, error) {
	result, err := r.db.Exec(
		"INSERT INTO entries (user_id, created_at, raw_text, amount) VALUES (?, ?, ?, ?)",
		userID,
		e.CreatedAt,
		e.RawText,
		e.Amount,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to insert entry: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("failed to get last insert id: %w", err)
	}

	// salva tags
	for _, tag := range e.Tags {
		_, err := r.db.Exec(
			"INSERT INTO tags (entry_id, tag) VALUES (?, ?)",
			id,
			tag,
		)
		if err != nil {
			return 0, fmt.Errorf("failed to insert tag: %w", err)
		}
	}

	e.ID = id
	return id, nil
}

// GetByID retorna uma entry por ID, restrita ao usuário dono
func (r *Repository) GetByID(userID, id int64) (*Entry, error) {
	row := r.db.QueryRow(
		"SELECT id, created_at, raw_text, amount FROM entries WHERE id = ? AND user_id = ?",
		id, userID,
	)

	e := &Entry{Tags: []string{}}

	if err := row.Scan(&e.ID, &e.CreatedAt, &e.RawText, &e.Amount); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("entry not found")
		}
		return nil, fmt.Errorf("failed to query entry: %w", err)
	}

	// carrega tags
	tagRows, err := r.db.Query(
		"SELECT tag FROM tags WHERE entry_id = ? ORDER BY id",
		id,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query tags: %w", err)
	}
	defer tagRows.Close()

	for tagRows.Next() {
		var tag string
		if err := tagRows.Scan(&tag); err != nil {
			return nil, err
		}
		e.Tags = append(e.Tags, tag)
	}

	return e, nil
}

// ListAll retorna todas as entries de um usuário (mais recentes primeiro)
func (r *Repository) ListAll(userID int64) ([]*Entry, error) {
	rows, err := r.db.Query(
		"SELECT id, created_at, raw_text, amount FROM entries WHERE user_id = ? ORDER BY created_at DESC",
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query entries: %w", err)
	}
	defer rows.Close()

	var entries []*Entry

	for rows.Next() {
		e := &Entry{Tags: []string{}}

		if err := rows.Scan(&e.ID, &e.CreatedAt, &e.RawText, &e.Amount); err != nil {
			return nil, err
		}

		// carrega tags para cada entry
		tagRows, err := r.db.Query(
			"SELECT tag FROM tags WHERE entry_id = ? ORDER BY id",
			e.ID,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to query tags: %w", err)
		}

		for tagRows.Next() {
			var tag string
			if err := tagRows.Scan(&tag); err != nil {
				tagRows.Close()
				return nil, err
			}
			e.Tags = append(e.Tags, tag)
		}
		tagRows.Close()

		entries = append(entries, e)
	}

	return entries, nil
}

// Delete remove uma entry do usuário dono
func (r *Repository) Delete(userID, id int64) error {
	// primeiro deleta as tags (apenas se a entry for do usuário)
	_, err := r.db.Exec(
		"DELETE FROM tags WHERE entry_id IN (SELECT id FROM entries WHERE id = ? AND user_id = ?)",
		id, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete tags: %w", err)
	}

	// depois a entry
	result, err := r.db.Exec("DELETE FROM entries WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return fmt.Errorf("failed to delete entry: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if affected == 0 {
		return fmt.Errorf("entry not found")
	}

	return nil
}

// ListByTag retorna entries de um usuário que contenham uma tag específica
func (r *Repository) ListByTag(userID int64, tag string) ([]*Entry, error) {
	rows, err := r.db.Query(`
		SELECT DISTINCT e.id, e.created_at, e.raw_text, e.amount
		FROM entries e
		INNER JOIN tags t ON e.id = t.entry_id
		WHERE e.user_id = ? AND t.tag = ?
		ORDER BY e.created_at DESC
	`, userID, tag)
	if err != nil {
		return nil, fmt.Errorf("failed to query entries by tag: %w", err)
	}
	defer rows.Close()

	var entries []*Entry

	for rows.Next() {
		e := &Entry{Tags: []string{}}

		if err := rows.Scan(&e.ID, &e.CreatedAt, &e.RawText, &e.Amount); err != nil {
			return nil, err
		}

		// carrega todas as tags
		tagRows, err := r.db.Query(
			"SELECT tag FROM tags WHERE entry_id = ? ORDER BY id",
			e.ID,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to query tags: %w", err)
		}

		for tagRows.Next() {
			var t string
			if err := tagRows.Scan(&t); err != nil {
				tagRows.Close()
				return nil, err
			}
			e.Tags = append(e.Tags, t)
		}
		tagRows.Close()

		entries = append(entries, e)
	}

	return entries, nil
}
