const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const APP_PORT = Number(process.env.APP_PORT || 3100);
const DEFAULT_ADMIN_ACCOUNT = 'root';
const DEFAULT_ADMIN_PASSWORD = '123456';
const PRODUCT_CATEGORIES = new Set(['mac', 'ipad', 'iphone', 'watch', 'airpods']);
const uploadDir = path.join(__dirname, 'images', 'uploads');

app.use(express.json({ limit: '12mb' }));
app.use(cors());
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

async function tableColumnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [tableName, columnName],
  );
  return rows.length > 0;
}

async function ensureColumn(tableName, columnName, definition) {
  if (await tableColumnExists(tableName, columnName)) {
    return;
  }
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

async function ensureIndex(sql) {
  try {
    await pool.query(sql);
  } catch (error) {
    if (!['ER_DUP_KEYNAME', 'ER_DUP_ENTRY'].includes(error.code)) {
      throw error;
    }
  }
}

function createSkuCode(productId, parts) {
  const signature = parts.filter(Boolean).join('|') || 'default';
  const digest = crypto.createHash('sha1').update(`${productId}|${signature}`).digest('hex').slice(0, 12);
  return `${productId}-${digest}`;
}

function buildSkuRowsFromProduct(productId, payload) {
  const product = payload && typeof payload === 'object' ? payload : {};
  const storageMode = String(product.storageMode || '').trim();
  const basePrice = Number(product.price || product.basePrice || 0) || 0;
  const colors = Array.isArray(product.colors) ? product.colors : [];
  const storages = Array.isArray(product.storages) ? product.storages : [];
  const materials = Array.isArray(product.materials) ? product.materials : [];
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  const connections = Array.isArray(product.connections) && product.showConnection !== false ? product.connections : [];
  const models = Array.isArray(product.models) ? product.models : [];
  const rows = [];

  const addRow = ({ colorName = '', specName = '', connectionName = '', price = basePrice, imageFile = '' }) => {
    const parts = [colorName, specName, connectionName].filter(Boolean);
    const description = parts.join(' / ') || product.name || productId;
    rows.push({
      skuCode: createSkuCode(productId, parts),
      colorName,
      specName,
      connectionName,
      description,
      price: Math.max(Number(price || 0), 0),
      imageUrl: imageFile || product.baseImage || '',
      configJson: JSON.stringify({ colorName, specName, connectionName, description }),
    });
  };

  if (storageMode === 'watch-material') {
    const materialList = materials.length ? materials : [{ capacity: '默认表壳', price: basePrice, file: product.baseImage }];
    const sizeList = sizes.length ? sizes : [{ capacity: '默认尺寸', price: basePrice }];
    const connectionList = connections.length ? connections : [{ capacity: '', price: 0 }];
    materialList.forEach((material) => {
      sizeList.forEach((size) => {
        connectionList.forEach((connection) => {
          const price = Math.max(
            Number(material.price || 0),
            Number(size.price || 0),
            Number(connection.price || 0),
            basePrice,
          );
          addRow({
            colorName: String(material.capacity || material.name || '').trim(),
            specName: String(size.capacity || '').trim(),
            connectionName: String(connection.capacity || '').trim(),
            price,
            imageFile: material.file || product.baseImage || '',
          });
        });
      });
    });
    return rows;
  }

  if (storageMode === 'airpods-model') {
    const modelList = models.length ? models : [{ capacity: product.name || productId, price: basePrice, file: product.baseImage }];
    modelList.forEach((model) => {
      addRow({
        specName: String(model.capacity || model.name || product.name || '').trim(),
        price: Number(model.price || basePrice) || basePrice,
        imageFile: model.file || product.baseImage || '',
      });
    });
    return rows;
  }

  if (storageMode === 'color-only') {
    const colorList = colors.length ? colors : [{ name: '默认款式', file: product.baseImage }];
    colorList.forEach((color) => {
      addRow({
        colorName: String(color.name || '').trim(),
        price: basePrice,
        imageFile: color.file || product.baseImage || '',
      });
    });
    return rows;
  }

  const colorList = colors.length ? colors : [{ name: '', file: product.baseImage }];
  const specList = storages.length ? storages : [{ capacity: '默认配置', price: storageMode === 'absolute' ? basePrice : 0 }];
  colorList.forEach((color) => {
    specList.forEach((storage) => {
      const storagePrice = Number(storage.price || 0) || 0;
      addRow({
        colorName: String(color.name || '').trim(),
        specName: String(storage.capacity || '').trim(),
        price: storageMode === 'absolute' ? storagePrice || basePrice : basePrice + storagePrice,
        imageFile: storage.file || color.file || product.baseImage || '',
      });
    });
  });
  return rows;
}

async function syncProductSkus(conn, productId, payload, defaultStock = 30) {
  const rows = buildSkuRowsFromProduct(productId, payload);
  if (!rows.length) {
    return;
  }

  for (const row of rows) {
    await conn.query(
      `
      INSERT INTO product_skus
        (product_id, sku_code, color_name, spec_name, connection_name, description, price, stock, image_url, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        sku_code = VALUES(sku_code),
        description = VALUES(description),
        price = VALUES(price),
        image_url = VALUES(image_url),
        config_json = VALUES(config_json),
        is_active = 1
      `,
      [
        productId,
        row.skuCode,
        row.colorName,
        row.specName,
        row.connectionName,
        row.description,
        row.price,
        defaultStock,
        row.imageUrl,
        row.configJson,
      ],
    );
  }

  await conn.query(
    'UPDATE product_skus SET is_active = 0 WHERE product_id = ? AND sku_code NOT IN (?)',
    [productId, rows.map((row) => row.skuCode)],
  );
}

async function ensureSkusForExistingCatalog() {
  const [rows] = await pool.query(
    `
    SELECT p.product_id, p.config_json
    FROM product_catalog p
    WHERE p.is_active = 1
      AND NOT EXISTS (
        SELECT 1
        FROM product_skus s
        WHERE s.product_id = p.product_id
        LIMIT 1
      )
    `,
  );
  if (!rows.length) {
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const row of rows) {
      await syncProductSkus(conn, row.product_id, parseJsonObject(row.config_json));
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account VARCHAR(191) NULL,
      email VARCHAR(191) NULL,
      phone VARCHAR(20) NULL,
      username VARCHAR(191) NULL,
      password_hash VARCHAR(255) NULL,
      password VARCHAR(255) NULL,
      role ENUM('customer', 'admin') NOT NULL DEFAULT 'customer',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await ensureColumn('users', 'account', 'account VARCHAR(191) NULL');
  await ensureColumn('users', 'email', 'email VARCHAR(191) NULL');
  await ensureColumn('users', 'phone', 'phone VARCHAR(20) NULL');
  await ensureColumn('users', 'username', 'username VARCHAR(191) NULL');
  await ensureColumn('users', 'password_hash', 'password_hash VARCHAR(255) NULL');
  await ensureColumn('users', 'password', 'password VARCHAR(255) NULL');
  await ensureColumn('users', 'role', "role ENUM('customer', 'admin') NOT NULL DEFAULT 'customer'");
  await loadUserColumns();
  await ensureIndex('CREATE UNIQUE INDEX uk_users_account ON users(account)');
  await ensureIndex('CREATE UNIQUE INDEX uk_users_email ON users(email)');
  await ensureIndex('CREATE UNIQUE INDEX uk_users_phone ON users(phone)');
  await ensureIndex('CREATE INDEX idx_users_role_created ON users(role, created_at)');
  await ensureIndex('CREATE INDEX idx_users_username ON users(username)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_comments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      product_id VARCHAR(120) NOT NULL,
      account VARCHAR(191) NOT NULL,
      content TEXT NOT NULL,
      parent_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_comments_product (product_id),
      INDEX idx_comments_parent (parent_id),
      INDEX idx_comments_created (created_at),
      CONSTRAINT fk_comments_parent
        FOREIGN KEY (parent_id) REFERENCES product_comments(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      comment_id BIGINT UNSIGNED NOT NULL,
      account VARCHAR(191) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_comment_likes (comment_id, account),
      INDEX idx_comment_likes_comment (comment_id),
      CONSTRAINT fk_comment_likes_comment
        FOREIGN KEY (comment_id) REFERENCES product_comments(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_catalog (
      product_id VARCHAR(120) NOT NULL,
      category VARCHAR(40) NOT NULL,
      name VARCHAR(191) NOT NULL,
      description TEXT NULL,
      base_price INT NOT NULL DEFAULT 0,
      config_json JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      primary_image VARCHAR(255)
        GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.baseImage'))) STORED,
      storage_mode VARCHAR(40)
        GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.storageMode'))) STORED,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (product_id),
      INDEX idx_product_catalog_category (category),
      INDEX idx_product_catalog_category_price (category, base_price),
      INDEX idx_product_catalog_storage_mode (storage_mode),
      FULLTEXT KEY ft_product_catalog_name_desc (name, description)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await ensureColumn('product_catalog', 'description', 'description TEXT NULL');
  await ensureColumn('product_catalog', 'is_active', 'is_active TINYINT(1) NOT NULL DEFAULT 1');
  try {
    await ensureColumn(
      'product_catalog',
      'primary_image',
      "primary_image VARCHAR(255) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.baseImage'))) STORED",
    );
    await ensureColumn(
      'product_catalog',
      'storage_mode',
      "storage_mode VARCHAR(40) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.storageMode'))) STORED",
    );
  } catch (error) {
    console.warn('生成列初始化失败，搜索接口会使用 JSON_EXTRACT 回退:', error.message);
  }
  await ensureIndex('CREATE INDEX idx_product_catalog_category_price ON product_catalog(category, base_price)');
  await ensureIndex('CREATE INDEX idx_product_catalog_active_category_updated ON product_catalog(is_active, category, updated_at)');
  try {
    await ensureIndex('CREATE INDEX idx_product_catalog_storage_mode ON product_catalog(storage_mode)');
  } catch (_error) {
  }
  await ensureIndex('CREATE FULLTEXT INDEX ft_product_catalog_name_desc ON product_catalog(name, description)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_skus (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      product_id VARCHAR(120) NOT NULL,
      sku_code VARCHAR(160) NOT NULL,
      color_name VARCHAR(120) NOT NULL DEFAULT '',
      spec_name VARCHAR(160) NOT NULL DEFAULT '',
      connection_name VARCHAR(120) NOT NULL DEFAULT '',
      description VARCHAR(500) NOT NULL,
      price INT NOT NULL DEFAULT 0,
      stock INT NOT NULL DEFAULT 0,
      sales_count INT NOT NULL DEFAULT 0,
      image_url VARCHAR(255) NULL,
      config_json JSON NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_product_skus_code (sku_code),
      UNIQUE KEY uk_product_skus_variant (product_id, color_name, spec_name, connection_name),
      KEY idx_product_skus_product_active (product_id, is_active),
      KEY idx_product_skus_stock (stock),
      KEY idx_product_skus_price (price),
      CONSTRAINT chk_product_skus_price CHECK (price >= 0),
      CONSTRAINT chk_product_skus_stock CHECK (stock >= 0),
      CONSTRAINT fk_product_skus_product
        FOREIGN KEY (product_id) REFERENCES product_catalog(product_id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await ensureColumn('product_skus', 'color_name', "color_name VARCHAR(120) NOT NULL DEFAULT ''");
  await ensureColumn('product_skus', 'spec_name', "spec_name VARCHAR(160) NOT NULL DEFAULT ''");
  await ensureColumn('product_skus', 'connection_name', "connection_name VARCHAR(120) NOT NULL DEFAULT ''");
  await ensureColumn('product_skus', 'config_json', 'config_json JSON NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_addresses (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      receiver_name VARCHAR(80) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      province VARCHAR(80) NOT NULL,
      city VARCHAR(80) NOT NULL,
      district VARCHAR(80) NOT NULL DEFAULT '',
      detail VARCHAR(255) NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      deleted_at DATETIME NULL,
      default_user_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_user_addresses_default (default_user_id),
      KEY idx_user_addresses_user_deleted (user_id, deleted_at),
      KEY idx_user_addresses_phone (phone),
      CONSTRAINT fk_user_addresses_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      sku_id BIGINT UNSIGNED NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      selected TINYINT(1) NOT NULL DEFAULT 1,
      snapshot_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_cart_items_user_sku (user_id, sku_id),
      KEY idx_cart_items_user_created (user_id, created_at),
      KEY idx_cart_items_sku (sku_id),
      CONSTRAINT chk_cart_items_quantity CHECK (quantity > 0),
      CONSTRAINT fk_cart_items_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_cart_items_sku
        FOREIGN KEY (sku_id) REFERENCES product_skus(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_no VARCHAR(40) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      address_id BIGINT UNSIGNED NULL,
      status ENUM('pending', 'paid', 'shipped', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
      total_amount INT NOT NULL DEFAULT 0,
      item_count INT NOT NULL DEFAULT 0,
      paid_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_orders_order_no (order_no),
      KEY idx_orders_user_created (user_id, created_at),
      KEY idx_orders_status_created (status, created_at),
      KEY idx_orders_address (address_id),
      CONSTRAINT chk_orders_total_amount CHECK (total_amount >= 0),
      CONSTRAINT fk_orders_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_orders_address
        FOREIGN KEY (address_id) REFERENCES user_addresses(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      sku_id BIGINT UNSIGNED NULL,
      product_id VARCHAR(120) NOT NULL,
      product_name VARCHAR(191) NOT NULL,
      sku_description VARCHAR(500) NOT NULL,
      unit_price INT NOT NULL DEFAULT 0,
      quantity INT NOT NULL DEFAULT 1,
      subtotal INT NOT NULL DEFAULT 0,
      image_url VARCHAR(255) NULL,
      snapshot_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_order_items_order (order_id),
      KEY idx_order_items_product (product_id),
      KEY idx_order_items_sku (sku_id),
      CONSTRAINT chk_order_items_quantity CHECK (quantity > 0),
      CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_order_items_sku
        FOREIGN KEY (sku_id) REFERENCES product_skus(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      method ENUM('mock_card', 'wechat', 'alipay', 'apple_pay') NOT NULL DEFAULT 'apple_pay',
      amount INT NOT NULL DEFAULT 0,
      status ENUM('pending', 'paid', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
      transaction_no VARCHAR(80) NULL,
      paid_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_payments_order (order_id),
      UNIQUE KEY uk_payments_transaction (transaction_no),
      KEY idx_payments_status_paid (status, paid_at),
      CONSTRAINT fk_payments_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      status ENUM('pending', 'shipped', 'delivered') NOT NULL DEFAULT 'pending',
      carrier VARCHAR(80) NULL,
      tracking_no VARCHAR(80) NULL,
      shipped_at DATETIME NULL,
      delivered_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_shipments_order (order_id),
      KEY idx_shipments_tracking (tracking_no),
      CONSTRAINT fk_shipments_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_status_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      from_status VARCHAR(30) NULL,
      to_status VARCHAR(30) NOT NULL,
      note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_order_status_logs_order_created (order_id, created_at),
      CONSTRAINT fk_order_status_logs_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      sku_id BIGINT UNSIGNED NOT NULL,
      change_type ENUM('manual_adjust', 'stock_in', 'order_paid', 'order_cancel') NOT NULL,
      quantity_delta INT NOT NULL,
      stock_after INT NOT NULL,
      reference_type VARCHAR(40) NULL,
      reference_id BIGINT UNSIGNED NULL,
      operator VARCHAR(191) NULL,
      note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_inventory_logs_sku_created (sku_id, created_at),
      KEY idx_inventory_logs_type_created (change_type, created_at),
      CONSTRAINT fk_inventory_logs_sku
        FOREIGN KEY (sku_id) REFERENCES product_skus(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_price_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      sku_id BIGINT UNSIGNED NOT NULL,
      old_price INT NOT NULL,
      new_price INT NOT NULL,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_price_history_sku_changed (sku_id, changed_at),
      CONSTRAINT fk_price_history_sku
        FOREIGN KEY (sku_id) REFERENCES product_skus(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_search_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account VARCHAR(191) NULL,
      keyword VARCHAR(191) NOT NULL,
      category VARCHAR(40) NULL,
      result_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_search_logs_keyword_created (keyword, created_at),
      KEY idx_search_logs_category_created (category, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_store_data (
      user_id BIGINT UNSIGNED NOT NULL,
      cart_json JSON NOT NULL,
      orders_json JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_user_store_data_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      admin_account VARCHAR(191) NOT NULL,
      action VARCHAR(80) NOT NULL,
      target_type VARCHAR(80) NOT NULL,
      target_id VARCHAR(191) NULL,
      detail_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_audit_admin_created (admin_account, created_at),
      KEY idx_admin_audit_action_created (action, created_at),
      KEY idx_admin_audit_target (target_type, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await ensureIndex('CREATE INDEX idx_orders_user_status_created ON orders(user_id, status, created_at)');
  await ensureIndex('CREATE INDEX idx_product_skus_active_stock ON product_skus(is_active, stock)');
  await ensureIndex('CREATE INDEX idx_user_addresses_user_default ON user_addresses(user_id, is_default, deleted_at)');

  await pool.query('DROP PROCEDURE IF EXISTS sp_adjust_inventory');
  await pool.query(`
    CREATE PROCEDURE sp_adjust_inventory(
      IN p_sku_id BIGINT UNSIGNED,
      IN p_delta INT,
      IN p_operator VARCHAR(191),
      IN p_note VARCHAR(255)
    )
    BEGIN
      DECLARE v_stock INT DEFAULT 0;
      DECLARE v_rows INT DEFAULT 0;

      UPDATE product_skus
      SET stock = stock + p_delta
      WHERE id = p_sku_id
        AND stock + p_delta >= 0;

      SET v_rows = ROW_COUNT();
      IF v_rows = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '库存不足或 SKU 不存在';
      END IF;

      SELECT stock INTO v_stock
      FROM product_skus
      WHERE id = p_sku_id;

      INSERT INTO inventory_logs
        (sku_id, change_type, quantity_delta, stock_after, reference_type, operator, note)
      VALUES
        (p_sku_id, 'manual_adjust', p_delta, v_stock, 'admin', p_operator, p_note);

      SELECT v_stock AS stock_after;
    END
  `);

  await pool.query('DROP TRIGGER IF EXISTS trg_product_skus_price_history');
  await pool.query(`
    CREATE TRIGGER trg_product_skus_price_history
    AFTER UPDATE ON product_skus
    FOR EACH ROW
    BEGIN
      IF OLD.price <> NEW.price THEN
        INSERT INTO product_price_history (sku_id, old_price, new_price)
        VALUES (NEW.id, OLD.price, NEW.price);
      END IF;
    END
  `);

  await pool.query(`
    CREATE OR REPLACE VIEW v_product_sales_rank AS
    SELECT
      p.product_id,
      p.category,
      p.name,
      COALESCE(SUM(oi.quantity), 0) AS total_sales,
      COALESCE(SUM(oi.subtotal), 0) AS total_revenue,
      RANK() OVER (ORDER BY COALESCE(SUM(oi.quantity), 0) DESC) AS sales_rank
    FROM product_catalog p
    LEFT JOIN order_items oi ON oi.product_id = p.product_id
    GROUP BY p.product_id, p.category, p.name
  `);

  await pool.query(`
    CREATE OR REPLACE VIEW v_inventory_status AS
    SELECT
      p.product_id,
      p.category,
      p.name,
      s.id AS sku_id,
      s.sku_code,
      s.description AS sku_description,
      s.price,
      s.stock,
      s.sales_count,
      CASE
        WHEN s.stock = 0 THEN 'out_of_stock'
        WHEN s.stock < 5 THEN 'low_stock'
        ELSE 'available'
      END AS stock_status
    FROM product_catalog p
    JOIN product_skus s ON s.product_id = p.product_id
    WHERE p.is_active = 1
      AND s.is_active = 1
  `);

  await ensureSkusForExistingCatalog();
  await ensureDefaultAdminUser();
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
  if (userColumns.has('username')) {
    clauses.push('username = ?');
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

async function ensureDefaultAdminUser() {
  const admin = await findUserByAccount(DEFAULT_ADMIN_ACCOUNT);
  const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  if (admin) {
    const updateMap = {};
    if (userColumns.has('account')) updateMap.account = DEFAULT_ADMIN_ACCOUNT;
    if (userColumns.has('email')) updateMap.email = null;
    if (userColumns.has('phone')) updateMap.phone = null;
    if (userColumns.has('username')) updateMap.username = DEFAULT_ADMIN_ACCOUNT;
    if (userColumns.has('password_hash')) updateMap.password_hash = hash;
    if (userColumns.has('password')) updateMap.password = null;
    if (userColumns.has('role')) updateMap.role = 'admin';
    const entries = Object.entries(updateMap);
    if (entries.length) {
      await pool.query(
        `UPDATE users SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...entries.map(([, value]) => value), admin.id],
      );
    }
    return;
  }

  const insertMap = {};
  if (userColumns.has('account')) insertMap.account = DEFAULT_ADMIN_ACCOUNT;
  if (userColumns.has('email')) insertMap.email = null;
  if (userColumns.has('phone')) insertMap.phone = null;
  if (userColumns.has('username')) insertMap.username = DEFAULT_ADMIN_ACCOUNT;
  if (userColumns.has('password_hash')) insertMap.password_hash = hash;
  if (userColumns.has('password')) insertMap.password = null;
  if (userColumns.has('role')) insertMap.role = 'admin';

  const columns = Object.keys(insertMap);
  const values = Object.values(insertMap);
  if (!columns.length) {
    return;
  }

  await pool.query(
    `INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
}

async function resolveValidAccount(rawAccount) {
  const normalized = normalizeAccount(rawAccount);
  if (!normalized) {
    return { ok: false, status: 400, message: '请先登录后再操作' };
  }

  const user = await findUserByAccount(normalized);
  if (!user) {
    return { ok: false, status: 401, message: '登录状态已失效，请重新登录' };
  }

  return { ok: true, account: normalized, userId: user.id, user };
}

async function resolveAdminAccount(rawAccount) {
  const accountCheck = await resolveValidAccount(rawAccount);
  if (!accountCheck.ok) {
    return accountCheck;
  }
  if (accountCheck.account !== DEFAULT_ADMIN_ACCOUNT || accountCheck.user.role !== 'admin') {
    return { ok: false, status: 403, message: '需要管理员账号才能访问后台' };
  }
  return accountCheck;
}

function sanitizeCommentText(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  return text;
}

function parseArrayJson(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }
  return [];
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function normalizePositiveInt(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeSearchKeyword(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5@.]+/g, '');
}

function generateOrderNo() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `AS${stamp}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getProductImageFromConfig(configJson, fallback = '') {
  const config = parseJsonObject(configJson);
  return config.baseImage || fallback || '';
}

function toImagePath(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value) || value.startsWith('../') || value.startsWith('/')) {
    return value;
  }
  return `../images/${value}`;
}

function sanitizeUploadFileName(value) {
  const ext = path.extname(String(value || '')).toLowerCase();
  const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  return allowedExt.includes(ext) ? ext : '.png';
}

async function saveUploadedImageFromDataUrl(file) {
  if (!file || typeof file !== 'object') {
    return '';
  }
  const dataUrl = String(file.dataUrl || '');
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    return '';
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('图片大小不能超过 8MB'), { statusCode: 400 });
  }
  await fs.mkdir(uploadDir, { recursive: true });
  const ext = sanitizeUploadFileName(file.name || `upload.${match[1]}`);
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  await fs.writeFile(path.join(uploadDir, fileName), buffer);
  return `uploads/${fileName}`;
}

function mapCartRow(row) {
  return {
    cartItemId: row.cart_item_id,
    skuId: row.sku_id,
    productId: row.product_id,
    name: row.product_name,
    selection: row.sku_description,
    price: Number(row.price || 0),
    quantity: Number(row.quantity || 1),
    stock: Number(row.stock || 0),
    image: toImagePath(row.image_url || row.product_image),
    createdAt: row.created_at,
  };
}

function mapOrderRows(rows) {
  const orderMap = new Map();
  rows.forEach((row) => {
    if (!orderMap.has(row.order_id)) {
      orderMap.set(row.order_id, {
        id: row.order_id,
        orderNo: row.order_no,
        status: row.status,
        totalAmount: Number(row.total_amount || 0),
        itemCount: Number(row.item_count || 0),
        paidAt: row.paid_at,
        createdAt: row.created_at,
        address: row.address_id
          ? {
              id: row.address_id,
              receiverName: row.receiver_name,
              phone: row.address_phone,
              province: row.province,
              city: row.city,
              district: row.district,
              detail: row.detail,
            }
          : null,
        items: [],
      });
    }
    if (row.order_item_id) {
      orderMap.get(row.order_id).items.push({
        id: row.order_item_id,
        skuId: row.sku_id,
        productId: row.product_id,
        name: row.product_name,
        selection: row.sku_description,
        price: Number(row.unit_price || 0),
        quantity: Number(row.quantity || 1),
        subtotal: Number(row.subtotal || 0),
        image: toImagePath(row.image_url),
      });
    }
  });
  return Array.from(orderMap.values());
}

async function fetchCartItems(userId) {
  const [rows] = await pool.query(
    `
    SELECT
      ci.id AS cart_item_id,
      ci.quantity,
      ci.created_at,
      s.id AS sku_id,
      s.product_id,
      s.description AS sku_description,
      s.price,
      s.stock,
      s.image_url,
      p.name AS product_name,
      JSON_UNQUOTE(JSON_EXTRACT(p.config_json, '$.baseImage')) AS product_image
    FROM cart_items ci
    JOIN product_skus s ON s.id = ci.sku_id
    JOIN product_catalog p ON p.product_id = s.product_id
    WHERE ci.user_id = ?
      AND s.is_active = 1
      AND p.is_active = 1
    ORDER BY ci.created_at DESC
    `,
    [userId],
  );
  return rows.map(mapCartRow);
}

async function fetchOrders(userId) {
  const [rows] = await pool.query(
    `
    SELECT
      o.id AS order_id,
      o.order_no,
      o.status,
      o.total_amount,
      o.item_count,
      o.paid_at,
      o.created_at,
      a.id AS address_id,
      a.receiver_name,
      a.phone AS address_phone,
      a.province,
      a.city,
      a.district,
      a.detail,
      oi.id AS order_item_id,
      oi.sku_id,
      oi.product_id,
      oi.product_name,
      oi.sku_description,
      oi.unit_price,
      oi.quantity,
      oi.subtotal,
      oi.image_url
    FROM orders o
    LEFT JOIN user_addresses a ON a.id = o.address_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC, oi.id ASC
    `,
    [userId],
  );
  return mapOrderRows(rows);
}

async function getDefaultAddressId(conn, userId, requestedAddressId) {
  if (requestedAddressId) {
    const [rows] = await conn.query(
      'SELECT id FROM user_addresses WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',
      [requestedAddressId, userId],
    );
    if (!rows.length) {
      throw Object.assign(new Error('收货地址不存在'), { statusCode: 400 });
    }
    return requestedAddressId;
  }

  const [rows] = await conn.query(
    'SELECT id FROM user_addresses WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, created_at ASC LIMIT 1',
    [userId],
  );
  return rows[0] ? rows[0].id : null;
}

async function createPaidOrder({ userId, addressId, cartItemIds = [], directItems = [] }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const finalAddressId = await getDefaultAddressId(conn, userId, addressId);
    let checkoutItems = [];

    if (cartItemIds.length) {
      const [cartRows] = await conn.query(
        `
        SELECT id, sku_id, quantity
        FROM cart_items
        WHERE user_id = ?
          AND id IN (?)
        FOR UPDATE
        `,
        [userId, cartItemIds],
      );
      if (cartRows.length !== cartItemIds.length) {
        throw Object.assign(new Error('部分购物车商品不存在，请刷新后重试'), { statusCode: 400 });
      }
      checkoutItems = cartRows.map((item) => ({
        skuId: item.sku_id,
        quantity: normalizePositiveInt(item.quantity, 1),
        cartItemId: item.id,
      }));
    } else {
      checkoutItems = directItems.map((item) => ({
        skuId: Number(item.skuId || 0),
        quantity: normalizePositiveInt(item.quantity, 1),
      }));
    }

    if (!checkoutItems.length || checkoutItems.some((item) => !Number.isInteger(item.skuId) || item.skuId <= 0)) {
      throw Object.assign(new Error('请选择要结算的商品'), { statusCode: 400 });
    }

    const normalizedBySku = new Map();
    checkoutItems.forEach((item) => {
      const existing = normalizedBySku.get(item.skuId) || { skuId: item.skuId, quantity: 0, cartItemIds: [] };
      existing.quantity += item.quantity;
      if (item.cartItemId) {
        existing.cartItemIds.push(item.cartItemId);
      }
      normalizedBySku.set(item.skuId, existing);
    });

    const orderItems = [];
    for (const item of normalizedBySku.values()) {
      const [skuRows] = await conn.query(
        `
        SELECT
          s.id AS sku_id,
          s.product_id,
          s.description AS sku_description,
          s.price,
          s.stock,
          s.image_url,
          s.config_json,
          p.name AS product_name,
          p.config_json AS product_config
        FROM product_skus s
        JOIN product_catalog p ON p.product_id = s.product_id
        WHERE s.id = ?
          AND s.is_active = 1
          AND p.is_active = 1
        FOR UPDATE
        `,
        [item.skuId],
      );
      const sku = skuRows[0];
      if (!sku) {
        throw Object.assign(new Error('商品规格不存在或已下架'), { statusCode: 400 });
      }
      if (Number(sku.stock || 0) < item.quantity) {
        throw Object.assign(new Error(`${sku.product_name} ${sku.sku_description} 库存不足`), { statusCode: 409 });
      }

      const stockAfter = Number(sku.stock) - item.quantity;
      await conn.query(
        'UPDATE product_skus SET stock = ?, sales_count = sales_count + ? WHERE id = ?',
        [stockAfter, item.quantity, sku.sku_id],
      );
      orderItems.push({
        skuId: sku.sku_id,
        productId: sku.product_id,
        productName: sku.product_name,
        skuDescription: sku.sku_description,
        unitPrice: Number(sku.price || 0),
        quantity: item.quantity,
        subtotal: Number(sku.price || 0) * item.quantity,
        imageUrl: sku.image_url || getProductImageFromConfig(sku.product_config),
        snapshotJson: JSON.stringify({
          sku: parseJsonObject(sku.config_json),
          product: parseJsonObject(sku.product_config),
        }),
        stockAfter,
      });
    }

    const totalAmount = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const itemCount = orderItems.reduce((sum, item) => sum + item.quantity, 0);
    const orderNo = generateOrderNo();
    const [orderResult] = await conn.query(
      `
      INSERT INTO orders (order_no, user_id, address_id, status, total_amount, item_count, paid_at)
      VALUES (?, ?, ?, 'paid', ?, ?, NOW())
      `,
      [orderNo, userId, finalAddressId, totalAmount, itemCount],
    );
    const orderId = orderResult.insertId;

    for (const item of orderItems) {
      await conn.query(
        `
        INSERT INTO order_items
          (order_id, sku_id, product_id, product_name, sku_description, unit_price, quantity, subtotal, image_url, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          orderId,
          item.skuId,
          item.productId,
          item.productName,
          item.skuDescription,
          item.unitPrice,
          item.quantity,
          item.subtotal,
          item.imageUrl,
          item.snapshotJson,
        ],
      );
      await conn.query(
        `
        INSERT INTO inventory_logs
          (sku_id, change_type, quantity_delta, stock_after, reference_type, reference_id, operator, note)
        VALUES (?, 'order_paid', ?, ?, 'order', ?, 'checkout', ?)
        `,
        [item.skuId, -item.quantity, item.stockAfter, orderId, orderNo],
      );
    }

    await conn.query(
      `
      INSERT INTO payments (order_id, method, amount, status, transaction_no, paid_at)
      VALUES (?, 'apple_pay', ?, 'paid', ?, NOW())
      `,
      [orderId, totalAmount, `PAY${orderNo}`],
    );
    await conn.query(
      'INSERT INTO shipments (order_id, status) VALUES (?, ?)',
      [orderId, 'pending'],
    );
    await conn.query(
      'INSERT INTO order_status_logs (order_id, from_status, to_status, note) VALUES (?, ?, ?, ?)',
      [orderId, null, 'paid', '模拟支付成功并扣减库存'],
    );

    if (cartItemIds.length) {
      await conn.query('DELETE FROM cart_items WHERE user_id = ? AND id IN (?)', [userId, cartItemIds]);
    }

    await conn.commit();
    return { orderId, orderNo, totalAmount, itemCount };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

app.get('/api/products/catalog', (req, res) => {
  (async () => {
    const [rows] = await pool.query(
      'SELECT product_id, config_json FROM product_catalog WHERE is_active = 1 ORDER BY category ASC, name ASC',
    );

    const products = {};
    rows.forEach((item) => {
      const payload = typeof item.config_json === 'string'
        ? (() => {
            try {
              return JSON.parse(item.config_json);
            } catch (_error) {
              return null;
            }
          })()
        : item.config_json;
      if (payload && typeof payload === 'object') {
        products[item.product_id] = payload;
      }
    });

    return res.json({ success: true, products });
  })().catch((error) => {
    console.error('查询商品目录错误:', error.message);
    return res.status(500).json({ success: false, message: '获取商品目录失败，请稍后重试' });
  });
});

app.post('/api/products/catalog/sync', (req, res) => {
  (async () => {
    const products = req.body.products;
    if (!products || typeof products !== 'object' || Array.isArray(products)) {
      return res.status(400).json({ success: false, message: '商品目录数据无效' });
    }

    const entries = Object.entries(products).filter(([key, value]) => key && value && typeof value === 'object');
    if (!entries.length) {
      return res.status(400).json({ success: false, message: '商品目录为空' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const [productId, payload] of entries) {
        const rawCategory = String(payload.category || '').trim().toLowerCase();
        const category = PRODUCT_CATEGORIES.has(rawCategory) ? rawCategory : 'mac';
        const name = String(payload.name || productId).trim();
        const basePrice = Number(payload.price || 0);
        const description = String(payload.description || `${name} Apple Store 商品`).trim();
        await conn.query(
          `
          INSERT INTO product_catalog (product_id, category, name, description, base_price, config_json, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
          ON DUPLICATE KEY UPDATE
            category = VALUES(category),
            name = VALUES(name),
            description = VALUES(description),
            base_price = VALUES(base_price),
            config_json = VALUES(config_json),
            is_active = 1
          `,
          [productId, category, name, description, Number.isFinite(basePrice) ? basePrice : 0, JSON.stringify(payload)],
        );
        await syncProductSkus(conn, productId, payload);
      }

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return res.json({ success: true, count: entries.length, message: '商品目录已同步到数据库' });
  })().catch((error) => {
    console.error('同步商品目录错误:', error.message);
    return res.status(500).json({ success: false, message: '同步商品目录失败，请稍后重试' });
  });
});

app.get('/api/products/search', (req, res) => {
  (async () => {
    const keyword = String(req.query.q || '').trim();
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    const category = String(req.query.category || '').trim();
    const sort = String(req.query.sort || 'popular').trim();
    const account = normalizeAccount(req.query.account || '');
    const params = [];
    const where = ['p.is_active = 1'];

    if (category) {
      where.push('p.category = ?');
      params.push(category);
    }

    if (keyword) {
      where.push('(p.name LIKE ? OR p.description LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    let orderSql = 'total_sales DESC, updated_at DESC';
    if (sort === 'priceAsc') {
      orderSql = 'min_price ASC, p.name ASC';
    } else if (sort === 'priceDesc') {
      orderSql = 'min_price DESC, p.name ASC';
    } else if (sort === 'newest') {
      orderSql = 'updated_at DESC';
    }

    const [rows] = await pool.query(
      `
      SELECT
        p.product_id,
        p.category,
        p.name,
        p.description,
        p.base_price,
        MAX(JSON_UNQUOTE(JSON_EXTRACT(p.config_json, '$.baseImage'))) AS image_url,
        COALESCE(MIN(CASE WHEN s.is_active = 1 THEN s.price END), p.base_price) AS min_price,
        COALESCE(SUM(CASE WHEN s.is_active = 1 THEN s.stock ELSE 0 END), 0) AS total_stock,
        COALESCE(SUM(CASE WHEN s.is_active = 1 THEN s.sales_count ELSE 0 END), 0) AS total_sales,
        MAX(p.updated_at) AS updated_at
      FROM product_catalog p
      LEFT JOIN product_skus s ON s.product_id = p.product_id
      WHERE ${where.join(' AND ')}
      GROUP BY p.product_id, p.category, p.name, p.description, p.base_price
      ORDER BY ${orderSql}
      LIMIT 40
      `,
      params,
    );

    if (keyword || category) {
      await pool.query(
        'INSERT INTO product_search_logs (account, keyword, category, result_count) VALUES (?, ?, ?, ?)',
        [account || null, keyword || '', category || null, rows.length],
      );
    }

    return res.json({
      success: true,
      products: rows.map((item) => ({
        productId: item.product_id,
        category: item.category,
        name: item.name,
        description: item.description || '',
        price: Number(item.min_price || item.base_price || 0),
        stock: Number(item.total_stock || 0),
        sales: Number(item.total_sales || 0),
        image: toImagePath(item.image_url),
      })),
    });
  })().catch((error) => {
    console.error('搜索商品错误:', error.message);
    return res.status(500).json({ success: false, message: '搜索商品失败，请稍后重试' });
  });
});

app.get('/api/products/:productId/skus', (req, res) => {
  (async () => {
    const productId = String(req.params.productId || '').trim();
    if (!productId) {
      return res.status(400).json({ success: false, message: '商品标识不能为空' });
    }

    const [rows] = await pool.query(
      `
      SELECT id, sku_code, color_name, spec_name, connection_name, description, price, stock, sales_count, image_url
      FROM product_skus
      WHERE product_id = ?
        AND is_active = 1
      ORDER BY price ASC, id ASC
      `,
      [productId],
    );

    return res.json({
      success: true,
      skus: rows.map((item) => ({
        id: item.id,
        skuCode: item.sku_code,
        colorName: item.color_name,
        specName: item.spec_name,
        connectionName: item.connection_name,
        description: item.description,
        price: Number(item.price || 0),
        stock: Number(item.stock || 0),
        salesCount: Number(item.sales_count || 0),
        image: toImagePath(item.image_url),
      })),
    });
  })().catch((error) => {
    console.error('查询 SKU 错误:', error.message);
    return res.status(500).json({ success: false, message: '查询商品库存失败，请稍后重试' });
  });
});

app.get('/api/user-store/:account', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.params.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const [cart, orders] = await Promise.all([
      fetchCartItems(accountCheck.userId),
      fetchOrders(accountCheck.userId),
    ]);
    return res.json({ success: true, cart, orders });
  })().catch((error) => {
    console.error('读取用户存储数据错误:', error.message);
    return res.status(500).json({ success: false, message: '读取购物车/订单失败，请稍后重试' });
  });
});

app.put('/api/user-store/:account/cart', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.params.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const cart = Array.isArray(req.body.cart) ? req.body.cart : null;
    if (!cart) {
      return res.status(400).json({ success: false, message: '购物车数据格式错误' });
    }

    await pool.query(
      `
      INSERT INTO user_store_data (user_id, cart_json, orders_json)
      VALUES (?, ?, JSON_ARRAY())
      ON DUPLICATE KEY UPDATE cart_json = VALUES(cart_json)
      `,
      [accountCheck.userId, JSON.stringify(cart)],
    );

    return res.json({ success: true, message: '购物车已同步到数据库' });
  })().catch((error) => {
    console.error('同步购物车错误:', error.message);
    return res.status(500).json({ success: false, message: '同步购物车失败，请稍后重试' });
  });
});

app.put('/api/user-store/:account/orders', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.params.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const orders = Array.isArray(req.body.orders) ? req.body.orders : null;
    if (!orders) {
      return res.status(400).json({ success: false, message: '订单数据格式错误' });
    }

    await pool.query(
      `
      INSERT INTO user_store_data (user_id, cart_json, orders_json)
      VALUES (?, JSON_ARRAY(), ?)
      ON DUPLICATE KEY UPDATE orders_json = VALUES(orders_json)
      `,
      [accountCheck.userId, JSON.stringify(orders)],
    );

    return res.json({ success: true, message: '订单已同步到数据库' });
  })().catch((error) => {
    console.error('同步订单错误:', error.message);
    return res.status(500).json({ success: false, message: '同步订单失败，请稍后重试' });
  });
});

app.get('/api/cart/:account', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.params.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const cart = await fetchCartItems(accountCheck.userId);
    return res.json({ success: true, cart });
  })().catch((error) => {
    console.error('读取购物车错误:', error.message);
    return res.status(500).json({ success: false, message: '读取购物车失败，请稍后重试' });
  });
});

app.post('/api/cart/items', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const skuId = Number(req.body.skuId || 0);
    const quantity = normalizePositiveInt(req.body.quantity, 1);
    if (!Number.isInteger(skuId) || skuId <= 0) {
      return res.status(400).json({ success: false, message: '请选择有效的商品规格' });
    }

    const [skuRows] = await pool.query(
      `
      SELECT
        s.id,
        s.stock,
        s.price,
        s.description,
        s.image_url,
        p.product_id,
        p.name,
        p.config_json
      FROM product_skus s
      JOIN product_catalog p ON p.product_id = s.product_id
      WHERE s.id = ?
        AND s.is_active = 1
        AND p.is_active = 1
      LIMIT 1
      `,
      [skuId],
    );
    const sku = skuRows[0];
    if (!sku) {
      return res.status(404).json({ success: false, message: '商品规格不存在或已下架' });
    }
    if (Number(sku.stock || 0) < quantity) {
      return res.status(409).json({ success: false, message: '库存不足，暂时无法加入购物车' });
    }

    await pool.query(
      `
      INSERT INTO cart_items (user_id, sku_id, quantity, snapshot_json)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        quantity = LEAST(quantity + VALUES(quantity), 99),
        snapshot_json = VALUES(snapshot_json),
        selected = 1
      `,
      [
        accountCheck.userId,
        skuId,
        quantity,
        JSON.stringify({
          productId: sku.product_id,
          name: sku.name,
          selection: sku.description,
          price: sku.price,
          image: sku.image_url || getProductImageFromConfig(sku.config_json),
        }),
      ],
    );

    const cart = await fetchCartItems(accountCheck.userId);
    return res.json({ success: true, cart, message: '已加入购物车' });
  })().catch((error) => {
    console.error('加入购物车错误:', error.message);
    return res.status(500).json({ success: false, message: '加入购物车失败，请稍后重试' });
  });
});

app.delete('/api/cart/items/:cartItemId', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const cartItemId = Number(req.params.cartItemId || 0);
    if (!Number.isInteger(cartItemId) || cartItemId <= 0) {
      return res.status(400).json({ success: false, message: '购物车项目无效' });
    }

    await pool.query('DELETE FROM cart_items WHERE id = ? AND user_id = ?', [cartItemId, accountCheck.userId]);
    const cart = await fetchCartItems(accountCheck.userId);
    return res.json({ success: true, cart, message: '已移除购物车商品' });
  })().catch((error) => {
    console.error('移除购物车错误:', error.message);
    return res.status(500).json({ success: false, message: '移除购物车商品失败，请稍后重试' });
  });
});

app.post('/api/orders/checkout', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const cartItemIds = Array.isArray(req.body.cartItemIds)
      ? Array.from(new Set(req.body.cartItemIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)))
      : [];
    const directItems = Array.isArray(req.body.items) ? req.body.items : [];
    const addressId = Number(req.body.addressId || 0) || null;

    const order = await createPaidOrder({
      userId: accountCheck.userId,
      addressId,
      cartItemIds,
      directItems,
    });
    const orders = await fetchOrders(accountCheck.userId);
    const cart = await fetchCartItems(accountCheck.userId);
    return res.json({ success: true, order, orders, cart, message: '支付成功，订单已生成' });
  })().catch((error) => {
    console.error('结算错误:', error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || '结算失败，请稍后重试',
    });
  });
});

app.get('/api/orders/:account', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.params.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const orders = await fetchOrders(accountCheck.userId);
    return res.json({ success: true, orders });
  })().catch((error) => {
    console.error('读取订单错误:', error.message);
    return res.status(500).json({ success: false, message: '读取订单失败，请稍后重试' });
  });
});

