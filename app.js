const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const flash = require('connect-flash');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cron = require('node-cron');
const geoip = require('geoip-lite');
const helmet = require('helmet');
require('dotenv').config();

// ======================
// DATABASE SETUP (SQLite3)
// ======================
const DB_PATH = path.join(__dirname, 'hosting.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database.');
        initDatabase();
    }
});

function runDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function initDatabase() {
    const createTables = [
        `CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            description TEXT,
            image TEXT,
            isActive BOOLEAN DEFAULT TRUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            firstName TEXT NOT NULL,
            lastName TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            city TEXT,
            state TEXT,
            postalCode TEXT,
            isAdmin BOOLEAN DEFAULT FALSE,
            isActive BOOLEAN DEFAULT TRUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            lastLogin DATETIME,
            lastIp TEXT,
            loginAttempts INTEGER DEFAULT 0
        )`,
        `CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            categoryId TEXT NOT NULL,
            specs TEXT NOT NULL,
            features TEXT,
            priceMonthly REAL DEFAULT 0,
            priceQuarterly REAL DEFAULT 0,
            priceYearly REAL DEFAULT 0,
            image TEXT,
            isActive BOOLEAN DEFAULT TRUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (categoryId) REFERENCES categories(id)
        )`,
        `CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            productId TEXT NOT NULL,
            userId TEXT NOT NULL,
            rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
            comment TEXT,
            isApproved BOOLEAN DEFAULT TRUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (productId) REFERENCES products(id),
            FOREIGN KEY (userId) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS likes (
            id TEXT PRIMARY KEY,
            productId TEXT NOT NULL,
            userId TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(productId, userId),
            FOREIGN KEY (productId) REFERENCES products(id),
            FOREIGN KEY (userId) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            productId TEXT NOT NULL,
            productName TEXT NOT NULL,
            productCategory TEXT NOT NULL,
            billingCycle TEXT NOT NULL,
            originalPrice REAL NOT NULL,
            discount REAL DEFAULT 0,
            price REAL NOT NULL,
            paymentMethod TEXT NOT NULL DEFAULT 'razorpay',
            razorpayOrderId TEXT,
            razorpayPaymentId TEXT,
            paymentTime DATETIME,
            status TEXT DEFAULT 'pending',
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users (id),
            FOREIGN KEY (productId) REFERENCES products (id)
        )`,
        `CREATE TABLE IF NOT EXISTS coupons (
            id TEXT PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            couponType TEXT DEFAULT 'fixed',
            value REAL NOT NULL,
            maxUses INTEGER,
            uses INTEGER DEFAULT 0,
            expiresAt DATETIME,
            isActive BOOLEAN DEFAULT TRUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            subject TEXT NOT NULL,
            description TEXT,
            department TEXT NOT NULL,
            priority TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            assignedTo TEXT,
            tags TEXT,
            isReadUser BOOLEAN DEFAULT FALSE,
            isReadAdmin BOOLEAN DEFAULT FALSE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            slaDue DATETIME,
            FOREIGN KEY (userId) REFERENCES users (id),
            FOREIGN KEY (assignedTo) REFERENCES users (id)
        )`,
        `CREATE TABLE IF NOT EXISTS ticket_replies (
            id TEXT PRIMARY KEY,
            ticketId TEXT NOT NULL,
            userId TEXT NOT NULL,
            message TEXT NOT NULL,
            attachments TEXT,
            isAdminReply BOOLEAN DEFAULT FALSE,
            isNote BOOLEAN DEFAULT FALSE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (ticketId) REFERENCES tickets (id),
            FOREIGN KEY (userId) REFERENCES users (id)
        )`,
        `CREATE TABLE IF NOT EXISTS ticket_notes (
            id TEXT PRIMARY KEY,
            ticketId TEXT NOT NULL,
            userId TEXT NOT NULL,
            message TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (ticketId) REFERENCES tickets (id),
            FOREIGN KEY (userId) REFERENCES users (id)
        )`,
        `CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            description TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS visits (
            id TEXT PRIMARY KEY,
            ip TEXT NOT NULL,
            country TEXT,
            page TEXT NOT NULL,
            user_agent TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_bot BOOLEAN DEFAULT FALSE
        )`
    ];
    try {
        for (const sql of createTables) {
            await runDb(sql);
        }
        // Migration: Add missing columns if they don't exist
        await runDb(`ALTER TABLE orders ADD COLUMN paymentTime DATETIME;`).catch(err => {
            if (!err.message.includes('duplicate column name')) {
                console.error('Migration error for paymentTime:', err);
            }
        });
        // Default settings (Razorpay in .env)
        const defaultSettings = [
            { key: 'site_name', value: 'Unix Service', description: 'Site name/title' },
            { key: 'site_logo', value: '', description: 'Site logo filename' },
            { key: 'site_favicon', value: '', description: 'Site favicon filename' },
            { key: 'site_description', value: 'Reliable web hosting solutions', description: 'Site meta description' },
            { key: 'contact_email', value: process.env.SMTP_FROM || 'support@example.com', description: 'Contact email address' },
            { key: 'razorpay_key_id', value: process.env.RAZORPAY_KEY_ID || '', description: 'Razorpay Key ID' },
            { key: 'razorpay_key_secret', value: process.env.RAZORPAY_KEY_SECRET || '', description: 'Razorpay Key Secret' },
            { key: 'maintenance_mode', value: 'off', description: 'Maintenance mode on/off' }
        ];
        for (const s of defaultSettings) {
            await runDb('INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)', [s.key, s.value, s.description]);
        }
        console.log('Database initialized successfully.');
    } catch (err) {
        console.error('Error initializing database:', err);
    }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Razorpay instance - Uses .env keys
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Middleware Setup
app.use(helmet()); // Security headers
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serves /uploads if under public/uploads

// Enhanced Rate Limiting
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000000,
    message: 'Too many requests from this IP'
});
app.use(generalLimiter);

// Visit tracking middleware - Log non-admin/public requests
app.use((req, res, next) => {
    if (req.path.startsWith('/admin') || req.path.startsWith('/api') || req.method !== 'GET') {
        return next();
    }
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const page = req.originalUrl;
    const ua = req.headers['user-agent'] || '';
    const isBot = /bot|crawl|spider|googlebot|bingbot|yandex/i.test(ua);
    const geo = geoip.lookup(ip);
    const country = geo ? geo.country : 'Unknown';
    const visitId = uuidv4();
    runDb('INSERT INTO visits (id, ip, country, page, user_agent, is_bot) VALUES (?, ?, ?, ?, ?, ?)',
          [visitId, ip, country, page, ua, isBot]).catch(err => console.error('Visit log error:', err));
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-prod',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

app.use(flash());

app.use((req, res, next) => {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.moment = moment;
    res.locals.isLoggedIn = !!req.session.authorised;
    res.locals.user = req.session.user || null;
    next();
});

// ======================
// Settings middleware - FIXED FAVICON & LOGO PATHS
// ======================
app.use(async (req, res, next) => {
    res.locals.siteName = 'Unix Service';
    res.locals.siteLogo = '/images/default-logo.png'; 
    res.locals.siteFavicon = '/images/favicon.ico'; // Default favicon
    res.locals.siteDescription = 'Best Reliable Minecraft & Vps Hosting Solutions';

    try {
        const settingsRows = await dbAll('SELECT key, value FROM settings');
        const settObj = {};
        settingsRows.forEach(row => settObj[row.key] = row.value);

        res.locals.settings = settObj;
        res.locals.siteName = settObj.site_name || res.locals.siteName;
        res.locals.siteDescription = settObj.site_description || res.locals.siteDescription;

        // === FIXED: Proper path handling for logo and favicon ===
        if (settObj.site_logo && settObj.site_logo.trim() !== '') {
            const logoPath = settObj.site_logo.startsWith('/uploads/') 
                ? settObj.site_logo 
                : `/uploads/${settObj.site_logo}`;
            res.locals.siteLogo = logoPath;
        }

        if (settObj.site_favicon && settObj.site_favicon.trim() !== '') {
            const faviconPath = settObj.site_favicon.startsWith('/uploads/') 
                ? settObj.site_favicon 
                : `/uploads/${settObj.site_favicon}`;
            res.locals.siteFavicon = faviconPath;
        }

        res.locals.maintenanceMode = settObj.maintenance_mode === 'on';
    } catch (err) {
        console.error('Settings load error:', err);
    }
    next();
});

// Serve favicon explicitly (fixes many favicon 404 issues)
app.get('/favicon.ico', (req, res) => {
    const favicon = res.locals.siteFavicon || '/images/favicon.ico';
    res.sendFile(path.join(__dirname, 'public', favicon.replace(/^\//, '')));
});

// Maintenance mode middleware
app.use((req, res, next) => {
    if (res.locals.maintenanceMode && req.path !== '/maintenance' && !req.path.startsWith('/admin')) {
        if (!req.session.user?.isAdmin) {
            return res.render('maintenance', { title: 'Maintenance Mode' });
        }
    }
    next();
});

// ======================
// CONFIGURATION
// ======================
const SALT_ROUNDS = 12; // Increased for better security
const UPLOAD_DIR = path.join(__dirname, 'public/uploads');
['uploads', 'uploads/tickets', 'images'].forEach(dir => { // Added images dir for defaults
    const fullPath = path.join(__dirname, 'public', dir);
    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname}`)
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Image only'), false)
});

const categoryUpload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Image only'), false)
});

const ticketStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'tickets')),
    filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname.replace(/\s+/g, '_')}`)
});

const ticketUpload = multer({
    storage: ticketStorage,
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'application/pdf', 'text/plain'];
        allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid type'), false);
    }
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465
    auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
    }
});

// ======================
// HELPER FUNCTIONS
// ======================
const helpers = {
    validateEmail: email => validator.isEmail(email),
    validatePhone: phone => validator.isMobilePhone(phone, 'any'),
    validatePassword: password => password && password.length >= 8,
    sanitize: (str) => validator.escape(str).trim(),
    hashPassword: password => bcrypt.hashSync(password, SALT_ROUNDS),
    comparePassword: (password, hash) => bcrypt.compareSync(password, hash),
    deleteFile: filePath => {
        if (!filePath) return;
        const fullPath = path.join(__dirname, 'public', filePath.startsWith('/') ? filePath.slice(1) : filePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    },
    sendEmail: async options => {
        try {
            await transporter.sendMail({
                from: `"Hosting" <${process.env.SMTP_FROM || ''}>`,
                ...options
            });
            return true;
        } catch (err) {
            console.error('Email error:', err);
            return false;
        }
    },
    formatBytes: (bytes, decimals = 2) => {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },
    paginate: (total, page = 1, perPage = 10) => ({
        data: [],
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
        hasNext: page < Math.ceil(total / perPage),
        hasPrev: page > 1
    }),
    generateCouponCode: () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
            if (i === 3) result += '-';
        }
        return result;
    },
    countRows: (table, where = '', params = []) => new Promise(resolve => {
        const sql = `SELECT COUNT(*) as count FROM ${table} ${where}`;
        db.get(sql, params, (err, row) => resolve(row ? row.count : 0));
    }),
    getCategories: async () => {
        const categories = await dbAll('SELECT id, name, slug, image FROM categories WHERE isActive = 1 ORDER BY name');
        return categories.map(c => ({
            ...c,
            image: c.image || '/images/default-category.png' // Default image fallback
        }));
    },
    getCategoryStats: async () => {
        const stats = await dbAll(`
            SELECT c.name, c.slug, c.image, COUNT(p.id) as count
            FROM categories c
            LEFT JOIN products p ON p.categoryId = c.id
            WHERE c.isActive = 1
            GROUP BY c.id
            ORDER BY c.name
        `);
        return stats.map(s => ({
            ...s,
            image: s.image || '/images/default-category.png' // Default image fallback
        }));
    },
    getAverageRating: (productId) => dbGet('SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE productId = ? AND isApproved = 1', [productId]),
    isLiked: (productId, userId) => dbGet('SELECT id FROM likes WHERE productId = ? AND userId = ?', [productId, userId])
};

async function getCategoryBySlug(slug) {
    try {
        const row = await dbGet('SELECT id FROM categories WHERE LOWER(slug) = LOWER(?) AND isActive = 1', [slug]);
        return row ? row.id : null;
    } catch (err) {
        console.error('getCategoryBySlug error:', err);
        return null;
    }
}

async function getProduct(id, userId = null) {
    try {
        const row = await dbGet(`SELECT p.*, c.name as categoryName, c.slug as categorySlug
            FROM products p
            LEFT JOIN categories c ON p.categoryId = c.id
            WHERE p.id = ? AND p.isActive = 1`, [id]);
        if (row) {
            row.category = row.categoryName || 'Uncategorized';
            row.categorySlug = row.categorySlug || '';
            delete row.categoryName;
            try {
                row.specs = JSON.parse(row.specs || '{}');
                row.features = JSON.parse(row.features || '[]');
            } catch (e) {
                row.specs = {};
                row.features = [];
            }
            row.image = row.image || '/images/default-product.png'; // Default image fallback
            // Add average rating
            const rating = await helpers.getAverageRating(id);
            row.averageRating = rating ? parseFloat(rating.avg).toFixed(1) : 0;
            row.reviewCount = rating ? rating.count : 0;
            // Add like status
            if (userId) {
                const like = await helpers.isLiked(id, userId);
                row.isLiked = !!like;
            }
        }
        return row;
    } catch (err) {
        console.error('getProduct error:', err);
        return null;
    }
}

async function processProducts(products) {
    // Parallel processing for ratings and JSON parsing
    return Promise.all(products.map(async (p) => {
        p.category = p.categoryName || 'Uncategorized';
        p.categorySlug = p.categorySlug || '';
        delete p.categoryName;
        try {
            p.specs = JSON.parse(p.specs || '{}');
            p.features = JSON.parse(p.features || '[]');
        } catch {
            p.specs = {};
            p.features = [];
        }
        p.image = p.image || '/images/default-product.png'; // Default image fallback
        const rating = await helpers.getAverageRating(p.id);
        p.averageRating = rating ? parseFloat(rating.avg).toFixed(1) : '0.0';
        return p;
    }));
}

async function refreshUserSession(req) {
    if (!req.session.authorised) return;
    try {
        const user = await dbGet('SELECT id, email, firstName, lastName, isAdmin FROM users WHERE id = ?', [req.session.user.id]);
        if (user) req.session.user = user;
    } catch (err) {
        console.error('Session refresh error:', err);
    }
}

// ======================
// MIDDLEWARE
// ======================
const requireGuest = (req, res, next) => req.session.authorised ? res.redirect('/dashboard') : next();

const requireAuth = (req, res, next) => {
    if (!req.session.authorised) {
        req.flash('error', 'Please login');
        return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    }
    refreshUserSession(req).then(() => next()).catch(() => next());
};

