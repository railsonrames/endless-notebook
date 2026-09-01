package entry

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Entry representa uma linha do notebook
type Entry struct {
	ID        int64
	CreatedAt string // YYYYMMDDHHMM
	RawText   string
	Amount    *float64
	Tags      []string
}

// ParseEntry analisa o texto da entry e extrai tags e valor
func ParseEntry(rawText string) (*Entry, error) {
	e := &Entry{
		RawText: rawText,
		Tags:    []string{},
	}

	// extrai timestamp automático (YYYYMMDDHHMM)
	now := time.Now()
	e.CreatedAt = now.Format("200601021504")

	// extrai tags (#tag)
	tagPattern := regexp.MustCompile(`#(\w+)`)
	matches := tagPattern.FindAllStringSubmatch(rawText, -1)
	for _, match := range matches {
		e.Tags = append(e.Tags, match[1])
	}

	// extrai valor monetário [valor]
	amountPattern := regexp.MustCompile(`\[(\d+(?:[.,]\d{1,2})?)\]`)
	amountMatches := amountPattern.FindStringSubmatch(rawText)
	if len(amountMatches) > 1 {
		amountStr := strings.Replace(amountMatches[1], ",", ".", -1)
		if amount, err := strconv.ParseFloat(amountStr, 64); err == nil {
			e.Amount = &amount
		}
	}

	return e, nil
}

// CreatedAtFormatted retorna a data formatada para exibição
func (e *Entry) CreatedAtFormatted() string {
	if len(e.CreatedAt) < 12 {
		return e.CreatedAt
	}
	// YYYYMMDDHHMM -> YYYY-MM-DD HH:MM
	return e.CreatedAt[:4] + "-" + e.CreatedAt[4:6] + "-" + e.CreatedAt[6:8] +
		" " + e.CreatedAt[8:10] + ":" + e.CreatedAt[10:12]
}
