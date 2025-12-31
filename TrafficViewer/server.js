const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const SAVES_DIR = path.join(__dirname, 'saves');

// Ensure saves directory exists
if (!fs.existsSync(SAVES_DIR)) {
    fs.mkdirSync(SAVES_DIR);
}
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// In-memory storage for captured transactions
let transactions = [];
let transactionId = 0;

// Command queue for CDP commands
let pendingCommands = [];
let commandId = 0;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// API Endpoints (before static files to avoid conflicts)

// Receive captured transaction from client
app.post('/api/capture', (req, res) => {
    const transaction = {
        id: ++transactionId,
        timestamp: new Date().toISOString(),
        ...req.body
    };

    transactions.push(transaction);

    // Emit to all connected dashboard clients
    io.emit('newTransaction', transaction);

    console.log(`[${transaction.timestamp}] ${transaction.request?.method || 'UNKNOWN'} ${transaction.request?.url || 'N/A'}`);

    res.status(200).json({ success: true, id: transaction.id });
});

// Get all transactions
app.get('/api/transactions', (req, res) => {
    res.json(transactions);
});

// Get specific transaction by ID
app.get('/api/transactions/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const transaction = transactions.find(t => t.id === id);

    if (transaction) {
        res.json(transaction);
    } else {
        res.status(404).json({ error: 'Transaction not found' });
    }
});

// Clear all transactions
app.delete('/api/transactions', (req, res) => {
    transactions = [];
    transactionId = 0;
    io.emit('transactionsCleared');
    res.json({ success: true, message: 'All transactions cleared' });
});

// Save transactions to file
app.post('/api/save', (req, res) => {
    const { filename } = req.body;
    const safeName = (filename || `capture_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(SAVES_DIR, `${safeName}.json`);

    try {
        fs.writeFileSync(filePath, JSON.stringify(transactions, null, 2));
        res.json({ success: true, filename: `${safeName}.json`, count: transactions.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List saved files
app.get('/api/saves', (req, res) => {
    try {
        // Ensure directory exists
        if (!fs.existsSync(SAVES_DIR)) {
            fs.mkdirSync(SAVES_DIR, { recursive: true });
        }

        const files = fs.readdirSync(SAVES_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const stat = fs.statSync(path.join(SAVES_DIR, f));
                    return { name: f, size: stat.size, modified: stat.mtime };
                } catch {
                    return null;
                }
            })
            .filter(f => f !== null)
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));

        res.setHeader('Content-Type', 'application/json');
        res.json(files);
    } catch (err) {
        console.error('Error listing saves:', err);
        res.status(500).json({ error: err.message });
    }
});

// Load transactions from file
app.post('/api/load', (req, res) => {
    const { filename } = req.body;
    const filePath = path.join(SAVES_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        transactions = data;
        transactionId = Math.max(0, ...transactions.map(t => t.id || 0));
        io.emit('transactionsLoaded', transactions);
        res.json({ success: true, count: transactions.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete saved file
app.delete('/api/saves/:filename', (req, res) => {
    const filePath = path.join(SAVES_DIR, req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get pending commands for capturer to poll
app.get('/api/commands', (req, res) => {
    if (pendingCommands.length > 0) {
        const command = pendingCommands.shift();
        res.json(command);
    } else {
        res.json(null);
    }
});

// Receive command result from capturer
app.post('/api/command-result', (req, res) => {
    const { id, type, result, error } = req.body;
    console.log(`[CMD] Result for ${type} (id: ${id})`);

    if (error) {
        io.emit('commandError', error);
    } else if (type === 'getCookies') {
        io.emit('cookiesResult', result);
    } else if (type === 'executeJs') {
        io.emit('executeJsResult', result);
    } else if (type === 'getTargets') {
        io.emit('targetsResult', result);
    }

    res.json({ success: true });
});

// Static files (after API routes)
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Dashboard client connected:', socket.id);

    // Send existing transactions to newly connected client
    socket.emit('existingTransactions', transactions);

    socket.on('disconnect', () => {
        console.log('Dashboard client disconnected:', socket.id);
    });

    // Handle getCookies command
    socket.on('getCookies', () => {
        const cmd = { id: ++commandId, type: 'getCookies' };
        pendingCommands.push(cmd);
        console.log(`[CMD] Queued getCookies (id: ${cmd.id})`);
    });

    // Handle getTargets command
    socket.on('getTargets', () => {
        const cmd = { id: ++commandId, type: 'getTargets' };
        pendingCommands.push(cmd);
        console.log(`[CMD] Queued getTargets (id: ${cmd.id})`);
    });

    // Handle executeJs command
    socket.on('executeJs', (data) => {
        const cmd = { id: ++commandId, type: 'executeJs', code: data.code, targetId: data.targetId };
        pendingCommands.push(cmd);
        console.log(`[CMD] Queued executeJs (id: ${cmd.id}, target: ${data.targetId})`);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Traffic Viewer server running on http://localhost:${PORT}`);
    console.log(`Dashboard available at http://localhost:${PORT}`);
    console.log(`API endpoint: POST http://localhost:${PORT}/api/capture`);
});
