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
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
const SQUARENET_SERVER = process.env.SQUARENET_SERVER || 'https://squarenet-server-production.up.railway.app';
const SQUARENET_ADMIN_PASS = process.env.SQUARENET_ADMIN_PASS || 'admin123';

// Payment addresses
const PAYMENT_INFO = {
  usdt_trc20: 'TG1iY6j2BNBdH5gQ7FiN4mfDM4cWtaZbJM',
  usdt_bep20: '0xc2bc21a1e56cf7ff0d8cbde85263b13aab1cbe3b',
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

// ── Auto-verify TRC20 payment ────────────────────────────────
async function verifyTRC20Payment(txHash, expectedAmount) {
  try {
    const infoUrl = `https://api.trongrid.io/v1/transactions/${txHash}/events`;
    const infoR = await fetch(infoUrl, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!infoR.ok) return { ok: false, error: 'TRC20 TX not found' };
    const infoData = await infoR.json();
    const events = infoData.data || [];
    const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    for (const event of events) {
      if (event.event_name === 'Transfer') {
        // TronGrid returns 'to' in base58 (T...) format in event.result
        const toAddr = event.result?.to || '';
        const amount = parseInt(event.result?.value || 0) / 1000000;
        // Verify it's a USDT transfer to our address with correct amount
        const isOurAddr = toAddr === PAYMENT_INFO.usdt_trc20;
        const isUsdt = (event.contract_address === USDT_CONTRACT) || true; // events endpoint already scoped
        if (isOurAddr && Math.abs(amount - expectedAmount) <= 0.005) {
          return { ok: true, amount, network: 'TRC20' };
        }
      }
    }
    return { ok: false, error: `TRC20: Amount/address not matched. Expected $${expectedAmount} to ${PAYMENT_INFO.usdt_trc20}` };
  } catch(e) {
    return { ok: false, error: 'TRC20 verify error: ' + e.message };
  }
}

// ── Auto-verify BEP20 payment ─────────────────────────────────
// BSC public RPC nodes — ordered with eth_getLogs-capable nodes first (free, no API key)
const BSC_RPC_NODES = [
  'https://rpc.ankr.com/bsc',
  'https://bsc.publicnode.com/',
  'https://bsc.drpc.org',
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/'
];

async function bscRpcCall(method, params) {
  for (const rpc of BSC_RPC_NODES) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.result !== undefined) return data.result;
    } catch(e) { continue; } // try next node
  }
  return null;
}

async function verifyBEP20Payment(txHash, expectedAmount) {
  try {
    const USDT_BEP20 = '0x55d398326f99059ff775485246999027b3197955';
    const ourAddr = PAYMENT_INFO.usdt_bep20.toLowerCase();

    const receipt = await bscRpcCall('eth_getTransactionReceipt', [txHash]);
    if (!receipt) return { ok: false, error: 'BEP20 TX not found on-chain' };
    if (receipt.status !== '0x1') return { ok: false, error: 'Transaction failed on-chain' };

    const logs = receipt.logs || [];
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    for (const log of logs) {
      if (log.topics[0] === transferTopic &&
          log.address.toLowerCase() === USDT_BEP20) {
        const toAddr = '0x' + log.topics[2].slice(26).toLowerCase();
        const amount = parseInt(log.data, 16) / 1e18;

        if (toAddr === ourAddr && amount >= expectedAmount * 0.99) {
          return { ok: true, amount, network: 'BEP20' };
        }
      }
    }
    return { ok: false, error: `BEP20: Amount ya address match nahi hua. Expected: $${expectedAmount}` };
  } catch(e) {
    return { ok: false, error: 'BEP20 verify error: ' + e.message };
  }
}

// ── Auto-detect network and verify by TX hash ────────────────
async function verifyPayment(txHash, expectedAmount) {
  if (txHash.startsWith('0x')) {
    return await verifyBEP20Payment(txHash, expectedAmount);
  } else {
    return await verifyTRC20Payment(txHash, expectedAmount);
  }
}