const requireAdmin = (req, res, next) => {
    requireAuth(req, res, () => {
        if (!req.session.user.isAdmin) {
            req.flash('error', 'Admin required');
            return res.redirect('/dashboard');
        }
        next();
    });
};

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many attempts' });

// ======================
// TICKET CONFIG
// ======================
const TICKET_CONFIG = {
    PRIORITIES: ['low', 'medium', 'high', 'critical'],
    STATUSES: ['open', 'in_progress', 'on_hold', 'resolved', 'closed'],
    DEPARTMENTS: ['billing', 'technical', 'sales', 'general'],
    TAGS: ['bug', 'feature', 'payment', 'login', 'ui', 'api', 'urgent'],
    MAX_ATTACHMENTS: 5,
    MAX_ATTACHMENT_SIZE: 10 * 1024 * 1024,
    AUTO_CLOSE_DAYS: 7,
    SLA: { critical: 2, high: 8, medium: 24, low: 72 },
    CANNED_RESPONSES: [
        { id: 'welcome', name: 'Welcome Message', content: 'Thank you for contacting support. We will get back to you soon.' },
        { id: 'update', name: 'Need More Info', content: 'To assist you better, please provide more details about the issue.' },
        { id: 'solved', name: 'Issue Resolved', content: 'Your issue has been resolved. If you have further questions, feel free to reply.' }
    ]
};

function calculateSLADueDate(priority) {
    const hours = TICKET_CONFIG.SLA[priority] || 24;
    const due = new Date();
    due.setHours(due.getHours() + hours);
    return due.toISOString();
}

const ticketHelpers = {
    getUserTickets: async (userId, page = 1, perPage = 10, filters = {}) => {
        let whereConditions = [];
        let whereParams = [userId];
        if (filters.status && filters.status !== 'all') {
            whereConditions.push('status = ?');
            whereParams.push(filters.status);
        }
        if (filters.department && filters.department !== 'all') {
            whereConditions.push('department = ?');
            whereParams.push(filters.department);
        }
        if (filters.priority && filters.priority !== 'all') {
            whereConditions.push('priority = ?');
            whereParams.push(filters.priority);
        }
        if (filters.search) {
            whereConditions.push('(subject LIKE ? OR id LIKE ? OR description LIKE ?)');
            const term = `%${filters.search}%`;
            whereParams.push(term, term, term);
        }
        if (filters.tag) {
            whereConditions.push('tags LIKE ?');
            whereParams.push(`%${filters.tag}%`);
        }
        const whereSql = whereConditions.length > 0 ? ' AND ' + whereConditions.join(' AND ') : '';
        const sql = `SELECT * FROM tickets WHERE userId = ?${whereSql} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`;
        const fullParams = [...whereParams, perPage, (page - 1) * perPage];
        const tickets = await dbAll(sql, fullParams);
        const count = await helpers.countRows('tickets', `WHERE userId = ?${whereSql}`, whereParams);
        const pag = helpers.paginate(count, page, perPage);
        pag.data = tickets;
        return pag;
    },
    getAllTickets: async (page = 1, perPage = 10, filters = {}) => {
        let whereConditions = [];
        let whereParams = [];
        if (filters.status && filters.status !== 'all') {
            whereConditions.push('status = ?');
            whereParams.push(filters.status);
        }
        if (filters.department && filters.department !== 'all') {
            whereConditions.push('department = ?');
            whereParams.push(filters.department);
        }
        if (filters.priority && filters.priority !== 'all') {
            whereConditions.push('priority = ?');
            whereParams.push(filters.priority);
        }
        if (filters.assigned && filters.assigned !== 'all') {
            if (filters.assigned === 'unassigned') {
                whereConditions.push('assignedTo IS NULL');
            } else {
                whereConditions.push('assignedTo = ?');
                whereParams.push(filters.assigned);
            }
        }
        if (filters.search) {
            whereConditions.push('(subject LIKE ? OR id LIKE ? OR description LIKE ? OR (SELECT email FROM users u WHERE u.id = tickets.userId) LIKE ?)');
            const term = `%${filters.search}%`;
            whereParams.push(term, term, term, term);
        }
        if (filters.tag) {
            whereConditions.push('tags LIKE ?');
            whereParams.push(`%${filters.tag}%`);
        }
        if (filters.dateFrom) {
            whereConditions.push('createdAt >= ?');
            whereParams.push(filters.dateFrom);
        }
        if (filters.dateTo) {
            whereConditions.push('createdAt <= ?');
            whereParams.push(filters.dateTo + ' 23:59:59');
        }
        const whereSql = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';
        const sql = `SELECT * FROM tickets${whereSql} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`;
        const fullParams = [...whereParams, perPage, (page - 1) * perPage];
        const tickets = await dbAll(sql, fullParams);
        const count = await helpers.countRows('tickets', whereSql, whereParams);
        const pag = helpers.paginate(count, page, perPage);
        pag.data = tickets;
        return pag;
    },
    createTicket: async (userId, subject, message, department, priority, attachments = [], tags = []) => {
        const ticketId = `TKT-${uuidv4().split('-')[0].toUpperCase()}`;
        const description = message.substring(0, 200) + (message.length > 200 ? '...' : '');
        const validTags = tags.filter(t => TICKET_CONFIG.TAGS.includes(t.trim()));
        const tagStr = validTags.join(',');
        const slaDue = calculateSLADueDate(priority);
        await runDb(`INSERT INTO tickets (id, userId, subject, description, department, priority, tags, slaDue, isReadUser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [ticketId, userId, subject, description, department, priority, tagStr, slaDue]);
        const replySuccess = await ticketHelpers.addReply(ticketId, userId, message, attachments, false, false, true);
        return replySuccess ? { id: ticketId } : null;
    },
    addReply: async (ticketId, userId, message, attachments = [], isInitial = false, isNote = false, noEmail = false) => {
        const user = await dbGet('SELECT isAdmin FROM users WHERE id = ?', [userId]);
        const isAdminReply = user ? user.isAdmin : false;
        const replyId = uuidv4();
        const attachStr = JSON.stringify(attachments.map(a => ({ name: a.name, path: a.path, size: a.size, type: a.mimetype })));
        const table = isNote ? 'ticket_notes' : 'ticket_replies';
        let sql, params;
        if (isNote) {
            sql = 'INSERT INTO ticket_notes (id, ticketId, userId, message) VALUES (?, ?, ?, ?)';
            params = [replyId, ticketId, userId, message];
        } else {
            sql = 'INSERT INTO ticket_replies (id, ticketId, userId, message, attachments, isAdminReply, isNote) VALUES (?, ?, ?, ?, ?, ?, ?)';
            params = [replyId, ticketId, userId, message, attachStr, isAdminReply, isNote];
        }
        await runDb(sql, params);
        let updateSql = 'UPDATE tickets SET updatedAt = CURRENT_TIMESTAMP';
        let updateParams = [];
        if (!isNote) {
            updateSql += ', isReadUser = ?, isReadAdmin = ?';
            updateParams.push(isAdminReply ? 0 : 1);
            updateParams.push(isAdminReply ? 1 : 0);
        }
        updateSql += ' WHERE id = ?';
        updateParams.push(ticketId);
        await runDb(updateSql, updateParams);
        if (!isNote && !noEmail && isAdminReply) {
            const ticketUser = await dbGet('SELECT u.email, t.subject FROM users u JOIN tickets t ON t.userId = u.id WHERE t.id = ?', [ticketId]);
            if (ticketUser) {
                await helpers.sendEmail({
                    to: ticketUser.email,
                    subject: `Re: ${ticketUser.subject}`,
                    html: `<p>New reply from support:</p><p>${message.replace(/\n/g, '<br>')}</p>`
                });
            }
        }
        return { id: replyId };
    },
    updateTicketStatus: async (ticketId, status, userId) => {
        if (!TICKET_CONFIG.STATUSES.includes(status)) return false;
        const result = await runDb('UPDATE tickets SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [status, ticketId]);
        return !result.err && result.changes > 0;
    },
    getSLAStatus: ticket => {
        if (!ticket.slaDue || ['closed', 'resolved'].includes(ticket.status)) return 'met';
        const now = new Date();
        const due = new Date(ticket.slaDue);
        const diffHours = (due - now) / (1000 * 60 * 60);
        if (diffHours <= 0) return 'breached';
        if (diffHours <= 4) return 'warning';
        return 'ok';
    },
    getCannedResponses: () => TICKET_CONFIG.CANNED_RESPONSES
};

// Auto close inactive tickets - Improved with cron instead of setInterval
cron.schedule('0 0 * * *', () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - TICKET_CONFIG.AUTO_CLOSE_DAYS);
    db.run('UPDATE tickets SET status = "closed", updatedAt = CURRENT_TIMESTAMP WHERE status NOT IN ("resolved", "closed") AND updatedAt < ? AND isReadAdmin = 1', [cutoff.toISOString()], function(err) {
        if (err) console.error('Auto close error:', err);
        else if (this.changes > 0) console.log(`Auto-closed ${this.changes} inactive tickets`);
    });
});

// ======================
// CRON JOBS FOR ORDERS
// ======================
// Activate orders 10 minutes after payment - Fixed with error handling
cron.schedule('*/1 * * * *', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    try {
        const result = await runDb(
            'UPDATE orders SET status = "active", updatedAt = CURRENT_TIMESTAMP WHERE status = "paid" AND paymentTime <= ?',
            [tenMinAgo]
        );
        if (result.changes > 0) {
            console.log(`Activated ${result.changes} orders after payment delay`);
            // Send activation email for each activated order
            const activatedOrders = await dbAll('SELECT o.id, u.email, o.productName FROM orders o JOIN users u ON o.userId = u.id WHERE o.status = "active" AND o.paymentTime <= ? AND o.paymentTime > datetime("now", "-15 minutes")', [tenMinAgo]);
            for (const order of activatedOrders) {
                helpers.sendEmail({
                    to: order.email,
                    subject: 'Order Activated',
                    html: `<h1>Your order #${order.id} is now active!</h1><p>Product: ${order.productName}</p><p>Welcome to your hosting service.</p>`
                });
            }
        }
    } catch (err) {
        console.error('Cron activate error:', err);
    }
});

// Cancel pending orders after 24 hours
cron.schedule('0 * * * *', async () => {
    const twentyFourHrsAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    try {
        const result = await runDb(
            'UPDATE orders SET status = "cancelled", updatedAt = CURRENT_TIMESTAMP WHERE status = "pending" AND createdAt <= ?',
            [twentyFourHrsAgo]
        );
        if (result.changes > 0) {
            console.log(`Cancelled ${result.changes} pending orders after 24 hours`);
        }
    } catch (err) {
        console.error('Cron cancel error:', err);
    }
});

// ======================
// PUBLIC ROUTES
// ======================
app.get('/maintenance', (req, res) => {
    res.render('maintenance', { title: 'Under Maintenance' });
});

app.get('/', (req, res) => res.redirect('/view'));

app.get('/view', async (req, res) => {
    try {
        const search = helpers.sanitize(req.query.search || '');
        let categories = await helpers.getCategoryStats();
        let featuredProducts = [];
        let recentProducts = [];
        let siteStats = {};
        // -----------------------------
        // 🔍 SEARCH MODE
        // -----------------------------
        if (search) {
            const rawProducts = await dbAll(
                `SELECT p.*, c.name AS categoryName
                 FROM products p
                 LEFT JOIN categories c ON p.categoryId = c.id
                 WHERE p.isActive = 1
                 AND (p.name LIKE ? OR p.description LIKE ?)
                 LIMIT 6`,
                [`%${search}%`, `%${search}%`]
            );
            featuredProducts = await processProducts(rawProducts);
        }
        // -----------------------------
        // 🆕 RECENT PRODUCTS MODE
        // -----------------------------
        else {
            const rawProducts = await dbAll(
                `SELECT p.*, c.name AS categoryName
                 FROM products p
                 LEFT JOIN categories c ON p.categoryId = c.id
                 WHERE p.isActive = 1
                 ORDER BY p.createdAt DESC
                 LIMIT 6`
            );
            recentProducts = await processProducts(rawProducts);
            // Get stats
            siteStats = {
                totalProducts: await helpers.countRows('products', 'WHERE isActive = 1'),
                totalCategories: await helpers.countRows('categories', 'WHERE isActive = 1'),
                totalOrders: await helpers.countRows('orders', 'WHERE status = "active"')
            };
        }
        // -----------------------------
        // STATIC DATA
        // -----------------------------
        const testimonials = [
            { name: 'John Doe', text: 'Great hosting service!', rating: 5 },
            { name: 'Jane Smith', text: 'Reliable and fast.', rating: 4 },
            { name: 'Mike Johnson', text: 'Excellent support team.', rating: 5 },
            { name: 'Sarah Wilson', text: 'Affordable plans with great uptime.', rating: 5 }
        ];
        const whyUs = [
            { icon: 'fa fa-shield-alt', title: 'Secure Hosting', desc: 'Advanced security features to protect your data.' },
            { icon: 'fa fa-rocket', title: 'Fast Performance', desc: 'Optimized servers for lightning-fast loading times.' },
            { icon: 'fa fa-headset', title: '24/7 Support', desc: 'Round-the-clock assistance whenever you need it.' },
            { icon: 'fa fa-database', title: 'Scalable Solutions', desc: 'Easily scale your resources as your business grows.' }
        ];
        // -----------------------------
        // RENDER PAGE
        // -----------------------------
        res.render('users/view', {
            title: 'Home - Categories & Featured',
            categories,
            currentCategory: null,
            activePage: 'view',
            isLoggedIn: !!req.session.user,
            search,
            featuredProducts,
            recentProducts,
            siteStats,
            testimonials,
            whyUs
        });
    } catch (err) {
        console.error('❌ Error loading /view:', err);
        req.flash('error', 'Error loading home page.');
        res.redirect('/');
    }
});

app.get('/c/:cat', async (req, res) => {
    const slug = helpers.sanitize(req.params.cat);
    const category = await dbGet('SELECT * FROM categories WHERE slug = ? AND isActive = 1', [slug]);
    if (!category) {
        req.flash('error', 'Category not found');
        return res.redirect('/view');
    }
    category.image = category.image || '/images/default-category.png'; // Fallback
    const page = parseInt(req.query.page) || 1;
    const perPage = 12;
    try {
        const offset = (page - 1) * perPage;
        let sql = `SELECT p.*, c.name as categoryName, c.slug as categorySlug
                   FROM products p
                   LEFT JOIN categories c ON p.categoryId = c.id
                   WHERE p.isActive = 1 AND p.categoryId = ?
                   ORDER BY p.createdAt DESC LIMIT ? OFFSET ?`;
        let params = [category.id, perPage, offset];
        const rawProducts = await dbAll(sql, params);
        const products = await processProducts(rawProducts);
        const count = await helpers.countRows('products', 'WHERE isActive = 1 AND categoryId = ?', [category.id]);
        const pag = helpers.paginate(count, page, perPage);
        pag.data = products;
        const categories = await helpers.getCategories();
        res.render('users/products', {
            title: `Products - ${category.name}`,
            products: pag.data,
            activePage: 'products',
            search: '',
            category,
            categories: categories,
            currentCategory: slug,
            pagination: pag
        });
    } catch (err) {
        console.error('Error loading category products:', err);
        req.flash('error', 'Error loading products');
        res.redirect('/view');
    }
});

