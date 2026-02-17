// backend/src/index.js
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || '../plombir_base.db';
const BOT_TOKEN = process.env.BOT_TOKEN;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../frontend')));

// Database connection
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ==================== TELEGRAM AUTH ====================
function validateTelegramInitData(initData) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    
    const dataCheckString = Array.from(urlParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    return computedHash === hash;
}

// ==================== AUTH ====================
app.post('/api/auth', async (req, res) => {
    try {
        const { initData, user } = req.body;
        
        if (!validateTelegramInitData(initData)) {
            return res.status(401).json({ error: 'Invalid Telegram data' });
        }
        
        // Get or create user
        let dbUser = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user.id);
        
        if (!dbUser) {
            // Auto-register from Telegram
            const maxId = db.prepare('SELECT MAX(short_id) FROM users').get();
            const newShortId = (maxId['MAX(short_id)'] || 0) + 1;
            
            db.prepare(`
                INSERT INTO users (user_id, short_id, username, name, agreed)
                VALUES (?, ?, ?, ?, 1)
            `).run(user.id, newShortId, user.username, user.first_name);
            
            dbUser = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user.id);
        }
        
        // Check if admin
        const isAdmin = db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(user.id);
        
        res.json({
            user: {
                id: dbUser.user_id,
                short_id: dbUser.short_id,
                name: dbUser.name,
                username: dbUser.username,
                rating: dbUser.rating,
                insta_verified: dbUser.insta_verified,
                tiktok_verified: dbUser.tiktok_verified,
                phone_verified: dbUser.phone_verified,
                pvp_notifications: dbUser.pvp_notifications,
                pvp_wins: db.prepare('SELECT wins FROM pvp_stats WHERE user_id = ?').get(user.id)?.wins || 0,
                is_admin: !!isAdmin
            }
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// ==================== FARM ====================
app.get('/api/farm', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        
        const animals = db.prepare(`
            SELECT animal_key, COUNT(*) as count
            FROM user_farm
            WHERE user_id = ?
            GROUP BY animal_key
        `).all(userId);
        
        const protection = db.prepare(`
            SELECT item_key
            FROM user_protection
            WHERE user_id = ?
        `).all(userId);
        
        // Map to frontend format
        const animalPrices = {
            chicken: { name: 'Курица', emoji: '🐔', income: 3, price: 500 },
            rooster: { name: 'Петух', emoji: '🐓', income: 8, price: 1000 },
            duck: { name: 'Утка', emoji: '🦆', income: 20, price: 2500 },
            goose: { name: 'Гусь', emoji: '🪿', income: 45, price: 5000 },
            pig: { name: 'Свинья', emoji: '🐷', income: 100, price: 12000 },
            sheep: { name: 'Овца', emoji: '🐑', income: 220, price: 25000 },
            cow: { name: 'Корова', emoji: '🐮', income: 500, price: 50000 },
            horse: { name: 'Лошадь', emoji: '🐴', income: 1300, price: 120000 },
            elephant: { name: 'Слон', emoji: '🐘', income: 3500, price: 300000 },
            unicorn: { name: 'Единорог', emoji: '🦄', income: 10000, price: 800000 },
            dragon: { name: 'Дракон', emoji: '🐉', income: 30000, price: 2000000 }
        };
        
        const protectionItems = {
            scarecrow: { name: 'Пугало', emoji: '👤', bonus: 0.05, price: 1000 },
            battle_cat: { name: 'Боевой кот', emoji: '😼', bonus: 0.15, price: 5000 },
            dog: { name: 'Собака', emoji: '🐕', bonus: 0.35, price: 15000 },
            fence_electric: { name: 'Электрозабор', emoji: '⚡️', bonus: 0.55, price: 50000 },
            guard: { name: 'Наемник', emoji: '💂‍♂️', bonus: 0.80, price: 150000 }
        };
        
        res.json({
            animals: animals.map(a => ({
                key: a.animal_key,
                ...animalPrices[a.animal_key],
                count: a.count
            })),
            protection: protection.map(p => ({
                key: p.item_key,
                ...protectionItems[p.item_key]
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/farm/buy-animal', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { animal_key } = req.body;
        
        const prices = {
            chicken: 500, rooster: 1000, duck: 2500, goose: 5000,
            pig: 12000, sheep: 25000, cow: 50000, horse: 120000,
            elephant: 300000, unicorn: 800000, dragon: 2000000
        };
        
        const price = prices[animal_key];
        if (!price) return res.status(400).json({ error: 'Invalid animal' });
        
        const user = db.prepare('SELECT rating FROM users WHERE user_id = ?').get(userId);
        if (user.rating < price) {
            return res.status(400).json({ error: 'Not enough points' });
        }
        
        const transaction = db.transaction(() => {
            db.prepare('UPDATE users SET rating = rating - ? WHERE user_id = ?').run(price, userId);
            db.prepare('INSERT INTO user_farm (user_id, animal_key) VALUES (?, ?)').run(userId, animal_key);
        });
        
        transaction();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/farm/buy-protection', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { item_key } = req.body;
        
        const prices = {
            scarecrow: 1000, battle_cat: 5000, dog: 15000,
            fence_electric: 50000, guard: 150000
        };
        
        const price = prices[item_key];
        if (!price) return res.status(400).json({ error: 'Invalid item' });
        
        const user = db.prepare('SELECT rating FROM users WHERE user_id = ?').get(userId);
        if (user.rating < price) {
            return res.status(400).json({ error: 'Not enough points' });
        }
        
        const exists = db.prepare('SELECT 1 FROM user_protection WHERE user_id = ? AND item_key = ?').get(userId, item_key);
        if (exists) return res.status(400).json({ error: 'Already owned' });
        
        const transaction = db.transaction(() => {
            db.prepare('UPDATE users SET rating = rating - ? WHERE user_id = ?').run(price, userId);
            db.prepare('INSERT INTO user_protection (user_id, item_key) VALUES (?, ?)').run(userId, item_key);
        });
        
        transaction();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== TASKS ====================
app.get('/api/tasks', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        
        const tasks = db.prepare(`
            SELECT at.*, 
                   CASE WHEN ct.status = 1 THEN 'completed'
                        WHEN ct.status = 0 THEN 'pending'
                        ELSE 'available' END as status
            FROM active_tasks at
            LEFT JOIN completed_tasks ct ON at.id = ct.task_id AND ct.user_id = ?
            WHERE ct.status IS NULL OR ct.status != 1
        `).all(userId);
        
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/tasks/start', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { task_id } = req.body;
        
        db.prepare(`
            INSERT OR REPLACE INTO completed_tasks (user_id, task_id, status)
            VALUES (?, ?, 0)
        `).run(userId, task_id);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PVP ====================
app.get('/api/pvp/offers', async (req, res) => {
    try {
        const offers = db.prepare(`
            SELECT b.*, u.name as challenger_name, u.short_id as challenger_short_id
            FROM pvp_battles b
            JOIN users u ON b.challenger_id = u.user_id
            WHERE b.status = 'pending'
            ORDER BY b.created_at DESC
        `).all();
        
        res.json(offers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/pvp/create', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { bet } = req.body;
        
        if (bet < 10) return res.status(400).json({ error: 'Minimum bet is 10' });
        
        const user = db.prepare('SELECT rating FROM users WHERE user_id = ?').get(userId);
        if (user.rating < bet) return res.status(400).json({ error: 'Not enough points' });
        
        const transaction = db.transaction(() => {
            db.prepare('UPDATE users SET rating = rating - ? WHERE user_id = ?').run(bet, userId);
            db.prepare(`
                INSERT INTO pvp_battles (challenger_id, bet, status)
                VALUES (?, ?, 'pending')
            `).run(userId, bet);
        });
        
        transaction();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/pvp/accept', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { battle_id } = req.body;
        
        const battle = db.prepare('SELECT * FROM pvp_battles WHERE battle_id = ?').get(battle_id);
        if (!battle || battle.status !== 'pending') {
            return res.status(400).json({ error: 'Battle not available' });
        }
        
        if (battle.challenger_id === userId) {
            return res.status(400).json({ error: 'Cannot fight yourself' });
        }
        
        const user = db.prepare('SELECT rating FROM users WHERE user_id = ?').get(userId);
        if (user.rating < battle.bet) {
            return res.status(400).json({ error: 'Not enough points' });
        }
        
        // Simulate battle
        const challengerRoll = Math.floor(Math.random() * 6) + 1;
        const opponentRoll = Math.floor(Math.random() * 6) + 1;
        
        let winner = null;
        let message = '';
        
        const transaction = db.transaction(() => {
            if (challengerRoll > opponentRoll) {
                winner = battle.challenger_id;
                db.prepare('UPDATE users SET rating = rating - ? WHERE user_id = ?').run(battle.bet, userId);
                db.prepare('UPDATE users SET rating = rating + ? WHERE user_id = ?').run(battle.bet * 2, battle.challenger_id);
                message = `Победил создатель вызова! +${battle.bet} PTS`;
            } else if (opponentRoll > challengerRoll) {
                winner = userId;
                db.prepare('UPDATE users SET rating = rating + ? WHERE user_id = ?').run(battle.bet, userId);
                message = `Вы победили! +${battle.bet} PTS`;
            } else {
                db.prepare('UPDATE users SET rating = rating + ? WHERE user_id = ?').run(battle.bet, battle.challenger_id);
                message = 'Ничья! Ставки возвращены';
            }
            
            db.prepare("UPDATE pvp_battles SET status = 'finished' WHERE battle_id = ?").run(battle_id);
        });
        
        transaction();
        
        res.json({ success: true, winner: winner === userId, message });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== TOP PLAYERS ====================
app.get('/api/top', async (req, res) => {
    try {
        const players = db.prepare(`
            SELECT user_id, short_id, name, username, rating
            FROM users
            ORDER BY rating DESC
            LIMIT 20
        `).all();
        
        res.json(players);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== GIVEAWAYS ====================
app.get('/api/giveaways', async (req, res) => {
    try {
        const giveaways = db.prepare(`
            SELECT *, 
                   (SELECT COUNT(*) FROM giveaway_users WHERE giveaway_id = giveaways.id) as participants
            FROM giveaways
            WHERE status = 'active'
        `).all();
        
        res.json(giveaways);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/giveaways/join', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { giveaway_id } = req.body;
        
        db.prepare(`
            INSERT OR IGNORE INTO giveaway_users (giveaway_id, user_id)
            VALUES (?, ?)
        `).run(giveaway_id, userId);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PROMO ====================
app.post('/api/promo/activate', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { code } = req.body;
        
        const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code.toUpperCase());
        if (!promo) {
            return res.status(400).json({ error: 'Invalid code' });
        }
        
        if (promo.current_uses >= promo.max_uses) {
            return res.status(400).json({ error: 'Code expired' });
        }
        
        const used = db.prepare('SELECT 1 FROM promo_history WHERE user_id = ? AND code = ?').get(userId, code);
        if (used) {
            return res.status(400).json({ error: 'Already used' });
        }
        
        const transaction = db.transaction(() => {
            db.prepare('UPDATE users SET rating = rating + ? WHERE user_id = ?').run(promo.reward, userId);
            db.prepare('UPDATE promo_codes SET current_uses = current_uses + 1 WHERE code = ?').run(code);
            db.prepare('INSERT INTO promo_history (user_id, code) VALUES (?, ?)').run(userId, code);
        });
        
        transaction();
        
        res.json({ success: true, reward: promo.reward });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SOCIAL ====================
app.post('/api/social/verify', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { platform, nick } = req.body;
        
        const field = platform === 'insta' ? 'insta' : 'tiktok';
        const verifiedField = platform === 'insta' ? 'insta_verified' : 'tiktok_verified';
        
        db.prepare(`UPDATE users SET ${field} = ?, ${verifiedField} = 2 WHERE user_id = ?`).run(nick, userId);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/social/verify-phone', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        
        const transaction = db.transaction(() => {
            db.prepare('UPDATE users SET phone_verified = 1, rating = rating + 20 WHERE user_id = ?').run(userId);
        });
        
        transaction();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PROFILE ====================
app.post('/api/profile/update', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { field, value } = req.body;
        
        const allowedFields = ['name', 'faculty', 'insta', 'tiktok', 'phone'];
        if (!allowedFields.includes(field)) {
            return res.status(400).json({ error: 'Invalid field' });
        }
        
        const dateCol = `edit_${field}`;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        
        db.prepare(`UPDATE users SET ${field} = ?, ${dateCol} = ? WHERE user_id = ?`).run(value, now, userId);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== DICE ====================
app.post('/api/dice/roll', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        
        const lastRoll = db.prepare('SELECT last_roll FROM dice_rolls WHERE user_id = ?').get(userId);
        if (lastRoll) {
            const lastTime = new Date(lastRoll.last_roll);
            const now = new Date();
            const hoursDiff = (now - lastTime) / (1000 * 60 * 60);
            
            if (hoursDiff < 24) {
                return res.status(400).json({ error: 'Wait 24 hours' });
            }
        }
        
        const value = Math.floor(Math.random() * 6) + 1;
        const points = value === 1 ? 100 : value * 10;
        
        const transaction = db.transaction(() => {
            db.prepare('UPDATE users SET rating = rating + ? WHERE user_id = ?').run(points, userId);
            db.prepare('INSERT OR REPLACE INTO dice_rolls (user_id, last_roll) VALUES (?, ?)').run(userId, new Date().toISOString().slice(0, 19).replace('T', ' '));
        });
        
        transaction();
        
        res.json({ success: true, value, points });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ADMIN ====================
app.post('/api/admin/export', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        
        const isAdmin = db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(userId);
        if (!isAdmin) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        const users = db.prepare('SELECT * FROM users ORDER BY short_id ASC').all();
        
        // In production, generate Excel file
        res.json({ success: true, count: users.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`🚀 PLOMBIR Backend running on port ${PORT}`);
});