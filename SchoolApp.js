const express = require('express');
const mysql = require('mysql2/promise');
const argon2 = require('argon2');
const session = require('express-session');
const path = require('path');
const moment = require('moment'); // Import moment.js
const multer = require('multer'); // Import multer for file uploads
//const cron = require('node-cron');
//const Flutterwave = require('flutterwave-node-v3');
//const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'your-secret-key', resave: false, saveUninitialized: true }));

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views', 'school_app')); // Corrected path

// Serve static files (CSS, JS)
app.use(express.static(path.join(__dirname, 'public'))); // Corrected path

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'public/images/teachers')); // Store images in public/images/teachers
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const nigerianStates = {
        "Abia": ["Aba North", "Aba South", "Arochukwu", "Bende", "Ikwuano", "Isiala Ngwa North", "Isiala Ngwa South", "Isuikwuato", "Obi Ngwa", "Ohafia", "Osisioma", "Ugwunagbo", "Ukwa East", "Ukwa West", "Umuahia North", "Umuahia South", "Umu Nneochi"],
        "Adamawa": ["Demsa", "Fufure", "Ganye", "Gayuk", "Gombi", "Grie", "Hong", "Jada", "Lamurde", "Madagali", "Maiha", "Mayo Belwa", "Michika", "Mubi North", "Mubi South", "Numan", "Shelleng", "Song", "Toungo", "Yola North", "Yola South"],
        "Akwa Ibom": ["Abak", "Eastern Obolo", "Eket", "Esit Eket", "Essien Udim", "Etim Ekpo", "Etinan", "Ibeno", "Ibesikpo Asutan", "Ibiono-Ibom", "Ika", "Ikono", "Ikot Abasi", "Ikot Ekpene", "Ini", "Itu", "Mbo", "Mkpat-Enin", "Nsit-Atai", "Nsit-Ibom", "Nsit-Ubium", "Obot Akara", "Okobo", "Onna", "Oron", "Oruk Anam", "Udung-Uko", "Ukanafun", "Uruan", "Urue-Offong/Oruko", "Uyo"],
        "Anambra": ["Aguata", "Anambra East", "Anambra West", "Anaocha", "Awka North", "Awka South", "Ayamelum", "Dunukofia", "Ekwusigo", "Idemili North", "Idemili South", "Ihiala", "Njikoka", "Nnewi North", "Nnewi South", "Ogbaru", "Onitsha North", "Onitsha South", "Orumba North", "Orumba South", "Oyi"],
        "Bauchi": ["Alkaleri", "Bauchi", "Bogoro", "Damban", "Darazo", "Dass", "Gamawa", "Ganjuwa", "Giade", "Itas/Gadau", "Jama'are", "Katagum", "Kirfi", "Misau", "Ningi", "Shira", "Tafawa Balewa", "Toro", "Warji", "Zaki"],
        "Bayelsa": ["Brass", "Ekeremor", "Kolokuma/Opokuma", "Nembe", "Ogbia", "Sagbama", "Southern Ijaw", "Yenagoa"],
        "Benue": ["Ado", "Agatu", "Apa", "Buruku", "Gboko", "Guma", "Gwer East", "Gwer West", "Katsina-Ala", "Konshisha", "Kwande", "Logo", "Makurdi", "Obi", "Ogbadibo", "Ohimini", "Oju", "Okpokwu", "Oturkpo", "Tarka", "Ukum", "Ushongo", "Vandeikya"],
        "Borno": ["Abadam", "Askira/Uba", "Bama", "Bayo", "Biase", "Chibok", "Damboa", "Dikwa", "Gubio", "Guzamala", "Gwoza", "Hawul", "Jere", "Kaga", "Kala/Balge", "Konduga", "Kukawa", "Kwaya Kusar", "Mafa", "Magumeri", "Maiduguri", "Marte", "Mobbar", "Monguno", "Ngala", "Nganzai", "Shani"],
        "Cross River": ["Abi", "Akamkpa", "Akpabuyo", "Bakassi", "Bekwarra", "Biase", "Boki", "Calabar Municipal", "Calabar South", "Etung", "Ikom", "Obanliku", "Obubra", "Obudu", "Odukpani", "Ogoja", "Yakuur", "Yala"],
        "Delta": ["Aniocha North", "Aniocha South", "Bomadi", "Burutu", "Ethiope East", "Ethiope West", "Ika North East", "Ika South", "Isoko North", "Isoko South", "Ndokwa East", "Ndokwa West", "Okpe", "Oshimili North", "Oshimili South", "Patani", "Sapele", "Udu", "Ughelli North", "Ughelli South", "Ukwuani", "Uvwie", "Warri North", "Warri South", "Warri South West"],
        "Ebonyi": ["Abakaliki", "Afikpo North", "Afikpo South", "Ebonyi", "Ezza North", "Ezza South", "Ikwo", "Ishielu", "Ivo", "Izzi", "Ohaozara", "Ohaukwu", "Onicha"],
        "Edo": ["Akoko-Edo", "Egor", "Esan Central", "Esan North-East", "Esan South-East", "Esan West", "Etsako Central", "Etsako East", "Etsako West", "Igueben", "Ikpoba Okha", "Orhionmwon", "Oredo", "Ovia North-East", "Ovia South-West", "Owan East", "Owan West", "Uhunmwonde"],
        "Ekiti": ["Ado Ekiti", "Efon", "Ekiti East", "Ekiti South-West", "Ekiti West", "Emure", "Gbonyin", "Ido Osi", "Ijero", "Ikere", "Ikole", "Ilejemeje", "Irepodun/Ifelodun", "Ise/Orun", "Moba", "Oye"],
        "Enugu": ["Aninri", "Awgu", "Enugu East", "Enugu North", "Enugu South", "Ezeagu", "Igbo Etiti", "Igbo Eze North", "Igbo Eze South", "Isi Uzo", "Nkanu East", "Nkanu West", "Nsukka", "Oji River", "Udenu", "Udi", "Uzo Uwani"],
        "FCT": ["Abaji", "Bwari", "Gwagwalada", "Kuje", "Kwali", "Municipal Area Council"],
        "Gombe": ["Akko", "Balanga", "Billiri", "Dukku", "Funakaye", "Gombe", "Kaltungo", "Kwami", "Nafada", "Shongom", "Yamaltu/Deba"],
        "Imo": ["Aboh Mbaise", "Ahiazu Mbaise", "Ehime Mbano", "Ezinihitte", "Ideato North", "Ideato South", "Ihitte/Uboma", "Ikeduru", "Isiala Mbano", "Isu", "Mbaitoli", "Ngor Okpala", "Njaba", "Nkwerre", "Nwangele", "Obowo", "Oguta", "Ohaji/Egbema", "Okigwe", "Orlu", "Orsu", "Oru East", "Oru West", "Owerri Municipal", "Owerri North", "Owerri West", "Unuimo"],
        "Jigawa": ["Auyo", "Babura", "Biriniwa", "Birnin Kudu", "Buji", "Dutse", "Gagarawa", "Garki", "Gumel", "Guri", "Gwaram", "Gwiwa", "Hadejia", "Jahun", "Kafin Hausa", "Kazaure", "Kiri Kasama", "Kiyawa", "Kaugama", "Maigatari", "Malam Madori", "Miga", "Ringim", "Roni", "Sule Tankarkar", "Taura", "Yankwashi"],
        "Kaduna": ["Birnin Gwari", "Chikun", "Giwa", "Igabi", "Ikara", "Jaba", "Jema'a", "Kachia", "Kaduna North", "Kaduna South", "Kagarko", "Kajuru", "Kaura", "Kauru", "Kubau", "Kudan", "Lere", "Makarfi", "Sabon Gari", "Sanga", "Soba", "Zangon Kataf", "Zaria"],
        "Kano": ["Ajingi", "Albasu", "Bagwai", "Bebeji", "Bichi", "Bunkure", "Dala", "Dambatta", "Dawakin Kudu", "Dawakin Tofa", "Doguwa", "Fagge", "Gabasawa", "Garko", "Garun Mallam", "Gaya", "Gezawa", "Gwale", "Gwarzo", "Kabo", "Kano Municipal", "Karaye", "Kibiya", "Kiru", "Kumbotso", "Kunchi", "Kura", "Madobi", "Makoda", "Minjibir", "Nasarawa", "Rano", "Rimin Gado", "Rogo", "Shanono", "Sumaila", "Takai", "Tarauni", "Tofa", "Tsanyawa", "Tudun Wada", "Ungogo", "Warawa", "Wudil"],
        "Katsina": ["Bakori", "Batagarawa", "Batsari", "Baure", "Bindawa", "Charanchi", "Dandume", "Danja", "Dan Musa", "Daura", "Dutsi", "Dutsin Ma", "Faskari", "Funtua", "Ingawa", "Jibia", "Kafur", "Kaita", "Kankara", "Kankia", "Katsina", "Kurfi", "Kusada", "Mai'Adua", "Malumfashi", "Mani", "Mashi", "Matazu", "Musawa", "Rimi", "Sabuwa", "Safana", "Sandamu", "Zango"],
        "Kebbi": ["Aleiro", "Arewa Dandi", "Argungu", "Augie", "Bagudo", "Birnin Kebbi", "Bunza", "Dandi", "Fakai", "Gwandu", "Jega", "Kalgo", "Koko/Besse", "Maiyama", "Ngaski", "Sakaba", "Shanga", "Suru", "Wasagu/Danko", "Yauri", "Zuru"],
        "Kogi": ["Adavi", "Ajaokuta", "Ankpa", "Bassa", "Dekina", "Ibaji", "Idah", "Igalamela Odolu", "Ijumu", "Kabba/Bunu", "Kogi", "Lokoja", "Mopa Muro", "Ofu", "Ogori/Magongo", "Okehi", "Okene", "Olamaboro", "Omala", "Yagba East", "Yagba West"],
        "Kwara": ["Asa", "Baruten", "Edu", "Ekiti", "Ifelodun", "Ilorin East", "Ilorin South", "Ilorin West", "Irepodun", "Isin", "Kaiama", "Moro", "Offa", "Oke Ero", "Oyun", "Pategi"],
        "Lagos": ["Agege", "Ajeromi-Ifelodun", "Alimosho", "Amuwo-Odofin", "Apapa", "Badagry", "Epe", "Eti Osa", "Ibeju-Lekki", "Ifako-Ijaiye", "Ikeja", "Ikorodu", "Kosofe", "Lagos Island", "Lagos Mainland", "Mushin", "Ojo", "Oshodi-Isolo", "Shomolu", "Surulere"],
        "Nasarawa": ["Akwanga", "Awe", "Doma", "Karu", "Keana", "Keffi", "Kokona", "Lafia", "Nasarawa", "Nasarawa Egon", "Obi", "Toto", "Wamba"],
        "Niger": ["Agaie", "Agwara", "Bida", "Borgu", "Bosso", "Chanchaga", "Edati", "Gbako", "Gurara", "Katcha", "Kontagora", "Lapai", "Lavun", "Magama", "Mariga", "Mashegu", "Mokwa", "Moya", "Paikoro", "Rafi", "Rijau", "Shiroro", "Suleja", "Tafa", "Wushishi"],
        "Ogun": ["Abeokuta North", "Abeokuta South", "Ado-Odo/Ota", "Egbado North", "Egbado South", "Ewekoro", "Ifo", "Ijebu East", "Ijebu North", "Ijebu North East", "Ijebu Ode", "Ikenne", "Imeko Afon", "Ipokia", "Obafemi Owode", "Odeda", "Odogbolu", "Ogun Waterside", "Remo North", "Shagamu", "Yewa North", "Yewa South"],
        "Ondo": ["Akoko North-East", "Akoko North-West", "Akoko South-East", "Akoko South-West", "Akure North", "Akure South", "Ese Odo", "Idanre", "Ifedore", "Ilaje", "Ile Oluji/Okeigbo", "Irele", "Odigbo", "Okitipupa", "Ondo East", "Ondo West", "Ose", "Owo"],
        "Osun": ["Aiyedade", "Aiyedire", "Atakunmosa East", "Atakunmosa West", "Boluwaduro", "Boripe", "Ede North", "Ede South", "Egbedore", "Ejigbo", "Ife Central", "Ife East", "Ife North", "Ife South", "Ifedayo", "Ila", "Ilesa East", "Ilesa West", "Irepodun", "Irewole", "Isokan", "Iwo", "Obokun", "Odo Otin", "Ola Oluwa", "Olorunda", "Oriade", "Orolu", "Osogbo"],
        "Oyo": ["Afijio", "Akinyele", "Atiba", "Atisbo", "Egbeda", "Ibadan North", "Ibadan North-East", "Ibadan North-West", "Ibadan South-East", "Ibadan South-West", "Ibarapa Central", "Ibarapa East", "Ibarapa North", "Ido", "Irepo", "Iseyin", "Itesiwaju", "Iwajowa", "Kajola", "Lagelu", "Ogbomosho North", "Ogbomosho South", "Ogo Oluwa", "Olorunsogo", "Oluyole", "Ona Ara", "Orelope", "Ori Ire", "Oyo East", "Oyo West", "Saki East", "Saki West", "Surulere"],
        "Plateau": ["Barkin Ladi", "Bassa", "Bokkos", "Jos East", "Jos North", "Jos South", "Kanam", "Kanke", "Langtang North", "Langtang South", "Mangu", "Mikang", "Pankshin", "Qua'an Pan", "Riyom", "Shendam", "Wase"],
        "Rivers": ["Abua/Odual", "Ahoada East", "Ahoada West", "Akuku-Toru", "Andoni", "Asari-Toru", "Bonny", "Degema", "Eleme", "Emuoha", "Etche", "Gokana", "Ikwerre", "Khana", "Obio/Akpor", "Ogba/Egbema/Ndoni", "Ogu/Bolo", "Okrika", "Omuma", "Opobo/Nkoro", "Oyigbo", "Port Harcourt", "Tai"],
        "Sokoto": ["Binji", "Bodinga", "Dange Shuni", "Gada", "Goronyo", "Gudu", "Gwadabawa", "Illela", "Isa", "Kebbe", "Kware", "Rabah", "Sabon Birni", "Shagari", "Silame", "Sokoto North", "Sokoto South", "Tambuwal", "Tangaza", "Tureta", "Wamako", "Wurno", "Yabo"],
        "Taraba": ["Ardo Kola", "Bali", "Donga", "Gashaka", "Gassol", "Ibi", "Jalingo", "Karim Lamido", "Kurmi", "Lau", "Sardauna", "Takum", "Ussa", "Wukari", "Yorro", "Zing"],
        "Yobe": ["Bade", "Bursari", "Damaturu", "Fika", "Fune", "Geidam", "Gujba", "Gulani", "Jakusko", "Karasuwa", "Machina", "Nangere", "Nguru", "Potiskum", "Tarmuwa", "Yunusari", "Yusufari"],
        "Zamfara": ["Anka", "Bakura", "Birnin Magaji/Kiyaw", "Bukkuyum", "Bungudu", "Gummi", "Gusau", "Kaura Namoda", "Maradun", "Maru", "Shinkafi", "Talata Mafara", "Chafe", "Zurmi"]
    };


// A new instance of multer for forms that do not have file uploads
const uploadNoFile = multer();
// The original multer instance for forms with file uploads
const uploadWithFile = multer({ storage: storage });

// Middleware to authenticate user
// Middleware to authenticate user
function authenticate(req, res, next) {
    if (req.session && req.session.role) {
        return next();
    } else {
        res.redirect('/login');
    }
}

// Middleware to check specific roles
function requireRole(role) {
    return (req, res, next) => {
        if (req.session && req.session.role === role) {
            return next();
        } else {
            res.status(403).render('error', {
                message: 'Access Denied',
                error: { status: 403, message: 'You do not have permission to access this page.' }
            });
        }
    };
}

// Apply role-based access control to routes
app.get('/admin/*', requireRole('admin'));
app.get('/teacher/*', requireRole('teacher'));
app.get('/student/*', requireRole('student'));
// Function to get a database connection
async function getConnection() {
    return await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: 'inshallah',
        database: 'school_management'
    });
}

// Function to compare passwords
async function comparePassword(inputPassword, storedPassword) {
    return await argon2.verify(storedPassword, inputPassword);
}

app.get('/register', (req, res) => {
    res.render('page-register', { error: null }); // Render the register.ejs file with no error initially
});