app.get('/products', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const perPage = 12;
        // Always convert null to empty string BEFORE sanitizing
        const rawCategory = req.query.category ?? '';
        const rawSearch = req.query.search ?? '';
        const category = helpers.sanitize(String(rawCategory));
        const search = helpers.sanitize(String(rawSearch));
        let where = 'WHERE p.isActive = 1';
        let params = [];
        let countWhere = where;
        let countParams = [];
        // -------------------------
        // SEARCH FILTER
        // -------------------------
        if (search.trim() !== '') {
            where += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            countWhere += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
            countParams.push(`%${search}%`, `%${search}%`);
        }
        // -------------------------
        // CATEGORY FILTER
        // -------------------------
        let catId = null;
        if (category.trim() !== '') {
            catId = await getCategoryBySlug(category);
            if (!catId) {
                req.flash('error', 'Category not found');
                return res.redirect('/products');
            }
            where += ' AND p.categoryId = ?';
            countWhere += ' AND p.categoryId = ?';
            params.push(catId);
            countParams.push(catId);
        }
        // -------------------------
        // PAGINATION
        // -------------------------
        const offset = (page - 1) * perPage;
        const sql = `
            SELECT p.*, c.name AS categoryName, c.slug AS categorySlug
            FROM products p
            LEFT JOIN categories c ON p.categoryId = c.id
            ${where}
            ORDER BY p.createdAt DESC
            LIMIT ? OFFSET ?
        `;
        params.push(perPage, offset);
        const rawProducts = await dbAll(sql, params);
        const products = await processProducts(rawProducts);
        // -------------------------
        // TOTAL COUNT FOR PAGINATION
        // -------------------------
        const countSql = `SELECT COUNT(*) AS total FROM products p ${countWhere}`;
        const countRow = await dbGet(countSql, countParams);
        const pag = helpers.paginate(countRow?.total || 0, page, perPage);
        pag.data = products;
        // -------------------------
        // LOAD CATEGORIES
        // -------------------------
        const categories = await helpers.getCategories();
        res.render('users/products', {
            title: 'Products',
            products: pag.data,
            activePage: 'products',
            category,
            categories,
            currentCategory: category || 'all',
            pagination: pag,
            search
        });
    } catch (err) {
        console.error('Error loading products:', err);
        req.flash('error', 'Error loading products');
        res.redirect('/view');
    }
});

app.get('/products/:id', requireAuth, async (req, res) => {
    try {
        const product = await getProduct(req.params.id, req.session.user.id);
        if (!product) {
            req.flash('error', 'Product not found');
            return res.redirect('/products');
        }
        const rawRelated = await dbAll('SELECT * FROM products WHERE categoryId = ? AND id != ? AND isActive = 1 LIMIT 4', [product.categoryId, req.params.id]);
        const relatedProducts = await Promise.all(rawRelated.map(async (p) => {
            try {
                p.specs = JSON.parse(p.specs || '{}');
                p.features = JSON.parse(p.features || '[]');
                p.image = p.image || '/images/default-product.png';
                const rating = await helpers.getAverageRating(p.id);
                p.averageRating = rating ? parseFloat(rating.avg).toFixed(1) : 0;
            } catch (e) {}
            return p;
        }));
        // Fetch reviews
        const reviews = await dbAll('SELECT r.*, u.firstName, u.lastName FROM reviews r JOIN users u ON r.userId = u.id WHERE r.productId = ? AND r.isApproved = 1 ORDER BY r.createdAt DESC LIMIT 5', [req.params.id]);
        const categories = await helpers.getCategories();
        res.render('users/product-detail', {
            title: product.name,
            product,
            activePage: 'products',
            relatedProducts,
            reviews,
            categories,
            currentCategory: product.categorySlug
        });
    } catch (err) {
        console.error('Error loading product:', err);
        req.flash('error', 'Error loading product');
        res.redirect('/products');
    }
});

app.get('/c/:cat/:id', async (req, res) => {
    const slug = helpers.sanitize(req.params.cat);
    const category = await dbGet('SELECT id FROM categories WHERE slug = ? AND isActive = 1', [slug]);
    if (!category) {
        req.flash('error', 'Category not found');
        return res.redirect('/view');
    }
    try {
        const row = await dbGet(`SELECT p.*, c.name as categoryName, c.slug as categorySlug
                                     FROM products p
                                     LEFT JOIN categories c ON p.categoryId = c.id
                                     WHERE p.id = ? AND p.categoryId = ? AND p.isActive = 1`, [req.params.id, category.id]);
        if (!row) {
            req.flash('error', 'Product not found');
            return res.redirect(`/c/${slug}`);
        }
        const product = await processProducts([row]).then(([p]) => p); // Reuse process
        const rawRelated = await dbAll('SELECT * FROM products WHERE categoryId = ? AND id != ? AND isActive = 1 LIMIT 4', [category.id, req.params.id]);
        const relatedProducts = await Promise.all(rawRelated.map(async (p) => {
            try {
                p.specs = JSON.parse(p.specs || '{}');
                p.features = JSON.parse(p.features || '[]');
                p.image = p.image || '/images/default-product.png';
                const rating = await helpers.getAverageRating(p.id);
                p.averageRating = rating ? parseFloat(rating.avg).toFixed(1) : 0;
            } catch (e) {}
            return p;
        }));
        const categories = await helpers.getCategories();
        // Fetch reviews
        const reviews = await dbAll('SELECT r.*, u.firstName, u.lastName FROM reviews r JOIN users u ON r.userId = u.id WHERE r.productId = ? AND r.isApproved = 1 ORDER BY r.createdAt DESC LIMIT 5', [req.params.id]);
        res.render('users/product-detail', {
            title: product.name,
            product,
            relatedProducts,
            reviews,
            categories,
            currentCategory: slug
        });
    } catch (err) {
        console.error('Error loading product:', err);
        req.flash('error', 'Error loading product');
        res.redirect(`/c/${slug}`);
    }
});

// Review and Like Routes
app.post('/products/:id/review', requireAuth, async (req, res) => {
    const { rating, comment } = req.body;
    const productId = req.params.id;
    const userId = req.session.user.id;
    if (!rating || rating < 1 || rating > 5 || (comment && comment.length > 1000)) {
        req.flash('error', 'Invalid rating or comment too long');
        return res.redirect(`/products/${productId}`);
    }
    try {
        const existing = await dbGet('SELECT id FROM reviews WHERE productId = ? AND userId = ?', [productId, userId]);
        if (existing) {
            req.flash('error', 'You can only submit one review per product');
            return res.redirect(`/products/${productId}`);
        }
        const reviewId = uuidv4();
        await runDb('INSERT INTO reviews (id, productId, userId, rating, comment) VALUES (?, ?, ?, ?, ?)',
            [reviewId, productId, userId, parseInt(rating), helpers.sanitize(comment || null)]);
        req.flash('success', 'Review submitted and awaiting approval');
        res.redirect(`/products/${productId}`);
    } catch (err) {
        console.error('Review submission error:', err);
        req.flash('error', 'Failed to submit review');
        res.redirect(`/products/${productId}`);
    }
});

app.post('/products/:id/like', requireAuth, async (req, res) => {
    const productId = req.params.id;
    const userId = req.session.user.id;
    try {
        const existing = await helpers.isLiked(productId, userId);
        if (existing) {
            await runDb('DELETE FROM likes WHERE productId = ? AND userId = ?', [productId, userId]);
            return res.json({ liked: false });
        } else {
            const likeId = uuidv4();
            await runDb('INSERT INTO likes (id, productId, userId) VALUES (?, ?, ?)', [likeId, productId, userId]);
            return res.json({ liked: true });
        }
    } catch (err) {
        console.error('Like toggle error:', err);
        res.status(500).json({ error: 'Failed to toggle like' });
    }
});

// ======================
// AUTH ROUTES
// ======================
app.get('/login', requireGuest, (req, res) => {
    res.render('users/login', {
        title: 'Login',
        redirectUrl: req.query.redirect || '',
        activePage: 'login',
        isLoggedIn: !!req.session.user
    });
});

app.post('/login', loginLimiter, requireGuest, (req, res) => {
    const { email, password, remember } = req.body;
    const redirectUrl = req.body.redirectUrl || '/dashboard';
    if (!email || !password || !helpers.validateEmail(email)) {
        req.flash('error', 'Invalid email/password');
        return res.redirect('/login');
    }
    db.get('SELECT * FROM users WHERE email = ? AND isActive = 1', [email], async (err, user) => {
        if (err || !user || !helpers.comparePassword(password, user.password)) {
            await runDb('UPDATE users SET loginAttempts = loginAttempts + 1 WHERE email = ?', [email]);
            const attemptsRow = await dbGet('SELECT loginAttempts FROM users WHERE email = ?', [email]);
            if (attemptsRow && attemptsRow.loginAttempts >= 5) {
                await runDb('UPDATE users SET isActive = 0 WHERE email = ?', [email]);
                helpers.sendEmail({ to: email, subject: 'Account Locked', html: 'Account locked due to multiple failed attempts.' });
                req.flash('error', 'Account locked due to multiple failed attempts');
            } else {
                req.flash('error', 'Invalid credentials');
            }
            return res.redirect('/login');
        }
        await runDb('UPDATE users SET loginAttempts = 0, lastLogin = CURRENT_TIMESTAMP, lastIp = ? WHERE id = ?', [req.ip, user.id]);
        req.session.authorised = true;
        req.session.user = { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, isAdmin: user.isAdmin };
        if (remember === 'on') req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        req.flash('success', 'Logged in successfully');
        res.redirect(redirectUrl);
    });
});

app.get('/register', requireGuest, (req, res) =>
    res.render('users/register', {
        title: 'Register',
        formData: req.flash('formData')[0] || {},
        errors: req.flash('error'),
        activePage: 'register',
        isLoggedIn: !!req.session.user
    })
);

