let currentFilterTag = null;
let activityStart = null;
let activityEnd = null;
let sheetRows = [];
let sheetHydrated = false;
let sheetInner = null;
let activeTagsOnly = false;
let lastEntries = [];
// allEntries: lista completa (sem filtro de tag), usada para (re)montar o caderno.
let allEntries = [];
// showOpenOnly: esconde do caderno as linhas que já têm hora de fim.
let showOpenOnly = false;
// Linha do caderno atualmente aberta no modal de edição de horário.
let timeModalRow = null;
// Estado do painel de calendário (sempre começa retraído).
let calendarOpen = false;
let calendarViewYear = new Date().getFullYear();
let calendarViewMonth = new Date().getMonth();

// Caderno "endless": começa com um bloco de linhas e cria mais
// dinamicamente conforme o final se aproxima.
const INITIAL_ROWS = 25;
const TRAILING_ROWS = 12;

// Intervalo do polling de sincronização (ms) — rede de segurança; o caminho
// rápido é o SSE em connectEvents().
const LIVE_SYNC_INTERVAL_MS = 45000;

// Carrega entries ao abrir a página
document.addEventListener('DOMContentLoaded', () => {
    restoreTheme();
    restoreHeaderState();
    restoreSidebarState();
    restoreActiveTagsFilterState();
    restoreOpenOnlyState();
    setupTimeEditModal();
    setupCalendar();
    setupHelpModal();
    loadCurrentUser();
    buildNotebookSheet();
    loadEntries();
    startLiveSync();
    alignCalendarButton();

    let alignResizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(alignResizeTimer);
        alignResizeTimer = setTimeout(alignCalendarButton, 120);
    });
});

// Mantém o botão do calendário (dentro de .header-actions, sem sair de lá)
// alinhado com a borda direita da caixa maior do caderno (.notebook-section),
// em vez de ficar colado no canto do header junto dos outros ícones. Um
// position:relative + right desloca só esse botão, sem empurrar os vizinhos.
function alignCalendarButton() {
    const btn = document.getElementById('calendarToggleBtn');
    const section = document.querySelector('.notebook-section');
    const header = document.querySelector('header');
    const panel = document.getElementById('calendarPanel');
    if (!btn || !section) return;

    // Reconstrói a posição "natural" (sem o deslocamento já aplicado) SEM
    // zerar o style antes de medir: zerar e reescrever é uma segunda escrita
    // de `right`, e como o botão tem transition, isso pintava um pulo visível
    // (volta pra posição natural, depois volta pra posição alinhada) a cada
    // clique/resize. Uma escrita só = sem animação de ida e volta.
    const currentOffset = parseFloat(btn.style.right) || 0;
    const btnRect = btn.getBoundingClientRect();
    const naturalRight = btnRect.right + currentOffset;
    const sectionRect = section.getBoundingClientRect();

    // Desloca só este botão (sem empurrar os vizinhos) até sua borda direita
    // encostar exatamente na borda direita da caixa do caderno — a mesma
    // linha reta que separa o caderno da sidebar.
    const offset = Math.round(naturalRight - sectionRect.right);
    btn.style.right = `${offset}px`;

    // O painel do calendário abre "para a esquerda do botão": sua borda
    // direita fica na mesma linha vertical (distância até a borda direita da
    // viewport = distância da caixa do caderno até essa borda).
    if (panel) {
        panel.style.right = `${Math.round(window.innerWidth - sectionRect.right)}px`;
        if (header) {
            panel.style.top = `${Math.round(header.getBoundingClientRect().bottom + 6)}px`;
        }
    }
}