app.post('/register', async (req, res) => {
    const { 
        username, 
        email, 
        password, 
        confirmPassword, 
        role,
        schoolName,
        schoolEmail,
        schoolPhone,
        schoolWebsite,
        schoolAddress
    } = req.body;

    try {
        const connection = await getConnection();

        // Validate required fields
        if (!username || !email || !password || !role || !schoolName || !schoolEmail || !schoolPhone || !schoolAddress) {
            return res.render('page-register', { 
                error: 'All required fields must be filled' 
            });
        }

        // Check if passwords match
        if (password !== confirmPassword) {
            return res.render('page-register', { 
                error: 'Passwords do not match' 
            });
        }

        // Check password length
        if (password.length < 8) {
            return res.render('page-register', { 
                error: 'Password must be at least 8 characters long' 
            });
        }

        // Check if the username or email already exists
        const [existingUsers] = await connection.execute(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existingUsers.length > 0) {
            return res.render('page-register', { 
                error: 'Username or email already exists' 
            });
        }

        // Hash the password
        const hashedPassword = await argon2.hash(password);

        // Start transaction
        await connection.beginTransaction();

        try {
            // First, insert school information
            const [schoolResult] = await connection.execute(
                'INSERT INTO school_info (name, email, phone, website, address) VALUES (?, ?, ?, ?, ?)',
                [schoolName, schoolEmail, schoolPhone, schoolWebsite || null, schoolAddress]
            );

            const schoolId = schoolResult.insertId;

            // Then, insert the user with school reference
            await connection.execute(
                'INSERT INTO users (username, password, role, email, school_id) VALUES (?, ?, ?, ?, ?)',
                [username, hashedPassword, role, email, schoolId]
            );

            // Commit transaction
            await connection.commit();

            // Redirect to login page after successful registration
            req.session.success = 'School registration successful! Please login.';
            res.redirect('/login');

        } catch (error) {
            // Rollback transaction on error
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Registration error:', error);
        res.render('page-register', { 
            error: 'Registration failed: ' + error.message 
        });
    }
});
app.get('/login', (req, res) => {
    res.render('page-login', { error: null });
});

// Update the POST /login route to handle 2-field login
app.post('/login', async (req, res) => {
    const { email, credential } = req.body; // credential can be password or first name

    try {
        const connection = await getConnection();

        if (!email || !credential) {
            return res.render('page-login', { 
                error: 'Email and credential are required' 
            });
        }

        // First, try admin login (users table with password)
        const [users] = await connection.execute(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );

        if (users.length > 0) {
            const user = users[0];
            const passwordMatch = await comparePassword(credential, user.password);

            if (passwordMatch) {
                // Admin login successful
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.role = user.role;
                return res.redirect('/');
            }
        }

        // Second, try teacher login (email + password)
        const [teachers] = await connection.execute(
            'SELECT * FROM teachers WHERE email = ?',
            [email]
        );

        if (teachers.length > 0) {
            const teacher = teachers[0];
            const passwordMatch = await comparePassword(credential, teacher.password);

            if (passwordMatch) {
                // Teacher login successful
                req.session.userId = teacher.id;
                req.session.username = `${teacher.firstName} ${teacher.lastName}`;
                req.session.role = 'teacher';
                req.session.teacherData = teacher;
                return res.redirect('/teacher-dashboard');
            }
        }

        // Third, try student login (email + first name)
        const [students] = await connection.execute(
            'SELECT * FROM students WHERE email = ? AND firstName = ?',
            [email, credential] // credential is the first name for students
        );

        if (students.length > 0) {
            const student = students[0];
            
            // Student login successful
            req.session.userId = student.id;
            req.session.username = `${student.firstName} ${student.lastName}`;
            req.session.role = 'student';
            req.session.studentData = student;
            return res.redirect('/student-dashboard');
        }

        // If nothing matches, show generic error
        res.render('page-login', { 
            error: 'Invalid credentials. Please check your email and password/first name.' 
        });

    } catch (error) {
        console.error('Login error:', error);
        res.render('page-login', { 
            error: 'Login failed. Please try again.' 
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/login');
    });
});

// Define allowed routes based on user role
function getAllowedRoutes(role) {
    switch (role) {
        case 'admin':
            // Add admin-specific routes
        case 'teacher':
            // Add teacher-specific routes
        case 'staff':
            // Add staff-specific routes
        default:
            // Add common routes
    }
}

app.get('/teacher', authenticate, (req, res) => {
    if (req.session.role !== 'teacher') {
        return res.status(403).send('Unauthorized');
    }
    res.render('teacher', { username: req.session.username });
});

app.get('/staff', authenticate, (req, res) => {
    if (req.session.role !== 'staff') {
        return res.status(403).send('Unauthorized');
    }
    res.render('staff', { username: req.session.username });
});

app.get('/', authenticate, async (req, res) => {
    try {
        // Redirect based on role
        if (req.session.role === 'student') {
            return res.redirect('/student-dashboard');
        } else if (req.session.role === 'teacher') {
            return res.redirect('/teacher-dashboard');
        }

        // Admin dashboard (existing code)
        const connection = await getConnection();
        
        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get counts from database
        const [studentRows] = await connection.execute('SELECT COUNT(*) as count FROM students');
        const [teacherRows] = await connection.execute('SELECT COUNT(*) as count FROM teachers');
        const [classRows] = await connection.execute('SELECT COUNT(*) as count FROM classes');
        
        // Get fee collection data for current term
        const [feeRows] = await connection.execute(`
            SELECT SUM(amount) as total 
            FROM fees 
            WHERE academicYear = ? AND term = ?
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get recent activities
        const [activities] = await connection.execute(`
            SELECT * FROM activities 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        
        // Get upcoming events
        const [events] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate >= CURDATE() 
            ORDER BY eventDate ASC 
            LIMIT 3
        `);
        
        // Calculate term progress based on actual dates
        let termProgress = 0;
        let daysRemaining = 0;
        
        if (currentTerm.length > 0) {
            const [termDetails] = await connection.execute(`
                SELECT start_date, end_date 
                FROM academic_terms 
                WHERE term_name = ? AND academic_year_id = (
                    SELECT id FROM academic_years WHERE is_current = TRUE LIMIT 1
                )
            `, [currentTerm[0].term_name]);
            
            if (termDetails.length > 0) {
                const startDate = new Date(termDetails[0].start_date);
                const endDate = new Date(termDetails[0].end_date);
                const today = new Date();
                
                const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
                const daysPassed = Math.ceil((today - startDate) / (1000 * 60 * 60 * 24));
                
                termProgress = Math.min(100, Math.max(0, Math.round((daysPassed / totalDays) * 100)));
                daysRemaining = Math.max(0, totalDays - daysPassed);
            }
        }
        
        // Get exam statistics
        const [examStats] = await connection.execute(`
            SELECT COUNT(DISTINCT subject_id) as exams_conducted
            FROM student_scores 
            WHERE academic_year = ? AND term = ?
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get assignment statistics
        const assignmentsSubmitted = 156; // Placeholder
        
        // Get class schedule statistics
        const [classStats] = await connection.execute(`
            SELECT COUNT(*) as classes_scheduled
            FROM calendar_events 
            WHERE eventDate >= CURDATE() 
            AND eventDate <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
            AND (title LIKE '%class%' OR description LIKE '%class%')
        `);
        
        // Get assignments due
        const assignmentsDue = 8; // Placeholder
        
        /// Get attendance statistics - FIXED QUERY
const [attendanceStats] = await connection.execute(`
    SELECT 
        (COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) * 100.0 / 
         COUNT(*)) as avg_attendance
    FROM attendance_records
    WHERE date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
`);
        const dashboardData = {
            username: req.session.username,
            role: req.session.role,
            studentCount: studentRows[0].count,
            teacherCount: teacherRows[0].count,
            classCount: classRows[0].count,
            revenue: feeRows[0].total || 0,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            recentActivities: activities,
            upcomingEvents: events,
            termProgress: termProgress,
            daysRemaining: daysRemaining,
            examsConducted: examStats[0]?.exams_conducted || 0,
            assignmentsSubmitted: assignmentsSubmitted,
            classesScheduled: classStats[0]?.classes_scheduled || 0,
            assignmentsDue: assignmentsDue,
            averageAttendance: attendanceStats[0]?.avg_attendance || 92,
            feesCollected: feeRows[0].total || 0,
            moment: require('moment')
        };

        res.render('index', dashboardData);

    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.render('index', { 
            username: req.session.username, 
            role: req.session.role, 
            error: 'Failed to load dashboard data.' 
        });
    }
});

// Student Dashboard
// Student Dashboard
app.get('/student-dashboard', authenticate, async (req, res) => {
    if (req.session.role !== 'student') {
        return res.redirect('/');
    }
    
    try {
        const connection = await getConnection();
        
        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get term dates for attendance calculation
        const [termDetails] = await connection.execute(`
            SELECT start_date, end_date 
            FROM academic_terms 
            WHERE term_name = ? AND academic_year_id = (
                SELECT id FROM academic_years WHERE year_name = ?
            )
        `, [
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024'
        ]);
        
        // Get student data
        const [students] = await connection.execute(
            'SELECT s.*, c.className FROM students s LEFT JOIN classes c ON s.classId = c.id WHERE s.id = ?',
            [req.session.userId]
        );
        
        if (students.length === 0) {
            return res.redirect('/login');
        }
        
        const studentData = students[0];
        
        // Get student's recent results
        const [results] = await connection.execute(`
            SELECT ss.*, sub.name as subject_name 
            FROM student_scores ss 
            JOIN subjects sub ON ss.subject_id = sub.id 
            WHERE ss.student_id = ? AND ss.academic_year = ? AND ss.term = ?
            ORDER BY ss.created_at DESC LIMIT 5
        `, [
            req.session.userId, 
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get attendance percentage
        let attendancePercentage = 0;
        if (termDetails.length > 0) {
            const [attendance] = await connection.execute(`
    SELECT 
        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
        COUNT(*) as total_days
    FROM attendance_records 
    WHERE student_id = ? AND date BETWEEN ? AND ?
`, [req.session.userId, termDetails[0].start_date, termDetails[0].end_date]);
            
            attendancePercentage = attendance.length > 0 && attendance[0].total_days > 0 ? 
                Math.round((attendance[0].present_days / attendance[0].total_days) * 100) : 0;
        }
        
        // Calculate average score
        const averageScore = results.length > 0 ? 
            Math.round(results.reduce((sum, result) => sum + (result.test_score + result.exam_score), 0) / results.length) : 0;
        
        // Get fee status
        const [fees] = await connection.execute(`
            SELECT status FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ?
            ORDER BY created_at DESC LIMIT 1
        `, [
            req.session.userId,
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        const feeStatus = fees.length > 0 ? fees[0].status : 'Pending';
        
        // Get upcoming events
        const [upcomingEvents] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate >= CURDATE() 
            ORDER BY eventDate ASC 
            LIMIT 5
        `);
        
        res.render('student-dashboard', {
            studentData: studentData,
            recentResults: results,
            attendancePercentage: attendancePercentage,
            averageScore: averageScore,
            feeStatus: feeStatus,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            upcomingEvents: upcomingEvents,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading student dashboard:', error);
        res.redirect('/login');
    }
});

// Teacher Dashboard
app.get('/teacher-dashboard', authenticate, async (req, res) => {
    if (req.session.role !== 'teacher') {
        return res.redirect('/');
    }
    
    try {
        const connection = await getConnection();
        
        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get teacher data
        const [teachers] = await connection.execute(
            'SELECT * FROM teachers WHERE id = ?',
            [req.session.userId]
        );
        
        if (teachers.length === 0) {
            return res.redirect('/login');
        }
        
        const teacherData = teachers[0];
        
        // Get teacher's classes and subjects
        const [classes] = await connection.execute(`
            SELECT DISTINCT c.id as classId, c.className, s.id as subjectId, s.name as subjectName,
                   (SELECT COUNT(*) FROM students WHERE classId = c.id) as studentCount
            FROM classes c
            JOIN class_subjects cs ON c.id = cs.class_id
            JOIN subjects s ON cs.subject_id = s.id
            WHERE c.professorId = ?
            ORDER BY c.className
        `, [req.session.userId]);
        
        // Get scores entered this term
        const [scores] = await connection.execute(`
            SELECT COUNT(*) as count FROM student_scores 
            WHERE academic_year = ? AND term = ?
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get today's schedule for the teacher
        const today = new Date().toISOString().split('T')[0];
        
        // Option 1: If calendar_events has a different structure, check what columns exist
        // First, let's see the structure of calendar_events table
        const [eventStructure] = await connection.execute(`
            DESCRIBE calendar_events
        `);
        
        
        
        // Option 2: Get events without class join (simpler approach)
        const [todaysEvents] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate = ? 
            AND (title LIKE '%class%' OR description LIKE '%class%' OR title LIKE '%lecture%' OR description LIKE '%lecture%')
            ORDER BY startTime
        `, [today]);
        
        // Option 3: If you need to filter by teacher, use a different approach
        // Since we don't have class_id in calendar_events, let's get events that might be relevant
        const [todaysSchedule] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate = ? 
            AND (
                title LIKE CONCAT('%', (SELECT className FROM classes WHERE professorId = ? LIMIT 1), '%')
                OR description LIKE CONCAT('%', (SELECT className FROM classes WHERE professorId = ? LIMIT 1), '%')
                OR title LIKE '%teacher%' 
                OR description LIKE '%teacher%'
            )
            ORDER BY startTime
        `, [today, req.session.userId, req.session.userId]);
        
        // Get assignments due soon (placeholder)
        const assignmentsDue = 0;
        
        // Get recent announcements or activities
        const [recentActivities] = await connection.execute(`
            SELECT * FROM activities 
            ORDER BY created_at DESC 
            LIMIT 3
        `);
        
        // Get teacher's upcoming events (next 7 days)
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        const nextWeekFormatted = nextWeek.toISOString().split('T')[0];
        
        const [upcomingEvents] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate BETWEEN ? AND ?
            AND (
                title LIKE CONCAT('%', (SELECT className FROM classes WHERE professorId = ? LIMIT 1), '%')
                OR description LIKE CONCAT('%', (SELECT className FROM classes WHERE professorId = ? LIMIT 1), '%')
            )
            ORDER BY eventDate, startTime
        `, [today, nextWeekFormatted, req.session.userId, req.session.userId]);
        
        res.render('teacher-dashboard', {
            teacherData: teacherData,
            myClasses: classes,
            totalStudents: classes.reduce((sum, cls) => sum + cls.studentCount, 0),
            totalSubjects: classes.length,
            scoresEntered: scores[0].count,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            todaysSchedule: todaysSchedule.length > 0 ? todaysSchedule : todaysEvents,
            nextClass: todaysSchedule.length > 0 ? todaysSchedule[0] : (todaysEvents.length > 0 ? todaysEvents[0] : null),
            assignmentsDue: assignmentsDue,
            recentActivities: recentActivities,
            upcomingEvents: upcomingEvents,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading teacher dashboard:', error);
        res.redirect('/login');
    }
});
// Academic Year Routes

// GET route to view all academic years with terms
app.get('/academic-years', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get all academic years with their terms
        const [academicYears] = await connection.execute(`
            SELECT 
                ay.*,
                (SELECT COUNT(*) FROM academic_terms at WHERE at.academic_year_id = ay.id) as term_count
            FROM academic_years ay
            ORDER BY ay.start_date DESC
        `);
        
        // Get all terms for display
        const [terms] = await connection.execute(`
            SELECT at.*, ay.year_name 
            FROM academic_terms at
            JOIN academic_years ay ON at.academic_year_id = ay.id
            ORDER BY at.start_date DESC
        `);
        
        res.render('academic-years', {
            academicYears: academicYears,
            terms: terms,
            error: req.session.error || null,
            success: req.session.success || null,
            moment: require('moment')
        });
        
        // Clear session messages
        delete req.session.error;
        delete req.session.success;
        
    } catch (error) {
        console.error('Error fetching academic years:', error);
        res.render('academic-years', {
            academicYears: [],
            terms: [],
            error: 'Failed to load academic years',
            success: null
        });
    }
});

// GET route to display add academic year form
app.get('/add-academic-year', authenticate, (req, res) => {
    res.render('add-academic-year', {
        formData: {
            year_name: '',
            start_date: '',
            end_date: '',
            first_term_start: '',
            first_term_end: '',
            second_term_start: '',
            second_term_end: '',
            third_term_start: '',
            third_term_end: ''
        },
        error: null
    });
});

// POST route to add a new academic year with terms
app.post('/add-academic-year', uploadNoFile.none(), async (req, res) => {
    const { 
        year_name, 
        start_date, 
        end_date, 
        is_current,
        first_term_start,
        first_term_end,
        second_term_start,
        second_term_end,
        third_term_start,
        third_term_end
    } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!year_name || !start_date || !end_date) {
            return res.render('add-academic-year', {
                formData: req.body,
                error: 'Year name, start date, and end date are required'
            });
        }
        
        // Validate term dates
        if (!first_term_start || !first_term_end || 
            !second_term_start || !second_term_end || 
            !third_term_start || !third_term_end) {
            return res.render('add-academic-year', {
                formData: req.body,
                error: 'All term dates are required'
            });
        }
        
        // Format dates
        const formattedStartDate = moment(start_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        const formattedEndDate = moment(end_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        
        // If this is set as current year, unset any other current year
        if (is_current === 'on') {
            await connection.execute(
                'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
            );
        }
        
        // Insert new academic year
        const [result] = await connection.execute(
            'INSERT INTO academic_years (year_name, start_date, end_date, is_current) VALUES (?, ?, ?, ?)',
            [year_name, formattedStartDate, formattedEndDate, is_current === 'on']
        );
        
        const academicYearId = result.insertId;
        
        // Insert terms
        const terms = [
            { name: 'First Term', start: first_term_start, end: first_term_end },
            { name: 'Second Term', start: second_term_start, end: second_term_end },
            { name: 'Third Term', start: third_term_start, end: third_term_end }
        ];
        
        for (const term of terms) {
            const termStartDate = moment(term.start, 'YYYY-MM-DD').format('YYYY-MM-DD');
            const termEndDate = moment(term.end, 'YYYY-MM-DD').format('YYYY-MM-DD');
            
            await connection.execute(
                'INSERT INTO academic_terms (academic_year_id, term_name, start_date, end_date) VALUES (?, ?, ?, ?)',
                [academicYearId, term.name, termStartDate, termEndDate]
            );
        }
        
        req.session.success = 'Academic year added successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error adding academic year:', error);
        
        let errorMessage = 'Failed to add academic year';
        if (error.code === 'ER_DUP_ENTRY') {
            errorMessage = 'An academic year with this name already exists';
        }
        
        res.render('add-academic-year', {
            formData: req.body,
            error: errorMessage
        });
    }
});

// GET route to edit academic year
app.get('/edit-academic-year/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get academic year
        const [academicYears] = await connection.execute(
            'SELECT * FROM academic_years WHERE id = ?',
            [req.params.id]
        );
        
        if (academicYears.length === 0) {
            req.session.error = 'Academic year not found';
            return res.redirect('/academic-years');
        }
        
        // Get terms for this academic year
        const [terms] = await connection.execute(
            'SELECT * FROM academic_terms WHERE academic_year_id = ? ORDER BY FIELD(term_name, "First Term", "Second Term", "Third Term")',
            [req.params.id]
        );
        
        // Format data for form
        const formData = {
            ...academicYears[0],
            first_term_start: terms.find(t => t.term_name === 'First Term')?.start_date || '',
            first_term_end: terms.find(t => t.term_name === 'First Term')?.end_date || '',
            second_term_start: terms.find(t => t.term_name === 'Second Term')?.start_date || '',
            second_term_end: terms.find(t => t.term_name === 'Second Term')?.end_date || '',
            third_term_start: terms.find(t => t.term_name === 'Third Term')?.start_date || '',
            third_term_end: terms.find(t => t.term_name === 'Third Term')?.end_date || ''
        };
        
        res.render('edit-academic-year', {
            formData: formData,
            error: null
        });
    } catch (error) {
        console.error('Error fetching academic year:', error);
        req.session.error = 'Error loading academic year';
        res.redirect('/academic-years');
    }
});

// POST route to update academic year
app.post('/edit-academic-year/:id', uploadNoFile.none(), async (req, res) => {
    const academicYearId = req.params.id;
    const { 
        year_name, 
        start_date, 
        end_date, 
        is_current,
        first_term_start,
        first_term_end,
        second_term_start,
        second_term_end,
        third_term_start,
        third_term_end
    } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!year_name || !start_date || !end_date) {
            return res.render('edit-academic-year', {
                formData: req.body,
                error: 'Year name, start date, and end date are required'
            });
        }
        
        // Validate term dates
        if (!first_term_start || !first_term_end || 
            !second_term_start || !second_term_end || 
            !third_term_start || !third_term_end) {
            return res.render('edit-academic-year', {
                formData: req.body,
                error: 'All term dates are required'
            });
        }
        
        // Format dates
        const formattedStartDate = moment(start_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        const formattedEndDate = moment(end_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        
        // If this is set as current year, unset any other current year
        if (is_current === 'on') {
            await connection.execute(
                'UPDATE academic_years SET is_current = FALSE WHERE id != ? AND is_current = TRUE',
                [academicYearId]
            );
        }
        
        // Update academic year
        await connection.execute(
            'UPDATE academic_years SET year_name = ?, start_date = ?, end_date = ?, is_current = ? WHERE id = ?',
            [year_name, formattedStartDate, formattedEndDate, is_current === 'on', academicYearId]
        );
        
        // Update terms
        const terms = [
            { name: 'First Term', start: first_term_start, end: first_term_end },
            { name: 'Second Term', start: second_term_start, end: second_term_end },
            { name: 'Third Term', start: third_term_start, end: third_term_end }
        ];
        
        for (const term of terms) {
            const termStartDate = moment(term.start, 'YYYY-MM-DD').format('YYYY-MM-DD');
            const termEndDate = moment(term.end, 'YYYY-MM-DD').format('YYYY-MM-DD');
            
            await connection.execute(
                'UPDATE academic_terms SET start_date = ?, end_date = ? WHERE academic_year_id = ? AND term_name = ?',
                [termStartDate, termEndDate, academicYearId, term.name]
            );
        }
        
        req.session.success = 'Academic year updated successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error updating academic year:', error);
        
        let errorMessage = 'Failed to update academic year';
        if (error.code === 'ER_DUP_ENTRY') {
            errorMessage = 'An academic year with this name already exists';
        }
        
        res.render('edit-academic-year', {
            formData: req.body,
            error: errorMessage
        });
    }
});

// GET route to set academic year as current
app.get('/set-current-academic-year/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Unset any current academic year
        await connection.execute(
            'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
        );
        
        // Set the selected academic year as current
        await connection.execute(
            'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
            [req.params.id]
        );
        
        req.session.success = 'Current academic year set successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error setting current academic year:', error);
        req.session.error = 'Failed to set current academic year';
        res.redirect('/academic-years');
    }
});

// GET route to set term as current
app.get('/set-current-term/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get the term to set as current
        const [terms] = await connection.execute(
            'SELECT * FROM academic_terms WHERE id = ?',
            [req.params.id]
        );
        
        if (terms.length === 0) {
            req.session.error = 'Term not found';
            return res.redirect('/academic-years');
        }
        
        const term = terms[0];
        
        // Unset any current term
        await connection.execute(
            'UPDATE academic_terms SET is_current = FALSE WHERE is_current = TRUE'
        );
        
        // Set the selected term as current
        await connection.execute(
            'UPDATE academic_terms SET is_current = TRUE WHERE id = ?',
            [req.params.id]
        );
        
        // Also set the academic year as current if it's not already
        await connection.execute(
            'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
            [term.academic_year_id]
        );
        
        req.session.success = 'Current term set successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error setting current term:', error);
        req.session.error = 'Failed to set current term';
        res.redirect('/academic-years');
    }
});

// GET route to delete academic year
app.get('/delete-academic-year/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Check if academic year is used in any records
        const [academicYears] = await connection.execute(
            'SELECT year_name FROM academic_years WHERE id = ?',
            [req.params.id]
        );
        
        if (academicYears.length === 0) {
            req.session.error = 'Academic year not found';
            return res.redirect('/academic-years');
        }
        
        const yearName = academicYears[0].year_name;
        
        const [feeRecords] = await connection.execute(
            'SELECT COUNT(*) as count FROM fees WHERE academic_year = ?',
            [yearName]
        );
        
        const [scoreRecords] = await connection.execute(
            'SELECT COUNT(*) as count FROM student_scores WHERE academic_year = ?',
            [yearName]
        );
        
        if (feeRecords[0].count > 0 || scoreRecords[0].count > 0) {
            req.session.error = 'Cannot delete academic year. It is being used in fee records or student scores.';
            return res.redirect('/academic-years');
        }
        
        // Delete academic year (terms will be deleted automatically due to CASCADE)
        await connection.execute(
            'DELETE FROM academic_years WHERE id = ?',
            [req.params.id]
        );
        
        req.session.success = 'Academic year deleted successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error deleting academic year:', error);
        req.session.error = 'Failed to delete academic year';
        res.redirect('/academic-years');
    }
});

// Update the /add-student GET route to include error variable
// In your server file (app.js or similar)

// GET route to display the add student form
app.get('/add-student', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get classes with their levels and departments
        const [classes] = await connection.execute(`
            SELECT id, className, classCode, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);

        // Check for success message from session
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success;
        }

        res.render('add-student', { 
            classes: classes,
            nigerianStates: nigerianStates,
            formData: {},
            success: success,
            error: null,
            mode: 'add'
        });
    } catch (error) {
        console.error('Error loading add student form:', error);
        res.render('add-student', { 
            classes: [],
            nigerianStates: nigerianStates,
            formData: {},
            success: null,
            error: 'Failed to load data',
            mode: 'add'
        });
    }
});

// GET /edit-student/:id - Updated to handle errors better
app.get('/edit-student/:id', authenticate, async (req, res) => {
    const studentId = req.params.id;

    try {
        const connection = await getConnection();
        
        // Get student data
        const [students] = await connection.execute(
            'SELECT * FROM students WHERE id = ?',
            [studentId]
        );

        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/all-students');
        }

        const student = students[0];
        
        // Get classes with their levels and departments
        const [classes] = await connection.execute(`
            SELECT id, className, classCode, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);

        // Check for success message from session
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success;
        }

        res.render('edit-student', { 
            classes: classes,
            nigerianStates: nigerianStates,
            formData: student,
            success: success,
            error: null,
            mode: 'edit',
            studentId: studentId
        });
    } catch (error) {
        console.error('Error loading edit student form:', error);
        req.session.error = 'Error loading student data: ' + error.message;
        res.redirect('/all-students');
    }
});

// POST route to handle both add and edit form submission - Updated with better error handling
// POST route to handle both add and edit form submission - Fixed column error
app.post('/save-student', uploadNoFile.none(), async (req, res) => {
    const {
        studentId, // This will be present for edits, null for new students
        firstName,
        middleName,
        lastName,
        email,
        nationality,
        classId,
        gender,
        mobileNumber,
        parentsName,
        parentsMobileNumber,
        dateOfBirth,
        address,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA
    } = req.body;

    const isEdit = !!studentId; // Determine if this is an edit operation
    const mode = isEdit ? 'edit' : 'add';

    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!firstName || !lastName || !email || !classId) {
            const [classes] = await connection.execute('SELECT id, className FROM classes ORDER BY className');
            
            return res.render(isEdit ? 'edit-student' : 'add-student', { 
                classes: classes,
                nigerianStates: nigerianStates,
                formData: req.body,
                error: 'Please fill in all required fields (First Name, Last Name, Email, and Class).',
                mode: mode,
                studentId: studentId
            });
        }

        // Check if email already exists (excluding current student for edits)
        let emailCheckQuery = 'SELECT id, admission_number FROM students WHERE email = ?';
        let emailCheckParams = [email];
        
        if (isEdit) {
            emailCheckQuery += ' AND id != ?';
            emailCheckParams.push(studentId);
        }
        
        const [existingStudents] = await connection.execute(
            emailCheckQuery,
            emailCheckParams
        );
        
        if (existingStudents.length > 0) {
            const [classes] = await connection.execute('SELECT id, className FROM classes ORDER BY className');
            
            return res.render(isEdit ? 'edit-student' : 'add-student', { 
                classes: classes,
                nigerianStates: nigerianStates,
                formData: req.body,
                error: 'A student with this email already exists. Admission Number: ' + existingStudents[0].admission_number,
                mode: mode,
                studentId: studentId
            });
        }

        // Get department from class if it's Senior Secondary
        let studentDepartment = null;
        const [classInfo] = await connection.execute(
            'SELECT level, department FROM classes WHERE id = ?',
            [classId]
        );
        
        if (classInfo.length > 0 && classInfo[0].level === 'SENIOR SECONDARY') {
            studentDepartment = classInfo[0].department;
        }

        if (isEdit) {
            // Update existing student - REMOVED updated_at column
            await connection.execute(
                `UPDATE students SET 
                    firstName = ?, middleName = ?, lastName = ?, email = ?, classId = ?, 
                    gender = ?, mobileNumber = ?, parentsName = ?, parentsMobileNumber = ?, 
                    dateOfBirth = ?, nationality = ?, address = ?, department = ?, 
                    stateOfOrigin = ?, localGovernment = ?, residentialState = ?, residentialLGA = ?
                 WHERE id = ?`,
                [
                    firstName,
                    middleName,
                    lastName,
                    email,
                    classId,
                    gender || null,
                    mobileNumber || null,
                    parentsName || null,
                    parentsMobileNumber || null,
                    dateOfBirth || null,
                    nationality || null,
                    address || null,
                    studentDepartment,
                    stateOfOrigin || null,
                    localGovernment || null,
                    residentialState || null,
                    residentialLGA || null,
                    studentId
                ]
            );

            req.session.success = 'Student updated successfully!';
            res.redirect('/all-students');
        } else {
            // Add new student with admission number
            const currentYear = new Date().getFullYear().toString().slice(-2);
            
            // Get the last admission number for this year
            const [lastStudent] = await connection.execute(
                'SELECT admission_number FROM students WHERE admission_number LIKE ? ORDER BY id DESC LIMIT 1',
                [`ADM${currentYear}%`]
            );
            
            let nextNumber = 1;
            if (lastStudent.length > 0) {
                const lastAdmissionNumber = lastStudent[0].admission_number;
                const lastNumber = parseInt(lastAdmissionNumber.slice(5)) || 0;
                nextNumber = lastNumber + 1;
            }
            
            const admissionNumber = `ADM${currentYear}${nextNumber.toString().padStart(4, '0')}`;

            // Insert student with admission number
            await connection.execute(
                `INSERT INTO students 
                (admission_number, firstName, middleName, lastName, email, classId, gender, 
                 mobileNumber, parentsName, parentsMobileNumber, dateOfBirth, nationality, 
                 address, department, stateOfOrigin, localGovernment, residentialState, residentialLGA) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    admissionNumber,
                    firstName,
                    middleName,
                    lastName,
                    email,
                    classId,
                    gender || null,
                    mobileNumber || null,
                    parentsName || null,
                    parentsMobileNumber || null,
                    dateOfBirth || null,
                    nationality || null,
                    address || null,
                    studentDepartment,
                    stateOfOrigin || null,
                    localGovernment || null,
                    residentialState || null,
                    residentialLGA || null
                ]
            );

            // Set success message with admission number
            req.session.success = `Student added successfully! Admission Number: ${admissionNumber}`;
            res.redirect('/all-students');
        }

    } catch (error) {
        console.error('Error saving student:', error);
        
        const connection = await getConnection();
        const [classes] = await connection.execute('SELECT id, className FROM classes ORDER BY className');
        
        let errorMessage = `Failed to ${isEdit ? 'update' : 'add'} student. Please try again.`;
        if (error.code === 'ER_DUP_ENTRY') {
            if (error.sqlMessage.includes('admission_number')) {
                errorMessage = 'Failed to generate unique admission number. Please try again.';
            } else if (error.sqlMessage.includes('email')) {
                errorMessage = 'A student with this email already exists.';
            }
        } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            errorMessage = 'The selected class does not exist.';
        } else if (error.code === 'ER_DATA_TOO_LONG') {
            errorMessage = 'One or more fields contain data that is too long. Please check your inputs.';
        } else if (error.code === 'ER_BAD_FIELD_ERROR') {
            errorMessage = 'Database field error. Please contact administrator.';
        }

        // Render the appropriate form based on whether we're editing or adding
        res.render(isEdit ? 'edit-student' : 'add-student', { 
            classes: classes,
            nigerianStates: nigerianStates,
            formData: req.body,
            error: errorMessage,
            mode: mode,
            studentId: studentId
        });
    }
});

// GET route to delete student - Added proper error handling
app.get('/delete-student/:id', authenticate, async (req, res) => {
    const studentId = req.params.id;

    try {
        const connection = await getConnection();
        
        // First check if student exists
        const [students] = await connection.execute(
            'SELECT admission_number FROM students WHERE id = ?',
            [studentId]
        );
        
        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/all-students');
        }
        
        const admissionNumber = students[0].admission_number;
        
        // Check if student has related records that would prevent deletion
        try {
            // First delete related fees
            await connection.execute('DELETE FROM fees WHERE studentId = ?', [studentId]);
            
            // Then delete the student
            const [result] = await connection.execute('DELETE FROM students WHERE id = ?', [studentId]);
            
            if (result.affectedRows === 0) {
                req.session.error = 'Failed to delete student';
            } else {
                req.session.success = `Student ${admissionNumber} deleted successfully`;
            }
            
        } catch (error) {
            console.error('Error deleting student:', error);
            
            if (error.code === 'ER_ROW_IS_REFERENCED_2') {
                req.session.error = `Cannot delete student ${admissionNumber}. There are related records that must be deleted first.`;
            } else {
                req.session.error = 'Error deleting student: ' + error.message;
            }
        }
        
        res.redirect('/all-students');
    } catch (error) {
        console.error('Error in delete student process:', error);
        req.session.error = 'Error processing delete request';
        res.redirect('/all-students');
    }
});
app.get('/all-students', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [students] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department AS classDepartment
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            ORDER BY 
                CASE 
                    WHEN c.level = 'KG' THEN 1
                    WHEN c.level = 'NURSERY' THEN 2
                    WHEN c.level = 'PRIMARY' THEN 3
                    WHEN c.level = 'JUNIOR SECONDARY' THEN 4
                    WHEN c.level = 'SENIOR SECONDARY' THEN 5
                    ELSE 6
                END,
                c.className,
                s.admission_number,  -- Sort by admission number
                s.firstName
        `);
        
        // Format registration dates for display
        const formattedStudents = students.map(student => ({
            ...student,
            registrationDate: student.registrationDate ? 
                new Date(student.registrationDate).toLocaleDateString() : 'N/A',
            dateOfBirth: student.dateOfBirth ?
                new Date(student.dateOfBirth).toLocaleDateString() : 'N/A'
        }));
        
        // Check for success message from session (e.g., after adding a student)
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success; // Clear the message after displaying
        }
        
        res.render('all-students', { 
            students: formattedStudents,
            success: success,
            error: null
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        res.render('all-students', { 
            students: [], 
            error: 'Failed to load students.',
            success: null
        });
    }
});

// Teacher Routes
app.get('/add-teacher', authenticate, (req, res) => {
    res.render('add-teacher', { formData: {}, error: null });
});


app.get('/all-teachers', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [teachers] = await connection.execute('SELECT * FROM teachers ORDER BY firstName, lastName');
        
        // Format dates for display
        const formattedTeachers = teachers.map(teacher => ({
            ...teacher,
            joiningDate: teacher.joiningDate ? moment(teacher.joiningDate).format('D MMMM, YYYY') : 'N/A',
            dateOfBirth: teacher.dateOfBirth ? moment(teacher.dateOfBirth).format('D MMMM, YYYY') : 'N/A'
        }));
        
        res.render('all-teachers', { 
            teachers: formattedTeachers, 
            error: null,
            success: req.session.success || null
        });
        
        // Clear success message
        delete req.session.success;
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.render('all-teachers', { 
            teachers: [], 
            error: 'Failed to load teachers. Please try again.' 
        });
    }
});

app.get('/edit-teacher/:id', authenticate, async (req, res) => {
    const teacherId = req.params.id;

    try {
        const connection = await getConnection();
        const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ?', [teacherId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/all-teachers');
        }

        const teacher = teachers[0];
        
        // Format dates for the form
        const formattedTeacher = {
            ...teacher,
            joiningDate: teacher.joiningDate ? moment(teacher.joiningDate).format('D MMMM, YYYY') : '',
            dateOfBirth: teacher.dateOfBirth ? moment(teacher.dateOfBirth).format('D MMMM, YYYY') : ''
        };
        
        res.render('edit-teacher', { 
            teacher: formattedTeacher, 
            error: null 
        });
    } catch (error) {
        console.error('Error fetching teacher:', error);
        req.session.error = 'Error fetching teacher details';
        res.redirect('/all-teachers');
    }
});

app.post('/add-teacher', authenticate, uploadNoFile.none(), async (req, res) => {

    const {
        firstName,
        lastName,
        email,
        joiningDate,
        password,
        mobileNumber,
        gender,
        designation,
        department,
        dateOfBirth,
        education,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address
    } = req.body;

    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'joiningDate', 'password', 'mobileNumber'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            return res.render('add-teacher', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                formData: req.body
            });
        }

        const connection = await getConnection();

        // Hash the password
        const hashedPassword = await argon2.hash(password);

        // Format the dates
        let formattedJoiningDate = null;
        let formattedDateOfBirth = null;
        
        try {
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid() 
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            return res.render('add-teacher', { 
                error: 'Invalid date format. Please use the correct date format.',
                formData: req.body
            });
        }

        // Insert into database
        const [result] = await connection.execute(
            `INSERT INTO teachers 
            (firstName, lastName, email, joiningDate, password, mobileNumber, gender, 
            designation, department, dateOfBirth, education, nationality, stateOfOrigin, 
            localGovernment, residentialState, residentialLGA, emergencyContactName, 
            emergencyContactNumber, address) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                firstName,
                lastName,
                email,
                formattedJoiningDate,
                hashedPassword,
                mobileNumber,
                gender || null,
                designation || null,
                department || null,
                formattedDateOfBirth,
                education || null,
                nationality || null,
                stateOfOrigin || null,
                localGovernment || null,
                residentialState || null,
                residentialLGA || null,
                emergencyContactName || null,
                emergencyContactNumber || null,
                address || null
            ]
        );

        console.log('Teacher inserted successfully, ID:', result.insertId);
        
        // Set success message in session
        req.session.success = 'Teacher added successfully';
        res.redirect('/all-teachers');
        
    } catch (error) {
        console.error('Error adding teacher:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.render('add-teacher', { 
                error: 'Email already exists',
                formData: req.body
            });
        }
        
        res.render('add-teacher', { 
            error: 'Failed to add teacher. Please try again. Error: ' + error.message,
            formData: req.body
        });
    }
});

