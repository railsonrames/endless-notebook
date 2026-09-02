let currentFilterTag = null;
let activityStart = null;
let activityEnd = null;
let sheetRows = [];
let sheetHydrated = false;
let sheetInner = null;

// Caderno "endless": começa com um bloco de linhas e cria mais
// dinamicamente conforme o final se aproxima.
const INITIAL_ROWS = 25;
const TRAILING_ROWS = 12;

// Carrega entries ao abrir a página
document.addEventListener('DOMContentLoaded', () => {
    restoreTheme();
    restoreHeaderState();
    restoreSidebarState();
    loadCurrentUser();
    buildNotebookSheet();
    loadEntries();
});

// Mostra o usuário logado no cabeçalho.
async function loadCurrentUser() {
    try {
        const res = await fetch('/api/me');
        if (res.status === 401) {
            window.location.href = '/login';
            return;
        }
        if (!res.ok) return;
        const data = await res.json();
        const el = document.getElementById('whoami');
        if (el && data.username) {
            el.textContent = '@' + data.username;
        }
    } catch (e) { /* ignore */ }
}

// ============================================
// MENU SUPERIOR (retrair / mostrar)
// ============================================

function restoreHeaderState() {
    let collapsed = false;
    try {
        collapsed = localStorage.getItem('headerCollapsed') === '1';
    } catch (e) { /* ignore */ }
    applyHeaderState(collapsed);
}

function applyHeaderState(collapsed) {
    document.body.classList.toggle('header-collapsed', collapsed);
}

function toggleHeader() {
    const collapsed = !document.body.classList.contains('header-collapsed');
    applyHeaderState(collapsed);
    try {
        localStorage.setItem('headerCollapsed', collapsed ? '1' : '0');
    } catch (e) { /* ignore */ }
}

// ============================================
// TEMA (claro / escuro — só a folha do caderno)
// ============================================

function restoreTheme() {
    let theme = 'light';
    try {
        theme = localStorage.getItem('notebookTheme') || 'light';
    } catch (e) { /* ignore */ }
    applyTheme(theme);
}

function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
        // simbolo do tema para o qual vai alternar: sol / lua
        btn.textContent = dark ? '☀' : '☾';
    }
}

function toggleTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try {
        localStorage.setItem('notebookTheme', next);
    } catch (e) { /* ignore */ }
}

// ============================================
// SIDEBAR (lista de entradas / tags)
// ============================================

function restoreSidebarState() {
    let hidden = false;
    try {
        hidden = localStorage.getItem('sidebarHidden') === '1';
    } catch (e) { /* ignore */ }
    applySidebarState(hidden);
}

function applySidebarState(hidden) {
    const container = document.querySelector('.container');
    if (container) {
        container.classList.toggle('sidebar-hidden', hidden);
    }
}

function toggleSidebar() {
    const container = document.querySelector('.container');
    if (!container) return;
    const hidden = !container.classList.contains('sidebar-hidden');
    applySidebarState(hidden);
    try {
        localStorage.setItem('sidebarHidden', hidden ? '1' : '0');
    } catch (e) { /* ignore */ }
}

