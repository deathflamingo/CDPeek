// Traffic Viewer Dashboard - Client-side JavaScript

// Global state
let transactions = [];
let selectedTransactionId = null;

// DOM Elements
const requestTableBody = document.getElementById('requestTableBody');
const requestContent = document.getElementById('requestContent');
const responseContent = document.getElementById('responseContent');
const renderFrame = document.getElementById('renderFrame');
const connectionStatus = document.getElementById('connectionStatus');
const transactionCount = document.getElementById('transactionCount');
const clearAllBtn = document.getElementById('clearAllBtn');
const saveBtn = document.getElementById('saveBtn');
const loadBtn = document.getElementById('loadBtn');
const getCookiesBtn = document.getElementById('getCookiesBtn');
const executeJsBtn = document.getElementById('executeJsBtn');
const tabButtons = document.querySelectorAll('.tab-btn');
const paneResizer = document.getElementById('paneResizer');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');

// Socket.io connection
const socket = io();

socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.classList.remove('disconnected');
    connectionStatus.classList.add('connected');
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.classList.remove('connected');
    connectionStatus.classList.add('disconnected');
});

socket.on('existingTransactions', (existingTransactions) => {
    transactions = existingTransactions;
    renderTable();
    updateTransactionCount();
});

socket.on('newTransaction', (transaction) => {
    transactions.push(transaction);
    appendTableRow(transaction);
    updateTransactionCount();
});

socket.on('transactionsCleared', () => {
    transactions = [];
    selectedTransactionId = null;
    requestTableBody.innerHTML = '';
    updateTransactionCount();
    clearDetailPanes();
});

socket.on('transactionsLoaded', (loadedTransactions) => {
    transactions = loadedTransactions;
    selectedTransactionId = null;
    renderTable();
    updateTransactionCount();
    clearDetailPanes();
});

socket.on('cookiesResult', (result) => {
    showResultModal('Cookies', result);
});

socket.on('executeJsResult', (result) => {
    showResultModal('Execute JS Result', result);
});

socket.on('commandError', (error) => {
    alert('Command Error: ' + error);
});

socket.on('targetsResult', (targets) => {
    updateTargetSelector(targets);
});

// Event Listeners
clearAllBtn.addEventListener('click', async () => {
    if (confirm('Clear all captured transactions?')) {
        await fetch('/api/transactions', { method: 'DELETE' });
    }
});

saveBtn.addEventListener('click', showSaveModal);
loadBtn.addEventListener('click', showLoadModal);
getCookiesBtn.addEventListener('click', () => socket.emit('getCookies'));
executeJsBtn.addEventListener('click', showExecuteJsModal);
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Modal functions
function closeModal() {
    modal.classList.add('hidden');
}

function showSaveModal() {
    modalTitle.textContent = 'Save Capture';
    const defaultName = `capture_${new Date().toISOString().slice(0,10)}`;
    modalBody.innerHTML = `
        <input type="text" class="modal-input" id="saveFilename" placeholder="Filename" value="${defaultName}">
        <div class="modal-actions">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="saveCapture()">Save</button>
        </div>
    `;
    modal.classList.remove('hidden');
    document.getElementById('saveFilename').focus();
    document.getElementById('saveFilename').select();
}

async function saveCapture() {
    const filename = document.getElementById('saveFilename').value.trim();
    if (!filename) return;

    try {
        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const data = await res.json();
        if (data.success) {
            closeModal();
            alert(`Saved ${data.count} transactions to ${data.filename}`);
        } else {
            alert('Error: ' + data.error);
        }
    } catch (err) {
        alert('Error saving: ' + err.message);
    }
}

async function showLoadModal() {
    modalTitle.textContent = 'Load Capture';
    modalBody.innerHTML = '<div class="empty-saves">Loading...</div>';
    modal.classList.remove('hidden');

    try {
        const res = await fetch('/api/saves');
        const files = await res.json();

        if (files.length === 0) {
            modalBody.innerHTML = '<div class="empty-saves">No saved captures found</div>';
            return;
        }

        modalBody.innerHTML = `
            <div class="saves-list" id="savesList">
                ${files.map(f => `
                    <div class="save-item" data-filename="${escapeHtml(f.name)}">
                        <div class="save-item-info">
                            <div class="save-item-name">${escapeHtml(f.name)}</div>
                            <div class="save-item-meta">${formatBytes(f.size)} - ${new Date(f.modified).toLocaleString()}</div>
                        </div>
                        <button class="save-item-delete" onclick="deleteSave('${escapeHtml(f.name)}', event)">Delete</button>
                    </div>
                `).join('')}
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-primary" id="loadSelectedBtn" disabled>Load Selected</button>
            </div>
        `;

        let selectedFile = null;
        document.querySelectorAll('.save-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('save-item-delete')) return;
                document.querySelectorAll('.save-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                selectedFile = item.dataset.filename;
                document.getElementById('loadSelectedBtn').disabled = false;
            });
            item.addEventListener('dblclick', () => {
                loadCapture(item.dataset.filename);
            });
        });

        document.getElementById('loadSelectedBtn').addEventListener('click', () => {
            if (selectedFile) loadCapture(selectedFile);
        });
    } catch (err) {
        modalBody.innerHTML = `<div class="empty-saves">Error loading saves: ${err.message}</div>`;
    }
}

