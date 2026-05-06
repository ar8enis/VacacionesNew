const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const sequelize = require('./db');
const { Op } = require('sequelize'); // NUEVO: Para poder filtrar por rango de fechas

// --- 1. MODELOS ---
const User = require('./models/User');
const Area = require('./models/Area');
const Employee = require('./models/Employee');
const Shift = require('./models/Shift');
const VacationRule = require('./models/VacationRule');
const VacationRequest = require('./models/VacationRequest'); 

// --- 2. RELACIONES ---
Area.belongsToMany(User, { as: 'Supervisores', through: 'AreaSupervisores' });
User.belongsToMany(Area, { as: 'Areas', through: 'AreaSupervisores' });
Area.hasMany(Employee, { foreignKey: 'AreaId' });
Employee.belongsTo(Area);
Shift.hasMany(Employee, { foreignKey: 'ShiftId' });
Employee.belongsTo(Shift, { foreignKey: 'ShiftId' });

Employee.hasMany(VacationRequest, { foreignKey: 'EmployeeId' });
VacationRequest.belongsTo(Employee, { foreignKey: 'EmployeeId' });
User.hasMany(VacationRequest, { foreignKey: 'RequesterId' });
VacationRequest.belongsTo(User, { as: 'Requester', foreignKey: 'RequesterId' });

const app = express();
const upload = multer({ dest: 'uploads/' });

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'secreto_seguro_dev',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// --- 3. CORREO ---
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: 587,
    auth: {
        user: process.env.EMAIL_USER || 'AQUI_TU_CORREO_REAL@gmail.com',
        pass: process.env.EMAIL_PASS || 'AQUI_TU_PASS_DE_16_LETRAS'
    }
});

const enviarCorreo = (destinatarios, asunto, htmlContent) => {
    if(!destinatarios || destinatarios === '') return;
    transporter.sendMail({
        from: `"Sistema Vacaciones" <${process.env.EMAIL_USER || 'tu_correo'}>`,
        to: destinatarios, subject: asunto, html: htmlContent
    }).catch(err => console.error("Error correo:", err.message));
};

// --- 4. MIDDLEWARES ---
const isAuthenticated = (req, res, next) => req.session.userId ? next() : res.redirect('/login');
const isAdmin = (req, res, next) => (req.session.role === 'Admin') ? next() : res.status(403).send('Solo Admin');
const isRRHH = (req, res, next) => (req.session.role === 'RRHH' || req.session.role === 'Admin') ? next() : res.status(403).send('Solo RRHH');
const isSupervisor = (req, res, next) => (req.session.role === 'Supervisor' || req.session.role === 'Admin') ? next() : res.status(403).send('Solo Supervisor');
const isNominas = (req, res, next) => (req.session.role === 'Nominas' || req.session.role === 'Admin') ? next() : res.status(403).send('Solo Nóminas');

// --- 5. AUTOMATIZACIÓN ---
async function procesarAniversarios() {
    try {
        const employees = await Employee.findAll({ where: { activo: true } });
        const rules = await VacationRule.findAll();
        const tabulador = {};
        rules.forEach(r => tabulador[r.anios] = r.diasDerecho);
        const hoy = new Date();
        for (const emp of employees) {
            const ingreso = new Date(emp.fechaIngreso);
            let antiguedad = hoy.getFullYear() - ingreso.getFullYear();
            if (hoy < new Date(hoy.getFullYear(), ingreso.getMonth(), ingreso.getDate())) antiguedad--;
            if (antiguedad > emp.ultimoAnioProcesado && antiguedad > 0) {
                let diasParaSumar = tabulador[antiguedad];
                if (!diasParaSumar) {
                    const añosDefinidos = Object.keys(tabulador).map(Number).sort((a,b) => b-a);
                    for (let año of añosDefinidos) { if (antiguedad >= año) { diasParaSumar = tabulador[año]; break; } }
                }
                if (diasParaSumar) { emp.diasDisponibles += diasParaSumar; emp.ultimoAnioProcesado = antiguedad; await emp.save(); }
            }
        }
    } catch (e) { console.error("Error aniversario:", e); }
}

