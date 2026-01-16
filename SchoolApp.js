const express = require('express');
const { Pool } = require('pg');
const argon2 = require('argon2');
const session = require('express-session');
const path = require('path');
const moment = require('moment');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ 
    secret: process.env.SESSION_SECRET || 'your-secret-key', 
    resave: false, 
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views', 'school_app'));

// Serve static files (CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Ensure upload directories exist
const ensureUploadDirectories = () => {
    const directories = [
        path.join(__dirname, 'public/images/teachers'),
        path.join(__dirname, 'public/images/staff'),
        path.join(__dirname, 'public/images/library')
    ];
    
    directories.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
};

// Call this function to create directories
ensureUploadDirectories();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'public/images/teachers');
        // Create directory if it doesn't exist
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// ========== FIXED DATABASE CONFIGURATION ==========
// PostgreSQL connection pool - Works for both local and Render
let poolConfig;

if (process.env.DATABASE_URL) {
    // PRODUCTION (Render): Use DATABASE_URL with SSL
    console.log('🔗 Using Render PostgreSQL database (SSL enabled)');
    poolConfig = {
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    };
} else {
    // DEVELOPMENT (Local): Use local config WITHOUT SSL
    console.log('💻 Using local PostgreSQL database (SSL disabled)');
    poolConfig = {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'inshallah',
        database: process.env.DB_NAME || 'school_management',
        port: parseInt(process.env.DB_PORT) || 5432,
        ssl: false  // ← CRITICAL FIX: Disable SSL for local PostgreSQL
    };
}

// Add common settings to both configurations
Object.assign(poolConfig, {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const pool = new Pool(poolConfig);

// Test database connection on startup
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});
// ==================================================