async function loadCapture(filename) {
    try {
        const res = await fetch('/api/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const data = await res.json();
        if (data.success) {
            closeModal();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (err) {
        alert('Error loading: ' + err.message);
    }
}

async function deleteSave(filename, event) {
    event.stopPropagation();
    if (!confirm(`Delete ${filename}?`)) return;

    try {
        await fetch(`/api/saves/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        showLoadModal(); // Refresh list
    } catch (err) {
        alert('Error deleting: ' + err.message);
    }
}

function showExecuteJsModal() {
    modalTitle.textContent = 'Execute JavaScript';
    modalBody.innerHTML = `
        <div class="modal-field">
            <label class="modal-label">Target Page:</label>
            <select class="modal-input" id="targetSelector">
                <option value="">Loading pages...</option>
            </select>
        </div>
        <div class="modal-field">
            <label class="modal-label">JavaScript Code:</label>
            <textarea class="modal-input modal-textarea" id="jsCode" placeholder="Enter JavaScript code to execute..." rows="6">alert('Hello from CDP!')</textarea>
        </div>
        <div class="modal-actions">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="executeJs()">Execute</button>
        </div>
    `;
    modal.classList.remove('hidden');
    // Request available targets
    socket.emit('getTargets');
}

function updateTargetSelector(targets) {
    const selector = document.getElementById('targetSelector');
    if (!selector) return;

    if (!targets || targets.length === 0) {
        selector.innerHTML = '<option value="">No pages available</option>';
        return;
    }

    selector.innerHTML = targets.map(t => {
        const shortUrl = t.url.length > 60 ? t.url.substring(0, 60) + '...' : t.url;
        return `<option value="${escapeHtml(t.id)}" title="${escapeHtml(t.url)}">${escapeHtml(shortUrl)}</option>`;
    }).join('');
}

function executeJs() {
    const code = document.getElementById('jsCode').value.trim();
    const targetId = document.getElementById('targetSelector').value;
    if (!code) return;
    if (!targetId) {
        alert('Please select a target page');
        return;
    }
    socket.emit('executeJs', { code, targetId });
    closeModal();
}

function showResultModal(title, result) {
    modalTitle.textContent = title;
    let content;
    if (typeof result === 'object') {
        content = JSON.stringify(result, null, 2);
    } else {
        content = String(result);
    }
    modalBody.innerHTML = `
        <pre class="modal-result">${escapeHtml(content)}</pre>
        <div class="modal-actions">
            <button class="btn btn-primary" onclick="closeModal()">Close</button>
        </div>
    `;
    modal.classList.remove('hidden');
}

// Column resizing
initColumnResizers();

function initColumnResizers() {
    const resizers = document.querySelectorAll('.col-resizer');
    resizers.forEach(resizer => {
        resizer.addEventListener('mousedown', initColumnResize);
    });
}

let currentResizer = null;
let currentTh = null;
let startX = 0;
let startWidth = 0;

function initColumnResize(e) {
    e.preventDefault();
    e.stopPropagation();

    currentResizer = e.target;
    currentTh = currentResizer.parentElement;
    startX = e.pageX;
    startWidth = currentTh.offsetWidth;

    currentResizer.classList.add('active');
    document.addEventListener('mousemove', handleColumnResize);
    document.addEventListener('mouseup', stopColumnResize);
}

function handleColumnResize(e) {
    if (!currentTh) return;
    const diff = e.pageX - startX;
    const newWidth = Math.max(30, startWidth + diff);
    currentTh.style.width = newWidth + 'px';
}

function stopColumnResize() {
    if (currentResizer) {
        currentResizer.classList.remove('active');
    }
    currentResizer = null;
    currentTh = null;
    document.removeEventListener('mousemove', handleColumnResize);
    document.removeEventListener('mouseup', stopColumnResize);
}

// Pane resizer functionality
let isResizing = false;
paneResizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    paneResizer.classList.add('active');
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
});

function handleResize(e) {
    if (!isResizing) return;
    const container = document.querySelector('.detail-container');
    const containerRect = container.getBoundingClientRect();
    const percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;
    const requestPane = document.querySelector('.request-pane');
    const responsePane = document.querySelector('.response-pane');

    if (percentage > 20 && percentage < 80) {
        requestPane.style.flex = `0 0 ${percentage}%`;
        responsePane.style.flex = `0 0 ${100 - percentage}%`;
    }
}

function stopResize() {
    isResizing = false;
    paneResizer.classList.remove('active');
    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', stopResize);
}

// Functions
function renderTable() {
    requestTableBody.innerHTML = '';
    transactions.forEach(t => appendTableRow(t));
}

function appendTableRow(t) {
    const row = document.createElement('tr');
    row.dataset.id = t.id;
    if (t.id === selectedTransactionId) row.classList.add('selected');

    const url = t.request?.url || '';
    const method = t.request?.method || '?';
    const status = t.response?.statusCode || '-';
    const urlObj = parseUrl(url);
    const length = t.response?.body?.length || 0;
    const mime = getMimeShort(t.response?.mimeType);
    const time = new Date(t.timestamp).toLocaleTimeString();

    row.innerHTML = `
        <td>${t.id}</td>
        <td title="${escapeHtml(urlObj.host)}">${escapeHtml(urlObj.host)}</td>
        <td class="method-${method}">${method}</td>
        <td title="${escapeHtml(url)}">${escapeHtml(urlObj.pathname + urlObj.search)}</td>
        <td class="${getStatusClass(status)}">${status}</td>
        <td style="text-align:right">${formatBytes(length)}</td>
        <td>${escapeHtml(mime)}</td>
        <td>${time}</td>
    `;

    row.addEventListener('click', () => selectTransaction(t.id));
    requestTableBody.appendChild(row);

    // Auto-scroll to bottom for new entries
    requestTableBody.parentElement.scrollTop = requestTableBody.parentElement.scrollHeight;
}

function selectTransaction(id) {
    selectedTransactionId = id;
    const transaction = transactions.find(t => t.id === id);
    if (!transaction) return;

    // Update table selection
    requestTableBody.querySelectorAll('tr').forEach(row => {
        row.classList.toggle('selected', row.dataset.id == id);
    });

    renderRequestDetails(transaction);
    renderResponseDetails(transaction);
}

function renderRequestDetails(transaction) {
    const req = transaction.request;
    if (!req) {
        requestContent.textContent = 'No request data';
        return;
    }

    const urlObj = parseUrl(req.url);
    let content = `${req.method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\n`;
    content += `Host: ${urlObj.host}\n`;

    if (req.headers) {
        for (const [name, value] of Object.entries(req.headers)) {
            if (name.toLowerCase() !== 'host') {
                content += `${name}: ${value}\n`;
            }
        }
    }

    if (req.body) {
        content += `\n${formatBody(req.body)}`;
    }

    requestContent.textContent = content;
}

function renderResponseDetails(transaction) {
    const res = transaction.response;
    if (!res) {
        responseContent.textContent = 'No response data';
        renderFrame.srcdoc = '<html><body style="background:#1e1e1e;color:#808080;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif">No response</body></html>';
        return;
    }

    let content = `HTTP/1.1 ${res.statusCode} ${getStatusText(res.statusCode)}\n`;

    if (res.headers) {
        for (const [name, value] of Object.entries(res.headers)) {
            content += `${name}: ${value}\n`;
        }
    }

    if (res.body) {
        content += `\n${formatBody(res.body)}`;
    }

    responseContent.textContent = content;

    // Update render frame with CSS injection
    if (res.body && isHtmlContent(res.mimeType, res.body)) {
        const htmlWithCss = injectCapturedCss(res.body, transaction.request?.url);
        renderFrame.srcdoc = htmlWithCss;
    } else if (res.body) {
        const escaped = escapeHtml(formatBody(res.body));
        renderFrame.srcdoc = `<html><head><style>body{background:#1e1e1e;color:#d4d4d4;font-family:Consolas,monospace;font-size:11px;padding:10px;margin:0;white-space:pre-wrap;word-wrap:break-word}</style></head><body>${escaped}</body></html>`;
    } else {
        renderFrame.srcdoc = '<html><body style="background:#1e1e1e;color:#808080;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif">No body</body></html>';
    }
}

// Inject captured CSS into HTML for rendering
function injectCapturedCss(html, baseUrl) {
    // Collect all captured CSS
    const cssMap = new Map();
    transactions.forEach(t => {
        const mime = t.response?.mimeType || '';
        const url = t.request?.url || '';
        if (mime.includes('text/css') || url.endsWith('.css')) {
            if (t.response?.body) {
                cssMap.set(url, t.response.body);
            }
        }
    });

    if (cssMap.size === 0) {
        return html;
    }

    // Parse base URL for resolving relative paths
    let baseUrlObj;
    try {
        baseUrlObj = new URL(baseUrl);
    } catch {
        return html;
    }

    // Build inline CSS from captured stylesheets
    let inlineCss = '';

    // Find all <link rel="stylesheet"> in the HTML and replace with inline styles
    const linkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
    const linkRegex2 = /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi;

    let modifiedHtml = html;

    // Function to resolve URL and get CSS
    function resolveCssUrl(href) {
        let fullUrl;
        try {
            if (href.startsWith('//')) {
                fullUrl = baseUrlObj.protocol + href;
            } else if (href.startsWith('/')) {
                fullUrl = baseUrlObj.origin + href;
            } else if (href.startsWith('http')) {
                fullUrl = href;
            } else {
                fullUrl = new URL(href, baseUrl).href;
            }
        } catch {
            return null;
        }

        // Look for matching CSS in our captured transactions
        for (const [cssUrl, cssBody] of cssMap) {
            if (cssUrl === fullUrl || cssUrl.endsWith(href) || href.endsWith(new URL(cssUrl).pathname)) {
                return cssBody;
            }
        }
        return null;
    }

    // Replace link tags with inline style tags
    modifiedHtml = modifiedHtml.replace(linkRegex, (match, href) => {
        const css = resolveCssUrl(href);
        if (css) {
            return `<style>/* Injected from: ${escapeHtml(href)} */\n${css}</style>`;
        }
        return match; // Keep original if not found
    });

    modifiedHtml = modifiedHtml.replace(linkRegex2, (match, href) => {
        const css = resolveCssUrl(href);
        if (css) {
            return `<style>/* Injected from: ${escapeHtml(href)} */\n${css}</style>`;
        }
        return match;
    });

    // Also inject any remaining CSS that wasn't linked (in case of dynamic loading)
    // Add them at the end of <head>
    if (cssMap.size > 0) {
        const additionalCss = Array.from(cssMap.entries())
            .map(([url, body]) => `<style>/* ${escapeHtml(url)} */\n${body}</style>`)
            .join('\n');

        if (modifiedHtml.includes('</head>')) {
            modifiedHtml = modifiedHtml.replace('</head>', `${additionalCss}\n</head>`);
        } else if (modifiedHtml.includes('<body')) {
            modifiedHtml = modifiedHtml.replace('<body', `<head>${additionalCss}</head><body`);
        }
    }

    return modifiedHtml;
}

function clearDetailPanes() {
    requestContent.textContent = 'Select a request to view details';
    responseContent.textContent = 'Select a request to view details';
    renderFrame.srcdoc = '';
}

function switchTab(tab) {
    tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    document.getElementById('rawTab').classList.toggle('active', tab === 'raw');
    document.getElementById('renderTab').classList.toggle('active', tab === 'render');
}

function updateTransactionCount() {
    transactionCount.textContent = `${transactions.length} request${transactions.length !== 1 ? 's' : ''}`;
}

// Utility functions
function getStatusClass(status) {
    if (status === '-') return '';
    const code = parseInt(status);
    if (code >= 200 && code < 300) return 'status-2xx';
    if (code >= 300 && code < 400) return 'status-3xx';
    if (code >= 400 && code < 500) return 'status-4xx';
    if (code >= 500) return 'status-5xx';
    return '';
}

function getStatusText(code) {
    const texts = {200:'OK',201:'Created',204:'No Content',301:'Moved Permanently',302:'Found',304:'Not Modified',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',500:'Internal Server Error',502:'Bad Gateway',503:'Service Unavailable'};
    return texts[code] || '';
}

function parseUrl(url) {
    try { return new URL(url); }
    catch { return { pathname: url, search: '', host: 'unknown' }; }
}

function formatBody(body) {
    if (!body) return '';
    try { return JSON.stringify(JSON.parse(body), null, 2); }
    catch { return body; }
}

function formatBytes(bytes) {
    if (bytes === 0) return '-';
    if (bytes < 1024) return bytes + '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
    return (bytes / (1024 * 1024)).toFixed(1) + 'M';
}

function getMimeShort(mime) {
    if (!mime) return '';
    const parts = mime.split(';')[0].split('/');
    return parts.length > 1 ? parts[1] : mime;
}

function isHtmlContent(mimeType, body) {
    if (mimeType?.includes('text/html')) return true;
    if (body?.trim().toLowerCase().startsWith('<!doctype html')) return true;
    if (body?.trim().toLowerCase().startsWith('<html')) return true;
    return false;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