async function procesarNotificacionesRegreso() {
    try {
        const requests = await VacationRequest.findAll({ where: { estado: 'Aprobado' }, include:[Employee, { model: User, as: 'Requester' }] });
        const hoy = new Date();
        const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;
        const rrhhUsers = await User.findAll({ where: { role: 'RRHH' } });
        const correosRRHH = rrhhUsers.map(u => u.email).filter(e => e).join(',');

        for (const req of requests) {
            if (!req.Employee.activo) continue;
            const fin = new Date(req.fechaFin + 'T00:00:00');
            const unDiaAntes = new Date(fin); unDiaAntes.setDate(unDiaAntes.getDate() - 1);
            const unDiaAntesStr = `${unDiaAntes.getFullYear()}-${String(unDiaAntes.getMonth()+1).padStart(2,'0')}-${String(unDiaAntes.getDate()).padStart(2,'0')}`;
            const diaRegreso = new Date(fin); diaRegreso.setDate(diaRegreso.getDate() + 1);
            const diaRegresoStr = `${diaRegreso.getFullYear()}-${String(diaRegreso.getMonth()+1).padStart(2,'0')}-${String(diaRegreso.getDate()).padStart(2,'0')}`;
            let destinatarios = correosRRHH;
            if (req.Requester && req.Requester.email) destinatarios += (destinatarios ? ',' : '') + req.Requester.email;
            if (!destinatarios) continue;

            if (!req.notificadoAvisoFin && hoyStr === unDiaAntesStr) {
                enviarCorreo(destinatarios, `⚠️ Aviso: Vacaciones por terminar - ${req.Employee.nombre}`, `<p>El periodo de vacaciones de <b>${req.Employee.nombre} ${req.Employee.apellido}</b> finaliza mañana (<b>${req.fechaFin}</b>).</p>`);
                req.notificadoAvisoFin = true; await req.save();
            }
            if (!req.notificadoRegreso && hoyStr === diaRegresoStr) {
                enviarCorreo(destinatarios, `📅 RECORDATORIO: Regreso a laborar - ${req.Employee.nombre}`, `<p>Las vacaciones de <b>${req.Employee.nombre}</b> finalizaron. Debe presentarse a laborar hoy.</p>`);
                req.notificadoRegreso = true; await req.save();
            }
        }
    } catch(e) { console.error("Error Notificaciones Regreso:", e); }
}

// --- 6. RUTAS BÁSICAS ---
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ where: { username: username.toLowerCase() } });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id; req.session.role = user.role; req.session.username = user.username;
            req.session.save((err) => {
                if (user.mustChangePassword) return res.redirect('/change-password');
                if (user.role === 'Admin') return res.redirect('/admin');
                if (user.role === 'RRHH') return res.redirect('/rrhh');
                if (user.role === 'Nominas') return res.redirect('/nominas');
                return res.redirect('/supervisor');
            });
        } else {
            res.render('login', { error: 'Credenciales inválidas' });
        }
    } catch (e) { res.render('login', { error: e.message }); }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/change-password', isAuthenticated, (req, res) => res.render('change-password'));
app.post('/change-password', isAuthenticated, async (req, res) => {
    const user = await User.findByPk(req.session.userId);
    user.password = req.body.newPassword; user.mustChangePassword = false; await user.save();
    res.redirect('/login');
});

// --- ADMIN ---
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => { res.render('admin', { users: await User.findAll() }); });
app.post('/admin/users', isAuthenticated, isAdmin, async (req, res) => { 
    try { await User.create(req.body); res.redirect('/admin'); } catch(e) { res.send("Error: Usuario duplicado"); }
});
app.post('/admin/reset-password/:id', isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findByPk(req.params.id); user.password = '123456'; user.mustChangePassword = true; await user.save();
    res.redirect('/admin');
});