app.post('/edit-teacher/:id', authenticate, uploadNoFile.none(), async (req, res) => {
    const teacherId = req.params.id; 
    const {
        firstName,
        lastName,
        email,
        joiningDate,
        mobileNumber,
        gender,
        designation,
        department,
        dateOfBirth,
        education,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address
    } = req.body;

    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'joiningDate', 'mobileNumber'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            const connection = await getConnection();
            const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ?', [teacherId]);
            return res.render('edit-teacher', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                teacher: teachers[0] || {}
            });
        }

        const connection = await getConnection();

        // Format the dates to 'YYYY-MM-DD'
        let formattedJoiningDate = null;
        let formattedDateOfBirth = null;
        
        try {
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid() 
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            const connection = await getConnection();
            const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ?', [teacherId]);
            return res.render('edit-teacher', { 
                error: 'Invalid date format. Please use the correct date format',
                teacher: teachers[0] || {}
            });
        }

        // Update the teacher in the database
        const [result] = await connection.execute(
            `UPDATE teachers SET 
            firstName = ?, lastName = ?, email = ?, joiningDate = ?, mobileNumber = ?, 
            gender = ?, designation = ?, department = ?, dateOfBirth = ?, education = ?,
            nationality = ?, stateOfOrigin = ?, localGovernment = ?, residentialState = ?,
            residentialLGA = ?, emergencyContactName = ?, emergencyContactNumber = ?, address = ?
            WHERE id = ?`,
            [
                firstName,
                lastName,
                email,
                formattedJoiningDate,
                mobileNumber,
                gender || null,
                designation || null,
                department || null,
                formattedDateOfBirth,
                education || null,
                nationality || null,
                stateOfOrigin || null,
                localGovernment || null,
                residentialState || null,
                residentialLGA || null,
                emergencyContactName || null,
                emergencyContactNumber || null,
                address || null,
                teacherId
            ]
        );

        console.log('Update result:', result);

        if (result.affectedRows === 0) {
            req.session.error = 'Teacher not found or no changes made';
        } else {
            req.session.success = 'Teacher updated successfully';
        }
        
        res.redirect('/all-teachers');
    } catch (error) {
        console.error('Error updating teacher:', error);
        
        // Handle duplicate email error
        if (error.code === 'ER_DUP_ENTRY') {
            const connection = await getConnection();
            const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ?', [teacherId]);
            return res.render('edit-teacher', { 
                error: 'Email already exists',
                teacher: teachers[0] || {}
            });
        }
        
        req.session.error = 'Error updating teacher: ' + error.message;
        res.redirect('/all-teachers');
    }
});
app.get('/delete-teacher/:id', authenticate, async (req, res) => {
    const teacherId = req.params.id;

    try {
        const connection = await getConnection();
        
        // Check if teacher exists before deleting
        const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ?', [teacherId]);
        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/all-teachers');
        }

        const [result] = await connection.execute('DELETE FROM teachers WHERE id = ?', [teacherId]);
        
        if (result.affectedRows === 0) {
            req.session.error = 'Failed to delete teacher';
        } else {
            req.session.success = 'Teacher deleted successfully';
        }
        
        res.redirect('/all-teachers');
    } catch (error) {
        console.error('Error deleting teacher:', error);
        
        // Handle foreign key constraint errors
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            req.session.error = 'Cannot delete teacher. This teacher is associated with existing records.';
        } else {
            req.session.error = 'Error deleting teacher: ' + error.message;
        }
        
        res.redirect('/all-teachers');
    }
});

app.get('/add-class', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [teachers] = await connection.execute('SELECT id, firstName, lastName FROM teachers ORDER BY lastName');
        
        res.render('add-class', {
            teachers: teachers,
            formData: {
                level: '',
                department: ''
            },
            error: null
        });
    } catch (error) {
        console.error('Error loading add class form:', error);
        res.render('add-class', {
            teachers: [],
            formData: {
                level: '',
                department: ''
            },
            error: 'Failed to load teacher data'
        });
    }
});

app.post('/add-class', uploadNoFile.none(), async (req, res) => {
    const {
        className,
        classCode,
        professorId,
        maximumStudents,
        level,
        department
    } = req.body;

    try {
        const connection = await getConnection();
        const [teachers] = await connection.execute('SELECT id, firstName, lastName FROM teachers ORDER BY lastName');

        // Validate required fields
        if (!className || !classCode || !professorId || !level) {
            return res.render('add-class', {
                teachers: teachers,
                formData: req.body,
                error: 'Class Name, Class Code, Level and Teacher are required fields'
            });
        }

        // Validate department for Senior Secondary
        if (level === 'SENIOR SECONDARY' && !department) {
            return res.render('add-class', {
                teachers: teachers,
                formData: req.body,
                error: 'Department is required for Senior Secondary'
            });
        }

        // Verify teacher exists
        const [teacher] = await connection.execute(
            'SELECT firstName, lastName FROM teachers WHERE id = ?', 
            [professorId]
        );
        
        if (teacher.length === 0) {
            return res.render('add-class', {
                teachers: teachers,
                formData: req.body,
                error: 'Selected teacher does not exist'
            });
        }

        const professorName = `${teacher[0].firstName} ${teacher[0].lastName}`;

        // Insert into database
        await connection.execute(
            `INSERT INTO classes 
            (className, classCode, professorName, professorId, maximumStudents, level, department) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                className,
                classCode,
                professorName,
                professorId,
                maximumStudents || null,
                level,
                level === 'SENIOR SECONDARY' ? department : null
            ]
        );

        res.redirect('/all-classes');

    } catch (error) {
        console.error('Error adding class:', error);
        const [teachers] = await getConnection().execute('SELECT id, firstName, lastName FROM teachers ORDER BY lastName');
        
        res.render('add-class', {
            teachers: teachers,
            formData: req.body,
            error: 'Failed to add class: ' + error.message
        });
    }
});

app.get('/all-classes', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [classes] = await connection.execute(`
            SELECT 
                id, 
                className, 
                level,
                department,
                classCode,
                professorName,
                professorId,
                maximumStudents
            FROM classes
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);
        
        res.render('all-classes', { classes: classes });
    } catch (error) {
        console.error('Error fetching classes:', error);
        res.render('all-classes', { 
            classes: [], 
            error: 'Failed to load classes' 
        });
    }
});

app.get('/edit-class/:id', authenticate, async (req, res) => {
    const classId = req.params.id;

    try {
        const connection = await getConnection();
        const [classes] = await connection.execute('SELECT * FROM classes WHERE id = ?', [classId]);

        if (classes.length === 0) {
            return res.status(404).send('Class not found');
        }

        const classData = classes[0];
        res.render('edit-class', { classData: classData });
    } catch (error) {
        console.error('Error fetching class:', error);
        res.status(500).send('Error fetching class');
    }
});

app.post('/edit-class/:id', authenticate, async (req, res) => {
    const classId = req.params.id;
    const {
        className,
        classCode,
        classDetails,
        startDate,
        classDuration,
        classPrice,
        professorName,
        maximumStudents,
        contactNumber,
        coursePhoto
    } = req.body;

    try {
        const connection = await getConnection();

        // Format the dates to 'YYYY-MM-DD'
        const formattedStartDate = moment(startDate, 'D MMMM, YYYY').format('YYYY-MM-DD');

        // Update the class in the database
        await connection.execute(
            'UPDATE classes SET className = ?, classCode = ?, classDetails = ?, startDate = ?, classDuration = ?, classPrice = ?, professorName = ?, maximumStudents = ?, contactNumber = ?, coursePhoto = ? WHERE id = ?',
            [className, classCode, classDetails, formattedStartDate, classDuration, classPrice, professorName, maximumStudents, contactNumber, coursePhoto, classId]
        );
        
        res.redirect('/all-classes');
    } catch (error) {
        console.error('Error updating class:', error);
        res.status(500).send('Error updating class');
    }
});

app.get('/delete-class/:id', authenticate, async (req, res) => {
    const classId = req.params.id;

    try {
        const connection = await getConnection();
        await connection.execute('DELETE FROM classes WHERE id = ?', [classId]);
        res.redirect('/all-classes');
    } catch (error) {
        console.error('Error deleting class:', error);
        res.status(500).send('Error deleting class');
    }
});

// Staff Routes
app.get('/all-staff', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [staff] = await connection.execute('SELECT * FROM staff');
        res.render('all-staff', { staff: staff });
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.render('all-staff', { staff: [], error: 'Failed to load staff.' });
    }
});

app.get('/add-staff', authenticate, (req, res) => {
    res.render('add-staff');
});

app.post('/add-staff', uploadWithFile.single('image'), async (req, res) => {
    const {
        firstName,
        lastName,
        gender,
        dateOfBirth,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address,
        email,
        position,
        department,
        phone,
        joiningDate
    } = req.body;
    
    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'position', 'department', 'phone'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            return res.render('add-staff', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                formData: req.body
            });
        }

        const connection = await getConnection();
        let imagePath = req.file ? '/images/staff/' + req.file.filename : null;
        
        // Format dates
        let formattedDateOfBirth = null;
        let formattedJoiningDate = null;
        
        try {
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid()
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            return res.render('add-staff', { 
                error: 'Invalid date format. Please use the correct date format.',
                formData: req.body
            });
        }

        await connection.execute(
            `INSERT INTO staff 
            (firstName, lastName, gender, dateOfBirth, nationality, stateOfOrigin, 
            localGovernment, residentialState, residentialLGA, emergencyContactName, 
            emergencyContactNumber, address, email, position, department, phone, 
            joiningDate, imagePath) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                firstName,
                lastName,
                gender || null,
                formattedDateOfBirth,
                nationality || null,
                stateOfOrigin || null,
                localGovernment || null,
                residentialState || null,
                residentialLGA || null,
                emergencyContactName || null,
                emergencyContactNumber || null,
                address || null,
                email,
                position,
                department,
                phone,
                formattedJoiningDate,
                imagePath
            ]
        );
        
        req.session.success = 'Staff member added successfully';
        res.redirect('/all-staff');
    } catch (error) {
        console.error('Error adding staff:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.render('add-staff', { 
                error: 'Email already exists',
                formData: req.body
            });
        }
        
        res.render('add-staff', { 
            error: 'Failed to add staff. Please try again. Error: ' + error.message,
            formData: req.body
        });
    }
});

// Add edit staff route
app.get('/edit-staff/:id', authenticate, async (req, res) => {
    const staffId = req.params.id;
    
    try {
        const connection = await getConnection();
        const [staff] = await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
        
        if (staff.length === 0) {
            req.session.error = 'Staff member not found';
            return res.redirect('/all-staff');
        }
        
        res.render('edit-staff', { staff: staff[0] });
    } catch (error) {
        console.error('Error fetching staff:', error);
        req.session.error = 'Error loading staff details';
        res.redirect('/all-staff');
    }
});

app.post('/edit-staff/:id', uploadWithFile.single('image'), async (req, res) => {
    const staffId = req.params.id;
    const {
        firstName,
        lastName,
        gender,
        dateOfBirth,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address,
        email,
        position,
        department,
        phone,
        joiningDate
    } = req.body;
    
    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'position', 'department', 'phone'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            const connection = await getConnection();
            const [staff] = await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
            return res.render('edit-staff', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                staff: staff[0] || {}
            });
        }

        const connection = await getConnection();
        
        // Check if new image was uploaded
        let imagePath = null;
        if (req.file) {
            imagePath = '/images/staff/' + req.file.filename;
            
            // Get old image path to delete it later
            const [currentStaff] = await connection.execute('SELECT imagePath FROM staff WHERE id = ?', [staffId]);
            const oldImagePath = currentStaff[0]?.imagePath;
            
            // Delete old image file if it exists
            if (oldImagePath) {
                const fs = require('fs');
                const path = require('path');
                const oldImageFullPath = path.join(__dirname, 'public', oldImagePath);
                
                if (fs.existsSync(oldImageFullPath)) {
                    fs.unlinkSync(oldImageFullPath);
                }
            }
        }
        
        // Format dates
        let formattedDateOfBirth = null;
        let formattedJoiningDate = null;
        
        try {
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid()
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            const connection = await getConnection();
            const [staff] = await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
            return res.render('edit-staff', { 
                error: 'Invalid date format. Please use the correct date format.',
                staff: staff[0] || {}
            });
        }

        // Build update query based on whether image was uploaded
        let query, params;
        if (imagePath) {
            query = `UPDATE staff SET 
                firstName = ?, lastName = ?, gender = ?, dateOfBirth = ?, nationality = ?, 
                stateOfOrigin = ?, localGovernment = ?, residentialState = ?, residentialLGA = ?, 
                emergencyContactName = ?, emergencyContactNumber = ?, address = ?, email = ?, 
                position = ?, department = ?, phone = ?, joiningDate = ?, imagePath = ? 
                WHERE id = ?`;
            params = [
                firstName, lastName, gender || null, formattedDateOfBirth, nationality || null,
                stateOfOrigin || null, localGovernment || null, residentialState || null,
                residentialLGA || null, emergencyContactName || null, emergencyContactNumber || null,
                address || null, email, position, department, phone, formattedJoiningDate,
                imagePath, staffId
            ];
        } else {
            query = `UPDATE staff SET 
                firstName = ?, lastName = ?, gender = ?, dateOfBirth = ?, nationality = ?, 
                stateOfOrigin = ?, localGovernment = ?, residentialState = ?, residentialLGA = ?, 
                emergencyContactName = ?, emergencyContactNumber = ?, address = ?, email = ?, 
                position = ?, department = ?, phone = ?, joiningDate = ? 
                WHERE id = ?`;
            params = [
                firstName, lastName, gender || null, formattedDateOfBirth, nationality || null,
                stateOfOrigin || null, localGovernment || null, residentialState || null,
                residentialLGA || null, emergencyContactName || null, emergencyContactNumber || null,
                address || null, email, position, department, phone, formattedJoiningDate,
                staffId
            ];
        }

        const [result] = await connection.execute(query, params);

        if (result.affectedRows === 0) {
            req.session.error = 'Staff member not found or no changes made';
        } else {
            req.session.success = 'Staff member updated successfully';
        }
        
        res.redirect('/all-staff');
    } catch (error) {
        console.error('Error updating staff:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            const connection = await getConnection();
            const [staff] = await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
            return res.render('edit-staff', { 
                error: 'Email already exists',
                staff: staff[0] || {}
            });
        }
        
        req.session.error = 'Error updating staff member: ' + error.message;
        res.redirect('/all-staff');
    }
});
// Fees Routes


// GET route to display add fees form
app.get('/api/terms/:academicYearId', authenticate, async (req, res) => {
    const { academicYearId } = req.params;
    
    try {
        const connection = await getConnection();
        
        const [terms] = await connection.execute(`
            SELECT id, term_name, is_current 
            FROM academic_terms 
            WHERE academic_year_id = ? 
            ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `, [academicYearId]);
        
        res.json(terms);
        
    } catch (error) {
        console.error('Error fetching terms:', error);
        res.status(500).json({ error: 'Failed to fetch terms' });
    }
});

// GET route to display add fees form
app.get('/add-fees', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get students with class information
        const [students] = await connection.execute(`
            SELECT 
                s.id, 
                s.firstName, 
                s.middleName, 
                s.lastName, 
                s.email,
                s.classId,
                c.className, 
                c.department AS classDepartment 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.classId IS NOT NULL
            ORDER BY s.firstName, s.lastName
        `);
        
        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get current academic year
        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get terms for the current academic year
        let terms = [];
        if (currentAcademicYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);
        }
        
        // Get distinct fee types from class bills
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Get school information
        const [schoolInfo] = await connection.execute(`
            SELECT * FROM school_info LIMIT 1
        `);
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };

        res.render('add-fees', { 
            students: students,
            feeTypes: feeTypes,
            paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '',
            school: school,
            formData: {}
        });
    } catch (error) {
        console.error('Error loading add fees form:', error);
        res.render('add-fees', { 
            students: [], 
            feeTypes: [],
            paymentTypes: [],
            academicYears: [],
            terms: [],
            currentAcademicYear: '',
            school: {
                name: "Excel College",
                address: "12 Education Road, Lagos, Nigeria",
                email: "info@excelcollege.edu.ng",
                phone: "+234 812 345 6789",
                website: "www.excelcollege.edu.ng"
            },
            formData: {},
            error: 'Failed to load form data'
        });
    }
});

// Get bill amount for specific criteria
app.post('/get-bill-amount', uploadNoFile.none(), async (req, res) => {
    try {
        const { studentId, feeType, academicYear, term } = req.body;
        
        if (!studentId || !feeType || !academicYear || !term) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters'
            });
        }
        
        const connection = await getConnection();
        
        // Get student's class first
        const [studentData] = await connection.execute(
            'SELECT classId FROM students WHERE id = ?',
            [studentId]
        );
        
        if (studentData.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Student not found'
            });
        }
        
        const classId = studentData[0].classId;
        
        // Get bill amount
        const [bills] = await connection.execute(`
            SELECT amount FROM class_bills 
            WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [classId, feeType, academicYear, term]);
        
        if (bills.length > 0) {
            res.json({
                success: true,
                amount: bills[0].amount,
                hasBill: true
            });
        } else {
            // Check if fee type exists at all
            const [feeTypeCheck] = await connection.execute(`
                SELECT fee_type FROM class_bills 
                WHERE fee_type = ? AND is_active = 1 LIMIT 1
            `, [feeType]);
            
            if (feeTypeCheck.length === 0) {
                res.json({
                    success: false,
                    error: `Fee type "${feeType}" is not configured in the system.`,
                    hasBill: false
                });
            } else {
                res.json({
                    success: false,
                    error: 'No bill found for the selected criteria',
                    hasBill: false
                });
            }
        }
    } catch (error) {
        console.error('Error fetching bill amount:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch bill amount'
        });
    }
});

// POST route to handle fee payment submission
app.post('/add-fees', uploadNoFile.none(), async (req, res) => {
    const { studentId, feeType, paymentType, amount, academicYear, term, paymentDate, notes } = req.body;

    try {
        const connection = await getConnection();
        
        // Get students list for form repopulation in case of error
        const [students] = await connection.execute(`
            SELECT 
                s.id, 
                s.firstName, 
                s.middleName, 
                s.lastName, 
                s.email,
                s.classId,
                c.className 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            ORDER BY s.firstName, s.lastName
        `);

        // Get academic years for the form in case of error
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get terms for the selected academic year
        let terms = [];
        const [selectedYear] = await connection.execute(
            'SELECT id FROM academic_years WHERE year_name = ?',
            [academicYear]
        );
        
        if (selectedYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [selectedYear[0].id]);
        }
        
        // Get distinct fee types from class bills for form repopulation
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Get school information
        const [schoolInfo] = await connection.execute(`
            SELECT * FROM school_info LIMIT 1
        `);
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };

        // Validate required fields
        const errors = [];
        if (!studentId) errors.push('Student');
        if (!feeType) errors.push('Fee Type');
        if (!paymentType) errors.push('Payment Type');
        if (!amount) errors.push('Amount');
        if (!academicYear) errors.push('Academic Year');
        if (!term) errors.push('Term');
        if (!paymentDate) errors.push('Payment Date');

        if (errors.length > 0) {
            return res.render('add-fees', {
                students: students,
                feeTypes: feeTypes,
                paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: academicYear,
                school: school,
                formData: req.body,
                error: `Missing required fields: ${errors.join(', ')}`
            });
        }

        // Validate amount is a valid number
        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
            return res.render('add-fees', {
                students: students,
                feeTypes: feeTypes,
                paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: academicYear,
                school: school,
                formData: req.body,
                error: 'Please enter a valid amount in Naira'
            });
        }

        // Get student's actual details from database including classId and admission_number
        const [studentData] = await connection.execute(`
            SELECT 
                s.firstName, s.middleName, s.lastName, s.email, s.classId, s.admission_number,
                c.className, c.department 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?`, 
            [studentId]
        );
        
        if (studentData.length === 0) {
            return res.render('add-fees', {
                students: students,
                feeTypes: feeTypes,
                paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: academicYear,
                school: school,
                formData: req.body,
                error: 'Selected student not found'
            });
        }

        const student = studentData[0];
        const studentName = `${student.firstName} ${student.middleName || ''} ${student.lastName}`.trim();
        const studentClass = student.className || 'Not assigned';
        const studentDepartment = student.department || '';
        const studentEmail = student.email || '';
        const admissionNumber = student.admission_number || '';
        
        // Check if there's a class bill for this fee type
        const [classBills] = await connection.execute(`
            SELECT amount FROM class_bills 
            WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [student.classId, feeType, academicYear, term]);
        
        let billAmount = 0;
        let hasBill = false;
        
        if (classBills.length > 0) {
            hasBill = true;
            billAmount = parseFloat(classBills[0].amount);
        } else {
            // If no bill found, check if fee type exists in class bills at all
            const [feeTypeCheck] = await connection.execute(`
                SELECT fee_type FROM class_bills 
                WHERE fee_type = ? AND is_active = 1 LIMIT 1
            `, [feeType]);
            
            if (feeTypeCheck.length === 0) {
                return res.render('add-fees', {
                    students: students,
                    feeTypes: feeTypes,
                    paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                    academicYears: academicYears,
                    terms: terms,
                    currentAcademicYear: academicYear,
                    school: school,
                    formData: req.body,
                    error: `Fee type "${feeType}" is not configured in the system. Please contact administrator.`
                });
            }
        }
        
        // Calculate total amount paid so far for this fee type, term, and academic year
        const [previousPayments] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid, SUM(balance) as totalBalance 
            FROM fees 
            WHERE studentId = ? AND feeType = ? AND academicYear = ? AND term = ?
        `, [studentId, feeType, academicYear, term]);
        
        const totalPaidSoFar = parseFloat(previousPayments[0].totalPaid) || 0;
        const currentBalance = parseFloat(previousPayments[0].totalBalance) || 0;
        
        // Check if this is a subsequent payment for the same fee type
        const isSubsequentPayment = totalPaidSoFar > 0;
        
        // Calculate remaining balance and new payment details
        let amountPaid = amountValue;
        let balance = 0;
        let status = 'paid';
        let notificationType = 'success';
        
        if (hasBill) {
            const totalAmountDue = billAmount;
            const totalPaidAfterThisPayment = totalPaidSoFar + amountValue;
            
            if (totalPaidAfterThisPayment < totalAmountDue) {
                // Partial payment - still owes more
                status = 'partial';
                balance = totalAmountDue - totalPaidAfterThisPayment;
            } else if (totalPaidAfterThisPayment > totalAmountDue) {
                // Overpayment - student paid more than required
                status = 'overpaid';
                balance = -(totalPaidAfterThisPayment - totalAmountDue); // Negative balance indicates overpayment
                amountPaid = totalAmountDue - totalPaidSoFar; // Adjust amount paid to avoid over-crediting
            } else {
                // Exact payment - fully paid
                status = 'paid';
                balance = 0;
            }
        } else {
            // No bill exists, use the entered amount
            status = 'paid';
            balance = 0;
        }
        
        // Format payment date
        const formattedPaymentDate = moment(paymentDate, 'YYYY-MM-DD').format('YYYY-MM-DD');
        
        // Generate receipt number
        const receiptNumber = 'REC-' + Date.now();
        
        // Insert fee payment
        await connection.execute(
            `INSERT INTO fees (
                studentId, admission_number, studentName, email,
                className, department,
                feeType, paymentType, amount, billAmount, amountPaid, balance, paymentDate, 
                receiptNumber, academicYear, term, notes, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                studentId,
                admissionNumber,
                studentName,
                studentEmail,
                studentClass,
                studentDepartment,
                feeType,
                paymentType,
                hasBill ? billAmount : amountValue, // amount
                hasBill ? billAmount : amountValue, // billAmount
                amountPaid,
                balance,
                formattedPaymentDate,
                receiptNumber,
                academicYear,
                term,
                notes || null,
                status
            ]
        );

        // Set success notification with appropriate message
        let message = '';
        let notificationTitle = 'Fee Payment Successful';
        
        if (isSubsequentPayment) {
            notificationTitle = 'Additional Payment Recorded';
            message = `Additional payment of ₦${amountValue.toLocaleString()} recorded for ${studentName}! Receipt: ${receiptNumber}`;
            
            if (hasBill) {
                message += `\n\nPrevious payments: ₦${totalPaidSoFar.toLocaleString()}`;
                message += `\nThis payment: ₦${amountPaid.toLocaleString()}`;
                message += `\nTotal paid now: ₦${(totalPaidSoFar + amountPaid).toLocaleString()} of ₦${billAmount.toLocaleString()}`;
                
                if (status === 'partial') {
                    message += `\nRemaining Balance: ₦${balance.toLocaleString()}`;
                    notificationType = 'info';
                } else if (status === 'overpaid') {
                    message += `\nOverpayment: ₦${Math.abs(balance).toLocaleString()} (this amount will be credited for future payments)`;
                    notificationType = 'warning';
                } else if (status === 'paid') {
                    message += `\nFee fully paid! No balance remaining.`;
                    notificationType = 'success';
                }
            }
        } else {
            // First payment for this fee type
            message = `Fee payment of ₦${amountValue.toLocaleString()} recorded successfully for ${studentName}! Receipt: ${receiptNumber}`;
            
            if (hasBill) {
                if (status === 'partial') {
                    message += `\nRemaining Balance: ₦${balance.toLocaleString()}`;
                    notificationType = 'info';
                } else if (status === 'overpaid') {
                    message += `\nOverpayment: ₦${Math.abs(balance).toLocaleString()} (this amount will be credited for future payments)`;
                    notificationType = 'warning';
                } else if (status === 'paid') {
                    message += `\nFee fully paid! No balance remaining.`;
                    notificationType = 'success';
                }
                
                message += `\nTotal paid for ${feeType} (${term}): ₦${(totalPaidSoFar + amountPaid).toLocaleString()} of ₦${billAmount.toLocaleString()}`;
            }
        }
        
        req.session.notification = {
            type: notificationType,
            title: notificationTitle,
            message: message,
            isSubsequentPayment: isSubsequentPayment,
            previousAmount: totalPaidSoFar,
            currentAmount: totalPaidSoFar + amountPaid,
            totalDue: hasBill ? billAmount : amountValue,
            balance: balance,
            receiptNumber: receiptNumber,
            studentName: studentName
        };
        
        res.redirect('/fees-collection');

    } catch (error) {
        console.error('Error adding fee payment:', error);
        
        // Get fresh data for form repopulation
        const connection = await getConnection();
        const [students] = await connection.execute(`
            SELECT 
                s.id, 
                s.firstName, 
                s.middleName, 
                s.lastName, 
                s.email,
                c.className 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            ORDER BY s.firstName, s.lastName
        `);
        
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get terms for the selected academic year if available
        let terms = [];
        if (req.body.academicYear) {
            const [selectedYear] = await connection.execute(
                'SELECT id FROM academic_years WHERE year_name = ?',
                [req.body.academicYear]
            );
            
            if (selectedYear.length > 0) {
                [terms] = await connection.execute(`
                    SELECT * FROM academic_terms 
                    WHERE academic_year_id = ? 
                    ORDER BY 
                        CASE term_name
                            WHEN 'First Term' THEN 1
                            WHEN 'Second Term' THEN 2
                            WHEN 'Third Term' THEN 3
                        END
                `, [selectedYear[0].id]);
            }
        }
        
        // Get distinct fee types from class bills for form repopulation
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Get school information
        const [schoolInfo] = await connection.execute(`
            SELECT * FROM school_info LIMIT 1
        `);
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };
        
        res.render('add-fees', {
            students: students,
            feeTypes: feeTypes,
            paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: req.body.academicYear || '',
            school: school,
            formData: req.body,
            error: error.code === 'ER_DUP_ENTRY' ? 'A fee payment with these details already exists' : 'Failed to add fee payment: ' + error.message
        });
    }
});

// Get class bills for a specific class
app.get('/get-class-bills', authenticate, async (req, res) => {
    try {
        const { classId } = req.query;
        
        const connection = await getConnection();
        const [bills] = await connection.execute(`
            SELECT * FROM class_bills 
            WHERE class_id = ? AND is_active = 1
            ORDER BY fee_type
        `, [classId]);
        
        res.json({
            success: true,
            bills: bills
        });
    } catch (error) {
        console.error('Error fetching class bills:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch class bills'
        });
    }
});

// Get bill amount for specific criteria
app.post('/get-bill-amount', uploadNoFile.none(), async (req, res) => {
    try {
        const { classId, feeType, academicYear, term } = req.body;
        
        const connection = await getConnection();
        const [bills] = await connection.execute(`
            SELECT amount FROM class_bills 
            WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [classId, feeType, academicYear, term]);
        
        if (bills.length > 0) {
            res.json({
                success: true,
                amount: bills[0].amount
            });
        } else {
            res.json({
                success: false,
                error: 'No bill found for the selected criteria'
            });
        }
    } catch (error) {
        console.error('Error fetching bill amount:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch bill amount'
        });
    }
});