// ── Scan TRC20 recent transactions (no TX hash needed) ────────
async function scanTRC20Recent(expectedAmount) {
  try {
    const ourAddr = PAYMENT_INFO.usdt_trc20;
    const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    // Get last 40 TRC20 USDT transfers to our address (last ~30 min)
    const url = `https://api.trongrid.io/v1/accounts/${ourAddr}/transactions/trc20?limit=40&contract_address=${USDT_CONTRACT}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const data = await r.json();
    const txs = data.data || [];
    const now = Date.now();
    const thirtyMin = 30 * 60 * 1000;

    for (const tx of txs) {
      const ts = tx.block_timestamp || 0;
      if (now - ts > thirtyMin) continue;
      if ((tx.to || '') !== ourAddr) continue;
      const amount = parseInt(tx.value || 0) / 1000000;
      if (Math.abs(amount - expectedAmount) <= 0.005) {
        return { ok: true, amount, txHash: tx.transaction_id, network: 'TRC20' };
      }
    }
    return null;
  } catch(e) { return null; }
}

// ── Scan BEP20 recent transactions (no TX hash needed) ────────
async function scanBEP20Recent(expectedAmount) {
  try {
    const ourAddr = PAYMENT_INFO.usdt_bep20.toLowerCase();
    const USDT_BEP20 = '0x55d398326f99059ff775485246999027b3197955';
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    // pad our address to 32 bytes for topic filter
    const paddedAddr = '0x' + '0'.repeat(24) + ourAddr.slice(2);

    const latestHex = await bscRpcCall('eth_blockNumber', []);
    if (!latestHex) return null;
    const latest = parseInt(latestHex, 16);
    // BSC block time ~3s, 30 min = ~600 blocks; scan last 700 for safety margin
    const fromBlock = '0x' + (latest - 700).toString(16);

    const logs = await bscRpcCall('eth_getLogs', [{
      fromBlock, toBlock: 'latest',
      address: USDT_BEP20,
      topics: [transferTopic, null, paddedAddr]
    }]);
    if (!logs || !Array.isArray(logs)) return null;

    for (const log of logs) {
      const amount = parseInt(log.data, 16) / 1e18;
      if (Math.abs(amount - expectedAmount) <= 0.005) {
        return { ok: true, amount, txHash: log.transactionHash, network: 'BEP20' };
      }
    }
    return null;
  } catch(e) { return null; }
}

// ── Active order polling (check every 2 min) ──────────────────
async function pollPendingOrders() {
  const orders = getOrders();
  const clients = getClients();
  const pending = Object.values(orders).filter(o => 
    o.status === 'pending' && o.autoCheck && 
    (Date.now() - new Date(o.createdAt).getTime()) < 35 * 60 * 1000 // within 35 min
  );
  
  for (const order of pending) {
    // Try TRC20 first, then BEP20
    const network = order.network || 'both';
    let result = null;
    
    const checkAmount = order.uniqueAmount || order.price;
    const net = order.network || 'both';
    if (net === 'trc20' || net === 'both') {
      result = await scanTRC20Recent(checkAmount);
    }
    if (!result && (net === 'bep20' || net === 'both')) {
      result = await scanBEP20Recent(checkAmount);
    }
    
    if (result && result.ok) {
      // Auto-approve!
      const client = clients[order.clientId];
      if (!client) continue;
      
      let apiKey = client.apiKey;
      if (!apiKey) {
        apiKey = 'aa_' + require('uuid').v4().replace(/-/g,'').substring(0, 24);
        await createSquarenetClient(client.name, apiKey, order.tasks);
      } else {
        await updateSquarenetPlan(apiKey, order.tasks);
      }
      
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 30);
      client.apiKey = apiKey;
      client.plan = order.planId;
      client.planTasks = order.tasks;
      client.planExpiry = expiry.toISOString();
      client.active = true;
      clients[order.clientId] = client;
      
      order.status = 'approved';
      order.approvedAt = new Date().toISOString();
      order.autoVerified = true;
      order.txHash = result.txHash;
      order.network = result.network;
      orders[order.id] = order;
      
      console.log(`Auto-verified: ${order.clientName} - $${order.price} via ${result.network}`);
    }
  }
  
  saveClients(clients);
  saveOrders(orders);
}

// Start polling every 20 seconds for fast verification
setInterval(pollPendingOrders, 20 * 1000);

// ── Generate unique payment amount ───────────────────────────
function generateUniqueAmount(basePrice) {
  const orders = getOrders();
  const pending = Object.values(orders).filter(o => o.status === 'pending');
  // Find used cents offsets
  const usedOffsets = new Set(pending.map(o => {
    const diff = Math.round((o.uniqueAmount - o.price) * 100);
    return diff;
  }));
  // Find first unused offset (1-99 cents)
  for (let i = 1; i <= 99; i++) {
    if (!usedOffsets.has(i)) {
      return Math.round((basePrice + i / 100) * 100) / 100;
    }
  }
  return basePrice + 0.01; // fallback
}

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
      body: JSON.stringify({ name, plan, apiKey })
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

// Delete client on squarenet server
async function deleteSquarenetClient(apiKey) {
  try {
    const r = await fetch(SQUARENET_SERVER + '/admin/clients/' + apiKey, {
      method: 'DELETE',
      headers: { 'x-admin-pass': SQUARENET_ADMIN_PASS }
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
  const refCode = req.body.ref || ''; // referral code used during signup

  clients[id] = {
    id, name, email: email.toLowerCase(),
    password: hash,
    apiKey: null, plan: null, planTasks: 0,
    planExpiry: null, active: false,
    referralCode: id.substring(0,8), // unique referral code
    referredBy: refCode || null,      // who referred this user
    walletBalance: 0,                 // referral earnings
    createdAt: new Date().toISOString()
  };
  saveClients(clients);
  res.json({ ok: true, message: 'Account created! Buy a plan to get started.' });
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
    usedToday: client.planTasks ? (client.planTasks - remaining) : 0,
    walletBalance: client.walletBalance || 0,
    referralCode: client.referralCode || client.id.substring(0,8),
    referralLink: `${process.env.PORTAL_URL || 'https://aacaptcha-portal-production.up.railway.app'}?ref=${client.referralCode || client.id.substring(0,8)}`
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

// Regenerate API key (client can reset if shared/compromised)
app.post('/api/regenerate-key', async (req, res) => {
  const token = req.headers['x-token'];
  const clients = getClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  if (!client.apiKey) return res.status(400).json({ error: 'No active API key to regenerate' });
  if (!isPlanValid(client)) return res.status(400).json({ error: 'No active plan' });

  const oldKey = client.apiKey;
  const newKey = 'aa_' + uuidv4().replace(/-/g,'').substring(0, 24);

  // Update on squarenet server: create new key with same plan, delete old
  try {
    await createSquarenetClient(client.name, newKey, client.planTasks);
    await deleteSquarenetClient(oldKey);
  } catch(e) { /* continue even if squarenet sync fails */ }

  client.apiKey = newKey;
  clients[token] = client;
  saveClients(clients);
  res.json({ ok: true, apiKey: newKey });
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
  let price = planId === 'custom' ? (tasks / 1000) : plan.price;

  if (tasks < 3000) return res.status(400).json({ error: 'Minimum 3000 tasks' });

  // Apply wallet balance discount
  const walletUse = Math.min(client.walletBalance || 0, price);
  const finalPrice = Math.max(0, price - walletUse);

  const orders = getOrders();
  const orderId = 'ORD-' + Date.now();

  const network = req.body.network || 'both';
  const uniqueAmount = generateUniqueAmount(price); // unique cents for identification
  orders[orderId] = {
    id: orderId,
    clientId: client.id,
    clientName: client.name,
    clientEmail: client.email,
    planId, tasks, price, uniqueAmount, network,
    txHash: txHash || '',
    screenshot: req.file ? req.file.filename : null,
    status: 'pending',
    autoCheck: true,
    createdAt: new Date().toISOString()
  };
  saveOrders(orders);
  res.json({ 
    ok: true, orderId, 
    uniqueAmount: finalPrice > 0 ? uniqueAmount : 0,
    finalPrice, walletUsed: walletUse,
    message: walletUse > 0 ? `Wallet se $${walletUse.toFixed(2)} use hua!` : 'Order submitted!'
  });
});

// ── Check order status (client polls this) ───────────────────
app.get('/api/check-order/:orderId', (req, res) => {
  const token = req.headers['x-token'];
  const clients = getClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Login karo' });
  const orders = getOrders();
  const order = orders[req.params.orderId];
  if (!order || order.clientId !== client.id) return res.status(404).json({ error: 'Not found' });
  res.json({ 
    approved: order.status === 'approved',
    status: order.status,
    apiKey: order.status === 'approved' ? client.apiKey : null
  });
});

// ── AUTO VERIFY ──────────────────────────────────────────────
app.post('/api/verify-payment', async (req, res) => {
  const token = req.headers['x-token'];
  const clients = getClients();
  const client = clients[token];
  if (!client) return res.status(401).json({ error: 'Login karo' });

  const { orderId, txHash } = req.body;
  const orders = getOrders();
  const order = orders[orderId];
  if (!order) return res.status(404).json({ error: 'Order nahi mila' });
  if (order.clientId !== client.id) return res.status(403).json({ error: 'Access denied' });
  if (order.status === 'approved') return res.json({ ok: true, alreadyApproved: true });

  // Use provided txHash or order's stored txHash
  const hashToVerify = txHash || order.txHash;
  if (!hashToVerify) return res.json({ ok: false, error: 'Transaction hash daalo' });

  // Save txHash to order
  if (txHash) { order.txHash = txHash; orders[orderId] = order; saveOrders(orders); }

  const result = await verifyPayment(hashToVerify, order.uniqueAmount || order.price);
  
  if (result.ok) {
    // Auto-approve!
    let apiKey = client.apiKey;
    if (!apiKey) {
      apiKey = 'aa_' + uuidv4().replace(/-/g,'').substring(0, 24);
      await createSquarenetClient(client.name, apiKey, order.tasks);
    } else {
      await updateSquarenetPlan(apiKey, order.tasks);
    }

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    client.apiKey = apiKey;
    client.plan = order.planId;
    client.planTasks = order.tasks;
    client.planExpiry = expiry.toISOString();
    client.active = true;
    clients[token] = client;
    saveClients(clients);

    order.status = 'approved';
    order.approvedAt = new Date().toISOString();
    order.autoVerified = true;
    orders[orderId] = order;
    saveOrders(orders);

    res.json({ ok: true, apiKey, message: 'Payment verified! Plan activate ho gaya.' });
  } else {
    res.json({ ok: false, error: result.error });
  }
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

  // Referral reward — $0.10 to referrer (only on FIRST purchase)
  if (client.referredBy && !client.referralRewardGiven) {
    const referrer = Object.values(clients).find(c => 
      (c.referralCode || c.id.substring(0,8)) === client.referredBy
    );
    if (referrer) {
      referrer.walletBalance = (referrer.walletBalance || 0) + 0.10;
      clients[referrer.id] = referrer;
      console.log(`Referral reward: $0.10 to ${referrer.name} for referring ${client.name}`);
    }
    client.referralRewardGiven = true; // only once
  }

  clients[order.clientId] = client;
  saveClients(clients);

  order.status = 'approved';
  order.approvedAt = new Date().toISOString();
  orders[req.params.orderId] = order;
  saveOrders(orders);

  res.json({ ok: true, apiKey, message: `Plan activate! Key: ${apiKey}` });
});

// Manual plan activate
app.post('/admin/manual-activate', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { clientId, tasks, days } = req.body;
  if (!clientId || !tasks) return res.status(400).json({ error: 'Missing data' });
  
  const clients = getClients();
  const client = clients[clientId];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  let apiKey = client.apiKey;
  if (!apiKey) {
    apiKey = 'aa_' + uuidv4().replace(/-/g,'').substring(0, 24);
    await createSquarenetClient(client.name, apiKey, tasks);
  } else {
    await updateSquarenetPlan(apiKey, tasks);
  }

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + (days || 30));

  client.apiKey = apiKey;
  client.planTasks = tasks;
  client.planExpiry = expiry.toISOString();
  client.active = true;
  client.suspended = false;
  clients[clientId] = client;
  saveClients(clients);

  res.json({ ok: true, apiKey });
});

// Suspend/unsuspend client
app.post('/admin/suspend-client', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { clientId, suspend } = req.body;
  const clients = getClients();
  if (!clients[clientId]) return res.status(404).json({ error: 'Not found' });
  clients[clientId].suspended = suspend;
  clients[clientId].active = !suspend;
  saveClients(clients);
  // Also update on squarenet server
  if (clients[clientId].apiKey) {
    await updateSquarenetPlan(clients[clientId].apiKey, suspend ? 0 : clients[clientId].planTasks);
  }
  res.json({ ok: true });
});

// Delete client permanently
app.delete('/admin/delete-client/:clientId', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  const client = clients[req.params.clientId];
  if (!client) return res.status(404).json({ error: 'Not found' });
  delete clients[req.params.clientId];
  saveClients(clients);
  // Also delete from usage
  const usage = getUsage();
  delete usage[req.params.clientId];
  saveUsage(usage);
  res.json({ ok: true });
});

// Delete order permanently
app.delete('/admin/order/:orderId', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const orders = getOrders();
  if (!orders[req.params.orderId]) return res.status(404).json({ error: 'Not found' });
  delete orders[req.params.orderId];
  saveOrders(orders);
  res.json({ ok: true });
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