// --- RRHH ---
app.get('/rrhh', isAuthenticated, isRRHH, async (req, res) => {
    const areas = await Area.findAll({ include: { model: User, as: 'Supervisores' } });
    const employees = await Employee.findAll({ include:[Area, Shift] });
    const requests = await VacationRequest.findAll({ include:[{ model: Employee, include:[Area] }, { model: User, as: 'Requester' }], order: [['createdAt', 'DESC']] });
    res.render('rrhh', { areas, employees, requests, shifts: await Shift.findAll(), rules: await VacationRule.findAll({ order: [['anios', 'ASC']] }), users: await User.findAll({ where: { role: 'Supervisor' } }) });
});
app.post('/rrhh/areas', isAuthenticated, isRRHH, async (req, res) => {
    try { const area = await Area.create({ nombre: req.body.nombre }); if (req.body.supervisores) await area.setSupervisores(req.body.supervisores); res.redirect('/rrhh'); } 
    catch (error) { res.send("Error"); }
});
app.post('/rrhh/areas/edit/:id', isAuthenticated, isRRHH, async (req, res) => {
    const area = await Area.findByPk(req.params.id);
    if (area) { area.nombre = req.body.nombre; await area.save(); await area.setSupervisores(req.body.supervisores ||[]); }
    res.redirect('/rrhh');
});
app.post('/rrhh/shifts', isAuthenticated, isRRHH, async (req, res) => { await Shift.create(req.body); res.redirect('/rrhh'); });
app.post('/rrhh/rules', isAuthenticated, isRRHH, async (req, res) => { await VacationRule.upsert(req.body); res.redirect('/rrhh'); });
app.post('/rrhh/employees', isAuthenticated, isRRHH, async (req, res) => {
    const hoy = new Date(); const ingreso = new Date(req.body.fechaIngreso);
    let antiguedad = hoy.getFullYear() - ingreso.getFullYear();
    if (hoy < new Date(hoy.getFullYear(), ingreso.getMonth(), ingreso.getDate())) antiguedad--;
    await Employee.create({ ...req.body, diasDisponibles: req.body.diasDisponibles || 0, ultimoAnioProcesado: Math.max(antiguedad, 0), activo: true });
    await procesarAniversarios(); res.redirect('/rrhh');
});
app.post('/rrhh/employees/edit/:id', isAuthenticated, isRRHH, async (req, res) => {
    try {
        const emp = await Employee.findByPk(req.params.id);
        if (emp) { 
            emp.nombre = req.body.nombre; emp.apellido = req.body.apellido; emp.dni = req.body.dni;
            emp.AreaId = req.body.AreaId; emp.ShiftId = req.body.ShiftId; emp.diasDisponibles = req.body.diasDisponibles; emp.activo = req.body.activo === 'true'; 
            await emp.save(); 
        }
        res.redirect('/rrhh');
    } catch (e) { res.send("Error al editar."); }
});
app.post('/rrhh/recalcular', isAuthenticated, isRRHH, async (req, res) => { await procesarAniversarios(); res.redirect('/rrhh'); });
app.get('/rrhh/download-template', isAuthenticated, isRRHH, (req, res) => {
    const data = [['Nombre', 'Apellido', 'DNI', 'FechaIngreso', 'Area', 'Turno', 'DiasDisp'],['(EJEMPLO - BORRAR ESTA FILA)', 'Perez', '10203040', '2023-05-20', 'Logistica', 'Primer', 12]];
    const ws = xlsx.utils.aoa_to_sheet(data); ws['!cols'] =[{wch: 30}, {wch: 20}, {wch: 15}, {wch: 15}, {wch: 15}, {wch: 15}, {wch: 10}];
    const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, "Empleados");
    res.setHeader('Content-Disposition', 'attachment; filename="Plantilla_Empleados.xlsx"');
    res.send(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
app.post('/rrhh/import-excel', isAuthenticated, isRRHH, upload.single('excelFile'), async (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path, { cellDates: true });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const hoy = new Date();
        for (const row of data) {
            if (row.Nombre && row.Nombre.includes('(EJEMPLO')) continue;
            const[area] = await Area.findOrCreate({ where: { nombre: row.Area } });
            const[turno] = await Shift.findOrCreate({ where: { nombre: row.Turno } });
            let f = row.FechaIngreso;
            let finalDate = f instanceof Date ? `${f.getFullYear()}-${String(f.getMonth()+1).padStart(2,'0')}-${String(f.getDate()).padStart(2,'0')}` : f;
            const ingreso = new Date(finalDate);
            let ant = hoy.getFullYear() - ingreso.getFullYear();
            if (hoy < new Date(hoy.getFullYear(), ingreso.getMonth(), ingreso.getDate())) ant--;
            await Employee.create({ nombre: row.Nombre, apellido: row.Apellido, dni: String(row.DNI), fechaIngreso: finalDate, AreaId: area.id, ShiftId: turno.id, diasDisponibles: row.DiasDisp || 0, ultimoAnioProcesado: Math.max(ant, 0), activo: true });
        }
        await procesarAniversarios(); res.redirect('/rrhh');
    } catch (e) { res.send("Error procesando Excel: " + e.message); }
});