app.post('/generate-fees-from-bills', uploadNoFile.none(), async (req, res) => {
    const { classId, academicYear, term } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!classId || !academicYear || !term) {
            return res.status(400).json({
                success: false,
                error: 'Class, Academic Year, and Term are required'
            });
        }
        
        // Get class bills for the selected criteria
        const [classBills] = await connection.execute(`
            SELECT * FROM class_bills 
            WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [classId, academicYear, term]);
        
        if (classBills.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No class bills found for the selected criteria'
            });
        }
        
        // Get students in the class
        const [students] = await connection.execute(`
            SELECT s.*, c.className 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.classId = ?
        `, [classId]);
        
        if (students.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No students found in the selected class'
            });
        }
        
        let generatedCount = 0;
        let skippedCount = 0;
        
        // Generate fees for each student
        for (const student of students) {
            for (const bill of classBills) {
                // Check if fee already exists for this student and bill
                const [existingFees] = await connection.execute(`
                    SELECT id FROM fees 
                    WHERE studentId = ? AND feeType = ? AND academicYear = ? AND term = ?
                `, [student.id, bill.fee_type, academicYear, term]);
                
                if (existingFees.length === 0) {
                    // Generate receipt number
                    const receiptNumber = `REC-${student.id}-${Date.now()}-${bill.id}`;
                    
                    // Insert fee record
                    await connection.execute(`
                        INSERT INTO fees (
                            studentId, studentName, email, className, department,
                            feeType, paymentType, amount, amountPaid, paymentDate,
                            receiptNumber, academicYear, term, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        student.id,
                        `${student.firstName} ${student.middleName || ''} ${student.lastName}`.trim(),
                        student.email,
                        student.className,
                        student.department,
                        bill.fee_type,
                        'Pending', // Default payment type
                        bill.amount,
                        0, // Initially unpaid
                        new Date().toISOString().split('T')[0], // Current date
                        receiptNumber,
                        academicYear,
                        term,
                        'pending' // Initial status
                    ]);
                    
                    generatedCount++;
                } else {
                    skippedCount++;
                }
            }
        }
        
        res.json({
            success: true,
            message: `Generated ${generatedCount} fee records. ${skippedCount} already existed.`,
            generated: generatedCount,
            skipped: skippedCount
        });
        
    } catch (error) {
        console.error('Error generating fees from bills:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate fees: ' + error.message
        });
    }
});

// GET route for fees collection listing with filtering
app.get('/fees-collection', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { academicYear, term, status, classId, feeType, page = 1, limit = 50 } = req.query;
        
        // Get academic years for filter dropdown
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get classes for filter
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        // Get distinct fee types from class bills
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Build the WHERE clause if filters are provided
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (academicYear) {
            whereClause += ' AND f.academicYear = ?';
            queryParams.push(academicYear);
        }
        
        if (term) {
            whereClause += ' AND f.term = ?';
            queryParams.push(term);
        }
        
        if (status) {
            whereClause += ' AND f.status = ?';
            queryParams.push(status);
        }
        
        if (classId) {
            whereClause += ' AND s.classId = ?';
            queryParams.push(classId);
        }
        
        if (feeType) {
            whereClause += ' AND f.feeType = ?';
            queryParams.push(feeType);
        }
        
        // Get total count for pagination
        const [totalCountResult] = await connection.execute(`
            SELECT COUNT(*) as total
            FROM fees f
            LEFT JOIN students s ON f.studentId = s.id
            LEFT JOIN classes c ON s.classId = c.id
            ${whereClause}
        `, queryParams);
        
        const totalCount = totalCountResult[0].total;
        const totalPages = Math.ceil(totalCount / limit);
        const offset = (page - 1) * limit;
        
        // Get fees with filters - join with students to filter by class
        const [fees] = await connection.execute(`
            SELECT 
                f.*,
                s.classId,
                c.className as studentClassName
            FROM fees f
            LEFT JOIN students s ON f.studentId = s.id
            LEFT JOIN classes c ON s.classId = c.id
            ${whereClause}
            ORDER BY f.paymentDate DESC, f.created_at DESC
            LIMIT ? OFFSET ?
        `, [...queryParams, parseInt(limit), parseInt(offset)]);
        
        // Format amounts for display and calculate payment status
        const formattedFees = fees.map(fee => {
            const billAmount = fee.billAmount || fee.amount;
            const amountPaid = fee.amountPaid || 0;
            const balance = fee.balance !== null && fee.balance !== undefined ? fee.balance : billAmount - amountPaid;
            
            let paymentStatus = fee.status;
            let statusClass = 'success';
            
            if (billAmount > 0) {
                if (amountPaid < billAmount) {
                    paymentStatus = 'Partial';
                    statusClass = 'warning';
                } else if (amountPaid > billAmount) {
                    paymentStatus = 'Overpaid';
                    statusClass = 'info';
                } else if (amountPaid === billAmount) {
                    paymentStatus = 'Paid';
                    statusClass = 'success';
                }
            }
            
            return {
                ...fee,
                billAmount: billAmount,
                formattedBillAmount: new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: 'NGN'
                }).format(billAmount),
                formattedAmount: new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: 'NGN'
                }).format(amountPaid),
                formattedBalance: new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: 'NGN'
                }).format(Math.abs(balance)),
                paymentStatus: paymentStatus,
                statusClass: statusClass,
                hasBill: fee.billAmount !== null && fee.billAmount !== undefined,
                isPartial: amountPaid < billAmount,
                isOverpaid: amountPaid > billAmount,
                balance: balance
            };
        });

        res.render('fees-collection', { 
            fees: formattedFees,
            academicYears: academicYears,
            classes: classes,
            feeTypes: feeTypes,
            selectedAcademicYear: academicYear || '',
            selectedTerm: term || '',
            selectedStatus: status || '',
            selectedClassId: classId || '',
            selectedFeeType: feeType || '',
            currentPage: parseInt(page),
            totalPages: totalPages,
            totalCount: totalCount,
            limit: parseInt(limit),
            moment: require('moment'),
            title: 'Fee Collection',
            notification: req.session.notification
        });
        
        // Clear notification after displaying
        delete req.session.notification;

    } catch (error) {
        console.error('Error fetching fees:', error);
        res.render('fees-collection', { 
            fees: [],
            academicYears: [],
            classes: [],
            feeTypes: [],
            selectedAcademicYear: '',
            selectedTerm: '',
            selectedStatus: '',
            selectedClassId: '',
            selectedFeeType: '',
            currentPage: 1,
            totalPages: 1,
            totalCount: 0,
            limit: 50,
            error: 'Failed to load fee records',
            title: 'Fee Collection'
        });
    }
});

app.get('/fee-receipt/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get fee payment details
        const [payments] = await connection.execute(`
            SELECT f.* 
            FROM fees f
            WHERE f.id = ?
        `, [req.params.id]);

        if (payments.length === 0) {
            return res.status(404).send('Receipt not found');
        }

        const receipt = payments[0];
        
        // Calculate amounts based on bill information
        const billAmount = receipt.billAmount || receipt.amount;
        const amountPaid = receipt.amountPaid || 0;
        const balance = receipt.balance !== null && receipt.balance !== undefined ? 
            receipt.balance : billAmount - amountPaid;
        
        // Determine payment status and messages
        let paymentStatus = 'Paid in Full';
        let statusMessage = '';
        let balanceMessage = '';
        
        if (billAmount > 0) {
            if (amountPaid < billAmount) {
                paymentStatus = 'Partial Payment';
                statusMessage = `Balance Due: ₦${Math.abs(balance).toLocaleString('en-NG')}`;
                balanceMessage = `The student still needs to pay ₦${Math.abs(balance).toLocaleString('en-NG')} to complete this fee payment.`;
            } else if (amountPaid > billAmount) {
                paymentStatus = 'Overpaid';
                statusMessage = `Overpayment: ₦${Math.abs(balance).toLocaleString('en-NG')}`;
                balanceMessage = `The student has overpaid by ₦${Math.abs(balance).toLocaleString('en-NG')}. This amount can be credited towards future payments.`;
            } else {
                paymentStatus = 'Paid in Full';
                statusMessage = 'No balance remaining';
                balanceMessage = 'This fee has been fully paid.';
            }
        }
        
        // Get total paid for this fee type, term, and academic year
        const [totalPayments] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid
            FROM fees 
            WHERE studentId = ? AND feeType = ? AND academicYear = ? AND term = ?
        `, [receipt.studentId, receipt.feeType, receipt.academicYear, receipt.term]);
        
        const totalPaid = parseFloat(totalPayments[0].totalPaid) || 0;
        
        // Format amounts as Naira
        const formatNaira = (amount) => {
            return new Intl.NumberFormat('en-NG', {
                style: 'currency',
                currency: 'NGN'
            }).format(amount || 0);
        };
        
        // Enhanced number to words conversion
        const numberToWords = (num) => {
            const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
            const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
            const tens = ['', 'Ten', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
            
            const convertLessThanThousand = (n) => {
                if (n === 0) return '';
                if (n < 10) return units[n];
                if (n < 20) return teens[n - 10];
                if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + units[n % 10] : '');
                
                return units[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' and ' + convertLessThanThousand(n % 100) : '');
            };
            
            if (num === 0) return 'Zero';
            
            let result = '';
            if (num >= 1000000) {
                result += convertLessThanThousand(Math.floor(num / 1000000)) + ' Million ';
                num %= 1000000;
            }
            if (num >= 1000) {
                result += convertLessThanThousand(Math.floor(num / 1000)) + ' Thousand ';
                num %= 1000;
            }
            if (num > 0) {
                result += convertLessThanThousand(num);
            }
            
            return result.trim();
        };
        
        // Format receipt data
        receipt.formattedBillAmount = formatNaira(billAmount);
        receipt.formattedAmountPaid = formatNaira(amountPaid);
        receipt.formattedBalance = formatNaira(Math.abs(balance));
        receipt.amountInWords = numberToWords(amountPaid) + ' Naira Only';
        receipt.paymentStatus = paymentStatus;
        receipt.statusMessage = statusMessage;
        receipt.balanceMessage = balanceMessage;
        receipt.hasBill = receipt.billAmount !== null && receipt.billAmount !== undefined;
        receipt.isPartial = amountPaid < billAmount;
        receipt.isOverpaid = amountPaid > billAmount;
        receipt.billAmount = billAmount;
        receipt.actualAmountPaid = amountPaid;
        receipt.balanceAmount = balance;
        receipt.totalPaid = totalPaid;
        receipt.formattedTotalPaid = formatNaira(totalPaid);
        
        // Get school information from database
        const [schoolInfo] = await connection.execute(`
            SELECT * FROM school_info LIMIT 1
        `);
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            logo: "/images/school-logo.png",
            website: "www.excelcollege.edu.ng",
            terms: "All payments are in Nigerian Naira (₦). Payment once made is non-refundable."
        };

        res.render('fee-receipt', { 
            receipt: receipt,
            school: school,
            moment: require('moment'),
            formatNaira: formatNaira
        });

    } catch (error) {
        console.error('Error generating receipt:', error);
        res.status(500).send('Error generating receipt');
    }
});
// Library Routes
app.get('/all-library', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [books] = await connection.execute('SELECT * FROM library_books');
        res.render('all-library', { books: books });
    } catch (error) {
        console.error('Error fetching library books:', error);
        res.render('all-library', { books: [], error: 'Failed to load library books.' });
    }
});

app.get('/add-library', authenticate, (req, res) => {
    res.render('add-library');
});

app.post('/add-library', uploadWithFile.single('bookCover'), async (req, res) => {
    const { title, author, isbn, quantity, category } = req.body;
    
    try {
        const connection = await getConnection();
        let coverPath = req.file ? '/images/library/' + req.file.filename : null;
        
        await connection.execute(
            'INSERT INTO library_books (title, author, isbn, quantity, category, coverPath) VALUES (?, ?, ?, ?, ?, ?)',
            [title, author, isbn, quantity, category, coverPath]
        );
        
        res.redirect('/all-library');
    } catch (error) {
        console.error('Error adding book:', error);
        res.render('add-library', { error: 'Failed to add book', formData: req.body });
    }
});

// Calendar Routes
app.get('/school-calendar', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { academicYear, term } = req.query;
        
        // Build the WHERE clause if filters are provided
        let whereClause = 'WHERE 1=1'; // Show all events, not just future ones
        let queryParams = [];
        
        if (academicYear && academicYear !== '') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }
        
        if (term && term !== '') {
            whereClause += ' AND term = ?';
            queryParams.push(term);
        }
        
        // Get events with optional filtering - select ALL columns
        const [events] = await connection.execute(`
            SELECT * FROM calendar_events 
            ${whereClause}
            ORDER BY eventDate ASC, startTime ASC
        `, queryParams);
        
        // Get academic years for filter dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT academic_year 
            FROM calendar_events 
            WHERE academic_year IS NOT NULL AND academic_year != ''
            ORDER BY academic_year DESC
        `);
        
        // Get terms for filter dropdown
        const [terms] = await connection.execute(`
            SELECT DISTINCT term 
            FROM calendar_events 
            WHERE term IS NOT NULL AND term != ''
            ORDER BY 
                CASE term
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                    ELSE 4
                END
        `);
        
        res.render('school-calendar', { 
            events: events,
            academicYears: academicYears,
            terms: terms,
            selectedAcademicYear: academicYear || '',
            selectedTerm: term || '',
            moment: require('moment') // Add moment for date formatting
        });
    } catch (error) {
        console.error('Error fetching calendar events:', error);
        res.render('school-calendar', { 
            events: [], 
            academicYears: [],
            terms: [],
            selectedAcademicYear: '',
            selectedTerm: '',
            error: 'Failed to load calendar.' 
        });
    }
});

app.get('/add-event', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get current academic year
        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get terms for the current academic year
        let terms = [];
        let currentTerm = null;
        
        if (currentAcademicYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);
            
            // Get current term
            const [currentTermResult] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? AND is_current = TRUE LIMIT 1
            `, [currentAcademicYear[0].id]);
            
            if (currentTermResult.length > 0) {
                currentTerm = currentTermResult[0];
            }
        }
        
        res.render('add-event', {
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
            currentTerm: currentTerm,
            formData: {}
        });
    } catch (error) {
        console.error('Error loading add event form:', error);
        res.render('add-event', {
            academicYears: [],
            terms: [],
            currentAcademicYear: null,
            currentTerm: null,
            formData: {},
            error: 'Failed to load form data'
        });
    }
});

app.post('/add-event', uploadNoFile.none(), async (req, res) => {
    const { title, description, eventDate, startTime, endTime, academicYear, term } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!title || !eventDate || !academicYear || !term) {
            // Re-fetch academic data for form repopulation
            const [academicYears] = await connection.execute(`
                SELECT * FROM academic_years ORDER BY start_date DESC
            `);
            
            const [currentAcademicYear] = await connection.execute(`
                SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
            `);
            
            let terms = [];
            if (currentAcademicYear.length > 0) {
                [terms] = await connection.execute(`
                    SELECT * FROM academic_terms 
                    WHERE academic_year_id = ? 
                    ORDER BY 
                        CASE term_name
                            WHEN 'First Term' THEN 1
                            WHEN 'Second Term' THEN 2
                            WHEN 'Third Term' THEN 3
                        END
                `, [currentAcademicYear[0].id]);
            }
            
            return res.render('add-event', {
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
                formData: req.body,
                error: 'Please fill in all required fields (Title, Date, Academic Year, and Term)'
            });
        }
        
        await connection.execute(
            'INSERT INTO calendar_events (title, description, eventDate, startTime, endTime, academic_year, term) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [title, description, eventDate, startTime, endTime, academicYear, term]
        );
        
        res.redirect('/school-calendar');
    } catch (error) {
        console.error('Error adding event:', error);
        
        // Re-fetch academic data for form repopulation on error
        const connection = await getConnection();
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        let terms = [];
        if (currentAcademicYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);
        }
        
        res.render('add-event', {
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
            formData: req.body,
            error: 'Failed to add event: ' + error.message
        });
    }
});

// View student profile by ID
app.get('/student-profile/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const studentId = req.params.id;

        // 1. Get student info with class name and department
        const [students] = await connection.execute(`
            SELECT s.*, c.className, c.department AS classDepartment
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?`,
            [studentId]
        );

        if (students.length === 0) {
            return res.status(404).render('error', {
                message: 'Student not found',
                error: { status: 404 }
            });
        }

        const student = students[0];

        // 2. Get enrolled subjects
        const [enrolledSubjects] = await connection.execute(`
            SELECT s.id, s.name AS subjectName, s.subject_code AS subjectCode
            FROM student_subjects ss
            JOIN subjects s ON ss.subject_id = s.id
            WHERE ss.student_id = ?
            ORDER BY s.name`,
            [studentId]
        );

        // 3. Get available subjects (not enrolled)
        const [availableSubjects] = await connection.execute(`
            SELECT s.id, s.name AS subjectName, s.subject_code AS subjectCode
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
            AND s.id NOT IN (
                SELECT subject_id
                FROM student_subjects 
                WHERE student_id = ?
            )
            ORDER BY s.name`,
            [student.classId, studentId]
        );

        // 4. Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);

        // 5. Get available academic years for report card selection
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);

        res.render('student-profile', {
            studentData: student, // Changed from 'student' to 'studentData'
            student: student, // Keep both for compatibility
            enrolledSubjects,
            availableSubjects,
            academicYears,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : '',
            terms: ['First Term', 'Second Term', 'Third Term', 'Session'],
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading student profile:', error);
        res.status(500).render('error', {
            message: 'Error loading student profile',
            error: { status: 500, details: error.message }
        });
    }
});

// View teacher profile by ID
app.get('/teacher-profile/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [teachers] = await connection.execute(
            'SELECT * FROM teachers WHERE id = ?', 
            [req.params.id]
        );

        if (teachers.length === 0) {
            return res.status(404).send('Teacher not found');
        }

        const teacher = teachers[0];
        res.render('teacher-profile', { teacher, moment: require('moment') });
    } catch (error) {
        console.error('Error fetching teacher profile:', error);
        res.status(500).send('Error loading profile');
    }
});

// View staff profile by ID
// Staff Profile Route
app.get('/staff-profile/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const [staff] = await connection.execute(
            'SELECT * FROM staff WHERE id = ?', 
            [req.params.id]
        );

        if (staff.length === 0) {
            return res.status(404).send('Staff member not found');
        }

        const member = staff[0];
        res.render('staff-profile', { staff: member, moment: require('moment') });
    } catch (error) {
        console.error('Error fetching staff profile:', error);
        res.status(500).send('Error loading profile');
    }
});

// Display form to register new subjects
// SUBJECT ROUTES
app.get('/register-subjects', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get distinct levels from classes table
        const [levels] = await connection.execute('SELECT DISTINCT level as name FROM classes ORDER BY level');
        
        // Get distinct departments from classes table
        const [departments] = await connection.execute('SELECT DISTINCT department as name FROM classes WHERE department IS NOT NULL ORDER BY department');
        
        // Get all classes grouped by level
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);
        
        // Group classes by level
        const classesByLevel = {};
        classes.forEach(cls => {
            if (!classesByLevel[cls.level]) {
                classesByLevel[cls.level] = [];
            }
            classesByLevel[cls.level].push(cls);
        });
        
        res.render('register-subjects', {
            levels: levels,
            departments: departments,
            classesByLevel: classesByLevel,
            formData: req.query.classId ? { classId: req.query.classId } : {},
            error: null
        });
    } catch (error) {
        console.error('Error loading form:', error);
        res.render('register-subjects', {
            levels: [],
            departments: [],
            classesByLevel: {},
            formData: {},
            error: 'Failed to load data'
        });
    }
});

app.post('/register-subjects', authenticate, async (req, res) => {
    let connection = null;
    
    try {
        connection = await getConnection();
        const { level, department, subjects, subject_codes, descriptions } = req.body;

        // Debug logging
        console.log('Form data received:', {
            level: level,
            department: department,
            subjects: subjects,
            subject_codes: subject_codes,
            descriptions: descriptions
        });

        await connection.beginTransaction();

        // Validate inputs
        if (!level || !subjects || !Array.isArray(subjects) || subjects.length === 0) {
            console.log('Validation failed - missing required fields');
            throw new Error('Please select a level and add at least one subject');
        }

        // For SENIOR SECONDARY, department is required
        if (level === 'SENIOR SECONDARY' && (!department || department.trim() === '')) {
            throw new Error('Department is required for Senior Secondary subjects');
        }

        // Get all classes for the selected level and department
        let classQuery = 'SELECT id, className FROM classes WHERE level = ?';
        let classParams = [level];
        
        if (level === 'SENIOR SECONDARY' && department) {
            classQuery += ' AND department = ?';
            classParams.push(department);
        }

        const [classes] = await connection.execute(classQuery, classParams);

        if (classes.length === 0) {
            throw new Error(`No classes found for level: ${level}${level === 'SENIOR SECONDARY' ? ' - ' + department : ''}`);
        }

        console.log(`Found ${classes.length} classes for ${level}${level === 'SENIOR SECONDARY' ? ' - ' + department : ''}`);

        // Process each subject for all classes
        for (let i = 0; i < subjects.length; i++) {
            const subjectName = subjects[i].trim();
            const subjectCode = subject_codes[i]?.trim();
            
            if (!subjectName) continue;

            let finalSubjectCode = subjectCode;

            // If no subject code provided, generate one based on level and index
            if (!finalSubjectCode) {
                const levelPrefix = level.substring(0, 2).toUpperCase();
                finalSubjectCode = `${levelPrefix}${(i + 1).toString().padStart(3, '0')}`;
            }

            // Create a new subject entry (allow duplicate subject codes)
            const [subjectResult] = await connection.execute(
                'INSERT INTO subjects (name, subject_code, description) VALUES (?, ?, ?)',
                [
                    subjectName.trim(),
                    finalSubjectCode,
                    descriptions[i]?.trim() || null
                ]
            );
            
            const subjectId = subjectResult.insertId;
            console.log(`Created new subject: "${subjectName}" with code: ${finalSubjectCode} and ID: ${subjectId}`);

            // Link subject to ALL classes in this level/department
            for (const classInfo of classes) {
                try {
                    await connection.execute(
                        `INSERT INTO class_subjects (class_id, subject_id) 
                         VALUES (?, ?)`,
                        [classInfo.id, subjectId]
                    );
                } catch (linkError) {
                    // Ignore duplicate entry errors for class_subjects
                    if (linkError.code !== 'ER_DUP_ENTRY') {
                        throw linkError;
                    }
                    console.log(`Subject ${subjectId} already linked to class ${classInfo.id}`);
                }
            }

            console.log(`Subject "${subjectName}" registered for ${classes.length} classes`);
        }

        await connection.commit();
        
        req.session.notification = {
            type: 'success',
            message: `Subjects registered successfully for ${level}${level === 'SENIOR SECONDARY' ? ' - ' + department : ''} (${classes.length} classes)`
        };
        res.redirect('/view-subjects');

    } catch (error) {
        // Rollback transaction if connection exists
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Rollback error:', rollbackError);
            }
        }
        
        console.error('Registration error:', error);
        
        // Check if it's a duplicate subject code error
        if (error.code === 'ER_DUP_ENTRY' && error.sqlMessage.includes('subject_code')) {
            // Remove the unique constraint from the database or handle this differently
            error.message = 'Database constraint error: Subject code must be unique. Please remove the unique constraint from the subject_code field or use unique codes.';
        }
        
        // Get levels, departments, and classes for the form
        let levels = [];
        let departments = [];
        let classesByLevel = {};
        try {
            const tempConnection = await getConnection();
            [levels] = await tempConnection.execute('SELECT DISTINCT level as name FROM classes ORDER BY level');
            [departments] = await tempConnection.execute('SELECT DISTINCT department as name FROM classes WHERE department IS NOT NULL ORDER BY department');
            
            const [classes] = await tempConnection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `);
            
            // Group classes by level
            classes.forEach(cls => {
                if (!classesByLevel[cls.level]) {
                    classesByLevel[cls.level] = [];
                }
                classesByLevel[cls.level].push(cls);
            });
            
            await tempConnection.end();
        } catch (dbError) {
            console.error('Error fetching form data:', dbError);
        }
        
        res.render('register-subjects', {
            levels: levels,
            departments: departments,
            classesByLevel: classesByLevel,
            formData: req.body,
            error: error.message || 'Failed to register subjects'
        });
    } finally {
        // Always close the connection
        if (connection) {
            try {
                await connection.end();
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }
    }
});

// Update the loadClassesForLevel function to handle multi-select properly
function loadClassesForLevel(level, department = '') {
    classesContainer.innerHTML = '';
    
    if (!level) {
        const select = document.createElement('select');
        select.className = 'form-control';
        select.multiple = true;
        select.name = 'classIds';
        select.innerHTML = '<option value="">Select a level first</option>';
        classesContainer.appendChild(select);
        return;
    }

    const select = document.createElement('select');
    select.className = 'form-control';
    select.multiple = true;
    select.name = 'classIds';
    select.required = true;
    select.size = 5; // Show 5 options at once

    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select classes (' + level + (department ? ' - ' + department : '') + ')';
    defaultOption.disabled = true;
    select.appendChild(defaultOption);

    // Filter classes by level and department
    const filteredClasses = classesData[level] || [];
    const classesToShow = department ? 
        filteredClasses.filter(cls => cls.department === department) : 
        filteredClasses;

    if (classesToShow.length === 0) {
        const noClassesOption = document.createElement('option');
        noClassesOption.value = '';
        noClassesOption.textContent = 'No classes available for this selection';
        noClassesOption.disabled = true;
        select.appendChild(noClassesOption);
    } else {
        classesToShow.forEach(cls => {
            const option = document.createElement('option');
            option.value = cls.id;
            option.textContent = cls.className + (cls.department ? ' (' + cls.department + ')' : '');
            // Pre-select if previously selected
            if (Array.isArray(formData.classIds) && formData.classIds.includes(cls.id.toString())) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    classesContainer.appendChild(select);
}

// View all subjects by class
app.get('/view-subjects', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const selectedClassId = req.query.classId || null;
        
        // Get all classes for the filter dropdown
        const [allClasses] = await connection.execute(`
            SELECT 
                c.id, 
                c.className,
                c.level,
                c.department
            FROM classes c
            ORDER BY 
                CASE c.level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                c.className
        `);

        // Build the WHERE clause if a class is selected
        let whereClause = '';
        let queryParams = [];
        if (selectedClassId) {
            whereClause = 'WHERE c.id = ?';
            queryParams = [selectedClassId];
        }

        // Get subjects with teachers - fixed column names
        const query = `
            SELECT 
                c.id AS classId,
                c.className,
                c.level,
                c.department,
                s.id AS subjectId,
                s.name AS subjectName,
                s.subject_code AS subjectCode,
                t.id AS teacherId,
                CONCAT(t.firstName, ' ', t.lastName) AS teacherName,
                COUNT(ss.student_id) AS studentCount,
                MAX(cs.created_at) AS lastUpdated
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
            LEFT JOIN teachers t ON cs.teacher_id = t.id
            LEFT JOIN student_subjects ss ON s.id = ss.subject_id
            ${whereClause}
            GROUP BY c.id, s.id, t.id
            ORDER BY c.className, s.name
        `;

        const [subjects] = await connection.execute(query, queryParams);

        // Format dates
        const formattedSubjects = subjects.map(subject => ({
            ...subject,
            formattedDate: subject.lastUpdated ? 
                moment(subject.lastUpdated).format('DD MMM YYYY') : 'Never'
        }));

        res.render('view-subjects', {
            classes: allClasses,
            subjects: formattedSubjects,
            selectedClassId: selectedClassId,
            notification: req.session.notification || null,
            moment: require('moment')
        });

        delete req.session.notification;

    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.render('view-subjects', {
            classes: [],
            subjects: [],
            selectedClassId: null,
            notification: null,
            error: 'Failed to load subjects data'
        });
    }
});

// View subjects for a specific class
app.get('/class-subjects/:classId', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get class info with level and department
        const [classes] = await connection.execute(
            'SELECT id, className, level, department FROM classes WHERE id = ?',
            [req.params.classId]
        );
        
        if (classes.length === 0) {
            return res.status(404).send('Class not found');
        }

        const classInfo = classes[0];
        classInfo.displayName = classInfo.level === 'SENIOR SECONDARY' && classInfo.department 
            ? `${classInfo.className} (${classInfo.department})` 
            : classInfo.className;

        // Get subjects for this class
        const [subjects] = await connection.execute(
            'SELECT id, subjectName, subjectCode FROM class_subjects WHERE classId = ? ORDER BY subjectName',
            [req.params.classId]
        );

        // Get students in this class
        const [students] = await connection.execute(
            `SELECT s.id, s.firstName, s.lastName, s.department 
             FROM students s 
             WHERE s.classId = ? 
             ORDER BY s.firstName`,
            [req.params.classId]
        );

        // Get enrolled subjects for each student
        const enrolledStudents = await Promise.all(students.map(async student => {
            const [enrollments] = await connection.execute(
                `SELECT ss.subjectId, cs.subjectName, cs.subjectCode 
                 FROM student_subjects ss
                 JOIN class_subjects cs ON ss.subjectId = cs.id
                 WHERE ss.studentId = ?`,
                [student.id]
            );
            return {
                ...student,
                enrollments,
                displayName: `${student.firstName} ${student.lastName}` +
                    (student.department ? ` (${student.department})` : '')
            };
        }));

        res.render('class-subjects', {
            classInfo: classInfo,
            subjects: subjects,
            students: enrolledStudents,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error fetching class subjects:', error);
        res.status(500).render('error', {
            message: 'Error loading class subjects',
            error: { status: 500 }
        });
    }
});

// Unenroll student from subject
app.delete('/unenroll-student-subject', authenticate, async (req, res) => {
    const { studentId, subjectId } = req.query;
    
    if (!studentId || !subjectId) {
        return res.status(400).json({ 
            success: false,
            error: 'Student ID and Subject ID are required'
        });
    }

    try {
        const connection = await getConnection();
        
        const [result] = await connection.execute(
            'DELETE FROM student_subjects WHERE student_id = ? AND subject_id = ?', // Fixed column names
            [studentId, subjectId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Enrollment record not found'
            });
        }

        res.json({ 
            success: true,
            message: 'Student successfully unenrolled from subject'
        });

    } catch (error) {
        console.error('Error unenrolling student:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to unenroll student',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET route to display teacher assignment form
app.get('/assign-teachers', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get all teachers, classes, and subjects
        const [teachers] = await connection.execute('SELECT id, firstName, lastName FROM teachers ORDER BY lastName');
        const [classes] = await connection.execute('SELECT id, className, level, department FROM classes ORDER BY className');
        const [subjects] = await connection.execute('SELECT id, name FROM subjects ORDER BY name');
        const [academicYears] = await connection.execute('SELECT DISTINCT academic_year FROM class_bills ORDER BY academic_year DESC');
        
        // Get existing assignments
        const [assignments] = await connection.execute(`
            SELECT ta.*, t.firstName, t.lastName, c.className, s.name AS subjectName
            FROM teacher_assignments ta
            JOIN teachers t ON ta.teacher_id = t.id
            JOIN classes c ON ta.class_id = c.id
            JOIN subjects s ON ta.subject_id = s.id
            ORDER BY c.className, s.name
        `);
        
        res.render('assign-teachers', {
            teachers: teachers,
            classes: classes,
            subjects: subjects,
            academicYears: academicYears.map(y => y.academic_year),
            assignments: assignments,
            error: null
        });
    } catch (error) {
        console.error('Error loading teacher assignment form:', error);
        res.render('assign-teachers', {
            teachers: [],
            classes: [],
            subjects: [],
            academicYears: [],
            assignments: [],
            error: 'Failed to load data'
        });
    }
});

// POST route to assign teacher to class and subject
app.post('/assign-teacher', uploadNoFile.none(), async (req, res) => {
    const { teacherId, classId, subjectId, academicYear } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Check if assignment already exists
        const [existing] = await connection.execute(
            'SELECT id FROM teacher_assignments WHERE teacher_id = ? AND class_id = ? AND subject_id = ? AND academic_year = ?',
            [teacherId, classId, subjectId, academicYear]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'This teacher is already assigned to this class and subject for the selected academic year'
            });
        }
        
        // Create new assignment
        await connection.execute(
            'INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, academic_year) VALUES (?, ?, ?, ?)',
            [teacherId, classId, subjectId, academicYear]
        );
        
        res.json({ success: true, message: 'Teacher assigned successfully' });
    } catch (error) {
        console.error('Error assigning teacher:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to assign teacher'
        });
    }
});

