const moment = require('moment');

function studentDisplayName(s) {
    if (!s) return '';
    const first = s.firstName ?? s.first_name ?? '';
    const mid = s.middleName ?? s.middle_name ?? '';
    const last = s.lastName ?? s.last_name ?? '';
    return [first, mid, last]
        .map((p) => (p != null && String(p).trim() !== '' ? String(p).trim() : null))
        .filter(Boolean)
        .join(' ');
}

const SQL_STUDENT_FULLNAME = `TRIM(CONCAT_WS(' ', s.firstName, NULLIF(TRIM(s.middleName), ''), s.lastName))`;

function showAlertAndBack(res, message) {
    const safeMessage = JSON.stringify(message);
    res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Notice</title></head>
<body>
<script>
  alert(${safeMessage});
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = '/';
  }
</script>
</body>
</html>`);
}

function formatDate(date) {
    if (!date) return '';
    if (typeof date === 'string') return date.split('T')[0] || date;
    return moment(date).format('YYYY-MM-DD');
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

/**
 * Calculates current school week, term progress, and week date range
 * from a term's start and end dates.
 *
 * @param {Date|string} startDate - Start date of the term
 * @param {Date|string} endDate - End date of the term
 * @param {Date|string} [refDate=new Date()] - Reference date (defaults to today)
 * @returns {Object} School week calculation details
 */
function calculateSchoolWeek(startDate, endDate, refDate = new Date()) {
    if (!startDate || !endDate) {
        return {
            currentWeek: 1,
            totalWeeks: 12,
            weekLabel: 'Week 1',
            shortWeekLabel: 'Week 1',
            status: 'unknown',
            statusBadge: 'Active Term',
            termProgress: 0,
            daysRemaining: 0,
            daysPassed: 0,
            totalDays: 0,
            weekStartDate: '',
            weekEndDate: ''
        };
    }

    const start = moment(startDate).startOf('day');
    const end = moment(endDate).endOf('day');
    const today = moment(refDate).startOf('day');

    const totalDays = Math.max(1, end.diff(start, 'days') + 1);
    const totalWeeks = Math.max(1, Math.ceil(totalDays / 7));

    if (today.isBefore(start)) {
        const daysUntil = start.diff(today, 'days');
        return {
            currentWeek: 1,
            totalWeeks,
            weekLabel: `Starts in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`,
            shortWeekLabel: 'Pre-Term',
            status: 'upcoming',
            statusBadge: 'Upcoming',
            termProgress: 0,
            daysRemaining: totalDays,
            daysPassed: 0,
            totalDays,
            weekStartDate: start.format('MMM D'),
            weekEndDate: moment.min(start.clone().add(6, 'days'), end).format('MMM D, YYYY')
        };
    }

    if (today.isAfter(end)) {
        return {
            currentWeek: totalWeeks,
            totalWeeks,
            weekLabel: `Term Concluded (${totalWeeks} Weeks)`,
            shortWeekLabel: `Week ${totalWeeks}`,
            status: 'completed',
            statusBadge: 'Concluded',
            termProgress: 100,
            daysRemaining: 0,
            daysPassed: totalDays,
            totalDays,
            weekStartDate: end.clone().subtract(6, 'days').format('MMM D'),
            weekEndDate: end.format('MMM D, YYYY')
        };
    }

    // Active term: calculate days passed and current week number (1-indexed)
    const daysPassed = today.diff(start, 'days');
    const weekNumber = Math.min(totalWeeks, Math.floor(daysPassed / 7) + 1);
    const termProgress = Math.min(100, Math.max(0, Math.round(((daysPassed + 1) / totalDays) * 100)));
    const daysRemaining = Math.max(0, end.diff(today, 'days'));

    // Start and end dates of this school week
    const currentWeekStart = start.clone().add((weekNumber - 1) * 7, 'days');
    const currentWeekEnd = moment.min(currentWeekStart.clone().add(6, 'days'), end);

    return {
        currentWeek: weekNumber,
        totalWeeks,
        weekLabel: `Week ${weekNumber} of ${totalWeeks}`,
        shortWeekLabel: `Week ${weekNumber}`,
        status: 'active',
        statusBadge: 'In Session',
        termProgress,
        daysRemaining,
        daysPassed,
        totalDays,
        weekStartDate: currentWeekStart.format('MMM D'),
        weekEndDate: currentWeekEnd.format('MMM D, YYYY')
    };
}

/**
 * Queries the database for the active academic year, term, and calculates the current school week.
 */
async function getCurrentTermAndWeek(connection, schoolId = null) {
    try {
        let termRow = null;

        // Try getting active term for specific school
        if (schoolId) {
            try {
                const [rows] = await connection.execute(
                    `SELECT at.*, ay.year_name, ay.start_date as year_start, ay.end_date as year_end
                     FROM academic_terms at
                     LEFT JOIN academic_years ay ON at.academic_year_id = ay.id
                     WHERE at.is_current = TRUE AND (at.school_id = ? OR at.school_id IS NULL)
                     ORDER BY at.school_id DESC, at.id DESC
                     LIMIT 1`,
                    [schoolId]
                );
                if (rows.length > 0) termRow = rows[0];
            } catch (e) {
                // column might not exist
            }
        }

        // Global fallback if no school-specific row found
        if (!termRow) {
            try {
                const [rows] = await connection.execute(
                    `SELECT at.*, ay.year_name, ay.start_date as year_start, ay.end_date as year_end
                     FROM academic_terms at
                     LEFT JOIN academic_years ay ON at.academic_year_id = ay.id
                     WHERE at.is_current = TRUE
                     ORDER BY at.id DESC
                     LIMIT 1`
                );
                if (rows.length > 0) termRow = rows[0];
            } catch (e) {}
        }

        // Fallback to most recent term
        if (!termRow) {
            try {
                const [rows] = await connection.execute(
                    `SELECT at.*, ay.year_name, ay.start_date as year_start, ay.end_date as year_end
                     FROM academic_terms at
                     LEFT JOIN academic_years ay ON at.academic_year_id = ay.id
                     ORDER BY at.start_date DESC
                     LIMIT 1`
                );
                if (rows.length > 0) termRow = rows[0];
            } catch (e) {}
        }

        let academicYear = termRow?.year_name;
        if (!academicYear) {
            if (schoolId) {
                try {
                    const [yRows] = await connection.execute(
                        `SELECT year_name FROM academic_years WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL) ORDER BY school_id DESC LIMIT 1`,
                        [schoolId]
                    );
                    if (yRows.length > 0) academicYear = yRows[0].year_name;
                } catch (e) {}
            }
            if (!academicYear) {
                try {
                    const [yRows] = await connection.execute(`SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1`);
                    if (yRows.length > 0) academicYear = yRows[0].year_name;
                } catch (e) {}
            }
        }

        const termName = termRow?.term_name || 'First Term';
        const weekInfo = calculateSchoolWeek(termRow?.start_date, termRow?.end_date);

        return {
            academicYear: academicYear || '2026/2027',
            currentTerm: termName,
            termName: termName,
            termStartDate: termRow?.start_date || null,
            termEndDate: termRow?.end_date || null,
            ...weekInfo
        };
    } catch (err) {
        console.error('Error in getCurrentTermAndWeek:', err.message);
        return {
            academicYear: '2026/2027',
            currentTerm: 'First Term',
            termName: 'First Term',
            termStartDate: null,
            termEndDate: null,
            currentWeek: 1,
            totalWeeks: 12,
            weekLabel: 'Week 1',
            shortWeekLabel: 'Week 1',
            status: 'active',
            statusBadge: 'In Session',
            termProgress: 0,
            daysRemaining: 0,
            daysPassed: 0,
            totalDays: 0,
            weekStartDate: '',
            weekEndDate: ''
        };
    }
}

module.exports = {
    studentDisplayName,
    SQL_STUDENT_FULLNAME,
    showAlertAndBack,
    formatDate,
    nigerianStates,
    calculateSchoolWeek,
    getCurrentTermAndWeek
};
