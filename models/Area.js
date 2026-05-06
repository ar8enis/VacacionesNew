const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const Area = sequelize.define('Area', {
  nombre: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  }
});

module.exports = Area; // <--- ESTA LÍNEA ES VITAL