// Mostra o usuário logado no cabeçalho.
async function loadCurrentUser() {
    try {
        const res = await fetch('/api/me', { cache: 'no-store' });
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
    if (!collapsed) alignCalendarButton();
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
    alignCalendarButton();
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

// ============================================
// FILTRO "SÓ TAGS ATIVAS" (esconde tags cujas entries já foram concluídas)
// ============================================

function restoreActiveTagsFilterState() {
    let on = false;
    try {
        on = localStorage.getItem('activeTagsOnly') === '1';
    } catch (e) { /* ignore */ }
    applyActiveTagsFilterState(on);
}

function applyActiveTagsFilterState(on) {
    activeTagsOnly = on;
    const btn = document.getElementById('activeTagsToggleBtn');
    if (btn) btn.classList.toggle('active', on);
    extractTags(lastEntries);
}

function toggleActiveTagsFilter() {
    const on = !activeTagsOnly;
    applyActiveTagsFilterState(on);
    try {
        localStorage.setItem('activeTagsOnly', on ? '1' : '0');
    } catch (e) { /* ignore */ }
}

// ============================================
// FILTRO "OPEN ONLY" DO CADERNO (esconde linhas já concluídas)
// ============================================

function restoreOpenOnlyState() {
    let on = false;
    try {
        on = localStorage.getItem('showOpenOnly') === '1';
    } catch (e) { /* ignore */ }
    showOpenOnly = on;
    const btn = document.getElementById('openOnlyToggleBtn');
    if (btn) btn.classList.toggle('active', on);
}

function toggleOpenOnly() {
    showOpenOnly = !showOpenOnly;
    const btn = document.getElementById('openOnlyToggleBtn');
    if (btn) btn.classList.toggle('active', showOpenOnly);
    try {
        localStorage.setItem('showOpenOnly', showOpenOnly ? '1' : '0');
    } catch (e) { /* ignore */ }
    renderSheet(allEntries, { focusEmpty: false });
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
                if (!ok) {
                    setStatus('Status: failed to save activity end');
                } else {
                    maybeShowTagRemovalModal(row.dataset.entryId, extractTagsFromText(row.dataset.rawText));
                    reloadAll();
                }
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
        // Linha vazia abandonada: desfaz o início registrado ao focar, para
        // não gravar depois uma entry com hora de início desatualizada.
        if (!row.dataset.saved && !row.dataset.end && row.dataset.start && content.textContent.trim() === '') {
            row.dataset.start = '';
            delete row.dataset.startLabel;
            row.classList.remove('start-set');
            renderTimeLabel();
        }
    });

    // Clicar na hora:
    //  - linha já com início E fim -> abre o modal (editar horários, apagar);
    //  - linha salva só com início (sem fim) -> um clique já encerra, direto;
    //  - linha nova/sem texto ainda -> começa a atividade (ou encerra se já
    //    tinha começado), sem persistir id nenhum.
    time.addEventListener('click', (event) => {
        event.stopPropagation();
        if (row.dataset.editing) return;
        if (row.dataset.entryId) {
            if (row.dataset.start && row.dataset.end) {
                openTimeEditModal(row);
            } else {
                endActivity(true);
            }
        } else if (row.dataset.start) {
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
    setStatus('Status: editing entry (Enter to save, Esc to cancel)');
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
        setStatus('Status: empty edit ignored');
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
        setStatus('Status: entry updated');
        loadEntries(currentFilterTag);
    } else {
        content.textContent = original;
        setStatus('Status: failed to update entry');
    }
}

function cancelEdit(row) {
    const content = row.querySelector('.row-content');
    delete row.dataset.editing;
    row.classList.remove('editing');
    content.contentEditable = 'false';
    content.textContent = row.dataset.rawText || '';
    content.blur();
    setStatus('Status: edit canceled');
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

        const response = await fetch(url, { cache: 'no-store' });
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const entries = await response.json();
        if (!tag) {
            allEntries = entries;
            if (calendarOpen) renderCalendar();
        }
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
    renderSheet(entries, { focusEmpty: true });
}

// Reconstrói a folha do zero a partir de uma lista de entradas.
// Insere uma linha divisória sempre que a data muda e, com "Open only" ligado,
// esconde as linhas que já têm hora de fim. Texto ainda não salvo é preservado.
function renderSheet(entries, opts) {
    const options = opts || {};
    const focusEmpty = options.focusEmpty === true;

    const sheet = document.getElementById('notebookSheet');
    if (!sheet) return;
    if (!Array.isArray(entries)) entries = [];

    if (!sheetInner || !sheetInner.isConnected) {
        sheetInner = sheet.querySelector('.sheet-inner');
    }
    if (!sheetInner) return;

    // API devolve mais recentes primeiro; na folha queremos ordem cronológica.
    let ordered = entries.slice().reverse();
    if (showOpenOnly) {
        ordered = ordered.filter((e) => !e.ended_at);
    }

    // Preserva o que o usuário está digitando numa linha ainda não salva.
    const drafts = [];
    sheetRows.forEach((r) => {
        const c = r.querySelector('.row-content');
        if (!r.dataset.saved && c && c.textContent.trim() !== '') {
            drafts.push({
                text: c.textContent,
                start: r.dataset.start || '',
                startLabel: r.dataset.startLabel || '',
            });
        }
    });

    sheetRows = [];
    sheetInner.innerHTML = '';

    let lastDateKey = null;
    ordered.forEach((entry) => {
        const startVal = entry.started_at || entry.created_at;
        const startDate = parseServerDate(startVal);
        const key = startDate ? dateKey(startDate) : null;
        if (key && key !== lastDateKey) {
            sheetInner.appendChild(createDividerRow(startDate));
            lastDateKey = key;
        }

        const row = appendRow(sheet);
        const content = row.querySelector('.row-content');
        content.textContent = entry.raw_text;
        content.contentEditable = 'false';
        row.dataset.saved = '1';
        row.dataset.entryId = String(entry.id);
        row.dataset.rawText = entry.raw_text;
        row.dataset.start = startVal;
        row.dataset.startLabel = startDate ? formatTimeOnly(startDate) : '--:--';
        row.classList.add('committed', 'start-set');

        if (entry.ended_at) {
            row.dataset.end = entry.ended_at;
            row.dataset.endLabel = formatTimeOnly(parseServerDate(entry.ended_at));
            row.classList.add('end-set');
        }

        row._renderTimeLabel();
    });

    // Recoloca os rascunhos em linhas novas ao final.
    drafts.forEach((d) => {
        const row = appendRow(sheet);
        row.querySelector('.row-content').textContent = d.text;
        if (d.start) {
            row.dataset.start = d.start;
            row.dataset.startLabel = d.startLabel;
            row.classList.add('start-set');
            row._renderTimeLabel();
        }
    });

    if (ordered.length === 0 && drafts.length === 0) {
        for (let i = 0; i < INITIAL_ROWS; i++) appendRow(sheet);
    }

    ensureTrailingRows(sheet);

    if (focusEmpty) {
        const firstEmpty = sheetRows.find((r) =>
            !r.dataset.saved && !r.dataset.start &&
            r.querySelector('.row-content').textContent.trim() === ''
        );
        if (firstEmpty) {
            firstEmpty.querySelector('.row-content').focus({ preventScroll: true });
            revealRowIfNeeded(sheet, firstEmpty);
        }
    }
}

// Chave "ano-mês-dia" no fuso do browser, para detectar troca de dia.
function dateKey(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Linha divisória com a data por extenso (não editável, fora de sheetRows).
function createDividerRow(date) {
    const div = document.createElement('div');
    div.className = 'notebook-row day-divider';
    const label = document.createElement('div');
    label.className = 'day-divider-label';
    label.textContent = date.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    div.appendChild(label);
    return div;
}

// Recarrega a lista lateral (respeitando o filtro de tag) e remonta o caderno
// a partir da lista completa de entradas. focusEmpty repõe o foco na primeira
// linha em branco depois de remontar (útil no sync automático em segundo plano;
// dispensável logo após uma ação explícita do usuário).
async function reloadAll(opts) {
    const focusEmpty = !!(opts && opts.focusEmpty);
    const tag = currentFilterTag;
    await loadEntries(tag);
    if (tag) {
        await loadAllEntries();
        if (calendarOpen) renderCalendar();
    }
    renderSheet(allEntries, { focusEmpty });
}

// ============================================
// SINCRONIZAÇÃO ENTRE SESSÕES/DISPOSITIVOS
// ============================================
// O servidor empurra um evento via Server-Sent Events (GET /api/events)
// sempre que uma entry deste usuário muda em qualquer sessão — é o caminho
// rápido (~1s). Como reforço, também recarregamos (a) sempre que a aba volta
// a ficar visível/em foco e (b) por polling de baixa frequência, caso o SSE
// caia e o navegador demore a reconectar.
let liveSyncInFlight = false;
let eventSource = null;

// Evita atropelar o usuário: só sincroniza se não houver texto não salvo numa
// linha nova, nem uma edição inline em andamento, nem um modal aberto.
function canLiveSync() {
    if (document.visibilityState !== 'visible') return false;

    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('row-content')) {
        if (active.textContent.trim() !== '') return false;
        const row = active.closest('.notebook-row');
        if (row && row.dataset.editing) return false;
    }

    const timeModal = document.getElementById('timeEditOverlay');
    const tagModal = document.getElementById('tagRemovalOverlay');
    if (timeModal && !timeModal.hidden) return false;
    if (tagModal && !tagModal.hidden) return false;

    return true;
}

async function liveSync() {
    if (liveSyncInFlight || !canLiveSync()) return;
    liveSyncInFlight = true;
    try {
        await reloadAll({ focusEmpty: true });
    } finally {
        liveSyncInFlight = false;
    }
}

function startLiveSync() {
    setInterval(liveSync, LIVE_SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') liveSync();
    });
    window.addEventListener('focus', liveSync);
    connectEvents();
}

// Abre a conexão SSE com o servidor. EventSource reconecta sozinho em caso de
// queda de rede; se a sessão expirou (401), o servidor fecha sem 200 e o
// browser não tenta de novo — o próximo liveSync (foco/polling) vai bater
// no fetch normal, que já redireciona para /login.
function connectEvents() {
    if (eventSource || typeof EventSource === 'undefined') return;
    eventSource = new EventSource('/api/events');
    eventSource.addEventListener('changed', () => {
        liveSync();
    });
}

// Busca a lista completa de entradas (sem filtro de tag) e guarda em allEntries.
async function loadAllEntries() {
    try {
        const res = await fetch('/api/entries', { cache: 'no-store' });
        if (res.status === 401) {
            window.location.href = '/login';
            return;
        }
        if (res.ok) {
            allEntries = await res.json();
        }
    } catch (e) { /* ignore */ }
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
            cache: 'no-store',
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
        console.error('Error saving entry:', error);
        alert('Failed to save entry');
        return null;
    }
}