// Student Records Routes - Updated to use academic_years and academic_terms
app.get('/student-records', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        const [students] = await connection.execute(`
            SELECT s.id, s.firstName, s.lastName, c.className, c.level, c.department
            FROM students s 
            JOIN classes c ON s.classId = c.id
            ORDER BY c.className, s.firstName
        `);
        
        res.render('student-records-list', { 
            students,
            error: null
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        res.render('student-records-list', { 
            students: [],
            error: 'Failed to load student records'
        });
    }
});

app.get('/student-records/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    const { term, academicYear } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Get available academic years and terms
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms ORDER BY start_date DESC
        `);
        
        if (!term || !academicYear) {
            return res.render('select-term', { 
                studentId, 
                academicYears, 
                terms,
                error: null
            });
        }
        
        // Get student details with class information
        const [studentResults] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department
            FROM students s 
            JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?
        `, [studentId]);
        
        if (studentResults.length === 0) {
            return res.status(404).render('error', {
                message: 'Student not found',
                error: { status: 404 }
            });
        }
        
        const student = studentResults[0];
        
        if (term === 'session') {
            // Calculate session record - get subjects the student is actually enrolled in
            const [sessionResults] = await connection.execute(`
                SELECT 
                    s.id as subject_id,
                    s.name as subject_name,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = ? AND subject_id = s.id 
                        AND term = 'First Term' AND academic_year = ?
                    ), 0) as first_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = ? AND subject_id = s.id 
                        AND term = 'Second Term' AND academic_year = ?
                    ), 0) as second_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = ? AND subject_id = s.id 
                        AND term = 'Third Term' AND academic_year = ?
                    ), 0) as third_term_score
                FROM subjects s
                WHERE s.id IN (
                    SELECT subject_id 
                    FROM student_scores 
                    WHERE student_id = ? AND academic_year = ?
                    GROUP BY subject_id
                )
                ORDER BY s.name
            `, [studentId, academicYear, studentId, academicYear, studentId, academicYear, studentId, academicYear]);
            
            // Calculate averages and totals
            let totalAverage = 0;
            let totalSubjectsWithScores = 0;
            const sessionRecord = sessionResults.map(subject => {
                const firstTerm = parseFloat(subject.first_term_score) || 0;
                const secondTerm = parseFloat(subject.second_term_score) || 0;
                const thirdTerm = parseFloat(subject.third_term_score) || 0;
                
                // Only calculate average if at least one term has scores
                let average = 0;
                let termsWithScores = 0;
                
                if (firstTerm > 0) termsWithScores++;
                if (secondTerm > 0) termsWithScores++;
                if (thirdTerm > 0) termsWithScores++;
                
                if (termsWithScores > 0) {
                    average = (firstTerm + secondTerm + thirdTerm) / termsWithScores;
                    totalAverage += average;
                    totalSubjectsWithScores++;
                }
                
                return {
                    ...subject,
                    average: average.toFixed(2),
                    firstTerm: firstTerm.toFixed(1),
                    secondTerm: secondTerm.toFixed(1),
                    thirdTerm: thirdTerm.toFixed(1),
                    hasScores: termsWithScores > 0
                };
            });
            
            // Calculate overall percentage
            const overallAverage = totalSubjectsWithScores > 0 ? totalAverage / totalSubjectsWithScores : 0;
            const percentage = ((overallAverage / 100) * 100).toFixed(2);
            
            // Determine grade
            let grade = 'F';
            if (overallAverage >= 80) grade = 'A';
            else if (overallAverage >= 70) grade = 'B';
            else if (overallAverage >= 60) grade = 'C';
            else if (overallAverage >= 50) grade = 'D';
            else if (overallAverage >= 40) grade = 'E';
            
            res.render('student-record', { 
                student, 
                subjects: sessionRecord, 
                scores: [], 
                terms: ['First Term', 'Second Term', 'Third Term'],
                academicYears,
                selectedTerm: 'session',
                selectedYear: academicYear,
                sessionRecord: sessionRecord.filter(subject => subject.hasScores),
                totalAverage: overallAverage.toFixed(2),
                percentage,
                grade,
                success: req.query.success,
                error: req.query.error
            });
            
        } else {
            // Show specific term scores - only subjects the student has scores for
            const [scores] = await connection.execute(`
                SELECT s.id as subject_id, s.name as subject_name, 
                       sc.test_score, sc.exam_score, 
                       COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                       sc.term
                FROM subjects s
                JOIN student_scores sc ON s.id = sc.subject_id 
                WHERE sc.student_id = ? AND sc.term = ? AND sc.academic_year = ?
                ORDER BY s.name
            `, [studentId, term, academicYear]);
            
            // Calculate term statistics
            let termTotal = 0;
            let termAverage = 0;
            
            if (scores.length > 0) {
                termTotal = scores.reduce((sum, score) => sum + parseFloat(score.total_score || 0), 0);
                termAverage = termTotal / scores.length;
            }
            
            const termPercentage = ((termAverage / 100) * 100).toFixed(2);
            
            // Determine grade for the term
            let termGrade = 'F';
            if (termAverage >= 80) termGrade = 'A';
            else if (termAverage >= 70) termGrade = 'B';
            else if (termAverage >= 60) termGrade = 'C';
            else if (termAverage >= 50) termGrade = 'D';
            else if (termAverage >= 40) termGrade = 'E';
            
            res.render('student-record', { 
                student, 
                subjects: scores, 
                scores, 
                terms: ['First Term', 'Second Term', 'Third Term'],
                academicYears,
                selectedTerm: term,
                selectedYear: academicYear,
                sessionRecord: null,
                termTotal: termTotal.toFixed(2),
                termAverage: termAverage.toFixed(2),
                termPercentage,
                termGrade,
                success: req.query.success,
                error: req.query.error
            });
        }
    } catch (error) {
        console.error('Error loading student record:', error);
        res.status(500).render('error', {
            message: 'Error loading student record',
            error: { status: 500, details: error.message }
        });
    }
});

// Term Reports Routes
app.get('/term-reports', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);
        
        // Terms for selection
        const terms = ['First Term', 'Second Term', 'Third Term'];
        
        res.render('term-report-selection', {
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            formData: {
                classId: req.query.classId || '',
                term: req.query.term || '',
                academicYear: req.query.academicYear || ''
            },
            error: req.query.error || null
        });
        
    } catch (error) {
        console.error('Error loading term report selection:', error);
        res.render('term-report-selection', {
            classes: [],
            academicYears: [],
            terms: [],
            formData: {
                classId: '',
                term: '',
                academicYear: ''
            },
            error: 'Failed to load selection data'
        });
    }
});

// Updated term report routes to accept class parameter
app.get('/first-term/:classId?', authenticate, async (req, res) => {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
        return res.redirect('/term-reports?error=Please select a class');
    }
    await generateTermReport('First Term', classId, res);
});

app.get('/second-term/:classId?', authenticate, async (req, res) => {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
        return res.redirect('/term-reports?error=Please select a class');
    }
    await generateTermReport('Second Term', classId, res);
});

app.get('/third-term/:classId?', authenticate, async (req, res) => {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
        return res.redirect('/term-reports?error=Please select a class');
    }
    await generateTermReport('Third Term', classId, res);
});

// Updated helper function to accept classId
async function generateTermReport(term, classId, res) {
    try {
        const connection = await getConnection();
        
        // Get current academic year if not specified
        const [currentYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const academicYear = currentYear.length > 0 ? currentYear[0].year_name : new Date().getFullYear().toString();
        
        // Get class information
        const [classResults] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE id = ?
        `, [classId]);
        
        if (classResults.length === 0) {
            return res.render('term-report', {
                term: term,
                academicYear: academicYear,
                classReports: [],
                termName: `${term} Report`,
                error: 'Class not found'
            });
        }
        
        const classInfo = classResults[0];
        
        // Get students with their scores for this specific class
        const [results] = await connection.execute(`
            SELECT 
                s.id as student_id,
                s.firstName as first_name,
                s.lastName as last_name,
                s.admission_number,
                s.department as student_department,
                COUNT(DISTINCT sc.subject_id) as subject_count,
                COALESCE(SUM(sc.test_score + sc.exam_score), 0) as total_score,
                COALESCE(AVG(sc.test_score + sc.exam_score), 0) as average_score
            FROM students s
            LEFT JOIN student_scores sc ON sc.student_id = s.id 
                AND sc.term = ? AND sc.academic_year = ?
            WHERE s.classId = ?
            GROUP BY s.id
            HAVING subject_count > 0
            ORDER BY average_score DESC
        `, [term, academicYear, classId]);
        
        // Process results for this class
        const processedResults = results.map((student, index) => {
            const avgScore = Number(student.average_score) || 0;
            const percentage = ((avgScore / 100) * 100).toFixed(2);
            
            return {
                ...student,
                average_score: avgScore,
                position: index + 1,
                percentage: isNaN(percentage) ? '0.00' : percentage,
                formattedAverage: avgScore.toFixed(2)
            };
        });
        
        // Create classReports array with just this one class
        const classReports = [{
            classInfo: classInfo,
            students: processedResults,
            studentCount: processedResults.length
        }];

        res.render('term-report', {
            term: term,
            academicYear: academicYear,
            classReports: classReports,
            termName: `${term} Report - ${classInfo.className}`,
            error: null
        });
        
    } catch (error) {
        console.error(`Error generating ${term} report:`, error);
        
        res.render('term-report', {
            term: term,
            academicYear: '',
            classReports: [],
            termName: `${term} Report`,
            error: `Failed to generate ${term} report: ${error.message}`
        });
    }
}

// Score Entry Routes - Updated to use academic years and terms
app.get('/enter-scores', authenticate, async (req, res) => {
    const { classId, term, subjectId, academicYear } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Get academic years and terms
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms ORDER BY start_date DESC
        `);
        
        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Set default values if not provided in query
        const defaultAcademicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '';
        const defaultTerm = currentTerm.length > 0 ? currentTerm[0].term_name : '';
        
        if (!classId || !term || !academicYear) {
            // Show selection form
            const [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `);
            
            // Get subjects based on selected class if available
            let subjects = [];
            if (classId) {
                [subjects] = await connection.execute(`
                    SELECT s.id, s.name 
                    FROM subjects s
                    JOIN class_subjects cs ON s.id = cs.subject_id
                    WHERE cs.class_id = ?
                    ORDER BY s.name
                `, [classId]);
            } else {
                [subjects] = await connection.execute('SELECT id, name FROM subjects ORDER BY name');
            }
            
            // Create formData object from query parameters with defaults
            const formData = {
                classId: classId || '',
                term: term || defaultTerm,
                academicYear: academicYear || defaultAcademicYear,
                subjectId: subjectId || ''
            };
            
            res.render('enter-scores-selection', { 
                classes, 
                subjects,
                academicYears,
                terms,
                currentAcademicYear: defaultAcademicYear,
                currentTerm: defaultTerm,
                formData, // Pass formData to the template
                error: req.query.error || null,
                success: req.query.success || null
            });
        } else {
            // Show score entry form for specific class, term, and academic year
            const [classResults] = await connection.execute('SELECT className, level, department FROM classes WHERE id = ?', [classId]);
            const [subjectResults] = await connection.execute('SELECT name FROM subjects WHERE id = ?', [subjectId]);
            const [yearResults] = await connection.execute('SELECT year_name FROM academic_years WHERE year_name = ?', [academicYear]);
            const [termResults] = await connection.execute('SELECT term_name FROM academic_terms WHERE term_name = ?', [term]);
            
            if (classResults.length === 0) {
                return res.status(404).send('Class not found');
            }
            
            const className = classResults[0].className;
            const classLevel = classResults[0].level;
            const classDepartment = classResults[0].department;
            const subjectName = subjectResults.length > 0 ? subjectResults[0].name : 'All Subjects';
            const yearName = yearResults.length > 0 ? yearResults[0].year_name : academicYear;
            const termName = termResults.length > 0 ? termResults[0].term_name : term;
            
            // Get students with their existing scores AND department information
            const [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.lastName, s.department,
                       sc.test_score, sc.exam_score
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.term = ? 
                    AND sc.subject_id = ?
                    AND sc.academic_year = ?
                WHERE s.classId = ?
                ORDER BY s.lastName, s.firstName
            `, [term, subjectId, academicYear, classId]);
            
            res.render('enter-scores', {
                classId,
                className,
                classLevel,
                classDepartment,
                term,
                termName,
                subjectId,
                subjectName,
                academicYear,
                yearName,
                students,
                success: req.query.success || null,
                error: req.query.error || null
            });
        }
    } catch (error) {
        console.error('Error loading score entry form:', error);
        
        // Even in error case, provide empty formData
        res.render('enter-scores-selection', {
            classes: [],
            subjects: [],
            academicYears: [],
            terms: [],
            currentAcademicYear: '',
            currentTerm: '',
            formData: {
                classId: '',
                term: '',
                academicYear: '',
                subjectId: ''
            },
            error: 'Failed to load form data'
        });
    }
});

// Add this API endpoint to your SchoolApp.js
app.get('/api/subjects-by-class', authenticate, async (req, res) => {
    const { classId } = req.query;
    
    try {
        const connection = await getConnection();
        
        const [subjects] = await connection.execute(`
            SELECT s.id, s.name 
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
            ORDER BY s.name
        `, [classId]);
        
        res.json({
            success: true,
            subjects: subjects
        });
        
    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch subjects'
        });
    }
});

app.post('/enter-scores', uploadNoFile.none(), async (req, res) => {
    const { classId, term, subjectId, academicYear, studentIds, testScores, examScores } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate inputs
        if (!classId || !term || !subjectId || !academicYear) {
            return res.redirect(`/enter-scores?error=Missing required parameters`);
        }
        
        if (!studentIds || !testScores || !examScores) {
            return res.redirect(`/enter-scores?classId=${classId}&term=${term}&subjectId=${subjectId}&academicYear=${academicYear}&error=No score data provided`);
        }
        
        // Convert to arrays if they're single values
        const studentIdsArray = Array.isArray(studentIds) ? studentIds : [studentIds];
        const testScoresArray = Array.isArray(testScores) ? testScores : [testScores];
        const examScoresArray = Array.isArray(examScores) ? examScores : [examScores];
        
        if (studentIdsArray.length !== testScoresArray.length || studentIdsArray.length !== examScoresArray.length) {
            return res.redirect(`/enter-scores?classId=${classId}&term=${term}&subjectId=${subjectId}&academicYear=${academicYear}&error=Invalid score data format`);
        }
        
        // Start transaction
        await connection.beginTransaction();
        
        try {
            // Process each student's scores
            for (let i = 0; i < studentIdsArray.length; i++) {
                const studentId = studentIdsArray[i];
                const testScore = parseInt(testScoresArray[i]);
                const examScore = parseInt(examScoresArray[i]);
                
                // Validate score ranges
                if (isNaN(testScore) || isNaN(examScore) || 
                    testScore < 0 || testScore > 40 || 
                    examScore < 0 || examScore > 60) {
                    throw new Error('Scores must be within valid ranges (Test: 0-40, Exam: 0-60)');
                }
                
                // Check if a record already exists
                const [existing] = await connection.execute(
                    'SELECT id FROM student_scores WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ?',
                    [studentId, subjectId, term, academicYear]
                );
                
                if (existing.length > 0) {
                    // Update existing score
                    await connection.execute(
                        'UPDATE student_scores SET test_score = ?, exam_score = ?, updated_at = NOW() WHERE id = ?',
                        [testScore, examScore, existing[0].id]
                    );
                } else {
                    // Insert new score
                    await connection.execute(
                        'INSERT INTO student_scores (student_id, subject_id, term, academic_year, test_score, exam_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
                        [studentId, subjectId, term, academicYear, testScore, examScore]
                    );
                }
            }
            
            await connection.commit();
            res.redirect(`/enter-scores?classId=${classId}&term=${term}&subjectId=${subjectId}&academicYear=${academicYear}&success=Scores saved successfully`);
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } catch (error) {
        console.error('Error saving scores:', error);
        res.redirect(`/enter-scores?classId=${classId}&term=${term}&subjectId=${subjectId}&academicYear=${academicYear}&error=${encodeURIComponent(error.message)}`);
    }
});

// Broadsheet Routes - Updated
app.get('/broadsheet', authenticate, async (req, res) => {
    const { classId, term, academicYear } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Get all classes with levels and departments
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        if (!classId || !term || !academicYear) {
            // Show selection form - pass formData with proper structure
            res.render('broadsheet-selection', { 
                classes, 
                academicYears,
                terms: ['First Term', 'Second Term', 'Third Term', 'Session'],
                formData: {
                    classId: classId || '',
                    term: term || '',
                    academicYear: academicYear || ''
                },
                error: req.query.error || null
            });
        } else {
            // Generate broadsheet
            await generateBroadsheet(classId, term, academicYear, res);
        }
    } catch (error) {
        console.error('Error loading broadsheet selection:', error);
        res.render('broadsheet-selection', { 
            classes: [], 
            academicYears: [],
            terms: [],
            formData: {
                classId: '',
                term: '',
                academicYear: ''
            },
            error: 'Failed to load selection data'
        });
    }
});

// Updated generateBroadsheet function with promotion logic
async function generateBroadsheet(classId, term, academicYear, res) {
    try {
        const connection = await getConnection();
        
        // Get class info
        const [classResults] = await connection.execute('SELECT className, level, department FROM classes WHERE id = ?', [classId]);
        
        if (classResults.length === 0) {
            return res.redirect('/broadsheet?error=Class not found');
        }
        
        const className = classResults[0].className;
        const classLevel = classResults[0].level;
        const classDepartment = classResults[0].department;
        
        if (term === 'Session') {
            // Session broadsheet - detailed format with all terms
            const [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.middleName, s.lastName, s.department
                FROM students s 
                WHERE s.classId = ? 
                ORDER BY s.lastName, s.firstName
            `, [classId]);
            
            // Get all subjects taught in this class
            const [subjects] = await connection.execute(`
                SELECT DISTINCT sub.id, sub.name 
                FROM subjects sub
                JOIN student_scores sc ON sub.id = sc.subject_id
                JOIN students s ON sc.student_id = s.id
                WHERE s.classId = ? AND sc.academic_year = ?
                ORDER BY sub.name
            `, [classId, academicYear]);
            
            // Get scores for all students and subjects across all terms
            const [scores] = await connection.execute(`
                SELECT 
                    sc.student_id,
                    sc.subject_id,
                    sc.term,
                    COALESCE(sc.test_score, 0) as test_score,
                    COALESCE(sc.exam_score, 0) as exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
                FROM student_scores sc
                JOIN students s ON sc.student_id = s.id
                WHERE s.classId = ? AND sc.academic_year = ?
                ORDER BY sc.student_id, sc.subject_id, sc.term
            `, [classId, academicYear]);
            
            // Organize scores by student and subject
            const scoreMap = {};
            scores.forEach(score => {
                if (!scoreMap[score.student_id]) {
                    scoreMap[score.student_id] = {};
                }
                if (!scoreMap[score.student_id][score.subject_id]) {
                    scoreMap[score.student_id][score.subject_id] = {};
                }
                scoreMap[score.student_id][score.subject_id][score.term] = {
                    test: score.test_score,
                    exam: score.exam_score,
                    total: score.total_score
                };
            });
            
            // Calculate student results with promotion logic
            const studentResults = students.map(student => {
                const studentScores = scoreMap[student.id] || {};
                let subjectAverages = [];
                let totalMarks = 0;
                let subjectsWithScores = 0;
                
                subjects.forEach(subject => {
                    const termScores = studentScores[subject.id] || {};
                    const firstTerm = parseFloat(termScores['First Term']?.total) || 0;
                    const secondTerm = parseFloat(termScores['Second Term']?.total) || 0;
                    const thirdTerm = parseFloat(termScores['Third Term']?.total) || 0;
                    
                    // Calculate average for this subject across all terms
                    const average = (firstTerm + secondTerm + thirdTerm) / 3;
                    subjectAverages.push({
                        subject: subject.name,
                        subjectId: subject.id,
                        firstTerm: firstTerm.toFixed(1),
                        secondTerm: secondTerm.toFixed(1),
                        thirdTerm: thirdTerm.toFixed(1),
                        average: parseFloat(average.toFixed(2))
                    });
                    
                    totalMarks += average;
                    if (average > 0) subjectsWithScores++;
                });
                
                // Calculate overall average and percentage
                const overallAverage = subjectsWithScores > 0 ? totalMarks / subjectsWithScores : 0;
                const percentage = parseFloat(overallAverage.toFixed(2));
                
                // Determine grade
                let grade = 'F';
                if (percentage >= 80) grade = 'A';
                else if (percentage >= 70) grade = 'B';
                else if (percentage >= 60) grade = 'C';
                else if (percentage >= 50) grade = 'D';
                else if (percentage >= 40) grade = 'E';
                
                // Determine promotion status (45% and above promotes, below 45% repeats)
                let promotionStatus = 'Repeat';
                let promotionAction = 'repeat';
                let promotionClass = 'danger';
                
                if (percentage >= 45) {
                    promotionStatus = 'Promote';
                    promotionAction = 'promote';
                    promotionClass = 'success';
                }
                
                return {
                    id: student.id,
                    firstName: student.firstName,
                    middleName: student.middleName,
                    lastName: student.lastName,
                    department: student.department,
                    subjectAverages,
                    overallAverage: parseFloat(overallAverage.toFixed(2)),
                    percentage,
                    grade,
                    promotionStatus,
                    promotionAction,
                    promotionClass,
                    total: parseFloat(totalMarks.toFixed(2)),
                    totalSubjects: subjects.length,
                    subjectsWithScores,
                    position: 0
                };
            });
            
            // Sort students by percentage and assign positions
            studentResults.sort((a, b) => b.percentage - a.percentage);
            studentResults.forEach((student, index) => {
                student.position = index + 1;
            });

            res.render('broadsheet', {
                selectedClass: { 
                    id: classId, 
                    name: className, 
                    level: classLevel, 
                    department: classDepartment 
                },
                term: term.toLowerCase(),
                academicYear,
                results: studentResults,
                subjects: subjects,
                isSessionReport: true,
                error: null
            });
            
        } else {
            // Term broadsheet (simple format)
            const [results] = await connection.execute(`
                SELECT 
                    s.id as student_id,
                    s.firstName as first_name,
                    s.middleName as middle_name,
                    s.lastName as last_name,
                    COUNT(DISTINCT sc.subject_id) as subject_count,
                    COALESCE(SUM(sc.test_score + sc.exam_score), 0) as total_score,
                    COALESCE(AVG(sc.test_score + sc.exam_score), 0) as average_score
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.term = ? AND sc.academic_year = ?
                WHERE s.classId = ?
                GROUP BY s.id
                HAVING subject_count > 0
                ORDER BY average_score DESC
            `, [term, academicYear, classId]);
            
            const processedResults = results.map((student, index) => {
                const avgScore = Number(student.average_score) || 0;
                const percentage = ((avgScore / 100) * 100).toFixed(2);
                
                return {
                    ...student,
                    average_score: avgScore.toFixed(2),
                    position: index + 1,
                    percentage: isNaN(percentage) ? '0.00' : percentage
                };
            });
            
            res.render('broadsheet', { 
                selectedClass: { 
                    id: classId, 
                    name: className, 
                    level: classLevel, 
                    department: classDepartment 
                },
                term: term.toLowerCase(),
                academicYear,
                results: processedResults,
                subjects: [],
                isSessionReport: false,
                error: null
            });
        }
    } catch (error) {
        console.error('Error generating broadsheet:', error);
        res.redirect('/broadsheet?error=Failed to generate broadsheet');
    }
}

// Promotion routes
// POST route to promote student
app.post('/promote-student/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    const { academicYear, nextClassId } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate nextClassId
        if (!nextClassId || nextClassId === 'undefined') {
            return res.status(400).json({ 
                success: false, 
                error: 'Next class ID is required for promotion' 
            });
        }
        
        // Get current student info
        const [student] = await connection.execute(
            'SELECT * FROM students WHERE id = ?',
            [studentId]
        );
        
        if (student.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Verify next class exists
        const [nextClass] = await connection.execute(
            'SELECT id, className FROM classes WHERE id = ?',
            [nextClassId]
        );
        
        if (nextClass.length === 0) {
            return res.status(404).json({ success: false, error: 'Next class not found' });
        }
        
        // Update student class to next class
        await connection.execute(
            'UPDATE students SET classId = ? WHERE id = ?',
            [nextClassId, studentId]
        );
        
        // Record promotion in promotion history
        await connection.execute(
            'INSERT INTO promotion_history (student_id, from_class, to_class, academic_year, action) VALUES (?, ?, ?, ?, ?)',
            [studentId, student[0].classId, nextClassId, academicYear, 'promoted']
        );
        
        res.json({ 
            success: true, 
            message: `Student promoted successfully to ${nextClass[0].className}` 
        });
        
    } catch (error) {
        console.error('Error promoting student:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to promote student: ' + error.message 
        });
    }
});

app.post('/repeat-student/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    const { academicYear } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Get current student info
        const [student] = await connection.execute(
            'SELECT * FROM students WHERE id = ?',
            [studentId]
        );
        
        if (student.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Record repetition in promotion history (student stays in same class)
        await connection.execute(
            'INSERT INTO promotion_history (student_id, from_class, to_class, academic_year, action) VALUES (?, ?, ?, ?, ?)',
            [studentId, student[0].classId, student[0].classId, academicYear, 'repeated']
        );
        
        res.json({ success: true, message: 'Student marked to repeat' });
        
    } catch (error) {
        console.error('Error marking student to repeat:', error);
        res.status(500).json({ success: false, error: 'Failed to mark student to repeat' });
    }
});

// GET classes by level
app.get('/api/classes-by-level/:level', authenticate, async (req, res) => {
    const { level } = req.params;
    
    try {
        const connection = await getConnection();
        
        const [classes] = await connection.execute(
            'SELECT id, className, department FROM classes WHERE level = ? ORDER BY className',
            [level]
        );
        
        res.json({ success: true, classes: classes });
        
    } catch (error) {
        console.error('Error fetching classes by level:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch classes' });
    }
});

// GET all classes
app.get('/api/all-classes', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);
        
        res.json({ success: true, classes: classes });
        
    } catch (error) {
        console.error('Error fetching all classes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch classes' });
    }
});

// GET next class options for promotion
app.get('/api/next-class-options/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    
    try {
        const connection = await getConnection();
        
        // Get student's current class and level
        const [students] = await connection.execute(`
            SELECT s.id, s.classId, c.level, c.className 
            FROM students s 
            JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?
        `, [studentId]);
        
        if (students.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        const student = students[0];
        let nextLevel = '';
        
        // Determine next level based on current level
        switch (student.level) {
            case 'KG': nextLevel = 'NURSERY'; break;
            case 'NURSERY': nextLevel = 'PRIMARY'; break;
            case 'PRIMARY': nextLevel = 'JUNIOR SECONDARY'; break;
            case 'JUNIOR SECONDARY': nextLevel = 'SENIOR SECONDARY'; break;
            case 'SENIOR SECONDARY': 
                return res.json({ success: true, classes: [] }); // Graduated
            default: nextLevel = student.level;
        }
        
        // Get classes for the next level
        const [classes] = await connection.execute(
            'SELECT id, className, department FROM classes WHERE level = ? ORDER BY className',
            [nextLevel]
        );
        
        res.json({ success: true, classes: classes });
        
    } catch (error) {
        console.error('Error getting next class options:', error);
        res.status(500).json({ success: false, error: 'Failed to get next class options' });
    }
});

// Get next class options for promotion
app.get('/next-class-options/:currentClassId', authenticate, async (req, res) => {
    const { currentClassId } = req.params;
    
    try {
        const connection = await getConnection();
        
        // Get current class info
        const [currentClass] = await connection.execute(
            'SELECT level, className FROM classes WHERE id = ?',
            [currentClassId]
        );
        
        if (currentClass.length === 0) {
            return res.status(404).json({ success: false, error: 'Class not found' });
        }
        
        // Determine next class based on current level
        let nextLevel = '';
        const currentLevel = currentClass[0].level;
        
        switch (currentLevel) {
            case 'KG':
                nextLevel = 'NURSERY';
                break;
            case 'NURSERY':
                nextLevel = 'PRIMARY';
                break;
            case 'PRIMARY':
                // For primary, go to next class (Primary 1 -> Primary 2, etc.)
                const currentClassName = currentClass[0].className;
                const classNumber = parseInt(currentClassName.match(/\d+/));
                if (classNumber && classNumber < 6) {
                    nextLevel = 'PRIMARY';
                } else {
                    nextLevel = 'JUNIOR SECONDARY';
                }
                break;
            case 'JUNIOR SECONDARY':
                nextLevel = 'SENIOR SECONDARY';
                break;
            case 'SENIOR SECONDARY':
                // Graduation - no next class
                nextLevel = 'GRADUATED';
                break;
            default:
                nextLevel = currentLevel;
        }
        
        // Get available classes for next level
        if (nextLevel === 'GRADUATED') {
            res.json({ success: true, options: [], message: 'Student has graduated' });
        } else {
            const [nextClasses] = await connection.execute(
                'SELECT id, className, department FROM classes WHERE level = ? ORDER BY className',
                [nextLevel]
            );
            
            res.json({ success: true, options: nextClasses });
        }
        
    } catch (error) {
        console.error('Error getting next class options:', error);
        res.status(500).json({ success: false, error: 'Failed to get next class options' });
    }
});

// Session Records Route - Updated
app.get('/session-records', authenticate, async (req, res) => {
    const { classId, academicYear, studentId } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        if (!classId || !academicYear) {
            // Show class selection - include level and department in the query
            const [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `);
            
            // Create formData object from query parameters
            const formData = {
                classId: classId || '',
                academicYear: academicYear || ''
            };
            
            res.render('session-records-selection', { 
                classes, 
                academicYears,
                formData, // Pass formData to the template
                error: req.query.error || null
            });
        } else {
            // Generate session records
            const [classResults] = await connection.execute('SELECT className, level, department FROM classes WHERE id = ?', [classId]);
            
            if (classResults.length === 0) {
                return res.status(404).send('Class not found');
            }
            
            const className = classResults[0].className;
            const classLevel = classResults[0].level;
            const classDepartment = classResults[0].department;
            
            // Get session records
            const [results] = await connection.execute(`
                SELECT 
                    s.id as student_id,
                    s.firstName,
                    s.lastName,
                    s.department as student_department,
                    sub.id as subject_id,
                    sub.name as subject_name,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'First Term' AND academic_year = ?
                    ), 0) as first_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'Second Term' AND academic_year = ?
                    ), 0) as second_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'Third Term' AND academic_year = ?
                    ), 0) as third_term_score
                FROM students s
                CROSS JOIN subjects sub
                WHERE s.classId = ?
                ORDER BY s.lastName, s.firstName, sub.name
            `, [academicYear, academicYear, academicYear, classId]);
            
            // Organize by student
            const students = {};
            results.forEach(row => {
                if (!students[row.student_id]) {
                    students[row.student_id] = {
                        id: row.student_id,
                        firstName: row.firstName,
                        lastName: row.lastName,
                        department: row.student_department,
                        subjects: []
                    };
                }
                
                // Ensure scores are numbers
                const firstTerm = parseFloat(row.first_term_score) || 0;
                const secondTerm = parseFloat(row.second_term_score) || 0;
                const thirdTerm = parseFloat(row.third_term_score) || 0;
                
                const average = (firstTerm + secondTerm + thirdTerm) / 3;
                
                students[row.student_id].subjects.push({
                    subject_id: row.subject_id,
                    subject_name: row.subject_name,
                    first_term: firstTerm,
                    second_term: secondTerm,
                    third_term: thirdTerm,
                    average: average.toFixed(2)
                });
            });
            
            // Calculate overall averages
            Object.keys(students).forEach(studentId => {
                const student = students[studentId];
                let totalAverage = 0;
                
                student.subjects.forEach(subject => {
                    totalAverage += parseFloat(subject.average) || 0;
                });
                
                student.overallAverage = student.subjects.length > 0 
                    ? (totalAverage / student.subjects.length).toFixed(2) 
                    : '0.00';
                
                student.percentage = student.subjects.length > 0
                    ? ((totalAverage / (student.subjects.length * 100)) * 100).toFixed(2)
                    : '0.00';
            });
            
            // Get student list for dropdown
            const studentList = Object.keys(students).map(id => {
                return {
                    id: id,
                    firstName: students[id].firstName,
                    lastName: students[id].lastName,
                    department: students[id].department
                };
            });
            
            res.render('session-records', {
                className,
                classLevel,
                classDepartment,
                classId,
                academicYear,
                students,
                studentList, // Pass student list for dropdown
                selectedStudentId: studentId || null, // Pass selected student ID
                success: req.query.success || null,
                error: req.query.error || null
            });
        }
    } catch (error) {
        console.error('Error loading session records:', error);
        
        // Even in error case, provide empty formData
        res.render('session-records-selection', {
            classes: [],
            academicYears: [],
            formData: {
                classId: '',
                academicYear: ''
            },
            error: 'Failed to load session records data'
        });
    }
});

