
const dns = require('dns');

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const { createClient } = require('@supabase/supabase-js');

// Load jose lazily because it is an ES module.
let josePromise;
function getJose() {
    if (!josePromise) {
        josePromise = import('jose');
    }
    return josePromise;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_JWKS_URL =
    process.env.SUPABASE_JWKS_URL ||
    (SUPABASE_URL
        ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
        : null);

const isConfigured = Boolean(
    SUPABASE_URL &&
    (SUPABASE_PUBLISHABLE_KEY || SUPABASE_SECRET_KEY)
);

// Client using the publishable key.
const supabase =
    SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
              auth: {
                  persistSession: false,
                  autoRefreshToken: false
              }
          })
        : null;

// Backend admin client. The secret key must remain server-side.
const supabaseAdmin =
    SUPABASE_URL &&
    (SUPABASE_SECRET_KEY || SUPABASE_PUBLISHABLE_KEY)
        ? createClient(
              SUPABASE_URL,
              SUPABASE_SECRET_KEY || SUPABASE_PUBLISHABLE_KEY,
              {
                  auth: {
                      persistSession: false,
                      autoRefreshToken: false
                  }
              }
          )
        : null;

// Cache the remote JWKS resolver.
let remoteJwksPromise;

async function getJwks() {
    if (!SUPABASE_JWKS_URL) {
        throw new Error('Supabase JWKS URL is not configured');
    }

    if (!remoteJwksPromise) {
        remoteJwksPromise = getJose().then(({ createRemoteJWKSet }) =>
            createRemoteJWKSet(new URL(SUPABASE_JWKS_URL))
        );
    }

    return remoteJwksPromise;
}

/**
 * Verify a Supabase JWT against the JWKS endpoint.
 */
async function verifySupabaseJwt(token) {
    if (!token) {
        return { valid: false, error: 'No token provided' };
    }

    try {
        const [{ jwtVerify }, jwks] = await Promise.all([
            getJose(),
            getJwks()
        ]);

        const { payload } = await jwtVerify(token, jwks);

        return { valid: true, payload };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

/**
 * Check Supabase connectivity and latency.
 */
async function checkSupabaseHealth() {
    if (!isConfigured || !supabaseAdmin) {
        return {
            ok: false,
            error: 'Supabase credentials not configured'
        };
    }

    const start = Date.now();

    try {
        const { error } = await supabaseAdmin
            .from('school_info')
            .select('id')
            .limit(1);

        if (error) {
            return {
                ok: false,
                error: error.message,
                latencyMs: Date.now() - start
            };
        }

        return {
            ok: true,
            latencyMs: Date.now() - start,
            url: SUPABASE_URL,
            authenticatedAs: SUPABASE_SECRET_KEY
                ? 'secret_key'
                : 'publishable_key'
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
            latencyMs: Date.now() - start
        };
    }
}

function isSupabaseConfigured() {
    return isConfigured;
}

module.exports = {
    supabase,
    supabaseAdmin,
    isSupabaseConfigured,
    checkSupabaseHealth,
    verifySupabaseJwt,
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY,
    SUPABASE_JWKS_URL
};
