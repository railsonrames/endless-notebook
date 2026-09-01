package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// sessionTTL é a validade de uma sessão (cookie de longa duração).
const sessionTTL = 30 * 24 * time.Hour

// Erros de autenticação expostos para os handlers.
var (
	ErrInvalidCredentials = errors.New("usuário ou senha inválidos")
	ErrInvalidInvite      = errors.New("código de convite inválido")
	ErrUsernameTaken      = errors.New("nome de usuário já existe")
	ErrWeakPassword       = errors.New("a senha precisa ter ao menos 6 caracteres")
	ErrInvalidUsername    = errors.New("usuário deve ter 3-32 caracteres: letras, números, _ ou -")
)

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)

type ctxKey int

const userIDKey ctxKey = 0

// Manager gerencia usuários e sessões, persistidos no banco (sobrevive a restart).
type Manager struct {
	db         *sql.DB
	inviteCode string
}

// New cria o gerenciador de autenticação.
func New(db *sql.DB, inviteCode string) *Manager {
	return &Manager{db: db, inviteCode: inviteCode}
}

// Register cria um novo usuário mediante código de convite.
func (m *Manager) Register(username, password, invite string) error {
	if m.inviteCode == "" || invite != m.inviteCode {
		return ErrInvalidInvite
	}

	username = strings.TrimSpace(username)
	if !usernameRe.MatchString(username) {
		return ErrInvalidUsername
	}
	if len(password) < 6 {
		return ErrWeakPassword
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	_, err = m.db.Exec(
		"INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
		username, string(hash), time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return ErrUsernameTaken
		}
		return fmt.Errorf("failed to create user: %w", err)
	}
	return nil
}

// Login valida credenciais e cria uma sessão, devolvendo o token e a expiração.
func (m *Manager) Login(username, password string) (string, time.Time, error) {
	username = strings.TrimSpace(username)

	var id int64
	var hash string
	err := m.db.QueryRow(
		"SELECT id, password_hash FROM users WHERE username = ?", username,
	).Scan(&id, &hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", time.Time{}, ErrInvalidCredentials
		}
		return "", time.Time{}, fmt.Errorf("failed to query user: %w", err)
	}

	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return "", time.Time{}, ErrInvalidCredentials
	}

	token := randomToken()
	expires := time.Now().Add(sessionTTL)
	if _, err := m.db.Exec(
		"INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
		token, id, expires.UTC().Format(time.RFC3339),
	); err != nil {
		return "", time.Time{}, fmt.Errorf("failed to create session: %w", err)
	}
	return token, expires, nil
}

// Logout apaga a sessão do banco.
func (m *Manager) Logout(token string) {
	if token == "" {
		return
	}
	m.db.Exec("DELETE FROM sessions WHERE token = ?", token)
}

// validateSession devolve o user_id se a sessão existir e não estiver expirada.
func (m *Manager) validateSession(token string) (int64, bool) {
	if token == "" {
		return 0, false
	}

	var userID int64
	var expiresAt string
	err := m.db.QueryRow(
		"SELECT user_id, expires_at FROM sessions WHERE token = ?", token,
	).Scan(&userID, &expiresAt)
	if err != nil {
		return 0, false
	}

	exp, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil || time.Now().After(exp) {
		m.db.Exec("DELETE FROM sessions WHERE token = ?", token)
		return 0, false
	}
	return userID, true
}

// Username devolve o nome do usuário (string vazia se não achar).
func (m *Manager) Username(userID int64) string {
	var name string
	m.db.QueryRow("SELECT username FROM users WHERE id = ?", userID).Scan(&name)
	return name
}

// Middleware valida a sessão e injeta o user_id no contexto da requisição.
func (m *Manager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("session")
		if err != nil {
			m.reject(w, r)
			return
		}
		userID, ok := m.validateSession(cookie.Value)
		if !ok {
			m.reject(w, r)
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// reject responde 401 para chamadas de API e redireciona o resto para /login.
func (m *Manager) reject(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

// UserID extrai o user_id do contexto (0 se ausente).
func UserID(ctx context.Context) int64 {
	id, _ := ctx.Value(userIDKey).(int64)
	return id
}

func randomToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}
