const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const VacationRequest = sequelize.define('VacationRequest', {
    fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
    fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
    diasSolicitados: { type: DataTypes.FLOAT, allowNull: false },
    // NUEVOS CAMPOS:
    motivo: { type: DataTypes.STRING, allowNull: true },
    motivoRechazo: { type: DataTypes.STRING, allowNull: true },
    estado: { 
        type: DataTypes.ENUM('Pendiente', 'Aprobado', 'Rechazado'), 
        defaultValue: 'Pendiente' 
    }
});

module.exports = VacationRequest;