// GET route to display class bills list and print functionality
app.get('/class-bills', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const selectedClassId = req.query.classId || null;
        const selectedAcademicYear = req.query.academicYear || null;
        const selectedTerm = req.query.term || null;
        const { page = 1, limit = 20 } = req.query;
        
        // Check if this is a print request
        const isPrintView = req.query.print === 'true';
        
        // Build WHERE clause
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (selectedClassId) {
            whereClause += ' AND cb.class_id = ?';
            queryParams.push(selectedClassId);
        }
        
        if (selectedAcademicYear) {
            whereClause += ' AND cb.academic_year = ?';
            queryParams.push(selectedAcademicYear);
        }
        
        if (selectedTerm) {
            whereClause += ' AND cb.term = ?';
            queryParams.push(selectedTerm);
        }
        
        // Get total count for pagination (only for list view)
        let totalCount = 0;
        let totalPages = 1;
        let offset = 0;
        
        if (!isPrintView) {
            const [totalCountResult] = await connection.execute(
                `SELECT COUNT(*) as total FROM class_bills cb ${whereClause}`,
                queryParams
            );
            
            totalCount = totalCountResult[0].total;
            totalPages = Math.ceil(totalCount / limit);
            offset = (page - 1) * limit;
        }
        
        // Get all classes for filter dropdown
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        // Get academic years for filter dropdown
        let academicYears = [];
        
        try {
            const [yearsFromBills] = await connection.execute(`
                SELECT DISTINCT academic_year as year_name 
                FROM class_bills 
                WHERE academic_year IS NOT NULL AND academic_year != ''
                ORDER BY academic_year DESC
            `);
            
            if (yearsFromBills.length > 0) {
                academicYears = yearsFromBills;
            } else {
                // Fallback to academic_years table
                const [yearsFromAcademic] = await connection.execute(`
                    SELECT year_name 
                    FROM academic_years 
                    ORDER BY start_date DESC
                `);
                academicYears = yearsFromAcademic;
            }
        } catch (error) {
            console.error('Error fetching academic years:', error);
            academicYears = [];
        }
        
        // Get bills for display
        let bills = [];
        let billsQuery = '';
        
        if (isPrintView) {
            // For print view, get all bills without pagination
            billsQuery = `
                SELECT 
                    cb.*, 
                    c.className as class_display_name,
                    c.level as class_level,
                    c.department as class_department
                FROM class_bills cb
                JOIN classes c ON cb.class_id = c.id
                ${whereClause}
                ORDER BY cb.fee_type
            `;
        } else {
            // For list view, get bills with pagination and additional info
            billsQuery = `
                SELECT 
                    cb.*, 
                    c.className as class_display_name,
                    c.level as class_level,
                    c.department as class_department,
                    COUNT(DISTINCT s.id) as student_count,
                    COALESCE(SUM(CASE WHEN f.status IN ('paid', 'partial') THEN f.amountPaid ELSE 0 END), 0) as amount_collected
                FROM class_bills cb
                JOIN classes c ON cb.class_id = c.id
                LEFT JOIN students s ON s.classId = cb.class_id
                LEFT JOIN fees f ON f.studentId = s.id 
                    AND cb.fee_type = f.feeType 
                    AND cb.academic_year = f.academicYear 
                    AND cb.term = f.term
                ${whereClause}
                GROUP BY cb.id
                ORDER BY cb.academic_year DESC, cb.term, c.className
                LIMIT ? OFFSET ?
            `;
            queryParams = [...queryParams, parseInt(limit), parseInt(offset)];
        }
        
        // Execute the appropriate query
        [bills] = await connection.execute(billsQuery, queryParams);
        
        // Get school information
        const [schoolInfo] = await connection.execute(`
            SELECT * FROM school_info LIMIT 1
        `);
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };
        
        // Always render the same template but pass isPrintView flag
        res.render('class-bills-list', {
            classes: classes,
            bills: bills,
            school: school,
            selectedClassId: selectedClassId,
            selectedAcademicYear: selectedAcademicYear,
            selectedTerm: selectedTerm,
            academicYears: academicYears,
            currentPage: parseInt(page),
            totalPages: totalPages,
            totalCount: totalCount,
            limit: parseInt(limit),
            isPrintView: isPrintView, // This controls which view to show
            moment: require('moment'),
            error: null
        });
        
    } catch (error) {
        console.error('Error loading class bills:', error);
        res.render('class-bills-list', {
            classes: [],
            bills: [],
            selectedClassId: null,
            selectedAcademicYear: null,
            selectedTerm: null,
            academicYears: [],
            currentPage: 1,
            totalPages: 1,
            totalCount: 0,
            limit: 20,
            isPrintView: false,
            error: 'Failed to load class bills: ' + error.message
        });
    }
});

// GET route to display class bill form
app.get('/class-bills/create', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const billId = req.query.id; // For editing existing bill
        
        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get current academic year
        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get terms
        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms ORDER BY 
            CASE term_name
                WHEN 'First Term' THEN 1
                WHEN 'Second Term' THEN 2
                WHEN 'Third Term' THEN 3
            END
        `);
        
        let billData = {};
        let isEdit = false;
        
        // If editing, get existing bill data
        if (billId) {
            const [bills] = await connection.execute(`
                SELECT * FROM class_bills WHERE id = ?
            `, [billId]);
            
            if (bills.length > 0) {
                billData = bills[0];
                isEdit = true;
            }
        }
        
        res.render('class-bills-form', {
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
            billData: billData,
            isEdit: isEdit,
            feeTypes: ['Tuition', 'Examination', 'Library', 'Sports', 'Transportation', 'Development', 'ICT', 'Science Lab', 'Textbooks', 'Uniform', 'Other'],
            error: null
        });
    } catch (error) {
        console.error('Error loading class bill form:', error);
        res.render('class-bills-form', {
            classes: [],
            academicYears: [],
            terms: [],
            currentAcademicYear: null,
            billData: {},
            isEdit: false,
            feeTypes: [],
            error: 'Failed to load form'
        });
    }
});

// POST route to add/update class bill
app.post('/save-class-bill', uploadNoFile.none(), async (req, res) => {
    const { billId, classId, feeType, amount, academicYear, term, description, dueDate } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!classId || !feeType || !amount || !academicYear || !term) {
            return res.status(400).json({
                success: false,
                error: 'Class, Fee Type, Amount, Academic Year, and Term are required fields'
            });
        }
        
        // Validate amount
        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid amount in Naira'
            });
        }
        
        // Get class details
        const [classDetails] = await connection.execute(`
            SELECT className, level, department FROM classes WHERE id = ?
        `, [classId]);
        
        if (classDetails.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Class not found'
            });
        }
        
        const classInfo = classDetails[0];
        const isEdit = !!billId;
        
        if (isEdit) {
            // Update existing bill
            await connection.execute(`
                UPDATE class_bills SET
                    class_id = ?, class_name = ?, level = ?, department = ?, 
                    fee_type = ?, amount = ?, academic_year = ?, term = ?, 
                    description = ?, due_date = ?
                WHERE id = ?
            `, [
                classId,
                classInfo.className,
                classInfo.level,
                classInfo.department,
                feeType,
                amountValue,
                academicYear,
                term,
                description || null,
                dueDate || null,
                billId
            ]);
            
            res.json({
                success: true,
                message: 'Class bill updated successfully'
            });
        } else {
            // Check if bill already exists
            const [existingBills] = await connection.execute(`
                SELECT id FROM class_bills 
                WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ?
            `, [classId, feeType, academicYear, term]);
            
            if (existingBills.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'A bill for this fee type already exists for the selected class, academic year, and term'
                });
            }
            
            // Insert new class bill
            await connection.execute(`
                INSERT INTO class_bills (
                    class_id, class_name, level, department, fee_type, amount, 
                    academic_year, term, description, due_date, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                classId,
                classInfo.className,
                classInfo.level,
                classInfo.department,
                feeType,
                amountValue,
                academicYear,
                term,
                description || null,
                dueDate || null,
                req.session.userId || 1
            ]);
            
            res.json({
                success: true,
                message: 'Class bill created successfully'
            });
        }
        
    } catch (error) {
        console.error('Error saving class bill:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save class bill: ' + error.message
        });
    }
});

// GET route to delete class bill
// GET route to delete class bill - FIXED
app.get('/delete-class-bill/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const billId = req.params.id;
        
        // First get the bill details to check against
        const [billDetails] = await connection.execute(
            'SELECT class_id, fee_type, academic_year, term FROM class_bills WHERE id = ?',
            [billId]
        );
        
        if (billDetails.length === 0) {
            req.session.error = 'Bill not found';
            return res.redirect('/class-bills');
        }
        
        const bill = billDetails[0];
        
        // Check if there are any fees linked to this bill by joining through students table
        const [linkedFees] = await connection.execute(`
            SELECT COUNT(*) as count 
            FROM fees f
            JOIN students s ON f.studentId = s.id
            WHERE s.classId = ?
            AND f.feeType = ?
            AND f.academicYear = ?
            AND f.term = ?
        `, [bill.class_id, bill.fee_type, bill.academic_year, bill.term]);
        
        if (linkedFees[0].count > 0) {
            req.session.error = 'Cannot delete bill. There are fees linked to this bill.';
            return res.redirect('/class-bills');
        }
        
        // If no linked fees, delete the bill
        await connection.execute(
            'DELETE FROM class_bills WHERE id = ?',
            [billId]
        );
        
        req.session.success = 'Class bill deleted successfully';
        res.redirect('/class-bills');
        
    } catch (error) {
        console.error('Error deleting class bill:', error);
        req.session.error = 'Failed to delete class bill';
        res.redirect('/class-bills');
    }
});

// GET route to display attendance marking page
app.get('/mark-attendance', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { academicYear, term, week, day, session } = req.query;
        
        // Get current academic year and term if not specified
        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT * FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        // Get academic years and terms for dropdowns
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms ORDER BY start_date DESC
        `);
        
        let students = [];
        let selectedDate = null;
        let weekDays = [];
        let weeksInTerm = [];
        
        // If academic year and term are selected, calculate weeks and days
        if (academicYear && term) {
            // Get term details
            const [termDetails] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE term_name = ? AND academic_year_id = (
                    SELECT id FROM academic_years WHERE year_name = ?
                )
            `, [term, academicYear]);
            
            if (termDetails.length > 0) {
                const termStart = moment(termDetails[0].start_date);
                const termEnd = moment(termDetails[0].end_date);
                
                // Calculate all weeks in the term
                let currentWeek = termStart.clone();
                let weekNumber = 1;
                
                while (currentWeek.isSameOrBefore(termEnd)) {
                    weeksInTerm.push(weekNumber);
                    currentWeek.add(1, 'week');
                    weekNumber++;
                }
                
                // Calculate days for selected week
                if (week) {
                    const weekStart = termStart.clone().add((parseInt(week) - 1), 'weeks');
                    const weekEnd = weekStart.clone().add(6, 'days');
                    
                    // Get all school days (Monday-Friday) for the week
                    let currentDay = weekStart.clone();
                    while (currentDay.isSameOrBefore(weekEnd)) {
                        if (currentDay.isoWeekday() >= 1 && currentDay.isoWeekday() <= 5) {
                            weekDays.push({
                                date: currentDay.format('YYYY-MM-DD'),
                                dayName: currentDay.format('dddd'),
                                formatted: currentDay.format('ddd, MMM D, YYYY')
                            });
                        }
                        currentDay.add(1, 'day');
                    }
                    
                    // Set selected date based on day parameter
                    if (day && weekDays[parseInt(day) - 1]) {
                        selectedDate = weekDays[parseInt(day) - 1].date;
                    } else if (weekDays.length > 0) {
                        selectedDate = weekDays[0].date;
                    }
                }
            }
            
            // Get students for the selected class if class is selected
            const classId = req.query.classId;
            if (classId) {
                [students] = await connection.execute(`
                    SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number
                    FROM students s 
                    WHERE s.classId = ? 
                    ORDER BY s.firstName, s.lastName
                `, [classId]);
                
                // Get existing attendance records for the selected date
                let attendanceData = [];
                if (selectedDate) {
                    const [attendance] = await connection.execute(`
                        SELECT a.*, s.firstName, s.lastName, s.admission_number
                        FROM attendance_records a
                        JOIN students s ON a.student_id = s.id
                        WHERE a.class_id = ? AND a.date = ? AND a.academic_year = ? AND a.term = ?
                        ORDER BY s.firstName, s.lastName
                    `, [classId, selectedDate, academicYear, term]);
                    
                    // Create a map of student attendance for easy lookup
                    const attendanceMap = {};
                    attendance.forEach(record => {
                        attendanceMap[record.student_id] = record;
                    });
                    
                    // Prepare attendance data with all students
                    attendanceData = students.map(student => {
                        const attendanceRecord = attendanceMap[student.id];
                        return {
                            studentId: student.id,
                            firstName: student.firstName,
                            middleName: student.middleName,
                            lastName: student.lastName,
                            admissionNumber: student.admission_number,
                            morningStatus: attendanceRecord ? attendanceRecord.morning_status : null,
                            afternoonStatus: attendanceRecord ? attendanceRecord.afternoon_status : null,
                            notes: attendanceRecord ? attendanceRecord.notes : null,
                            recordId: attendanceRecord ? attendanceRecord.id : null
                        };
                    });
                    
                    students = attendanceData;
                }
            }
        }
        
        res.render('mark-attendance', {
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            weeks: weeksInTerm,
            weekDays: weekDays,
            students: students,
            selectedAcademicYear: academicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : ''),
            selectedTerm: term || (currentTerm.length > 0 ? currentTerm[0].term_name : ''),
            selectedWeek: week || '',
            selectedDay: day || '',
            selectedSession: session || 'morning',
            selectedClassId: req.query.classId || '',
            selectedDate: selectedDate,
            moment: require('moment'),
            error: null
        });
        
    } catch (error) {
        console.error('Error loading attendance marking page:', error);
        res.render('mark-attendance', {
            classes: [],
            academicYears: [],
            terms: [],
            weeks: [],
            weekDays: [],
            students: [],
            selectedAcademicYear: '',
            selectedTerm: '',
            selectedWeek: '',
            selectedDay: '',
            selectedSession: 'morning',
            selectedClassId: '',
            selectedDate: null,
            error: 'Failed to load attendance data'
        });
    }
});

