require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { db, runAsync, allAsync, getAsync, DB_PATH } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

app.use(cors());
app.use(express.json());

// simple rate limiter
app.use(rateLimit({ windowMs: 1000 * 60, max: 120 }));

// create DB tables if missing
const initSql = fs.readFileSync(path.join(__dirname, 'init-db.sql'), 'utf8');
db.exec(initSql, async (err) => {
    if (err) {
        console.error('DB init failed', err);
        process.exit(1);
    } else {
        console.log('DB initialized');
        // create admin if not exists
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@caprio.com';
        const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
        const user = await getAsync('SELECT id FROM users WHERE email = ?', [adminEmail]);
        if (!user) {
            const hash = await bcrypt.hash(adminPassword, 10);
            await runAsync('INSERT INTO users (name, email, password, is_admin) VALUES (?,?,?,1)', ['Admin', adminEmail, hash]);
            console.log(`Admin user created: ${adminEmail}`);
        }
    }
});

// helper middleware
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized' });
    const token = auth.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (e) {
        return res.status(401).json({ message: 'Invalid token' });
    }
}

function adminMiddleware(req, res, next) {
    if (!req.user || !req.user.is_admin) return res.status(403).json({ message: 'Admin only' });
    next();
}

// --- Auth routes ---
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    try {
        const exists = await getAsync('SELECT id FROM users WHERE email = ?', [email]);
        if (exists) return res.status(400).json({ message: 'Email already registered' });
        const hash = await bcrypt.hash(password, 10);
        const result = await runAsync('INSERT INTO users (name, email, password) VALUES (?,?,?)', [name || '', email, hash]);
        const userId = result.lastID;
        const token = jwt.sign({ id: userId, email, is_admin: 0 }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await getAsync('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) return res.status(400).json({ message: 'Invalid email/password' });
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return res.status(400).json({ message: 'Invalid email/password' });
        const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/me', authMiddleware, async (req, res) => {
    const user = await getAsync('SELECT id, name, email, is_admin, created_at FROM users WHERE id = ?', [req.user.id]);
    res.json({ user });
});

// --- Products ---
app.get('/api/products', async (req, res) => {
    // basic filters via query string
    const { category, age_group, q, sort } = req.query;
    let sql = 'SELECT * FROM products';
    const conditions = [];
    const params = [];
    if (category) { conditions.push('category = ?'); params.push(category); }
    if (age_group) { conditions.push('age_group = ?'); params.push(age_group); }
    if (q) { conditions.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    if (sort === 'price_asc') sql += ' ORDER BY price ASC';
    else if (sort === 'price_desc') sql += ' ORDER BY price DESC';
    else if (sort === 'newest') sql += ' ORDER BY created_at DESC';
    else sql += ' ORDER BY id DESC';
    try {
        const rows = await allAsync(sql, params);
        // parse JSON fields
        const parsed = rows.map(r => ({
            ...r,
            images: r.images ? JSON.parse(r.images) : [],
            colors: r.colors ? JSON.parse(r.colors) : []
        }));
        res.json(parsed);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    const id = req.params.id;
    const row = await getAsync('SELECT * FROM products WHERE id = ? OR slug = ?', [id, id]);
    if (!row) return res.status(404).json({ message: 'Not found' });
    row.images = row.images ? JSON.parse(row.images) : [];
    row.colors = row.colors ? JSON.parse(row.colors) : [];
    res.json(row);
});

// Admin product CRUD
app.post('/api/admin/products', authMiddleware, adminMiddleware, async (req, res) => {
    const { name, slug, description, price, colors, images, category, age_group } = req.body;
    try {
        const stmt = 'INSERT INTO products (name, slug, description, price, colors, images, category, age_group) VALUES (?,?,?,?,?,?,?,?)';
        const result = await runAsync(stmt, [name, slug, description, price, JSON.stringify(colors || []), JSON.stringify(images || []), category || '', age_group || '']);
        res.json({ id: result.lastID });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/admin/products/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const id = req.params.id;
    const { name, slug, description, price, colors, images, category, age_group } = req.body;
    try {
        await runAsync('UPDATE products SET name=?, slug=?, description=?, price=?, colors=?, images=?, category=?, age_group=? WHERE id=?', [name, slug, description, price, JSON.stringify(colors || []), JSON.stringify(images || []), category || '', age_group || '', id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/admin/products/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const id = req.params.id;
    try {
        await runAsync('DELETE FROM products WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Wishlist ---
app.get('/api/wishlist', authMiddleware, async (req, res) => {
    const rows = await allAsync('SELECT w.id, w.product_id, p.name, p.price, p.images FROM wishlists w JOIN products p ON p.id = w.product_id WHERE w.user_id = ?', [req.user.id]);
    const parsed = rows.map(r => ({ id: r.id, product_id: r.product_id, name: r.name, price: r.price, images: r.images ? JSON.parse(r.images) : [] }));
    res.json(parsed);
});

app.post('/api/wishlist', authMiddleware, async (req, res) => {
    const { product_id } = req.body;
    try {
        await runAsync('INSERT OR IGNORE INTO wishlists (user_id, product_id) VALUES (?,?)', [req.user.id, product_id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/wishlist/:product_id', authMiddleware, async (req, res) => {
    const pid = req.params.product_id;
    await runAsync('DELETE FROM wishlists WHERE user_id = ? AND product_id = ?', [req.user.id, pid]);
    res.json({ success: true });
});

// --- simple seeded products route for dev (admin only) ---
app.post('/api/admin/seed-demo', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const products = [
            {
                name: 'Everest Adventure Hoodie',
                slug: 'everest-adventure-hoodie',
                description: 'Cozy hoodie built for play, with reinforced seams and soft fleece.',
                price: 45.0,
                colors: [{ name: 'Navy', hex: '#1f3b6f' }, { name: 'Heather Grey', hex: '#bdbdbd' }, { name: 'Forest Green', hex: '#2b6b4a' }],
                images: ['https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=1000&q=80'],
                category: 'Hoodies & Sweatshirts',
                age_group: 'Big Kid'
            },
            {
                name: 'Cosmic Explorer Glow-in-the-Dark Tee',
                slug: 'cosmic-explorer-tee',
                description: 'Glow-in-the-dark organic tee for little astronauts.',
                price: 28.0,
                colors: [{ name: 'Midnight Blue', hex: '#0b2545' }, { name: 'Charcoal Grey', hex: '#4b4b4b' }],
                images: ['https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=900&q=80'],
                category: 'Graphic Tees',
                age_group: 'Little Kid'
            }
        ];
        for (const p of products) {
            await runAsync('INSERT OR IGNORE INTO products (name, slug, description, price, colors, images, category, age_group) VALUES (?,?,?,?,?,?,?,?)', [p.name, p.slug, p.description, p.price, JSON.stringify(p.colors), JSON.stringify(p.images), p.category, p.age_group]);
        }
        res.json({ seeded: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'err' });
    }
});

app.listen(PORT, () => {
    console.log(`Caprio Fashion API listening on port ${PORT}`);
});