// Rola o caderno só o necessário para deixar a linha visível.
function revealRowIfNeeded(sheet, row) {
    if (!sheet || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const viewTop = sheet.scrollTop;
    const viewBottom = viewTop + sheet.clientHeight;

    if (bottom > viewBottom) {
        sheet.scrollTop = bottom - sheet.clientHeight + 8;
    } else if (top < viewTop) {
        sheet.scrollTop = Math.max(0, top - 8);
    }
}

function buildNotebookSheet() {
    const sheet = document.getElementById('notebookSheet');
    if (!sheet) return;

    sheetRows = [];
    sheet.innerHTML = '';

    // wrapper que cresce com o conteúdo (margem + "arame" acompanham as linhas)
    sheetInner = document.createElement('div');
    sheetInner.className = 'sheet-inner';
    sheet.appendChild(sheetInner);

    for (let i = 0; i < INITIAL_ROWS; i++) {
        appendRow(sheet);
    }

    // Cria mais linhas ao rolar perto do final.
    sheet.addEventListener('scroll', () => {
        if (sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 240) {
            ensureTrailingRows(sheet);
        }
    });

    ensureTrailingRows(sheet);
}

// Cria uma linha do caderno e devolve o elemento (sem foco).
function createRow(sheet, index) {
    const row = document.createElement('div');
    row.className = 'notebook-row';
    row.tabIndex = 0;
    row.dataset.index = String(index);
    row.dataset.start = '';
    row.dataset.end = '';

    const time = document.createElement('div');
    time.className = 'row-time';
    time.textContent = '--:--';

    const content = document.createElement('div');
    content.className = 'row-content';
    content.contentEditable = 'true';
    content.spellcheck = false;
    content.setAttribute('role', 'textbox');
    content.setAttribute('aria-label', `Linha ${index + 1}`);

    row.appendChild(time);
    row.appendChild(content);

    const renderTimeLabel = () => {
        if (row.dataset.startLabel && row.dataset.endLabel) {
            time.textContent = `${row.dataset.startLabel} › ${row.dataset.endLabel}`;
        } else if (row.dataset.startLabel) {
            time.textContent = row.dataset.startLabel;
        } else {
            time.textContent = '--:--';
        }
    };
    row._renderTimeLabel = renderTimeLabel;

    const beginActivity = () => {
        row.classList.add('active');
        if (!row.dataset.start) {
            const now = new Date();
            row.dataset.start = now.toISOString();
            row.dataset.startLabel = formatTimeOnly(now);
            row.classList.add('start-set');
            renderTimeLabel();
            activityStart = now;
            setStatus(`Status: activity started at ${row.dataset.startLabel}`);
        }
    };

    // force = true permite (re)registrar o fim mesmo já encerrado (clique na hora).
    const endActivity = (force = false) => {
        if (!row.dataset.start) return;
        if (row.dataset.end && !force) return;
        const now = new Date();
        row.dataset.end = now.toISOString();
        row.dataset.endLabel = formatTimeOnly(now);
        row.classList.add('end-set');
        renderTimeLabel();
        activityEnd = now;
        setStatus(`Status: activity ended at ${row.dataset.endLabel}`);
        // Persiste o fim quando a linha já existe no servidor.
        if (row.dataset.entryId) {
            updateEntry(row.dataset.entryId, { ended_at: row.dataset.end }).then((ok) => {
                if (!ok) setStatus('Status: falha ao guardar o fim da atividade');
            });
        }
    };
    row._endActivity = endActivity;

    row.addEventListener('focusin', () => {
        if (!row.dataset.saved) {
            beginActivity();
        }
        ensureTrailingRows(sheet);
    });

    row.addEventListener('focusout', () => {
        row.classList.remove('active');
    });

    // Clicar na hora: sem início ainda -> começa a tarefa; com início -> encerra
    // (mesma ideia de clicar num card da lista de entradas).
    time.addEventListener('click', (event) => {
        event.stopPropagation();
        if (row.dataset.editing) return;
        if (row.dataset.start) {
            endActivity(true);
        } else {
            beginActivity();
            content.focus();
        }
    });

    // Clicar no texto de uma linha já salva abre a edição inline.
    content.addEventListener('click', () => {
        if (row.dataset.saved && !row.dataset.editing) {
            enterEditMode(row);
        }
    });

    content.addEventListener('input', () => ensureTrailingRows(sheet));

    // Sair da linha em edição confirma a alteração.
    content.addEventListener('blur', () => {
        if (row.dataset.editing) {
            commitEdit(row);
        }
    });

    content.addEventListener('keydown', (event) => {
        // Linha já salva e em edição inline.
        if (row.dataset.editing) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                commitEdit(row);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelEdit(row);
            }
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();

        if (!row.dataset.start) {
            beginActivity();
        }

        const value = content.textContent.trim();

        if (value && !row.dataset.saved) {
            // Trava a linha e salva no servidor.
            row.dataset.saved = '1';
            row.dataset.rawText = value;
            row.classList.add('committed');
            content.textContent = value;
            content.contentEditable = 'false';
            content.blur();
            saveSheetRow(row, value);
            focusNextRow(sheet, row);
            ensureTrailingRows(sheet);
        } else if (row.dataset.saved) {
            // Linha já salva: Enter só pula para a próxima.
            focusNextRow(sheet, row);
        }
    });

    return row;
}

// Move o foco para a próxima linha, criando-a se necessário.
function focusNextRow(sheet, row) {
    const nextIndex = Number(row.dataset.index) + 1;
    const next = sheetRows[nextIndex] || appendRow(sheet);
    next.querySelector('.row-content').focus({ preventScroll: true });
    revealRowIfNeeded(sheet, next);
}