// POST route to record attendance (already exists, but ensure it handles the new structure)
// POST route to record attendance
app.post('/record-attendance', uploadNoFile.none(), async (req, res) => {
    try {
        const connection = await getConnection();
        const { classId, date, academicYear, term, session, attendance } = req.body;
        
        if (!classId || !date || !academicYear || !term || !session) {
            return res.status(400).json({
                success: false,
                error: 'Class, date, academic year, term, and session are required'
            });
        }
        
        // Validate session
        if (session !== 'morning' && session !== 'afternoon') {
            return res.status(400).json({
                success: false,
                error: 'Session must be either "morning" or "afternoon"'
            });
        }
        
        // Get user info from session
        const recordedByUserId = req.session.userId || null;
        const recordedByName = req.session.username || 'System Administrator';
        
        await connection.beginTransaction();
        
        try {
            for (const studentId in attendance) {
                const { status, notes } = attendance[studentId];
                
                if (status) {
                    // Check if attendance record already exists
                    const [existingRecords] = await connection.execute(`
                        SELECT id FROM attendance_records 
                        WHERE student_id = ? AND date = ? AND academic_year = ? AND term = ?
                    `, [studentId, date, academicYear, term]);
                    
                    if (existingRecords.length > 0) {
                        // Update existing record
                        await connection.execute(`
                            UPDATE attendance_records 
                            SET ${session}_status = ?, notes = COALESCE(?, notes), 
                                recorded_by_user_id = ?, recorded_by_name = ?, updated_at = NOW()
                            WHERE student_id = ? AND date = ? AND academic_year = ? AND term = ?
                        `, [status, notes, recordedByUserId, recordedByName, studentId, date, academicYear, term]);
                    } else {
                        // Insert new record
                        await connection.execute(`
                            INSERT INTO attendance_records 
                            (student_id, class_id, date, academic_year, term, 
                             ${session}_status, recorded_by_user_id, recorded_by_name, notes)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            studentId, 
                            classId, 
                            date, 
                            academicYear, 
                            term,
                            status, 
                            recordedByUserId,
                            recordedByName,
                            notes || null
                        ]);
                    }
                }
            }
            
            await connection.commit();
            
            res.json({
                success: true,
                message: `${session.charAt(0).toUpperCase() + session.slice(1)} attendance recorded successfully`
            });
            
        } catch (error) {
            await connection.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('Error recording attendance:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to record attendance: ' + error.message
        });
    }
});

// GET route to view attendance reports
app.get('/attendance-reports', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { classId, month, studentId, academicYear, term, viewType, weekStart, weekEnd } = req.query;
        
        // Get current academic year and term if not specified
        let targetAcademicYear = academicYear;
        let targetTerm = term;
        
        if (!targetAcademicYear || !targetTerm) {
            const [currentAcademicYear] = await connection.execute(`
                SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
            `);
            
            const [currentTerm] = await connection.execute(`
                SELECT * FROM academic_terms WHERE is_current = TRUE LIMIT 1
            `);
            
            if (currentAcademicYear.length > 0) targetAcademicYear = currentAcademicYear[0].year_name;
            if (currentTerm.length > 0) targetTerm = currentTerm[0].term_name;
        }
        
        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        let reportData = [];
        let students = [];
        let selectedMonth = month || moment().format('YYYY-MM');
        let selectedViewType = viewType || 'summary';
        let selectedWeekStart = weekStart;
        let selectedWeekEnd = weekEnd;
        
        // Calculate attendance percentages
        let weeklyPercentage = null;
        let termlyPercentage = null;
        let yearlyPercentage = null;

        if (classId && targetAcademicYear && targetTerm) {
            // Get students for the selected class
            [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number
                FROM students s 
                WHERE s.classId = ? 
                ORDER BY s.firstName, s.lastName
            `, [classId]);
            
            // Get term dates for the selected term
            const [termDates] = await connection.execute(`
                SELECT start_date, end_date 
                FROM academic_terms 
                WHERE term_name = ? AND academic_year_id = (
                    SELECT id FROM academic_years WHERE year_name = ?
                )
            `, [targetTerm, targetAcademicYear]);
            
            if (termDates.length > 0 && termDates[0].start_date && termDates[0].end_date) {
                const termStart = moment(termDates[0].start_date);
                const termEnd = moment(termDates[0].end_date);
                
                // Calculate weekly percentage
                let weekStartDate, weekEndDate;

                if (weekStart && weekEnd) {
                    // Use provided week dates
                    weekStartDate = moment(weekStart);
                    weekEndDate = moment(weekEnd);
                    selectedWeekStart = weekStart;
                    selectedWeekEnd = weekEnd;
                    
                    // Ensure proper date order
                    if (weekStartDate.isAfter(weekEndDate)) {
                        // Swap dates if they're in wrong order
                        [weekStartDate, weekEndDate] = [weekEndDate, weekStartDate];
                        [selectedWeekStart, selectedWeekEnd] = [selectedWeekEnd, selectedWeekStart];
                    }
                } else {
                    // Calculate current week (or use the selected month if provided)
                    if (month) {
                        // Use the month to get the first complete week
                        const monthStart = moment(month + '-01');
                        weekStartDate = monthStart.startOf('week');
                        weekEndDate = weekStartDate.clone().add(6, 'days');
                    } else {
                        // Use current week
                        weekStartDate = moment().startOf('week');
                        weekEndDate = moment().endOf('week');
                    }
                    
                    // Ensure week is within term dates
                    if (weekStartDate.isBefore(termStart)) weekStartDate = termStart.clone();
                    if (weekEndDate.isAfter(termEnd)) weekEndDate = termEnd.clone();
                    
                    selectedWeekStart = weekStartDate.format('YYYY-MM-DD');
                    selectedWeekEnd = weekEndDate.format('YYYY-MM-DD');
                }
                // Calculate weekly attendance percentage
                const [weeklyAttendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                        COUNT(*) as total_sessions
                    FROM attendance_records 
                    WHERE class_id = ? 
                    AND date BETWEEN ? AND ?
                    AND academic_year = ? 
                    AND term = ?
                `, [classId, selectedWeekStart, selectedWeekEnd, targetAcademicYear, targetTerm]);

                if (weeklyAttendance.length > 0 && weeklyAttendance[0].total_sessions > 0) {
                    weeklyPercentage = {
                        weekStart: selectedWeekStart,
                        weekEnd: selectedWeekEnd,
                        presentCount: weeklyAttendance[0].present_count,
                        totalSessions: weeklyAttendance[0].total_sessions,
                        percentage: ((weeklyAttendance[0].present_count / weeklyAttendance[0].total_sessions) * 100).toFixed(2)
                    };
                } else {
                    weeklyPercentage = null;
                }
                
                // Calculate termly attendance percentage
                // Calculate school days in term (Monday-Friday)
                let schoolDays = 0;
                let currentDay = termStart.clone();
                
                while (currentDay.isSameOrBefore(termEnd)) {
                    // Count only weekdays (Monday-Friday)
                    if (currentDay.isoWeekday() >= 1 && currentDay.isoWeekday() <= 5) {
                        schoolDays++;
                    }
                    currentDay.add(1, 'day');
                }
                
                // Calculate maximum possible attendance (school days × number of students)
                const maxTermAttendance = students.length * schoolDays;
                
                // Get actual attendance for the term
                const [termAttendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                        COUNT(*) as total_sessions
                    FROM attendance_records 
                    WHERE class_id = ? 
                    AND date BETWEEN ? AND ?
                    AND academic_year = ? 
                    AND term = ?
                `, [classId, termStart.format('YYYY-MM-DD'), termEnd.format('YYYY-MM-DD'), targetAcademicYear, targetTerm]);
                
                if (termAttendance.length > 0 && maxTermAttendance > 0) {
                    termlyPercentage = {
                        termStart: termStart.format('YYYY-MM-DD'),
                        termEnd: termEnd.format('YYYY-MM-DD'),
                        presentCount: termAttendance[0].present_count,
                        totalSessions: termAttendance[0].total_sessions,
                        schoolDays: schoolDays,
                        maxPossibleAttendance: maxTermAttendance,
                        percentage: ((termAttendance[0].present_count / maxTermAttendance) * 100).toFixed(2),
                        studentCount: students.length
                    };
                }
            }
            
            // Calculate academic year attendance percentage
            // Get all terms in the academic year
            const [academicYearTerms] = await connection.execute(`
                SELECT term_name, start_date, end_date 
                FROM academic_terms 
                WHERE academic_year_id = (
                    SELECT id FROM academic_years WHERE year_name = ?
                )
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [targetAcademicYear]);
            
            if (academicYearTerms.length > 0) {
                // Calculate school days across all terms
                let totalSchoolDays = 0;
                let yearlyStartDate = null;
                let yearlyEndDate = null;
                
                for (const term of academicYearTerms) {
                    if (term.start_date && term.end_date) {
                        const termStart = moment(term.start_date);
                        const termEnd = moment(term.end_date);
                        
                        // Set yearly date range
                        if (!yearlyStartDate || termStart.isBefore(yearlyStartDate)) {
                            yearlyStartDate = termStart.clone();
                        }
                        if (!yearlyEndDate || termEnd.isAfter(yearlyEndDate)) {
                            yearlyEndDate = termEnd.clone();
                        }
                        
                        // Count school days in this term (Monday-Friday)
                        let currentDay = termStart.clone();
                        while (currentDay.isSameOrBefore(termEnd)) {
                            if (currentDay.isoWeekday() >= 1 && currentDay.isoWeekday() <= 5) {
                                totalSchoolDays++;
                            }
                            currentDay.add(1, 'day');
                        }
                    }
                }
                
                // Calculate maximum possible attendance for the year
                const maxYearlyAttendance = students.length * totalSchoolDays;
                
                // Get actual attendance for the entire academic year
                const [yearlyAttendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                        COUNT(*) as total_sessions
                    FROM attendance_records 
                    WHERE class_id = ? 
                    AND academic_year = ?
                `, [classId, targetAcademicYear]);
                
                if (yearlyAttendance.length > 0 && maxYearlyAttendance > 0) {
                    yearlyPercentage = {
                        academicYear: targetAcademicYear,
                        startDate: yearlyStartDate.format('YYYY-MM-DD'),
                        endDate: yearlyEndDate.format('YYYY-MM-DD'),
                        presentCount: yearlyAttendance[0].present_count,
                        totalSessions: yearlyAttendance[0].total_sessions,
                        schoolDays: totalSchoolDays,
                        maxPossibleAttendance: maxYearlyAttendance,
                        percentage: ((yearlyAttendance[0].present_count / maxYearlyAttendance) * 100).toFixed(2),
                        studentCount: students.length,
                        termCount: academicYearTerms.length
                    };
                }
            }
            
            if (studentId || selectedViewType === 'detailed') {
                // Get detailed attendance records
                let query = `
                    SELECT a.*, c.className, 
                           CONCAT(s.firstName, ' ', COALESCE(s.middleName, ''), ' ', s.lastName) as student_name,
                           s.admission_number
                    FROM attendance_records a
                    JOIN classes c ON a.class_id = c.id
                    JOIN students s ON a.student_id = s.id
                    WHERE a.class_id = ? AND a.academic_year = ? AND a.term = ?
                `;
                
                let params = [classId, targetAcademicYear, targetTerm];
                
                if (studentId) {
                    query += ' AND a.student_id = ?';
                    params.push(studentId);
                }
                
                if (month) {
                    query += ' AND DATE_FORMAT(a.date, "%Y-%m") = ?';
                    params.push(selectedMonth);
                }
                
                query += ' ORDER BY a.date DESC, s.firstName, s.lastName';
                
                const [detailedAttendance] = await connection.execute(query, params);
                reportData = detailedAttendance;
            } else {
                // Get class summary for the selected period
                let summaryQuery = `
                    SELECT 
                        s.id as student_id,
                        CONCAT(s.firstName, ' ', COALESCE(s.middleName, ''), ' ', s.lastName) as student_name,
                        s.admission_number,
                        COUNT(CASE WHEN a.morning_status = 'present' THEN 1 END) as morning_present,
                        COUNT(CASE WHEN a.morning_status = 'absent' THEN 1 END) as morning_absent,
                        COUNT(CASE WHEN a.morning_status = 'late' THEN 1 END) as morning_late,
                        COUNT(CASE WHEN a.morning_status = 'excused' THEN 1 END) as morning_excused,
                        COUNT(CASE WHEN a.afternoon_status = 'present' THEN 1 END) as afternoon_present,
                        COUNT(CASE WHEN a.afternoon_status = 'absent' THEN 1 END) as afternoon_absent,
                        COUNT(CASE WHEN a.afternoon_status = 'late' THEN 1 END) as afternoon_late,
                        COUNT(CASE WHEN a.afternoon_status = 'excused' THEN 1 END) as afternoon_excused,
                        COUNT(*) as total_sessions,
                        ROUND((COUNT(CASE WHEN a.morning_status = 'present' OR a.afternoon_status = 'present' THEN 1 END) * 100.0 / COUNT(*)), 2) as attendance_percentage
                    FROM students s
                    LEFT JOIN attendance_records a ON s.id = a.student_id 
                        AND a.class_id = ? 
                        AND a.academic_year = ?
                        AND a.term = ?
                `;
                
                let summaryParams = [classId, targetAcademicYear, targetTerm];
                
                if (month) {
                    summaryQuery += ' AND DATE_FORMAT(a.date, "%Y-%m") = ?';
                    summaryParams.push(selectedMonth);
                }
                
                summaryQuery += ' WHERE s.classId = ? GROUP BY s.id ORDER BY s.firstName, s.lastName';
                summaryParams.push(classId);
                
                const [classSummary] = await connection.execute(summaryQuery, summaryParams);
                reportData = classSummary;
            }
        }
        
        // Get available academic years and terms
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms ORDER BY start_date DESC
        `);
        
        // Calculate overall statistics
        let overallStats = {
            totalStudents: reportData.length,
            avgAttendance: 0,
            totalPresent: 0,
            totalSessions: 0
        };
        
        if (reportData.length > 0 && !studentId && selectedViewType !== 'detailed') {
            const totalPresent = reportData.reduce((sum, student) => {
                return sum + (student.morning_present || 0) + (student.afternoon_present || 0);
            }, 0);
            
            const totalSessions = reportData.reduce((sum, student) => {
                return sum + (student.total_sessions || 0);
            }, 0);
            
            overallStats.totalPresent = totalPresent;
            overallStats.totalSessions = totalSessions;
            overallStats.avgAttendance = totalSessions > 0 ? Math.round((totalPresent / totalSessions) * 100) : 0;
        }
                
        res.render('attendance-reports', {
            classes: classes,
            students: students,
            reportData: reportData,
            academicYears: academicYears,
            terms: terms,
            selectedClassId: classId || '',
            selectedMonth: selectedMonth,
            selectedStudentId: studentId || '',
            selectedAcademicYear: targetAcademicYear || '',
            selectedTerm: targetTerm || '',
            selectedViewType: selectedViewType,
            selectedWeekStart: selectedWeekStart || '',
            selectedWeekEnd: selectedWeekEnd || '',
            weeklyPercentage: weeklyPercentage,
            termlyPercentage: termlyPercentage,
            yearlyPercentage: yearlyPercentage,
            overallStats: overallStats,
            moment: require('moment'),
            error: null
        });
        
    } catch (error) {
        console.error('Error loading attendance reports:', error);
        res.render('attendance-reports', {
            classes: [],
            students: [],
            reportData: [],
            academicYears: [],
            terms: [],
            selectedClassId: '',
            selectedMonth: moment().format('YYYY-MM'),
            selectedStudentId: '',
            selectedAcademicYear: '',
            selectedTerm: '',
            selectedViewType: 'summary',
            selectedWeekStart: '',
            selectedWeekEnd: '',
            weeklyPercentage: null,
            termlyPercentage: null,
            yearlyPercentage: null,
            overallStats: {},
            error: 'Failed to load attendance reports: ' + error.message
        });
    }
});

//report card
app.get('/report-cards', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { classId, studentId, term, academicYear } = req.query;
        
        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);
        
        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        let students = [];
        let selectedStudent = null;
        
        if (classId) {
            // Get students for the selected class
            [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number
                FROM students s 
                WHERE s.classId = ? 
                ORDER BY s.firstName, s.lastName
            `, [classId]);
            
            // Find the selected student if studentId is provided
            if (studentId && students.length > 0) {
                selectedStudent = students.find(s => s.id == studentId);
            }
        }
        
        res.render('report-card-selection', {
            classes: classes,
            students: students,
            academicYears: academicYears,
            terms: ['First Term', 'Second Term', 'Third Term', 'Session'],
            formData: {
                classId: classId || '',
                studentId: studentId || '',
                term: term || '',
                academicYear: academicYear || ''
            },
            student: selectedStudent, // Pass the selected student to template
            error: req.query.error || null
        });
        
    } catch (error) {
        console.error('Error loading report card selection:', error);
        res.render('report-card-selection', {
            classes: [],
            students: [],
            academicYears: [],
            terms: [],
            formData: {
                classId: '',
                studentId: '',
                term: '',
                academicYear: ''
            },
            student: null,
            error: 'Failed to load selection data'
        });
    }
});

// GET route to generate and display report card
app.get('/report-card', authenticate, async (req, res) => {
    const { studentId, term, academicYear } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Validate required parameters
        if (!studentId || !term || !academicYear) {
            return res.redirect('/report-cards?error=Student, Term, and Academic Year are required');
        }
        
        // Get student information
        const [studentResults] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department as classDepartment
            FROM students s 
            JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?
        `, [studentId]);
        
        if (studentResults.length === 0) {
            return res.redirect('/report-cards?error=Student not found');
        }
        
        const student = studentResults[0];
        
        // Get school information
        const [schoolInfo] = await connection.execute(`
            SELECT * FROM school_info LIMIT 1
        `);
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            logo: "/images/school-logo.png",
            website: "www.excelcollege.edu.ng",
            motto: "Excellence in Education"
        };
        
        if (term === 'Session') {
            // Generate session report card
            await generateSessionReportCard(student, academicYear, school, res);
        } else {
            // Generate term report card
            await generateTermReportCard(student, term, academicYear, school, res);
        }
        
    } catch (error) {
        console.error('Error generating report card:', error);
        res.redirect('/report-cards?error=Failed to generate report card: ' + encodeURIComponent(error.message));
    }
});

// Generate term report card
async function generateTermReportCard(student, term, academicYear, school, res) {
    try {
        const connection = await getConnection();
        
        // Get scores for the selected term
        const [scores] = await connection.execute(`
            SELECT 
                s.name as subject_name,
                s.subject_code,
                sc.test_score,
                sc.exam_score,
                COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                sc.term
            FROM student_scores sc
            JOIN subjects s ON sc.subject_id = s.id
            WHERE sc.student_id = ? AND sc.term = ? AND sc.academic_year = ?
            ORDER BY s.name
        `, [student.id, term, academicYear]);
        
        // Calculate term statistics
        let termTotal = 0;
        let termAverage = 0;
        let subjectCount = scores.length;
        
        if (scores.length > 0) {
            termTotal = scores.reduce((sum, score) => sum + parseFloat(score.total_score || 0), 0);
            termAverage = termTotal / scores.length;
        }
        
        const termPercentage = ((termAverage / 100) * 100).toFixed(2);
        
        // Determine grade for the term
        let termGrade = 'F';
        let gradeRemark = 'Fail';
        
        if (termAverage >= 80) {
            termGrade = 'A';
            gradeRemark = 'Excellent';
        } else if (termAverage >= 70) {
            termGrade = 'B';
            gradeRemark = 'Very Good';
        } else if (termAverage >= 60) {
            termGrade = 'C';
            gradeRemark = 'Good';
        } else if (termAverage >= 50) {
            termGrade = 'D';
            gradeRemark = 'Fair';
        } else if (termAverage >= 40) {
            termGrade = 'E';
            gradeRemark = 'Pass';
        }
        
        // Get term dates for attendance calculation
        const [termDates] = await connection.execute(`
            SELECT start_date, end_date 
            FROM academic_terms 
            WHERE term_name = ? AND academic_year_id = (
                SELECT id FROM academic_years WHERE year_name = ?
            )
        `, [term, academicYear]);
        
        let attendance = {
            present_days: 0,
            absent_days: 0,
            late_days: 0,
            excused_days: 0,
            total_days: 0
        };
        
        if (termDates.length > 0 && termDates[0].start_date && termDates[0].end_date) {
            // FIXED: Use the correct column names from your attendance_records table
            const [attendanceSummary] = await connection.execute(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                    COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                    COUNT(CASE WHEN (morning_status = 'excused' OR afternoon_status = 'excused') THEN 1 END) as excused_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? 
                AND date BETWEEN ? AND ?
            `, [student.id, termDates[0].start_date, termDates[0].end_date]);
            
            if (attendanceSummary.length > 0) {
                attendance = attendanceSummary[0];
            }
        }
        
        // Get teacher's comments
        const [comments] = await connection.execute(`
            SELECT comment, comment_by, comment_date 
            FROM student_comments 
            WHERE student_id = ? AND term = ? AND academic_year = ?
            ORDER BY comment_date DESC LIMIT 1
        `, [student.id, term, academicYear]);
        
        const teacherComment = comments.length > 0 ? comments[0] : {
            comment: 'No comment available',
            comment_by: 'Class Teacher',
            comment_date: new Date()
        };
        
        // Get principal's comments
        const [principalComments] = await connection.execute(`
            SELECT comment, comment_by, comment_date 
            FROM student_comments 
            WHERE student_id = ? AND term = ? AND academic_year = ? 
            AND (comment_by LIKE '%Principal%' OR comment_by LIKE '%Head%' OR comment_by LIKE '%Director%')
            ORDER BY comment_date DESC LIMIT 1
        `, [student.id, term, academicYear]);
        
        const principalComment = principalComments.length > 0 ? principalComments[0] : {
            comment: 'Keep up the good work!',
            comment_by: 'Principal',
            comment_date: new Date()
        };
        
        // Format scores with grades
        const formattedScores = scores.map(score => {
            const total = parseFloat(score.total_score) || 0;
            let grade = 'F';
            let remark = 'Fail';
            
            if (total >= 80) {
                grade = 'A';
                remark = 'Excellent';
            } else if (total >= 70) {
                grade = 'B';
                remark = 'Very Good';
            } else if (total >= 60) {
                grade = 'C';
                remark = 'Good';
            } else if (total >= 50) {
                grade = 'D';
                remark = 'Fair';
            } else if (total >= 40) {
                grade = 'E';
                remark = 'Pass';
            }
            
            return {
                ...score,
                grade: grade,
                remark: remark,
                formattedTotal: total.toFixed(1)
            };
        });
        
        res.render('report-card-term', {
            student: student,
            school: school,
            term: term,
            academicYear: academicYear,
            scores: formattedScores,
            termTotal: termTotal.toFixed(2),
            termAverage: termAverage.toFixed(2),
            termPercentage: termPercentage,
            termGrade: termGrade,
            gradeRemark: gradeRemark,
            subjectCount: subjectCount,
            attendance: attendance,
            teacherComment: teacherComment,
            principalComment: principalComment,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error generating term report card:', error);
        res.redirect('/report-cards?error=Failed to generate term report card');
    }
}

// Generate session report card
async function generateSessionReportCard(student, academicYear, school, res) {
    try {
        const connection = await getConnection();
        
        // Get scores for all terms in the academic year
        const [scores] = await connection.execute(`
            SELECT 
                s.name as subject_name,
                s.subject_code,
                sc.term,
                sc.test_score,
                sc.exam_score,
                COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
            FROM student_scores sc
            JOIN subjects s ON sc.subject_id = s.id
            WHERE sc.student_id = ? AND sc.academic_year = ?
            ORDER BY s.name, sc.term
        `, [student.id, academicYear]);
        
        // Organize scores by subject
        const subjectMap = {};
        scores.forEach(score => {
            if (!subjectMap[score.subject_name]) {
                subjectMap[score.subject_name] = {
                    subject_code: score.subject_code,
                    terms: {}
                };
            }
            subjectMap[score.subject_name].terms[score.term] = {
                test_score: score.test_score,
                exam_score: score.exam_score,
                total_score: score.total_score
            };
        });
        
        // Calculate subject averages and overall statistics
        let sessionTotal = 0;
        let subjectCount = 0;
        const subjectAverages = [];
        
        Object.keys(subjectMap).forEach(subjectName => {
            const subject = subjectMap[subjectName];
            let subjectTotal = 0;
            let termCount = 0;
            
            // Calculate average for each subject across all terms
            ['First Term', 'Second Term', 'Third Term'].forEach(term => {
                if (subject.terms[term]) {
                    subjectTotal += parseFloat(subject.terms[term].total_score || 0);
                    termCount++;
                }
            });
            
            const subjectAverage = termCount > 0 ? subjectTotal / termCount : 0;
            
            if (termCount > 0) {
                sessionTotal += subjectAverage;
                subjectCount++;
            }
            
            // Determine subject grade
            let subjectGrade = 'F';
            let subjectRemark = 'Fail';
            
            if (subjectAverage >= 80) {
                subjectGrade = 'A';
                subjectRemark = 'Excellent';
            } else if (subjectAverage >= 70) {
                subjectGrade = 'B';
                subjectRemark = 'Very Good';
            } else if (subjectAverage >= 60) {
                subjectGrade = 'C';
                subjectRemark = 'Good';
            } else if (subjectAverage >= 50) {
                subjectGrade = 'D';
                subjectRemark = 'Fair';
            } else if (subjectAverage >= 40) {
                subjectGrade = 'E';
                subjectRemark = 'Pass';
            }
            
            subjectAverages.push({
                subject_name: subjectName,
                subject_code: subject.subject_code,
                first_term: subject.terms['First Term'] ? parseFloat(subject.terms['First Term'].total_score).toFixed(1) : '-',
                second_term: subject.terms['Second Term'] ? parseFloat(subject.terms['Second Term'].total_score).toFixed(1) : '-',
                third_term: subject.terms['Third Term'] ? parseFloat(subject.terms['Third Term'].total_score).toFixed(1) : '-',
                average: subjectAverage.toFixed(1),
                grade: subjectGrade,
                remark: subjectRemark
            });
        });
        
        // Calculate overall session average
        const sessionAverage = subjectCount > 0 ? sessionTotal / subjectCount : 0;
        const sessionPercentage = ((sessionAverage / 100) * 100).toFixed(2);
        
        // Determine overall grade
        let sessionGrade = 'F';
        let sessionRemark = 'Fail';
        
        if (sessionAverage >= 80) {
            sessionGrade = 'A';
            sessionRemark = 'Excellent';
        } else if (sessionAverage >= 70) {
            sessionGrade = 'B';
            sessionRemark = 'Very Good';
        } else if (sessionAverage >= 60) {
            sessionGrade = 'C';
            sessionRemark = 'Good';
        } else if (sessionAverage >= 50) {
            sessionGrade = 'D';
            sessionRemark = 'Fair';
        } else if (sessionAverage >= 40) {
            sessionGrade = 'E';
            sessionRemark = 'Pass';
        }
        
        // Determine promotion status
        let promotionStatus = 'Repeat';
        let promotionAction = 'repeat';
        let promotionClass = 'danger';
        
        if (sessionAverage >= 45) {
            promotionStatus = 'Promote';
            promotionAction = 'promote';
            promotionClass = 'success';
        }
        
        // Get academic year dates for attendance calculation
        const [yearDates] = await connection.execute(`
            SELECT start_date, end_date 
            FROM academic_years 
            WHERE year_name = ?
        `, [academicYear]);
        
        let attendance = {
            present_days: 0,
            absent_days: 0,
            late_days: 0,
            excused_days: 0,
            total_days: 0
        };
        
        if (yearDates.length > 0 && yearDates[0].start_date && yearDates[0].end_date) {
            // FIXED: Use the correct column names from your attendance_records table
            const [attendanceSummary] = await connection.execute(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                    COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                    COUNT(CASE WHEN (morning_status = 'excused' OR afternoon_status = 'excused') THEN 1 END) as excused_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? 
                AND date BETWEEN ? AND ?
            `, [student.id, yearDates[0].start_date, yearDates[0].end_date]);
            
            if (attendanceSummary.length > 0) {
                attendance = attendanceSummary[0];
            }
        }
        
        // Get teacher's comments for the session
        const [comments] = await connection.execute(`
            SELECT comment, comment_by, comment_date 
            FROM student_comments 
            WHERE student_id = ? AND academic_year = ?
            ORDER BY comment_date DESC LIMIT 1
        `, [student.id, academicYear]);
        
        const teacherComment = comments.length > 0 ? comments[0] : {
            comment: 'No comment available',
            comment_by: 'Class Teacher',
            comment_date: new Date()
        };
        
        // Get principal's comments for the session
        const [principalComments] = await connection.execute(`
            SELECT comment, comment_by, comment_date 
            FROM student_comments 
            WHERE student_id = ? AND academic_year = ? 
            AND (comment_by LIKE '%Principal%' OR comment_by LIKE '%Head%' OR comment_by LIKE '%Director%')
            ORDER BY comment_date DESC LIMIT 1
        `, [student.id, academicYear]);
        
        const principalComment = principalComments.length > 0 ? principalComments[0] : {
            comment: promotionStatus === 'Promote' ? 'Congratulations on your promotion!' : 'Please work harder next session.',
            comment_by: 'Principal',
            comment_date: new Date()
        };
        
        res.render('report-card-session', {
            student: student,
            school: school,
            academicYear: academicYear,
            subjects: subjectAverages,
            sessionAverage: sessionAverage.toFixed(2),
            sessionPercentage: sessionPercentage,
            sessionGrade: sessionGrade,
            sessionRemark: sessionRemark,
            promotionStatus: promotionStatus,
            promotionAction: promotionAction,
            promotionClass: promotionClass,
            subjectCount: subjectCount,
            attendance: attendance,
            teacherComment: teacherComment,
            principalComment: principalComment,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error generating session report card:', error);
        res.redirect('/report-cards?error=Failed to generate session report card');
    }
}

// POST route to add teacher comments
app.post('/add-comment', authenticate, async (req, res) => {
    const { studentId, term, academicYear, comment, commentType } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!studentId || !term || !academicYear || !comment) {
            return res.status(400).json({
                success: false,
                error: 'Student, Term, Academic Year, and Comment are required'
            });
        }
        
        // Get user info from session
        const commentBy = req.session.username || 'Unknown Teacher';
        const commentByUserId = req.session.userId || null;
        
        // Insert comment
        await connection.execute(`
            INSERT INTO student_comments 
            (student_id, term, academic_year, comment, comment_by, comment_by_user_id, comment_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [studentId, term, academicYear, comment, commentBy, commentByUserId, commentType || 'general']);
        
        res.json({
            success: true,
            message: 'Comment added successfully'
        });
        
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add comment: ' + error.message
        });
    }
});

// API to get students for a class (for AJAX loading)
app.get('/api/students-by-class/:classId', authenticate, async (req, res) => {
    const { classId } = req.params;
    
    try {
        const connection = await getConnection();
        
        const [students] = await connection.execute(`
            SELECT id, firstName, middleName, lastName, admission_number
            FROM students 
            WHERE classId = ? 
            ORDER BY firstName, lastName
        `, [classId]);
        
        res.json({
            success: true,
            students: students
        });
        
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch students'
        });
    }
});

// Salary Management Routes
// GET route to display salary dashboard
app.get('/salary-management', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get summary statistics
        const [salarySummary] = await connection.execute(`
            SELECT 
                COUNT(*) as total_employees,
                SUM(CASE WHEN employee_type = 'teacher' THEN 1 ELSE 0 END) as total_teachers,
                SUM(CASE WHEN employee_type = 'staff' THEN 1 ELSE 0 END) as total_staff,
                COALESCE(SUM(net_salary), 0) as total_paid,
                COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_count,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count
            FROM salary_payments 
            WHERE month = DATE_FORMAT(NOW(), '%Y-%m')
        `);
        
        // Get recent payments
        const [recentPayments] = await connection.execute(`
            SELECT sp.*, 
                   COALESCE(t.firstName, s.firstName) as first_name,
                   COALESCE(t.lastName, s.lastName) as last_name,
                   COALESCE(t.designation, s.position) as position
            FROM salary_payments sp
            LEFT JOIN teachers t ON sp.employee_id = t.id AND sp.employee_type = 'teacher'
            LEFT JOIN staff s ON sp.employee_id = s.id AND sp.employee_type = 'staff'
            ORDER BY sp.created_at DESC 
            LIMIT 10
        `);
        
        // Get current month and year
        const currentMonth = moment().format('YYYY-MM');
        
        res.render('salary-dashboard', {
            summary: salarySummary[0],
            recentPayments: recentPayments,
            currentMonth: currentMonth,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading salary dashboard:', error);
        res.render('salary-dashboard', {
            summary: {},
            recentPayments: [],
            currentMonth: moment().format('YYYY-MM'),
            error: 'Failed to load salary dashboard'
        });
    }
});

// GET route to display salary structures
// GET route to display salary structures
app.get('/salary-structures', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        const [structures] = await connection.execute(`
            SELECT * FROM salary_structures 
            ORDER BY position, level
        `);
        
        res.render('salary-structures', {
            structures: structures,
            error: null,
            success: req.session.success || null
        });
        
        // Clear success message
        delete req.session.success;
        
    } catch (error) {
        console.error('Error loading salary structures:', error);
        res.render('salary-structures', {
            structures: [],
            error: 'Failed to load salary structures'
        });
    }
});

// GET route to delete salary structure
app.get('/delete-salary-structure/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Check if structure is being used
        const [usage] = await connection.execute(`
            SELECT COUNT(*) as count FROM salary_payments 
            WHERE employee_type = 'teacher' AND designation = (
                SELECT position FROM salary_structures WHERE id = ?
            )
            UNION ALL
            SELECT COUNT(*) as count FROM salary_payments 
            WHERE employee_type = 'staff' AND position = (
                SELECT position FROM salary_structures WHERE id = ?
            )
        `, [req.params.id, req.params.id]);
        
        if (usage[0].count > 0 || usage[1].count > 0) {
            req.session.error = 'Cannot delete salary structure. It is being used by employees.';
            return res.redirect('/salary-structures');
        }
        
        await connection.execute(
            'DELETE FROM salary_structures WHERE id = ?',
            [req.params.id]
        );
        
        req.session.success = 'Salary structure deleted successfully';
        res.redirect('/salary-structures');
        
    } catch (error) {
        console.error('Error deleting salary structure:', error);
        req.session.error = 'Failed to delete salary structure';
        res.redirect('/salary-structures');
    }
});



// GET route to display add salary structure form
app.get('/add-salary-structure', authenticate, (req, res) => {
    res.render('add-salary-structure', {
        formData: {},
        error: null
    });
});

