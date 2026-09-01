package report

import (
	"database/sql"
	"fmt"
)

// TODO: este pacote ainda não está ligado às rotas. Ao integrar, escopar as
// queries por user_id (ver internal/entry/repository.go).

// Report agrupa dados para relatórios
type Report struct {
	TotalAmount float64
	EntriesByTag map[string]float64
	TagCount    map[string]int
}

// GenerateFinancialReport gera relatório financeiro filtrado por tags e data
func GenerateFinancialReport(db *sql.DB, startDate, endDate string) (*Report, error) {
	report := &Report{
		EntriesByTag: make(map[string]float64),
		TagCount:     make(map[string]int),
	}

	// total de valores
	row := db.QueryRow(`
		SELECT COALESCE(SUM(amount), 0)
		FROM entries
		WHERE created_at >= ? AND created_at <= ?
		AND amount IS NOT NULL
	`, startDate, endDate)

	if err := row.Scan(&report.TotalAmount); err != nil {
		return nil, fmt.Errorf("failed to calculate total: %w", err)
	}

	// valores por tag
	rows, err := db.Query(`
		SELECT t.tag, COALESCE(SUM(e.amount), 0), COUNT(*)
		FROM tags t
		LEFT JOIN entries e ON t.entry_id = e.id
		WHERE e.created_at >= ? AND e.created_at <= ?
		AND e.amount IS NOT NULL
		GROUP BY t.tag
	`, startDate, endDate)
	if err != nil {
		return nil, fmt.Errorf("failed to query tags: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var tag string
		var amount float64
		var count int

		if err := rows.Scan(&tag, &amount, &count); err != nil {
			return nil, err
		}

		report.EntriesByTag[tag] = amount
		report.TagCount[tag] = count
	}

	return report, nil
}
