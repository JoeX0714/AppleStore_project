const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const APP_PORT = Number(process.env.APP_PORT || 3100);

app.use(express.json());
app.use(cors());

// --- 你的原有代码：托管前端静态资源 ---
app.use('/html', express.static(path.join(__dirname, 'html')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/images', express.static(path.join(__dirname, 'images')));

 const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_NAME || 'apple_store',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

let userColumns = new Set();

function normalizeAccount(value) {
  const trimmed = String(value || '').trim();
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed.replace(/\s+/g, '');
}

function isEmail(account) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account);
}

function isPhone(account) {
  return /^1[3-9]\d{9}$/.test(account);
}

async function loadUserColumns() {
  const [rows] = await pool.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
    `,
  );
  userColumns = new Set(rows.map((item) => item.COLUMN_NAME));
}

async function initDatabase() {
  // 1. 一次性建好表和所有字段
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account VARCHAR(191) NULL,
      email VARCHAR(191) NULL,
      phone VARCHAR(20) NULL,
      username VARCHAR(191) NULL,
      password_hash VARCHAR(255) NULL,
      password VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ⚠️ 删除了所有 ALTER TABLE 语句

  // 2. 加载字段配置
  await loadUserColumns();

  // 3. 创建唯一索引
  try {
    await pool.query(`CREATE UNIQUE INDEX uk_users_account ON users(account)`);
  } catch (_error) {
    // 索引已存在或历史数据冲突时忽略，避免阻塞服务启动。
  }
}

function buildAccountQueryClauses(account) {
  const clauses = [];
  const params = [];

  if (userColumns.has('account')) {
    clauses.push('account = ?');
    params.push(account);
  }
  if (userColumns.has('email')) {
    clauses.push('email = ?');
    params.push(account);
  }
  if (userColumns.has('phone')) {
    clauses.push('phone = ?');
    params.push(account);
  }

  return { clauses, params };
}

async function findUserByAccount(account) {
  const { clauses, params } = buildAccountQueryClauses(account);
  if (!clauses.length) {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT * FROM users WHERE ${clauses.join(' OR ')} LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

app.post('/api/register', (req, res) => {
  (async () => {
    const account = normalizeAccount(req.body.account);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!account) {
      return res.status(400).json({ success: false, message: '请输入电子邮件或电话号码' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: '密码至少需要 6 位' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: '两次输入的密码不一致' });
    }

    const existed = await findUserByAccount(account);
    if (existed) {
      return res.status(400).json({ success: false, message: '该电子邮件或电话号码已注册' });
    }

    const hash = await bcrypt.hash(password, 10);

    const insertMap = {};
    if (userColumns.has('account')) insertMap.account = account;
    if (userColumns.has('email') && isEmail(account)) insertMap.email = account;
    if (userColumns.has('phone') && isPhone(account)) insertMap.phone = account;
    if (userColumns.has('username')) insertMap.username = account;
    if (userColumns.has('password_hash')) insertMap.password_hash = hash;
    if (userColumns.has('password')) insertMap.password = null;

    const columns = Object.keys(insertMap);
    const values = Object.values(insertMap);

    if (!columns.length) {
      return res.status(500).json({ success: false, message: 'users 表字段配置异常' });
    }

    await pool.query(
      `INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    );

    return res.json({ success: true, message: '注册成功' });
  })().catch((error) => {
    console.error('注册错误:', error.message);
    return res.status(500).json({ success: false, message: '服务器繁忙，请稍后重试' });
  });
});

app.post('/api/auth/check-account', (req, res) => {
  (async () => {
    const account = normalizeAccount(req.body.account);
    if (!account) {
      return res.status(400).json({ success: false, exists: false, message: '请输入电子邮件或电话号码' });
    }

    const existed = await findUserByAccount(account);
    if (!existed) {
      return res.status(400).json({ success: false, exists: false, message: '该邮箱或手机号未注册' });
    }

    return res.json({ success: true, exists: true, message: '账号已验证，请输入密码' });
  })().catch((error) => {
    console.error('账号校验错误:', error.message);
    return res.status(500).json({ success: false, exists: false, message: '服务器繁忙，请稍后重试' });
  });
});

app.post('/api/login', (req, res) => {
  (async () => {
    const account = normalizeAccount(req.body.account);
    const password = String(req.body.password || '');

    if (!account || !password) {
      return res.status(400).json({ success: false, message: '请输入完整的账号和密码' });
    }

    const user = await findUserByAccount(account);
    if (!user) {
      return res.status(401).json({ success: false, message: '该邮箱或手机号未注册' });
    }

    let passwordMatched = false;
    if (user.password_hash) {
      passwordMatched = await bcrypt.compare(password, user.password_hash);
    } else if (user.password) {
      passwordMatched = password === user.password;
    }

    if (!passwordMatched) {
      return res.status(401).json({ success: false, message: '密码错误，请重试' });
    }

    if (!user.password_hash && userColumns.has('password_hash')) {
      const migratedHash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = ?, password = NULL WHERE id = ?', [migratedHash, user.id]);
    }

    if (userColumns.has('account') && !user.account) {
      await pool.query('UPDATE users SET account = ? WHERE id = ?', [account, user.id]);
    }

    return res.json({ success: true, message: '登录成功' });
  })().catch((error) => {
    console.error('登录错误:', error.message);
    return res.status(500).json({ success: false, message: '服务器繁忙，请稍后重试' });
  });
});

app.post('/api/change-password', (req, res) => {
  (async () => {
    const account = normalizeAccount(req.body.account);
    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmNewPassword = String(req.body.confirmNewPassword || '');

    if (!account) {
      return res.status(400).json({ success: false, message: '请先登录后再修改密码' });
    }

    if (!oldPassword || !newPassword || !confirmNewPassword) {
      return res.status(400).json({ success: false, message: '请填写完整信息' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少需要 6 位' });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ success: false, message: '两次输入的新密码不一致' });
    }

    const user = await findUserByAccount(account);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在，请重新登录' });
    }

    let oldPasswordMatched = false;
    if (user.password_hash) {
      oldPasswordMatched = await bcrypt.compare(oldPassword, user.password_hash);
    } else if (user.password) {
      oldPasswordMatched = oldPassword === user.password;
    }

    if (!oldPasswordMatched) {
      return res.status(401).json({ success: false, message: '旧密码错误' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = ?, password = NULL WHERE id = ?', [newHash, user.id]);

    return res.json({ success: true, message: '密码修改成功' });
  })().catch((error) => {
    console.error('修改密码错误:', error.message);
    return res.status(500).json({ success: false, message: '服务器繁忙，请稍后重试' });
  });
});

initDatabase()
  .then(() => {
    console.log('✅ MySQL 数据库已成功连接！');
    app.listen(APP_PORT, '0.0.0.0', () => {
      console.log('start');
      console.log(`打开你的页面: http://localhost:${APP_PORT}/html/index.html`);
      console.log(`打开你的页面: http://127.0.0.1:${APP_PORT}/html/index.html`);
    });
  })
  .catch((error) => {
    console.error('数据库初始化失败:', error.message);
    process.exit(1);
  });