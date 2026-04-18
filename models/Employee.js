const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const Employee = sequelize.define('Employee', {
  nombre: { type: DataTypes.STRING, allowNull: false },
  apellido: { type: DataTypes.STRING, allowNull: false },
  dni: { type: DataTypes.STRING, allowNull: false, unique: true },
  fechaIngreso: { type: DataTypes.DATEONLY, allowNull: false },
  diasDisponibles: { type: DataTypes.FLOAT, defaultValue: 0 }, // FLOAT por si hay medios días
  // NUEVO: Para saber qué años ya le sumamos
  ultimoAnioProcesado: { type: DataTypes.INTEGER, defaultValue: 0 } 
});

module.exports = Employee;