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
    };

    row.addEventListener('focusin', () => {
        beginActivity();
        ensureTrailingRows(sheet);
    });

    row.addEventListener('focusout', () => {
        row.classList.remove('active');
    });

    // Clicar na hora: sem início ainda -> começa a tarefa; com início -> encerra
    // (mesma ideia de clicar num card da lista de entradas).
    time.addEventListener('click', (event) => {
        event.stopPropagation();
        if (row.dataset.start) {
            endActivity(true);
        } else {
            beginActivity();
            content.focus();
        }
    });

    content.addEventListener('input', () => ensureTrailingRows(sheet));

    content.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!row.dataset.start) {
                beginActivity();
            }

            const value = content.textContent.trim();
            if (value && !row.dataset.saved) {
                saveSheetRow(value);
                // Mantém o texto escrito na linha do caderno e trava a linha.
                content.textContent = value;
                content.contentEditable = 'false';
                row.dataset.saved = '1';
                row.classList.add('committed');
                content.blur();

                const nextIndex = Number(row.dataset.index) + 1;
                const next = sheetRows[nextIndex] || appendRow(sheet);
                next.querySelector('.row-content').focus({ preventScroll: true });
                revealRowIfNeeded(sheet, next);
                ensureTrailingRows(sheet);
            } else if (row.dataset.saved) {
                // Linha já salva: Enter só pula para a próxima.
                const nextIndex = Number(row.dataset.index) + 1;
                const next = sheetRows[nextIndex] || appendRow(sheet);
                next.querySelector('.row-content').focus({ preventScroll: true });
                revealRowIfNeeded(sheet, next);
            }
        }
    });

    return row;
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

function saveSheetRow(text) {
    if (!text) return;
    addEntry(text);
}

function formatTimeOnly(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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
        const time = row.querySelector('.row-time');
        const label = timeLabelFromCreatedAt(entry.created_at);

        content.textContent = entry.raw_text;
        content.contentEditable = 'false';
        row.dataset.saved = '1';
        row.dataset.entryId = String(entry.id);
        row.dataset.start = entry.created_at;
        row.dataset.startLabel = label;
        row.classList.add('committed', 'start-set');
        time.textContent = label;
    });

    ensureTrailingRows(sheet);

    const firstEmpty = sheetRows.find((r) => !r.dataset.saved && !r.dataset.start);
    if (firstEmpty) {
        firstEmpty.querySelector('.row-content').focus({ preventScroll: true });
        revealRowIfNeeded(sheet, firstEmpty);
    }
}

// Aceita "YYYY-MM-DD HH:MM" (formato da API) ou "YYYYMMDDHHMM" -> "HH:MM"
function timeLabelFromCreatedAt(createdAt) {
    if (!createdAt) return '--:--';
    const m = String(createdAt).match(/(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    if (String(createdAt).length >= 12) {
        return `${createdAt.slice(8, 10)}:${createdAt.slice(10, 12)}`;
    }
    return '--:--';
}

async function addEntry(textOverride = null) {
    const text = (textOverride || '').trim();

    if (!text) {
        return;
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
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        loadEntries(currentFilterTag);
    } catch (error) {
        console.error('Erro ao salvar entry:', error);
        alert('Erro ao salvar a anotação');
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
        timeDiv.textContent = entry.created_at;

        const textDiv = document.createElement('div');
        textDiv.className = 'entry-text';
        textDiv.innerHTML = formatEntryText(entry.raw_text);

        const rangeDiv = document.createElement('div');
        rangeDiv.className = 'activity-range';
        rangeDiv.textContent = 'Fim: clique para registrar';

        item.appendChild(timeDiv);
        item.appendChild(textDiv);
        item.appendChild(rangeDiv);

        if (entry.amount) {
            const amountDiv = document.createElement('div');
            amountDiv.className = 'amount';
            amountDiv.textContent = `€ ${entry.amount.toFixed(2)}`;
            item.appendChild(amountDiv);
        }

        item.addEventListener('click', () => {
            const endTime = new Date();
            const formattedEnd = formatDateTime(endTime);
            rangeDiv.textContent = `Fim: ${formattedEnd}`;

            const statusStrip = document.getElementById('statusStrip');
            if (statusStrip) {
                statusStrip.textContent = `Status: activity ended at ${formattedEnd}`;
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

