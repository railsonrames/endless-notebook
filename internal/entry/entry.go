package entry

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Entry representa uma linha do notebook.
// Todos os timestamps são strings RFC3339 em UTC; a conversão para o fuso do
// leitor acontece só na exibição (no browser).
type Entry struct {
	ID        int64
	CreatedAt string  // RFC3339 UTC — registro da linha
	StartedAt *string // RFC3339 UTC — início da atividade (default = CreatedAt)
	EndedAt   *string // RFC3339 UTC — fim da atividade (nulo até marcar)
	RawText   string
	Amount    *float64
	Tags      []string
}

var (
	tagPattern    = regexp.MustCompile(`#(\w+)`)
	amountPattern = regexp.MustCompile(`\[(\d+(?:[.,]\d{1,2})?)\]`)
)

// ParseEntry analisa o texto da entry e extrai tags e valor.
func ParseEntry(rawText string) (*Entry, error) {
	now := time.Now().UTC().Format(time.RFC3339)

	return &Entry{
		CreatedAt: now,
		StartedAt: &now,
		RawText:   rawText,
		Tags:      ExtractTags(rawText),
		Amount:    ExtractAmount(rawText),
	}, nil
}

// ExtractTags devolve as tags (#tag) presentes no texto.
func ExtractTags(rawText string) []string {
	tags := []string{}
	for _, match := range tagPattern.FindAllStringSubmatch(rawText, -1) {
		tags = append(tags, match[1])
	}
	return tags
}

// ExtractAmount devolve o primeiro valor monetário [valor] do texto, se houver.
func ExtractAmount(rawText string) *float64 {
	match := amountPattern.FindStringSubmatch(rawText)
	if len(match) <= 1 {
		return nil
	}
	amountStr := strings.Replace(match[1], ",", ".", -1)
	amount, err := strconv.ParseFloat(amountStr, 64)
	if err != nil {
		return nil
	}
	return &amount
}
