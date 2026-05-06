const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const Employee = sequelize.define('Employee', {
  nombre: { type: DataTypes.STRING, allowNull: false },
  apellido: { type: DataTypes.STRING, allowNull: false },
  dni: { type: DataTypes.STRING, allowNull: false, unique: true },
  fechaIngreso: { type: DataTypes.DATEONLY, allowNull: false },
  diasDisponibles: { type: DataTypes.FLOAT, defaultValue: 0 },
  ultimoAnioProcesado: { type: DataTypes.INTEGER, defaultValue: 0 },
  // NUEVO: Campo para saber si está en la planta o fue dado de baja
  activo: { type: DataTypes.BOOLEAN, defaultValue: true } 
});

module.exports = Employee;