// Apaga uma entry no servidor. Devolve true em caso de sucesso.
async function deleteEntry(id) {
    try {
        const response = await fetch(`/api/entry?id=${encodeURIComponent(id)}`, {
            method: 'DELETE',
            cache: 'no-store',
        });
        if (response.status === 401) {
            window.location.href = '/login';
            return false;
        }
        return response.ok;
    } catch (error) {
        console.error('Error deleting entry:', error);
        return false;
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
            cache: 'no-store',
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
        list.innerHTML = '<div style="color: #888; font-size: 11px;">No entries yet</div>';
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
        rangeDiv.textContent = endDate ? `End: ${formatDateTime(endDate)}` : 'Not finished yet';

        item.appendChild(timeDiv);
        item.appendChild(textDiv);
        item.appendChild(rangeDiv);

        if (entry.amount) {
            const amountDiv = document.createElement('div');
            amountDiv.className = 'amount';
            amountDiv.textContent = `€ ${entry.amount.toFixed(2)}`;
            item.appendChild(amountDiv);
        }

        // Finishing a line only happens by clicking its time in the notebook
        // now — a card here just jumps you to that line to edit it.
        item.title = 'Click to edit this line in the notebook';
        item.addEventListener('click', () => {
            jumpToEntry(entry.id);
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

// Leva o usuário até a linha no caderno (desligando "Open only" se for
// preciso, já que uma entry concluída pode estar escondida por esse filtro)
// e entra no modo de edição inline dela.
function jumpToEntry(entryId) {
    const sheet = document.getElementById('notebookSheet');
    let row = sheetRows.find((r) => r.dataset.entryId === String(entryId));

    if (!row && showOpenOnly) {
        showOpenOnly = false;
        const btn = document.getElementById('openOnlyToggleBtn');
        if (btn) btn.classList.remove('active');
        try { localStorage.setItem('showOpenOnly', '0'); } catch (e) { /* ignore */ }
        renderSheet(allEntries, { focusEmpty: false });
        row = sheetRows.find((r) => r.dataset.entryId === String(entryId));
    }

    if (!row) {
        setStatus('Status: could not find that line in the notebook');
        return;
    }

    revealRowIfNeeded(sheet, row);
    if (row.dataset.saved) enterEditMode(row);
}

function extractTags(entries) {
    lastEntries = entries;
    const tags = new Set();
    // counts: nº de linhas que usam cada tag (respeitando o filtro "Active only").
    const counts = new Map();

    // Mantém sempre visível a tag do filtro atual, mesmo que ela se qualifique
    // para ser escondida pelo toggle "só ativas" — evita ficar preso num
    // filtro sem forma de desligá-lo pela lista.
    if (currentFilterTag) tags.add(currentFilterTag);

    entries.forEach(entry => {
        if (!entry.tags || entry.tags.length === 0) return;
        if (activeTagsOnly && entry.ended_at) return;
        [...new Set(entry.tags)].forEach(tag => {
            // Uma tag que é uma cor (#red, #F54927...) é uma diretiva pro
            // calendário, não uma tag de agrupamento — não vira botão de filtro.
            if (colorFromTag(tag)) return;
            tags.add(tag);
            counts.set(tag, (counts.get(tag) || 0) + 1);
        });
    });

    const tagsList = document.getElementById('tagsList');
    tagsList.innerHTML = '';

    if (tags.size === 0) {
        tagsList.innerHTML = '<div style="color: #888; font-size: 11px;">No tags</div>';
        return;
    }

    tags.forEach(tag => {
        const button = document.createElement('button');
        button.className = 'tag-button';
        if (currentFilterTag === tag) {
            button.classList.add('active');
        }

        const count = counts.get(tag) || 0;

        const name = document.createElement('span');
        name.className = 'tag-name';
        name.textContent = `#${tag}`;
        button.appendChild(name);

        const badge = document.createElement('span');
        badge.className = 'tag-count';
        badge.textContent = String(count);
        button.appendChild(badge);

        // Nome completo no title, já que o botão pode truncar tags longas.
        button.title = `#${tag} (${count})`;
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

// ============================================
// MODAL DE REMOÇÃO DE TAGS AO CONCLUIR UMA ENTRY
// ============================================

// Extrai tags (#tag) de um texto no cliente, espelhando o regex do backend
// (internal/entry/entry.go), para não precisar reconsultar o servidor.
function extractTagsFromText(text) {
    const set = new Set();
    const re = /#(\w+)/g;
    let m;
    while ((m = re.exec(text || ''))) {
        if (colorFromTag(m[1])) continue; // diretiva de cor do calendário, não uma tag
        set.add(m[1]);
    }
    return [...set];
}

function maybeShowTagRemovalModal(entryId, tags) {
    const unique = [...new Set(tags || [])];
    if (!entryId || unique.length === 0) return;
    openTagRemovalModal(entryId, unique);
}

function openTagRemovalModal(entryId, tags) {
    const overlay = document.getElementById('tagRemovalOverlay');
    const list = document.getElementById('tagRemovalList');
    if (!overlay || !list) return;

    list.innerHTML = '';
    tags.forEach(tag => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = tag;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(`#${tag}`));
        list.appendChild(label);
    });

    const confirmBtn = document.getElementById('tagRemovalConfirmBtn');
    const removeAllBtn = document.getElementById('tagRemovalRemoveAllBtn');
    const keepBtn = document.getElementById('tagRemovalKeepBtn');

    const close = () => { overlay.hidden = true; };

    const removeTags = async (selected) => {
        close();
        if (selected.length === 0) return;
        const updated = await updateEntry(entryId, { remove_tags: selected });
        if (updated) {
            loadEntries(currentFilterTag);
        } else {
            setStatus('Status: failed to remove tags');
        }
    };

    // "Remove all" só marca todas as caixas e deixa o mesmo fluxo do
    // "Remove selected" cuidar do resto.
    removeAllBtn.onclick = () => {
        list.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
        confirmBtn.click();
    };

    confirmBtn.onclick = async () => {
        const selected = [...list.querySelectorAll('input:checked')].map(cb => cb.value);
        await removeTags(selected);
    };
    keepBtn.onclick = close;

    overlay.hidden = false;
}

// ============================================
// MODAL DE EDIÇÃO DE HORÁRIO / EXCLUSÃO DE LINHA
// ============================================

// Date -> "YYYY-MM-DDTHH:MM" no fuso do browser (valor de <input datetime-local>).
function toLocalInputValue(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Valor de <input datetime-local> (hora local) -> Date, ou null.
function fromLocalInputValue(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d) ? null : d;
}

// Liga os botões do modal uma única vez (o alvo é guardado em timeModalRow).
function setupTimeEditModal() {
    const overlay = document.getElementById('timeEditOverlay');
    if (!overlay) return;

    const startInput = document.getElementById('timeEditStart');
    const endInput = document.getElementById('timeEditEnd');

    document.getElementById('timeEditEndNow').onclick = () => {
        endInput.value = toLocalInputValue(new Date());
    };
    document.getElementById('timeEditEndClear').onclick = () => {
        endInput.value = '';
    };
    document.getElementById('timeEditCancelBtn').onclick = closeTimeEditModal;
    document.getElementById('timeEditSaveBtn').onclick = saveTimeEditModal;
    document.getElementById('timeEditDeleteBtn').onclick = deleteTimeEditModalRow;

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeTimeEditModal();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !overlay.hidden) closeTimeEditModal();
    });
}

function openTimeEditModal(row) {
    const overlay = document.getElementById('timeEditOverlay');
    if (!overlay || !row || !row.dataset.entryId) return;

    timeModalRow = row;

    const startDate = parseServerDate(row.dataset.start);
    const endDate = parseServerDate(row.dataset.end);
    document.getElementById('timeEditStart').value = toLocalInputValue(startDate || new Date());
    document.getElementById('timeEditEnd').value = endDate ? toLocalInputValue(endDate) : '';

    overlay.hidden = false;
    setStatus(`Status: editing line #${row.dataset.entryId}`);
}

function closeTimeEditModal() {
    const overlay = document.getElementById('timeEditOverlay');
    if (overlay) overlay.hidden = true;
    timeModalRow = null;
}

async function saveTimeEditModal() {
    const row = timeModalRow;
    if (!row || !row.dataset.entryId) {
        closeTimeEditModal();
        return;
    }

    const startDate = fromLocalInputValue(document.getElementById('timeEditStart').value);
    if (!startDate) {
        setStatus('Status: invalid start time');
        return;
    }
    const endValue = document.getElementById('timeEditEnd').value;
    const endDate = fromLocalInputValue(endValue);
    if (endValue && !endDate) {
        setStatus('Status: invalid end time');
        return;
    }
    if (endDate && endDate < startDate) {
        setStatus('Status: end time is before start time');
        return;
    }

    const body = {
        started_at: startDate.toISOString(),
        ended_at: endDate ? endDate.toISOString() : '',
    };

    const updated = await updateEntry(row.dataset.entryId, body);
    if (!updated) {
        setStatus('Status: failed to update line');
        return;
    }

    closeTimeEditModal();
    setStatus('Status: line updated');
    await reloadAll();
}

async function deleteTimeEditModalRow() {
    const row = timeModalRow;
    if (!row || !row.dataset.entryId) {
        closeTimeEditModal();
        return;
    }
    if (!confirm('Delete this line permanently?')) return;

    const ok = await deleteEntry(row.dataset.entryId);
    if (!ok) {
        setStatus('Status: failed to delete line');
        return;
    }

    closeTimeEditModal();
    setStatus('Status: line deleted');
    await reloadAll();
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

// ============================================
// CALENDÁRIO
// ============================================
// Painel retraído (só o emoji no header) que marca, no mês visível, os dias
// citados no texto das linhas (dd/mm/yyyy ou yyyy-mm-dd). Tudo client-side:
// não há campo novo no banco, é uma leitura de raw_text já carregado.

const CALENDAR_HEX_RE = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/;
// dd/mm/yyyy (dia primeiro) e yyyy-mm-dd (ISO), soltos em qualquer lugar do texto.
const CALENDAR_DATE_SLASH_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const CALENDAR_DATE_ISO_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
// Intervalo: duas datas (qualquer um dos dois formatos) separadas por "~",
// ex.: "05/10/2026 ~ 10/10/2026".
const CALENDAR_DATE_TOKEN = '(\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{1,2}-\\d{1,2})';
const CALENDAR_RANGE_RE = new RegExp(CALENDAR_DATE_TOKEN + '\\s*~\\s*' + CALENDAR_DATE_TOKEN, 'g');
// Intervalo máximo aceito, pra não gerar um range gigante por um "~" perdido.
const CALENDAR_MAX_RANGE_DAYS = 366 * 2;

// Confere se o browser reconhece `name` como cor CSS válida (nome ou hex).
function isValidCssColor(name) {
    const probe = new Option().style;
    probe.color = '';
    probe.color = name;
    return probe.color !== '';
}

// Tag -> cor CSS, se a tag for um nome de cor reconhecido ou um hex de 3/6
// dígitos (ex: #red, #27F5B4 viram tags "red"/"27F5B4"). Senão, null.
function colorFromTag(tag) {
    if (CALENDAR_HEX_RE.test(tag)) return `#${tag}`;
    if (/^[a-zA-Z]+$/.test(tag) && isValidCssColor(tag)) return tag.toLowerCase();
    return null;
}

// Chave estável de dia (independe de zero à esquerda).
function calendarDayKey(year, month, day) {
    return `${year}-${month}-${day}`;
}

// true se year/month(1-12)/day formarem uma data real (rejeita 31/02 etc.).
function isRealCalendarDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

// Interpreta um único token de data ("dd/mm/yyyy" ou "yyyy-mm-dd") já
// isolado do texto (ex: dentro de um intervalo "a ~ b"). Devolve
// {year, month(1-12), day} ou null se inválido.
function parseDateToken(token) {
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token);
    if (m) {
        const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
        return isRealCalendarDate(year, month, day) ? { year, month, day } : null;
    }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
    if (m) {
        const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
        return isRealCalendarDate(year, month, day) ? { year, month, day } : null;
    }
    return null;
}

// calendarDayKey() de cada dia entre a e b, inclusive nas duas pontas
// (aceita a data final vindo antes da inicial e simplesmente inverte).
function keysInRange(a, b) {
    let start = new Date(a.year, a.month - 1, a.day);
    let end = new Date(b.year, b.month - 1, b.day);
    if (start > end) { const t = start; start = end; end = t; }

    const keys = [];
    const cur = new Date(start);
    let guard = 0;
    while (cur <= end && guard < CALENDAR_MAX_RANGE_DAYS) {
        keys.push(calendarDayKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
        cur.setDate(cur.getDate() + 1);
        guard++;
    }
    return keys;
}

// Extrai as datas citadas em `text`, já validadas, como calendarDayKey().
// Cobre tanto datas soltas quanto intervalos "data ~ data" (todo dia do
// intervalo entra, com a mesma cor/mensagem da linha).
function datesInText(text) {
    const keys = [];
    if (!text) return keys;

    let m;
    CALENDAR_RANGE_RE.lastIndex = 0;
    while ((m = CALENDAR_RANGE_RE.exec(text))) {
        const a = parseDateToken(m[1]);
        const b = parseDateToken(m[2]);
        if (a && b) keys.push(...keysInRange(a, b));
    }

    CALENDAR_DATE_SLASH_RE.lastIndex = 0;
    while ((m = CALENDAR_DATE_SLASH_RE.exec(text))) {
        const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
        if (isRealCalendarDate(year, month, day)) keys.push(calendarDayKey(year, month - 1, day));
    }
    CALENDAR_DATE_ISO_RE.lastIndex = 0;
    while ((m = CALENDAR_DATE_ISO_RE.exec(text))) {
        const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
        if (isRealCalendarDate(year, month, day)) keys.push(calendarDayKey(year, month - 1, day));
    }
    // Datas soltas também batem nas pontas de um intervalo já processado
    // acima — dedupe pra não duplicar a mesma linha no tooltip do dia.
    return [...new Set(keys)];
}

// Varre allEntries e monta dayKey -> { color, texts }. Se mais de uma entry
// citar a mesma data com cores diferentes, a primeira encontrada vale — não
// há uma regra "certa" para empate, só precisa ser previsível.
function buildCalendarMarks() {
    const marks = new Map();
    (allEntries || []).forEach((entry) => {
        const keys = datesInText(entry.raw_text);
        if (keys.length === 0) return;

        let color = null;
        for (const tag of entry.tags || []) {
            color = colorFromTag(tag);
            if (color) break;
        }

        keys.forEach((key) => {
            let mark = marks.get(key);
            if (!mark) {
                mark = { color: null, texts: [] };
                marks.set(key, mark);
            }
            if (color && !mark.color) mark.color = color;
            mark.texts.push(entry.raw_text);
        });
    });
    return marks;
}

// Preto ou branco, o que for mais legível sobre `bgColor` (nome CSS ou hex).
function readableTextColor(bgColor) {
    const probe = document.createElement('div');
    probe.style.color = bgColor;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const parts = rgb.match(/\d+/g);
    if (!parts) return '#111111';
    const [r, g, b] = parts.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#111111' : '#ffffff';
}

function setupCalendar() {
    const toggleBtn = document.getElementById('calendarToggleBtn');
    const panel = document.getElementById('calendarPanel');
    const prevBtn = document.getElementById('calendarPrevBtn');
    const nextBtn = document.getElementById('calendarNextBtn');
    if (!toggleBtn || !panel || !prevBtn || !nextBtn) return;

    toggleBtn.onclick = (event) => {
        event.stopPropagation();
        toggleCalendar();
    };
    prevBtn.onclick = () => {
        calendarViewMonth -= 1;
        if (calendarViewMonth < 0) { calendarViewMonth = 11; calendarViewYear -= 1; }
        renderCalendar();
    };
    nextBtn.onclick = () => {
        calendarViewMonth += 1;
        if (calendarViewMonth > 11) { calendarViewMonth = 0; calendarViewYear += 1; }
        renderCalendar();
    };

    // Clique dentro do painel não deve fechá-lo; clique fora, sim.
    panel.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => {
        if (calendarOpen) toggleCalendar();
    });
}

// ============================================
// MODAL DE AJUDA (EN/ES)
// ============================================

function setupHelpModal() {
    const overlay = document.getElementById('helpOverlay');
    const toggleBtn = document.getElementById('helpToggleBtn');
    const closeBtn = document.getElementById('helpCloseBtn');
    const enBtn = document.getElementById('helpLangEnBtn');
    const esBtn = document.getElementById('helpLangEsBtn');
    const bodyEn = document.getElementById('helpBodyEn');
    const bodyEs = document.getElementById('helpBodyEs');
    if (!overlay || !toggleBtn || !closeBtn || !enBtn || !esBtn || !bodyEn || !bodyEs) return;

    const showLang = (lang) => {
        bodyEn.hidden = lang !== 'en';
        bodyEs.hidden = lang !== 'es';
        enBtn.classList.toggle('active', lang === 'en');
        esBtn.classList.toggle('active', lang === 'es');
    };

    toggleBtn.onclick = (event) => {
        event.stopPropagation();
        overlay.hidden = false;
    };
    closeBtn.onclick = () => { overlay.hidden = true; };
    enBtn.onclick = () => showLang('en');
    esBtn.onclick = () => showLang('es');

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) overlay.hidden = true;
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
    });
}

