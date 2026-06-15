// AACaptcha Solver Portal — server.js v1.0
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(express.static('public/public')); // fallback for double-public

// ── Data Storage ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 5 * 1024 * 1024 } });

function readJSON(file, def={}) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return def;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ── Config ───────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SQUARENET_SERVER = process.env.SQUARENET_SERVER || 'https://squarenet-server-production.up.railway.app';
const SQUARENET_ADMIN_PASS = process.env.SQUARENET_ADMIN_PASS || 'admin123';

// Payment addresses
const PAYMENT_INFO = {
  usdt_trc20: 'TSyXMwMLUGBxCPNBurRaogZzpXziAtcNh3',
  usdt_bep20: '0xc8bf99776ca9fb0c5665ffb4a0206c0de1d4d328',
  telegram: 't.me/AACaptchaSolver',
  telegram_group: 't.me/AACaptchaSolverGroup'
};

// Plans
const PLANS = [
  { id: 'p1',  tasks: 3000,  price: 3  },
  { id: 'p2',  tasks: 5000,  price: 5  },
  { id: 'p3',  tasks: 7000,  price: 7  },
  { id: 'p4',  tasks: 10000, price: 10 },
  { id: 'p5',  tasks: 15000, price: 15 },
  { id: 'p6',  tasks: 20000, price: 20 },
  { id: 'p7',  tasks: 25000, price: 25 },
  { id: 'p8',  tasks: 30000, price: 30 },
  { id: 'p9',  tasks: 40000, price: 40 },
  { id: 'p10', tasks: 50000, price: 50 },
  { id: 'p11', tasks: 75000, price: 75 },
  { id: 'p12', tasks: 100000,price: 100},
  { id: 'custom', tasks: 0,  price: 0  }
];

// ── Helpers ──────────────────────────────────────────────────
function isAdmin(req) { return req.headers['x-admin-pass'] === ADMIN_PASS; }

function getClients() { return readJSON('clients.json', {}); }
function saveClients(d) { writeJSON('clients.json', d); }
function getOrders() { return readJSON('orders.json', {}); }
function saveOrders(d) { writeJSON('orders.json', d); }
function getUsage() { return readJSON('usage.json', {}); }
function saveUsage(d) { writeJSON('usage.json', d); }

function getTodayKey() { return new Date().toISOString().slice(0, 10); }

// Check if plan is still valid (30 days from purchase)
function isPlanValid(client) {
  if (!client.planExpiry) return false;
  return new Date(client.planExpiry) > new Date();
}

// Get remaining tasks today
function getRemainingToday(clientId, dailyLimit) {
  const usage = getUsage();
  const today = getTodayKey();
  const used = (usage[clientId] || {})[today] || 0;
  return Math.max(0, dailyLimit - used);
}

// Create client on squarenet server
async function createSquarenetClient(name, apiKey, plan) {
  try {
    const r = await fetch(SQUARENET_SERVER + '/admin/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-pass': SQUARENET_ADMIN_PASS },
      body: JSON.stringify({ name, plan })
    });
    return r.json();
  } catch(e) { return null; }
}

// Update plan on squarenet server
async function updateSquarenetPlan(apiKey, plan) {
  try {
    const r = await fetch(SQUARENET_SERVER + '/admin/clients/' + apiKey, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-pass': SQUARENET_ADMIN_PASS },
      body: JSON.stringify({ plan })
    });
    return r.json();
  } catch(e) { return null; }
}

// ── AUTH ─────────────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Sab fields fill karo' });
  if (password.length < 6) return res.status(400).json({ error: 'Password kam az kam 6 characters' });

  const clients = getClients();
  const exists = Object.values(clients).find(c => c.email === email.toLowerCase());
  if (exists) return res.status(400).json({ error: 'Email already registered hai' });

  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);

  clients[id] = {
    id, name, email: email.toLowerCase(),
    password: hash,
    apiKey: null, plan: null, planTasks: 0,
    planExpiry: null, active: false,
    createdAt: new Date().toISOString()
  };
  saveClients(clients);
  res.json({ ok: true, message: 'Account ban gaya! Ab plan kharido.' });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const clients = getClients();
  const client = Object.values(clients).find(c => c.email === email?.toLowerCase());
  if (!client) return res.status(401).json({ error: 'Email ya password galat hai' });

  const ok = await bcrypt.compare(password, client.password);
  if (!ok) return res.status(401).json({ error: 'Email ya password galat hai' });

  // Return client token (simple: use client id as token)
  res.json({
    ok: true,
    token: client.id,
    name: client.name,
    email: client.email,
    hasActivePlan: isPlanValid(client),
    apiKey: client.apiKey,
    plan: client.plan,
    planTasks: client.planTasks,
    planExpiry: client.planExpiry
  });
});

// Get profile
app.get('/api/profile', (req, res) => {
  const token = req.headers['x-token'];
  const clients = getClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });

  const remaining = client.planTasks ? getRemainingToday(client.id, client.planTasks) : 0;
  const valid = isPlanValid(client);

  res.json({
    name: client.name, email: client.email,
    hasActivePlan: valid,
    apiKey: valid ? client.apiKey : null,
    plan: client.plan, planTasks: client.planTasks,
    planExpiry: client.planExpiry,
    remainingToday: remaining,
    usedToday: client.planTasks ? (client.planTasks - remaining) : 0
  });
});

