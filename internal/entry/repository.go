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

// entryColumns é a lista de colunas lidas por scanEntry, nessa ordem.
const entryColumns = "id, created_at, started_at, ended_at, raw_text, amount"

// scanner cobre *sql.Row e *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

// scanEntry lê uma linha de entries no formato entryColumns.
func scanEntry(s scanner) (*Entry, error) {
	e := &Entry{Tags: []string{}}
	if err := s.Scan(&e.ID, &e.CreatedAt, &e.StartedAt, &e.EndedAt, &e.RawText, &e.Amount); err != nil {
		return nil, err
	}
	return e, nil
}

// loadTags preenche e.Tags a partir da tabela tags.
func (r *Repository) loadTags(e *Entry) error {
	rows, err := r.db.Query("SELECT tag FROM tags WHERE entry_id = ? ORDER BY id", e.ID)
	if err != nil {
		return fmt.Errorf("failed to query tags: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return err
		}
		e.Tags = append(e.Tags, tag)
	}
	return rows.Err()
}

// Save persiste uma entry no banco para um usuário
func (r *Repository) Save(userID int64, e *Entry) (int64, error) {
	result, err := r.db.Exec(
		"INSERT INTO entries (user_id, created_at, started_at, ended_at, raw_text, amount) VALUES (?, ?, ?, ?, ?, ?)",
		userID,
		e.CreatedAt,
		e.StartedAt,
		e.EndedAt,
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
		if _, err := r.db.Exec("INSERT INTO tags (entry_id, tag) VALUES (?, ?)", id, tag); err != nil {
			return 0, fmt.Errorf("failed to insert tag: %w", err)
		}
	}

	e.ID = id
	return id, nil
}

// GetByID retorna uma entry por ID, restrita ao usuário dono
func (r *Repository) GetByID(userID, id int64) (*Entry, error) {
	row := r.db.QueryRow(
		"SELECT "+entryColumns+" FROM entries WHERE id = ? AND user_id = ?",
		id, userID,
	)

	e, err := scanEntry(row)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("entry not found")
		}
		return nil, fmt.Errorf("failed to query entry: %w", err)
	}

	if err := r.loadTags(e); err != nil {
		return nil, err
	}
	return e, nil
}

// ListAll retorna todas as entries de um usuário (mais recentes primeiro)
func (r *Repository) ListAll(userID int64) ([]*Entry, error) {
	rows, err := r.db.Query(
		"SELECT "+entryColumns+" FROM entries WHERE user_id = ? ORDER BY created_at DESC",
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query entries: %w", err)
	}
	return r.collectEntries(rows)
}

// ListByTag retorna entries de um usuário que contenham uma tag específica
func (r *Repository) ListByTag(userID int64, tag string) ([]*Entry, error) {
	rows, err := r.db.Query(`
		SELECT DISTINCT `+prefixColumns("e")+`
		FROM entries e
		INNER JOIN tags t ON e.id = t.entry_id
		WHERE e.user_id = ? AND t.tag = ?
		ORDER BY e.created_at DESC
	`, userID, tag)
	if err != nil {
		return nil, fmt.Errorf("failed to query entries by tag: %w", err)
	}
	return r.collectEntries(rows)
}

// collectEntries consome rows no formato entryColumns e carrega as tags de cada.
func (r *Repository) collectEntries(rows *sql.Rows) ([]*Entry, error) {
	defer rows.Close()

	var entries []*Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, e := range entries {
		if err := r.loadTags(e); err != nil {
			return nil, err
		}
	}
	return entries, nil
}

// prefixColumns devolve entryColumns qualificado por um alias de tabela.
func prefixColumns(alias string) string {
	return alias + ".id, " + alias + ".created_at, " + alias + ".started_at, " +
		alias + ".ended_at, " + alias + ".raw_text, " + alias + ".amount"
}

// Update altera texto, fim de atividade e/ou remove tags específicas de uma
// entry do usuário dono. text != nil reescreve raw_text, amount e as tags.
// endedAt != nil grava o fim (string vazia limpa o campo). removeTags apaga
// só as tags indicadas (sem tocar em raw_text/amount). Devolve a entry já
// atualizada.
func (r *Repository) Update(userID, id int64, text, endedAt *string, removeTags []string) (*Entry, error) {
	var owner int64
	err := r.db.QueryRow("SELECT user_id FROM entries WHERE id = ?", id).Scan(&owner)
	if err == sql.ErrNoRows || (err == nil && owner != userID) {
		return nil, fmt.Errorf("entry not found")
	}
	if err != nil {
		return nil, fmt.Errorf("failed to load entry: %w", err)
	}

	if text != nil {
		if _, err := r.db.Exec(
			"UPDATE entries SET raw_text = ?, amount = ? WHERE id = ? AND user_id = ?",
			*text, ExtractAmount(*text), id, userID,
		); err != nil {
			return nil, fmt.Errorf("failed to update entry: %w", err)
		}
		if _, err := r.db.Exec("DELETE FROM tags WHERE entry_id = ?", id); err != nil {
			return nil, fmt.Errorf("failed to clear tags: %w", err)
		}
		for _, tag := range ExtractTags(*text) {
			if _, err := r.db.Exec("INSERT INTO tags (entry_id, tag) VALUES (?, ?)", id, tag); err != nil {
				return nil, fmt.Errorf("failed to insert tag: %w", err)
			}
		}
	}

	if endedAt != nil {
		var execErr error
		if *endedAt == "" {
			_, execErr = r.db.Exec("UPDATE entries SET ended_at = NULL WHERE id = ? AND user_id = ?", id, userID)
		} else {
			_, execErr = r.db.Exec("UPDATE entries SET ended_at = ? WHERE id = ? AND user_id = ?", *endedAt, id, userID)
		}
		if execErr != nil {
			return nil, fmt.Errorf("failed to update ended_at: %w", execErr)
		}
	}

	for _, tag := range removeTags {
		if _, err := r.db.Exec("DELETE FROM tags WHERE entry_id = ? AND tag = ?", id, tag); err != nil {
			return nil, fmt.Errorf("failed to remove tag: %w", err)
		}
	}

	return r.GetByID(userID, id)
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