app.post('/rrhh/requests/approve/:id', isAuthenticated, isRRHH, async (req, res) => {
    try {
        const request = await VacationRequest.findByPk(req.params.id, { include:[Employee, { model: User, as: 'Requester' }] });
        if (request && request.estado === 'Pendiente') {
            request.estado = 'Aprobado'; await request.save();
            request.Employee.diasDisponibles -= parseFloat(request.diasSolicitados); await request.Employee.save();
            if (request.Requester && request.Requester.email) {
                enviarCorreo(request.Requester.email, `✅ Aprobada: Vacaciones de ${request.Employee.nombre}`, `<p>Las vacaciones de <b>${request.Employee.nombre}</b> han sido aprobadas.</p>`);
            }
        }
        res.redirect('/rrhh');
    } catch (e) { res.send("Error al aprobar"); }
});
app.post('/rrhh/requests/reject/:id', isAuthenticated, isRRHH, async (req, res) => {
    try {
        const request = await VacationRequest.findByPk(req.params.id, { include:[Employee, { model: User, as: 'Requester' }] });
        if (request && request.estado === 'Pendiente') {
            request.estado = 'Rechazado'; request.motivoRechazo = req.body.motivoRechazo; await request.save();
            if (request.Requester && request.Requester.email) {
                enviarCorreo(request.Requester.email, `❌ Rechazada: Vacaciones de ${request.Employee.nombre}`, `<p>Las vacaciones de <b>${request.Employee.nombre}</b> fueron rechazadas. Motivo: ${request.motivoRechazo}</p>`);
            }
        }
        res.redirect('/rrhh');
    } catch (e) { res.send("Error al rechazar"); }
});

// --- SUPERVISOR ---
app.get('/supervisor', isAuthenticated, isSupervisor, async (req, res) => {
    const supervisor = await User.findByPk(req.session.userId, { include: { model: Area, as: 'Areas' } });
    const areaIds = supervisor?.Areas.map(a => a.id) ||[];
    const employees = await Employee.findAll({ where: { AreaId: areaIds, activo: true }, include:[Area, Shift] });
    const empIds = employees.map(e => e.id);
    const requests = await VacationRequest.findAll({ where: { EmployeeId: empIds }, include:[{ model: Employee, include:[Area, Shift] }], order: [['createdAt', 'DESC']] });
    
    const limit = new Date(); limit.setDate(limit.getDate() + 3);
    res.render('supervisor', { employees, requests, currentUser: req.session.username, minDateStr: limit.toISOString().split('T')[0] });
});