// Change password
app.post('/api/change-password', async (req, res) => {
  const token = req.headers['x-token'];
  const { oldPassword, newPassword } = req.body;
  const clients = getClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  const ok = await bcrypt.compare(oldPassword, client.password);
  if (!ok) return res.status(400).json({ error: 'Purana password galat hai' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password kam az kam 6 characters' });
  client.password = await bcrypt.hash(newPassword, 10);
  clients[token] = client;
  saveClients(clients);
  res.json({ ok: true });
});

// ── ORDERS ───────────────────────────────────────────────────

// Get plans
app.get('/api/plans', (req, res) => {
  res.json({ plans: PLANS, payment: PAYMENT_INFO });
});

// Create order (after payment)
app.post('/api/order', upload.single('screenshot'), (req, res) => {
  const token = req.headers['x-token'];
  const clients = getClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Login karo pehle' });

  const { planId, customTasks, txHash } = req.body;
  const plan = PLANS.find(p => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'Plan nahi mila' });

  const tasks = planId === 'custom' ? parseInt(customTasks) : plan.tasks;
  const price = planId === 'custom' ? (tasks / 1000) : plan.price;

  if (tasks < 3000) return res.status(400).json({ error: 'Minimum 3000 tasks' });

  const orders = getOrders();
  const orderId = 'ORD-' + Date.now();

  orders[orderId] = {
    id: orderId,
    clientId: client.id,
    clientName: client.name,
    clientEmail: client.email,
    planId, tasks, price,
    txHash: txHash || '',
    screenshot: req.file ? req.file.filename : null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  saveOrders(orders);
  res.json({ ok: true, orderId, message: 'Order submit ho gaya! Admin verify karega.' });
});

// ── ADMIN ────────────────────────────────────────────────────

app.post('/admin/login', (req, res) => {
  res.json({ ok: req.body.password === ADMIN_PASS });
});

app.get('/admin/orders', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const orders = getOrders();
  const list = Object.values(orders).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: list });
});

app.get('/admin/clients-list', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  const usage = getUsage();
  const today = getTodayKey();
  const list = Object.values(clients).map(c => ({
    id: c.id, name: c.name, email: c.email,
    apiKey: c.apiKey, plan: c.plan, planTasks: c.planTasks,
    planExpiry: c.planExpiry, active: c.active,
    usedToday: (usage[c.id] || {})[today] || 0,
    createdAt: c.createdAt
  }));
  res.json({ clients: list });
});

app.get('/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  const orders = getOrders();
  const usage = getUsage();
  const today = getTodayKey();
  let totalToday = 0;
  for (const uid of Object.keys(usage)) totalToday += (usage[uid][today] || 0);
  const pendingOrders = Object.values(orders).filter(o => o.status === 'pending').length;
  const activeClients = Object.values(clients).filter(c => isPlanValid(c)).length;
  res.json({
    totalClients: Object.keys(clients).length,
    activeClients, pendingOrders,
    totalOrders: Object.keys(orders).length,
    tasksToday: totalToday
  });
});

// Approve order → activate client plan
app.post('/admin/approve/:orderId', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const orders = getOrders();
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Order nahi mila' });
  if (order.status === 'approved') return res.json({ ok: true, message: 'Already approved' });

  const clients = getClients();
  const client = clients[order.clientId];
  if (!client) return res.status(404).json({ error: 'Client nahi mila' });

  // Create API key if not exists
  let apiKey = client.apiKey;
  if (!apiKey) {
    apiKey = 'aa_' + uuidv4().replace(/-/g,'').substring(0, 24);
    // Create on squarenet server
    await createSquarenetClient(client.name, apiKey, order.tasks);
  } else {
    // Update plan on squarenet server
    await updateSquarenetPlan(apiKey, order.tasks);
  }

  // Set plan expiry: 30 days from now
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 30);

  client.apiKey = apiKey;
  client.plan = order.planId;
  client.planTasks = order.tasks;
  client.planExpiry = expiry.toISOString();
  client.active = true;
  clients[order.clientId] = client;
  saveClients(clients);

  order.status = 'approved';
  order.approvedAt = new Date().toISOString();
  orders[req.params.orderId] = order;
  saveOrders(orders);

  res.json({ ok: true, apiKey, message: `Plan activate! Key: ${apiKey}` });
});

// Reject order
app.post('/admin/reject/:orderId', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const orders = getOrders();
  if (!orders[req.params.orderId]) return res.status(404).json({ error: 'Not found' });
  orders[req.params.orderId].status = 'rejected';
  orders[req.params.orderId].rejectedAt = new Date().toISOString();
  saveOrders(orders);
  res.json({ ok: true });
});

// Serve screenshot
app.get('/admin/screenshot/:filename', (req, res) => {
  if (!isAdmin(req)) return res.status(401).end();
  const fp = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`AACaptcha Portal v1.0 on port ${PORT}`));