// ============================================
// EDIÇÃO INLINE DE LINHAS JÁ SALVAS
// ============================================

function enterEditMode(row) {
    const content = row.querySelector('.row-content');
    row.dataset.editing = '1';
    row.classList.add('editing');
    content.contentEditable = 'true';
    content.textContent = row.dataset.rawText || content.textContent;
    content.focus();
    placeCaretEnd(content);
    setStatus('Status: editing entry (Enter salva, Esc cancela)');
}

async function commitEdit(row) {
    const content = row.querySelector('.row-content');
    const value = content.textContent.trim();
    const id = row.dataset.entryId;
    const original = row.dataset.rawText || '';

    delete row.dataset.editing;
    row.classList.remove('editing');
    content.contentEditable = 'false';

    if (!value) {
        content.textContent = original;
        setStatus('Status: edição vazia ignorada');
        return;
    }
    if (value === original) {
        content.textContent = original;
        return;
    }
    if (!id) {
        // Linha ainda sem id no servidor: guarda só em memória.
        row.dataset.rawText = value;
        content.textContent = value;
        return;
    }

    const updated = await updateEntry(id, { text: value });
    if (updated) {
        row.dataset.rawText = value;
        content.textContent = value;
        setStatus('Status: entry atualizada');
        loadEntries(currentFilterTag);
    } else {
        content.textContent = original;
        setStatus('Status: falha ao atualizar a entry');
    }
}

function cancelEdit(row) {
    const content = row.querySelector('.row-content');
    delete row.dataset.editing;
    row.classList.remove('editing');
    content.contentEditable = 'false';
    content.textContent = row.dataset.rawText || '';
    content.blur();
    setStatus('Status: edição cancelada');
}

function placeCaretEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

// Acrescenta uma linha ao final do caderno.
function appendRow(sheet) {
    sheet = sheet || document.getElementById('notebookSheet');
    if (!sheet) return null;
    if (!sheetInner || !sheetInner.isConnected) {
        sheetInner = sheet.querySelector('.sheet-inner') || sheet;
    }
    const row = createRow(sheet, sheetRows.length);
    sheetInner.appendChild(row);
    sheetRows.push(row);
    return row;
}

// Garante que sempre exista um bloco de linhas em branco após a última linha usada.
function ensureTrailingRows(sheet) {
    sheet = sheet || document.getElementById('notebookSheet');
    if (!sheet) return;

    let trailingEmpty = 0;
    for (let i = sheetRows.length - 1; i >= 0; i--) {
        const row = sheetRows[i];
        const content = row.querySelector('.row-content');
        const used = row.dataset.start || (content && content.textContent.trim() !== '');
        if (used) break;
        trailingEmpty++;
    }

    // Limite de segurança para não crescer sem parar.
    let guard = 0;
    while (trailingEmpty < TRAILING_ROWS && guard < TRAILING_ROWS + 2) {
        appendRow(sheet);
        trailingEmpty++;
        guard++;
    }
}

function setStatus(value) {
    const statusStrip = document.getElementById('statusStrip');
    if (statusStrip) {
        statusStrip.textContent = value;
    }
}

async function saveSheetRow(row, text) {
    if (!text) return;
    const id = await addEntry(text);
    if (id) {
        row.dataset.entryId = String(id);
        // Se o fim foi marcado antes do id voltar do servidor, persiste agora.
        if (row.dataset.end) {
            updateEntry(id, { ended_at: row.dataset.end });
        }
    }
}