app.post('/register', requireGuest, async (req, res) => {
    const { email, password, confirmPassword, firstName, lastName, phone, terms } = req.body;
    const errors = [];
    if (!email || !password || !confirmPassword || !firstName || !lastName || !phone || !terms) errors.push('All fields required');
    if (!helpers.validateEmail(email)) errors.push('Invalid email');
    if (!helpers.validatePassword(password)) errors.push('Password >= 8 chars');
    if (password !== confirmPassword) errors.push('Passwords mismatch');
    if (!helpers.validatePhone(phone)) errors.push('Invalid phone');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
        req.flash('error', 'Email already exists');
        return res.redirect('/register');
    }
    const hashed = helpers.hashPassword(password);
    const userId = uuidv4();
    const count = await helpers.countRows('users');
    const isAdmin = count === 0;
    try {
        await runDb('INSERT INTO users (id, email, password, firstName, lastName, phone, address, city, state, postalCode, isAdmin) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)',
            [userId, email, hashed, firstName, lastName, phone, isAdmin]);
        helpers.sendEmail({ to: email, subject: 'Welcome', html: `<h1>Welcome ${firstName}!</h1>` });
        req.flash('success', 'Registered successfully');
        res.redirect('/login');
    } catch (err) {
        console.error('Registration error:', err);
        req.flash('error', 'Registration failed');
        res.redirect('/register');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) console.error(err);
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

// ======================
// DASHBOARD & USER ROUTES
// ======================
app.get('/dashboard', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const orders = await dbAll('SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC LIMIT 5', [userId]);
        const totalOrders = await helpers.countRows('orders', 'WHERE userId = ?', [userId]);
        const openTickets = await helpers.countRows('tickets', 'WHERE userId = ? AND status IN ("open", "in_progress")', [userId]);
        const totalSpent = await dbGet('SELECT SUM(price) as total FROM orders WHERE userId = ? AND status != "cancelled"', [userId]);
        const recentActivity = await dbAll(`SELECT 'order' as type, createdAt, 'Order #' || id as desc FROM orders WHERE userId = ?
                                           UNION ALL
                                           SELECT 'ticket' as type, createdAt, 'Ticket #' || id as desc FROM tickets WHERE userId = ?
                                           ORDER BY createdAt DESC LIMIT 5`, [userId, userId]);
        // Liked products - process with defaults
        const rawLiked = await dbAll(`
            SELECT p.*, c.name as categoryName
            FROM likes l
            JOIN products p ON l.productId = p.id
            LEFT JOIN categories c ON p.categoryId = c.id
            WHERE l.userId = ? AND p.isActive = 1
            ORDER BY l.createdAt DESC LIMIT 5
        `, [userId]);
        const likedProducts = await processProducts(rawLiked.map(p => ({...p, categoryName: p.categoryName})));
        res.render('users/dashboard', {
            title: 'Dashboard',
            activePage: 'dashboard',
            orders,
            stats: { totalOrders, openTickets },
            totalSpent: totalSpent ? totalSpent.total : 0,
            recentActivity,
            likedProducts
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        req.flash('error', 'Error loading dashboard');
        res.redirect('/dashboard');
    }
});

// ======================
// ORDERS & PAYMENT - Professional Razorpay Integration (Improved with failed payments)
// ======================
app.post('/create-razorpay-order', requireAuth, async (req, res) => {
    const { amount, orderId } = req.body;
    if (!amount || amount <= 0 || !orderId) {
        return res.status(400).json({ error: 'Invalid amount or order ID' });
    }
    try {
        const options = {
            amount: Math.round(amount * 100), // paise
            currency: 'INR',
            receipt: orderId,
            notes: {
                userId: req.session.user.id
            },
            theme: {
                color: '#3399cc'
            },
            handler: function (response){
                // Client-side handler if needed
            }
        };
        const order = await razorpay.orders.create(options);
        // Update order with Razorpay order ID
        await runDb('UPDATE orders SET razorpayOrderId = ? WHERE id = ?', [order.id, orderId]);
        res.json({
            orderId: order.id,
            key: process.env.RAZORPAY_KEY_ID,
            amount: order.amount / 100
        });
    } catch (err) {
        console.error('Razorpay order creation error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// Webhook for Razorpay - Enhanced with better logging, security, and failed payment handling
app.post('/razorpay-webhook', express.raw({type: 'application/json'}), (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
        console.log('Webhook: Missing signature');
        return res.status(400).send('Signature missing');
    }
    try {
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                                       .update(req.body).digest('hex');
        if (signature === expectedSignature) {
            const event = JSON.parse(req.body);
            const razorpayOrderId = event.payload.payment.entity.order_id;
            if (event.event === 'payment.captured') {
                const paymentId = event.payload.payment.entity.id;
                // Update to 'paid' status and set paymentTime
                runDb('UPDATE orders SET razorpayPaymentId = ?, status = "paid", paymentTime = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE razorpayOrderId = ?',
                      [paymentId, razorpayOrderId], function(err) {
                    if (err) console.error('Webhook DB update error:', err);
                    else if (this.changes > 0) {
                        console.log(`Payment captured for order ${razorpayOrderId}, set to paid`);
                        // Send email notification
                        db.get('SELECT u.email, o.productName, o.price FROM users u JOIN orders o ON o.userId = u.id WHERE o.razorpayOrderId = ?', [razorpayOrderId], (err, row) => {
                            if (row && !err) {
                                helpers.sendEmail({
                                    to: row.email,
                                    subject: 'Payment Successful - Order Confirmation',
                                    html: `<h1>Payment Successful!</h1><p>Product: ${row.productName}</p><p>Amount: ₹${row.price}</p><p>Your order will be activated within 10 minutes.</p>`
                                });
                            }
                        });
                    }
                });
            } else if (event.event === 'payment.failed') {
                // Handle failed payments
                runDb('UPDATE orders SET status = "failed", updatedAt = CURRENT_TIMESTAMP WHERE razorpayOrderId = ?', [razorpayOrderId], function(err) {
                    if (err) console.error('Webhook failed payment update error:', err);
                    else if (this.changes > 0) {
                        console.log(`Payment failed for order ${razorpayOrderId}, set to failed`);
                        // Send failure email
                        db.get('SELECT u.email, o.productName FROM users u JOIN orders o ON o.userId = u.id WHERE o.razorpayOrderId = ?', [razorpayOrderId], (err, row) => {
                            if (row && !err) {
                                helpers.sendEmail({
                                    to: row.email,
                                    subject: 'Payment Failed - Order Issue',
                                    html: `<h1>Payment Failed!</h1><p>Product: ${row.productName}</p><p>Please retry the payment or contact support.</p>`
                                });
                            }
                        });
                    }
                });
            }
            res.sendStatus(200);
        } else {
            console.log('Webhook: Invalid signature');
            res.status(400).send('Invalid signature');
        }
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(500).send('Internal error');
    }
});

// Verify payment (client-side fallback)
app.post('/verify-razorpay-payment', requireAuth, async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        req.flash('error', 'Invalid payment details');
        return res.redirect(`/orders/${orderId}`);
    }
    try {
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                                       .update(`${razorpay_order_id}|${razorpay_payment_id}`)
                                       .digest('hex');
        if (expectedSignature === razorpay_signature) {
            // Set to paid and paymentTime
            await runDb('UPDATE orders SET razorpayOrderId = ?, razorpayPaymentId = ?, status = "paid", paymentTime = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
                        [razorpay_order_id, razorpay_payment_id, orderId]);
            req.flash('success', 'Payment verified successfully. Order will activate in 5-10 minutes.');
            res.redirect(`/orders/${orderId}`);
        } else {
            req.flash('error', 'Payment verification failed');
            res.redirect(`/orders/${orderId}`);
        }
    } catch (err) {
        console.error('Payment verify error:', err);
        req.flash('error', 'Verification failed');
        res.redirect(`/orders/${orderId}`);
    }
});

// Retry payment for pending orders
app.post('/retry-payment/:orderId', requireAuth, async (req, res) => {
    const orderId = req.params.orderId;
    const userId = req.session.user.id;
    console.log('Retry hit for order:', orderId, 'by user:', userId); // Debug log
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = ? AND userId = ? AND status = "pending"', [orderId, userId]);
        console.log('Found order for retry:', order ? 'Yes' : 'No'); // Debug
        if (!order) {
            console.log('Order not pending or not found'); // Debug
            req.flash('error', 'Order not found or not pending');
            return res.redirect('/orders');
        }
        // Create new Razorpay order for retry
        const options = {
            amount: Math.round(order.price * 100),
            currency: 'INR',
            receipt: orderId + '-retry',
            notes: { userId, originalOrder: orderId }
        };
        console.log('Creating Razorpay order with amount:', options.amount); // Debug
        const rzOrder = await razorpay.orders.create(options);
        console.log('Razorpay order created:', rzOrder.id); // Debug
        // Update order with new Razorpay order ID
        await runDb('UPDATE orders SET razorpayOrderId = ? WHERE id = ?', [rzOrder.id, orderId]);
        req.flash('success', 'Retry payment initiated');
        res.render('users/razorpay-payment', {
            title: 'Retry Payment with Razorpay',
            order: { id: orderId, amount: order.price },
            key: process.env.RAZORPAY_KEY_ID,
            isRetry: true
        });
    } catch (err) {
        console.error('Retry payment error:', err.message); // Enhanced log
        req.flash('error', 'Failed to initiate retry: ' + err.message);
        res.redirect('/orders');
    }
});

app.post('/orders', requireAuth, async (req, res) => {
    const { productId, billingCycle, couponCode } = req.body;
    const userId = req.session.user.id;
    const validCycles = ['monthly', 'quarterly', 'yearly'];
    if (!validCycles.includes(billingCycle)) {
        req.flash('error', 'Invalid billing cycle');
        return res.redirect(`/products/${productId}`);
    }
    try {
        const product = await getProduct(productId);
        if (!product) {
            req.flash('error', 'Product not found');
            return res.redirect('/products');
        }
        let originalPrice;
        switch (billingCycle) {
            case 'monthly': originalPrice = product.priceMonthly; break;
            case 'quarterly': originalPrice = product.priceQuarterly; break;
            case 'yearly': originalPrice = product.priceYearly; break;
            default: originalPrice = 0;
        }
        if (originalPrice <= 0) {
            req.flash('error', 'Invalid product price');
            return res.redirect(`/products/${productId}`);
        }
        let discount = 0;
        let couponError = null;
        if (couponCode) {
            const code = couponCode.toUpperCase().trim();
            if (code) {
                const coupon = await dbGet(
                    'SELECT * FROM coupons WHERE code = ? AND isActive = 1 AND (expiresAt IS NULL OR expiresAt > datetime("now")) AND (maxUses IS NULL OR uses < maxUses)',
                    [code]
                );
                if (coupon) {
                    let discVal = coupon.couponType === 'percent'
                        ? originalPrice * (Math.min(100, coupon.value) / 100)
                        : coupon.value;
                    discount = Math.min(Math.round(discVal), originalPrice);
                    await runDb('UPDATE coupons SET uses = uses + 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [coupon.id]);
                } else {
                    couponError = 'Invalid or expired coupon';
                }
            }
        }
        if (couponError) {
            req.flash('error', couponError);
            return res.redirect(`/products/${productId}?cycle=${billingCycle}&coupon=${couponCode}`);
        }
        const totalPrice = originalPrice - discount;
        const orderId = uuidv4();
        const status = 'pending';
        await runDb(
            `INSERT INTO orders (id, userId, productId, productName, productCategory, billingCycle, originalPrice, discount, price, paymentMethod, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'razorpay', ?)`,
            [orderId, userId, productId, product.name, product.category, billingCycle, originalPrice, discount, totalPrice, status]
        );
        const emailHtml = `
            <h1>Order #${orderId} - Payment Pending</h1>
            <p>Product: ${product.name}</p>
            <p>Billing Cycle: ${billingCycle}</p>
            <p>Original Price: ₹${originalPrice}</p>
            ${discount > 0 ? `<p>Discount: ₹${discount}</p>` : ''}
            <p>Total: ₹${totalPrice}</p>
            <p>Payment Method: Razorpay</p>
            <p>Status: Pending - Complete payment within 24 hours or order will be cancelled.</p>
        `;
        helpers.sendEmail({ to: req.session.user.email, subject: 'Order Placed - Payment Pending', html: emailHtml });
        // Render Razorpay payment page
        res.render('users/razorpay-payment', {
            title: 'Pay with Razorpay',
            order: { id: orderId, amount: totalPrice },
            key: process.env.RAZORPAY_KEY_ID,
            activePage: 'payment',
            isRetry: false
        });
    } catch (err) {
        console.error('Order creation error:', err);
        req.flash('error', 'Order creation failed');
        res.redirect(`/products/${productId}`);
    }
});

app.get('/orders/:id/invoice', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = ? AND userId = ?', [req.params.id, userId]);
        if (!order || order.status !== 'active') {
            req.flash('error', 'Invoice available only for active orders');
            return res.redirect('/orders');
        }
        const product = await getProduct(order.productId);
        res.render('users/invoice', {
            title: 'Invoice',
            order,
            product,
            print: true,
            originalPrice: order.originalPrice,
            activePage: 'orders',
            isLoggedIn: !!req.session.user
        });
    } catch (err) {
        console.error('Invoice error:', err);
        req.flash('error', 'Error generating invoice');
        res.redirect('/orders');
    }
});

app.get('/orders', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    try {
        const orders = await dbAll('SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?', [userId, perPage, (page - 1) * perPage]);
        const countRow = await dbGet('SELECT COUNT(*) as total FROM orders WHERE userId = ?', [userId]);
        const pag = helpers.paginate(countRow ? countRow.total : 0, page, perPage);
        pag.data = orders;
        res.render('users/orders', {
            title: 'Orders',
            activePage: 'orders',
            orders: pag.data,
            pagination: pag,
            isLoggedIn: !!req.session.user
        });
    } catch (err) {
        console.error('Orders error:', err);
        req.flash('error', 'Error loading orders');
        res.redirect('/orders');
    }
});

app.get('/orders/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = ? AND userId = ?', [req.params.id, userId]);
        if (!order) {
            req.flash('error', 'Order not found');
            return res.redirect('/orders');
        }
        const product = await getProduct(order.productId);
        const canRetry = order.status === 'pending';
        res.render('users/order-detail', {
            title: 'Order Details',
            order,
            product,
            originalPrice: order.originalPrice,
            canRetry,
            activePage: 'orders',
            isLoggedIn: !!req.session.user
        });
    } catch (err) {
        console.error('Order detail error:', err);
        req.flash('error', 'Error loading order');
        res.redirect('/orders');
    }
});

// ======================
// PROFILE
// ======================
app.get('/profile', requireAuth, (req, res) => res.render('users/profile', { title: 'Profile', activePage: 'profile' }));

app.post('/profile', requireAuth, async (req, res) => {
    const { firstName, lastName, phone, address, city, state, postalCode } = req.body;
    const userId = req.session.user.id;
    if (!firstName || !lastName || !helpers.validatePhone(phone || '')) {
        req.flash('error', 'Invalid name or phone');
        return res.redirect('/profile');
    }
    try {
        await runDb(`UPDATE users SET firstName = ?, lastName = ?, phone = ?, address = ?, city = ?, state = ?, postalCode = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            [helpers.sanitize(firstName), helpers.sanitize(lastName), phone, helpers.sanitize(address || null), helpers.sanitize(city || null), helpers.sanitize(state || null), postalCode || null, userId]);
        req.session.user.firstName = firstName;
        req.session.user.lastName = lastName;
        req.flash('success', 'Profile updated successfully');
        res.redirect('/profile');
    } catch (err) {
        console.error('Profile update error:', err);
        req.flash('error', 'Update failed');
        res.redirect('/profile');
    }
});

app.get('/profile/security', requireAuth, (req, res) => res.render('users/security', { title: 'Security', activePage: 'security' }));

app.post('/profile/security', requireAuth, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.session.user.id;
    if (!helpers.validatePassword(newPassword) || newPassword !== confirmPassword) {
        req.flash('error', 'New passwords do not match or too short');
        return res.redirect('/profile/security');
    }
    try {
        const user = await dbGet('SELECT password FROM users WHERE id = ?', [userId]);
        if (!helpers.comparePassword(currentPassword, user.password)) {
            req.flash('error', 'Current password incorrect');
            return res.redirect('/profile/security');
        }
        const hashed = helpers.hashPassword(newPassword);
        await runDb('UPDATE users SET password = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [hashed, userId]);
        helpers.sendEmail({ to: req.session.user.email, subject: 'Password Changed', html: '<p>Your password has been updated successfully.</p>' });
        req.flash('success', 'Password updated successfully');
        res.redirect('/profile/security');
    } catch (err) {
        console.error('Password update error:', err);
        req.flash('error', 'Password update failed');
        res.redirect('/profile/security');
    }
});

// ======================
// TICKET ROUTES USER
// ======================
app.get('/tickets', requireAuth, async (req, res) => {
    const filters = {
        status: req.query.status || 'all',
        department: req.query.department || 'all',
        priority: req.query.priority || 'all',
        search: helpers.sanitize(req.query.search || ''),
        tag: helpers.sanitize(req.query.tag || '')
    };

    // ---------------------------
    // ADD THIS FUNCTION HERE
    // ---------------------------
    function getDepartmentIcon(dept) {
        if (!dept) return "question-circle";

        const icons = {
            billing: "wallet",
            technical: "tools",
            support: "life-ring",
            sales: "shopping-cart",
            general: "comments",
            other: "tag"
        };

        return icons[dept.toLowerCase()] || "question-circle";
    }
    // ---------------------------

    try {
        const pag = await ticketHelpers.getUserTickets(
            req.session.user.id,
            parseInt(req.query.page) || 1,
            10,
            filters
        );

        const unreadRow = await dbGet(
            'SELECT COUNT(*) as count FROM tickets WHERE userId = ? AND isReadUser = 0',
            [req.session.user.id]
        );

        const unread = unreadRow ? unreadRow.count : 0;

        res.render('users/tickets', {
            title: 'Support Tickets',
            activePage: 'tickets',
            tickets: pag.data,
            filters,
            unreadCount: unread,
            TICKET_CONFIG,
            pagination: pag,

            // ⬇️ Pass function to EJS
            getDepartmentIcon
        });

    } catch (err) {
        console.error('Tickets error:', err);
        req.flash('error', 'Error loading tickets');
        res.redirect('/tickets');
    }
});

app.get('/tickets/new', requireAuth, (req, res) => res.render('users/ticket-new', { title: 'New Ticket', activePage: 'tickets', TICKET_CONFIG, formData: req.flash('formData')[0] || {}, errors: req.flash('error') }));

app.post('/tickets', requireAuth, ticketUpload.array('attachments', TICKET_CONFIG.MAX_ATTACHMENTS), async (req, res) => {
    const { subject, message, department, priority, tags } = req.body;
    const errors = [];
    if (!subject || subject.length < 2) errors.push('Subject must be at least 2 characters');
    if (!message || message.length < 2) errors.push('Message must be at least 2 characters');
    if (!TICKET_CONFIG.DEPARTMENTS.includes(department)) errors.push('Invalid department');
    if (!TICKET_CONFIG.PRIORITIES.includes(priority)) errors.push('Invalid priority');
    if (req.files && req.files.length > TICKET_CONFIG.MAX_ATTACHMENTS) errors.push(`Maximum ${TICKET_CONFIG.MAX_ATTACHMENTS} attachments allowed`);
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        req.flash('formData', req.body);
        return res.redirect('/tickets/new');
    }
    const attachments = req.files ? req.files.map(f => ({ name: f.originalname, path: `/uploads/tickets/${f.filename}`, size: f.size, type: f.mimetype })) : [];
    const tagArray = tags ? tags.split(',').map(t => helpers.sanitize(t.trim())).filter(t => TICKET_CONFIG.TAGS.includes(t)) : [];
    try {
        const ticket = await ticketHelpers.createTicket(req.session.user.id, helpers.sanitize(subject.trim()), helpers.sanitize(message.trim()), department, priority, attachments, tagArray);
        if (!ticket) {
            req.flash('error', 'Failed to create ticket');
            return res.redirect('/tickets/new');
        }
        helpers.sendEmail({
            to: req.session.user.email,
            subject: `Ticket Created: ${ticket.id}`,
            html: `<p>Your ticket ${ticket.id} has been created successfully.</p><p>You will receive updates via email.</p>`
        });
        req.flash('success', `Ticket ${ticket.id} created successfully`);
        res.redirect(`/tickets/${ticket.id}`);
    } catch (err) {
        console.error('Create ticket error:', err);
        req.flash('error', 'Failed to create ticket');
        res.redirect('/tickets/new');
    }
});

app.get('/tickets/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const ticket = await dbGet('SELECT * FROM tickets WHERE id = ? AND userId = ?', [req.params.id, userId]);
        if (!ticket) {
            req.flash('error', 'Ticket not found');
            return res.redirect('/tickets');
        }
        await runDb('UPDATE tickets SET isReadUser = 1 WHERE id = ?', [req.params.id]);
        ticket.tags = ticket.tags ? ticket.tags.split(',') : [];
        const replies = await dbAll(
            `SELECT tr.*, u.firstName, u.lastName, u.isAdmin
             FROM ticket_replies tr
             LEFT JOIN users u ON tr.userId = u.id
             WHERE ticketId = ? AND isNote = 0
             ORDER BY createdAt ASC`, [req.params.id]
        );
        replies.forEach(r => {
            try {
                r.attachments = JSON.parse(r.attachments || '[]');
            } catch (e) {
                r.attachments = [];
            }
        });
        res.render('users/ticket-view', {
            title: `Ticket #${ticket.id}: ${ticket.subject}`,
            activePage: 'tickets',
            ticket,
            replies,
            TICKET_CONFIG,
            slaStatus: ticketHelpers.getSLAStatus(ticket)
        });
    } catch (err) {
        console.error('Ticket view error:', err);
        req.flash('error', 'Error loading ticket');
        res.redirect('/tickets');
    }
});