// Helper function to execute queries
async function executeQuery(query, params = []) {
    const client = await pool.connect();
    try {
        const result = await client.query(query, params);
        return result.rows;
    } catch (error) {
        console.error('Database query error:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Helper function to execute single query
async function executeSingle(query, params = []) {
    const client = await pool.connect();
    try {
        const result = await client.query(query, params);
        return result.rows[0];
    } catch (error) {
        console.error('Database query error:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Helper function for transactions
async function executeTransaction(operations) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await operations(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Transaction error:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// A new instance of multer for forms that do not have file uploads
const uploadNoFile = multer();
// The original multer instance for forms with file uploads
const uploadWithFile = multer({ storage: storage });

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

// Apply role-based access control to routes
app.get('/admin/*', requireRole('admin'));
app.get('/teacher/*', requireRole('teacher'));
app.get('/student/*', requireRole('student'));

// Function to compare passwords
async function comparePassword(inputPassword, storedPassword) {
    return await argon2.verify(storedPassword, inputPassword);
}

app.get('/register', (req, res) => {
    res.render('page-register', { error: null });
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
        const existingUsers = await executeQuery(
            'SELECT * FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existingUsers.length > 0) {
            return res.render('page-register', { 
                error: 'Username or email already exists' 
            });
        }

        // Hash the password
        const hashedPassword = await argon2.hash(password);

        // Execute transaction
        await executeTransaction(async (client) => {
            // First, insert school information
            const schoolResult = await client.query(
                'INSERT INTO school_info (name, email, phone, website, address) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [schoolName, schoolEmail, schoolPhone, schoolWebsite || null, schoolAddress]
            );

            const schoolId = schoolResult.rows[0].id;

            // Then, insert the user with school reference
            await client.query(
                'INSERT INTO users (username, password, role, email, school_id) VALUES ($1, $2, $3, $4, $5)',
                [username, hashedPassword, role, email, schoolId]
            );
        });

        // Redirect to login page after successful registration
        req.session.success = 'School registration successful! Please login.';
        res.redirect('/login');

    } catch (error) {
        console.error('Registration error:', error);
        
        let errorMessage = 'Registration failed';
        if (error.code === '23505') { // unique_violation in PostgreSQL
            errorMessage = 'Username or email already exists';
        } else {
            errorMessage += ': ' + error.message;
        }
        
        res.render('page-register', { 
            error: errorMessage 
        });
    }
});

app.get('/login', (req, res) => {
    res.render('page-login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, credential } = req.body;

    try {
        if (!email || !credential) {
            return res.render('page-login', { 
                error: 'Email and credential are required' 
            });
        }

        // First, try admin login (users table with password)
        const users = await executeQuery(
            'SELECT * FROM users WHERE email = $1',
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
        const teachers = await executeQuery(
            'SELECT * FROM teachers WHERE email = $1',
            [email]
        );

        if (teachers.length > 0) {
            const teacher = teachers[0];
            const passwordMatch = await comparePassword(credential, teacher.password);

            if (passwordMatch) {
                // Teacher login successful
                req.session.userId = teacher.id;
                req.session.username = `${teacher.first_name} ${teacher.last_name}`;
                req.session.role = 'teacher';
                req.session.teacherData = teacher;
                return res.redirect('/teacher-dashboard');
            }
        }

        // Third, try student login (email + first name)
        const students = await executeQuery(
            'SELECT * FROM students WHERE email = $1 AND first_name = $2',
            [email, credential]
        );

        if (students.length > 0) {
            const student = students[0];
            
            // Student login successful
            req.session.userId = student.id;
            req.session.username = `${student.first_name} ${student.last_name}`;
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

        // Admin dashboard
        // Get current academic year and term
        const currentAcademicYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const currentTerm = await executeQuery(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get counts from database
        const studentRows = await executeQuery('SELECT COUNT(*) as count FROM students');
        const teacherRows = await executeQuery('SELECT COUNT(*) as count FROM teachers');
        const classRows = await executeQuery('SELECT COUNT(*) as count FROM classes');
        
        // Get fee collection data for current term
        const feeRows = await executeQuery(`
            SELECT SUM(amount) as total 
            FROM fees 
            WHERE academic_year = $1 AND term = $2
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get recent activities
        const activities = await executeQuery(`
            SELECT * FROM activities 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        
        // Get upcoming events
        const events = await executeQuery(`
            SELECT * FROM calendar_events 
            WHERE event_date >= CURRENT_DATE 
            ORDER BY event_date ASC 
            LIMIT 3
        `);
        
        // Calculate term progress based on actual dates
        let termProgress = 0;
        let daysRemaining = 0;
        
        if (currentTerm.length > 0) {
            const termDetails = await executeQuery(`
                SELECT start_date, end_date 
                FROM academic_terms 
                WHERE term_name = $1 AND academic_year_id = (
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
        const examStats = await executeQuery(`
            SELECT COUNT(DISTINCT subject_id) as exams_conducted
            FROM student_scores 
            WHERE academic_year = $1 AND term = $2
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get assignment statistics
        const assignmentsSubmitted = 156; // Placeholder
        
        // Get class schedule statistics
        const classStats = await executeQuery(`
            SELECT COUNT(*) as classes_scheduled
            FROM calendar_events 
            WHERE event_date >= CURRENT_DATE 
            AND event_date <= CURRENT_DATE + INTERVAL '7 days'
            AND (title LIKE '%class%' OR description LIKE '%class%')
        `);
        
        // Get assignments due
        const assignmentsDue = 8; // Placeholder
        
        // Get attendance statistics
        // Get attendance statistics (FIXED - avoids division by zero)
const attendanceStats = await executeQuery(`
    SELECT 
        CASE 
            WHEN COUNT(*) > 0 
            THEN (COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) * 100.0 / COUNT(*))
            ELSE 0 
        END as avg_attendance
    FROM attendance_records
    WHERE date >= CURRENT_DATE - INTERVAL '30 days'
`);
        
        const dashboardData = {
            username: req.session.username,
            role: req.session.role,
            studentCount: studentRows[0].count,
            teacherCount: teacherRows[0].count,
            classCount: classRows[0].count,
            revenue: feeRows[0]?.total || 0,
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
            feesCollected: feeRows[0]?.total || 0,
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
app.get('/student-dashboard', authenticate, async (req, res) => {
    if (req.session.role !== 'student') {
        return res.redirect('/');
    }
    
    try {
        // Get current academic year and term
        const currentAcademicYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const currentTerm = await executeQuery(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get term dates for attendance calculation
        const termDetails = await executeQuery(`
            SELECT start_date, end_date 
            FROM academic_terms 
            WHERE term_name = $1 AND academic_year_id = (
                SELECT id FROM academic_years WHERE year_name = $2
            )
        `, [
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024'
        ]);
        
        // Get student data
        const students = await executeQuery(
            'SELECT s.*, c.class_name FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.id = $1',
            [req.session.userId]
        );
        
        if (students.length === 0) {
            return res.redirect('/login');
        }
        
        const studentData = students[0];
        
        // Get student's recent results
        const results = await executeQuery(`
            SELECT ss.*, sub.name as subject_name 
            FROM student_scores ss 
            JOIN subjects sub ON ss.subject_id = sub.id 
            WHERE ss.student_id = $1 AND ss.academic_year = $2 AND ss.term = $3
            ORDER BY ss.created_at DESC LIMIT 5
        `, [
            req.session.userId, 
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get attendance percentage
        let attendancePercentage = 0;
        if (termDetails.length > 0) {
            const attendance = await executeQuery(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = $1 AND date BETWEEN $2 AND $3
            `, [req.session.userId, termDetails[0].start_date, termDetails[0].end_date]);
            
            attendancePercentage = attendance.length > 0 && attendance[0].total_days > 0 ? 
                Math.round((attendance[0].present_days / attendance[0].total_days) * 100) : 0;
        }
        
        // Calculate average score
        const averageScore = results.length > 0 ? 
            Math.round(results.reduce((sum, result) => sum + (result.test_score + result.exam_score), 0) / results.length) : 0;
        
        // Get fee status
        const fees = await executeQuery(`
            SELECT status FROM fees 
            WHERE student_id = $1 AND academic_year = $2 AND term = $3
            ORDER BY created_at DESC LIMIT 1
        `, [
            req.session.userId,
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        const feeStatus = fees.length > 0 ? fees[0].status : 'Pending';
        
        // Get upcoming events
        const upcomingEvents = await executeQuery(`
            SELECT * FROM calendar_events 
            WHERE event_date >= CURRENT_DATE 
            ORDER BY event_date ASC 
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
        // Get current academic year and term
        const currentAcademicYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const currentTerm = await executeQuery(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get teacher data
        const teachers = await executeQuery(
            'SELECT * FROM teachers WHERE id = $1',
            [req.session.userId]
        );
        
        if (teachers.length === 0) {
            return res.redirect('/login');
        }
        
        const teacherData = teachers[0];
        
        // Get teacher's classes and subjects
        const classes = await executeQuery(`
            SELECT DISTINCT c.id as class_id, c.class_name, s.id as subject_id, s.name as subject_name,
                   (SELECT COUNT(*) FROM students WHERE class_id = c.id) as student_count
            FROM classes c
            JOIN class_subjects cs ON c.id = cs.class_id
            JOIN subjects s ON cs.subject_id = s.id
            WHERE c.professor_id = $1
            ORDER BY c.class_name
        `, [req.session.userId]);
        
        // Get scores entered this term
        const scores = await executeQuery(`
            SELECT COUNT(*) as count FROM student_scores 
            WHERE academic_year = $1 AND term = $2
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);
        
        // Get today's schedule for the teacher
        const today = new Date().toISOString().split('T')[0];
        
        // Get events without class join
        const todaysEvents = await executeQuery(`
            SELECT * FROM calendar_events 
            WHERE event_date = $1 
            AND (title LIKE '%class%' OR description LIKE '%class%' OR title LIKE '%lecture%' OR description LIKE '%lecture%')
            ORDER BY start_time
        `, [today]);
        
        // Get events that might be relevant
        const todaysSchedule = await executeQuery(`
            SELECT * FROM calendar_events 
            WHERE event_date = $1 
            AND (
                title LIKE '%' || (SELECT class_name FROM classes WHERE professor_id = $2 LIMIT 1) || '%'
                OR description LIKE '%' || (SELECT class_name FROM classes WHERE professor_id = $3 LIMIT 1) || '%'
                OR title LIKE '%teacher%' 
                OR description LIKE '%teacher%'
            )
            ORDER BY start_time
        `, [today, req.session.userId, req.session.userId]);
        
        // Get assignments due soon (placeholder)
        const assignmentsDue = 0;
        
        // Get recent announcements or activities
        const recentActivities = await executeQuery(`
            SELECT * FROM activities 
            ORDER BY created_at DESC 
            LIMIT 3
        `);
        
        // Get teacher's upcoming events (next 7 days)
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        const nextWeekFormatted = nextWeek.toISOString().split('T')[0];
        
        const upcomingEvents = await executeQuery(`
            SELECT * FROM calendar_events 
            WHERE event_date BETWEEN $1 AND $2
            AND (
                title LIKE '%' || (SELECT class_name FROM classes WHERE professor_id = $3 LIMIT 1) || '%'
                OR description LIKE '%' || (SELECT class_name FROM classes WHERE professor_id = $4 LIMIT 1) || '%'
            )
            ORDER BY event_date, start_time
        `, [today, nextWeekFormatted, req.session.userId, req.session.userId]);
        
        res.render('teacher-dashboard', {
            teacherData: teacherData,
            myClasses: classes,
            totalStudents: classes.reduce((sum, cls) => sum + cls.student_count, 0),
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
app.get('/academic-years', authenticate, async (req, res) => {
    try {
        // Get all academic years with their terms
        const academicYears = await executeQuery(`
            SELECT 
                ay.*,
                (SELECT COUNT(*) FROM academic_terms at WHERE at.academic_year_id = ay.id) as term_count
            FROM academic_years ay
            ORDER BY ay.start_date DESC
        `);
        
        // Get all terms for display
        const terms = await executeQuery(`
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
        
        // Execute transaction
        await executeTransaction(async (client) => {
            // If this is set as current year, unset any other current year
            if (is_current === 'on') {
                await client.query(
                    'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
                );
            }
            
            // Insert new academic year
            const result = await client.query(
                'INSERT INTO academic_years (year_name, start_date, end_date, is_current) VALUES ($1, $2, $3, $4) RETURNING id',
                [year_name, formattedStartDate, formattedEndDate, is_current === 'on']
            );
            
            const academicYearId = result.rows[0].id;
            
            // Insert terms
            const terms = [
                { name: 'First Term', start: first_term_start, end: first_term_end },
                { name: 'Second Term', start: second_term_start, end: second_term_end },
                { name: 'Third Term', start: third_term_start, end: third_term_end }
            ];
            
            for (const term of terms) {
                const termStartDate = moment(term.start, 'YYYY-MM-DD').format('YYYY-MM-DD');
                const termEndDate = moment(term.end, 'YYYY-MM-DD').format('YYYY-MM-DD');
                
                await client.query(
                    'INSERT INTO academic_terms (academic_year_id, term_name, start_date, end_date) VALUES ($1, $2, $3, $4)',
                    [academicYearId, term.name, termStartDate, termEndDate]
                );
            }
        });
        
        req.session.success = 'Academic year added successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error adding academic year:', error);
        
        let errorMessage = 'Failed to add academic year';
        if (error.code === '23505') { // unique_violation
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
        // Get academic year
        const academicYears = await executeQuery(
            'SELECT * FROM academic_years WHERE id = $1',
            [req.params.id]
        );
        
        if (academicYears.length === 0) {
            req.session.error = 'Academic year not found';
            return res.redirect('/academic-years');
        }
        
        // Get terms for this academic year
        const terms = await executeQuery(
            'SELECT * FROM academic_terms WHERE academic_year_id = $1 ORDER BY CASE term_name WHEN \'First Term\' THEN 1 WHEN \'Second Term\' THEN 2 WHEN \'Third Term\' THEN 3 END',
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
        
        // Execute transaction
        await executeTransaction(async (client) => {
            // If this is set as current year, unset any other current year
            if (is_current === 'on') {
                await client.query(
                    'UPDATE academic_years SET is_current = FALSE WHERE id != $1 AND is_current = TRUE',
                    [academicYearId]
                );
            }
            
            // Update academic year
            await client.query(
                'UPDATE academic_years SET year_name = $1, start_date = $2, end_date = $3, is_current = $4 WHERE id = $5',
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
                
                await client.query(
                    'UPDATE academic_terms SET start_date = $1, end_date = $2 WHERE academic_year_id = $3 AND term_name = $4',
                    [termStartDate, termEndDate, academicYearId, term.name]
                );
            }
        });
        
        req.session.success = 'Academic year updated successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error updating academic year:', error);
        
        let errorMessage = 'Failed to update academic year';
        if (error.code === '23505') {
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
        // Execute transaction
        await executeTransaction(async (client) => {
            // Unset any current academic year
            await client.query(
                'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
            );
            
            // Set the selected academic year as current
            await client.query(
                'UPDATE academic_years SET is_current = TRUE WHERE id = $1',
                [req.params.id]
            );
        });
        
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
        // Get the term to set as current
        const terms = await executeQuery(
            'SELECT * FROM academic_terms WHERE id = $1',
            [req.params.id]
        );
        
        if (terms.length === 0) {
            req.session.error = 'Term not found';
            return res.redirect('/academic-years');
        }
        
        const term = terms[0];
        
        // Execute transaction
        await executeTransaction(async (client) => {
            // Unset any current term
            await client.query(
                'UPDATE academic_terms SET is_current = FALSE WHERE is_current = TRUE'
            );
            
            // Set the selected term as current
            await client.query(
                'UPDATE academic_terms SET is_current = TRUE WHERE id = $1',
                [req.params.id]
            );
            
            // Also set the academic year as current if it's not already
            await client.query(
                'UPDATE academic_years SET is_current = TRUE WHERE id = $1',
                [term.academic_year_id]
            );
        });
        
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
        // Check if academic year is used in any records
        const academicYears = await executeQuery(
            'SELECT year_name FROM academic_years WHERE id = $1',
            [req.params.id]
        );
        
        if (academicYears.length === 0) {
            req.session.error = 'Academic year not found';
            return res.redirect('/academic-years');
        }
        
        const yearName = academicYears[0].year_name;
        
        const feeRecords = await executeQuery(
            'SELECT COUNT(*) as count FROM fees WHERE academic_year = $1',
            [yearName]
        );
        
        const scoreRecords = await executeQuery(
            'SELECT COUNT(*) as count FROM student_scores WHERE academic_year = $1',
            [yearName]
        );
        
        if (feeRecords[0].count > 0 || scoreRecords[0].count > 0) {
            req.session.error = 'Cannot delete academic year. It is being used in fee records or student scores.';
            return res.redirect('/academic-years');
        }
        
        // Delete academic year
        await executeQuery(
            'DELETE FROM academic_years WHERE id = $1',
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

// GET route to display the add student form
app.get('/add-student', authenticate, async (req, res) => {
    try {
        // Get classes with their levels and departments
        const classes = await executeQuery(`
            SELECT id, class_name, class_code, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                class_name
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

// GET /edit-student/:id
app.get('/edit-student/:id', authenticate, async (req, res) => {
    const studentId = req.params.id;

    try {
        // Get student data
        const students = await executeQuery(
            'SELECT * FROM students WHERE id = $1',
            [studentId]
        );

        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/all-students');
        }

        const student = students[0];
        
        // Get classes with their levels and departments
        const classes = await executeQuery(`
            SELECT id, class_name, class_code, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                class_name
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

// POST route to handle both add and edit form submission
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
        // Validate required fields
        if (!firstName || !lastName || !email || !classId) {
            const classes = await executeQuery('SELECT id, class_name FROM classes ORDER BY class_name');
            
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
        let emailCheckQuery = 'SELECT id, admission_number FROM students WHERE email = $1';
        let emailCheckParams = [email];
        
        if (isEdit) {
            emailCheckQuery += ' AND id != $2';
            emailCheckParams.push(studentId);
        }
        
        const existingStudents = await executeQuery(
            emailCheckQuery,
            emailCheckParams
        );
        
        if (existingStudents.length > 0) {
            const classes = await executeQuery('SELECT id, class_name FROM classes ORDER BY class_name');
            
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
        const classInfo = await executeQuery(
            'SELECT level, department FROM classes WHERE id = $1',
            [classId]
        );
        
        if (classInfo.length > 0 && classInfo[0].level === 'SENIOR SECONDARY') {
            studentDepartment = classInfo[0].department;
        }

        if (isEdit) {
            // Update existing student
            await executeQuery(
                `UPDATE students SET 
                    first_name = $1, middle_name = $2, last_name = $3, email = $4, class_id = $5, 
                    gender = $6, mobile_number = $7, parents_name = $8, parents_mobile_number = $9, 
                    date_of_birth = $10, nationality = $11, address = $12, department = $13, 
                    state_of_origin = $14, local_government = $15, residential_state = $16, residential_lga = $17
                 WHERE id = $18`,
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
            const lastStudent = await executeQuery(
                'SELECT admission_number FROM students WHERE admission_number LIKE $1 ORDER BY id DESC LIMIT 1',
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
            await executeQuery(
                `INSERT INTO students 
                (admission_number, first_name, middle_name, last_name, email, class_id, gender, 
                 mobile_number, parents_name, parents_mobile_number, date_of_birth, nationality, 
                 address, department, state_of_origin, local_government, residential_state, residential_lga) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
        
        const classes = await executeQuery('SELECT id, class_name FROM classes ORDER BY class_name');
        
        let errorMessage = `Failed to ${isEdit ? 'update' : 'add'} student. Please try again.`;
        if (error.code === '23505') { // unique violation
            if (error.message.includes('admission_number')) {
                errorMessage = 'Failed to generate unique admission number. Please try again.';
            } else if (error.message.includes('email')) {
                errorMessage = 'A student with this email already exists.';
            }
        } else if (error.code === '23503') { // foreign key violation
            errorMessage = 'The selected class does not exist.';
        } else if (error.code === '22001') { // string data right truncation
            errorMessage = 'One or more fields contain data that is too long. Please check your inputs.';
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

// GET route to delete student
app.get('/delete-student/:id', authenticate, async (req, res) => {
    const studentId = req.params.id;

    try {
        // First check if student exists
        const students = await executeQuery(
            'SELECT admission_number FROM students WHERE id = $1',
            [studentId]
        );
        
        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/all-students');
        }
        
        const admissionNumber = students[0].admission_number;
        
        try {
            // First delete related fees
            await executeQuery('DELETE FROM fees WHERE student_id = $1', [studentId]);
            
            // Then delete the student
            const result = await executeQuery('DELETE FROM students WHERE id = $1', [studentId]);
            
            req.session.success = `Student ${admissionNumber} deleted successfully`;
            
        } catch (error) {
            console.error('Error deleting student:', error);
            
            if (error.code === '23503') { // foreign key violation
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
        const students = await executeQuery(`
            SELECT s.*, c.class_name, c.level, c.department AS class_department
            FROM students s
            LEFT JOIN classes c ON s.class_id = c.id
            ORDER BY 
                CASE 
                    WHEN c.level = 'KG' THEN 1
                    WHEN c.level = 'NURSERY' THEN 2
                    WHEN c.level = 'PRIMARY' THEN 3
                    WHEN c.level = 'JUNIOR SECONDARY' THEN 4
                    WHEN c.level = 'SENIOR SECONDARY' THEN 5
                    ELSE 6
                END,
                c.class_name,
                s.admission_number,
                s.first_name
        `);
        
        // Format registration dates for display
        const formattedStudents = students.map(student => ({
            ...student,
            registration_date: student.registration_date ? 
                new Date(student.registration_date).toLocaleDateString() : 'N/A',
            date_of_birth: student.date_of_birth ?
                new Date(student.date_of_birth).toLocaleDateString() : 'N/A'
        }));
        
        // Check for success message from session
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success;
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
        const teachers = await executeQuery('SELECT * FROM teachers ORDER BY first_name, last_name');
        
        // Format dates for display
        const formattedTeachers = teachers.map(teacher => ({
            ...teacher,
            joining_date: teacher.joining_date ? moment(teacher.joining_date).format('D MMMM, YYYY') : 'N/A',
            date_of_birth: teacher.date_of_birth ? moment(teacher.date_of_birth).format('D MMMM, YYYY') : 'N/A'
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
        const teachers = await executeQuery('SELECT * FROM teachers WHERE id = $1', [teacherId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/all-teachers');
        }

        const teacher = teachers[0];
        
        // Format dates for the form
        const formattedTeacher = {
            ...teacher,
            joining_date: teacher.joining_date ? moment(teacher.joining_date).format('D MMMM, YYYY') : '',
            date_of_birth: teacher.date_of_birth ? moment(teacher.date_of_birth).format('D MMMM, YYYY') : ''
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
        await executeQuery(
            `INSERT INTO teachers 
            (first_name, last_name, email, joining_date, password, mobile_number, gender, 
            designation, department, date_of_birth, education, nationality, state_of_origin, 
            local_government, residential_state, residential_lga, emergency_contact_name, 
            emergency_contact_number, address) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
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
        
        // Set success message in session
        req.session.success = 'Teacher added successfully';
        res.redirect('/all-teachers');
        
    } catch (error) {
        console.error('Error adding teacher:', error);
        
        if (error.code === '23505') { // unique violation
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
            const teachers = await executeQuery('SELECT * FROM teachers WHERE id = $1', [teacherId]);
            return res.render('edit-teacher', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                teacher: teachers[0] || {}
            });
        }

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
            const teachers = await executeQuery('SELECT * FROM teachers WHERE id = $1', [teacherId]);
            return res.render('edit-teacher', { 
                error: 'Invalid date format. Please use the correct date format',
                teacher: teachers[0] || {}
            });
        }

        // Update the teacher in the database
        const result = await executeQuery(
            `UPDATE teachers SET 
            first_name = $1, last_name = $2, email = $3, joining_date = $4, mobile_number = $5, 
            gender = $6, designation = $7, department = $8, date_of_birth = $9, education = $10,
            nationality = $11, state_of_origin = $12, local_government = $13, residential_state = $14,
            residential_lga = $15, emergency_contact_name = $16, emergency_contact_number = $17, address = $18
            WHERE id = $19`,
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

        if (result.length === 0) {
            req.session.error = 'Teacher not found or no changes made';
        } else {
            req.session.success = 'Teacher updated successfully';
        }
        
        res.redirect('/all-teachers');
    } catch (error) {
        console.error('Error updating teacher:', error);
        
        // Handle duplicate email error
        if (error.code === '23505') {
            const teachers = await executeQuery('SELECT * FROM teachers WHERE id = $1', [teacherId]);
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
        // Check if teacher exists before deleting
        const teachers = await executeQuery('SELECT * FROM teachers WHERE id = $1', [teacherId]);
        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/all-teachers');
        }

        const result = await executeQuery('DELETE FROM teachers WHERE id = $1', [teacherId]);
        
        if (result.length === 0) {
            req.session.error = 'Failed to delete teacher';
        } else {
            req.session.success = 'Teacher deleted successfully';
        }
        
        res.redirect('/all-teachers');
    } catch (error) {
        console.error('Error deleting teacher:', error);
        
        // Handle foreign key constraint errors
        if (error.code === '23503') {
            req.session.error = 'Cannot delete teacher. This teacher is associated with existing records.';
        } else {
            req.session.error = 'Error deleting teacher: ' + error.message;
        }
        
        res.redirect('/all-teachers');
    }
});

// Class Routes
app.get('/add-class', authenticate, async (req, res) => {
    try {
        const teachers = await executeQuery('SELECT id, first_name, last_name FROM teachers ORDER BY last_name');
        
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
        const teachers = await executeQuery('SELECT id, first_name, last_name FROM teachers ORDER BY last_name');

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
        const teacher = await executeQuery(
            'SELECT first_name, last_name FROM teachers WHERE id = $1', 
            [professorId]
        );
        
        if (teacher.length === 0) {
            return res.render('add-class', {
                teachers: teachers,
                formData: req.body,
                error: 'Selected teacher does not exist'
            });
        }

        const professorName = `${teacher[0].first_name} ${teacher[0].last_name}`;

        // Insert into database
        await executeQuery(
            `INSERT INTO classes 
            (class_name, class_code, professor_name, professor_id, maximum_students, level, department) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
        const teachers = await executeQuery('SELECT id, first_name, last_name FROM teachers ORDER BY last_name');
        
        res.render('add-class', {
            teachers: teachers,
            formData: req.body,
            error: 'Failed to add class: ' + error.message
        });
    }
});

app.get('/all-classes', authenticate, async (req, res) => {
    try {
        const classes = await executeQuery(`
            SELECT 
                id, 
                class_name, 
                level,
                department,
                class_code,
                professor_name,
                professor_id,
                maximum_students
            FROM classes
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                class_name
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
        const classes = await executeQuery('SELECT * FROM classes WHERE id = $1', [classId]);

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
        // Format the dates to 'YYYY-MM-DD'
        const formattedStartDate = moment(startDate, 'D MMMM, YYYY').format('YYYY-MM-DD');

        // Update the class in the database
        await executeQuery(
            'UPDATE classes SET class_name = $1, class_code = $2, class_details = $3, start_date = $4, class_duration = $5, class_price = $6, professor_name = $7, maximum_students = $8, contact_number = $9, course_photo = $10 WHERE id = $11',
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
        await executeQuery('DELETE FROM classes WHERE id = $1', [classId]);
        res.redirect('/all-classes');
    } catch (error) {
        console.error('Error deleting class:', error);
        res.status(500).send('Error deleting class');
    }
});

// Staff Routes
app.get('/all-staff', authenticate, async (req, res) => {
    try {
        const staff = await executeQuery('SELECT * FROM staff');
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

        await executeQuery(
            `INSERT INTO staff 
            (first_name, last_name, gender, date_of_birth, nationality, state_of_origin, 
            local_government, residential_state, residential_lga, emergency_contact_name, 
            emergency_contact_number, address, email, position, department, phone, 
            joining_date, image_path) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
        
        if (error.code === '23505') {
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
        const staff = await executeQuery('SELECT * FROM staff WHERE id = $1', [staffId]);
        
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
            const staff = await executeQuery('SELECT * FROM staff WHERE id = $1', [staffId]);
            return res.render('edit-staff', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                staff: staff[0] || {}
            });
        }

        // Check if new image was uploaded
        let imagePath = null;
        if (req.file) {
            imagePath = '/images/staff/' + req.file.filename;
            
            // Get old image path to delete it later
            const currentStaff = await executeQuery('SELECT image_path FROM staff WHERE id = $1', [staffId]);
            const oldImagePath = currentStaff[0]?.image_path;
            
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
            const staff = await executeQuery('SELECT * FROM staff WHERE id = $1', [staffId]);
            return res.render('edit-staff', { 
                error: 'Invalid date format. Please use the correct date format.',
                staff: staff[0] || {}
            });
        }

        // Build update query based on whether image was uploaded
        let query, params;
        if (imagePath) {
            query = `UPDATE staff SET 
                first_name = $1, last_name = $2, gender = $3, date_of_birth = $4, nationality = $5, 
                state_of_origin = $6, local_government = $7, residential_state = $8, residential_lga = $9, 
                emergency_contact_name = $10, emergency_contact_number = $11, address = $12, email = $13, 
                position = $14, department = $15, phone = $16, joining_date = $17, image_path = $18 
                WHERE id = $19`;
            params = [
                firstName, lastName, gender || null, formattedDateOfBirth, nationality || null,
                stateOfOrigin || null, localGovernment || null, residentialState || null,
                residentialLGA || null, emergencyContactName || null, emergencyContactNumber || null,
                address || null, email, position, department, phone, formattedJoiningDate,
                imagePath, staffId
            ];
        } else {
            query = `UPDATE staff SET 
                first_name = $1, last_name = $2, gender = $3, date_of_birth = $4, nationality = $5, 
                state_of_origin = $6, local_government = $7, residential_state = $8, residential_lga = $9, 
                emergency_contact_name = $10, emergency_contact_number = $11, address = $12, email = $13, 
                position = $14, department = $15, phone = $16, joining_date = $17 
                WHERE id = $18`;
            params = [
                firstName, lastName, gender || null, formattedDateOfBirth, nationality || null,
                stateOfOrigin || null, localGovernment || null, residentialState || null,
                residentialLGA || null, emergencyContactName || null, emergencyContactNumber || null,
                address || null, email, position, department, phone, formattedJoiningDate,
                staffId
            ];
        }

        const result = await executeQuery(query, params);

        if (result.length === 0) {
            req.session.error = 'Staff member not found or no changes made';
        } else {
            req.session.success = 'Staff member updated successfully';
        }
        
        res.redirect('/all-staff');
    } catch (error) {
        console.error('Error updating staff:', error);
        
        if (error.code === '23505') {
            const staff = await executeQuery('SELECT * FROM staff WHERE id = $1', [staffId]);
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
app.get('/api/terms/:academicYearId', authenticate, async (req, res) => {
    const { academicYearId } = req.params;
    
    try {
        const terms = await executeQuery(`
            SELECT id, term_name, is_current 
            FROM academic_terms 
            WHERE academic_year_id = $1 
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
        // Get students with class information
        const students = await executeQuery(`
            SELECT 
                s.id, 
                s.first_name, 
                s.middle_name, 
                s.last_name, 
                s.email,
                s.class_id,
                c.class_name, 
                c.department AS class_department 
            FROM students s 
            LEFT JOIN classes c ON s.class_id = c.id 
            WHERE s.class_id IS NOT NULL
            ORDER BY s.first_name, s.last_name
        `);
        
        // Get academic years
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get current academic year
        const currentAcademicYear = await executeQuery(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get terms for the current academic year
        let terms = [];
        if (currentAcademicYear.length > 0) {
            terms = await executeQuery(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = $1 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);
        }
        
        // Get distinct fee types from class bills
        const feeTypesResult = await executeQuery(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = true
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Get school information
        const schoolInfo = await executeQuery(`
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
        
        // Get student's class first
        const studentData = await executeQuery(
            'SELECT class_id FROM students WHERE id = $1',
            [studentId]
        );
        
        if (studentData.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Student not found'
            });
        }
        
        const classId = studentData[0].class_id;
        
        // Get bill amount
        const bills = await executeQuery(`
            SELECT amount FROM class_bills 
            WHERE class_id = $1 AND fee_type = $2 AND academic_year = $3 AND term = $4 AND is_active = true
        `, [classId, feeType, academicYear, term]);
        
        if (bills.length > 0) {
            res.json({
                success: true,
                amount: bills[0].amount,
                hasBill: true
            });
        } else {
            // Check if fee type exists at all
            const feeTypeCheck = await executeQuery(`
                SELECT fee_type FROM class_bills 
                WHERE fee_type = $1 AND is_active = true LIMIT 1
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
        // Get students list for form repopulation in case of error
        const students = await executeQuery(`
            SELECT 
                s.id, 
                s.first_name, 
                s.middle_name, 
                s.last_name, 
                s.email,
                s.class_id,
                c.class_name 
            FROM students s 
            LEFT JOIN classes c ON s.class_id = c.id 
            ORDER BY s.first_name, s.last_name
        `);

        // Get academic years for the form in case of error
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get terms for the selected academic year
        let terms = [];
        const selectedYear = await executeQuery(
            'SELECT id FROM academic_years WHERE year_name = $1',
            [academicYear]
        );
        
        if (selectedYear.length > 0) {
            terms = await executeQuery(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = $1 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [selectedYear[0].id]);
        }
        
        // Get distinct fee types from class bills for form repopulation
        const feeTypesResult = await executeQuery(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = true
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Get school information
        const schoolInfo = await executeQuery(`
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

        // Get student's actual details from database including class_id and admission_number
        const studentData = await executeQuery(`
            SELECT 
                s.first_name, s.middle_name, s.last_name, s.email, s.class_id, s.admission_number,
                c.class_name, c.department 
            FROM students s 
            LEFT JOIN classes c ON s.class_id = c.id 
            WHERE s.id = $1`, 
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
        const studentName = `${student.first_name} ${student.middle_name || ''} ${student.last_name}`.trim();
        const studentClass = student.class_name || 'Not assigned';
        const studentDepartment = student.department || '';
        const studentEmail = student.email || '';
        const admissionNumber = student.admission_number || '';
        
        // Check if there's a class bill for this fee type
        const classBills = await executeQuery(`
            SELECT amount FROM class_bills 
            WHERE class_id = $1 AND fee_type = $2 AND academic_year = $3 AND term = $4 AND is_active = true
        `, [student.class_id, feeType, academicYear, term]);
        
        let billAmount = 0;
        let hasBill = false;
        
        if (classBills.length > 0) {
            hasBill = true;
            billAmount = parseFloat(classBills[0].amount);
        } else {
            // If no bill found, check if fee type exists in class bills at all
            const feeTypeCheck = await executeQuery(`
                SELECT fee_type FROM class_bills 
                WHERE fee_type = $1 AND is_active = true LIMIT 1
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
        const previousPayments = await executeQuery(`
            SELECT SUM(amount_paid) as total_paid, SUM(balance) as total_balance 
            FROM fees 
            WHERE student_id = $1 AND fee_type = $2 AND academic_year = $3 AND term = $4
        `, [studentId, feeType, academicYear, term]);
        
        const totalPaidSoFar = parseFloat(previousPayments[0].total_paid) || 0;
        const currentBalance = parseFloat(previousPayments[0].total_balance) || 0;
        
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
        await executeQuery(
            `INSERT INTO fees (
                student_id, admission_number, student_name, email,
                class_name, department,
                fee_type, payment_type, amount, bill_amount, amount_paid, balance, payment_date, 
                receipt_number, academic_year, term, notes, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
                hasBill ? billAmount : amountValue, // bill_amount
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
        const students = await executeQuery(`
            SELECT 
                s.id, 
                s.first_name, 
                s.middle_name, 
                s.last_name, 
                s.email,
                c.class_name 
            FROM students s 
            LEFT JOIN classes c ON s.class_id = c.id 
            ORDER BY s.first_name, s.last_name
        `);
        
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get terms for the selected academic year if available
        let terms = [];
        if (req.body.academicYear) {
            const selectedYear = await executeQuery(
                'SELECT id FROM academic_years WHERE year_name = $1',
                [req.body.academicYear]
            );
            
            if (selectedYear.length > 0) {
                terms = await executeQuery(`
                    SELECT * FROM academic_terms 
                    WHERE academic_year_id = $1 
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
        const feeTypesResult = await executeQuery(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = true
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Get school information
        const schoolInfo = await executeQuery(`
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
            error: error.code === '23505' ? 'A fee payment with these details already exists' : 'Failed to add fee payment: ' + error.message
        });
    }
});

// GET route for fees collection listing with filtering
app.get('/fees-collection', authenticate, async (req, res) => {
    try {
        const { academicYear, term, status, classId, feeType, page = 1, limit = 50 } = req.query;
        
        // Get academic years for filter dropdown
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get classes for filter
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY class_name
        `);
        
        // Get distinct fee types from class bills
        const feeTypesResult = await executeQuery(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = true
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Build the WHERE clause if filters are provided
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (academicYear) {
            whereClause += ' AND f.academic_year = $' + (queryParams.length + 1);
            queryParams.push(academicYear);
        }
        
        if (term) {
            whereClause += ' AND f.term = $' + (queryParams.length + 1);
            queryParams.push(term);
        }
        
        if (status) {
            whereClause += ' AND f.status = $' + (queryParams.length + 1);
            queryParams.push(status);
        }
        
        if (classId) {
            whereClause += ' AND s.class_id = $' + (queryParams.length + 1);
            queryParams.push(classId);
        }
        
        if (feeType) {
            whereClause += ' AND f.fee_type = $' + (queryParams.length + 1);
            queryParams.push(feeType);
        }
        
        // Get total count for pagination
        const totalCountResult = await executeQuery(
            `SELECT COUNT(*) as total
            FROM fees f
            LEFT JOIN students s ON f.student_id = s.id
            LEFT JOIN classes c ON s.class_id = c.id
            ${whereClause}`,
            queryParams
        );
        
        const totalCount = totalCountResult[0].total;
        const totalPages = Math.ceil(totalCount / limit);
        const offset = (page - 1) * limit;
        
        // Get fees with filters - join with students to filter by class
        const fees = await executeQuery(`
            SELECT 
                f.*,
                s.class_id,
                c.class_name as student_class_name
            FROM fees f
            LEFT JOIN students s ON f.student_id = s.id
            LEFT JOIN classes c ON s.class_id = c.id
            ${whereClause}
            ORDER BY f.payment_date DESC, f.created_at DESC
            LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
        `, [...queryParams, parseInt(limit), parseInt(offset)]);
        
        // Format amounts for display and calculate payment status
        const formattedFees = fees.map(fee => {
            const billAmount = fee.bill_amount || fee.amount;
            const amountPaid = fee.amount_paid || 0;
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
                hasBill: fee.bill_amount !== null && fee.bill_amount !== undefined,
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
        // Get fee payment details
        const payments = await executeQuery(`
            SELECT f.* 
            FROM fees f
            WHERE f.id = $1
        `, [req.params.id]);

        if (payments.length === 0) {
            return res.status(404).send('Receipt not found');
        }

        const receipt = payments[0];
        
        // Calculate amounts based on bill information
        const billAmount = receipt.bill_amount || receipt.amount;
        const amountPaid = receipt.amount_paid || 0;
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
        const totalPayments = await executeQuery(`
            SELECT SUM(amount_paid) as total_paid
            FROM fees 
            WHERE student_id = $1 AND fee_type = $2 AND academic_year = $3 AND term = $4
        `, [receipt.student_id, receipt.fee_type, receipt.academic_year, receipt.term]);
        
        const totalPaid = parseFloat(totalPayments[0].total_paid) || 0;
        
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
        receipt.hasBill = receipt.bill_amount !== null && receipt.bill_amount !== undefined;
        receipt.isPartial = amountPaid < billAmount;
        receipt.isOverpaid = amountPaid > billAmount;
        receipt.billAmount = billAmount;
        receipt.actualAmountPaid = amountPaid;
        receipt.balanceAmount = balance;
        receipt.totalPaid = totalPaid;
        receipt.formattedTotalPaid = formatNaira(totalPaid);
        
        // Get school information from database
        const schoolInfo = await executeQuery(`
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
        const books = await executeQuery('SELECT * FROM library_books');
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
        let coverPath = req.file ? '/images/library/' + req.file.filename : null;
        
        await executeQuery(
            'INSERT INTO library_books (title, author, isbn, quantity, category, cover_path) VALUES ($1, $2, $3, $4, $5, $6)',
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
        const { academicYear, term } = req.query;
        
        // Build the WHERE clause if filters are provided
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (academicYear && academicYear !== '') {
            whereClause += ' AND academic_year = $1';
            queryParams.push(academicYear);
        }
        
        if (term && term !== '') {
            whereClause += ' AND term = $2';
            queryParams.push(term);
        }
        
        // Get events with optional filtering
        const events = await executeQuery(`
            SELECT * FROM calendar_events 
            ${whereClause}
            ORDER BY event_date ASC, start_time ASC
        `, queryParams);
        
        // Get academic years for filter dropdown
        const academicYears = await executeQuery(`
            SELECT DISTINCT academic_year 
            FROM calendar_events 
            WHERE academic_year IS NOT NULL AND academic_year != ''
            ORDER BY academic_year DESC
        `);
        
        // Get terms for filter dropdown
        const terms = await executeQuery(`
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
            moment: require('moment')
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
        // Get academic years
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get current academic year
        const currentAcademicYear = await executeQuery(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get terms for the current academic year
        let terms = [];
        let currentTerm = null;
        
        if (currentAcademicYear.length > 0) {
            terms = await executeQuery(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = $1 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);
            
            // Get current term
            const currentTermResult = await executeQuery(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = $1 AND is_current = TRUE LIMIT 1
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
        // Validate required fields
        if (!title || !eventDate || !academicYear || !term) {
            // Re-fetch academic data for form repopulation
            const academicYears = await executeQuery(`
                SELECT * FROM academic_years ORDER BY start_date DESC
            `);
            
            const currentAcademicYear = await executeQuery(`
                SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
            `);
            
            let terms = [];
            if (currentAcademicYear.length > 0) {
                terms = await executeQuery(`
                    SELECT * FROM academic_terms 
                    WHERE academic_year_id = $1 
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
        
        await executeQuery(
            'INSERT INTO calendar_events (title, description, event_date, start_time, end_time, academic_year, term) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [title, description, eventDate, startTime, endTime, academicYear, term]
        );
        
        res.redirect('/school-calendar');
    } catch (error) {
        console.error('Error adding event:', error);
        
        // Re-fetch academic data for form repopulation on error
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const currentAcademicYear = await executeQuery(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        let terms = [];
        if (currentAcademicYear.length > 0) {
            terms = await executeQuery(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = $1 
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
        const studentId = req.params.id;

        // 1. Get student info with class name and department
        const students = await executeQuery(`
            SELECT s.*, c.class_name, c.department AS class_department
            FROM students s 
            LEFT JOIN classes c ON s.class_id = c.id 
            WHERE s.id = $1`,
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
        const enrolledSubjects = await executeQuery(`
            SELECT s.id, s.name AS subject_name, s.subject_code AS subject_code
            FROM student_subjects ss
            JOIN subjects s ON ss.subject_id = s.id
            WHERE ss.student_id = $1
            ORDER BY s.name`,
            [studentId]
        );

        // 3. Get available subjects (not enrolled)
        const availableSubjects = await executeQuery(`
            SELECT s.id, s.name AS subject_name, s.subject_code AS subject_code
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = $1
            AND s.id NOT IN (
                SELECT subject_id
                FROM student_subjects 
                WHERE student_id = $2
            )
            ORDER BY s.name`,
            [student.class_id, studentId]
        );

        // 4. Get current academic year and term
        const currentAcademicYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const currentTerm = await executeQuery(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);

        // 5. Get available academic years for report card selection
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);

        res.render('student-profile', {
            studentData: student,
            student: student,
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
        const teachers = await executeQuery(
            'SELECT * FROM teachers WHERE id = $1', 
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
app.get('/staff-profile/:id', authenticate, async (req, res) => {
    try {
        const staff = await executeQuery(
            'SELECT * FROM staff WHERE id = $1', 
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

// SUBJECT ROUTES
app.get('/register-subjects', authenticate, async (req, res) => {
    try {
        // Get distinct levels from classes table
        const levels = await executeQuery('SELECT DISTINCT level as name FROM classes ORDER BY level');
        
        // Get distinct departments from classes table
        const departments = await executeQuery('SELECT DISTINCT department as name FROM classes WHERE department IS NOT NULL ORDER BY department');
        
        // Get all classes grouped by level
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                class_name
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
    try {
        const { level, department, subjects, subject_codes, descriptions } = req.body;

        // Debug logging
        console.log('Form data received:', {
            level: level,
            department: department,
            subjects: subjects,
            subject_codes: subject_codes,
            descriptions: descriptions
        });

        await executeTransaction(async (client) => {
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
            let classQuery = 'SELECT id, class_name FROM classes WHERE level = $1';
            let classParams = [level];
            
            if (level === 'SENIOR SECONDARY' && department) {
                classQuery += ' AND department = $2';
                classParams.push(department);
            }

            const classes = await client.query(classQuery, classParams);

            if (classes.rows.length === 0) {
                throw new Error(`No classes found for level: ${level}${level === 'SENIOR SECONDARY' ? ' - ' + department : ''}`);
            }

            console.log(`Found ${classes.rows.length} classes for ${level}${level === 'SENIOR SECONDARY' ? ' - ' + department : ''}`);

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

                // Create a new subject entry
                const subjectResult = await client.query(
                    'INSERT INTO subjects (name, subject_code, description) VALUES ($1, $2, $3) RETURNING id',
                    [
                        subjectName.trim(),
                        finalSubjectCode,
                        descriptions[i]?.trim() || null
                    ]
                );
                
                const subjectId = subjectResult.rows[0].id;
                console.log(`Created new subject: "${subjectName}" with code: ${finalSubjectCode} and ID: ${subjectId}`);

                // Link subject to ALL classes in this level/department
                for (const classInfo of classes.rows) {
                    try {
                        await client.query(
                            `INSERT INTO class_subjects (class_id, subject_id) 
                             VALUES ($1, $2)`,
                            [classInfo.id, subjectId]
                        );
                    } catch (linkError) {
                        // Ignore duplicate entry errors for class_subjects
                        if (linkError.code !== '23505') { // unique_violation
                            throw linkError;
                        }
                        console.log(`Subject ${subjectId} already linked to class ${classInfo.id}`);
                    }
                }

                console.log(`Subject "${subjectName}" registered for ${classes.rows.length} classes`);
            }
        });
        
        req.session.notification = {
            type: 'success',
            message: `Subjects registered successfully for ${level}${level === 'SENIOR SECONDARY' ? ' - ' + department : ''}`
        };
        res.redirect('/view-subjects');

    } catch (error) {
        console.error('Registration error:', error);
        
        // Check if it's a duplicate subject code error
        if (error.code === '23505' && error.message.includes('subject_code')) {
            error.message = 'Database constraint error: Subject code must be unique. Please remove the unique constraint from the subject_code field or use unique codes.';
        }
        
        // Get levels, departments, and classes for the form
        let levels = [];
        let departments = [];
        let classesByLevel = {};
        try {
            levels = await executeQuery('SELECT DISTINCT level as name FROM classes ORDER BY level');
            departments = await executeQuery('SELECT DISTINCT department as name FROM classes WHERE department IS NOT NULL ORDER BY department');
            
            const classes = await executeQuery(`
                SELECT id, class_name, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    class_name
            `);
            
            // Group classes by level
            classes.forEach(cls => {
                if (!classesByLevel[cls.level]) {
                    classesByLevel[cls.level] = [];
                }
                classesByLevel[cls.level].push(cls);
            });
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
    }
});

// View all subjects by class
app.get('/view-subjects', authenticate, async (req, res) => {
    try {
        const selectedClassId = req.query.classId || null;
        
        // Get all classes for the filter dropdown
        const allClasses = await executeQuery(`
            SELECT 
                c.id, 
                c.class_name,
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
                c.class_name
        `);

        // Build the WHERE clause if a class is selected
        let whereClause = '';
        let queryParams = [];
        if (selectedClassId) {
            whereClause = 'WHERE c.id = $1';
            queryParams = [selectedClassId];
        }

        // Get subjects with teachers
        const query = `
            SELECT 
                c.id AS class_id,
                c.class_name,
                c.level,
                c.department,
                s.id AS subject_id,
                s.name AS subject_name,
                s.subject_code AS subject_code,
                t.id AS teacher_id,
                CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                COUNT(ss.student_id) AS student_count,
                MAX(cs.created_at) AS last_updated
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
            LEFT JOIN teachers t ON cs.teacher_id = t.id
            LEFT JOIN student_subjects ss ON s.id = ss.subject_id
            ${whereClause}
            GROUP BY c.id, s.id, t.id
            ORDER BY c.class_name, s.name
        `;

        const subjects = await executeQuery(query, queryParams);

        // Format dates
        const formattedSubjects = subjects.map(subject => ({
            ...subject,
            formattedDate: subject.last_updated ? 
                moment(subject.last_updated).format('DD MMM YYYY') : 'Never'
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
        // Get class info with level and department
        const classes = await executeQuery(
            'SELECT id, class_name, level, department FROM classes WHERE id = $1',
            [req.params.classId]
        );
        
        if (classes.length === 0) {
            return res.status(404).send('Class not found');
        }

        const classInfo = classes[0];
        classInfo.displayName = classInfo.level === 'SENIOR SECONDARY' && classInfo.department 
            ? `${classInfo.class_name} (${classInfo.department})` 
            : classInfo.class_name;

        // Get subjects for this class
        const subjects = await executeQuery(
            'SELECT id, subject_name, subject_code FROM class_subjects WHERE class_id = $1 ORDER BY subject_name',
            [req.params.classId]
        );

        // Get students in this class
        const students = await executeQuery(
            `SELECT s.id, s.first_name, s.last_name, s.department 
             FROM students s 
             WHERE s.class_id = $1 
             ORDER BY s.first_name`,
            [req.params.classId]
        );

        // Get enrolled subjects for each student
        const enrolledStudents = await Promise.all(students.map(async student => {
            const enrollments = await executeQuery(
                `SELECT ss.subject_id, cs.subject_name, cs.subject_code 
                 FROM student_subjects ss
                 JOIN class_subjects cs ON ss.subject_id = cs.id
                 WHERE ss.student_id = $1`,
                [student.id]
            );
            return {
                ...student,
                enrollments,
                displayName: `${student.first_name} ${student.last_name}` +
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
        const result = await executeQuery(
            'DELETE FROM student_subjects WHERE student_id = $1 AND subject_id = $2',
            [studentId, subjectId]
        );

        if (result.length === 0) {
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
        // Get all teachers, classes, and subjects
        const teachers = await executeQuery('SELECT id, first_name, last_name FROM teachers ORDER BY last_name');
        const classes = await executeQuery('SELECT id, class_name, level, department FROM classes ORDER BY class_name');
        const subjects = await executeQuery('SELECT id, name FROM subjects ORDER BY name');
        const academicYears = await executeQuery('SELECT DISTINCT academic_year FROM class_bills ORDER BY academic_year DESC');
        
        // Get existing assignments
        const assignments = await executeQuery(`
            SELECT ta.*, t.first_name, t.last_name, c.class_name, s.name AS subject_name
            FROM teacher_assignments ta
            JOIN teachers t ON ta.teacher_id = t.id
            JOIN classes c ON ta.class_id = c.id
            JOIN subjects s ON ta.subject_id = s.id
            ORDER BY c.class_name, s.name
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
        // Check if assignment already exists
        const existing = await executeQuery(
            'SELECT id FROM teacher_assignments WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3 AND academic_year = $4',
            [teacherId, classId, subjectId, academicYear]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'This teacher is already assigned to this class and subject for the selected academic year'
            });
        }
        
        // Create new assignment
        await executeQuery(
            'INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, academic_year) VALUES ($1, $2, $3, $4)',
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

// Student Records Routes
app.get('/student-records', authenticate, async (req, res) => {
    try {
        const students = await executeQuery(`
            SELECT s.id, s.first_name, s.last_name, c.class_name, c.level, c.department
            FROM students s 
            JOIN classes c ON s.class_id = c.id
            ORDER BY c.class_name, s.first_name
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
        // Get available academic years and terms
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const terms = await executeQuery(`
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
        const studentResults = await executeQuery(`
            SELECT s.*, c.class_name, c.level, c.department
            FROM students s 
            JOIN classes c ON s.class_id = c.id 
            WHERE s.id = $1
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
            const sessionResults = await executeQuery(`
                SELECT 
                    s.id as subject_id,
                    s.name as subject_name,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = $1 AND subject_id = s.id 
                        AND term = 'First Term' AND academic_year = $2
                    ), 0) as first_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = $1 AND subject_id = s.id 
                        AND term = 'Second Term' AND academic_year = $3
                    ), 0) as second_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = $1 AND subject_id = s.id 
                        AND term = 'Third Term' AND academic_year = $4
                    ), 0) as third_term_score
                FROM subjects s
                WHERE s.id IN (
                    SELECT subject_id 
                    FROM student_scores 
                    WHERE student_id = $5 AND academic_year = $6
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
            const scores = await executeQuery(`
                SELECT s.id as subject_id, s.name as subject_name, 
                       sc.test_score, sc.exam_score, 
                       COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                       sc.term
                FROM subjects s
                JOIN student_scores sc ON s.id = sc.subject_id 
                WHERE sc.student_id = $1 AND sc.term = $2 AND sc.academic_year = $3
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
        // Get available academic years
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get all classes
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                class_name
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
        // Get current academic year if not specified
        const currentYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const academicYear = currentYear.length > 0 ? currentYear[0].year_name : new Date().getFullYear().toString();
        
        // Get class information
        const classResults = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            WHERE id = $1
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
        const results = await executeQuery(`
            SELECT 
                s.id as student_id,
                s.first_name as first_name,
                s.last_name as last_name,
                s.admission_number,
                s.department as student_department,
                COUNT(DISTINCT sc.subject_id) as subject_count,
                COALESCE(SUM(sc.test_score + sc.exam_score), 0) as total_score,
                COALESCE(AVG(sc.test_score + sc.exam_score), 0) as average_score
            FROM students s
            LEFT JOIN student_scores sc ON sc.student_id = s.id 
                AND sc.term = $1 AND sc.academic_year = $2
            WHERE s.class_id = $3
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
            termName: `${term} Report - ${classInfo.class_name}`,
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

// Score Entry Routes
app.get('/enter-scores', authenticate, async (req, res) => {
    const { classId, term, subjectId, academicYear } = req.query;
    
    try {
        // Get academic years and terms
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const terms = await executeQuery(`
            SELECT * FROM academic_terms ORDER BY start_date DESC
        `);
        
        // Get current academic year and term
        const currentAcademicYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const currentTerm = await executeQuery(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Set default values if not provided in query
        const defaultAcademicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '';
        const defaultTerm = currentTerm.length > 0 ? currentTerm[0].term_name : '';
        
        if (!classId || !term || !academicYear) {
            // Show selection form
            const classes = await executeQuery(`
                SELECT id, class_name, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    class_name
            `);
            
            // Get subjects based on selected class if available
            let subjects = [];
            if (classId) {
                subjects = await executeQuery(`
                    SELECT s.id, s.name 
                    FROM subjects s
                    JOIN class_subjects cs ON s.id = cs.subject_id
                    WHERE cs.class_id = $1
                    ORDER BY s.name
                `, [classId]);
            } else {
                subjects = await executeQuery('SELECT id, name FROM subjects ORDER BY name');
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
                formData,
                error: req.query.error || null,
                success: req.query.success || null
            });
        } else {
            // Show score entry form for specific class, term, and academic year
            const classResults = await executeQuery('SELECT class_name, level, department FROM classes WHERE id = $1', [classId]);
            const subjectResults = await executeQuery('SELECT name FROM subjects WHERE id = $1', [subjectId]);
            const yearResults = await executeQuery('SELECT year_name FROM academic_years WHERE year_name = $1', [academicYear]);
            const termResults = await executeQuery('SELECT term_name FROM academic_terms WHERE term_name = $1', [term]);
            
            if (classResults.length === 0) {
                return res.status(404).send('Class not found');
            }
            
            const className = classResults[0].class_name;
            const classLevel = classResults[0].level;
            const classDepartment = classResults[0].department;
            const subjectName = subjectResults.length > 0 ? subjectResults[0].name : 'All Subjects';
            const yearName = yearResults.length > 0 ? yearResults[0].year_name : academicYear;
            const termName = termResults.length > 0 ? termResults[0].term_name : term;
            
            // Get students with their existing scores AND department information
            const students = await executeQuery(`
                SELECT s.id, s.first_name, s.last_name, s.department,
                       sc.test_score, sc.exam_score
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.term = $1 
                    AND sc.subject_id = $2
                    AND sc.academic_year = $3
                WHERE s.class_id = $4
                ORDER BY s.last_name, s.first_name
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

// Add this API endpoint
app.get('/api/subjects-by-class', authenticate, async (req, res) => {
    const { classId } = req.query;
    
    try {
        const subjects = await executeQuery(`
            SELECT s.id, s.name 
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = $1
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
        
        // Execute transaction
        await executeTransaction(async (client) => {
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
                const existing = await client.query(
                    'SELECT id FROM student_scores WHERE student_id = $1 AND subject_id = $2 AND term = $3 AND academic_year = $4',
                    [studentId, subjectId, term, academicYear]
                );
                
                if (existing.rows.length > 0) {
                    // Update existing score
                    await client.query(
                        'UPDATE student_scores SET test_score = $1, exam_score = $2, updated_at = NOW() WHERE id = $3',
                        [testScore, examScore, existing.rows[0].id]
                    );
                } else {
                    // Insert new score
                    await client.query(
                        'INSERT INTO student_scores (student_id, subject_id, term, academic_year, test_score, exam_score, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())',
                        [studentId, subjectId, term, academicYear, testScore, examScore]
                    );
                }
            }
        });
        
        res.redirect(`/enter-scores?classId=${classId}&term=${term}&subjectId=${subjectId}&academicYear=${academicYear}&success=Scores saved successfully`);
    } catch (error) {
        console.error('Error saving scores:', error);
        res.redirect(`/enter-scores?classId=${classId}&term=${term}&subjectId=${subjectId}&academicYear=${academicYear}&error=${encodeURIComponent(error.message)}`);
    }
});

// Broadsheet Routes
app.get('/broadsheet', authenticate, async (req, res) => {
    const { classId, term, academicYear } = req.query;
    
    try {
        // Get all classes with levels and departments
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY class_name
        `);
        
        // Get available academic years
        const academicYears = await executeQuery(`
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
        // Get class info
        const classResults = await executeQuery('SELECT class_name, level, department FROM classes WHERE id = $1', [classId]);
        
        if (classResults.length === 0) {
            return res.redirect('/broadsheet?error=Class not found');
        }
        
        const className = classResults[0].class_name;
        const classLevel = classResults[0].level;
        const classDepartment = classResults[0].department;
        
        if (term === 'Session') {
            // Session broadsheet - detailed format with all terms
            const students = await executeQuery(`
                SELECT s.id, s.first_name, s.middle_name, s.last_name, s.department
                FROM students s 
                WHERE s.class_id = $1 
                ORDER BY s.last_name, s.first_name
            `, [classId]);
            
            // Get all subjects taught in this class
            const subjects = await executeQuery(`
                SELECT DISTINCT sub.id, sub.name 
                FROM subjects sub
                JOIN student_scores sc ON sub.id = sc.subject_id
                JOIN students s ON sc.student_id = s.id
                WHERE s.class_id = $1 AND sc.academic_year = $2
                ORDER BY sub.name
            `, [classId, academicYear]);
            
            // Get scores for all students and subjects across all terms
            const scores = await executeQuery(`
                SELECT 
                    sc.student_id,
                    sc.subject_id,
                    sc.term,
                    COALESCE(sc.test_score, 0) as test_score,
                    COALESCE(sc.exam_score, 0) as exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
                FROM student_scores sc
                JOIN students s ON sc.student_id = s.id
                WHERE s.class_id = $1 AND sc.academic_year = $2
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
                    first_name: student.first_name,
                    middle_name: student.middle_name,
                    last_name: student.last_name,
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
            const results = await executeQuery(`
                SELECT 
                    s.id as student_id,
                    s.first_name as first_name,
                    s.middle_name as middle_name,
                    s.last_name as last_name,
                    COUNT(DISTINCT sc.subject_id) as subject_count,
                    COALESCE(SUM(sc.test_score + sc.exam_score), 0) as total_score,
                    COALESCE(AVG(sc.test_score + sc.exam_score), 0) as average_score
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.term = $1 AND sc.academic_year = $2
                WHERE s.class_id = $3
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
        // Validate nextClassId
        if (!nextClassId || nextClassId === 'undefined') {
            return res.status(400).json({ 
                success: false, 
                error: 'Next class ID is required for promotion' 
            });
        }
        
        // Get current student info
        const student = await executeQuery(
            'SELECT * FROM students WHERE id = $1',
            [studentId]
        );
        
        if (student.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Verify next class exists
        const nextClass = await executeQuery(
            'SELECT id, class_name FROM classes WHERE id = $1',
            [nextClassId]
        );
        
        if (nextClass.length === 0) {
            return res.status(404).json({ success: false, error: 'Next class not found' });
        }
        
        // Update student class to next class
        await executeQuery(
            'UPDATE students SET class_id = $1 WHERE id = $2',
            [nextClassId, studentId]
        );
        
        // Record promotion in promotion history
        await executeQuery(
            'INSERT INTO promotion_history (student_id, from_class, to_class, academic_year, action) VALUES ($1, $2, $3, $4, $5)',
            [studentId, student[0].class_id, nextClassId, academicYear, 'promoted']
        );
        
        res.json({ 
            success: true, 
            message: `Student promoted successfully to ${nextClass[0].class_name}` 
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
        // Get current student info
        const student = await executeQuery(
            'SELECT * FROM students WHERE id = $1',
            [studentId]
        );
        
        if (student.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Record repetition in promotion history (student stays in same class)
        await executeQuery(
            'INSERT INTO promotion_history (student_id, from_class, to_class, academic_year, action) VALUES ($1, $2, $3, $4, $5)',
            [studentId, student[0].class_id, student[0].class_id, academicYear, 'repeated']
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
        const classes = await executeQuery(
            'SELECT id, class_name, department FROM classes WHERE level = $1 ORDER BY class_name',
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
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                class_name
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
        // Get student's current class and level
        const students = await executeQuery(`
            SELECT s.id, s.class_id, c.level, c.class_name 
            FROM students s 
            JOIN classes c ON s.class_id = c.id 
            WHERE s.id = $1
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
        const classes = await executeQuery(
            'SELECT id, class_name, department FROM classes WHERE level = $1 ORDER BY class_name',
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
        // Get current class info
        const currentClass = await executeQuery(
            'SELECT level, class_name FROM classes WHERE id = $1',
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
                const currentClassName = currentClass[0].class_name;
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
            const nextClasses = await executeQuery(
                'SELECT id, class_name, department FROM classes WHERE level = $1 ORDER BY class_name',
                [nextLevel]
            );
            
            res.json({ success: true, options: nextClasses });
        }
        
    } catch (error) {
        console.error('Error getting next class options:', error);
        res.status(500).json({ success: false, error: 'Failed to get next class options' });
    }
});

// Session Records Route
app.get('/session-records', authenticate, async (req, res) => {
    const { classId, academicYear, studentId } = req.query;
    
    try {
        // Get available academic years
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        if (!classId || !academicYear) {
            // Show class selection - include level and department in the query
            const classes = await executeQuery(`
                SELECT id, class_name, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    class_name
            `);
            
            // Create formData object from query parameters
            const formData = {
                classId: classId || '',
                academicYear: academicYear || ''
            };
            
            res.render('session-records-selection', { 
                classes, 
                academicYears,
                formData,
                error: req.query.error || null
            });
        } else {
            // Generate session records
            const classResults = await executeQuery('SELECT class_name, level, department FROM classes WHERE id = $1', [classId]);
            
            if (classResults.length === 0) {
                return res.status(404).send('Class not found');
            }
            
            const className = classResults[0].class_name;
            const classLevel = classResults[0].level;
            const classDepartment = classResults[0].department;
            
            // Get session records
            const results = await executeQuery(`
                SELECT 
                    s.id as student_id,
                    s.first_name,
                    s.last_name,
                    s.department as student_department,
                    sub.id as subject_id,
                    sub.name as subject_name,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'First Term' AND academic_year = $1
                    ), 0) as first_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'Second Term' AND academic_year = $2
                    ), 0) as second_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'Third Term' AND academic_year = $3
                    ), 0) as third_term_score
                FROM students s
                CROSS JOIN subjects sub
                WHERE s.class_id = $4
                ORDER BY s.last_name, s.first_name, sub.name
            `, [academicYear, academicYear, academicYear, classId]);
            
            // Organize by student
            const students = {};
            results.forEach(row => {
                if (!students[row.student_id]) {
                    students[row.student_id] = {
                        id: row.student_id,
                        first_name: row.first_name,
                        last_name: row.last_name,
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
                    first_name: students[id].first_name,
                    last_name: students[id].last_name,
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
                studentList,
                selectedStudentId: studentId || null,
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
            whereClause += ' AND cb.class_id = $1';
            queryParams.push(selectedClassId);
        }
        
        if (selectedAcademicYear) {
            whereClause += ' AND cb.academic_year = $2';
            queryParams.push(selectedAcademicYear);
        }
        
        if (selectedTerm) {
            whereClause += ' AND cb.term = $3';
            queryParams.push(selectedTerm);
        }
        
        // Get total count for pagination (only for list view)
        let totalCount = 0;
        let totalPages = 1;
        let offset = 0;
        
        if (!isPrintView) {
            const totalCountResult = await executeQuery(
                `SELECT COUNT(*) as total FROM class_bills cb ${whereClause}`,
                queryParams
            );
            
            totalCount = totalCountResult[0].total;
            totalPages = Math.ceil(totalCount / limit);
            offset = (page - 1) * limit;
        }
        
        // Get all classes for filter dropdown
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY class_name
        `);
        
        // Get academic years for filter dropdown
        let academicYears = [];
        
        try {
            const yearsFromBills = await executeQuery(`
                SELECT DISTINCT academic_year as year_name 
                FROM class_bills 
                WHERE academic_year IS NOT NULL AND academic_year != ''
                ORDER BY academic_year DESC
            `);
            
            if (yearsFromBills.length > 0) {
                academicYears = yearsFromBills;
            } else {
                // Fallback to academic_years table
                const yearsFromAcademic = await executeQuery(`
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
                    c.class_name as class_display_name,
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
                    c.class_name as class_display_name,
                    c.level as class_level,
                    c.department as class_department,
                    COUNT(DISTINCT s.id) as student_count,
                    COALESCE(SUM(CASE WHEN f.status IN ('paid', 'partial') THEN f.amount_paid ELSE 0 END), 0) as amount_collected
                FROM class_bills cb
                JOIN classes c ON cb.class_id = c.id
                LEFT JOIN students s ON s.class_id = cb.class_id
                LEFT JOIN fees f ON f.student_id = s.id 
                    AND cb.fee_type = f.fee_type 
                    AND cb.academic_year = f.academic_year 
                    AND cb.term = f.term
                ${whereClause}
                GROUP BY cb.id
                ORDER BY cb.academic_year DESC, cb.term, c.class_name
                LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
            `;
            queryParams = [...queryParams, parseInt(limit), parseInt(offset)];
        }
        
        // Execute the appropriate query
        bills = await executeQuery(billsQuery, queryParams);
        
        // Get school information
        const schoolInfo = await executeQuery(`
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
            isPrintView: isPrintView,
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
        const billId = req.query.id; // For editing existing bill
        
        // Get all classes
        const classes = await executeQuery(`
            SELECT id, class_name, level, department 
            FROM classes 
            ORDER BY class_name
        `);
        
        // Get academic years
        const academicYears = await executeQuery(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get current academic year
        const currentAcademicYear = await executeQuery(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get terms
        const terms = await executeQuery(`
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
            const bills = await executeQuery(`
                SELECT * FROM class_bills WHERE id = $1
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
        const classDetails = await executeQuery(`
            SELECT class_name, level, department FROM classes WHERE id = $1
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
            await executeQuery(`
                UPDATE class_bills SET
                    class_id = $1, class_name = $2, level = $3, department = $4, 
                    fee_type = $5, amount = $6, academic_year = $7, term = $8, 
                    description = $9, due_date = $10
                WHERE id = $11
            `, [
                classId,
                classInfo.class_name,
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
            const existingBills = await executeQuery(`
                SELECT id FROM class_bills 
                WHERE class_id = $1 AND fee_type = $2 AND academic_year = $3 AND term = $4
            `, [classId, feeType, academicYear, term]);
            
            if (existingBills.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'A bill for this fee type already exists for the selected class, academic year, and term'
                });
            }
            
            // Insert new class bill
            await executeQuery(`
                INSERT INTO class_bills (
                    class_id, class_name, level, department, fee_type, amount, 
                    academic_year, term, description, due_date, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
                classId,
                classInfo.class_name,
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

// Salary Management Routes - CONVERTED TO POSTGRESQL

// GET route to display salary dashboard
app.get('/salary-management', authenticate, async (req, res) => {
    try {
        // Get summary statistics
        const salarySummary = await executeQuery(`
            SELECT 
                COUNT(*) as total_employees,
                SUM(CASE WHEN employee_type = 'teacher' THEN 1 ELSE 0 END) as total_teachers,
                SUM(CASE WHEN employee_type = 'staff' THEN 1 ELSE 0 END) as total_staff,
                COALESCE(SUM(net_salary), 0) as total_paid,
                COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_count,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count
            FROM salary_payments 
            WHERE month = TO_CHAR(NOW(), 'YYYY-MM')
        `);
        
        // Get recent payments
        const recentPayments = await executeQuery(`
            SELECT sp.*, 
                   COALESCE(t.firstname, s.firstname) as first_name,
                   COALESCE(t.lastname, s.lastname) as last_name,
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

// GET route to display salary structures - CONVERTED TO POSTGRESQL
app.get('/salary-structures', authenticate, async (req, res) => {
    try {
        const structures = await executeQuery(`
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

// GET route to delete salary structure - CONVERTED TO POSTGRESQL
app.get('/delete-salary-structure/:id', authenticate, async (req, res) => {
    try {
        // Check if structure is being used
        const usage = await executeQuery(`
            SELECT COUNT(*) as count FROM salary_payments 
            WHERE employee_type = 'teacher' AND designation = (
                SELECT position FROM salary_structures WHERE id = $1
            )
            UNION ALL
            SELECT COUNT(*) as count FROM salary_payments 
            WHERE employee_type = 'staff' AND position = (
                SELECT position FROM salary_structures WHERE id = $2
            )
        `, [req.params.id, req.params.id]);
        
        if (usage[0].count > 0 || usage[1].count > 0) {
            req.session.error = 'Cannot delete salary structure. It is being used by employees.';
            return res.redirect('/salary-structures');
        }
        
        await executeQuery(
            'DELETE FROM salary_structures WHERE id = $1',
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

// POST route to add salary structure - CONVERTED TO POSTGRESQL
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
        // Validate required fields
        if (!position || !level || !basic_salary) {
            return res.render('add-salary-structure', {
                formData: req.body,
                error: 'Position, Level, and Basic Salary are required fields'
            });
        }
        
        // Check if structure already exists
        const existing = await executeQuery(`
            SELECT id FROM salary_structures 
            WHERE position = $1 AND level = $2
        `, [position, level]);
        
        if (existing.length > 0) {
            return res.render('add-salary-structure', {
                formData: req.body,
                error: 'Salary structure already exists for this position and level'
            });
        }
        
        // Insert new salary structure
        await executeQuery(`
            INSERT INTO salary_structures 
            (position, level, basic_salary, housing_allowance, transport_allowance, 
             medical_allowance, other_allowance, tax_percentage, pension_percentage,
             is_active, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
            is_active === '1' ? true : false,
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

// GET route to process salaries - CONVERTED TO POSTGRESQL
app.get('/process-salaries', authenticate, async (req, res) => {
    try {
        const { month, showProcessed } = req.query;
        
        const currentMonth = month || moment().format('YYYY-MM');
        
        // Get all teachers with their salary structures
        const teachers = await executeQuery(`
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
        const staff = await executeQuery(`
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
        const processedSalaries = await executeQuery(`
            SELECT employee_id, employee_type 
            FROM salary_payments 
            WHERE month = $1
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

// POST route to process individual salary - CONVERTED TO POSTGRESQL
app.post('/process-salary', uploadNoFile.none(), async (req, res) => {
    const {
        employee_id,
        employee_type,
        month
    } = req.body;
    
    try {
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
            // Get teacher with salary structure
            const teachers = await executeQuery(`
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
                WHERE t.id = $1
            `, [employee_id]);
            
            if (teachers.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Teacher not found'
                });
            }
            employee = teachers[0];
        } else {
            // Get staff with salary structure
            const staff = await executeQuery(`
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
                WHERE s.id = $1
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
        await executeQuery('BEGIN');
        
        try {
            // Insert salary payment
            await executeQuery(`
                INSERT INTO salary_payments 
                (employee_id, employee_type, month, basic_salary, housing_allowance, 
                 transport_allowance, medical_allowance, other_allowance, gross_salary,
                 tax_amount, pension_amount, net_salary, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
            
            await executeQuery('COMMIT');
            
            res.json({
                success: true,
                message: 'Salary processed successfully'
            });
            
        } catch (error) {
            await executeQuery('ROLLBACK');
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

// GET route to view salary payments - CONVERTED TO POSTGRESQL
app.get('/salary-payments', authenticate, async (req, res) => {
    try {
        const { month, employee_type, status } = req.query;
        
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        let paramCount = 0;
        
        if (month) {
            paramCount++;
            whereClause += ` AND sp.month = $${paramCount}`;
            queryParams.push(month);
        }
        
        if (employee_type) {
            paramCount++;
            whereClause += ` AND sp.employee_type = $${paramCount}`;
            queryParams.push(employee_type);
        }
        
        if (status) {
            paramCount++;
            whereClause += ` AND sp.status = $${paramCount}`;
            queryParams.push(status);
        }
        
        const payments = await executeQuery(`
            SELECT sp.*, 
                   COALESCE(t.firstname, s.firstname) as first_name,
                   COALESCE(t.lastname, s.lastname) as last_name,
                   COALESCE(t.designation, s.position) as position
            FROM salary_payments sp
            LEFT JOIN teachers t ON sp.employee_id = t.id AND sp.employee_type = 'teacher'
            LEFT JOIN staff s ON sp.employee_id = s.id AND sp.employee_type = 'staff'
            ${whereClause}
            ORDER BY sp.month DESC, sp.created_at DESC
        `, queryParams);
        
        // Get distinct months for filter
        const months = await executeQuery(`
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

// POST route to update payment status - CONVERTED TO POSTGRESQL
app.post('/update-salary-status', uploadNoFile.none(), async (req, res) => {
    const { payment_id, status, payment_date, payment_method, notes } = req.body;
    
    try {
        // Handle undefined values by converting them to null
        const processedPaymentDate = payment_date || null;
        const processedPaymentMethod = payment_method || null;
        const processedNotes = notes || null;
        
        await executeQuery(`
            UPDATE salary_payments 
            SET status = $1, payment_date = $2, payment_method = $3, notes = $4
            WHERE id = $5
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

// GET route to view salary slip - CONVERTED TO POSTGRESQL
app.get('/salary-slip/:id', authenticate, async (req, res) => {
    try {
        const paymentId = req.params.id;
        
        const payment = await executeQuery(`
            SELECT sp.*, 
                   COALESCE(t.firstname, s.firstname) as first_name,
                   COALESCE(t.lastname, s.lastname) as last_name,
                   COALESCE(t.designation, s.position) as position,
                   COALESCE(t.email, s.email) as email,
                   COALESCE(t.mobilenumber, s.phone) as phone,
                   sch.name as school_name,
                   sch.address as school_address,
                   sch.phone as school_phone
            FROM salary_payments sp
            LEFT JOIN teachers t ON sp.employee_id = t.id AND sp.employee_type = 'teacher'
            LEFT JOIN staff s ON sp.employee_id = s.id AND sp.employee_type = 'staff'
            CROSS JOIN school_info sch
            WHERE sp.id = $1
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

// GET route to manage salary adjustments - CONVERTED TO POSTGRESQL
app.get('/salary-adjustments', authenticate, async (req, res) => {
    try {
        const { employee_type, status } = req.query;
        
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        let paramCount = 0;
        
        if (employee_type) {
            paramCount++;
            whereClause += ` AND sa.employee_type = $${paramCount}`;
            queryParams.push(employee_type);
        }
        
        if (status) {
            paramCount++;
            whereClause += ` AND sa.status = $${paramCount}`;
            queryParams.push(status);
        }
        
        const adjustments = await executeQuery(`
            SELECT sa.*, 
                   COALESCE(t.firstname, s.firstname) as first_name,
                   COALESCE(t.lastname, s.lastname) as last_name,
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

// POST route to add salary adjustment - CONVERTED TO POSTGRESQL
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
        await executeQuery(`
            INSERT INTO salary_adjustments 
            (employee_id, employee_type, adjustment_type, amount, description, 
             effective_date, is_recurring, recurrence_months, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

// GET route to fetch employees for adjustments - CONVERTED TO POSTGRESQL
app.get('/get-employees', authenticate, async (req, res) => {
    try {
        const { type } = req.query;
        
        if (type === 'teacher') {
            const teachers = await executeQuery(`
                SELECT id, firstname as first_name, lastname as last_name, designation as position 
                FROM teachers 
                ORDER BY firstname, lastname
            `);
            res.json(teachers);
        } else if (type === 'staff') {
            const staff = await executeQuery(`
                SELECT id, firstname as first_name, lastname as last_name, position 
                FROM staff 
                ORDER BY firstname, lastname
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

// GET route to display expenses page - CONVERTED TO POSTGRESQL
app.get('/expenses', authenticate, async (req, res) => {
    try {
        const { startDate, endDate, category, status, page = 1, limit = 50 } = req.query;
        
        // Build WHERE clause
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        let paramCount = 0;
        
        if (startDate) {
            paramCount++;
            whereClause += ` AND e.expense_date >= $${paramCount}`;
            queryParams.push(startDate);
        }
        
        if (endDate) {
            paramCount++;
            whereClause += ` AND e.expense_date <= $${paramCount}`;
            queryParams.push(endDate);
        }
        
        if (category && category !== 'all') {
            paramCount++;
            whereClause += ` AND e.category = $${paramCount}`;
            queryParams.push(category);
        }
        
        if (status && status !== 'all') {
            paramCount++;
            whereClause += ` AND e.status = $${paramCount}`;
            queryParams.push(status);
        }
        
        // Get total count for pagination
        const totalCountResult = await executeQuery(
            `SELECT COUNT(*) as total FROM expenses e ${whereClause}`,
            queryParams
        );
        
        const totalCount = totalCountResult[0].total;
        const totalPages = Math.ceil(totalCount / limit);
        const offset = (page - 1) * limit;
        
        // Get expenses with filters
        const expenses = await executeQuery(
            `SELECT e.*, 
                    u.username as created_by_name,
                    a.username as approved_by_name
             FROM expenses e
             LEFT JOIN users u ON e.created_by = u.id
             LEFT JOIN users a ON e.approved_by = a.id
             ${whereClause}
             ORDER BY e.expense_date DESC, e.created_at DESC
             LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
            [...queryParams, parseInt(limit), parseInt(offset)]
        );
        
        // Get expense categories
        const categories = await executeQuery(
            'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
        );
        
        // Get total expenses amount (excluding salaries)
        const totalExpensesResult = await executeQuery(
            `SELECT SUM(amount) as total FROM expenses WHERE status = 'approved'`
        );
        const totalRegularExpenses = totalExpensesResult[0].total || 0;
        
        // Get total salary expenses (paid salaries)
        const totalSalaryExpensesResult = await executeQuery(
            `SELECT SUM(net_salary) as total FROM salary_payments WHERE status = 'paid'`
        );
        const totalSalaryExpenses = totalSalaryExpensesResult[0].total || 0;
        
        // Get total fees collected
        const totalFeesResult = await executeQuery(
            `SELECT SUM(amountpaid) as total FROM fees WHERE status IN ('paid', 'partial')`
        );
        const totalFees = totalFeesResult[0].total || 0;
        
        // Calculate balance (fees - all expenses including salaries)
        const totalAllExpenses = totalRegularExpenses + totalSalaryExpenses;
        const balance = totalFees - totalAllExpenses;
        
        res.render('expenses', {
            expenses,
            categories,
            totalExpenses: totalAllExpenses,
            totalRegularExpenses,
            totalSalaryExpenses,
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

// GET route to display add expense form - CONVERTED TO POSTGRESQL
app.get('/add-expense', authenticate, async (req, res) => {
    try {
        const categories = await executeQuery(
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

// POST route to add new expense - CONVERTED TO POSTGRESQL
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
        // Validate required fields
        if (!expense_date || !category || !description || !amount) {
            const categories = await executeQuery(
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
            const categories = await executeQuery(
                'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
            );
            
            return res.render('add-expense', {
                categories,
                formData: req.body,
                error: 'Please enter a valid amount'
            });
        }
        
        // Insert new expense
        await executeQuery(
            `INSERT INTO expenses 
             (expense_date, category, description, amount, payment_method, vendor, reference_number, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
        
        const categories = await executeQuery(
            'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name'
        );
        
        res.render('add-expense', {
            categories,
            formData: req.body,
            error: 'Failed to add expense: ' + error.message
        });
    }
});

// GET route to approve/reject expense - CONVERTED TO POSTGRESQL
app.get('/update-expense-status/:id/:status', authenticate, async (req, res) => {
    const { id, status } = req.params;
    
    try {
        if (status !== 'approved' && status !== 'rejected') {
            req.session.error = 'Invalid status';
            return res.redirect('/expenses');
        }
        
        await executeQuery(
            'UPDATE expenses SET status = $1, approved_by = $2, approved_at = NOW() WHERE id = $3',
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

// GET route to delete expense - CONVERTED TO POSTGRESQL
app.get('/delete-expense/:id', authenticate, async (req, res) => {
    try {
        await executeQuery(
            'DELETE FROM expenses WHERE id = $1',
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

// GET route for financial reports - CONVERTED TO POSTGRESQL
app.get('/financial-reports', authenticate, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        // Default to current month if no dates provided
        const defaultStartDate = startDate || moment().startOf('month').format('YYYY-MM-DD');
        const defaultEndDate = endDate || moment().endOf('month').format('YYYY-MM-DD');
        
        // Get total fees collected
        const feesResult = await executeQuery(
            `SELECT 
                SUM(amountpaid) as total,
                COUNT(*) as count,
                academicyear,
                term
             FROM fees 
             WHERE paymentdate BETWEEN $1 AND $2
             GROUP BY academicyear, term
             ORDER BY academicyear DESC, term`,
            [defaultStartDate, defaultEndDate]
        );
        
        // Get current academic year and term
        const currentAcademicYear = await executeQuery(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const currentTerm = await executeQuery(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        
        // Get total expenses (excluding salaries)
        const expensesResult = await executeQuery(
            `SELECT 
                SUM(amount) as total,
                COUNT(*) as count,
                category
             FROM expenses 
             WHERE expense_date BETWEEN $1 AND $2 AND status = 'approved'
             GROUP BY category
             ORDER BY total DESC`,
            [defaultStartDate, defaultEndDate]
        );
        
        // Get total salary expenses
        const salaryExpensesResult = await executeQuery(
            `SELECT 
                SUM(net_salary) as total,
                COUNT(*) as count,
                'Salaries' as category
             FROM salary_payments 
             WHERE payment_date BETWEEN $1 AND $2 AND status = 'paid'`,
            [defaultStartDate, defaultEndDate]
        );
        
        // Combine regular expenses and salary expenses
        const allExpenses = [...expensesResult];
        if (salaryExpensesResult[0].total) {
            allExpenses.push(salaryExpensesResult[0]);
        }
        
        // Get daily financial summary (including salaries)
        const dailySummary = await executeQuery(
            `SELECT 
                DATE(paymentdate) as date,
                'Revenue' as type,
                SUM(amountpaid) as amount
             FROM fees 
             WHERE paymentdate BETWEEN $1 AND $2
             GROUP BY DATE(paymentdate)
             
             UNION ALL
             
             SELECT 
                expense_date as date,
                'Expense' as type,
                SUM(amount) as amount
             FROM expenses 
             WHERE expense_date BETWEEN $3 AND $4 AND status = 'approved'
             GROUP BY expense_date
             
             UNION ALL
             
             SELECT 
                payment_date as date,
                'Salary' as type,
                SUM(net_salary) as amount
             FROM salary_payments 
             WHERE payment_date BETWEEN $5 AND $6 AND status = 'paid'
             GROUP BY payment_date
             
             ORDER BY date DESC`,
            [
                defaultStartDate, defaultEndDate,
                defaultStartDate, defaultEndDate,
                defaultStartDate, defaultEndDate
            ]
        );
        
        // Calculate totals
        const totalRevenue = feesResult.reduce((sum, item) => sum + parseFloat(item.total || 0), 0);
        const totalRegularExpenses = expensesResult.reduce((sum, item) => sum + parseFloat(item.total || 0), 0);
        const totalSalaryExpenses = salaryExpensesResult[0].total || 0;
        const totalExpenses = totalRegularExpenses + totalSalaryExpenses;
        const netBalance = totalRevenue - totalExpenses;
        
        res.render('financial-reports', {
            fees: feesResult,
            expenses: allExpenses,
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

// GET route to print class bill - CONVERTED TO POSTGRESQL
app.get('/class-bill/print/:id', authenticate, async (req, res) => {
    try {
        const billId = req.params.id;
        
        // Get the class bill
        const bills = await executeQuery(
            'SELECT * FROM class_bills WHERE id = $1',
            [billId]
        );
        
        if (bills.length === 0) {
            return res.status(404).send('Bill not found');
        }
        
        const bill = bills[0];
        
        // Get school information
        const schoolInfo = await executeQuery(
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

// Route to display printable book list - CONVERTED TO POSTGRESQL
app.get('/books/print', authenticate, async (req, res) => {
    try {
        const { academicYear, classLevel, department, subject } = req.query;
        
        // Build WHERE clause based on filters
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        let paramCount = 0;
        
        if (academicYear && academicYear !== 'all') {
            paramCount++;
            whereClause += ` AND academic_year = $${paramCount}`;
            queryParams.push(academicYear);
        }
        
        if (classLevel && classLevel !== 'all') {
            paramCount++;
            whereClause += ` AND class_level = $${paramCount}`;
            queryParams.push(classLevel);
        }
        
        if (department && department !== 'all') {
            paramCount++;
            whereClause += ` AND department = $${paramCount}`;
            queryParams.push(department);
        }
        
        if (subject && subject !== 'all') {
            paramCount++;
            whereClause += ` AND subject ILIKE $${paramCount}`;
            queryParams.push(`%${subject}%`);
        }
        
        // Get books based on filters
        const books = await executeQuery(
            `SELECT * FROM book_lists ${whereClause} ORDER BY subject, title`,
            queryParams
        );
        
        // Get school information
        const schoolInfo = await executeQuery(
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
        const academicYears = await executeQuery(
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
    res.status(500).render('error', {
        message: 'Something went wrong!',
        error: { status: 500, message: 'Internal server error' }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', {
        message: 'Page Not Found',
        error: { status: 404, message: 'The page you are looking for does not exist.' }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});
