// backend/db.js
const mysql = require('mysql2/promise');

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'asistencia_ldv',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

console.log("Pool MySQL creado");

module.exports = db;