app.post('/tickets/:id/reply', requireAuth, ticketUpload.array('attachments', TICKET_CONFIG.MAX_ATTACHMENTS), async (req, res) => {
    const { message } = req.body;
    if (!message || message.length < 5) {
        req.flash('error', 'Reply must be at least 5 characters');
        return res.redirect(`/tickets/${req.params.id}`);
    }
    if (req.files && req.files.length > TICKET_CONFIG.MAX_ATTACHMENTS) {
        req.flash('error', `Maximum ${TICKET_CONFIG.MAX_ATTACHMENTS} attachments allowed`);
        return res.redirect(`/tickets/${req.params.id}`);
    }
    const attachments = req.files ? req.files.map(f => ({ name: f.originalname, path: `/uploads/tickets/${f.filename}`, size: f.size, type: f.mimetype })) : [];
    try {
        await ticketHelpers.addReply(req.params.id, req.session.user.id, helpers.sanitize(message.trim()), attachments);
        req.flash('success', 'Reply added successfully');
        res.redirect(`/tickets/${req.params.id}`);
    } catch (err) {
        console.error('Add reply error:', err);
        req.flash('error', 'Failed to add reply');
        res.redirect(`/tickets/${req.params.id}`);
    }
});

app.post('/tickets/:id/close', requireAuth, async (req, res) => {
    const success = await ticketHelpers.updateTicketStatus(req.params.id, 'closed', req.session.user.id);
    if (success) {
        helpers.sendEmail({
            to: req.session.user.email,
            subject: 'Ticket Closed',
            html: '<p>You have closed this ticket. If you need further assistance, please open a new one.</p>'
        });
        req.flash('success', 'Ticket closed successfully');
    } else {
        req.flash('error', 'Failed to close ticket');
    }
    res.redirect(`/tickets/${req.params.id}`);
});

// ======================
// ADMIN ROUTES
// ======================
app.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/dashboard'));

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
        const orders = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC LIMIT 5');
        const users = await dbAll('SELECT * FROM users ORDER BY createdAt DESC LIMIT 5');
        const statsRow = await dbGet('SELECT COUNT(*) as totalUsers FROM users');
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const rev = await dbGet('SELECT SUM(price) as revenue FROM orders WHERE createdAt >= ? AND status = "active"', [monthStart]);
        const totalProducts = await helpers.countRows('products', 'WHERE isActive = 1');
        const openTickets = await helpers.countRows('tickets', 'WHERE status IN ("open", "in_progress")');
        const totalVisits = await helpers.countRows('visits');
        const uniqueVisitors = await dbGet('SELECT COUNT(DISTINCT ip) as count FROM visits');
        // Reviews stats
        const totalReviews = await helpers.countRows('reviews');
        const approvedReviews = await helpers.countRows('reviews', 'WHERE isApproved = 1');
        res.render('admin/dashboard', {
            title: 'Admin Dashboard',
            activePage: 'dashboard',
            user: req.session.user,
            stats: { ...statsRow, totalProducts, openTickets, totalVisits, uniqueVisitors: uniqueVisitors ? uniqueVisitors.count : 0, totalReviews, approvedReviews },
            recentOrders: orders,
            recentUsers: users,
            monthlyRevenue: rev ? rev.revenue : 0
        });
    } catch (err) {
        console.error('Admin dashboard error:', err);
        req.flash('error', 'Error loading dashboard');
        res.redirect('/admin/dashboard');
    }
});

// Enhanced Admin Analytics Routes
app.get('/admin/analytics', requireAdmin, async (req, res) => {
    try {
        const dateFrom = req.query.dateFrom || moment().subtract(30, 'days').format('YYYY-MM-DD');
        const dateTo = req.query.dateTo || moment().format('YYYY-MM-DD');

        // Total visits and unique visitors
        const totalVisits = await helpers.countRows(
            'visits',
            'WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?',
            [dateFrom, dateTo]
        );

        const uniqueVisitors = await dbGet(
            'SELECT COUNT(DISTINCT ip) as count FROM visits WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?',
            [dateFrom, dateTo]
        );

        // Top pages
        const topPages = await dbAll(
            'SELECT page, COUNT(*) as count FROM visits WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ? GROUP BY page ORDER BY count DESC LIMIT 10',
            [dateFrom, dateTo]
        );

        // Countries
        const countries = await dbAll(
            'SELECT country, COUNT(*) as count FROM visits WHERE country != "Unknown" AND is_bot = 0 AND date(timestamp) BETWEEN ? AND ? GROUP BY country ORDER BY count DESC LIMIT 10',
            [dateFrom, dateTo]
        );

        // Recent visits
        const recentVisits = await dbAll(
            'SELECT ip, country, page, user_agent, timestamp FROM visits WHERE is_bot = 0 ORDER BY timestamp DESC LIMIT 50'
        );

        // Today's stats
        const today = moment().format('YYYY-MM-DD');

        const visitsToday = await helpers.countRows(
            'visits',
            'WHERE date(timestamp) = ? AND is_bot = 0',
            [today]
        );

        const visitsYesterday = await helpers.countRows(
            'visits',
            'WHERE date(timestamp) = ? AND is_bot = 0',
            [moment().subtract(1, 'day').format('YYYY-MM-DD')]
        );

        const uniqueToday = await dbGet(
            'SELECT COUNT(DISTINCT ip) as count FROM visits WHERE date(timestamp) = ? AND is_bot = 0',
            [today]
        );

        // Traffic trends (last 7 days)
        const trafficTrends = await dbAll(
            `
            SELECT date(timestamp) as date, COUNT(*) as visits, COUNT(DISTINCT ip) as unique_visits
            FROM visits
            WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?
            GROUP BY date(timestamp)
            ORDER BY date(timestamp) DESC
            LIMIT 7
        `,
            [moment().subtract(7, 'days').format('YYYY-MM-DD'), today]
        );

        // ⬇️ FIX: PASS dateFrom AND dateTo TO THE VIEW
        res.render('admin/analytics', {
            title: 'Analytics',
            activePage: 'analytics',
            totalVisits,
            uniqueVisitors: uniqueVisitors ? uniqueVisitors.count : 0,
            topPages,
            countries,
            recentVisits,
            visitsToday,
            visitsYesterday,
            uniqueToday: uniqueToday ? uniqueToday.count : 0,
            trafficTrends,
            moment,
            dateFrom,  // ⬅️ FIX ADDED
            dateTo     // ⬅️ FIX ADDED
        });

    } catch (err) {
        console.error('Analytics error:', err);
        req.flash('error', 'Error loading analytics');
        res.redirect('/admin/dashboard');
    }
});

// API endpoint for chart data
app.get('/admin/analytics/data', requireAdmin, async (req, res) => {
    try {
        const dateFrom = req.query.dateFrom || moment().subtract(30, 'days').format('YYYY-MM-DD');
        const dateTo = req.query.dateTo || moment().format('YYYY-MM-DD');
        const groupBy = req.query.groupBy || 'day';
        let groupFormat;
        switch (groupBy) {
            case 'week':
                groupFormat = "strftime('%Y-%W', timestamp)";
                break;
            case 'month':
                groupFormat = "strftime('%Y-%m', timestamp)";
                break;
            default:
                groupFormat = "date(timestamp)";
        }
        const trafficData = await dbAll(`
            SELECT ${groupFormat} as period,
                   COUNT(*) as visits,
                   COUNT(DISTINCT ip) as unique_visits
            FROM visits
            WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?
            GROUP BY ${groupFormat}
            ORDER BY period
        `, [dateFrom, dateTo]);
        // Browser statistics
        const browserStats = await dbAll(`
            SELECT
                CASE
                    WHEN user_agent LIKE '%Chrome%' THEN 'Chrome'
                    WHEN user_agent LIKE '%Firefox%' THEN 'Firefox'
                    WHEN user_agent LIKE '%Safari%' THEN 'Safari'
                    WHEN user_agent LIKE '%Edge%' THEN 'Edge'
                    ELSE 'Other'
                END as browser,
                COUNT(*) as count
            FROM visits
            WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?
            GROUP BY browser
        `, [dateFrom, dateTo]);
        // Peak hours
        const peakHours = await dbAll(`
            SELECT strftime('%H:00', timestamp) as hour, COUNT(*) as count
            FROM visits
            WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?
            GROUP BY strftime('%H', timestamp)
            ORDER BY hour
        `, [dateFrom, dateTo]);
        res.json({
            success: true,
            data: {
                traffic: trafficData,
                browsers: browserStats,
                peakHours: peakHours
            }
        });
    } catch (err) {
        console.error('Analytics data error:', err);
        res.status(500).json({ success: false, error: 'Failed to load analytics data' });
    }
});

