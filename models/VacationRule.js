const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const VacationRule = sequelize.define('VacationRule', {
  anios: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  diasDerecho: { type: DataTypes.INTEGER, allowNull: false }
});

module.exports = VacationRule;