app.get('/api/addresses/:account', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.params.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const [rows] = await pool.query(
      `
      SELECT id, receiver_name, phone, province, city, district, detail, is_default, created_at
      FROM user_addresses
      WHERE user_id = ?
        AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at DESC
      `,
      [accountCheck.userId],
    );

    return res.json({
      success: true,
      addresses: rows.map((item) => ({
        id: item.id,
        receiverName: item.receiver_name,
        phone: item.phone,
        province: item.province,
        city: item.city,
        district: item.district,
        detail: item.detail,
        isDefault: Number(item.is_default) === 1,
        createdAt: item.created_at,
      })),
    });
  })().catch((error) => {
    console.error('读取地址错误:', error.message);
    return res.status(500).json({ success: false, message: '读取收货地址失败，请稍后重试' });
  });
});

app.post('/api/addresses', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const receiverName = String(req.body.receiverName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const province = String(req.body.province || '').trim();
    const city = String(req.body.city || '').trim();
    const district = String(req.body.district || '').trim();
    const detail = String(req.body.detail || '').trim();
    const isDefault = req.body.isDefault ? 1 : 0;

    if (!receiverName || !phone || !province || !city || !detail) {
      return res.status(400).json({ success: false, message: '请填写完整的收货地址' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (isDefault) {
        await conn.query(
          'UPDATE user_addresses SET is_default = 0, default_user_id = NULL WHERE user_id = ? AND deleted_at IS NULL',
          [accountCheck.userId],
        );
      }
      await conn.query(
        `
        INSERT INTO user_addresses
          (user_id, receiver_name, phone, province, city, district, detail, is_default, default_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          accountCheck.userId,
          receiverName,
          phone,
          province,
          city,
          district,
          detail,
          isDefault,
          isDefault ? accountCheck.userId : null,
        ],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return res.json({ success: true, message: '收货地址已保存' });
  })().catch((error) => {
    console.error('保存地址错误:', error.message);
    return res.status(500).json({ success: false, message: '保存收货地址失败，请稍后重试' });
  });
});

app.put('/api/addresses/:addressId', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const addressId = Number(req.params.addressId || 0);
    const isDefault = req.body.isDefault ? 1 : 0;
    if (!Number.isInteger(addressId) || addressId <= 0) {
      return res.status(400).json({ success: false, message: '地址标识无效' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (isDefault) {
        await conn.query(
          'UPDATE user_addresses SET is_default = 0, default_user_id = NULL WHERE user_id = ? AND deleted_at IS NULL',
          [accountCheck.userId],
        );
      }
      const [result] = await conn.query(
        `
        UPDATE user_addresses
        SET
          receiver_name = ?,
          phone = ?,
          province = ?,
          city = ?,
          district = ?,
          detail = ?,
          is_default = ?,
          default_user_id = ?
        WHERE id = ?
          AND user_id = ?
          AND deleted_at IS NULL
        `,
        [
          String(req.body.receiverName || '').trim(),
          String(req.body.phone || '').trim(),
          String(req.body.province || '').trim(),
          String(req.body.city || '').trim(),
          String(req.body.district || '').trim(),
          String(req.body.detail || '').trim(),
          isDefault,
          isDefault ? accountCheck.userId : null,
          addressId,
          accountCheck.userId,
        ],
      );
      if (!result.affectedRows) {
        throw Object.assign(new Error('收货地址不存在'), { statusCode: 404 });
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return res.json({ success: true, message: '收货地址已更新' });
  })().catch((error) => {
    console.error('更新地址错误:', error.message);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || '更新收货地址失败' });
  });
});

app.delete('/api/addresses/:addressId', (req, res) => {
  (async () => {
    const accountCheck = await resolveValidAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const addressId = Number(req.params.addressId || 0);
    if (!Number.isInteger(addressId) || addressId <= 0) {
      return res.status(400).json({ success: false, message: '地址标识无效' });
    }

    await pool.query(
      'UPDATE user_addresses SET deleted_at = NOW(), is_default = 0, default_user_id = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [addressId, accountCheck.userId],
    );
    return res.json({ success: true, message: '收货地址已删除' });
  })().catch((error) => {
    console.error('删除地址错误:', error.message);
    return res.status(500).json({ success: false, message: '删除收货地址失败，请稍后重试' });
  });
});

app.get('/api/products/:productId/comments', (req, res) => {
  (async () => {
    const productId = String(req.params.productId || '').trim();
    const viewer = normalizeAccount(req.query.account || '');
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 5), 1), 20);
    const sortBy = String(req.query.sortBy || 'time').toLowerCase() === 'likes' ? 'likes' : 'time';
    const offset = (page - 1) * pageSize;
    const rootOrderSql =
      sortBy === 'likes'
        ? 'IFNULL(like_info.like_count, 0) DESC, c.created_at DESC'
        : 'c.created_at DESC';

    if (!productId) {
      return res.status(400).json({ success: false, message: '商品标识不能为空' });
    }

    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM product_comments WHERE product_id = ? AND parent_id IS NULL',
      [productId],
    );
    const total = Number((countRows[0] && countRows[0].total) || 0);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * pageSize;

    const [totalCommentRows] = await pool.query(
      'SELECT COUNT(*) AS total_comments FROM product_comments WHERE product_id = ?',
      [productId],
    );
    const totalComments = Number((totalCommentRows[0] && totalCommentRows[0].total_comments) || 0);

    const [rootRows] = await pool.query(
      `
      SELECT
        c.id,
        c.product_id,
        c.account,
        c.content,
        c.parent_id,
        c.created_at,
        IFNULL(like_info.like_count, 0) AS like_count,
        CASE
          WHEN ? <> '' AND viewer_like.comment_id IS NOT NULL THEN 1
          ELSE 0
        END AS liked_by_me
      FROM product_comments c
      LEFT JOIN (
        SELECT comment_id, COUNT(*) AS like_count
        FROM comment_likes
        GROUP BY comment_id
      ) like_info ON like_info.comment_id = c.id
      LEFT JOIN (
        SELECT comment_id
        FROM comment_likes
        WHERE account = ?
      ) viewer_like ON viewer_like.comment_id = c.id
      WHERE c.product_id = ?
        AND c.parent_id IS NULL
      ORDER BY ${rootOrderSql}
      LIMIT ? OFFSET ?
      `,
      [viewer, viewer, productId, pageSize, safeOffset],
    );

    if (!rootRows.length) {
      return res.json({
        success: true,
        comments: [],
        page: safePage,
        pageSize,
        total,
        totalPages,
        sortBy,
        totalComments,
      });
    }

    const rootIds = rootRows.map((item) => item.id);

    const [replyRows] = await pool.query(
      `
      SELECT
        c.id,
        c.product_id,
        c.account,
        c.content,
        c.parent_id,
        c.created_at,
        IFNULL(like_info.like_count, 0) AS like_count,
        CASE
          WHEN ? <> '' AND viewer_like.comment_id IS NOT NULL THEN 1
          ELSE 0
        END AS liked_by_me
      FROM product_comments c
      LEFT JOIN (
        SELECT comment_id, COUNT(*) AS like_count
        FROM comment_likes
        GROUP BY comment_id
      ) like_info ON like_info.comment_id = c.id
      LEFT JOIN (
        SELECT comment_id
        FROM comment_likes
        WHERE account = ?
      ) viewer_like ON viewer_like.comment_id = c.id
      WHERE c.parent_id IN (?)
      ORDER BY c.parent_id ASC, c.created_at ASC
      `,
      [viewer, viewer, rootIds],
    );

    const roots = [];
    const rootById = new Map();

    rootRows.forEach((item) => {
      const comment = {
        id: item.id,
        productId: item.product_id,
        account: item.account,
        content: item.content,
        parentId: item.parent_id,
        createdAt: item.created_at,
        likeCount: Number(item.like_count || 0),
        likedByMe: Number(item.liked_by_me) === 1,
        replies: [],
      };
      roots.push(comment);
      rootById.set(comment.id, comment);
    });

    replyRows.forEach((item) => {
      const reply = {
        id: item.id,
        productId: item.product_id,
        account: item.account,
        content: item.content,
        parentId: item.parent_id,
        createdAt: item.created_at,
        likeCount: Number(item.like_count || 0),
        likedByMe: Number(item.liked_by_me) === 1,
        replies: [],
      };
      const parent = rootById.get(reply.parentId);
      if (parent) {
        parent.replies.push(reply);
      }
    });

    return res.json({
      success: true,
      comments: roots,
      page: safePage,
      pageSize,
      total,
      totalPages,
      sortBy,
      totalComments,
    });
  })().catch((error) => {
    console.error('查询评论错误:', error.message);
    return res.status(500).json({ success: false, message: '获取评论失败，请稍后重试' });
  });
});

app.post('/api/products/:productId/comments', (req, res) => {
  (async () => {
    const productId = String(req.params.productId || '').trim();
    const content = sanitizeCommentText(req.body.content);
    const parentId = Number(req.body.parentId || 0) || null;
    const accountCheck = await resolveValidAccount(req.body.account);

    if (!productId) {
      return res.status(400).json({ success: false, message: '商品标识不能为空' });
    }

    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    if (!content) {
      return res.status(400).json({ success: false, message: '评论内容不能为空' });
    }

    if (content.length > 500) {
      return res.status(400).json({ success: false, message: '评论内容不能超过 500 字' });
    }

    if (parentId) {
      const [parentRows] = await pool.query(
        'SELECT id, product_id FROM product_comments WHERE id = ? LIMIT 1',
        [parentId],
      );
      const parent = parentRows[0];
      if (!parent || parent.product_id !== productId) {
        return res.status(400).json({ success: false, message: '回复目标不存在或不属于当前商品' });
      }
    }

    const [insertResult] = await pool.query(
      'INSERT INTO product_comments (product_id, account, content, parent_id) VALUES (?, ?, ?, ?)',
      [productId, accountCheck.account, content, parentId],
    );

    return res.json({
      success: true,
      message: parentId ? '回复成功' : '评论成功',
      commentId: insertResult.insertId,
    });
  })().catch((error) => {
    console.error('发表评论错误:', error.message);
    return res.status(500).json({ success: false, message: '提交评论失败，请稍后重试' });
  });
});

app.post('/api/comments/:commentId/like', (req, res) => {
  (async () => {
    const commentId = Number(req.params.commentId || 0);
    const accountCheck = await resolveValidAccount(req.body.account);

    if (!Number.isInteger(commentId) || commentId <= 0) {
      return res.status(400).json({ success: false, message: '评论标识无效' });
    }

    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const [commentRows] = await pool.query('SELECT id FROM product_comments WHERE id = ? LIMIT 1', [commentId]);
    if (!commentRows.length) {
      return res.status(404).json({ success: false, message: '评论不存在' });
    }

    const [likeRows] = await pool.query(
      'SELECT id FROM comment_likes WHERE comment_id = ? AND account = ? LIMIT 1',
      [commentId, accountCheck.account],
    );

    let liked = false;
    if (likeRows.length) {
      await pool.query('DELETE FROM comment_likes WHERE id = ?', [likeRows[0].id]);
      liked = false;
    } else {
      await pool.query('INSERT INTO comment_likes (comment_id, account) VALUES (?, ?)', [commentId, accountCheck.account]);
      liked = true;
    }

    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM comment_likes WHERE comment_id = ?', [commentId]);
    const likeCount = Number((countRows[0] && countRows[0].total) || 0);

    return res.json({ success: true, liked, likeCount });
  })().catch((error) => {
    console.error('点赞评论错误:', error.message);
    return res.status(500).json({ success: false, message: '点赞失败，请稍后重试' });
  });
});

app.delete('/api/comments/:commentId', (req, res) => {
  (async () => {
    const commentId = Number(req.params.commentId || 0);
    const accountCheck = await resolveValidAccount(req.body.account);

    if (!Number.isInteger(commentId) || commentId <= 0) {
      return res.status(400).json({ success: false, message: '评论标识无效' });
    }

    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const [rows] = await pool.query(
      'SELECT id, account, parent_id FROM product_comments WHERE id = ? LIMIT 1',
      [commentId],
    );
    const comment = rows[0];

    if (!comment) {
      return res.status(404).json({ success: false, message: '评论不存在或已删除' });
    }

    if (comment.account !== accountCheck.account) {
      return res.status(403).json({ success: false, message: '只能删除自己发布的评论或回复' });
    }

    await pool.query('DELETE FROM product_comments WHERE id = ?', [commentId]);

    return res.json({
      success: true,
      message: comment.parent_id ? '回复已删除' : '评论已删除',
    });
  })().catch((error) => {
    console.error('删除评论错误:', error.message);
    return res.status(500).json({ success: false, message: '删除失败，请稍后重试' });
  });
});

app.get('/api/admin/me', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.query.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }
    return res.json({ success: true, account: accountCheck.account, role: accountCheck.user.role });
  })().catch((error) => {
    console.error('管理员校验错误:', error.message);
    return res.status(500).json({ success: false, message: '管理员校验失败' });
  });
});

app.get('/api/admin/summary', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.query.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const [[productRows], [skuRows], [orderRows], [revenueRows], [lowStockRows]] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM product_catalog WHERE is_active = 1'),
      pool.query('SELECT COUNT(*) AS total FROM product_skus WHERE is_active = 1'),
      pool.query('SELECT COUNT(*) AS total FROM orders'),
      pool.query("SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status IN ('paid', 'shipped', 'completed')"),
      pool.query("SELECT COUNT(*) AS total FROM v_inventory_status WHERE stock_status IN ('low_stock', 'out_of_stock')"),
    ]);

    return res.json({
      success: true,
      summary: {
        products: Number(productRows[0].total || 0),
        skus: Number(skuRows[0].total || 0),
        orders: Number(orderRows[0].total || 0),
        revenue: Number(revenueRows[0].total || 0),
        lowStock: Number(lowStockRows[0].total || 0),
      },
    });
  })().catch((error) => {
    console.error('后台概览错误:', error.message);
    return res.status(500).json({ success: false, message: '读取后台概览失败' });
  });
});

app.get('/api/admin/products', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.query.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const keyword = String(req.query.q || '').trim();
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    const category = String(req.query.category || '').trim().toLowerCase();
    const where = ['p.is_active = 1'];
    const params = [];

    if (category) {
      where.push('p.category = ?');
      params.push(category);
    }

    if (keyword) {
      where.push(`(
        p.name LIKE ?
        OR p.product_id LIKE ?
        OR p.description LIKE ?
        OR LOWER(REPLACE(REPLACE(REPLACE(p.name, ' ', ''), '-', ''), '_', '')) LIKE ?
        OR LOWER(REPLACE(REPLACE(REPLACE(p.product_id, ' ', ''), '-', ''), '_', '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM product_skus sx
          WHERE sx.product_id = p.product_id
            AND sx.is_active = 1
            AND (
              sx.sku_code LIKE ?
              OR sx.description LIKE ?
              OR sx.color_name LIKE ?
              OR sx.spec_name LIKE ?
              OR sx.connection_name LIKE ?
              OR LOWER(REPLACE(REPLACE(REPLACE(sx.sku_code, ' ', ''), '-', ''), '_', '')) LIKE ?
              OR LOWER(REPLACE(REPLACE(REPLACE(CONCAT_WS('', sx.description, sx.color_name, sx.spec_name, sx.connection_name), ' ', ''), '-', ''), '_', '')) LIKE ?
            )
        )
      )`);
      params.push(
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${normalizedKeyword}%`,
        `%${normalizedKeyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${normalizedKeyword}%`,
        `%${normalizedKeyword}%`,
      );
    }

    const [rows] = await pool.query(
      `
      SELECT
        p.product_id,
        p.category,
        p.name,
        p.description,
        p.base_price,
        p.is_active,
        JSON_UNQUOTE(JSON_EXTRACT(p.config_json, '$.baseImage')) AS product_image,
        s.id AS sku_id,
        s.sku_code,
        s.description AS sku_description,
        s.price,
        s.stock,
        s.sales_count,
        s.image_url,
        s.is_active AS sku_active
      FROM product_catalog p
      LEFT JOIN product_skus s ON s.product_id = p.product_id AND s.is_active = 1
      WHERE ${where.join(' AND ')}
      ORDER BY p.updated_at DESC, s.id ASC
      `,
      params,
    );

    const productMap = new Map();
    rows.forEach((row) => {
      if (!productMap.has(row.product_id)) {
        productMap.set(row.product_id, {
          productId: row.product_id,
          category: row.category,
          name: row.name,
          description: row.description || '',
          basePrice: Number(row.base_price || 0),
          image: toImagePath(row.product_image),
          skus: [],
        });
      }
      if (row.sku_id) {
        productMap.get(row.product_id).skus.push({
          id: row.sku_id,
          skuCode: row.sku_code,
          description: row.sku_description,
          price: Number(row.price || 0),
          stock: Number(row.stock || 0),
          salesCount: Number(row.sales_count || 0),
          image: toImagePath(row.image_url || row.product_image),
          isActive: Number(row.sku_active) === 1,
        });
      }
    });

    return res.json({ success: true, products: Array.from(productMap.values()) });
  })().catch((error) => {
    console.error('后台商品列表错误:', error.message);
    return res.status(500).json({ success: false, message: '读取商品库存失败' });
  });
});

app.get('/api/admin/users', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.query.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const keyword = String(req.query.q || '').trim();
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    const params = [];
    const where = [];
    if (keyword) {
      where.push(`(
        COALESCE(u.account, '') LIKE ?
        OR COALESCE(u.email, '') LIKE ?
        OR COALESCE(u.phone, '') LIKE ?
        OR COALESCE(u.username, '') LIKE ?
        OR LOWER(REPLACE(COALESCE(u.account, ''), ' ', '')) LIKE ?
        OR LOWER(REPLACE(COALESCE(u.email, ''), ' ', '')) LIKE ?
        OR LOWER(REPLACE(COALESCE(u.username, ''), ' ', '')) LIKE ?
      )`);
      params.push(
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${normalizedKeyword}%`,
        `%${normalizedKeyword}%`,
        `%${normalizedKeyword}%`,
      );
    }

    const [rows] = await pool.query(
      `
      SELECT
        u.id AS user_id,
        u.account,
        u.email,
        u.phone,
        u.username,
        u.role,
        u.created_at AS user_created_at,
        a.id AS address_id,
        a.receiver_name,
        a.phone AS address_phone,
        a.province,
        a.city,
        a.district,
        a.detail,
        a.is_default,
        o.id AS order_id,
        o.order_no,
        o.status,
        o.total_amount,
        o.item_count,
        o.created_at AS order_created_at,
        oi.id AS order_item_id,
        oi.product_name,
        oi.sku_description,
        oi.unit_price,
        oi.quantity,
        oi.subtotal
      FROM (
        SELECT
          u.id,
          u.account,
          u.email,
          u.phone,
          u.username,
          u.role,
          u.created_at
        FROM users u
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY u.created_at DESC
        LIMIT 100
      ) u
      LEFT JOIN user_addresses a ON a.user_id = u.id AND a.deleted_at IS NULL
      LEFT JOIN orders o ON o.user_id = u.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ORDER BY u.created_at DESC, a.is_default DESC, o.created_at DESC, oi.id ASC
      `,
      params,
    );

    const users = new Map();
    rows.forEach((row) => {
      if (!users.has(row.user_id)) {
        users.set(row.user_id, {
          id: row.user_id,
          account: row.account || row.username || row.email || row.phone || '',
          email: row.email || '',
          phone: row.phone || '',
          username: row.username || '',
          role: row.role || 'customer',
          createdAt: row.user_created_at,
          addresses: [],
          orders: [],
        });
      }
      const user = users.get(row.user_id);
      if (row.address_id && !user.addresses.some((item) => Number(item.id) === Number(row.address_id))) {
        user.addresses.push({
          id: row.address_id,
          receiverName: row.receiver_name,
          phone: row.address_phone,
          province: row.province,
          city: row.city,
          district: row.district,
          detail: row.detail,
          isDefault: Number(row.is_default) === 1,
        });
      }
      if (row.order_id) {
        let order = user.orders.find((item) => Number(item.id) === Number(row.order_id));
        if (!order) {
          order = {
            id: row.order_id,
            orderNo: row.order_no,
            status: row.status,
            totalAmount: Number(row.total_amount || 0),
            itemCount: Number(row.item_count || 0),
            createdAt: row.order_created_at,
            items: [],
          };
          user.orders.push(order);
        }
        if (row.order_item_id && !order.items.some((item) => Number(item.id) === Number(row.order_item_id))) {
          order.items.push({
            id: row.order_item_id,
            name: row.product_name,
            selection: row.sku_description,
            price: Number(row.unit_price || 0),
            quantity: Number(row.quantity || 0),
            subtotal: Number(row.subtotal || 0),
          });
        }
      }
    });

    return res.json({ success: true, users: Array.from(users.values()) });
  })().catch((error) => {
    console.error('后台用户总览错误:', error.message);
    return res.status(500).json({ success: false, message: '读取用户、订单和地址失败' });
  });
});

app.post('/api/admin/products', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const productId = String(req.body.productId || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const category = String(req.body.category || 'mac').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const baseImage = String(req.body.baseImage || '').trim();
    const uploadedImage = await saveUploadedImageFromDataUrl(req.body.imageFile);
    const finalBaseImage = uploadedImage || baseImage;
    const rawVariants = Array.isArray(req.body.variants) ? req.body.variants : [];

    if (!productId || !name) {
      return res.status(400).json({ success: false, message: '商品名称不能为空' });
    }

    if (!PRODUCT_CATEGORIES.has(category)) {
      return res.status(400).json({ success: false, message: '商品种类无效' });
    }

    if (!PRODUCT_CATEGORIES.has(category)) {
      return res.status(400).json({ success: false, message: '鍟嗗搧绉嶇被鏃犳晥' });
    }

    const variants = rawVariants
      .map((item) => ({
        colorName: String(item.colorName || '').trim() || '默认款式',
        specName: String(item.specName || '').trim() || '默认配置',
        connectionName: String(item.connectionName || '').trim(),
        price: Math.max(Number(item.price || 0), 0),
        stock: Math.max(Number(item.stock || 0), 0),
        imageUrl: String(item.imageUrl || finalBaseImage || '').trim(),
      }))
      .filter((item) => item.price > 0);

    if (!variants.length) {
      return res.status(400).json({ success: false, message: '至少需要录入一个有效 SKU' });
    }

    const minPrice = Math.min(...variants.map((item) => item.price));
    const uniqueColors = Array.from(new Map(
      variants
        .filter((item) => item.colorName)
        .map((item) => [item.colorName, { name: item.colorName, file: item.imageUrl || finalBaseImage }]),
    ).values());
    const uniqueSpecs = Array.from(new Map(
      variants.map((item) => [item.specName, { capacity: item.specName, price: item.price }]),
    ).values());
    const configJson = {
      category,
      storageMode: 'absolute',
      name,
      description,
      price: minPrice,
      baseImage: finalBaseImage || variants[0].imageUrl || '',
      colors: uniqueColors.length ? uniqueColors : [{ name: '默认款式', file: finalBaseImage || variants[0].imageUrl || '' }],
      storages: uniqueSpecs,
    };

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `
        INSERT INTO product_catalog (product_id, category, name, description, base_price, config_json, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          category = VALUES(category),
          name = VALUES(name),
          description = VALUES(description),
          base_price = VALUES(base_price),
          config_json = VALUES(config_json),
          is_active = 1
        `,
        [productId, category, name, description, minPrice, JSON.stringify(configJson)],
      );

      const skuCodes = [];
      for (const variant of variants) {
        const parts = [variant.colorName, variant.specName, variant.connectionName].filter(Boolean);
        const skuCode = createSkuCode(productId, parts);
        const skuDescription = parts.join(' / ') || '默认配置';
        skuCodes.push(skuCode);
        await conn.query(
          `
          INSERT INTO product_skus
            (product_id, sku_code, color_name, spec_name, connection_name, description, price, stock, image_url, config_json, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON DUPLICATE KEY UPDATE
            description = VALUES(description),
            price = VALUES(price),
            stock = VALUES(stock),
            image_url = VALUES(image_url),
            config_json = VALUES(config_json),
            is_active = 1
          `,
          [
            productId,
            skuCode,
            variant.colorName,
            variant.specName,
            variant.connectionName,
            skuDescription,
            variant.price,
            variant.stock,
            variant.imageUrl,
            JSON.stringify(variant),
          ],
        );
        const [skuRows] = await conn.query('SELECT id, stock FROM product_skus WHERE sku_code = ? LIMIT 1', [skuCode]);
        if (skuRows[0]) {
          await conn.query(
            `
            INSERT INTO inventory_logs
              (sku_id, change_type, quantity_delta, stock_after, reference_type, operator, note)
            VALUES (?, 'stock_in', ?, ?, 'admin', ?, ?)
            `,
            [skuRows[0].id, variant.stock, Number(skuRows[0].stock || 0), accountCheck.account, `商品入库 ${name}`],
          );
        }
      }
      await conn.query(
        'UPDATE product_skus SET is_active = 0 WHERE product_id = ? AND sku_code NOT IN (?)',
        [productId, skuCodes],
      );
      await conn.query(
        `
        INSERT INTO admin_audit_logs (admin_account, action, target_type, target_id, detail_json)
        VALUES (?, 'product_upsert', 'product', ?, ?)
        `,
        [accountCheck.account, productId, JSON.stringify({ category, name, variants: variants.length })],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return res.json({ success: true, message: '商品已入库', productId });
  })().catch((error) => {
    console.error('后台商品入库错误:', error.message);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || '商品入库失败，请检查 SKU 是否重复' });
  });
});

app.post('/api/admin/products-legacy', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const productId = String(req.body.productId || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const category = String(req.body.category || 'mac').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const baseImage = String(req.body.baseImage || '').trim();
    const rawVariants = Array.isArray(req.body.variants) ? req.body.variants : [];

    if (!productId || !name) {
      return res.status(400).json({ success: false, message: '商品 ID 和名称不能为空' });
    }

    const variants = rawVariants
      .map((item) => ({
        colorName: String(item.colorName || '').trim() || '默认款式',
        specName: String(item.specName || '').trim(),
        connectionName: String(item.connectionName || '').trim(),
        price: Math.max(Number(item.price || 0), 0),
        stock: Math.max(Number(item.stock || 0), 0),
        imageUrl: String(item.imageUrl || baseImage || '').trim(),
      }))
      .filter((item) => item.price > 0);

    if (!variants.length) {
      return res.status(400).json({ success: false, message: '至少需要录入一个有效 SKU' });
    }

    const minPrice = Math.min(...variants.map((item) => item.price));
    const uniqueColors = Array.from(new Map(
      variants
        .filter((item) => item.colorName)
        .map((item) => [item.colorName, { name: item.colorName, file: item.imageUrl || baseImage }]),
    ).values());
    const uniqueSpecs = Array.from(new Map(
      variants
        .map((item) => [item.specName || '默认配置', { capacity: item.specName || '默认配置', price: item.price }]),
    ).values());
    const configJson = {
      category,
      storageMode: uniqueSpecs.length ? 'absolute' : 'color-only',
      name,
      description,
      price: minPrice,
      baseImage: baseImage || variants[0].imageUrl || '',
      colors: uniqueColors.length ? uniqueColors : [{ name: '默认款式', file: baseImage || variants[0].imageUrl || '' }],
      storages: uniqueSpecs,
    };

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `
        INSERT INTO product_catalog (product_id, category, name, description, base_price, config_json, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          category = VALUES(category),
          name = VALUES(name),
          description = VALUES(description),
          base_price = VALUES(base_price),
          config_json = VALUES(config_json),
          is_active = 1
        `,
        [productId, category, name, description, minPrice, JSON.stringify(configJson)],
      );

      const skuCodes = [];
      for (const variant of variants) {
        const parts = [variant.colorName, variant.specName, variant.connectionName].filter(Boolean);
        const skuCode = createSkuCode(productId, parts);
        const skuDescription = parts.join(' / ') || '默认配置';
        skuCodes.push(skuCode);
        await conn.query(
          `
          INSERT INTO product_skus
            (product_id, sku_code, color_name, spec_name, connection_name, description, price, stock, image_url, config_json, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON DUPLICATE KEY UPDATE
            description = VALUES(description),
            price = VALUES(price),
            stock = VALUES(stock),
            image_url = VALUES(image_url),
            config_json = VALUES(config_json),
            is_active = 1
          `,
          [
            productId,
            skuCode,
            variant.colorName,
            variant.specName,
            variant.connectionName,
            skuDescription,
            variant.price,
            variant.stock,
            variant.imageUrl,
            JSON.stringify(variant),
          ],
        );
      }
      await conn.query(
        'UPDATE product_skus SET is_active = 0 WHERE product_id = ? AND sku_code NOT IN (?)',
        [productId, skuCodes],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return res.json({ success: true, message: '商品已入库', productId });
  })().catch((error) => {
    console.error('后台商品入库错误:', error.message);
    return res.status(500).json({ success: false, message: '商品入库失败，请检查 SKU 是否重复' });
  });
});

app.put('/api/admin/skus/:skuId/stock', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const skuId = Number(req.params.skuId || 0);
    if (!Number.isInteger(skuId) || skuId <= 0) {
      return res.status(400).json({ success: false, message: 'SKU 标识无效' });
    }

    const conn = await pool.getConnection();
    let finalStock = 0;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT id, stock FROM product_skus WHERE id = ? LIMIT 1 FOR UPDATE', [skuId]);
      const sku = rows[0];
      if (!sku) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'SKU 不存在' });
      }

      let delta = Number(req.body.delta);
      if (req.body.stock !== undefined && req.body.stock !== null && req.body.stock !== '') {
        const targetStock = Number(req.body.stock);
        if (!Number.isInteger(targetStock) || targetStock < 0) {
          await conn.rollback();
          return res.status(400).json({ success: false, message: '库存必须是非负整数' });
        }
        delta = targetStock - Number(sku.stock || 0);
      }

      if (!Number.isInteger(delta)) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: '库存调整值必须是整数' });
      }

      if (delta !== 0) {
        await conn.query(
          'CALL sp_adjust_inventory(?, ?, ?, ?)',
          [skuId, delta, accountCheck.account, String(req.body.note || '后台库存调整').trim()],
        );
      }

      const [freshRows] = await conn.query('SELECT stock FROM product_skus WHERE id = ? LIMIT 1', [skuId]);
      finalStock = Number((freshRows[0] && freshRows[0].stock) || 0);
      await conn.query(
        `
        INSERT INTO admin_audit_logs (admin_account, action, target_type, target_id, detail_json)
        VALUES (?, 'stock_update', 'sku', ?, ?)
        `,
        [accountCheck.account, String(skuId), JSON.stringify({ delta, stock: finalStock })],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    return res.json({ success: true, stock: finalStock, message: '库存已更新' });
  })().catch((error) => {
    console.error('后台库存调整错误:', error.message);
    return res.status(500).json({ success: false, message: error.message || '库存调整失败' });
  });
});

app.put('/api/admin/skus/:skuId/stock-legacy', (req, res) => {
  (async () => {
    const accountCheck = await resolveAdminAccount(req.body.account);
    if (!accountCheck.ok) {
      return res.status(accountCheck.status).json({ success: false, message: accountCheck.message });
    }

    const skuId = Number(req.params.skuId || 0);
    if (!Number.isInteger(skuId) || skuId <= 0) {
      return res.status(400).json({ success: false, message: 'SKU 标识无效' });
    }

    const [rows] = await pool.query('SELECT id, stock FROM product_skus WHERE id = ? LIMIT 1', [skuId]);
    const sku = rows[0];
    if (!sku) {
      return res.status(404).json({ success: false, message: 'SKU 不存在' });
    }

    let delta = Number(req.body.delta);
    if (req.body.stock !== undefined && req.body.stock !== null && req.body.stock !== '') {
      const targetStock = Number(req.body.stock);
      if (!Number.isInteger(targetStock) || targetStock < 0) {
        return res.status(400).json({ success: false, message: '库存必须是非负整数' });
      }
      delta = targetStock - Number(sku.stock || 0);
    }

    if (!Number.isInteger(delta)) {
      return res.status(400).json({ success: false, message: '库存调整值必须是整数' });
    }

    if (delta !== 0) {
      await pool.query(
        'CALL sp_adjust_inventory(?, ?, ?, ?)',
        [skuId, delta, accountCheck.account, String(req.body.note || '后台库存调整').trim()],
      );
    }

    const [freshRows] = await pool.query('SELECT stock FROM product_skus WHERE id = ? LIMIT 1', [skuId]);
    return res.json({
      success: true,
      stock: Number((freshRows[0] && freshRows[0].stock) || 0),
      message: '库存已更新',
    });
  })().catch((error) => {
    console.error('后台库存调整错误:', error.message);
    return res.status(500).json({ success: false, message: error.message || '库存调整失败' });
  });
});

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

    return res.json({ success: true, message: '登录成功', role: user.role || 'customer', isAdmin: account === DEFAULT_ADMIN_ACCOUNT && user.role === 'admin' });
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