// Export analytics data
app.get('/admin/analytics/export', requireAdmin, async (req, res) => {
    try {
        const dateFrom = req.query.dateFrom || moment().subtract(30, 'days').format('YYYY-MM-DD');
        const dateTo = req.query.dateTo || moment().format('YYYY-MM-DD');
        const analyticsData = await dbAll(`
            SELECT
                date(timestamp) as date,
                COUNT(*) as total_visits,
                COUNT(DISTINCT ip) as unique_visitors,
                GROUP_CONCAT(DISTINCT country) as countries,
                COUNT(DISTINCT page) as unique_pages
            FROM visits
            WHERE is_bot = 0 AND date(timestamp) BETWEEN ? AND ?
            GROUP BY date(timestamp)
            ORDER BY date(timestamp)
        `, [dateFrom, dateTo]);
        // Convert to CSV
        const headers = ['Date', 'Total Visits', 'Unique Visitors', 'Countries', 'Unique Pages'];
        const csvData = [
            headers.join(','),
            ...analyticsData.map(row => [
                row.date,
                row.total_visits,
                row.unique_visitors,
                `"${row.countries}"`,
                row.unique_pages
            ].join(','))
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=analytics-${dateFrom}-to-${dateTo}.csv`);
        res.send(csvData);
    } catch (err) {
        console.error('Export error:', err);
        req.flash('error', 'Failed to export analytics data');
        res.redirect('/admin/analytics');
    }
});

// Live updates endpoint
app.get('/admin/analytics/live', requireAdmin, async (req, res) => {
    try {
        const recentVisits = await dbAll(
            'SELECT ip, country, page, user_agent, timestamp FROM visits WHERE is_bot = 0 ORDER BY timestamp DESC LIMIT 10'
        );
        res.json({
            success: true,
            recentVisits
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to load live data' });
    }
});

// Admin Orders
app.get('/admin/orders', requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    const status = req.query.status || 'all';
    let sql = 'SELECT * FROM orders';
    let params = [];
    let whereClause = '';
    if (status !== 'all') {
        whereClause = ' WHERE status = ?';
        params.push(status);
    }
    sql += whereClause + ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    params.push(perPage, (page - 1) * perPage);
    try {
        const orders = await dbAll(sql, params);
        let countSql = 'SELECT COUNT(*) as total FROM orders';
        let countParams = [];
        if (status !== 'all') {
            countSql += ' WHERE status = ?';
            countParams.push(status);
        }
        const countRow = await dbGet(countSql, countParams);
        const pag = helpers.paginate(countRow ? countRow.total : 0, page, perPage);
        pag.data = orders;
        res.render('admin/orders', { title: 'Orders', activePage: 'orders', orders: pag.data, currentStatus: status, pagination: pag });
    } catch (err) {
        console.error('Admin orders error:', err);
        req.flash('error', 'Error loading orders');
        res.redirect('/admin/orders');
    }
});

app.get('/admin/orders/:id', requireAdmin, async (req, res) => {
    try {
        const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (!order) {
            req.flash('error', 'Order not found');
            return res.redirect('/admin/orders');
        }
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [order.userId]);
        const product = await getProduct(order.productId);
        const originalPrice = order.originalPrice || (order.price + order.discount);
        res.render('admin/order-detail', {
            title: 'Order Detail',
            order,
            user: user || null,
            product: product || null,
            originalPrice,
            activePage: 'orders'
        });
    } catch (err) {
        console.error('Admin order detail error:', err);
        req.flash('error', 'Error loading order');
        res.redirect('/admin/orders');
    }
});

app.post('/admin/orders/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['pending', 'paid', 'active', 'suspended', 'cancelled', 'completed', 'failed'];
    if (!validStatuses.includes(status)) {
        req.flash('error', 'Invalid status');
        return res.redirect(`/admin/orders/${req.params.id}`);
    }
    try {
        const result = await runDb('UPDATE orders SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id]);
        if (result.changes === 0) {
            req.flash('error', 'Order not found');
            return res.redirect('/admin/orders');
        }
        const orderUser = await dbGet('SELECT userId FROM orders WHERE id = ?', [req.params.id]);
        if (orderUser) {
            const user = await dbGet('SELECT email FROM users WHERE id = ?', [orderUser.userId]);
            if (user) {
                helpers.sendEmail({ to: user.email, subject: `Order Status Updated: ${status}`, html: `<p>Your order status has been updated to ${status}.</p>` });
            }
        }
        req.flash('success', 'Order status updated');
        res.redirect(`/admin/orders/${req.params.id}`);
    } catch (err) {
        console.error('Order status update error:', err);
        req.flash('error', 'Update failed');
        res.redirect(`/admin/orders/${req.params.id}`);
    }
});

// Admin Order Delete
app.post('/admin/orders/:id/delete', requireAdmin, async (req, res) => {
    try {
        const order = await dbGet('SELECT status FROM orders WHERE id = ?', [req.params.id]);
        if (!order) {
            req.flash('error', 'Order not found');
            return res.redirect('/admin/orders');
        }
        if (order.status === 'active') {
            req.flash('error', 'Cannot delete active orders');
            return res.redirect(`/admin/orders/${req.params.id}`);
        }
        await runDb('DELETE FROM orders WHERE id = ?', [req.params.id]);
        req.flash('success', 'Order deleted successfully');
        res.redirect('/admin/orders');
    } catch (err) {
        console.error('Order delete error:', err);
        req.flash('error', 'Delete failed: ' + err.message);
        res.redirect('/admin/orders');
    }
});

// Admin Products
app.get('/admin/products', requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    const categoryFilter = req.query.category || null;
    try {
        let where = '';
        let params = [];
        if (categoryFilter) {
            const catId = await getCategoryBySlug(categoryFilter);
            if (catId) {
                where = ' WHERE p.categoryId = ?';
                params.push(catId);
            }
        }
        const offset = (page - 1) * perPage;
        const sql = `SELECT p.*, c.name as categoryName
                     FROM products p
                     LEFT JOIN categories c ON p.categoryId = c.id
                     ${where}
                     ORDER BY p.createdAt DESC LIMIT ? OFFSET ?`;
        params.push(perPage, offset);
        const rawProducts = await dbAll(sql, params);
        const products = await processProducts(rawProducts);
        let countSql = 'SELECT COUNT(*) as total FROM products p';
        let countParams = [];
        if (categoryFilter) {
            const catId = await getCategoryBySlug(categoryFilter);
            if (catId) {
                countSql += ' WHERE p.categoryId = ?';
                countParams.push(catId);
            }
        }
        const countRow = await dbGet(countSql, countParams);
        const pag = helpers.paginate(countRow ? countRow.total : 0, page, perPage);
        pag.data = products;
        const categories = await helpers.getCategories();
        let currentCategoryName = 'All';
        if (categoryFilter) {
            const currentCat = categories.find(cat => cat.slug === categoryFilter);
            currentCategoryName = currentCat ? currentCat.name : categoryFilter;
        }
        res.render('admin/products', {
            title: 'Products',
            activePage: 'products',
            products: pag.data,
            categories,
            currentCategory: categoryFilter,
            currentCategoryName: currentCategoryName,
            pagination: pag
        });
    } catch (err) {
        console.error('Admin products error:', err);
        req.flash('error', 'Error loading products');
        res.redirect('/admin/products');
    }
});

app.get('/admin/products/new', requireAdmin, async (req, res) => {
    try {
        const categories = await helpers.getCategories();
        res.render('admin/product-new', {
            title: 'New Product',
            product: {},
            categories,
            activePage: 'products'
        });
    } catch (err) {
        console.error('New product error:', err);
        req.flash('error', 'Failed to load the product creation page');
        res.redirect('/admin/products');
    }
});

app.post('/admin/products', requireAdmin, upload.single('image'), async (req, res) => {
    const { name, description, category, cpu, ram, disk, bandwidth, priceMonthly, priceQuarterly, priceYearly, locations, features, isActive } = req.body;
    const categorySlug = helpers.sanitize(category);
    const categoryId = await getCategoryBySlug(categorySlug);
    const errors = [];
    if (!name || !description || !categoryId || !cpu || !ram || !disk) errors.push('Required fields missing');
    if (parseFloat(priceMonthly) < 0 || parseFloat(priceQuarterly) < 0 || parseFloat(priceYearly) < 0) errors.push('Prices cannot be negative');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        const categories = await helpers.getCategories();
        return res.render('admin/product-new', { title: 'New Product', product: req.body, categories, errors, activePage: 'products' });
    }
    const productId = uuidv4();
    const specsObj = {
        cpu: helpers.sanitize(cpu.trim()),
        ram: helpers.formatBytes(parseInt(ram) * 1024 ** 3),
        disk: helpers.formatBytes(parseInt(disk) * 1024 ** 3),
        bandwidth: bandwidth ? helpers.formatBytes(parseInt(bandwidth) * 1024 ** 3) : 'Unlimited',
        locations: locations ? locations.split(',').map(l => helpers.sanitize(l.trim())).filter(l => l) : ['Global']
    };
    const featArray = features ? features.split(',').map(f => helpers.sanitize(f.trim())).filter(f => f) : [];
    const image = req.file ? `/uploads/${req.file.filename}` : '/images/default-product.png';
    try {
        await runDb(`INSERT INTO products (id, name, description, categoryId, specs, features, priceMonthly, priceQuarterly, priceYearly, image, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [productId, helpers.sanitize(name.trim()), helpers.sanitize(description.trim()), categoryId, JSON.stringify(specsObj), JSON.stringify(featArray), parseFloat(priceMonthly) || 0, parseFloat(priceQuarterly) || 0, parseFloat(priceYearly) || 0, image, isActive === 'on']);
        req.flash('success', 'Product added successfully');
        res.redirect('/admin/products');
    } catch (err) {
        console.error('Product insert error:', err);
        req.flash('error', 'Failed to add product');
        const categories = await helpers.getCategories();
        res.render('admin/product-new', { title: 'New Product', product: req.body, categories, activePage: 'products' });
    }
});

app.get('/admin/products/:id/edit', requireAdmin, async (req, res) => {
    try {
        const product = await getProduct(req.params.id);
        if (!product) {
            req.flash('error', 'Product not found');
            return res.redirect('/admin/products');
        }
        const categories = await helpers.getCategories();
        res.render('admin/product-edit', {
            title: 'Edit Product',
            product,
            categories,
            activePage: 'products'
        });
    } catch (err) {
        console.error('Edit product error:', err);
        req.flash('error', 'Error loading product');
        res.redirect('/admin/products');
    }
});

app.post('/admin/products/:id', requireAdmin, upload.single('image'), async (req, res) => {
    const { name, description, category, cpu, ram, disk, bandwidth, priceMonthly, priceQuarterly, priceYearly, locations, features, isActive, removeImage } = req.body;
    const categorySlug = helpers.sanitize(category);
    const categoryId = await getCategoryBySlug(categorySlug);
    const errors = [];
    if (!name || !description || !categoryId || !cpu || !ram || !disk) errors.push('Required fields missing');
    if (parseFloat(priceMonthly) < 0 || parseFloat(priceQuarterly) < 0 || parseFloat(priceYearly) < 0) errors.push('Prices cannot be negative');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        const categories = await helpers.getCategories();
        return res.render('admin/product-edit', { title: 'Edit Product', product: { ...req.body, id: req.params.id }, categories, errors, activePage: 'products' });
    }
    const specsObj = {
        cpu: helpers.sanitize(cpu.trim()),
        ram: helpers.formatBytes(parseInt(ram) * 1024 ** 3),
        disk: helpers.formatBytes(parseInt(disk) * 1024 ** 3),
        bandwidth: bandwidth ? helpers.formatBytes(parseInt(bandwidth) * 1024 ** 3) : 'Unlimited',
        locations: locations ? locations.split(',').map(l => helpers.sanitize(l.trim())).filter(l => l) : ['Global']
    };
    const featArray = features ? features.split(',').map(f => helpers.sanitize(f.trim())).filter(f => f) : [];
    let image = '/images/default-product.png';
    try {
        const oldProduct = await dbGet('SELECT image FROM products WHERE id = ?', [req.params.id]);
        if (removeImage === 'on' && oldProduct && oldProduct.image) {
            helpers.deleteFile(oldProduct.image);
            image = '/images/default-product.png';
        }
        if (req.file) {
            if (oldProduct && oldProduct.image && oldProduct.image !== '/images/default-product.png') helpers.deleteFile(oldProduct.image);
            image = `/uploads/${req.file.filename}`;
        } else {
            image = oldProduct ? oldProduct.image : '/images/default-product.png';
        }
        await runDb(`UPDATE products SET name = ?, description = ?, categoryId = ?, specs = ?, features = ?, priceMonthly = ?, priceQuarterly = ?, priceYearly = ?, image = ?, isActive = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            [helpers.sanitize(name.trim()), helpers.sanitize(description.trim()), categoryId, JSON.stringify(specsObj), JSON.stringify(featArray), parseFloat(priceMonthly) || 0, parseFloat(priceQuarterly) || 0, parseFloat(priceYearly) || 0, image, isActive === 'on', req.params.id]);
        req.flash('success', 'Product updated successfully');
        res.redirect('/admin/products');
    } catch (err) {
        console.error('Product update error:', err);
        req.flash('error', 'Failed to update product');
        const categories = await helpers.getCategories();
        res.render('admin/product-edit', { title: 'Edit Product', product: { ...req.body, id: req.params.id }, categories, activePage: 'products' });
    }
});

app.post('/admin/products/:id/delete', requireAdmin, async (req, res) => {
    try {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM orders WHERE productId = ? AND status != "cancelled"', [req.params.id]);
        if (countRow.count > 0) {
            req.flash('error', 'Cannot delete product with active orders');
            return res.redirect('/admin/products');
        }
        const product = await dbGet('SELECT image FROM products WHERE id = ?', [req.params.id]);
        if (product && product.image && product.image !== '/images/default-product.png') helpers.deleteFile(product.image);
        await runDb('DELETE FROM products WHERE id = ?', [req.params.id]);
        req.flash('success', 'Product deleted successfully');
        res.redirect('/admin/products');
    } catch (err) {
        console.error('Product delete error:', err);
        req.flash('error', 'Delete failed: ' + err.message);
        res.redirect('/admin/products');
    }
});

// Admin Reviews Management
app.get('/admin/reviews', requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    const approvedFilter = req.query.approved || 'all';
    try {
        let where = '';
        let params = [];
        if (approvedFilter !== 'all') {
            where = ' WHERE isApproved = ?';
            params.push(approvedFilter === 'true');
        }
        const offset = (page - 1) * perPage;
        const sql = `SELECT r.*, p.name as productName, u.firstName, u.lastName
                     FROM reviews r
                     LEFT JOIN products p ON r.productId = p.id
                     LEFT JOIN users u ON r.userId = u.id
                     ${where}
                     ORDER BY r.createdAt DESC LIMIT ? OFFSET ?`;
        params.push(perPage, offset);
        const reviews = await dbAll(sql, params);
        const countSql = `SELECT COUNT(*) as total FROM reviews ${where}`;
        const countParams = approvedFilter !== 'all' ? [approvedFilter === 'true'] : [];
        const countRow = await dbGet(countSql, countParams);
        const pag = helpers.paginate(countRow ? countRow.total : 0, page, perPage);
        pag.data = reviews;
        res.render('admin/reviews', {
            title: 'Reviews',
            activePage: 'reviews',
            reviews: pag.data,
            currentFilter: approvedFilter,
            pagination: pag
        });
    } catch (err) {
        console.error('Admin reviews error:', err);
        req.flash('error', 'Error loading reviews');
        res.redirect('/admin/reviews');
    }
});

app.post('/admin/reviews/:id/approve', requireAdmin, async (req, res) => {
    try {
        await runDb('UPDATE reviews SET isApproved = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
        req.flash('success', 'Review approved');
        res.redirect('/admin/reviews');
    } catch (err) {
        console.error('Approve review error:', err);
        req.flash('error', 'Failed to approve review');
        res.redirect('/admin/reviews');
    }
});

app.post('/admin/reviews/:id/delete', requireAdmin, async (req, res) => {
    try {
        await runDb('DELETE FROM reviews WHERE id = ?', [req.params.id]);
        req.flash('success', 'Review deleted');
        res.redirect('/admin/reviews');
    } catch (err) {
        console.error('Delete review error:', err);
        req.flash('error', 'Failed to delete review');
        res.redirect('/admin/reviews');
    }
});

// Admin Categories
app.get('/admin/categories', requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    try {
        const offset = (page - 1) * perPage;
        const categories = await dbAll('SELECT * FROM categories ORDER BY createdAt DESC LIMIT ? OFFSET ?', [perPage, offset]);
        categories.forEach(c => { c.image = c.image || '/images/default-category.png'; });
        const count = await helpers.countRows('categories');
        const pag = helpers.paginate(count, page, perPage);
        pag.data = categories;
        res.render('admin/categories', { title: 'Categories', activePage: 'categories', categories: pag.data, pagination: pag });
    } catch (err) {
        console.error('Admin categories error:', err);
        req.flash('error', 'Error loading categories');
        res.redirect('/admin/categories');
    }
});

app.get('/admin/categories/new', requireAdmin, (req, res) => {
    res.render('admin/category-new', { title: 'New Category', category: {}, activePage: 'categories' });
});

app.post('/admin/categories', requireAdmin, categoryUpload.single('image'), async (req, res) => {
    const { name, description, isActive } = req.body;
    const errors = [];
    if (!name || name.trim().length < 2) errors.push('Name must be at least 2 characters');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        return res.render('admin/category-new', { title: 'New Category', category: req.body, errors, activePage: 'categories' });
    }
    const slug = helpers.sanitize(name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
    const catId = uuidv4();
    const image = req.file ? `/uploads/${req.file.filename}` : '/images/default-category.png';
    try {
        await runDb('INSERT INTO categories (id, name, slug, description, image, isActive) VALUES (?, ?, ?, ?, ?, ?)',
            [catId, helpers.sanitize(name.trim()), slug, helpers.sanitize(description || null), image, isActive === 'on']);
        req.flash('success', 'Category created successfully');
        res.redirect('/admin/categories');
    } catch (err) {
        console.error('Category insert error:', err);
        req.flash('error', 'Failed to create category');
        res.render('admin/category-new', { title: 'New Category', category: req.body, activePage: 'categories' });
    }
});

app.get('/admin/categories/:id/edit', requireAdmin, async (req, res) => {
    try {
        const category = await dbGet('SELECT * FROM categories WHERE id = ?', [req.params.id]);
        if (!category) {
            req.flash('error', 'Category not found');
            return res.redirect('/admin/categories');
        }
        category.image = category.image || '/images/default-category.png';
        res.render('admin/category-edit', { title: 'Edit Category', category, activePage: 'categories' });
    } catch (err) {
        console.error('Edit category error:', err);
        req.flash('error', 'Error loading category');
        res.redirect('/admin/categories');
    }
});

app.post('/admin/categories/:id', requireAdmin, categoryUpload.single('image'), async (req, res) => {
    const { name, description, isActive, removeImage } = req.body;
    const errors = [];
    if (!name || name.trim().length < 2) errors.push('Name must be at least 2 characters');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        return res.render('admin/category-edit', { title: 'Edit Category', category: { ...req.body, id: req.params.id }, errors, activePage: 'categories' });
    }
    const slug = helpers.sanitize(name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
    let image = '/images/default-category.png';
    try {
        const oldCategory = await dbGet('SELECT image FROM categories WHERE id = ?', [req.params.id]);
        if (removeImage === 'on' && oldCategory && oldCategory.image) {
            helpers.deleteFile(oldCategory.image);
            image = '/images/default-category.png';
        }
        if (req.file) {
            if (oldCategory && oldCategory.image && oldCategory.image !== '/images/default-category.png') helpers.deleteFile(oldCategory.image);
            image = `/uploads/${req.file.filename}`;
        } else {
            image = oldCategory ? oldCategory.image : '/images/default-category.png';
        }
        await runDb('UPDATE categories SET name = ?, slug = ?, description = ?, image = ?, isActive = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [helpers.sanitize(name.trim()), slug, helpers.sanitize(description || null), image, isActive === 'on', req.params.id]);
        req.flash('success', 'Category updated successfully');
        res.redirect('/admin/categories');
    } catch (err) {
        console.error('Category update error:', err);
        req.flash('error', 'Failed to update category');
        res.render('admin/category-edit', { title: 'Edit Category', category: { ...req.body, id: req.params.id }, activePage: 'categories' });
    }
});

app.post('/admin/categories/:id/delete', requireAdmin, async (req, res) => {
    try {
        const count = await helpers.countRows('products', 'WHERE categoryId = ?', [req.params.id]);
        if (count > 0) {
            req.flash('error', 'Cannot delete category with products');
            return res.redirect('/admin/categories');
        }
        const category = await dbGet('SELECT image FROM categories WHERE id = ?', [req.params.id]);
        if (category && category.image && category.image !== '/images/default-category.png') helpers.deleteFile(category.image);
        await runDb('DELETE FROM categories WHERE id = ?', [req.params.id]);
        req.flash('success', 'Category deleted successfully');
        res.redirect('/admin/categories');
    } catch (err) {
        console.error('Category delete error:', err);
        req.flash('error', 'Delete failed: ' + err.message);
        res.redirect('/admin/categories');
    }
});

// Admin Coupons
app.get('/admin/coupons', requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    const status = req.query.status || 'all';
    let sql = 'SELECT * FROM coupons';
    let whereClause = '';
    if (status !== 'all') {
        if (status === 'active') {
            whereClause = ' WHERE (expiresAt IS NULL OR expiresAt > datetime("now")) AND isActive = 1';
        } else if (status === 'expired') {
            whereClause = ' WHERE (expiresAt <= datetime("now") OR isActive = 0)';
        }
    }
    sql += whereClause + ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    const params = [perPage, (page - 1) * perPage];
    try {
        const coupons = await dbAll(sql, params);
        const countRow = await dbGet(`SELECT COUNT(*) as total FROM coupons ${whereClause}`);
        const pag = helpers.paginate(countRow ? countRow.total : 0, page, perPage);
        pag.data = coupons;
        res.render('admin/coupons', { title: 'Coupons', activePage: 'coupons', coupons: pag.data, currentStatus: status, pagination: pag });
    } catch (err) {
        console.error('Admin coupons error:', err);
        req.flash('error', 'Error loading coupons');
        res.redirect('/admin/coupons');
    }
});

app.get('/admin/coupons/new', requireAdmin, (req, res) => {
    const code = helpers.generateCouponCode();
    const expiresAt = moment().add(30, 'days').format('YYYY-MM-DD');
    res.render('admin/coupon-new', {
        title: 'New Coupon',
        coupon: { code, expiresAt, couponType: 'fixed' },
        couponTypes: ['fixed', 'percent'],
        activePage: 'coupons'
    });
});

app.post('/admin/coupons', requireAdmin, async (req, res) => {
    const { code, value, couponType = 'fixed', maxUses, expiresAt, isActive } = req.body;
    const errors = [];
    if (!code || value === undefined) errors.push('Code and value required');
    const couponValue = parseFloat(value);
    if (isNaN(couponValue) || couponValue <= 0) errors.push('Value must be positive');
    if (couponType === 'percent' && (couponValue > 100 || couponValue < 1)) errors.push('Percent discount must be between 1 and 100');
    if (code.length < 3) errors.push('Code too short');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        return res.render('admin/coupon-new', { title: 'New Coupon', coupon: req.body, couponTypes: ['fixed', 'percent'], errors, activePage: 'coupons' });
    }
    const finalCode = helpers.sanitize(code.toUpperCase().trim());
    try {
        const existing = await dbGet('SELECT id FROM coupons WHERE code = ?', [finalCode]);
        if (existing) {
            req.flash('error', 'Coupon code already exists');
            return res.render('admin/coupon-new', { title: 'New Coupon', coupon: req.body, couponTypes: ['fixed', 'percent'], activePage: 'coupons' });
        }
        const couponId = uuidv4();
        await runDb('INSERT INTO coupons (id, code, couponType, value, maxUses, expiresAt, isActive) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [couponId, finalCode, couponType, couponValue, maxUses ? parseInt(maxUses) : null, expiresAt || null, isActive === 'on']);
        req.flash('success', 'Coupon created successfully');
        res.redirect('/admin/coupons');
    } catch (err) {
        console.error('Coupon insert error:', err);
        req.flash('error', 'Failed to create coupon');
        res.render('admin/coupon-new', { title: 'New Coupon', coupon: req.body, couponTypes: ['fixed', 'percent'], activePage: 'coupons' });
    }
});

app.get('/admin/coupons/:id/edit', requireAdmin, async (req, res) => {
    try {
        const coupon = await dbGet('SELECT * FROM coupons WHERE id = ?', [req.params.id]);
        if (!coupon) {
            req.flash('error', 'Coupon not found');
            return res.redirect('/admin/coupons');
        }
        res.render('admin/coupon-edit', {
            title: 'Edit Coupon',
            coupon,
            couponTypes: ['fixed', 'percent'],
            activePage: 'coupons'
        });
    } catch (err) {
        console.error('Edit coupon error:', err);
        req.flash('error', 'Error loading coupon');
        res.redirect('/admin/coupons');
    }
});

app.post('/admin/coupons/:id', requireAdmin, async (req, res) => {
    const { code, value, couponType = 'fixed', maxUses, expiresAt, isActive } = req.body;
    const errors = [];
    if (!code || value === undefined) errors.push('Code and value required');
    const couponValue = parseFloat(value);
    if (isNaN(couponValue) || couponValue <= 0) errors.push('Value must be positive');
    if (couponType === 'percent' && (couponValue > 100 || couponValue < 1)) errors.push('Percent discount must be between 1 and 100');
    if (code.length < 3) errors.push('Code too short');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        return res.render('admin/coupon-edit', { title: 'Edit Coupon', coupon: { ...req.body, id: req.params.id }, couponTypes: ['fixed', 'percent'], errors, activePage: 'coupons' });
    }
    const finalCode = helpers.sanitize(code.toUpperCase().trim());
    try {
        const existing = await dbGet('SELECT id FROM coupons WHERE code = ? AND id != ?', [finalCode, req.params.id]);
        if (existing) {
            req.flash('error', 'Coupon code already exists');
            return res.render('admin/coupon-edit', { title: 'Edit Coupon', coupon: { ...req.body, id: req.params.id }, couponTypes: ['fixed', 'percent'], activePage: 'coupons' });
        }
        await runDb('UPDATE coupons SET code = ?, couponType = ?, value = ?, maxUses = ?, expiresAt = ?, isActive = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [finalCode, couponType, couponValue, maxUses ? parseInt(maxUses) : null, expiresAt || null, isActive === 'on', req.params.id]);
        req.flash('success', 'Coupon updated successfully');
        res.redirect('/admin/coupons');
    } catch (err) {
        console.error('Coupon update error:', err);
        req.flash('error', 'Failed to update coupon');
        res.render('admin/coupon-edit', { title: 'Edit Coupon', coupon: { ...req.body, id: req.params.id }, couponTypes: ['fixed', 'percent'], activePage: 'coupons' });
    }
});

app.post('/admin/coupons/:id/delete', requireAdmin, async (req, res) => {
    try {
        const result = await runDb('DELETE FROM coupons WHERE id = ?', [req.params.id]);
        if (result.changes === 0) {
            req.flash('error', 'Delete failed');
            return res.redirect('/admin/coupons');
        }
        req.flash('success', 'Coupon deleted successfully');
        res.redirect('/admin/coupons');
    } catch (err) {
        console.error('Coupon delete error:', err);
        req.flash('error', 'Delete failed');
        res.redirect('/admin/coupons');
    }
});

// Admin Users
app.get('/admin/users', requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const perPage = 10;
    const status = req.query.status || 'all';
    let sql = 'SELECT * FROM users';
    let whereClause = '';
    if (status !== 'all') {
        const cond = status === 'active' ? 'isActive = 1' : status === 'inactive' ? 'isActive = 0' : 'isAdmin = 1';
        whereClause = ` WHERE ${cond}`;
    }
    sql += whereClause + ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    const params = [perPage, (page - 1) * perPage];
    try {
        const users = await dbAll(sql, params);
        const countRow = await dbGet(`SELECT COUNT(*) as total FROM users ${whereClause}`);
        const pag = helpers.paginate(countRow ? countRow.total : 0, page, perPage);
        pag.data = users;
        res.render('admin/users', { title: 'Users', activePage: 'users', users: pag.data, currentStatus: status, pagination: pag });
    } catch (err) {
        console.error('Admin users error:', err);
        req.flash('error', 'Error loading users');
        res.redirect('/admin/users');
    }
});

app.get('/admin/users/new', requireAdmin, (req, res) => {
    res.render('admin/user-new', {
        title: 'New User',
        user: {},
        activePage: 'users'
    });
});

app.post('/admin/users', requireAdmin, async (req, res) => {
    const { email, firstName, lastName, phone, address, city, state, postalCode, isAdmin, isActive } = req.body;
    const errors = [];
    if (!email || !firstName || !lastName || !helpers.validateEmail(email)) errors.push('Valid email, first and last name required');
    if (phone && !helpers.validatePhone(phone)) errors.push('Invalid phone number');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        return res.render('admin/user-new', { title: 'New User', user: req.body, errors, activePage: 'users' });
    }
    try {
        const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (existing) {
            req.flash('error', 'Email already exists');
            return res.render('admin/user-new', { title: 'New User', user: req.body, activePage: 'users' });
        }
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashed = helpers.hashPassword(tempPassword);
        const userId = uuidv4();
        await runDb('INSERT INTO users (id, email, password, firstName, lastName, phone, address, city, state, postalCode, isAdmin, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [userId, email, hashed, helpers.sanitize(firstName.trim()), helpers.sanitize(lastName.trim()), phone || null, helpers.sanitize(address || null), helpers.sanitize(city || null), helpers.sanitize(state || null), postalCode || null, isAdmin === 'on', isActive === 'on']);
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        helpers.sendEmail({ to: email, subject: 'New Account Created', html: `<p>Welcome! Your temporary password is: <strong>${tempPassword}</strong></p><p>Please change it upon login.</p><a href="${baseUrl}/login">Login Here</a>` });
        req.flash('success', 'User created successfully');
        res.redirect('/admin/users');
    } catch (err) {
        console.error('User insert error:', err);
        req.flash('error', 'Failed to create user');
        res.render('admin/user-new', { title: 'New User', user: req.body, activePage: 'users' });
    }
});

app.get('/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
        if (!user) {
            req.flash('error', 'User not found');
            return res.redirect('/admin/users');
        }
        const orders = await dbAll(
            'SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC LIMIT 10',
            [req.params.id]
        );
        const userTickets = await helpers.countRows('tickets', 'WHERE userId = ?', [req.params.id]);
        res.render('admin/user-detail', {
            title: 'User Detail',
            user,
            orders,
            userTickets,
            activePage: 'users'
        });
    } catch (err) {
        console.error('Admin user detail error:', err);
        req.flash('error', 'Error loading user');
        res.redirect('/admin/users');
    }
});

app.post('/admin/users/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    const sessionId = req.session.user.id;
    if (userId === sessionId && req.body.isAdmin !== 'on') {
        req.flash('error', 'Cannot remove admin privileges from your own account');
        return res.redirect(`/admin/users/${userId}`);
    }
    const { email, firstName, lastName, phone, address, city, state, postalCode, isAdmin, isActive } = req.body;
    const errors = [];
    if (!email || !firstName || !lastName || !helpers.validateEmail(email)) errors.push('Valid email, first and last name required');
    if (phone && !helpers.validatePhone(phone)) errors.push('Invalid phone number');
    if (errors.length > 0) {
        req.flash('error', errors.join('<br>'));
        return res.redirect(`/admin/users/${userId}`);
    }
    try {
        const existing = await dbGet('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
        if (existing) {
            req.flash('error', 'Email already exists for another user');
            return res.redirect(`/admin/users/${userId}`);
        }
        await runDb(`UPDATE users SET email = ?, firstName = ?, lastName = ?, phone = ?, address = ?, city = ?, state = ?, postalCode = ?, isAdmin = ?, isActive = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            [email, helpers.sanitize(firstName.trim()), helpers.sanitize(lastName.trim()), phone || null, helpers.sanitize(address || null), helpers.sanitize(city || null), helpers.sanitize(state || null), postalCode || null, isAdmin === 'on', isActive === 'on', userId]);
        req.flash('success', 'User updated successfully');
        res.redirect(`/admin/users/${userId}`);
    } catch (err) {
        console.error('User update error:', err);
        req.flash('error', 'Failed to update user');
        res.redirect(`/admin/users/${userId}`);
    }
});