function toggleCalendar() {
    calendarOpen = !calendarOpen;
    const panel = document.getElementById('calendarPanel');
    if (panel) panel.hidden = !calendarOpen;
    if (calendarOpen) {
        alignCalendarButton();
        renderCalendar();
    }
}

// Substitui o ano exibido por um <input type=number>; Enter confirma, Esc ou
// blur também fecham (blur confirma o que estiver digitado).
function editCalendarYear() {
    const monthYearEl = document.getElementById('calendarMonthYear');
    const yearEl = monthYearEl.querySelector('.calendar-year');
    if (!yearEl) return;

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'calendar-year-input';
    input.value = String(calendarViewYear);

    const commit = () => {
        const value = parseInt(input.value, 10);
        if (!Number.isNaN(value) && value > 0) calendarViewYear = value;
        renderCalendar();
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.preventDefault(); renderCalendar(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (event) => event.stopPropagation());

    yearEl.replaceWith(input);
    input.focus();
    input.select();
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const monthYearEl = document.getElementById('calendarMonthYear');
    if (!grid || !monthYearEl) return;

    const year = calendarViewYear;
    const month = calendarViewMonth;
    const marks = buildCalendarMarks();

    monthYearEl.innerHTML = '';
    const monthLabel = document.createElement('span');
    monthLabel.textContent = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long' }) + ' ';
    const yearLabel = document.createElement('span');
    yearLabel.className = 'calendar-year';
    yearLabel.textContent = String(year);
    yearLabel.title = 'Click to change year';
    yearLabel.onclick = (event) => { event.stopPropagation(); editCalendarYear(); };
    monthYearEl.appendChild(monthLabel);
    monthYearEl.appendChild(yearLabel);

    grid.innerHTML = '';

    const startWeekday = new Date(year, month, 1).getDay(); // 0 = domingo
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const today = new Date();

    const TOTAL_CELLS = 42; // 6 semanas fixas, grade sempre do mesmo tamanho
    for (let i = 0; i < TOTAL_CELLS; i++) {
        let cellMonth = month;
        let cellYear = year;
        let cellDay;
        let outside = false;

        if (i < startWeekday) {
            cellDay = daysInPrevMonth - startWeekday + 1 + i;
            cellMonth = month - 1;
            outside = true;
        } else if (i >= startWeekday + daysInMonth) {
            cellDay = i - (startWeekday + daysInMonth) + 1;
            cellMonth = month + 1;
            outside = true;
        } else {
            cellDay = i - startWeekday + 1;
        }
        if (cellMonth < 0) { cellMonth = 11; cellYear -= 1; }
        if (cellMonth > 11) { cellMonth = 0; cellYear += 1; }

        const cell = document.createElement('div');
        cell.className = 'calendar-day' + (outside ? ' outside' : '');
        cell.textContent = String(cellDay);

        if (cellYear === today.getFullYear() && cellMonth === today.getMonth() && cellDay === today.getDate()) {
            cell.classList.add('today');
        }

        const mark = marks.get(calendarDayKey(cellYear, cellMonth, cellDay));
        if (mark) {
            cell.classList.add('marked');
            if (mark.color) {
                cell.style.backgroundColor = mark.color;
                cell.style.color = readableTextColor(mark.color);
            } else {
                cell.classList.add('marked-default');
            }
            cell.title = mark.texts.slice(0, 5).join('\n');
        }

        grid.appendChild(cell);
    }
}