// Formata só a hora (HH:MM) no fuso do browser.
function formatTimeOnly(date) {
    if (!(date instanceof Date) || isNaN(date)) return '--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Converte um timestamp do servidor (RFC3339 UTC) num Date local.
// Aceita também o formato legado "YYYYMMDDHHMM" (hora local).
function parseServerDate(value) {
    if (!value) return null;
    const s = String(value);
    if (/^\d{12}$/.test(s)) {
        return new Date(
            +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
            +s.slice(8, 10), +s.slice(10, 12)
        );
    }
    const dt = new Date(s);
    return isNaN(dt) ? null : dt;
}

// ============================================
// API CALLS
// ============================================

async function loadEntries(tag = null) {
    try {
        let url = '/api/entries';
        if (tag) {
            url += `?tag=${encodeURIComponent(tag)}`;
            currentFilterTag = tag;
        } else {
            currentFilterTag = null;
        }

        const response = await fetch(url);
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const entries = await response.json();
        renderEntries(entries);
        extractTags(entries);
        redrawCanvas();

        if (!sheetHydrated && !tag) {
            hydrateNotebookSheet(entries);
            sheetHydrated = true;
        }
    } catch (error) {
        console.error('Erro ao carregar entries:', error);
    }
}

// Preenche as linhas do caderno com as entradas já salvas (é o "endless": o
// que foi escrito continua na folha depois de recarregar).
function hydrateNotebookSheet(entries) {
    const sheet = document.getElementById('notebookSheet');
    if (!sheet || !Array.isArray(entries) || entries.length === 0) return;

    // API devolve mais recentes primeiro; na folha queremos ordem cronológica.
    const ordered = entries.slice().reverse();

    ordered.forEach((entry, i) => {
        const row = sheetRows[i] || appendRow(sheet);
        const content = row.querySelector('.row-content');

        const startVal = entry.started_at || entry.created_at;
        const startLabel = timeLabelFromCreatedAt(startVal);

        content.textContent = entry.raw_text;
        content.contentEditable = 'false';
        row.dataset.saved = '1';
        row.dataset.entryId = String(entry.id);
        row.dataset.rawText = entry.raw_text;
        row.dataset.start = startVal;
        row.dataset.startLabel = startLabel;
        row.classList.add('committed', 'start-set');

        if (entry.ended_at) {
            row.dataset.end = entry.ended_at;
            row.dataset.endLabel = formatTimeOnly(parseServerDate(entry.ended_at));
            row.classList.add('end-set');
        }

        row._renderTimeLabel();
    });

    ensureTrailingRows(sheet);

    const firstEmpty = sheetRows.find((r) => !r.dataset.saved && !r.dataset.start);
    if (firstEmpty) {
        firstEmpty.querySelector('.row-content').focus({ preventScroll: true });
        revealRowIfNeeded(sheet, firstEmpty);
    }
}

// Timestamp do servidor (RFC3339 UTC ou legado) -> "HH:MM" no fuso do browser.
function timeLabelFromCreatedAt(createdAt) {
    const d = parseServerDate(createdAt);
    return d ? formatTimeOnly(d) : '--:--';
}

// Cria a entry no servidor e devolve o id gerado (ou null em caso de erro).
async function addEntry(textOverride = null) {
    const text = (textOverride || '').trim();

    if (!text) {
        return null;
    }

    try {
        const response = await fetch('/api/entries', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: text }),
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return null;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        loadEntries(currentFilterTag);
        return data && data.id ? data.id : null;
    } catch (error) {
        console.error('Erro ao salvar entry:', error);
        alert('Erro ao salvar a anotação');
        return null;
    }
}

