package handler

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/rames/endless-notebook/internal/auth"
	"github.com/rames/endless-notebook/internal/entry"
)

// Server agrupa handlers HTTP
type Server struct {
	db        *sql.DB
	auth      *auth.Manager
	entryRepo *entry.Repository
}

// New cria um novo servidor HTTP
func New(db *sql.DB, authMgr *auth.Manager) *Server {
	return &Server{
		db:        db,
		auth:      authMgr,
		entryRepo: entry.NewRepository(db),
	}
}

// EntryResponse é o formato JSON de uma entry.
// Timestamps são RFC3339 UTC; o cliente converte para o fuso local na exibição.
type EntryResponse struct {
	ID        int64    `json:"id"`
	CreatedAt string   `json:"created_at"`
	StartedAt *string  `json:"started_at"`
	EndedAt   *string  `json:"ended_at"`
	RawText   string   `json:"raw_text"`
	Amount    *float64 `json:"amount"`
	Tags      []string `json:"tags"`
}

// noStore evita que respostas de API sejam guardadas por caches intermediários
// (proxy de operadora móvel, cache heurístico do navegador), o que pode causar
// divergência de dados entre dispositivos acessando o mesmo endereço.
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

// toResponse converte uma entry interna para response JSON
func toResponse(e *entry.Entry) *EntryResponse {
	return &EntryResponse{
		ID:        e.ID,
		CreatedAt: e.CreatedAt,
		StartedAt: e.StartedAt,
		EndedAt:   e.EndedAt,
		RawText:   e.RawText,
		Amount:    e.Amount,
		Tags:      e.Tags,
	}
}

// CreateEntryRequest é o formato JSON de entrada para criar entry
type CreateEntryRequest struct {
	Text string `json:"text"`
}

// UpdateEntryRequest é o corpo de PUT/PATCH /api/entry.
// Campos omitidos (nil) não são alterados. ended_at vazio ("") limpa o fim.
// remove_tags apaga só as tags indicadas, sem alterar raw_text/amount.
type UpdateEntryRequest struct {
	Text       *string  `json:"text"`
	EndedAt    *string  `json:"ended_at"`
	RemoveTags []string `json:"remove_tags"`
}

// Me retorna dados do usuário logado
func (s *Server) Me(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r.Context())
	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":       userID,
		"username": s.auth.Username(userID),
	})
}

// CreateEntry handler POST /api/entries
func (s *Server) CreateEntry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := auth.UserID(r.Context())

	var req CreateEntryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// parse da entry
	e, err := entry.ParseEntry(req.Text)
	if err != nil {
		http.Error(w, fmt.Sprintf("parse error: %v", err), http.StatusBadRequest)
		return
	}

	// salva no banco
	id, err := s.entryRepo.Save(userID, e)
	if err != nil {
		log.Printf("error saving entry: %v", err)
		http.Error(w, "failed to save entry", http.StatusInternalServerError)
		return
	}

	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":    id,
		"entry": toResponse(e),
	})
}

// GetEntry handler GET /api/entry?id=
func (s *Server) GetEntry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := auth.UserID(r.Context())

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	e, err := s.entryRepo.GetByID(userID, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toResponse(e))
}

// ListEntries handler GET /api/entries
func (s *Server) ListEntries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := auth.UserID(r.Context())

	// se tiver query param "tag", filtra por tag
	tag := r.URL.Query().Get("tag")
	var entries []*entry.Entry
	var err error

	if tag != "" {
		entries, err = s.entryRepo.ListByTag(userID, tag)
	} else {
		entries, err = s.entryRepo.ListAll(userID)
	}

	if err != nil {
		log.Printf("error listing entries: %v", err)
		http.Error(w, "failed to list entries", http.StatusInternalServerError)
		return
	}

	responses := make([]*EntryResponse, len(entries))
	for i, e := range entries {
		responses[i] = toResponse(e)
	}

	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(responses)
}

// UpdateEntry handler PUT/PATCH /api/entry?id=
func (s *Server) UpdateEntry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPatch {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := auth.UserID(r.Context())

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	var req UpdateEntryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid request: %v", err), http.StatusBadRequest)
		return
	}

	if req.Text == nil && req.EndedAt == nil && len(req.RemoveTags) == 0 {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}
	if req.Text != nil && strings.TrimSpace(*req.Text) == "" {
		http.Error(w, "text cannot be empty", http.StatusBadRequest)
		return
	}

	e, err := s.entryRepo.Update(userID, id, req.Text, req.EndedAt, req.RemoveTags)
	if err != nil {
		if err.Error() == "entry not found" {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		log.Printf("error updating entry: %v", err)
		http.Error(w, "failed to update entry", http.StatusInternalServerError)
		return
	}

	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toResponse(e))
}

// DeleteEntry handler DELETE /api/entry?id=
func (s *Server) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := auth.UserID(r.Context())

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	if err := s.entryRepo.Delete(userID, id); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNoContent)
}

// HealthHandler retorna status de saúde
func (s *Server) HealthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
