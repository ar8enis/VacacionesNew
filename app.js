const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const sequelize = require('./db');

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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sesión segura (ajustada para producción)
app.use(session({
    secret: process.env.SESSION_SECRET || 'secreto_seguro_dev',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' } 
}));

// --- 3. CONFIGURACIÓN DE CORREO ---
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: 587,
    auth: {
        user: process.env.EMAIL_USER, // Se configurará en Render
        pass: process.env.EMAIL_PASS  // Se configurará en Render
    }
});

const enviarCorreo = (destinatarios, asunto, htmlContent) => {
    if(!process.env.EMAIL_USER) return console.log("Correo no enviado: No configurado.");
    transporter.sendMail({
        from: `"Sistema Vacaciones" <${process.env.EMAIL_USER}>`,
        to: destinatarios,
        subject: asunto,
        html: htmlContent
    }).catch(err => console.error("Error correo:", err));
};

// --- 4. MIDDLEWARES ---
const isAuthenticated = (req, res, next) => req.session.userId ? next() : res.redirect('/login');
const isAdmin = (req, res, next) => (req.session.role === 'Admin') ? next() : res.status(403).send('Solo Admin');
const isRRHH = (req, res, next) => (req.session.role === 'RRHH' || req.session.role === 'Admin') ? next() : res.status(403).send('Solo RRHH');
const isSupervisor = (req, res, next) => (req.session.role === 'Supervisor' || req.session.role === 'Admin') ? next() : res.status(403).send('Solo Supervisor');

// --- 5. LÓGICA DE ANIVERSARIOS ---
async function procesarAniversarios() {
    try {
        const employees = await Employee.findAll();
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

// --- 6. RUTAS ---
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ where: { username: username.toLowerCase() } });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id; req.session.role = user.role; req.session.username = user.username;
            if (user.mustChangePassword) return res.redirect('/change-password');
            return res.redirect(user.role === 'Admin' ? '/admin' : (user.role === 'RRHH' ? '/rrhh' : '/supervisor'));
        }
        res.render('login', { error: 'Credenciales inválidas' });
    } catch (e) { res.render('login', { error: e.message }); }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/change-password', isAuthenticated, (req, res) => res.render('change-password'));
app.post('/change-password', isAuthenticated, async (req, res) => {
    const user = await User.findByPk(req.session.userId);
    user.password = req.body.newPassword; user.mustChangePassword = false; await user.save();
    res.redirect('/login');
});

// ADMIN
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => { res.render('admin', { users: await User.findAll() }); });
app.post('/admin/users', isAuthenticated, isAdmin, async (req, res) => { 
    try { await User.create(req.body); res.redirect('/admin'); } catch(e) { res.send("Error: Usuario duplicado"); }
});
app.post('/admin/reset-password/:id', isAuthenticated, isAdmin, async (req, res) => {
    const user = await User.findByPk(req.params.id); user.password = '123456'; user.mustChangePassword = true; await user.save();
    res.redirect('/admin');
});

// RRHH
app.get('/rrhh', isAuthenticated, isRRHH, async (req, res) => {
    const areas = await Area.findAll({ include: { model: User, as: 'Supervisores' } });
    const employees = await Employee.findAll({ include:[Area, Shift] });
    const requests = await VacationRequest.findAll({ include:[{ model: Employee, include:[Area] }, { model: User, as: 'Requester' }], order: [['createdAt', 'DESC']] });
    res.render('rrhh', { areas, employees, requests, shifts: await Shift.findAll(), rules: await VacationRule.findAll({ order: [['anios', 'ASC']] }), users: await User.findAll({ where: { role: 'Supervisor' } }) });
});

app.post('/rrhh/areas', isAuthenticated, isRRHH, async (req, res) => {
    const area = await Area.create({ nombre: req.body.nombre });
    if (req.body.supervisores) await area.setSupervisores(req.body.supervisores);
    res.redirect('/rrhh');
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
    await Employee.create({ ...req.body, diasDisponibles: req.body.diasDisponibles || 0, ultimoAnioProcesado: Math.max(antiguedad, 0) });
    await procesarAniversarios(); res.redirect('/rrhh');
});
app.post('/rrhh/employees/edit/:id', isAuthenticated, isRRHH, async (req, res) => {
    const emp = await Employee.findByPk(req.params.id);
    if (emp) { Object.assign(emp, req.body); await emp.save(); }
    res.redirect('/rrhh');
});
app.post('/rrhh/recalcular', isAuthenticated, isRRHH, async (req, res) => { await procesarAniversarios(); res.redirect('/rrhh'); });