app.post('/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    if (req.params.id === req.session.user.id) {
        req.flash('error', 'Cannot reset password for your own account via admin panel');
        return res.redirect(`/admin/users/${req.params.id}`);
    }
    const newPassword = Math.random().toString(36).slice(-8);
    const hashed = helpers.hashPassword(newPassword);
    try {
        await runDb('UPDATE users SET password = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [hashed, req.params.id]);
        const user = await dbGet('SELECT email FROM users WHERE id = ?', [req.params.id]);
        if (user) {
            helpers.sendEmail({ to: user.email, subject: 'Password Reset by Admin', html: `<p>Your password has been reset by an administrator.</p><p>New temporary password: <strong>${newPassword}</strong></p><p>Please change it upon login.</p>` });
        }
        req.flash('success', 'Password reset successfully');
        res.redirect(`/admin/users/${req.params.id}`);
    } catch (err) {
        console.error('Password reset error:', err);
        req.flash('error', 'Failed to reset password');
        res.redirect(`/admin/users/${req.params.id}`);
    }
});

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
    if (req.params.id === req.session.user.id) {
        req.flash('error', 'Cannot delete your own account');
        return res.redirect(`/admin/users/${req.params.id}`);
    }
    try {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM orders WHERE userId = ? AND status != "cancelled"', [req.params.id]);
        if (countRow.count > 0) {
            req.flash('error', 'Cannot delete user with active orders');
            return res.redirect(`/admin/users/${req.params.id}`);
        }
        const result = await runDb('DELETE FROM users WHERE id = ?', [req.params.id]);
        if (result.changes === 0) {
            req.flash('error', 'Delete failed');
            return res.redirect(`/admin/users/${req.params.id}`);
        }
        req.flash('success', 'User deleted successfully');
        res.redirect('/admin/users');
    } catch (err) {
        console.error('User delete error:', err);
        req.flash('error', 'Delete failed');
        res.redirect(`/admin/users/${req.params.id}`);
    }
});