// Atualiza texto e/ou fim de atividade de uma entry existente.
// Devolve a entry atualizada (objeto) ou null em caso de erro.
async function updateEntry(id, body) {
    try {
        const response = await fetch(`/api/entry?id=${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return null;
        }
        if (!response.ok) {
            console.error('Erro ao atualizar entry:', response.status);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('Erro ao atualizar entry:', error);
        return null;
    }
}

// ============================================
// RENDERIZAÇÃO
// ============================================

function renderEntries(entries) {
    const list = document.getElementById('entriesList');
    list.innerHTML = '';

    if (entries.length === 0) {
        list.innerHTML = '<div style="color: #888; font-size: 11px;">Nenhuma anotação ainda</div>';
        return;
    }

    entries.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'entry-item';
        item.style.animation = `slideIn 0.3s ease-out ${index * 0.05}s backwards`;

        const timeDiv = document.createElement('div');
        timeDiv.className = 'entry-time';
        const createdDate = parseServerDate(entry.created_at);
        timeDiv.textContent = createdDate ? formatDateTime(createdDate) : entry.created_at;

        const textDiv = document.createElement('div');
        textDiv.className = 'entry-text';
        textDiv.innerHTML = formatEntryText(entry.raw_text);

        const rangeDiv = document.createElement('div');
        rangeDiv.className = 'activity-range';
        const endDate = parseServerDate(entry.ended_at);
        rangeDiv.textContent = endDate ? `Fim: ${formatDateTime(endDate)}` : 'Fim: clique para registrar';

        item.appendChild(timeDiv);
        item.appendChild(textDiv);
        item.appendChild(rangeDiv);

        if (entry.amount) {
            const amountDiv = document.createElement('div');
            amountDiv.className = 'amount';
            amountDiv.textContent = `€ ${entry.amount.toFixed(2)}`;
            item.appendChild(amountDiv);
        }

        item.addEventListener('click', async () => {
            const endTime = new Date();
            const updated = await updateEntry(entry.id, { ended_at: endTime.toISOString() });
            if (!updated) {
                setStatus('Status: falha ao guardar o fim da atividade');
                return;
            }

            rangeDiv.textContent = `Fim: ${formatDateTime(endTime)}`;
            setStatus(`Status: activity ended at ${formatTimeOnly(endTime)}`);

            // Reflete o fim na linha correspondente da folha, se estiver montada.
            const sheetRow = sheetRows.find((r) => r.dataset.entryId === String(entry.id));
            if (sheetRow) {
                sheetRow.dataset.end = endTime.toISOString();
                sheetRow.dataset.endLabel = formatTimeOnly(endTime);
                sheetRow.classList.add('end-set');
                if (sheetRow._renderTimeLabel) sheetRow._renderTimeLabel();
            }
        });

        list.appendChild(item);
    });

    // Adiciona animação
    if (!document.querySelector('style[data-animation]')) {
        const style = document.createElement('style');
        style.setAttribute('data-animation', 'true');
        style.textContent = `
            @keyframes slideIn {
                from {
                    opacity: 0;
                    transform: translateX(-20px);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
        `;
        document.head.appendChild(style);
    }
}

function extractTags(entries) {
    const tags = new Set();

    entries.forEach(entry => {
        if (entry.tags && entry.tags.length > 0) {
            entry.tags.forEach(tag => tags.add(tag));
        }
    });

    const tagsList = document.getElementById('tagsList');
    tagsList.innerHTML = '';

    if (tags.size === 0) {
        tagsList.innerHTML = '<div style="color: #888; font-size: 11px;">Nenhuma tag</div>';
        return;
    }

    tags.forEach(tag => {
        const button = document.createElement('button');
        button.className = 'tag-button';
        if (currentFilterTag === tag) {
            button.classList.add('active');
        }
        button.textContent = `#${tag}`;
        button.onclick = () => filterByTag(tag);
        tagsList.appendChild(button);
    });
}

function filterByTag(tag) {
    if (currentFilterTag === tag) {
        currentFilterTag = null;
        loadEntries();
    } else {
        loadEntries(tag);
    }
}

function formatEntryText(text) {
    let formatted = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Destaca tags
        .replace(/#(\w+)/g, '<span class="tag">#$1</span>')
        // Destaca valores
        .replace(/\[(\d+(?:[.,]\d{1,2})?)\]/g, '<span class="amount">[$1]</span>');

    return formatted;
}

function formatDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');

    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());

    return `${day}/${month}/${year} ${hour}:${minute}`;
}

function formatActivityTime(createdAt) {
    if (!createdAt || createdAt.length < 12) {
        return '—';
    }

    const year = createdAt.slice(0, 4);
    const month = createdAt.slice(4, 6);
    const day = createdAt.slice(6, 8);
    const hour = createdAt.slice(8, 10);
    const minute = createdAt.slice(10, 12);

    return `${day}/${month}/${year} ${hour}:${minute}`;
}

function redrawCanvas() {
    // sem canvas: apenas mantém o status visual da atividade
}

// ============================================
// UTILIDADES
// ============================================

function logout() {
    // o servidor apaga a sessão do banco e limpa o cookie
    window.location.href = '/logout';
}

function startActivity() {
    activityStart = new Date();
    activityEnd = null;
    const statusStrip = document.getElementById('statusStrip');
    if (statusStrip) {
        statusStrip.textContent = `Status: activity started at ${activityStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }
    redrawCanvas();
}

function endActivity() {
    const now = new Date();
    if (activityStart) {
        activityEnd = now;
        const statusStrip = document.getElementById('statusStrip');
        if (statusStrip) {
            statusStrip.textContent = `Status: finished at ${activityEnd.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        }
        redrawCanvas();
    }
}