app.get('/rrhh/download-template', isAuthenticated, isRRHH, (req, res) => {
    const data = [['Nombre', 'Apellido', 'DNI', 'FechaIngreso', 'Area', 'Turno', 'DiasDisp'],['Ejemplo', 'User', '123', '2023-01-01', 'Area', 'Turno', 10]];
    const ws = xlsx.utils.aoa_to_sheet(data);
    const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, "Empleados");
    res.setHeader('Content-Disposition', 'attachment; filename="Plantilla.xlsx"');
    res.send(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

app.post('/rrhh/import-excel', isAuthenticated, isRRHH, upload.single('excelFile'), async (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path, { cellDates: true });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const hoy = new Date();
        for (const row of data) {
            if (row.Nombre.includes('Ejemplo')) continue;
            const[area] = await Area.findOrCreate({ where: { nombre: row.Area } });
            const[turno] = await Shift.findOrCreate({ where: { nombre: row.Turno } });
            let f = row.FechaIngreso;
            let finalDate = f instanceof Date ? `${f.getFullYear()}-${String(f.getMonth()+1).padStart(2,'0')}-${String(f.getDate()).padStart(2,'0')}` : f;
            const ingreso = new Date(finalDate);
            let ant = hoy.getFullYear() - ingreso.getFullYear();
            if (hoy < new Date(hoy.getFullYear(), ingreso.getMonth(), ingreso.getDate())) ant--;
            await Employee.create({ nombre: row.Nombre, apellido: row.Apellido, dni: String(row.DNI), fechaIngreso: finalDate, AreaId: area.id, ShiftId: turno.id, diasDisponibles: row.DiasDisp || 0, ultimoAnioProcesado: Math.max(ant, 0) });
        }
        await procesarAniversarios(); res.redirect('/rrhh');
    } catch (e) { res.send("Error: " + e.message); }
});

// APROBACIONES
app.post('/rrhh/requests/approve/:id', isAuthenticated, isRRHH, async (req, res) => {
    const request = await VacationRequest.findByPk(req.params.id, { include: [Employee, { model: User, as: 'Requester' }] });
    if (request && request.estado === 'Pendiente') {
        request.estado = 'Aprobado'; await request.save();
        request.Employee.diasDisponibles -= parseFloat(request.diasSolicitados); await request.Employee.save();
        if (request.Requester?.email) enviarCorreo(request.Requester.email, "✅ Vacaciones Aprobadas", `<p>Las vacaciones de ${request.Employee.nombre} han sido aprobadas.</p>`);
    }
    res.redirect('/rrhh');
});
app.post('/rrhh/requests/reject/:id', isAuthenticated, isRRHH, async (req, res) => {
    const request = await VacationRequest.findByPk(req.params.id, { include: [Employee, { model: User, as: 'Requester' }] });
    if (request && request.estado === 'Pendiente') {
        request.estado = 'Rechazado'; request.motivoRechazo = req.body.motivoRechazo; await request.save();
        if (request.Requester?.email) enviarCorreo(request.Requester.email, "❌ Vacaciones Rechazadas", `<p>Motivo: ${req.body.motivoRechazo}</p>`);
    }
    res.redirect('/rrhh');
});

// SUPERVISOR
app.get('/supervisor', isAuthenticated, isSupervisor, async (req, res) => {
    const supervisor = await User.findByPk(req.session.userId, { include: { model: Area, as: 'Areas' } });
    const areaIds = supervisor?.Areas.map(a => a.id) || [];
    const employees = await Employee.findAll({ where: { AreaId: areaIds }, include:[Area, Shift] });
    const requests = await VacationRequest.findAll({ where: { EmployeeId: employees.map(e => e.id) }, include:[{ model: Employee, include:[Area] }], order: [['createdAt', 'DESC']] });
    res.render('supervisor', { employees, requests, currentUser: req.session.username });
});
app.post('/supervisor/solicitar', isAuthenticated, isSupervisor, async (req, res) => {
    const { EmployeeId, fechaInicio, fechaFin, diasSolicitados, motivo } = req.body;
    await VacationRequest.create({ EmployeeId, fechaInicio, fechaFin, diasSolicitados, motivo, RequesterId: req.session.userId });
    
    const emp = await Employee.findByPk(EmployeeId);
    const rrhhUsers = await User.findAll({ where: { role: 'RRHH' } });
    enviarCorreo(rrhhUsers.map(u => u.email).join(','), "🔔 Nueva Solicitud", `<p>Nueva solicitud de ${emp.nombre} por ${diasSolicitados} días.</p>`);
    res.redirect('/supervisor');
});

// --- 7. INICIO ---
const PORT = process.env.PORT || 3000;
sequelize.sync().then(async () => {
    const adminExists = await User.findOne({ where: { username: 'admin' } });
    if (!adminExists) {
        await User.create({ username: 'admin', email: 'admin@empresa.com', password: 'adminpassword', role: 'Admin', mustChangePassword: false });
    }
    await procesarAniversarios();
    setInterval(procesarAniversarios, 86400000);
    app.listen(PORT, '0.0.0.0', () => console.log(`Puerto: ${PORT}`));
});