app.post('/supervisor/solicitar', isAuthenticated, isSupervisor, async (req, res) => {
    try {
        const { EmployeeId, fechaInicio, fechaFin, diasSolicitados, motivo } = req.body;
        const fSolicitada = new Date(fechaInicio + 'T00:00:00');
        const fMinima = new Date(); fMinima.setHours(0,0,0,0); fMinima.setDate(fMinima.getDate() + 3);
        if (fSolicitada < fMinima) return res.send("Mínimo 3 días de anticipación.");
        const fFinVal = new Date(fechaFin + 'T00:00:00');
        if (fFinVal < fSolicitada) return res.send("La fecha de fin no puede ser menor a la de inicio.");

        await VacationRequest.create({ EmployeeId, fechaInicio, fechaFin, diasSolicitados, motivo, RequesterId: req.session.userId });
        
        const emp = await Employee.findByPk(EmployeeId);
        const supervisor = await User.findByPk(req.session.userId);
        const rrhhUsers = await User.findAll({ where: { role: 'RRHH' } });
        
        if (supervisor.email) enviarCorreo(supervisor.email, `⏳ Solicitud Registrada: ${emp.nombre}`, `<p>Tu solicitud para <b>${emp.nombre}</b> está en espera de RRHH.</p>`);
        if(rrhhUsers.length > 0) {
            enviarCorreo(rrhhUsers.map(u => u.email).join(','), `🔔 Nueva Solicitud: ${emp.nombre}`, `<p>El supervisor <b>${supervisor.username}</b> ha solicitado vacaciones para <b>${emp.nombre}</b>.</p>`);
        }
        res.redirect('/supervisor');
    } catch (error) { res.send("Error al solicitar."); }
});

// --- NÓMINAS ---
app.get('/nominas', isAuthenticated, isNominas, async (req, res) => {
    const requests = await VacationRequest.findAll({ 
        where: { estado: 'Aprobado' },
        include:[{ model: Employee, include: [Area, Shift] }],
        order: [['fechaInicio', 'ASC']]
    });
    res.render('nominas', { requests, currentUser: req.session.username });
});

// NUEVO: EXPORTACIÓN SAP PARA NÓMINAS
app.post('/nominas/export-sap', isAuthenticated, isNominas, async (req, res) => {
    try {
        const { fechaInicio, fechaFin, fileName } = req.body;
        
        // Buscar solicitudes aprobadas que coincidan con las fechas indicadas
        const requests = await VacationRequest.findAll({ 
            where: { 
                estado: 'Aprobado',
                fechaInicio: { [Op.lte]: fechaFin },
                fechaFin: { [Op.gte]: fechaInicio }
            },
            include: [{ model: Employee }]
        });

        // Formato exacto para SAP: idempleado | nombre | desde | hasta | dias | fechapago | diasprima
        const data = [['idempleado', 'nombre', 'desde', 'hasta', 'dias', 'fechapago', 'diasprima']];
        
        requests.forEach(req => {
            data.push([
                req.Employee.dni,
                `${req.Employee.nombre} ${req.Employee.apellido}`,
                req.fechaInicio, 
                req.fechaFin,
                req.diasSolicitados,
                '', // fechapago se queda vacío
                req.diasSolicitados // diasprima igual que dias
            ]);
        });

        const ws = xlsx.utils.aoa_to_sheet(data);
        const wb = xlsx.utils.book_new(); 
        xlsx.utils.book_append_sheet(wb, ws, "Vacaciones");
        
        // Ajustar columnas
        ws['!cols'] =[{wch: 15}, {wch: 35}, {wch: 15}, {wch: 15}, {wch: 10}, {wch: 15}, {wch: 10}];

        const finalName = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;

        res.setHeader('Content-Disposition', `attachment; filename="${finalName}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    } catch (e) { 
        res.send("Error al exportar: " + e.message); 
    }
});

// --- 7. INICIO ---
const PORT = process.env.PORT || 3000;
sequelize.sync({ force: true }).then(async () => {
    const adminExists = await User.findOne({ where: { username: 'admin' } });
    if (!adminExists) {
        await User.create({ username: 'admin', email: 'admin@empresa.com', password: 'adminpassword', role: 'Admin', mustChangePassword: false });
    }
    await procesarAniversarios();
    await procesarNotificacionesRegreso();
    setInterval(() => { procesarAniversarios(); procesarNotificacionesRegreso(); }, 86400000);
    app.listen(PORT, '0.0.0.0', () => console.log(`Puerto: ${PORT}`));
});
