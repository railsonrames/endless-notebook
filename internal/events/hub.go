// Package events implementa um hub de notificação em memória, usado para
// avisar sessões abertas (outras abas/dispositivos do mesmo usuário) quando
// uma entry muda. Como o servidor é um único processo (monolito), um mapa
// protegido por mutex é suficiente — não precisa de Redis/broker externo.
package events

import "sync"

// Hub distribui notificações de "algo mudou" por usuário.
type Hub struct {
	mu   sync.Mutex
	subs map[int64]map[chan struct{}]struct{}
}

// NewHub cria um hub vazio.
func NewHub() *Hub {
	return &Hub{subs: make(map[int64]map[chan struct{}]struct{})}
}

// Subscribe registra um novo assinante para o usuário e devolve o canal por
// onde ele recebe os avisos. O canal tem buffer 1: notificações são um sinal
// ("recarregue"), não uma fila — perder um sinal coalescido não tem problema
// porque o próximo carrega o estado mais recente do banco.
func (h *Hub) Subscribe(userID int64) chan struct{} {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[userID] == nil {
		h.subs[userID] = make(map[chan struct{}]struct{})
	}
	h.subs[userID][ch] = struct{}{}
	return ch
}

// Unsubscribe remove e fecha o canal de um assinante (chamar sempre que a
// conexão SSE terminar, via defer).
func (h *Hub) Unsubscribe(userID int64, ch chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if subs, ok := h.subs[userID]; ok {
		if _, ok := subs[ch]; ok {
			delete(subs, ch)
			close(ch)
		}
		if len(subs) == 0 {
			delete(h.subs, userID)
		}
	}
}

// Notify avisa todos os assinantes vivos do usuário. Não bloqueia: se o
// canal já tem um sinal pendente, o novo é descartado (coalescendo avisos).
func (h *Hub) Notify(userID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[userID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