// Admin Settings
app.get('/admin/settings', requireAdmin, async (req, res) => {
    try {
        res.render('admin/settings', {
            title: 'Settings',
            settings: res.locals.settings,
            activePage: 'settings'
        });
    } catch (err) {
        console.error('Settings error:', err);
        req.flash('error', 'Error loading settings');
        res.redirect('/admin/settings');
    }
});

app.post('/admin/settings/general', requireAdmin, upload.fields([{name: 'site_logo', maxCount: 1}, {name: 'site_favicon', maxCount: 1}]), async (req, res) => {
    const { site_name, site_description, contact_email } = req.body;
    const updateFields = [
        {key: 'site_name', value: helpers.sanitize(site_name || 'Hosting Service')},
        {key: 'site_description', value: helpers.sanitize(site_description || '')},
        {key: 'contact_email', value: helpers.sanitize(contact_email || '')}
    ];
    try {
        for (const field of updateFields) {
            await runDb('INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)',
                [field.key, field.value, `Description for ${field.key}`]);
        }
        if (req.files['site_logo'] && req.files['site_logo'].length > 0) {
            const newLogo = req.files['site_logo'][0].filename;
            const oldLogoRow = await dbGet('SELECT value FROM settings WHERE key = "site_logo"');
            if (oldLogoRow && oldLogoRow.value) {
                helpers.deleteFile(oldLogoRow.value);
            }
            await runDb('UPDATE settings SET value = ? WHERE key = "site_logo"', [newLogo]); // ← Save only filename
        }
        
        if (req.files['site_favicon'] && req.files['site_favicon'].length > 0) {
            const newFavicon = req.files['site_favicon'][0].filename;
            const oldFaviconRow = await dbGet('SELECT value FROM settings WHERE key = "site_favicon"');
            if (oldFaviconRow && oldFaviconRow.value) {
                helpers.deleteFile(oldFaviconRow.value);
            }
            await runDb('UPDATE settings SET value = ? WHERE key = "site_favicon"', [newFavicon]); // ← Only filename
        }
        req.flash('success', 'General settings updated successfully');
        res.redirect('/admin/settings');
    } catch (err) {
        console.error('General settings error:', err);
        req.flash('error', 'Failed to update settings');
        res.redirect('/admin/settings');
    }
});

app.post('/admin/settings/maintenance', requireAdmin, async (req, res) => {
    const { maintenance_mode } = req.body;
    try {
        await runDb('INSERT OR REPLACE INTO settings (key, value, description) VALUES ("maintenance_mode", ?, "Maintenance mode on/off")', [maintenance_mode || 'off']);
        req.flash('success', 'Maintenance mode updated');
        res.redirect('/admin/settings');
    } catch (err) {
        console.error('Maintenance settings error:', err);
        req.flash('error', 'Update failed');
        res.redirect('/admin/settings');
    }
});

app.post('/admin/settings/razorpay', requireAdmin, async (req, res) => {
    const { razorpay_key_id, razorpay_key_secret } = req.body;
    if (!razorpay_key_id || !razorpay_key_secret) {
        req.flash('error', 'Razorpay keys are required');
        return res.redirect('/admin/settings');
    }
    try {
        await runDb('INSERT OR REPLACE INTO settings (key, value, description) VALUES ("razorpay_key_id", ?, "Razorpay Key ID")', [razorpay_key_id]);
        await runDb('INSERT OR REPLACE INTO settings (key, value, description) VALUES ("razorpay_key_secret", ?, "Razorpay Key Secret")', [razorpay_key_secret]);
        req.flash('success', 'Razorpay settings updated (restart server for changes to take effect)');
        res.redirect('/admin/settings');
    } catch (err) {
        console.error('Razorpay settings error:', err);
        req.flash('error', 'Update failed');
        res.redirect('/admin/settings');
    }
});

// ======================
// ADMIN TICKET ROUTES
// ======================
app.get('/admin/tickets', requireAdmin, async (req, res) => {
    const filters = {
        status: req.query.status || 'all',
        department: req.query.department || 'all',
        priority: req.query.priority || 'all',
        assigned: req.query.assigned || 'all',
        search: helpers.sanitize(req.query.search || ''),
        tag: helpers.sanitize(req.query.tag || ''),
        dateFrom: req.query.dateFrom || '',
        dateTo: req.query.dateTo || ''
    };
    try {
        const pag = await ticketHelpers.getAllTickets(parseInt(req.query.page) || 1, 10, filters);
        const unreadRow = await dbGet('SELECT COUNT(*) as count FROM tickets WHERE isReadAdmin = 0');
        const unread = unreadRow ? unreadRow.count : 0;
        const admins = await dbAll('SELECT id, email, firstName, lastName FROM users WHERE isAdmin = 1 ORDER BY firstName');
        res.render('admin/tickets', {
            title: 'Support Tickets',
            activePage: 'tickets',
            tickets: pag.data,
            admins,
            unreadCount: unread,
            TICKET_CONFIG,
            filters,
            pagination: pag
        });
    } catch (err) {
        console.error('Admin tickets error:', err);
        req.flash('error', 'Error loading tickets');
        res.redirect('/admin/tickets');
    }
});

app.get('/admin/tickets/:id', requireAdmin, async (req, res) => {
    try {
        const ticket = await dbGet('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
        if (!ticket) {
            req.flash('error', 'Ticket not found');
            return res.redirect('/admin/tickets');
        }
        await runDb('UPDATE tickets SET isReadAdmin = 1 WHERE id = ?', [req.params.id]);
        ticket.tags = ticket.tags ? ticket.tags.split(',') : [];
        const replies = await dbAll(
            `SELECT tr.*, u.firstName, u.lastName, u.isAdmin
             FROM ticket_replies tr
             LEFT JOIN users u ON tr.userId = u.id
             WHERE ticketId = ? AND isNote = 0
             ORDER BY createdAt ASC`, [req.params.id]
        );
        replies.forEach(r => {
            try {
                r.attachments = JSON.parse(r.attachments || '[]');
            } catch (e) {
                r.attachments = [];
            }
        });
        const notes = await dbAll(
            `SELECT tn.*, u.firstName, u.lastName
             FROM ticket_notes tn
             LEFT JOIN users u ON tn.userId = u.id
             WHERE ticketId = ?
             ORDER BY createdAt ASC`, [req.params.id]
        );
        const admins = await dbAll('SELECT id, email, firstName, lastName FROM users WHERE isAdmin = 1 ORDER BY firstName');
        res.render('admin/ticket-view', {
            title: `Ticket #${ticket.id}: ${ticket.subject}`,
            activePage: 'tickets',
            ticket,
            replies,
            notes,
            admins,
            TICKET_CONFIG,
            cannedResponses: ticketHelpers.getCannedResponses(),
            slaStatus: ticketHelpers.getSLAStatus(ticket)
        });
    } catch (err) {
        console.error('Admin ticket view error:', err);
        req.flash('error', 'Error loading ticket');
        res.redirect('/admin/tickets');
    }
});

app.post('/admin/tickets/:id/reply', requireAdmin, ticketUpload.array('attachments', TICKET_CONFIG.MAX_ATTACHMENTS), async (req, res) => {
    const { message, isNote, canned } = req.body;
    let finalMessage = message;
    if (canned) {
        const cannedResp = TICKET_CONFIG.CANNED_RESPONSES.find(r => r.id === canned);
        if (cannedResp) finalMessage = cannedResp.content;
    }
    if (!finalMessage || finalMessage.length < 5) {
        req.flash('error', 'Message must be at least 5 characters');
        return res.redirect(`/admin/tickets/${req.params.id}`);
    }
    if (req.files && req.files.length > TICKET_CONFIG.MAX_ATTACHMENTS) {
        req.flash('error', `Maximum ${TICKET_CONFIG.MAX_ATTACHMENTS} attachments allowed`);
        return res.redirect(`/admin/tickets/${req.params.id}`);
    }
    const attachments = req.files ? req.files.map(f => ({ name: f.originalname, path: `/uploads/tickets/${f.filename}`, size: f.size, type: f.mimetype })) : [];
    const noteFlag = isNote === 'on';
    try {
        await ticketHelpers.addReply(req.params.id, req.session.user.id, helpers.sanitize(finalMessage.trim()), attachments, false, noteFlag);
        req.flash('success', noteFlag ? 'Note added successfully' : 'Reply added successfully');
        res.redirect(`/admin/tickets/${req.params.id}`);
    } catch (err) {
        console.error('Admin add reply error:', err);
        req.flash('error', 'Failed to add reply/note');
        res.redirect(`/admin/tickets/${req.params.id}`);
    }
});

app.post('/admin/tickets/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    const success = await ticketHelpers.updateTicketStatus(req.params.id, status, req.session.user.id);
    if (success) {
        const user = await dbGet('SELECT u.email FROM users u JOIN tickets t ON t.userId = u.id WHERE t.id = ?', [req.params.id]);
        if (user) {
            helpers.sendEmail({
                to: user.email,
                subject: 'Ticket Status Updated',
                html: `<p>Your ticket status has been updated to: ${status}</p>`
            });
        }
        req.flash('success', 'Status updated successfully');
    } else {
        req.flash('error', 'Failed to update status');
    }
    res.redirect(`/admin/tickets/${req.params.id}`);
});

app.post('/admin/tickets/:id/assign', requireAdmin, async (req, res) => {
    const { assignTo } = req.body;
    try {
        const result = await runDb('UPDATE tickets SET assignedTo = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [assignTo || null, req.params.id]);
        if (result.changes === 0) {
            req.flash('error', 'Failed to assign ticket');
            return res.redirect(`/admin/tickets/${req.params.id}`);
        }
        req.flash('success', 'Ticket assigned successfully');
        res.redirect(`/admin/tickets/${req.params.id}`);
    } catch (err) {
        console.error('Assign ticket error:', err);
        req.flash('error', 'Failed to assign ticket');
        res.redirect(`/admin/tickets/${req.params.id}`);
    }
});

app.post('/admin/tickets/:id/delete', requireAdmin, async (req, res) => {
    try {
        await runDb('DELETE FROM ticket_replies WHERE ticketId = ?', [req.params.id]);
        await runDb('DELETE FROM ticket_notes WHERE ticketId = ?', [req.params.id]);
        const result = await runDb('DELETE FROM tickets WHERE id = ?', [req.params.id]);
        if (result.changes === 0) {
            req.flash('error', 'Failed to delete ticket');
            return res.redirect('/admin/tickets');
        }
        req.flash('success', 'Ticket deleted successfully');
        res.redirect('/admin/tickets');
    } catch (err) {
        console.error('Delete ticket error:', err);
        req.flash('error', 'Failed to delete ticket');
        res.redirect('/admin/tickets');
    }
});

// Ticket stats
app.get('/admin/tickets/stats', requireAdmin, async (req, res) => {
    try {
        const statusStats = await dbAll('SELECT status, COUNT(*) as count FROM tickets GROUP BY status');
        const deptStats = await dbAll('SELECT department, COUNT(*) as count FROM tickets GROUP BY department');
        const prioStats = await dbAll('SELECT priority, COUNT(*) as count FROM tickets GROUP BY priority');
        const total = statusStats.reduce((sum, s) => sum + (s.count || 0), 0);
        const stats = {
            total,
            byStatus: statusStats,
            byDepartment: deptStats,
            byPriority: prioStats
        };
        res.render('admin/ticket-stats', { title: 'Ticket Stats', activePage: 'tickets', stats, TICKET_CONFIG });
    } catch (err) {
        console.error('Ticket stats error:', err);
        req.flash('error', 'Error loading stats');
        res.redirect('/admin/tickets');
    }
});

// Global 404 handler
app.use((req, res) => {
    req.flash('error', 'Page not found');
    res.redirect('/');
});

// Start Server
app.listen(PORT, () => {
    console.log(`
  
  ____    _____   _        _        _____   _   _    _____      _____                _____   _    _ 
 |  _ \\  |_   _| | |      | |      |_   _| | \\ | |  / ____|    |  __ \\      /\\      / ____| | |  | |
 | |_) |   | |   | |      | |        | |   |  \\| | | |  __     | |  | |    /  \\    | (___   | |__| |
 |  _ <    | |   | |      | |        | |   | . \` | | | |_ |    | |  | |   / /\\ \\    \\___ \\  |  __  |
 | |_) |  _| |_  | |____  | |____   _| |_  | |\\  | | |__| |    | |__| |  / ____ \\   ____) | | |  | |
 |____/  |_____| |______| |______| |_____| |_| \\_|  \\_____|    |_____/  /_/    \\_\\ |_____/  |_|  |_|                                                                                                      
    `);

    console.log(`Server running on port ${PORT}`);
    console.log('Razorpay configured - ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
    console.log('Cron jobs started for order management');
    console.log('Full professional Razorpay gateway ready with auto-activation and cancellation.');
    console.log('Product reviews and likes added with admin management.');
    console.log('Security improved with helmet and input sanitization.');
});