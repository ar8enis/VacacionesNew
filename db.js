const { Sequelize } = require('sequelize');
const path = require('path');

let sequelize;

// Si existe la variable DATABASE_URL (en Render), conectamos a PostgreSQL
if (process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false // Necesario para Render
      }
    },
    logging: false
  });
} else {
  // Si no, seguimos usando SQLite para tus pruebas locales
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, 'vacaciones.sqlite'),
    logging: false
  });
}

module.exports = sequelize;