// POST route to add salary structure
app.post('/add-salary-structure', uploadNoFile.none(), async (req, res) => {
    const {
        position,
        level,
        basic_salary,
        housing_allowance,
        transport_allowance,
        medical_allowance,
        other_allowance,
        tax_percentage,
        pension_percentage,
        is_active,
        description
    } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!position || !level || !basic_salary) {
            return res.render('add-salary-structure', {
                formData: req.body,
                error: 'Position, Level, and Basic Salary are required fields'
            });
        }
        
        // Check if structure already exists
        const [existing] = await connection.execute(`
            SELECT id FROM salary_structures 
            WHERE position = ? AND level = ?
        `, [position, level]);
        
        if (existing.length > 0) {
            return res.render('add-salary-structure', {
                formData: req.body,
                error: 'Salary structure already exists for this position and level'
            });
        }
        
        // Insert new salary structure
        await connection.execute(`
            INSERT INTO salary_structures 
            (position, level, basic_salary, housing_allowance, transport_allowance, 
             medical_allowance, other_allowance, tax_percentage, pension_percentage,
             is_active, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            position,
            level,
            parseFloat(basic_salary) || 0,
            parseFloat(housing_allowance) || 0,
            parseFloat(transport_allowance) || 0,
            parseFloat(medical_allowance) || 0,
            parseFloat(other_allowance) || 0,
            parseFloat(tax_percentage) || 0,
            parseFloat(pension_percentage) || 0,
            is_active === '1' ? 1 : 0,
            description || null
        ]);
        
        req.session.success = 'Salary structure added successfully';
        res.redirect('/salary-structures');
        
    } catch (error) {
        console.error('Error adding salary structure:', error);
        res.render('add-salary-structure', {
            formData: req.body,
            error: 'Failed to add salary structure: ' + error.message
        });
    }
});

// GET route to process salaries
// GET route to process salaries
app.get('/process-salaries', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { month, showProcessed } = req.query;
        
        const currentMonth = month || moment().format('YYYY-MM');
        
        // Get all teachers with their salary structures
        const [teachers] = await connection.execute(`
            SELECT 
                t.*, 
                COALESCE(ss.basic_salary, 0) as basic_salary,
                COALESCE(ss.housing_allowance, 0) as housing_allowance,
                COALESCE(ss.transport_allowance, 0) as transport_allowance,
                COALESCE(ss.medical_allowance, 0) as medical_allowance,
                COALESCE(ss.other_allowance, 0) as other_allowance,
                COALESCE(ss.tax_percentage, 0) as tax_percentage,
                COALESCE(ss.pension_percentage, 0) as pension_percentage
            FROM teachers t
            LEFT JOIN salary_structures ss ON t.designation = ss.position 
        `);
        
        // Get all staff with their salary structures
        const [staff] = await connection.execute(`
            SELECT 
                s.*, 
                COALESCE(ss.basic_salary, 0) as basic_salary,
                COALESCE(ss.housing_allowance, 0) as housing_allowance,
                COALESCE(ss.transport_allowance, 0) as transport_allowance,
                COALESCE(ss.medical_allowance, 0) as medical_allowance,
                COALESCE(ss.other_allowance, 0) as other_allowance,
                COALESCE(ss.tax_percentage, 0) as tax_percentage,
                COALESCE(ss.pension_percentage, 0) as pension_percentage
            FROM staff s
            LEFT JOIN salary_structures ss ON s.position = ss.position 
        `);
        
        // Check which employees already have salaries processed for this month
        const [processedSalaries] = await connection.execute(`
            SELECT employee_id, employee_type 
            FROM salary_payments 
            WHERE month = ?
        `, [currentMonth]);
        
        const processedMap = {};
        processedSalaries.forEach(item => {
            processedMap[`${item.employee_type}_${item.employee_id}`] = true;
        });
        
        // Calculate total amounts for display
        const calculateEmployeeSalary = (employee) => {
            return (employee.basic_salary || 0) + 
                   (employee.housing_allowance || 0) + 
                   (employee.transport_allowance || 0) + 
                   (employee.medical_allowance || 0) + 
                   (employee.other_allowance || 0);
        };
        
        const calculateTotalAmount = (employees, processedMap, employeeType) => {
            return employees.reduce((total, employee) => {
                if (!processedMap[`${employeeType}_${employee.id}`]) {
                    return total + calculateEmployeeSalary(employee);
                }
                return total;
            }, 0);
        };
        
        const teacherTotalAmount = calculateTotalAmount(teachers, processedMap, 'teacher');
        const staffTotalAmount = calculateTotalAmount(staff, processedMap, 'staff');
        
        res.render('process-salaries', {
            teachers: teachers,
            staff: staff,
            processedMap: processedMap,
            currentMonth: currentMonth,
            showProcessed: showProcessed === 'on',
            teacherTotalAmount: teacherTotalAmount,
            staffTotalAmount: staffTotalAmount,
            calculateEmployeeSalary: calculateEmployeeSalary,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading process salaries page:', error);
        res.render('process-salaries', {
            teachers: [],
            staff: [],
            processedMap: {},
            currentMonth: moment().format('YYYY-MM'),
            showProcessed: false,
            teacherTotalAmount: 0,
            staffTotalAmount: 0,
            error: 'Failed to load process salaries page'
        });
    }
});

// POST route to process individual salary
app.post('/process-salary', uploadNoFile.none(), async (req, res) => {
    const {
        employee_id,
        employee_type,
        month
    } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!employee_id || !employee_type || !month) {
            return res.status(400).json({
                success: false,
                error: 'Employee ID, Employee Type, and Month are required fields'
            });
        }
        
        // Validate month format (should be YYYY-MM)
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({
                success: false,
                error: 'Month must be in YYYY-MM format (e.g., 2024-01)'
            });
        }
        
        let employee;
        if (employee_type === 'teacher') {
            // Get teacher with salary structure (simplified JOIN)
            const [teachers] = await connection.execute(`
                SELECT 
                    t.*, 
                    COALESCE(ss.basic_salary, 0) as basic_salary,
                    COALESCE(ss.housing_allowance, 0) as housing_allowance,
                    COALESCE(ss.transport_allowance, 0) as transport_allowance,
                    COALESCE(ss.medical_allowance, 0) as medical_allowance,
                    COALESCE(ss.other_allowance, 0) as other_allowance,
                    COALESCE(ss.tax_percentage, 0) as tax_percentage,
                    COALESCE(ss.pension_percentage, 0) as pension_percentage
                FROM teachers t
                LEFT JOIN salary_structures ss ON t.designation = ss.position
                WHERE t.id = ?
            `, [employee_id]);
            
            if (teachers.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Teacher not found'
                });
            }
            employee = teachers[0];
        } else {
            // Get staff with salary structure (simplified JOIN)
            const [staff] = await connection.execute(`
                SELECT 
                    s.*, 
                    COALESCE(ss.basic_salary, 0) as basic_salary,
                    COALESCE(ss.housing_allowance, 0) as housing_allowance,
                    COALESCE(ss.transport_allowance, 0) as transport_allowance,
                    COALESCE(ss.medical_allowance, 0) as medical_allowance,
                    COALESCE(ss.other_allowance, 0) as other_allowance,
                    COALESCE(ss.tax_percentage, 0) as tax_percentage,
                    COALESCE(ss.pension_percentage, 0) as pension_percentage
                FROM staff s
                LEFT JOIN salary_structures ss ON s.position = ss.position
                WHERE s.id = ?
            `, [employee_id]);
            
            if (staff.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Staff member not found'
                });
            }
            employee = staff[0];
        }
        
        // Use salary structure values
        const basic = parseFloat(employee.basic_salary) || 0;
        const housing = parseFloat(employee.housing_allowance) || 0;
        const transport = parseFloat(employee.transport_allowance) || 0;
        const medical = parseFloat(employee.medical_allowance) || 0;
        const otherAllowance = parseFloat(employee.other_allowance) || 0;
        const taxPercent = parseFloat(employee.tax_percentage) || 0;
        const pensionPercent = parseFloat(employee.pension_percentage) || 0;
        
        // Calculate gross salary
        const grossSalary = basic + housing + transport + medical + otherAllowance;
        
        // Calculate deductions
        const taxAmount = (grossSalary * taxPercent) / 100;
        const pensionAmount = (grossSalary * pensionPercent) / 100;
        
        // Calculate net salary
        const netSalary = grossSalary - taxAmount - pensionAmount;
        
        // Get user ID from session
        const createdBy = req.session.userId || 1;
        
        // Start transaction
        await connection.beginTransaction();
        
        try {
            // Insert salary payment
            await connection.execute(`
                INSERT INTO salary_payments 
                (employee_id, employee_type, month, basic_salary, housing_allowance, 
                 transport_allowance, medical_allowance, other_allowance, gross_salary,
                 tax_amount, pension_amount, net_salary, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                employee_id,
                employee_type,
                month,
                basic,
                housing,
                transport,
                medical,
                otherAllowance,
                grossSalary,
                taxAmount,
                pensionAmount,
                netSalary,
                createdBy
            ]);
            
            await connection.commit();
            
            res.json({
                success: true,
                message: 'Salary processed successfully'
            });
            
        } catch (error) {
            await connection.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('Error processing salary:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process salary: ' + error.message
        });
    }
});
// GET route to view salary payments
app.get('/salary-payments', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { month, employee_type, status } = req.query;
        
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (month) {
            whereClause += ' AND sp.month = ?';
            queryParams.push(month);
        }
        
        if (employee_type) {
            whereClause += ' AND sp.employee_type = ?';
            queryParams.push(employee_type);
        }
        
        if (status) {
            whereClause += ' AND sp.status = ?';
            queryParams.push(status);
        }
        
        const [payments] = await connection.execute(`
            SELECT sp.*, 
                   COALESCE(t.firstName, s.firstName) as first_name,
                   COALESCE(t.lastName, s.lastName) as last_name,
                   COALESCE(t.designation, s.position) as position
            FROM salary_payments sp
            LEFT JOIN teachers t ON sp.employee_id = t.id AND sp.employee_type = 'teacher'
            LEFT JOIN staff s ON sp.employee_id = s.id AND sp.employee_type = 'staff'
            ${whereClause}
            ORDER BY sp.month DESC, sp.created_at DESC
        `, queryParams);
        
        // Get distinct months for filter
        const [months] = await connection.execute(`
            SELECT DISTINCT month 
            FROM salary_payments 
            ORDER BY month DESC
        `);
        
        res.render('salary-payments', {
            payments: payments,
            months: months,
            filters: {
                month: month || '',
                employee_type: employee_type || '',
                status: status || ''
            },
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading salary payments:', error);
        res.render('salary-payments', {
            payments: [],
            months: [],
            filters: {},
            error: 'Failed to load salary payments'
        });
    }
});

// POST route to update payment status
// POST route to update payment status - FIXED
app.post('/update-salary-status', uploadNoFile.none(), async (req, res) => {
    const { payment_id, status, payment_date, payment_method, notes } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Handle undefined values by converting them to null
        const processedPaymentDate = payment_date || null;
        const processedPaymentMethod = payment_method || null;
        const processedNotes = notes || null;
        
        await connection.execute(`
            UPDATE salary_payments 
            SET status = ?, payment_date = ?, payment_method = ?, notes = ?
            WHERE id = ?
        `, [status, processedPaymentDate, processedPaymentMethod, processedNotes, payment_id]);
        
        res.json({
            success: true,
            message: 'Payment status updated successfully'
        });
        
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update payment status: ' + error.message
        });
    }
});

// GET route to view salary slip
app.get('/salary-slip/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const paymentId = req.params.id;
        
        const [payment] = await connection.execute(`
            SELECT sp.*, 
                   COALESCE(t.firstName, s.firstName) as first_name,
                   COALESCE(t.lastName, s.lastName) as last_name,
                   COALESCE(t.designation, s.position) as position,
                   COALESCE(t.email, s.email) as email,
                   COALESCE(t.mobileNumber, s.phone) as phone,
                   sch.name as school_name,
                   sch.address as school_address,
                   sch.phone as school_phone
            FROM salary_payments sp
            LEFT JOIN teachers t ON sp.employee_id = t.id AND sp.employee_type = 'teacher'
            LEFT JOIN staff s ON sp.employee_id = s.id AND sp.employee_type = 'staff'
            CROSS JOIN school_info sch
            WHERE sp.id = ?
            LIMIT 1
        `, [paymentId]);
        
        if (payment.length === 0) {
            return res.status(404).send('Salary slip not found');
        }
        
        res.render('salary-slip', {
            payment: payment[0],
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error generating salary slip:', error);
        res.status(500).send('Error generating salary slip');
    }
});

// GET route to manage salary adjustments
app.get('/salary-adjustments', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { employee_type, status } = req.query;
        
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (employee_type) {
            whereClause += ' AND sa.employee_type = ?';
            queryParams.push(employee_type);
        }
        
        if (status) {
            whereClause += ' AND sa.status = ?';
            queryParams.push(status);
        }
        
        const [adjustments] = await connection.execute(`
            SELECT sa.*, 
                   COALESCE(t.firstName, s.firstName) as first_name,
                   COALESCE(t.lastName, s.lastName) as last_name,
                   COALESCE(t.designation, s.position) as position
            FROM salary_adjustments sa
            LEFT JOIN teachers t ON sa.employee_id = t.id AND sa.employee_type = 'teacher'
            LEFT JOIN staff s ON sa.employee_id = s.id AND sa.employee_type = 'staff'
            ${whereClause}
            ORDER BY sa.effective_date DESC
        `, queryParams);
        
        res.render('salary-adjustments', {
            adjustments: adjustments,
            filters: {
                employee_type: employee_type || '',
                status: status || ''
            },
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading salary adjustments:', error);
        res.render('salary-adjustments', {
            adjustments: [],
            filters: {},
            error: 'Failed to load salary adjustments'
        });
    }
});

// POST route to add salary adjustment
app.post('/add-salary-adjustment', uploadNoFile.none(), async (req, res) => {
    const {
        employee_id,
        employee_type,
        adjustment_type,
        amount,
        description,
        effective_date,
        is_recurring,
        recurrence_months
    } = req.body;
    
    try {
        const connection = await getConnection();
        
        await connection.execute(`
            INSERT INTO salary_adjustments 
            (employee_id, employee_type, adjustment_type, amount, description, 
             effective_date, is_recurring, recurrence_months, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            employee_id,
            employee_type,
            adjustment_type,
            parseFloat(amount),
            description,
            effective_date,
            is_recurring === 'true',
            parseInt(recurrence_months) || 0,
            req.session.userId
        ]);
        
        res.json({
            success: true,
            message: 'Salary adjustment added successfully'
        });
        
    } catch (error) {
        console.error('Error adding salary adjustment:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add salary adjustment'
        });
    }
});

// GET route to fetch employees for adjustments
app.get('/get-employees', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { type } = req.query;
        
        if (type === 'teacher') {
            const [teachers] = await connection.execute(`
                SELECT id, firstName as first_name, lastName as last_name, designation as position 
                FROM teachers 
                ORDER BY firstName, lastName
            `);
            res.json(teachers);
        } else if (type === 'staff') {
            const [staff] = await connection.execute(`
                SELECT id, firstName as first_name, lastName as last_name, position 
                FROM staff 
                ORDER BY firstName, lastName
            `);
            res.json(staff);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json([]);
    }
});

// GET route to display expenses page - FIXED
app.get('/expenses', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { startDate, endDate, category, status, page = 1, limit = 50 } = req.query;
        
        // Build WHERE clause
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (startDate) {
            whereClause += ' AND e.expense_date >= ?';
            queryParams.push(startDate);
        }
        
        if (endDate) {
            whereClause += ' AND e.expense_date <= ?';
            queryParams.push(endDate);
        }
        
        if (category && category !== 'all') {
            whereClause += ' AND e.category = ?';
            queryParams.push(category);
        }
        
        if (status && status !== 'all') {
            whereClause += ' AND e.status = ?';
            queryParams.push(status);
        }
        
        // Get total count for pagination
        const [totalCountResult] = await connection.execute(
            `SELECT COUNT(*) as total FROM expenses e ${whereClause}`,
            queryParams
        );
        
        const totalCount = totalCountResult[0].total;
        const totalPages = Math.ceil(totalCount / limit);
        const offset = (page - 1) * limit;
        
        // Get expenses with filters
        const [expenses] = await connection.execute(
            `SELECT e.*, 
                    u.username as created_by_name,
                    a.username as approved_by_name
             FROM expenses e
             LEFT JOIN users u ON e.created_by = u.id
             LEFT JOIN users a ON e.approved_by = a.id
             ${whereClause}
             ORDER BY e.expense_date DESC, e.created_at DESC
             LIMIT ? OFFSET ?`,
            [...queryParams, parseInt(limit), parseInt(offset)]
        );
        
        // Get expense categories
        const [categories] = await connection.execute(
            'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
        );
        
        // Get total expenses amount (excluding salaries)
        const [totalExpensesResult] = await connection.execute(
            `SELECT SUM(amount) as total FROM expenses WHERE status = 'approved'`
        );
        const totalRegularExpenses = totalExpensesResult[0].total || 0;
        
        // Get total salary expenses (paid salaries)
        const [totalSalaryExpensesResult] = await connection.execute(
            `SELECT SUM(net_salary) as total FROM salary_payments WHERE status = 'paid'`
        );
        const totalSalaryExpenses = totalSalaryExpensesResult[0].total || 0;
        
        // Get total fees collected
        const [totalFeesResult] = await connection.execute(
            `SELECT SUM(amountPaid) as total FROM fees WHERE status IN ('paid', 'partial')`
        );
        const totalFees = totalFeesResult[0].total || 0;
        
        // Calculate balance (fees - all expenses including salaries)
        const totalAllExpenses = totalRegularExpenses + totalSalaryExpenses;
        const balance = totalFees - totalAllExpenses;
        
        res.render('expenses', {
            expenses,
            categories,
            totalExpenses: totalAllExpenses, // Now includes salaries
            totalRegularExpenses, // Regular expenses only
            totalSalaryExpenses, // Salary expenses only
            totalFees,
            balance,
            filters: {
                startDate: startDate || '',
                endDate: endDate || '',
                category: category || 'all',
                status: status || 'all'
            },
            currentPage: parseInt(page),
            totalPages,
            totalCount,
            limit: parseInt(limit),
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading expenses:', error);
        res.render('expenses', {
            expenses: [],
            categories: [],
            totalExpenses: 0,
            totalRegularExpenses: 0,
            totalSalaryExpenses: 0,
            totalFees: 0,
            balance: 0,
            filters: {},
            currentPage: 1,
            totalPages: 1,
            totalCount: 0,
            error: 'Failed to load expenses'
        });
    }
});

// GET route to display add expense form
app.get('/add-expense', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        const [categories] = await connection.execute(
            'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
        );
        
        res.render('add-expense', {
            categories,
            formData: {},
            error: null
        });
        
    } catch (error) {
        console.error('Error loading add expense form:', error);
        res.render('add-expense', {
            categories: [],
            formData: {},
            error: 'Failed to load form'
        });
    }
});

// POST route to add new expense
app.post('/add-expense', uploadNoFile.none(), async (req, res) => {
    const {
        expense_date,
        category,
        description,
        amount,
        payment_method,
        vendor,
        reference_number
    } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!expense_date || !category || !description || !amount) {
            const [categories] = await connection.execute(
                'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
            );
            
            return res.render('add-expense', {
                categories,
                formData: req.body,
                error: 'Date, category, description, and amount are required fields'
            });
        }
        
        // Validate amount
        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
            const [categories] = await connection.execute(
                'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
            );
            
            return res.render('add-expense', {
                categories,
                formData: req.body,
                error: 'Please enter a valid amount'
            });
        }
        
        // Insert new expense
        await connection.execute(
            `INSERT INTO expenses 
             (expense_date, category, description, amount, payment_method, vendor, reference_number, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                expense_date,
                category,
                description,
                amountValue,
                payment_method || 'Cash',
                vendor || null,
                reference_number || null,
                req.session.userId
            ]
        );
        
        req.session.success = 'Expense added successfully';
        res.redirect('/expenses');
        
    } catch (error) {
        console.error('Error adding expense:', error);
        
        const connection = await getConnection();
        const [categories] = await connection.execute(
            'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
        );
        
        res.render('add-expense', {
            categories,
            formData: req.body,
            error: 'Failed to add expense: ' + error.message
        });
    }
});

// GET route to approve/reject expense
app.get('/update-expense-status/:id/:status', authenticate, async (req, res) => {
    const { id, status } = req.params;
    
    try {
        const connection = await getConnection();
        
        if (status !== 'approved' && status !== 'rejected') {
            req.session.error = 'Invalid status';
            return res.redirect('/expenses');
        }
        
        await connection.execute(
            'UPDATE expenses SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?',
            [status, req.session.userId, id]
        );
        
        req.session.success = `Expense ${status} successfully`;
        res.redirect('/expenses');
        
    } catch (error) {
        console.error('Error updating expense status:', error);
        req.session.error = 'Failed to update expense status';
        res.redirect('/expenses');
    }
});

// GET route to delete expense
app.get('/delete-expense/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        await connection.execute(
            'DELETE FROM expenses WHERE id = ?',
            [req.params.id]
        );
        
        req.session.success = 'Expense deleted successfully';
        res.redirect('/expenses');
        
    } catch (error) {
        console.error('Error deleting expense:', error);
        req.session.error = 'Failed to delete expense';
        res.redirect('/expenses');
    }
});

// GET route for financial reports
// GET route for financial reports - UPDATED
app.get('/financial-reports', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { startDate, endDate } = req.query;
        
        // Default to current month if no dates provided
        const defaultStartDate = startDate || moment().startOf('month').format('YYYY-MM-DD');
        const defaultEndDate = endDate || moment().endOf('month').format('YYYY-MM-DD');
        
        // Get total fees collected
        const [feesResult] = await connection.execute(
            `SELECT 
                SUM(amountPaid) as total,
                COUNT(*) as count,
                academicYear,
                term
             FROM fees 
             WHERE paymentDate BETWEEN ? AND ?
             GROUP BY academicYear, term
             ORDER BY academicYear DESC, term`,
            [defaultStartDate, defaultEndDate]
        );
        
        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        

        // Get total expenses (excluding salaries)
        const [expensesResult] = await connection.execute(
            `SELECT 
                SUM(amount) as total,
                COUNT(*) as count,
                category
             FROM expenses 
             WHERE expense_date BETWEEN ? AND ? AND status = 'approved'
             GROUP BY category
             ORDER BY total DESC`,
            [defaultStartDate, defaultEndDate]
        );
        
        // Get total salary expenses
        const [salaryExpensesResult] = await connection.execute(
            `SELECT 
                SUM(net_salary) as total,
                COUNT(*) as count,
                'Salaries' as category
             FROM salary_payments 
             WHERE payment_date BETWEEN ? AND ? AND status = 'paid'`,
            [defaultStartDate, defaultEndDate]
        );
        
        // Combine regular expenses and salary expenses
        const allExpenses = [...expensesResult];
        if (salaryExpensesResult[0].total) {
            allExpenses.push(salaryExpensesResult[0]);
        }
        
        // Get daily financial summary (including salaries)
        const [dailySummary] = await connection.execute(
            `SELECT 
                DATE(paymentDate) as date,
                'Revenue' as type,
                SUM(amountPaid) as amount
             FROM fees 
             WHERE paymentDate BETWEEN ? AND ?
             GROUP BY DATE(paymentDate)
             
             UNION ALL
             
             SELECT 
                expense_date as date,
                'Expense' as type,
                SUM(amount) as amount
             FROM expenses 
             WHERE expense_date BETWEEN ? AND ? AND status = 'approved'
             GROUP BY expense_date
             
             UNION ALL
             
             SELECT 
                payment_date as date,
                'Salary' as type,
                SUM(net_salary) as amount
             FROM salary_payments 
             WHERE payment_date BETWEEN ? AND ? AND status = 'paid'
             GROUP BY payment_date
             
             ORDER BY date DESC`,
            [defaultStartDate, defaultEndDate, defaultStartDate, defaultEndDate, defaultStartDate, defaultEndDate]
        );
        
        // Calculate totals
        const totalRevenue = feesResult.reduce((sum, item) => sum + parseFloat(item.total || 0), 0);
        const totalRegularExpenses = expensesResult.reduce((sum, item) => sum + parseFloat(item.total || 0), 0);
        const totalSalaryExpenses = salaryExpensesResult[0].total || 0;
        const totalExpenses = totalRegularExpenses + totalSalaryExpenses;
        const netBalance = totalRevenue - totalExpenses;
        
        res.render('financial-reports', {
            fees: feesResult,
            expenses: allExpenses, // Includes salaries
            dailySummary,
            totalRevenue,
            totalExpenses,
            totalRegularExpenses,
            totalSalaryExpenses,
            netBalance,
            filters: {
                startDate: defaultStartDate,
                endDate: defaultEndDate
            },
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading financial reports:', error);
        res.render('financial-reports', {
            fees: [],
            expenses: [],
            dailySummary: [],
            totalRevenue: 0,
            totalExpenses: 0,
            totalRegularExpenses: 0,
            totalSalaryExpenses: 0,
            netBalance: 0,
            filters: {},
            error: 'Failed to load financial reports'
        });
    }
});

// Add this function to calculate next academic year and term
function getNextAcademicInfo(currentTerm, currentAcademicYear) {
    let nextTerm = '';
    let nextAcademicYear = '';
    
    if (currentTerm === 'First Term') {
        nextTerm = 'Second Term';
        nextAcademicYear = currentAcademicYear;
    } else if (currentTerm === 'Second Term') {
        nextTerm = 'Third Term';
        nextAcademicYear = currentAcademicYear;
    } else if (currentTerm === 'Third Term') {
        nextTerm = 'First Term';
        // Extract years and increment (format: "2023-2024")
        const years = currentAcademicYear.split('-');
        if (years.length === 2) {
            const nextStartYear = parseInt(years[1]);
            const nextEndYear = nextStartYear + 1;
            nextAcademicYear = `${nextStartYear}-${nextEndYear}`;
        } else {
            // Fallback if format is unexpected
            const currentYear = new Date().getFullYear();
            nextAcademicYear = `${currentYear}-${currentYear + 1}`;
        }
    }
    
    return { nextTerm, nextAcademicYear };
}

app.get('/class-bill/print/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const billId = req.params.id;
        
        // Get the class bill
        const [bills] = await connection.execute(
            'SELECT * FROM class_bills WHERE id = ?',
            [billId]
        );
        
        if (bills.length === 0) {
            return res.status(404).send('Bill not found');
        }
        
        const bill = bills[0];
        
        // Get school information
        const [schoolInfo] = await connection.execute(
            'SELECT * FROM school_info LIMIT 1'
        );
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };
        
        res.render('class-bill-print', {
            bill: bill,
            school: school,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading class bill:', error);
        res.status(500).send('Error loading bill');
    }
});

// Route to display printable book list
app.get('/books/print', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { academicYear, classLevel, department, subject } = req.query;
        
        // Build WHERE clause based on filters
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (academicYear && academicYear !== 'all') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }
        
        if (classLevel && classLevel !== 'all') {
            whereClause += ' AND class_level = ?';
            queryParams.push(classLevel);
        }
        
        if (department && department !== 'all') {
            whereClause += ' AND department = ?';
            queryParams.push(department);
        }
        
        if (subject && subject !== 'all') {
            whereClause += ' AND subject LIKE ?';
            queryParams.push(`%${subject}%`);
        }
        
        // Get books based on filters
        const [books] = await connection.execute(
            `SELECT * FROM book_lists ${whereClause} ORDER BY subject, title`,
            queryParams
        );
        
        // Get school information
        const [schoolInfo] = await connection.execute(
            'SELECT * FROM school_info LIMIT 1'
        );
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };
        
        // Get available academic years for filter
        const [academicYears] = await connection.execute(
            'SELECT DISTINCT academic_year FROM book_lists ORDER BY academic_year DESC'
        );
        
        res.render('book-list-print', {
            books: books,
            school: school,
            academicYears: academicYears,
            filters: {
                academicYear: academicYear || 'all',
                classLevel: classLevel || 'all',
                department: department || 'all',
                subject: subject || 'all'
            },
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading book list:', error);
        res.status(500).send('Error loading book list');
    }
});


// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    res.status(500).send('Something went wrong!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
