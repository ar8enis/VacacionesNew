const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const Shift = sequelize.define('Shift', {
  nombre: { type: DataTypes.STRING, allowNull: false },
  diasLaborales: { type: DataTypes.STRING }, // Ejemplo: "Lunes,Martes,Miércoles"
  horaEntrada: { type: DataTypes.STRING },  // "22:00"
  horaSalida: { type: DataTypes.STRING },   // "06:00" (Soporta cruce de día)
  factorDescuento: { type: DataTypes.FLOAT, defaultValue: 1.0 } // 1.5 o 0.5 según pides
});

module.exports = Shift;